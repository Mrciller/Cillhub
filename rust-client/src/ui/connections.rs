//! Saved private nodes connected next to the hub (stage 2a). A node is untrusted input, so each connection keeps
//! its own State (servers, channels, messages, users, presences) plus its pending poll choices, loading set and
//! request scopes: nothing a node sends can reach the hub's data or another node's. `self.state` holds the data
//! of `self.front`; the others wait in `self.parked`. The window shows `self.shown`'s servers. Every request is
//! sent with the connection whose data is in front when it starts (its origin and token), and its answer is
//! applied to that connection's data again, only while that connection still exists.
use super::CillhubApp;
use crate::i18n::tr;
use crate::native_gateway::{spawn_node, GatewayCommand, GatewayEvent, EVENT_QUEUE};
use crate::nodes::{NodeLink, SignInFail};
use crate::state::State;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

/// None = the hub, Some(origin) = a private node.
pub type Conn = Option<String>;

/// Everything that names a server, channel or message of one connection or holds content typed for it: parked
/// together with that connection's State. One list, so nothing of one connection is ever used with another.
macro_rules! per_connection {
    ($($f:ident: $t:ty),* $(,)?) => {
        /// One connection's data while another one is in front.
        #[derive(Default)]
        pub struct Front { state: State, $($f: $t),* }
        impl CillhubApp {
            fn swap_front(&mut self, other: &mut Front) {
                std::mem::swap(&mut self.state, &mut other.state);
                $(std::mem::swap(&mut self.$f, &mut other.$f);)*
            }
        }
    };
}
per_connection! {
    poll_pending: HashMap<String, Vec<u32>>,
    loading_history: HashSet<String>,
    loading_members: HashSet<String>,
    scopes: HashMap<String, u64>,
    selected_guild_id: Option<String>,
    selected_channel_id: Option<String>,
    composer_text: String,
    composer_seen: String,
    composer_rev: u64,
    pending_files: Vec<std::sync::Arc<std::path::PathBuf>>,
    failed_drafts: HashMap<String, Vec<super::chat::FailedDraft>>,
    reply_to_message: Option<crate::model::Message>,
    editing_message_id: Option<String>,
    canvas_cid: Option<String>,
    canvas_doc_input: String,
    search_query: String,
    search: Option<super::SearchResults>,
    events: Vec<Value>,
    active_drawer: Option<super::DrawerKind>,
    toolbar_msg: Option<String>,
    msg_menu: Option<(String, egui::Pos2)>,
    emoji_picker: Option<(super::chat::EmojiTarget, egui::Pos2)>,
    confirm_delete: Option<crate::model::Message>,
    edit_channel: Option<(String, String)>,
    create_channel_parent: Option<String>,
    revealed_spoilers: HashSet<(String, u16)>,
    row_heights: super::chat::RowHeights,
    collapsed_categories: HashSet<String>,
    role_draft: Option<crate::model::Role>,
    guild_name_draft: Option<String>,
}

/// What one node's data may keep, in items (a record, or 256 bytes of text; see `retained`). Anything that would
/// pass it is refused before it goes in and the node is cut off ("too much data").
const MAX_ITEMS: usize = if cfg!(test) { 5_000 } else { 500_000 };

/// The items a connection's data keeps: every collection a node can fill, text counted by size.
pub fn retained(st: &State) -> usize {
    let guilds: usize = st.guilds.values().map(|g| {
        1 + g.roles.len() + g.channels.len() + g.threads.len() + g.members.len() + g.voice_states.len() + g.presences.len()
            + g.emojis.len() + g.stickers.len() + g.soundboard_sounds.len() + g.stage_instances.len() + g.guild_scheduled_events.len() + g.features.len()
    }).sum();
    let messages: usize = st.messages.values().flatten().map(|m| {
        1 + m.content.len() / 256 + m.mentions.len() + m.mention_roles.len() + m.attachments.len() + m.embeds.len() + m.reactions.len() + m.sticker_items.len()
    }).sum();
    let canvases: usize = st.canvases.values().map(|c| 1 + c.doc.len() / 256 + c.notes.len()).sum();
    let pending: usize = st.pending_history.values().map(|p| p.created.len() + p.updates.len() + p.deleted.len()).sum();
    guilds + messages + canvases + pending + st.channels.len() + st.users.len() + st.presences.len() + st.voice_states.len()
        + st.members.values().map(|m| m.len()).sum::<usize>() + st.typing.values().map(Vec::len).sum::<usize>()
        + st.scheduled_events.values().map(Vec::len).sum::<usize>() + st.stage_instances.len()
}

/// The most a payload can add: its objects plus its text by size.
pub fn weight(v: &Value) -> usize {
    match v {
        Value::Object(m) => 1 + m.iter().map(|(k, v)| k.len() / 256 + weight(v)).sum::<usize>(),
        Value::Array(a) => a.iter().map(weight).sum(),
        Value::String(s) => s.len() / 256,
        _ => 0,
    }
}

/// Node events applied per frame; the rest wait in the bounded queue (the gateway stops reading when it is full).
const EVENT_BUDGET: usize = 500;

/// Gateway events a node may send: about its own servers only. Account-wide events (settings, relationships,
/// DMs, read states, sessions, saved messages) come from the hub alone.
const NODE_EVENTS: &[&str] = &[
    "GUILD_CREATE", "GUILD_UPDATE", "GUILD_DELETE", "GUILD_ROLE_CREATE", "GUILD_ROLE_UPDATE", "GUILD_ROLE_DELETE",
    "GUILD_MEMBER_ADD", "GUILD_MEMBER_UPDATE", "GUILD_MEMBER_REMOVE", "CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE",
    "THREAD_CREATE", "THREAD_UPDATE", "THREAD_DELETE", "THREAD_LIST_SYNC", "MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE",
    "MESSAGE_DELETE_BULK", "MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE", "MESSAGE_REACTION_REMOVE_ALL",
    "MESSAGE_POLL_VOTE_ADD", "MESSAGE_POLL_VOTE_REMOVE", "PRESENCE_UPDATE", "TYPING_START", "VOICE_STATE_UPDATE",
    "VOICE_CHANNEL_STATUS_UPDATE", "GUILD_EMOJIS_UPDATE", "GUILD_STICKERS_UPDATE", "GUILD_SCHEDULED_EVENT_CREATE",
    "GUILD_SCHEDULED_EVENT_UPDATE", "GUILD_SCHEDULED_EVENT_DELETE", "STAGE_INSTANCE_CREATE", "STAGE_INSTANCE_UPDATE",
    "STAGE_INSTANCE_DELETE", "CHANNEL_CANVAS_UPDATE",
];

pub struct NodeConn {
    pub link: NodeLink,
    rx: Option<Receiver<GatewayEvent>>,
    cmd: Option<Sender<GatewayCommand>>,
    /// requests to this node: its origin and token, nothing else
    api: Option<crate::api::ApiClient>,
    tries: u32,
    retry_at: Option<Instant>,
    busy: bool,
    /// answers started for an earlier connection (removed, signed out) are dropped
    pub gen: u64,
    /// `gen` for workers: a sign-in checks it right before it posts the consent (u64::MAX once removed)
    live: std::sync::Arc<std::sync::atomic::AtomicU64>,
}

impl NodeConn {
    fn new(gen: u64) -> Self {
        let live = std::sync::Arc::new(std::sync::atomic::AtomicU64::new(gen));
        Self { link: NodeLink::Connecting, rx: None, cmd: None, api: None, tries: 0, retry_at: None, busy: false, gen, live }
    }
    fn set_gen(&mut self, gen: u64) {
        self.gen = gen;
        self.live.store(gen, std::sync::atomic::Ordering::SeqCst);
    }
    /// Closes the gateway and ends this connection for every worker still holding it.
    fn close(&mut self) {
        if let Some(tx) = self.cmd.take() {
            let _ = tx.send(GatewayCommand::Shutdown);
        }
        self.rx = None;
    }
}

impl Drop for NodeConn {
    fn drop(&mut self) {
        self.close();
        self.live.store(u64::MAX, std::sync::atomic::Ordering::SeqCst); // removed: no consent for it any more
    }
}

/// A finished background sign-in: (session it was started in, origin, node connection generation, result).
pub type SignInDone = (u64, String, u64, Result<String, SignInFail>);

/// What happens to a sign-in result: adopt the token, revoke it on the node (the session ended or the node was
/// removed meanwhile), or only record why it failed.
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    Adopt,
    Revoke,
    Drop,
    Fail,
}

pub fn outcome(started: u64, now: u64, saved: bool, ok: bool) -> Outcome {
    match (started == now && saved, ok) {
        (true, true) => Outcome::Adopt,
        (false, true) => Outcome::Revoke,
        (false, false) => Outcome::Drop,
        (true, false) => Outcome::Fail,
    }
}

impl CillhubApp {
    /// Puts `conn`'s data in front (the current front's data is parked). False when `conn` has no data.
    pub fn swap_in(&mut self, conn: &Conn) -> bool {
        if *conn == self.front {
            return true;
        }
        let Some(mut data) = self.parked.remove(conn) else { return false };
        self.swap_front(&mut data); // `data` now holds the previous front's
        self.parked.insert(std::mem::replace(&mut self.front, conn.clone()), data);
        true
    }

    /// Runs `f` with `conn`'s data in front, then puts the previous front back. None when `conn` has no data.
    pub fn with_conn<R>(&mut self, conn: &Conn, f: impl FnOnce(&mut Self) -> R) -> Option<R> {
        let prev = self.front.clone();
        if !self.swap_in(conn) {
            return None;
        }
        let r = f(self);
        if !self.swap_in(&prev) {
            self.swap_in(&None); // the previous one went away meanwhile
        }
        Some(r)
    }

    /// Shows `conn`'s servers (Home and the hub's servers for None).
    pub fn show(&mut self, conn: &Conn) {
        if self.swap_in(conn) {
            self.shown = conn.clone();
        }
    }

    /// The data of `conn`, wherever it is.
    pub fn conn_state(&self, conn: &Conn) -> Option<&State> {
        if *conn == self.front {
            Some(&self.state)
        } else {
            self.parked.get(conn).map(|f| &f.state)
        }
    }

    /// The API client of the connection in front.
    pub fn front_api(&self) -> Option<&crate::api::ApiClient> {
        match &self.front {
            None => self.api.as_ref(),
            Some(o) => self.conns.get(o).and_then(|c| c.api.as_ref()),
        }
    }

    /// Whether an answer started for (`conn`, `gen`) may still be applied.
    pub fn conn_alive(&self, conn: &Conn, gen: u64) -> bool {
        conn.as_ref().is_none_or(|o| self.conns.get(o).is_some_and(|c| c.gen == gen))
    }

    /// The generation of the connection in front (0 for the hub).
    pub fn front_gen(&self) -> u64 {
        self.front.as_ref().and_then(|o| self.conns.get(o)).map_or(0, |c| c.gen)
    }

    /// DMs and friends are the hub's: from a node's view (a node user's id means nothing on the hub) they are refused.
    pub fn refuse_on_node(&mut self) -> bool {
        if self.front.is_some() {
            self.status_banner = Some(tr("Direct messages and friends are not available on private nodes yet.").to_string());
        }
        self.front.is_some()
    }

    /// The image key of an attachment: per connection, so a node naming a hub attachment's id gets its own image.
    pub fn attachment_uri(&self, id: &str, filename: &str) -> String {
        let conn = self.front.as_deref().map_or_else(|| "hub".to_string(), |o| o.replace("://", "_").replace(':', "_"));
        format!("bytes://attachment/{conn}/{id}/{filename}")
    }

    /// The saved node's name for marks and rows.
    pub fn node_name(&self, origin: &str) -> String {
        let n = self.settings.private_nodes.iter().find(|n| n.origin == origin);
        n.map(|n| n.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| origin.split("://").nth(1).unwrap_or(origin).to_string())
    }

    /// Where a node token is kept: per hub, hub account and node.
    fn node_key(&self, origin: &str) -> String {
        let hub = self.api.as_ref().map(|a| a.origin.origin().ascii_serialization()).unwrap_or_default();
        crate::settings::node_key(&hub, &self.hub_user, origin)
    }

    /// On the hub's READY and USER_SETTINGS_UPDATE: the hub copy of the list wins (removals on another device
    /// too); an account that never saved one (null) uploads this device's. Then every saved node gets a try.
    pub fn sync_private_nodes(&mut self) {
        let from_hub = self.state.user_settings.extra.get("private_nodes").filter(|v| v.is_array()).cloned();
        match from_hub {
            None if !self.settings.private_nodes.is_empty() => {
                // stored only while the account has none; the list comes back with USER_SETTINGS_UPDATE
                let nodes = self.settings.private_nodes.clone();
                self.api_bg(true, move |api| api.put("/users/@me/settings/private-nodes/initial", Some(json!({ "nodes": nodes }))), |_, _| {});
            }
            None => {}
            Some(v) => self.adopt_list(&v),
        }
        self.retry_revokes();
        self.connect_saved();
    }

    /// Takes the list the hub sent; nodes no longer in it are signed out and dropped.
    pub fn adopt_list(&mut self, v: &Value) {
        let list = crate::nodes::sanitize(serde_json::from_value(v.clone()).unwrap_or_default());
        let gone: Vec<String> = self.settings.private_nodes.iter().filter(|n| !list.iter().any(|x| x.origin == n.origin)).map(|n| n.origin.clone()).collect();
        self.settings.private_nodes = list;
        super::report(&mut self.status_banner, self.settings.save());
        for o in gone {
            self.drop_node(&o, true);
        }
    }

    /// Starts every saved node that has no connection yet: its gateway with a stored token, else a sign-in.
    pub fn connect_saved(&mut self) {
        if self.api.is_none() || self.hub_user.is_empty() {
            return;
        }
        for n in self.settings.private_nodes.clone() {
            if self.conns.contains_key(&n.origin) {
                continue;
            }
            self.node_gen += 1;
            self.conns.insert(n.origin.clone(), NodeConn::new(self.node_gen));
            match self.settings.node_token(&self.node_key(&n.origin)) {
                Some(t) => self.open_node(&n.origin, t),
                None => self.start_sign_in(&n.origin),
            }
        }
    }

    /// Hub GET /federation/nodes, then the background sign-in, on a worker; the result comes back through
    /// `signin_rx` with the session it was started in.
    fn start_sign_in(&mut self, origin: &str) {
        let Some(api) = self.api.clone() else { return };
        let Some(c) = self.conns.get_mut(origin) else { return };
        if c.busy {
            return;
        }
        c.busy = true;
        c.retry_at = None;
        let (node_gen, node_live) = (c.gen, c.live.clone());
        let (gen, live, tx, origin) = (self.session_gen, self.session_live.clone(), self.signin_tx.clone(), origin.to_string());
        let hub_token = api.token.clone().unwrap_or_default();
        let o = origin.clone();
        let started = self.spawn_bg(
            false,
            move || {
                // the hub session and this very node connection (not removed, not signed in another way meanwhile)
                let alive = || live.load(std::sync::atomic::Ordering::SeqCst) == gen && node_live.load(std::sync::atomic::Ordering::SeqCst) == node_gen;
                let r = api
                    .get("/federation/nodes")
                    .map_err(|e| SignInFail::Down(if e.status == 0 { tr("Can't reach the server.").to_string() } else { e.to_string() }))
                    .and_then(|records| match crate::nodes::find_record(&records, &origin) {
                        None => Err(SignInFail::OwnLogin), // standalone, or linked to another hub
                        Some((_, _, false)) => Err(SignInFail::Down(tr("Suspended by the hub").to_string())),
                        Some((id, _, true)) => crate::nodes::sign_in(&api.origin, &hub_token, &origin, &id, &alive),
                    });
                let _ = tx.send((gen, origin, node_gen, r));
            },
            |_, ()| {},
        );
        if !started {
            if let Some(c) = self.conns.get_mut(&o) {
                c.busy = false;
            }
            self.retry(&o, tr("Can't reach the server.").to_string());
        }
    }

    /// Opens a node's gateway with its token; its requests use that token from now on.
    fn open_node(&mut self, origin: &str, token: String) {
        let Ok(url) = url::Url::parse(origin) else { return };
        self.parked.entry(Some(origin.to_string())).or_default();
        let (ev_tx, ev_rx) = mpsc::sync_channel(EVENT_QUEUE);
        let (cmd_tx, cmd_rx) = mpsc::channel();
        spawn_node(url.clone(), token.clone(), ev_tx, cmd_rx);
        self.node_gen += 1; // answers for the earlier credentials are dropped
        let gen = self.node_gen;
        let Some(c) = self.conns.get_mut(origin) else { return };
        c.close();
        c.set_gen(gen);
        (c.rx, c.cmd, c.link) = (Some(ev_rx), Some(cmd_tx), NodeLink::Connecting);
        c.api = Some(crate::api::ApiClient::new(url, Some(token)));
        // answers of the earlier credentials are dropped: their member loads will not come back
        self.with_conn(&Some(origin.to_string()), |app| app.loading_members.clear());
    }

    /// Tries again later, 5 s doubling up to 5 minutes; nothing waits for it.
    fn retry(&mut self, origin: &str, why: String) {
        if let Some(c) = self.conns.get_mut(origin) {
            c.tries += 1;
            c.link = NodeLink::Down(why);
            c.retry_at = Some(Instant::now() + Duration::from_secs(crate::nodes::backoff_secs(c.tries)));
        }
    }

    /// Records a sign-out to confirm (saved; if saving fails, kept in memory and saved again with the next retry)
    /// and tries it now. False when it could not be saved yet.
    fn sign_out_later(&mut self, origin: &str, token: String) -> bool {
        match self.settings.add_pending_revoke(origin, &token) {
            Ok(key) => {
                self.revoke_async(key, origin.to_string(), token);
                true
            }
            Err(e) => {
                self.status_banner = Some(e.to_string());
                self.unsaved_seq += 1;
                let id = format!("unsaved-{}", self.unsaved_seq);
                self.unsaved_revokes.push((id.clone(), origin.to_string(), token.clone()));
                self.revoke_async(id, origin.to_string(), token);
                false
            }
        }
    }

    /// Ends a node's session there on its own thread; the sign-out stays pending until the node confirms.
    fn revoke_async(&mut self, key: String, origin: String, token: String) {
        if !self.revoking.insert(key.clone()) {
            return;
        }
        let tx = self.revoke_tx.clone();
        std::thread::spawn(move || {
            let ok = crate::nodes::revoke(&origin, &token);
            let _ = tx.send((key, ok));
        });
    }

    /// Sign-outs that a node has not confirmed yet (from this run or an earlier one) are tried again.
    pub fn retry_revokes(&mut self) {
        for (key, origin, token) in self.settings.pending_revoke_list() {
            self.revoke_async(key, origin, token);
        }
    }

    /// Every frame: finished sign-ins and sign-outs, node gateway events (a budget per node), due retries.
    pub fn tick_nodes(&mut self) {
        for o in std::mem::take(&mut self.cut_off) {
            self.cut_off_node(&o); // found by a member-list answer
        }
        if !(self.settings.pending_revokes.is_empty() && self.unsaved_revokes.is_empty()) && self.last_revoke_retry.elapsed() >= Duration::from_secs(60) {
            self.last_revoke_retry = Instant::now();
            // not saved yet: save again (then it is an ordinary pending sign-out), else try the node again
            for (id, origin, token) in std::mem::take(&mut self.unsaved_revokes) {
                match self.settings.add_pending_revoke(&origin, &token) {
                    Ok(key) => self.revoke_async(key, origin, token),
                    Err(_) => {
                        self.unsaved_revokes.push((id.clone(), origin.clone(), token.clone()));
                        self.revoke_async(id, origin, token);
                    }
                }
            }
            self.retry_revokes(); // a node that was down may be back; each try is bounded (nodes::revoke)
        }
        while let Ok((key, ok)) = self.revoke_rx.try_recv() {
            self.revoking.remove(&key);
            if ok && key.starts_with("unsaved-") {
                self.unsaved_revokes.retain(|(id, _, _)| *id != key);
            } else if ok {
                super::report(&mut self.status_banner, self.settings.clear_pending_revoke(&key));
            }
        }
        while let Ok((gen, origin, node_gen, r)) = self.signin_rx.try_recv() {
            // the same connection still waits for it (not removed and added again, not signed in meanwhile)
            let current = self.conns.get(&origin).is_some_and(|c| c.gen == node_gen);
            let saved = current && self.settings.private_nodes.iter().any(|n| n.origin == origin);
            if gen == self.session_gen && current {
                if let Some(c) = self.conns.get_mut(&origin) {
                    c.busy = false;
                }
            }
            match (outcome(gen, self.session_gen, saved, r.is_ok()), r) {
                (Outcome::Adopt, Ok(token)) => {
                    let key = self.node_key(&origin);
                    super::report(&mut self.status_banner, self.settings.set_node_token(&key, Some(&token)));
                    self.open_node(&origin, token);
                }
                // started for another session, or the node was removed meanwhile: never stored, ended on the node
                (Outcome::Revoke, Ok(token)) => {
                    self.sign_out_later(&origin, token);
                }
                (Outcome::Fail, Err(SignInFail::OwnLogin)) => self.set_link(&origin, NodeLink::OwnLogin),
                (Outcome::Fail, Err(SignInFail::Old)) => self.set_link(&origin, NodeLink::Old),
                (Outcome::Fail, Err(SignInFail::Down(why))) => self.retry(&origin, why),
                _ => {}
            }
        }
        let origins: Vec<String> = self.conns.keys().cloned().collect();
        for origin in origins {
            let events: Vec<GatewayEvent> = self.conns.get(&origin).and_then(|c| c.rx.as_ref()).map(|rx| rx.try_iter().take(EVENT_BUDGET).collect()).unwrap_or_default();
            // counted once per batch; each event adds its weight before it is applied
            let mut used = if events.is_empty() { 0 } else { self.with_conn(&Some(origin.clone()), |app| retained(&app.state)).unwrap_or(0) };
            for ev in events {
                if self.conn_state(&Some(origin.clone())).is_none() && self.conns.get(&origin).is_some_and(|c| c.rx.is_none()) {
                    break; // cut off by an earlier event of this batch
                }
                self.node_event(&origin, ev, &mut used);
            }
            let due = self.conns.get(&origin).is_some_and(|c| c.retry_at.is_some_and(|t| t <= Instant::now()));
            if due {
                self.start_sign_in(&origin);
            }
        }
    }

    fn set_link(&mut self, origin: &str, link: NodeLink) {
        if let Some(c) = self.conns.get_mut(origin) {
            c.link = link;
        }
    }

    fn node_event(&mut self, origin: &str, ev: GatewayEvent, used: &mut usize) {
        let conn = Some(origin.to_string());
        match ev {
            GatewayEvent::Dispatch(name, d) => {
                if name != "READY" && !NODE_EVENTS.contains(&name.as_str()) {
                    eprintln!("cillhub: {origin} sent {name}: dropped");
                    return;
                }
                // READY replaces the node's data: only its own size counts
                let w = weight(&d);
                *used = if name == "READY" { w } else { *used + w };
                if *used > MAX_ITEMS {
                    return self.cut_off_node(origin);
                }
                self.with_conn(&conn, |app| app.apply_node_event(&conn, &name, d));
            }
            // the gateway keeps reconnecting by itself; its servers are greyed meanwhile
            GatewayEvent::ConnectionError(_) => self.set_link(origin, NodeLink::Down(crate::i18n::trf("{name} is not reachable right now.", &[("name", &self.node_name(origin))]))),
            GatewayEvent::RejectedToken => {
                // the node ended our session there: a new background sign-in
                self.node_gen += 1;
                let gen = self.node_gen;
                if let Some(c) = self.conns.get_mut(origin) {
                    c.close();
                    c.api = None;
                    c.set_gen(gen);
                }
                let key = self.node_key(origin);
                super::report(&mut self.status_banner, self.settings.set_node_token(&key, None));
                self.retry(origin, tr("Signed out").to_string());
            }
            GatewayEvent::Connected => {}
        }
    }

    /// Applies one node event to that node's own data (in front now).
    fn apply_node_event(&mut self, conn: &Conn, name: &str, d: Value) {
        let s = |k: &str| d.get(k).and_then(Value::as_str).map(String::from);
        // a server event must name a server of this node (no member lists for made-up servers)
        if !matches!(name, "READY" | "GUILD_CREATE") && s("guild_id").is_some_and(|g| !self.state.guilds.contains_key(&g)) {
            return;
        }
        let vote = name.starts_with("MESSAGE_POLL_VOTE_").then(|| s("channel_id").zip(s("message_id"))).flatten();
        let new_guild = (name == "GUILD_CREATE").then(|| s("id")).flatten();
        if let Err(e) = self.state.apply(name, d) {
            eprintln!("cillhub: node {name} not applied: {e}");
        }
        if let Some((cid, mid)) = vote {
            self.settle_poll(&cid, &mid);
        }
        if let Some(id) = new_guild {
            self.load_members(&id);
        }
        if name == "READY" {
            // requests and choices from before this READY belong to the replaced data
            self.new_scope("history");
            self.loading_history.clear();
            self.poll_pending.clear();
            let ids: Vec<String> = self.state.guilds.keys().cloned().collect();
            ids.iter().for_each(|id| self.load_members(id));
            if let Some(c) = conn.as_ref().and_then(|o| self.conns.get_mut(o)) {
                (c.link, c.tries, c.retry_at) = (NodeLink::Ready, 0, None);
            }
            if self.shown == *conn {
                let gone = |c: &Option<String>, ok: &dyn Fn(&str) -> bool| c.as_deref().is_some_and(|c| !ok(c));
                if gone(&self.selected_guild_id, &|g| self.state.guilds.contains_key(g)) || gone(&self.selected_channel_id, &|c| self.state.channels.contains_key(c)) {
                    self.selected_guild_id = None; // the window goes back to Home (headless_tick)
                    self.selected_channel_id = None;
                } else if let Some(cid) = self.selected_channel_id.clone() {
                    self.load_channel_history(&cid);
                }
            }
        }
    }

    /// With a node's data in front: whether `extra` more items still fit; if not, the node is marked for cutting
    /// off (tick_nodes) and nothing may be added. The hub is not limited.
    pub fn within_budget(&mut self, extra: usize) -> bool {
        let Some(o) = self.front.clone() else { return true };
        if retained(&self.state) + extra <= MAX_ITEMS {
            return true;
        }
        if !self.cut_off.contains(&o) {
            self.cut_off.push(o);
        }
        false
    }

    /// Cuts off a node that sent more than this app keeps: its data is dropped, it is not retried.
    fn cut_off_node(&mut self, origin: &str) {
        eprintln!("cillhub: {origin} sent more than this app keeps: cut off");
        if let Some(mut c) = self.conns.remove(origin) {
            c.close();
        }
        self.drop_node_data(origin);
        self.node_gen += 1;
        let mut c = NodeConn::new(self.node_gen);
        c.link = NodeLink::Down(tr("This node sent more data than the app keeps.").to_string());
        self.conns.insert(origin.to_string(), c);
    }

    /// Forgets a node's data; the window goes back to Home if it showed that node.
    fn drop_node_data(&mut self, origin: &str) {
        let conn = Some(origin.to_string());
        if self.shown == conn || self.front == conn {
            self.show(&None);
            self.shown = None;
            self.selected_guild_id = None;
            self.selected_channel_id = None;
        }
        self.parked.remove(&conn);
    }

    /// Ends a node connection: gateway closed, data gone, token forgotten. With `sign_out` the token (the one in
    /// memory first) is revoked on the node; until the node confirms, that sign-out stays saved and is retried.
    pub fn drop_node(&mut self, origin: &str, sign_out: bool) {
        let key = self.node_key(origin);
        let live = self.conns.remove(origin).and_then(|mut c| {
            c.close();
            c.api.take().and_then(|a| a.token)
        });
        self.drop_node_data(origin);
        let stored = self.settings.node_token(&key);
        let mut keep_credential = false;
        if sign_out {
            for token in live.into_iter().chain(stored).collect::<HashSet<_>>() {
                // not saved: the stored credential stays too, the only durable way to sign out there later
                keep_credential |= !self.sign_out_later(origin, token);
            }
        }
        if !keep_credential {
            // also when the keyring could not be read: the entry is tombstoned before it is deleted
            super::report(&mut self.status_banner, self.settings.set_node_token(&key, None));
        }
    }

    /// Hub logout: node sessions and the private node list belong to this hub account.
    pub fn forget_nodes(&mut self) {
        self.show(&None);
        let mut origins: Vec<String> = self.settings.private_nodes.iter().map(|n| n.origin.clone()).collect();
        origins.extend(self.conns.keys().cloned());
        origins.sort();
        origins.dedup();
        for o in origins {
            self.drop_node(&o, true);
        }
        self.settings.private_nodes.clear();
        self.parked.clear();
        (self.front, self.shown) = (None, None);
    }

    /// The node mark of a node's servers on the rail: (node name, link).
    pub fn node_mark(&self, origin: &str) -> (String, NodeLink) {
        let link = self.conns.get(origin).map_or(NodeLink::Down(tr("Not connected").to_string()), |c| c.link.clone());
        (self.node_name(origin), link)
    }

    /// Adds a node to the account's list (one call on the hub); the hub's USER_SETTINGS_UPDATE brings the list and
    /// connects it (answers are not merged: an older answer would undo a newer change). Demo: this device only.
    pub fn save_added_node(&mut self, node: crate::nodes::SavedNode) {
        if self.api.is_none() {
            self.settings.private_nodes.push(node);
            super::report(&mut self.status_banner, self.settings.save());
            return;
        }
        let body = json!({ "origin": node.origin, "name": node.name });
        self.with_conn(&None, |app| {
            app.api_bg(true, move |api| api.put("/users/@me/settings/private-nodes", Some(body)), |app, r| {
                super::report(&mut app.status_banner, r);
            })
        });
    }

    /// Removes a node from the account's list (all devices, one call on the hub), signs out there, drops its servers.
    /// The hub's USER_SETTINGS_UPDATE removes it on the other devices.
    pub fn remove_saved_node(&mut self, origin: &str) {
        if self.api.is_none() {
            self.settings.private_nodes.retain(|n| n.origin != origin);
            super::report(&mut self.status_banner, self.settings.save());
            return;
        }
        let path = format!("/users/@me/settings/private-nodes?origin={}", percent_encoding::utf8_percent_encode(origin, percent_encoding::NON_ALPHANUMERIC));
        let o = origin.to_string();
        // only this session's answer arrives here (pump_bg); the list itself comes with USER_SETTINGS_UPDATE
        self.with_conn(&None, |app| {
            app.api_bg(true, move |api| api.delete(&path), move |app, r| {
                if super::report(&mut app.status_banner, r).is_some() {
                    app.settings.private_nodes.retain(|n| n.origin != o);
                    app.drop_node(&o, true);
                }
            })
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::ImageLoad;
    use std::sync::mpsc::SyncSender;

    /// A connected node without network: its events come from the returned sender, its requests go to `api`.
    fn fake_node(app: &mut CillhubApp, origin: &str, api: Option<&str>) -> SyncSender<GatewayEvent> {
        let (tx, rx) = mpsc::sync_channel(EVENT_QUEUE);
        app.node_gen += 1;
        let mut c = NodeConn::new(app.node_gen);
        c.rx = Some(rx);
        c.api = api.map(|a| crate::api::ApiClient::new(url::Url::parse(a).unwrap(), Some("node-token".into())));
        app.conns.insert(origin.into(), c);
        app.parked.insert(Some(origin.into()), Front::default());
        tx
    }

    fn send(tx: &SyncSender<GatewayEvent>, name: &str, d: Value) {
        tx.send(GatewayEvent::Dispatch(name.into(), d)).unwrap();
    }

    /// Against a hub, two linked nodes and a standalone node (the rig on control port CILLHUB_TEST_RIG).
    #[cfg(feature = "native-net")]
    #[test]
    #[ignore]
    fn real_hub_and_nodes_at_once() {
        let rig = std::env::var("CILLHUB_TEST_RIG").expect("CILLHUB_TEST_RIG");
        let ctl = |path: &str| -> Value { reqwest::blocking::get(format!("{rig}/{path}")).unwrap().json().unwrap() };
        let cfg = ctl("config");
        let node = |p: &str, k: &str| cfg["nodes"][p][k].as_str().unwrap().to_string();
        let (alpha, beta, solo) = (node("3393", "origin"), node("3394", "origin"), node("3395", "origin"));
        let wait = |app: &mut CillhubApp, what: &str, ok: &dyn Fn(&CillhubApp) -> bool| {
            let t = Instant::now();
            while !ok(app) {
                assert!(t.elapsed() < Duration::from_secs(60), "timed out waiting for {what}: {:?} list {:?} links {:?}", app.status_banner,
                    app.settings.private_nodes, app.conns.iter().map(|(o, c)| (o.clone(), c.link.clone())).collect::<Vec<_>>());
                app.pump_bg();
                app.process_background_events();
                std::thread::sleep(Duration::from_millis(20));
            }
            eprintln!("[real] {what} ({} ms)", t.elapsed().as_millis());
        };
        let link = |app: &CillhubApp, o: &str| app.conns.get(o).map(|c| c.link.clone());
        let mut app = CillhubApp::new(None, false);
        app.settings.private_nodes.clear();
        app.settings.server_target = "node".into();
        app.auth_server_url = cfg["hub"].as_str().unwrap().into();
        app.auth_login_input = "alex".into();
        app.auth_password_input = "hunter2hunter2".into();
        app.submit_auth();
        wait(&mut app, "hub READY", &|a| a.state.me.is_some());
        for o in [&alpha, &beta, &solo] {
            app.add_node(o.clone(), true);
            wait(&mut app, "node added", &|a| !a.node_busy && a.settings.private_nodes.iter().any(|n| &n.origin == o));
        }
        wait(&mut app, "both linked nodes connected, the standalone one not", &|a| {
            link(a, &alpha) == Some(NodeLink::Ready) && link(a, &beta) == Some(NodeLink::Ready) && link(a, &solo) == Some(NodeLink::OwnLogin)
        });
        let hub_token = app.api.as_ref().unwrap().token.clone().unwrap();
        for (p, o) in [("3393", &alpha), ("3394", &beta)] {
            let t = app.settings.node_token(&app.node_key(o)).expect("node token stored");
            assert_ne!(t, hub_token);
            assert_eq!(ctl(&format!("me/3390/{t}"))["status"], 401, "a node token is useless on the hub");
            assert_eq!(ctl(&format!("me/{p}/{hub_token}"))["status"], 401, "the hub token is not a node token");
            // Alex joins the node's server (as an invite would); the node's GUILD_CREATE brings it
            crate::api::ApiClient::new(url::Url::parse(o).unwrap(), Some(t)).post(&format!("/invites/{}", node(p, "invite")), json!({})).unwrap();
            let g = node(p, "guild");
            let conn = Some(o.clone());
            wait(&mut app, "node server in the rail", &|a| a.conn_state(&conn).is_some_and(|s| s.guilds.contains_key(&g)));
        }
        let say = |app: &mut CillhubApp, conn: Conn, gid: Option<String>, cid: String, text: &str, port: &str| {
            app.show(&conn);
            app.selected_guild_id = gid;
            app.selected_channel_id = Some(cid.clone());
            app.load_channel_history(&cid);
            wait(app, "history", &|a| a.state.messages.contains_key(&cid));
            app.send_message_to_selected(text);
            let me = app.state.me.as_ref().unwrap().id.clone();
            wait(app, "own message echoed", &|a| a.state.messages[&cid].iter().any(|m| m.content == text && m.author.as_ref().is_some_and(|u| u.id == me)));
            assert!(ctl(&format!("messages/{port}")).as_array().unwrap().iter().any(|m| m == text), "{text} stored on {port}");
        };
        let hub_gid = app.conn_state(&None).unwrap().guilds.keys().next().cloned();
        let (on_alpha, on_beta) = (Some(alpha.clone()), Some(beta.clone()));
        say(&mut app, None, hub_gid.clone(), cfg["hub_channel"].as_str().unwrap().into(), "Hello hub from Alex", "3390");
        say(&mut app, on_alpha.clone(), Some(node("3393", "guild")), node("3393", "channel"), "Hello Alpha from Alex", "3393");
        say(&mut app, on_beta.clone(), Some(node("3394", "guild")), node("3394", "channel"), "Hello Beta from Alex", "3394");

        ctl("stop/3394");
        wait(&mut app, "Beta greyed with a reason", &|a| matches!(link(a, &beta), Some(NodeLink::Down(_))));
        eprintln!("[real] Beta mark: {:?}", app.node_mark(&beta));
        say(&mut app, None, hub_gid.clone(), cfg["hub_channel"].as_str().unwrap().into(), "Hub still works while Beta is down", "3390");
        ctl("start/3394");
        wait(&mut app, "Beta reconnected", &|a| link(a, &beta) == Some(NodeLink::Ready));
        app.show(&on_beta);
        app.state.messages.remove(&node("3394", "channel"));
        say(&mut app, on_beta.clone(), Some(node("3394", "guild")), node("3394", "channel"), "Beta is back", "3394");

        // a second device with the same account: gets the list from the hub and connects without a click
        let mut other = CillhubApp::new(None, false);
        other.settings.private_nodes.clear();
        other.settings.node_tokens.clear();
        other.settings.server_target = "node".into();
        other.auth_server_url = cfg["hub"].as_str().unwrap().into();
        other.auth_login_input = "alex".into();
        other.auth_password_input = "hunter2hunter2".into();
        other.submit_auth();
        wait(&mut other, "second device: both nodes connected from the synced list", &|a| {
            link(a, &alpha) == Some(NodeLink::Ready) && link(a, &beta) == Some(NodeLink::Ready) && a.settings.private_nodes.len() == 3
        });

        let alpha_token = app.settings.node_token(&app.node_key(&alpha)).unwrap();
        app.remove_saved_node(&alpha);
        wait(&mut app, "Alpha removed", &|a| !a.settings.private_nodes.iter().any(|n| n.origin == alpha) && !a.conns.contains_key(&alpha));
        wait(&mut other, "second device dropped Alpha too", &|a| !a.conns.contains_key(&alpha) && a.conn_state(&on_alpha).is_none());
        other.logout();
        let t = Instant::now();
        while ctl(&format!("me/3393/{alpha_token}"))["status"] != 401 {
            assert!(t.elapsed() < Duration::from_secs(20), "Alpha token still valid");
            app.pump_bg();
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(app.settings.node_token(&app.node_key(&alpha)).is_none() && app.conn_state(&on_alpha).is_none());
        let list = app.api.as_ref().unwrap().get("/users/@me/settings").unwrap()["private_nodes"].clone();
        assert_eq!(list.as_array().unwrap().len(), 2, "{list}");
        eprintln!("[real] hub list after remove: {list}");

        let beta_key = app.node_key(&beta);
        let beta_token = app.settings.node_token(&beta_key).unwrap();
        app.logout();
        assert!(app.settings.node_token(&beta_key).is_none() && app.settings.private_nodes.is_empty() && app.parked.is_empty());
        let t = Instant::now();
        while ctl(&format!("me/3394/{beta_token}"))["status"] != 401 {
            assert!(t.elapsed() < Duration::from_secs(20), "Beta token still valid after logout");
            app.pump_bg();
            std::thread::sleep(Duration::from_millis(100));
        }
        wait(&mut app, "sign-outs confirmed", &|a| a.settings.pending_revokes.is_empty());
        eprintln!("[real] ALL OK");
    }

    #[cfg(feature = "native-net")]
    #[test]
    fn a_late_sign_in_is_revoked_on_the_node_and_never_stored() {
        let (node, seen) = crate::api::testing::serve(1, |_| (204, String::new()));
        let mut app = CillhubApp::new(None, true);
        app.settings.private_nodes = vec![crate::nodes::SavedNode { origin: node.clone(), name: "Robin".into() }];
        let old = app.session_gen;
        app.new_session(); // logout, or another account logged in
        app.signin_tx.send((old, node.clone(), 0, Ok("late-token".into()))).unwrap();
        app.tick_nodes();
        assert_eq!(app.settings.node_token(&app.node_key(&node)), None);
        assert!(app.conns.is_empty());
        let seen = seen.join().unwrap();
        assert!(seen[0].starts_with("POST /api/v9/auth/logout ") && seen[0].contains("late-token"), "{seen:?}");
        let t = Instant::now();
        while !app.settings.pending_revokes.is_empty() {
            assert!(t.elapsed() < Duration::from_secs(5), "the confirmed sign-out stays pending");
            app.tick_nodes();
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// A node's events change only that node's data, whatever ids they name; account-wide events are dropped.
    #[test]
    fn node_events_never_touch_hub_data() {
        let mut app = CillhubApp::new(None, true); // the demo state stands in for the hub's
        let hub_before = (app.state.messages["c_general"].len(), app.state.channels.len(), app.state.users["u_sam"].username.clone());
        let a = "https://a.example";
        let tx = fake_node(&mut app, a, None);
        send(&tx, "READY", json!({ "session_id": "s", "user": { "id": "u_me", "username": "evil-me" }, "guilds": [] }));
        // a server that carries hub channel ids, and a hub friend's id with another name
        send(&tx, "GUILD_CREATE", json!({ "id": "g_arena", "name": "Taken", "channels": [{ "id": "c_general", "type": 0, "name": "x" }],
            "members": [{ "user": { "id": "u_sam", "username": "evil-sam" } }] }));
        send(&tx, "MESSAGE_DELETE", json!({ "id": "m_1", "channel_id": "c_general", "guild_id": "g_arena" }));
        send(&tx, "CHANNEL_DELETE", json!({ "id": "c_general", "guild_id": "g_arena" }));
        send(&tx, "MESSAGE_CREATE", json!({ "id": "m9", "channel_id": "c_general", "guild_id": "g_arena", "content": "x", "author": { "id": "u_sam", "username": "evil-sam" } }));
        send(&tx, "USER_SETTINGS_UPDATE", json!({ "theme": "light" }));
        send(&tx, "RELATIONSHIP_ADD", json!({ "id": "u_kim", "type": 1, "user": { "id": "u_kim", "username": "kim" } }));
        app.tick_nodes();
        assert_eq!(app.front, None);
        assert_eq!((app.state.messages["c_general"].len(), app.state.channels.len(), app.state.users["u_sam"].username.clone()), hub_before);
        assert_eq!(app.state.guilds["g_arena"].name, "Cillhub Arena");
        assert_eq!(app.state.me.as_ref().unwrap().username, "alex", "the local account stays");
        let node = app.conn_state(&Some(a.into())).unwrap();
        assert_eq!(node.guilds["g_arena"].name, "Taken");
        assert_eq!(node.users["u_sam"].username, "evil-sam", "kept in the node's own users");
        assert!(node.relationships.is_empty() && node.user_settings.theme.is_none(), "account-wide events are dropped");
        assert_eq!(app.conns[a].link, NodeLink::Ready);
    }

    /// Requests go to the connection whose data is in front when they start; an id a node names (even "channels",
    /// even a hub channel id) never moves a hub request to it. Late answers of a removed node are dropped.
    #[cfg(feature = "native-net")]
    #[test]
    fn requests_follow_the_connection_not_the_ids() {
        let (hub, hub_seen) = crate::api::testing::serve(2, |_| (200, "[]".into()));
        let (node, node_seen) = crate::api::testing::serve(1, |_| (200, r#"[{"id":"m9","channel_id":"c_general","content":"from the node","author":{"id":"u_sam","username":"evil"}}]"#.into()));
        let mut app = CillhubApp::new(None, true);
        app.api = Some(crate::api::ApiClient::new(url::Url::parse(&hub).unwrap(), Some("hub-token".into())));
        let tx = fake_node(&mut app, &node, Some(&node));
        send(&tx, "READY", json!({ "session_id": "s", "user": { "id": "n1", "username": "alex" },
            "guilds": [{ "id": "channels", "name": "odd", "channels": [{ "id": "c_general", "type": 0 }] }] }));
        app.tick_nodes();
        app.state.messages.remove("c_general");
        app.load_channel_history("c_general"); // hub in front: to the hub
        let conn = Some(node.clone());
        app.with_conn(&conn, |app| app.load_channel_history("c_general")); // the node's own channel of that id
        app.drop_node(&node, false); // removed before its answer arrives
        let t = Instant::now();
        while app.bg.pending > 0 {
            assert!(t.elapsed() < Duration::from_secs(5));
            app.pump_bg();
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(app.state.messages["c_general"].is_empty(), "the hub's answer, not the node's");
        assert!(app.parked.is_empty() && app.state.users["u_sam"].username == "sam");
        let _ = std::net::TcpStream::connect(hub.trim_start_matches("http://")); // ends the idle hub server
        let hub_seen = hub_seen.join().unwrap();
        assert!(hub_seen[0].starts_with("GET /api/v9/channels/c_general/messages") && hub_seen[0].contains("hub-token"));
        let node_seen = node_seen.join().unwrap();
        assert!(node_seen[0].contains("node-token") && !node_seen[0].contains("hub-token"));
    }

    fn settle(app: &mut CillhubApp) {
        let t = Instant::now();
        while app.bg.pending > 0 && t.elapsed() < Duration::from_secs(10) {
            app.pump_bg();
            std::thread::sleep(Duration::from_millis(5));
        }
        app.pump_bg();
    }

    /// Finding 1: search and canvas belong to the connection they were opened in; a switch shows the other's.
    #[test]
    fn search_and_canvas_stay_with_their_connection() {
        let mut app = CillhubApp::new(None, true);
        let a = "https://a.example";
        fake_node(&mut app, a, None);
        app.search = Some(crate::ui::SearchResults { query: "hub secret".into(), scope: "/guilds/g_arena".into(), ..Default::default() });
        (app.canvas_cid, app.canvas_doc_input) = (Some("c_general".into()), "hub notes".into());
        app.show(&Some(a.into()));
        assert!(app.search.is_none() && app.canvas_cid.is_none() && app.canvas_doc_input.is_empty(), "nothing of the hub's in the node's view");
        app.show(&None);
        assert_eq!(app.search.as_ref().map(|s| s.query.as_str()), Some("hub secret"));
        assert_eq!(app.canvas_doc_input, "hub notes");
    }

    /// Finding 2: a failed hub send comes back into the hub's composer only, never a node channel of the same id.
    #[cfg(feature = "native-net")]
    #[test]
    fn a_failed_hub_draft_never_lands_in_a_node_composer() {
        let mut app = CillhubApp::new(None, true);
        app.api = Some(crate::api::ApiClient::new(url::Url::parse("http://localhost:9/").unwrap(), None)); // refuses
        let a = "https://a.example";
        let tx = fake_node(&mut app, a, None);
        send(&tx, "READY", json!({ "session_id": "s", "user": { "id": "n1", "username": "alex" },
            "guilds": [{ "id": "g_arena", "name": "Node", "channels": [{ "id": "c_general", "type": 0, "guild_id": "g_arena" }] }] }));
        app.tick_nodes();
        app.selected_channel_id = Some("c_general".into());
        app.send_message_to_selected("for the hub only");
        app.show(&Some(a.into()));
        (app.selected_guild_id, app.selected_channel_id) = (Some("g_arena".into()), Some("c_general".into()));
        settle(&mut app);
        app.restore_failed_draft();
        assert!(app.composer_text.is_empty() && app.failed_drafts.is_empty(), "the node view got nothing");
        app.show(&None);
        app.restore_failed_draft();
        assert_eq!(app.composer_text, "for the hub only");
    }

    /// Finding 3: an answer that would open a server changes the view only if the window still shows its connection.
    #[cfg(feature = "native-net")]
    #[test]
    fn a_late_join_never_moves_the_view() {
        let (hub, seen) = crate::api::testing::serve(1, |_| (200, r#"{"id":"g_new","name":"New","channels":[{"id":"c_new","type":0,"guild_id":"g_new"}]}"#.into()));
        let mut app = CillhubApp::new(None, true);
        app.api = Some(crate::api::ApiClient::new(url::Url::parse(&hub).unwrap(), Some("hub-token".into())));
        let a = "https://a.example";
        fake_node(&mut app, a, Some("http://127.0.0.1:1"));
        app.show(&Some(a.into()));
        (app.selected_guild_id, app.selected_channel_id) = (Some("g_n".into()), Some("c_n".into()));
        app.join_invite("abc".into()); // Finding 4 too: from a node's view the invite goes to the hub
        settle(&mut app);
        assert_eq!((app.selected_guild_id.as_deref(), app.selected_channel_id.as_deref()), (Some("g_n"), Some("c_n")));
        assert!(app.conn_state(&None).unwrap().guilds.contains_key("g_new"), "joined on the hub");
        app.show(&None);
        assert_ne!(app.selected_guild_id.as_deref(), Some("g_new"), "the hub view did not jump either");
        let seen = seen.join().unwrap();
        assert!(seen[0].starts_with("POST /api/v9/invites/abc ") && seen[0].contains("hub-token"));
    }

    /// Finding 4: attachment images are cached per connection.
    #[test]
    fn attachment_images_are_kept_per_connection() {
        let mut app = CillhubApp::new(None, true);
        let a = "https://a.example:8443";
        fake_node(&mut app, a, None);
        let hub = app.attachment_uri("1", "a.png");
        app.show(&Some(a.into()));
        assert_ne!(app.attachment_uri("1", "a.png"), hub);
    }

    /// Finding 5: member records for servers the node does not have are dropped, member lists are asked once per
    /// server, and members count against the node's limits.
    #[test]
    fn member_records_are_bounded() {
        let mut app = CillhubApp::new(None, true);
        let a = "https://a.example";
        let tx = fake_node(&mut app, a, None);
        send(&tx, "READY", json!({ "session_id": "s", "user": { "id": "n1", "username": "alex" }, "guilds": [{ "id": "g1", "name": "n" }] }));
        send(&tx, "GUILD_MEMBER_ADD", json!({ "guild_id": "made-up", "user_id": "x", "user": { "id": "x", "username": "x" } }));
        app.tick_nodes();
        let conn = Some(a.to_string());
        assert!(!app.conn_state(&conn).unwrap().members.contains_key("made-up"));
        // records that keep no user object still count
        let members: Vec<Value> = (0..MAX_ITEMS).map(|i| json!({ "guild_id": "g1", "user_id": i.to_string() })).collect();
        for m in members.chunks(EVENT_BUDGET) {
            for m in m {
                send(&tx, "GUILD_MEMBER_ADD", m.clone());
            }
            app.tick_nodes();
        }
        assert!(app.conn_state(&conn).is_none() && matches!(app.conns[a].link, NodeLink::Down(_)), "cut off before passing the budget");
    }

    /// Finding 6: a sign-in started for an earlier connection to the same node (removed and added again, or
    /// signed in meanwhile) is revoked, not adopted; a vote answer from before READY leaves the new choice alone.
    #[cfg(feature = "native-net")]
    #[test]
    fn stale_generations_are_dropped() {
        let (node, seen) = crate::api::testing::serve(1, |_| (204, String::new()));
        let mut app = CillhubApp::new(None, true);
        app.settings.private_nodes = vec![crate::nodes::SavedNode { origin: node.clone(), name: "Kim".into() }];
        fake_node(&mut app, &node, None);
        let now = app.conns[&node].gen;
        app.signin_tx.send((app.session_gen, node.clone(), now - 1, Ok("old-token".into()))).unwrap();
        app.tick_nodes();
        assert!(app.conns[&node].api.is_none() && app.settings.node_token(&app.node_key(&node)).is_none());
        assert!(seen.join().unwrap()[0].contains("old-token"), "revoked on the node");

        app.api = Some(crate::api::ApiClient::new(url::Url::parse("http://localhost:9/").unwrap(), None)); // refuses
        app.vote_poll("c_general", "m_1", 1, true);
        app.new_scope("history"); // READY
        app.poll_pending.insert("m_1".into(), vec![1]); // the same choice again, after READY
        settle(&mut app);
        assert_eq!(app.poll_pending.get("m_1"), Some(&vec![1]), "the old answer's failure does not remove it");
    }

    /// Finding 7: removing a node tombstones its keyring entry even when nothing could be read from it.
    #[test]
    fn removal_tombstones_an_unreadable_credential() {
        let mut app = CillhubApp::new(None, true);
        let a = "https://a.example";
        fake_node(&mut app, a, None);
        app.drop_node(a, false);
        assert!(app.settings.node_tombstones.contains(&app.node_key(a)));
    }

    /// Finding 8: an unconfirmed sign-out is tried again while the app runs, not only at the next start.
    #[cfg(feature = "native-net")]
    #[test]
    fn pending_sign_outs_are_retried_while_running() {
        let (node, seen) = crate::api::testing::serve(1, |_| (204, String::new()));
        let mut app = CillhubApp::new(None, true);
        app.settings.add_pending_revoke(&node, "pending-token").unwrap();
        app.last_revoke_retry = Instant::now() - Duration::from_secs(61);
        app.tick_nodes();
        assert!(seen.join().unwrap()[0].contains("pending-token"));
        let t = Instant::now();
        while !app.settings.pending_revokes.is_empty() {
            assert!(t.elapsed() < Duration::from_secs(5));
            app.tick_nodes();
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    /// Item 10: picked files reach only the draft they were picked for.
    #[test]
    fn picked_files_go_only_to_their_own_draft() {
        let mut app = CillhubApp::new(None, true); // hub view: c_general open
        let a = "https://a.example";
        fake_node(&mut app, a, None);
        let file = || vec![std::path::PathBuf::from("/tmp/hub-secret.pdf")];
        let session = app.session_gen;
        app.picked_tx.send((session, None, 0, Some("c_general".into()), file())).unwrap();
        app.show(&Some(a.into()));
        app.selected_guild_id = Some("g".into());
        app.selected_channel_id = Some("c_general".into()); // a node channel with the same id
        app.take_picked_files();
        assert!(app.pending_files.is_empty(), "nothing in the node's draft");
        app.show(&None);
        assert_eq!(app.pending_files.len(), 1, "in the hub draft it was picked for");
        app.picked_tx.send((session, None, 0, Some("c_lfg".into()), file())).unwrap(); // the user moved on
        app.take_picked_files();
        assert_eq!(app.pending_files.len(), 1);
    }

    /// Item 11: removing a node ends its sign-in before the consent (the worker's check sees the removal).
    #[test]
    fn removal_cancels_a_running_sign_in() {
        let mut app = CillhubApp::new(None, true);
        let a = "https://a.example";
        fake_node(&mut app, a, None);
        let (live, gen) = (app.conns[a].live.clone(), app.conns[a].gen);
        assert_eq!(live.load(std::sync::atomic::Ordering::SeqCst), gen);
        app.drop_node(a, false);
        assert_ne!(live.load(std::sync::atomic::Ordering::SeqCst), gen);
    }

    /// Item 12: a node's media only from its own origin, and never through a redirect.
    #[cfg(feature = "native-net")]
    #[test]
    fn node_media_only_from_the_node() {
        let mut app = CillhubApp::new(None, true);
        app.api = Some(crate::api::ApiClient::new(url::Url::parse("http://localhost:9/").unwrap(), None));
        let a = "https://a.example:8443";
        fake_node(&mut app, a, None);
        app.show(&Some(a.into()));
        app.request_image("bytes://x1", "http://127.0.0.1:8080/admin".into());
        app.request_image("bytes://x2", "https://a.example/a.png".into()); // another port
        app.request_image("bytes://x3", "https://a.example:8443/attachments/a.png".into());
        assert_eq!((app.images["bytes://x1"], app.images["bytes://x2"], app.images["bytes://x3"]), (ImageLoad::Failed, ImageLoad::Failed, ImageLoad::Loading));
        let (to, seen) = crate::api::testing::serve(1, |_| (302, String::new()));
        assert!(crate::ui::images::fetch(&crate::api::no_redirect_client(5), &format!("{to}/a.png")).is_err(), "a redirect is refused");
        seen.join().unwrap();
    }

    /// Items 13 and 14: User Settings draws only with the hub's data (its drafts start there), and the node view
    /// waits until it closes.
    #[test]
    fn user_settings_never_sees_node_data() {
        let mut app = CillhubApp::new(None, true);
        let a = "https://a.example";
        let tx = fake_node(&mut app, a, None);
        send(&tx, "READY", json!({ "session_id": "s", "user": { "id": "n1", "username": "evil", "global_name": "Evil Name" }, "guilds": [{ "id": "g", "name": "n" }] }));
        app.tick_nodes();
        app.show(&Some(a.into()));
        app.selected_guild_id = Some("g".into());
        app.active_modal = Some(super::super::ModalKind::UserSettings);
        let ctx = egui::Context::default();
        let mut input = egui::RawInput::default();
        input.screen_rect = Some(egui::Rect::from_min_size(egui::Pos2::ZERO, egui::Vec2::new(1280.0, 800.0)));
        let _ = ctx.run(input.clone(), |ctx| app.render_user_settings(ctx));
        assert_eq!(app.account_name_draft.as_deref(), Some("Alex"), "the hub account's name");
        let _ = ctx.run(input, |ctx| app.render_user_settings(ctx)); // a second frame with settings open
        app.keep_view_consistent();
        app.active_modal = None;
        app.keep_view_consistent();
        assert_eq!((app.shown.as_deref(), app.selected_guild_id.as_deref()), (Some(a), Some("g")), "back to the node view");
    }

    /// Item 5: a node's REST answer is counted before it goes in, and background work is bounded.
    #[cfg(feature = "native-net")]
    #[test]
    fn a_node_answer_over_budget_is_refused_and_work_is_bounded() {
        let big: Vec<Value> = (0..=MAX_ITEMS).map(|i| json!({ "id": i.to_string(), "channel_id": "c" })).collect();
        let body = serde_json::to_string(&big).unwrap();
        let (node, seen) = crate::api::testing::serve(1, move |_| (200, body.clone()));
        let mut app = CillhubApp::new(None, true);
        let tx = fake_node(&mut app, &node, Some(&node));
        send(&tx, "READY", json!({ "session_id": "s", "user": { "id": "n1", "username": "alex" }, "guilds": [{ "id": "g", "name": "n", "channels": [{ "id": "c", "type": 0, "guild_id": "g" }] }] }));
        app.tick_nodes();
        let conn = Some(node.clone());
        app.with_conn(&conn, |app| app.load_channel_history("c"));
        settle(&mut app);
        app.tick_nodes();
        assert!(app.conn_state(&conn).is_none(), "cut off, nothing installed");
        seen.join().unwrap();
        app.bg.pending = crate::ui::background::MAX_JOBS;
        assert!(!app.spawn_bg(false, || (), |_, ()| {}), "the queue is full");
        app.bg.pending = 0;
    }

    /// Item 8: a sign-out whose record cannot be saved keeps the credential and is saved again later.
    #[test]
    fn an_unsaved_sign_out_is_kept_and_saved_again() {
        let mut app = CillhubApp::new(None, true);
        let a = "http://127.0.0.1:1"; // offline: the sign-out cannot be confirmed now
        let key = app.node_key(a);
        app.settings.set_node_token(&key, Some("node-token")).unwrap();
        crate::settings::FAIL_SAVE.with(|f| f.set(true));
        app.drop_node(a, true);
        crate::settings::FAIL_SAVE.with(|f| f.set(false));
        assert_eq!(app.settings.node_token(&key).as_deref(), Some("node-token"), "the only durable record stays");
        assert_eq!(app.unsaved_revokes.len(), 1);
        app.last_revoke_retry = Instant::now() - Duration::from_secs(61);
        app.tick_nodes();
        assert!(app.unsaved_revokes.is_empty() && app.settings.pending_revokes.len() == 1, "saved now, retried until confirmed");
    }

    #[test]
    fn a_node_over_its_limits_is_cut_off() {
        let mut app = CillhubApp::new(None, true);
        let a = "https://a.example";
        let tx = fake_node(&mut app, a, None);
        // roles count like everything else, checked before the READY goes in
        let roles: Vec<Value> = (0..=MAX_ITEMS).map(|i| json!({ "id": i.to_string(), "name": "r" })).collect();
        let guilds = vec![json!({ "id": "1", "name": "g", "roles": roles })];
        send(&tx, "READY", json!({ "session_id": "s", "user": { "id": "n1", "username": "alex" }, "guilds": guilds }));
        app.tick_nodes();
        assert!(app.conn_state(&Some(a.into())).is_none(), "its data is gone");
        assert!(matches!(app.conns[a].link, NodeLink::Down(_)));
    }

    #[test]
    fn a_late_token_is_adopted_only_by_its_own_session_and_list() {
        assert_eq!(outcome(3, 3, true, true), Outcome::Adopt);
        assert_eq!(outcome(2, 3, true, true), Outcome::Revoke, "logout or another account meanwhile");
        assert_eq!(outcome(3, 3, false, true), Outcome::Revoke, "removed meanwhile");
        assert_eq!(outcome(2, 3, true, false), Outcome::Drop);
        assert_eq!(outcome(3, 3, true, false), Outcome::Fail);
    }
}
