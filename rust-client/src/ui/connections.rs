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

/// One connection's data while another one is in front.
#[derive(Default)]
pub struct Front {
    state: State,
    poll_pending: HashMap<String, Vec<u32>>,
    loading_history: HashSet<String>,
    scopes: HashMap<String, u64>,
}

/// Node events applied per frame; the rest wait in the bounded queue (the gateway stops reading when it is full).
const EVENT_BUDGET: usize = 500;
/// A node with more than this is cut off ("too much data"): it cannot grow this app's memory without bound.
const MAX_GUILDS: usize = 200;
const MAX_CHANNELS: usize = 20_000;
const MAX_USERS: usize = 200_000;

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
}

impl NodeConn {
    fn new(gen: u64) -> Self {
        Self { link: NodeLink::Connecting, rx: None, cmd: None, api: None, tries: 0, retry_at: None, busy: false, gen }
    }
    fn close(&mut self) {
        if let Some(tx) = self.cmd.take() {
            let _ = tx.send(GatewayCommand::Shutdown);
        }
        self.rx = None;
    }
}

/// A finished background sign-in: (session it was started in, origin, result).
pub type SignInDone = (u64, String, Result<String, SignInFail>);

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
        let Some(next) = self.parked.remove(conn) else { return false };
        let cur = Front {
            state: std::mem::replace(&mut self.state, next.state),
            poll_pending: std::mem::replace(&mut self.poll_pending, next.poll_pending),
            loading_history: std::mem::replace(&mut self.loading_history, next.loading_history),
            scopes: std::mem::replace(&mut self.scopes, next.scopes),
        };
        self.parked.insert(std::mem::replace(&mut self.front, conn.clone()), cur);
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
        let (gen, live, tx, origin) = (self.session_gen, self.session_live.clone(), self.signin_tx.clone(), origin.to_string());
        let hub_token = api.token.clone().unwrap_or_default();
        self.spawn_bg(
            false,
            move || {
                let alive = || live.load(std::sync::atomic::Ordering::SeqCst) == gen;
                let r = api
                    .get("/federation/nodes")
                    .map_err(|e| SignInFail::Down(if e.status == 0 { tr("Can't reach the server.").to_string() } else { e.to_string() }))
                    .and_then(|records| match crate::nodes::find_record(&records, &origin) {
                        None => Err(SignInFail::OwnLogin), // standalone, or linked to another hub
                        Some((_, _, false)) => Err(SignInFail::Down(tr("Suspended by the hub").to_string())),
                        Some((id, _, true)) => crate::nodes::sign_in(&api.origin, &hub_token, &origin, &id, &alive),
                    });
                let _ = tx.send((gen, origin, r));
            },
            |_, ()| {},
        );
    }

    /// Opens a node's gateway with its token; its requests use that token from now on.
    fn open_node(&mut self, origin: &str, token: String) {
        let Ok(url) = url::Url::parse(origin) else { return };
        self.parked.entry(Some(origin.to_string())).or_default();
        let (ev_tx, ev_rx) = mpsc::sync_channel(EVENT_QUEUE);
        let (cmd_tx, cmd_rx) = mpsc::channel();
        spawn_node(url.clone(), token.clone(), ev_tx, cmd_rx);
        let Some(c) = self.conns.get_mut(origin) else { return };
        c.close();
        (c.rx, c.cmd, c.link) = (Some(ev_rx), Some(cmd_tx), NodeLink::Connecting);
        c.api = Some(crate::api::ApiClient::new(url, Some(token)));
    }

    /// Tries again later, 5 s doubling up to 5 minutes; nothing waits for it.
    fn retry(&mut self, origin: &str, why: String) {
        if let Some(c) = self.conns.get_mut(origin) {
            c.tries += 1;
            c.link = NodeLink::Down(why);
            c.retry_at = Some(Instant::now() + Duration::from_secs(crate::nodes::backoff_secs(c.tries)));
        }
    }

    /// Ends a node's session there on its own thread; the sign-out stays pending (saved) until the node confirms.
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
        while let Ok((key, ok)) = self.revoke_rx.try_recv() {
            self.revoking.remove(&key);
            if ok {
                super::report(&mut self.status_banner, self.settings.clear_pending_revoke(&key));
            }
        }
        while let Ok((gen, origin, r)) = self.signin_rx.try_recv() {
            let saved = self.settings.private_nodes.iter().any(|n| n.origin == origin);
            if gen == self.session_gen {
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
                    let key = self.settings.add_pending_revoke(&origin, &token);
                    self.revoke_async(key, origin, token);
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
            for ev in events {
                if !self.conns.contains_key(&origin) {
                    break; // cut off by an earlier event of this batch
                }
                self.node_event(&origin, ev);
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

    fn node_event(&mut self, origin: &str, ev: GatewayEvent) {
        let conn = Some(origin.to_string());
        match ev {
            GatewayEvent::Dispatch(name, d) => {
                if name != "READY" && !NODE_EVENTS.contains(&name.as_str()) {
                    eprintln!("cillhub: {origin} sent {name}: dropped");
                    return;
                }
                let too_much = self.with_conn(&conn, |app| app.apply_node_event(&conn, &name, d)).unwrap_or(false);
                if too_much {
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
            }
            // the gateway keeps reconnecting by itself; its servers are greyed meanwhile
            GatewayEvent::ConnectionError(_) => self.set_link(origin, NodeLink::Down(crate::i18n::trf("{name} is not reachable right now.", &[("name", &self.node_name(origin))]))),
            GatewayEvent::RejectedToken => {
                // the node ended our session there: a new background sign-in
                if let Some(c) = self.conns.get_mut(origin) {
                    c.close();
                    c.api = None;
                }
                let key = self.node_key(origin);
                super::report(&mut self.status_banner, self.settings.set_node_token(&key, None));
                self.retry(origin, tr("Signed out").to_string());
            }
            GatewayEvent::Connected => {}
        }
    }

    /// Applies one node event to that node's own data (in front now). True when the node is over its limits.
    fn apply_node_event(&mut self, conn: &Conn, name: &str, d: Value) -> bool {
        let s = |k: &str| d.get(k).and_then(Value::as_str).map(String::from);
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
        self.state.guilds.len() > MAX_GUILDS || self.state.channels.len() > MAX_CHANNELS || self.state.users.len() > MAX_USERS
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
            c.api.and_then(|a| a.token)
        });
        self.drop_node_data(origin);
        let stored = self.settings.node_token(&key);
        if sign_out {
            for token in live.into_iter().chain(stored.clone()).collect::<HashSet<_>>() {
                let pending = self.settings.add_pending_revoke(origin, &token);
                self.revoke_async(pending, origin.to_string(), token);
            }
        }
        if stored.is_some() {
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
        app.signin_tx.send((old, node.clone(), Ok("late-token".into()))).unwrap();
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

    #[test]
    fn a_node_over_its_limits_is_cut_off() {
        let mut app = CillhubApp::new(None, true);
        let a = "https://a.example";
        let tx = fake_node(&mut app, a, None);
        let guilds: Vec<Value> = (0..=MAX_GUILDS).map(|i| json!({ "id": i.to_string(), "name": "g" })).collect();
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
