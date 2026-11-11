//! Saved private nodes connected next to the hub (stage 2a): per node origin a token (own keyring entry), a
//! gateway and a link state. Node servers join the one State; their guild and channel ids are recorded in
//! `routes.owner`, so requests about them go to their node (api::Routes) and only that node's events may touch them.
use super::CillhubApp;
use crate::api::{inbound, Routes};
use crate::i18n::tr;
use crate::native_gateway::{spawn_node, GatewayCommand, GatewayEvent};
use crate::nodes::{NodeLink, SignInFail};
use serde_json::{json, Value};
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};

pub struct NodeConn {
    pub link: NodeLink,
    rx: Option<Receiver<GatewayEvent>>,
    cmd: Option<Sender<GatewayCommand>>,
    tries: u32,
    retry_at: Option<Instant>,
    busy: bool,
}

impl NodeConn {
    fn new() -> Self {
        Self { link: NodeLink::Connecting, rx: None, cmd: None, tries: 0, retry_at: None, busy: false }
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
    fn routes_mut(&self) -> std::sync::RwLockWriteGuard<'_, Routes> {
        self.routes.write().unwrap_or_else(|e| e.into_inner())
    }

    /// The node origin that owns a guild or channel id; None = the hub.
    pub fn owner_of(&self, id: &str) -> Option<String> {
        self.routes.read().unwrap_or_else(|e| e.into_inner()).owner.get(id).cloned()
    }

    /// History requests are scoped per connection: a node's READY makes only that node's older answers stale.
    pub fn history_key(&self, channel_id: &str) -> String {
        self.owner_of(channel_id).map_or_else(|| "history".to_string(), |o| format!("history@{o}"))
    }

    /// The saved node's name for marks and rows.
    pub fn node_name(&self, origin: &str) -> String {
        let n = self.settings.private_nodes.iter().find(|n| n.origin == origin);
        n.map(|n| n.name.clone()).filter(|n| !n.is_empty()).unwrap_or_else(|| origin.split("://").nth(1).unwrap_or(origin).to_string())
    }

    /// On the hub's READY and USER_SETTINGS_UPDATE: the hub copy of the list wins (removals on another device
    /// too); an account that never saved one (null) takes this device's. Then every saved node gets a try.
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
        self.connect_saved();
    }

    /// Takes a list the hub sent (settings answer or event); nodes no longer in it are signed out and dropped.
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
        if self.api.is_none() {
            return;
        }
        for n in self.settings.private_nodes.clone() {
            if self.conns.contains_key(&n.origin) {
                continue;
            }
            self.conns.insert(n.origin.clone(), NodeConn::new());
            match self.settings.node_token(&n.origin) {
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
                let r = crate::api::ApiClient::new(api.origin.clone(), api.token.clone())
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

    /// Opens a node's gateway with its token; requests about its servers use the token from now on.
    fn open_node(&mut self, origin: &str, token: String) {
        let Ok(url) = url::Url::parse(origin) else { return };
        self.routes_mut().nodes.insert(origin.to_string(), (token.clone(), String::new()));
        let (ev_tx, ev_rx) = mpsc::channel();
        let (cmd_tx, cmd_rx) = mpsc::channel();
        spawn_node(url, token, ev_tx, cmd_rx);
        let c = self.conns.entry(origin.to_string()).or_insert_with(NodeConn::new);
        c.close();
        (c.rx, c.cmd, c.link) = (Some(ev_rx), Some(cmd_tx), NodeLink::Connecting);
    }

    /// Tries again later, 5 s doubling up to 5 minutes; nothing waits for it.
    fn retry(&mut self, origin: &str, why: String) {
        if let Some(c) = self.conns.get_mut(origin) {
            c.tries += 1;
            c.link = NodeLink::Down(why);
            c.retry_at = Some(Instant::now() + Duration::from_secs(crate::nodes::backoff_secs(c.tries)));
        }
    }

    /// Every frame: finished sign-ins, node gateway events, due retries.
    pub fn tick_nodes(&mut self) {
        while let Ok((gen, origin, r)) = self.signin_rx.try_recv() {
            let saved = self.settings.private_nodes.iter().any(|n| n.origin == origin);
            let fresh = gen == self.session_gen;
            if fresh {
                if let Some(c) = self.conns.get_mut(&origin) {
                    c.busy = false;
                }
            }
            match (outcome(gen, self.session_gen, saved, r.is_ok()), r) {
                (Outcome::Adopt, Ok(token)) => {
                    super::report(&mut self.status_banner, self.settings.set_node_token(&origin, Some(&token)));
                    self.open_node(&origin, token);
                }
                // started for another session, or the node was removed meanwhile: never stored, ended on the node
                (Outcome::Revoke, Ok(token)) => {
                    std::thread::spawn(move || crate::nodes::revoke(&origin, &token));
                }
                (Outcome::Fail, Err(SignInFail::OwnLogin)) => self.set_link(&origin, NodeLink::OwnLogin),
                (Outcome::Fail, Err(SignInFail::Old)) => self.set_link(&origin, NodeLink::Old),
                (Outcome::Fail, Err(SignInFail::Down(why))) => self.retry(&origin, why),
                _ => {}
            }
        }
        let origins: Vec<String> = self.conns.keys().cloned().collect();
        for origin in origins {
            let events: Vec<GatewayEvent> = self.conns.get(&origin).and_then(|c| c.rx.as_ref()).map(|rx| rx.try_iter().collect()).unwrap_or_default();
            for ev in events {
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
        match ev {
            GatewayEvent::Dispatch(name, d) if name == "READY" => self.node_ready(origin, d),
            GatewayEvent::Dispatch(name, d) => self.node_dispatch(origin, &name, d),
            // the gateway keeps reconnecting by itself; its servers are greyed meanwhile
            GatewayEvent::ConnectionError(_) => self.set_link(origin, NodeLink::Down(crate::i18n::trf("{name} is not reachable right now.", &[("name", &self.node_name(origin))]))),
            GatewayEvent::RejectedToken => {
                // the node ended our session there: a new background sign-in
                if let Some(c) = self.conns.get_mut(origin) {
                    c.close();
                }
                self.routes_mut().nodes.remove(origin);
                super::report(&mut self.status_banner, self.settings.set_node_token(origin, None));
                self.retry(origin, tr("Signed out").to_string());
            }
            GatewayEvent::Connected => {}
        }
    }

    fn hub_me(&self) -> String {
        self.state.me.as_ref().map(|u| u.id.clone()).unwrap_or_default()
    }

    /// An id for `origin`: its own already, or new and not the hub's (the hub wins an id both name).
    fn claim(&mut self, origin: &str, id: &str) -> bool {
        let hub_has = self.state.guilds.contains_key(id) || self.state.channels.contains_key(id);
        let mut r = self.routes_mut();
        match r.owner.get(id) {
            Some(o) => o == origin,
            None if hub_has => false,
            None => {
                r.owner.insert(id.to_string(), origin.to_string());
                true
            }
        }
    }

    /// A node GUILD_CREATE: the guild and its channels become the node's, unless the hub has them.
    fn claim_guild(&mut self, origin: &str, g: &Value) -> bool {
        let Some(id) = g.get("id").and_then(Value::as_str) else { return false };
        if !self.claim(origin, id) {
            return false;
        }
        for c in ["channels", "threads"].iter().flat_map(|k| g.get(*k).and_then(Value::as_array)).flatten() {
            if let Some(cid) = c.get("id").and_then(Value::as_str) {
                self.claim(origin, cid);
            }
        }
        true
    }

    /// The node's READY replaces its servers wholesale (left ones disappear); hub data stays untouched.
    fn node_ready(&mut self, origin: &str, mut d: Value) {
        let node_me = d.pointer("/user/id").and_then(Value::as_str).unwrap_or("").to_string();
        let hub_me = self.hub_me();
        if let Some(n) = self.routes_mut().nodes.get_mut(origin) {
            n.1 = node_me.clone();
        }
        inbound(&mut d, origin, &node_me, &hub_me);
        self.drop_node_guilds(origin);
        for g in d.get("guilds").and_then(Value::as_array).cloned().unwrap_or_default() {
            let Some(gid) = g.get("id").and_then(Value::as_str).map(String::from) else { continue };
            if self.claim_guild(origin, &g) {
                super::report(&mut self.status_banner, self.state.apply("GUILD_CREATE", g));
                self.load_members(&gid);
            }
        }
        for u in d.get("users").and_then(Value::as_array).into_iter().flatten() {
            // shortcut: node user ids share the hub's user map (hub entries win); key users by origin if collisions show up
            if let Ok(u) = crate::model::parse::<crate::model::User>(u.clone()) {
                self.state.users.entry(u.id.clone()).or_insert(u);
            }
        }
        // requests started before this READY belong to the replaced servers
        self.new_scope(&format!("history@{origin}"));
        let owner = self.routes.read().unwrap_or_else(|e| e.into_inner()).owner.clone();
        self.loading_history.retain(|c| owner.get(c).map(String::as_str) != Some(origin));
        if let Some(c) = self.conns.get_mut(origin) {
            (c.link, c.tries, c.retry_at) = (NodeLink::Ready, 0, None);
        }
        if let Some(cid) = self.selected_channel_id.clone().filter(|c| owner.get(c).map(String::as_str) == Some(origin)) {
            self.load_channel_history(&cid);
        }
    }

    /// Only guild-scoped events of this node's own servers apply; DMs, friends and settings stay on the hub.
    fn node_dispatch(&mut self, origin: &str, name: &str, mut d: Value) {
        let node_me = self.routes.read().unwrap_or_else(|e| e.into_inner()).nodes.get(origin).map(|n| n.1.clone()).unwrap_or_default();
        let hub_me = self.hub_me();
        inbound(&mut d, origin, &node_me, &hub_me);
        let s = |k: &str| d.get(k).and_then(Value::as_str).map(String::from);
        let own = |app: &Self, id: Option<String>| id.is_some_and(|id| app.owner_of(&id).as_deref() == Some(origin));
        let ok = match name {
            "GUILD_CREATE" => self.claim_guild(origin, &d),
            "GUILD_UPDATE" | "GUILD_DELETE" => own(self, s("id")),
            "USER_UPDATE" | "READY_SUPPLEMENTAL" => false,
            "PRESENCE_UPDATE" if d.pointer("/user/id").and_then(Value::as_str) == Some(hub_me.as_str()) => false,
            _ if d.get("guild_id").is_some_and(|g| !g.is_null()) => own(self, s("guild_id")),
            _ => own(self, s("channel_id")),
        };
        if !ok {
            return;
        }
        if matches!(name, "CHANNEL_CREATE" | "THREAD_CREATE") {
            if let Some(id) = s("id") {
                self.claim(origin, &id);
            }
        }
        let vote = name.starts_with("MESSAGE_POLL_VOTE_").then(|| s("channel_id").zip(s("message_id"))).flatten();
        let id = s("id");
        if let Err(e) = self.state.apply(name, d) {
            eprintln!("cillhub: node {name} not applied: {e}");
        }
        if let Some((cid, mid)) = vote {
            self.settle_poll(&cid, &mid);
        }
        if let Some(id) = id.filter(|_| name == "GUILD_CREATE") {
            self.load_members(&id);
        }
    }

    /// Removes a node's servers, channels and cached messages from the state (its ids stay recorded as its own).
    fn drop_node_guilds(&mut self, origin: &str) {
        let owner = self.routes.read().unwrap_or_else(|e| e.into_inner()).owner.clone();
        let mine = |id: &str| owner.get(id).map(String::as_str) == Some(origin);
        let gids: Vec<String> = self.state.guilds.keys().filter(|g| mine(g)).cloned().collect();
        for g in gids {
            let _ = self.state.apply("GUILD_DELETE", json!({ "id": g }));
        }
        self.state.messages.retain(|c, _| !mine(c));
        if self.selected_guild_id.as_deref().is_some_and(mine) {
            self.selected_guild_id = None;
            self.selected_channel_id = None;
        }
    }

    /// Ends a node connection: gateway closed, servers gone, token forgotten (and revoked on the node with `sign_out`).
    pub fn drop_node(&mut self, origin: &str, sign_out: bool) {
        if let Some(mut c) = self.conns.remove(origin) {
            c.close();
        }
        self.routes_mut().nodes.remove(origin);
        self.drop_node_guilds(origin);
        if let Some(token) = self.settings.node_token(origin) {
            if sign_out {
                let o = origin.to_string();
                std::thread::spawn(move || crate::nodes::revoke(&o, &token));
            }
            super::report(&mut self.status_banner, self.settings.set_node_token(origin, None));
        }
    }

    /// Hub logout: node sessions and the private node list belong to this hub account.
    pub fn forget_nodes(&mut self) {
        let mut origins: Vec<String> = self.settings.private_nodes.iter().map(|n| n.origin.clone()).collect();
        origins.extend(self.conns.keys().cloned());
        origins.extend(self.settings.node_tokens.keys().cloned());
        for o in origins {
            self.drop_node(&o, true);
        }
        self.settings.private_nodes.clear();
        *self.routes_mut() = Routes::default();
    }

    /// The hub's READY replaces the whole state: node servers are carried over (their gateways stay connected).
    pub fn keep_node_guilds(&self) -> Vec<(crate::model::Guild, Vec<crate::model::Channel>)> {
        let owner = self.routes.read().unwrap_or_else(|e| e.into_inner()).owner.clone();
        let node = |id: &str| owner.contains_key(id);
        self.state.guilds.values().filter(|g| node(&g.id)).map(|g| {
            (g.clone(), self.state.channels.values().filter(|c| c.guild_id.as_deref() == Some(&g.id)).cloned().collect())
        }).collect()
    }

    pub fn restore_node_guilds(&mut self, kept: Vec<(crate::model::Guild, Vec<crate::model::Channel>)>) {
        for (g, channels) in kept {
            // the hub wins an id it now names itself
            if self.state.guilds.contains_key(&g.id) {
                self.routes_mut().owner.remove(&g.id);
                continue;
            }
            for c in channels {
                self.state.channels.entry(c.id.clone()).or_insert(c);
            }
            self.state.guilds.insert(g.id.clone(), g);
        }
    }

    /// The node mark on a rail entry: (node name, link) for servers that are not on the hub.
    pub fn node_mark(&self, gid: &str) -> Option<(String, NodeLink)> {
        let origin = self.owner_of(gid)?;
        let link = self.conns.get(&origin).map_or(NodeLink::Down(tr("Not connected").to_string()), |c| c.link.clone());
        Some((self.node_name(&origin), link))
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
        self.api_bg(true, move |api| api.put("/users/@me/settings/private-nodes", Some(body)), |app, r| {
            super::report(&mut app.status_banner, r);
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
        self.api_bg(true, move |api| api.delete(&path), move |app, r| {
            if super::report(&mut app.status_banner, r).is_some() {
                app.settings.private_nodes.retain(|n| n.origin != o);
                app.drop_node(&o, true);
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!(app.settings.node_token(&node), None);
        assert!(app.routes.read().unwrap().nodes.is_empty());
        let seen = seen.join().unwrap();
        assert!(seen[0].starts_with("POST /api/v9/auth/logout ") && seen[0].contains("late-token"), "{seen:?}");
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
            let t = app.settings.node_token(o).expect("node token stored");
            assert_ne!(t, hub_token);
            assert_eq!(ctl(&format!("me/3390/{t}"))["status"], 401, "a node token is useless on the hub");
            assert_eq!(ctl(&format!("me/{p}/{hub_token}"))["status"], 401, "the hub token is not a node token");
            // Alex joins the node's server (as an invite would); the node's GUILD_CREATE brings it
            crate::api::ApiClient::new(url::Url::parse(o).unwrap(), Some(t)).post(&format!("/invites/{}", node(p, "invite")), json!({})).unwrap();
            let g = node(p, "guild");
            wait(&mut app, "node server in the rail", &|a| a.state.guilds.contains_key(&g) && a.node_mark(&g).is_some());
        }
        let say = |app: &mut CillhubApp, gid: Option<String>, cid: String, text: &str, port: &str| {
            app.selected_guild_id = gid;
            app.selected_channel_id = Some(cid.clone());
            app.load_channel_history(&cid);
            wait(app, "history", &|a| a.state.messages.contains_key(&cid));
            app.send_message_to_selected(text);
            let me = app.state.me.as_ref().unwrap().id.clone();
            wait(app, "own message echoed", &|a| a.state.messages[&cid].iter().any(|m| m.content == text && m.author.as_ref().is_some_and(|u| u.id == me)));
            assert!(ctl(&format!("messages/{port}")).as_array().unwrap().iter().any(|m| m == text), "{text} stored on {port}");
        };
        let hub_gid = app.state.guilds.keys().find(|g| app.node_mark(g).is_none()).cloned();
        say(&mut app, hub_gid.clone(), cfg["hub_channel"].as_str().unwrap().into(), "Hello hub from Alex", "3390");
        say(&mut app, Some(node("3393", "guild")), node("3393", "channel"), "Hello Alpha from Alex", "3393");
        say(&mut app, Some(node("3394", "guild")), node("3394", "channel"), "Hello Beta from Alex", "3394");

        ctl("stop/3394");
        wait(&mut app, "Beta greyed with a reason", &|a| matches!(link(a, &beta), Some(NodeLink::Down(_))));
        eprintln!("[real] Beta mark: {:?}", app.node_mark(&node("3394", "guild")));
        say(&mut app, hub_gid.clone(), cfg["hub_channel"].as_str().unwrap().into(), "Hub still works while Beta is down", "3390");
        ctl("start/3394");
        wait(&mut app, "Beta reconnected", &|a| link(a, &beta) == Some(NodeLink::Ready));
        app.state.messages.remove(&node("3394", "channel"));
        say(&mut app, Some(node("3394", "guild")), node("3394", "channel"), "Beta is back", "3394");

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

        let alpha_token = app.settings.node_token(&alpha).unwrap();
        app.remove_saved_node(&alpha);
        wait(&mut app, "Alpha removed", &|a| !a.settings.private_nodes.iter().any(|n| n.origin == alpha) && !a.conns.contains_key(&alpha));
        wait(&mut other, "second device dropped Alpha too", &|a| !a.conns.contains_key(&alpha) && !a.state.guilds.contains_key(&node("3393", "guild")));
        other.logout();
        let t = Instant::now();
        while ctl(&format!("me/3393/{alpha_token}"))["status"] != 401 {
            assert!(t.elapsed() < Duration::from_secs(20), "Alpha token still valid");
            app.pump_bg();
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(app.settings.node_token(&alpha).is_none() && !app.state.guilds.contains_key(&node("3393", "guild")));
        let list = app.api.as_ref().unwrap().get("/users/@me/settings").unwrap()["private_nodes"].clone();
        assert_eq!(list.as_array().unwrap().len(), 2, "{list}");
        eprintln!("[real] hub list after remove: {list}");

        let beta_token = app.settings.node_token(&beta).unwrap();
        app.logout();
        assert!(app.settings.node_token(&beta).is_none() && app.settings.private_nodes.is_empty());
        let t = Instant::now();
        while ctl(&format!("me/3394/{beta_token}"))["status"] != 401 {
            assert!(t.elapsed() < Duration::from_secs(20), "Beta token still valid after logout");
            app.pump_bg();
            std::thread::sleep(Duration::from_millis(100));
        }
        eprintln!("[real] ALL OK");
    }

    #[test]
    fn node_events_touch_only_that_nodes_servers() {
        let mut app = CillhubApp::new(None, true); // the demo state stands in for the hub's
        let (a, b) = ("https://a.example", "https://b.example");
        app.routes_mut().hub_me = "u_me".into();
        app.routes_mut().nodes.insert(a.into(), ("t".into(), "n9".into()));
        app.routes_mut().nodes.insert(b.into(), ("t".into(), "n8".into()));
        app.node_dispatch(a, "GUILD_CREATE", json!({ "id": "g_arena", "name": "Taken" }));
        assert_eq!(app.state.guilds["g_arena"].name, "Cillhub Arena", "the hub keeps its ids");
        app.node_dispatch(a, "GUILD_CREATE", json!({ "id": "500", "name": "Alpha Lounge", "channels": [{ "id": "501", "type": 0, "guild_id": "500" }] }));
        assert_eq!((app.owner_of("500").as_deref(), app.owner_of("501").as_deref()), (Some(a), Some(a)));
        app.node_dispatch(b, "GUILD_UPDATE", json!({ "id": "500", "name": "Taken by Beta" }));
        assert_eq!(app.state.guilds["500"].name, "Alpha Lounge");
        let hub_msgs = app.state.messages["c_general"].len();
        app.node_dispatch(b, "MESSAGE_CREATE", json!({ "id": "m9", "channel_id": "c_general", "content": "x", "author": { "id": "n8" } }));
        assert_eq!(app.state.messages["c_general"].len(), hub_msgs, "a node cannot write into hub channels");
        app.state.messages.insert("501".into(), Vec::new());
        app.node_dispatch(a, "MESSAGE_CREATE", json!({ "id": "m1", "channel_id": "501", "guild_id": "500", "content": "hi <@n9>", "author": { "id": "n9" } }));
        let m = &app.state.messages["501"][0];
        assert_eq!((m.author.as_ref().unwrap().id.as_str(), m.content.as_str()), ("u_me", "hi <@u_me>"), "our node account reads as us");
        assert_eq!(app.history_key("501"), format!("history@{a}"));
        app.drop_node(a, false);
        assert!(!app.state.guilds.contains_key("500") && !app.state.messages.contains_key("501"));
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
