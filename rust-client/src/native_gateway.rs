//! Native gateway worker: reconnects, identifies, heartbeats, sends outgoing
//! presence/voice commands, and forwards dispatches to a UI channel.
use crate::{
    api::api_url,
    games::GameActivity,
    gateway::{Action, Envelope, Gateway},
    model::CustomStatus,
    websocket::Opcode,
    websocket_transport::WebSocket,
};
use serde_json::Value;
use std::{
    io,
    sync::mpsc::{self, Receiver, SyncSender},
    thread,
    time::{Duration, Instant},
};
use url::Url;

#[derive(Debug)]
pub enum GatewayEvent {
    Dispatch(String, Value),
    /// A private node's event with the bytes it holds in that node's queue (the UI gives them back on receipt).
    NodeDispatch(String, Value, usize),
    ConnectionError(String),
    RejectedToken,
    Connected,
}

#[derive(Debug, Clone)]
pub enum GatewayCommand {
    UpdatePresence {
        status: String,
        custom_status: Option<CustomStatus>,
        game: Option<GameActivity>,
    },
    UpdateVoiceState {
        guild_id: Option<String>,
        channel_id: Option<String>,
        self_mute: bool,
        self_deaf: bool,
        self_video: bool,
        self_stream: bool,
    },
    Send(Envelope),
    Shutdown,
}

/// Events wait here for the UI; a full queue stalls the socket reader instead of growing memory.
pub const EVENT_QUEUE: usize = 10_000;
/// A private node's queue also holds at most this many bytes of events; the reader waits for the UI meanwhile.
pub const NODE_QUEUE_BYTES: usize = 32 << 20;
/// How long the reader waits for room before it gives the connection up (it reconnects later).
const NODE_QUEUE_WAIT: Duration = Duration::from_secs(60);

/// Gateway events a node may send: about its own servers only. Account-wide events (settings, relationships,
/// DMs, read states, sessions, saved messages) come from the hub alone. Others are dropped on the reader.
pub const NODE_EVENTS: &[&str] = &[
    "READY", "GUILD_CREATE", "GUILD_UPDATE", "GUILD_DELETE", "GUILD_ROLE_CREATE", "GUILD_ROLE_UPDATE", "GUILD_ROLE_DELETE",
    "GUILD_MEMBER_ADD", "GUILD_MEMBER_UPDATE", "GUILD_MEMBER_REMOVE", "CHANNEL_CREATE", "CHANNEL_UPDATE", "CHANNEL_DELETE",
    "THREAD_CREATE", "THREAD_UPDATE", "THREAD_DELETE", "THREAD_LIST_SYNC", "MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE",
    "MESSAGE_DELETE_BULK", "MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE", "MESSAGE_REACTION_REMOVE_ALL",
    "MESSAGE_POLL_VOTE_ADD", "MESSAGE_POLL_VOTE_REMOVE", "PRESENCE_UPDATE", "TYPING_START", "VOICE_STATE_UPDATE",
    "VOICE_CHANNEL_STATUS_UPDATE", "GUILD_EMOJIS_UPDATE", "GUILD_STICKERS_UPDATE", "GUILD_SCHEDULED_EVENT_CREATE",
    "GUILD_SCHEDULED_EVENT_UPDATE", "GUILD_SCHEDULED_EVENT_DELETE", "STAGE_INSTANCE_CREATE", "STAGE_INSTANCE_UPDATE",
    "STAGE_INSTANCE_DELETE", "CHANNEL_CANVAS_UPDATE",
];

/// The bytes a node's events hold in its queue (shared by the reader and the UI).
pub type QueueBytes = std::sync::Arc<std::sync::atomic::AtomicUsize>;

pub fn spawn(origin: Url, token: String, sender: SyncSender<GatewayEvent>) -> thread::JoinHandle<()> {
    let (_cmd_tx, cmd_rx) = mpsc::channel();
    spawn_with_commands(origin, token, sender, cmd_rx)
}

pub fn spawn_with_commands(
    origin: Url,
    token: String,
    sender: SyncSender<GatewayEvent>,
    commands: Receiver<GatewayCommand>,
) -> thread::JoinHandle<()> {
    spawn_inner(origin, token, sender, commands, None)
}

/// A private node's gateway: the node names its gateway URL, our node token goes only to the node's own host,
/// only NODE_EVENTS are queued and its queue holds at most NODE_QUEUE_BYTES (`queued`).
pub fn spawn_node(origin: Url, token: String, sender: SyncSender<GatewayEvent>, commands: Receiver<GatewayCommand>, queued: QueueBytes) -> thread::JoinHandle<()> {
    spawn_inner(origin, token, sender, commands, Some(queued))
}

fn spawn_inner(
    origin: Url,
    token: String,
    sender: SyncSender<GatewayEvent>,
    commands: Receiver<GatewayCommand>,
    node: Option<QueueBytes>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let client = crate::api::no_redirect_client(10);
        let mut backoff = 1u64;
        let mut last_presence: (String, Option<CustomStatus>, Option<GameActivity>) =
            ("online".to_string(), None, None);
        // one outbox for every attempt: commands held for READY survive a reconnect
        let mut outbox = Outbox::default();
        loop {
            match run_once(
                &client,
                &origin,
                &token,
                &sender,
                &commands,
                &mut last_presence,
                &mut outbox,
                node.as_ref(),
            ) {
                Ok(true) => break, // clean shutdown
                Ok(false) => backoff = 1,
                Err(error) => {
                    outbox.reconnect(); // commands from now on wait for the next READY
                    let _ = sender.send(GatewayEvent::ConnectionError(error.to_string()));
                    let sleep_until = Instant::now() + Duration::from_secs(backoff);
                    while Instant::now() < sleep_until {
                        if let Ok(cmd) = commands.try_recv() {
                            match cmd {
                                GatewayCommand::Shutdown => return,
                                GatewayCommand::UpdatePresence {
                                    status,
                                    custom_status,
                                    game,
                                } => {
                                    last_presence = (status, custom_status, game);
                                }
                                other => {
                                    outbox.command(other, &mut last_presence); // held for the next READY
                                }
                            }
                        }
                        thread::sleep(Duration::from_millis(100));
                    }
                    backoff = (backoff * 2).min(30);
                }
            }
        }
    })
}

#[allow(clippy::too_many_arguments)] // one connection attempt; the loop state lives in spawn_inner
fn run_once(
    client: &reqwest::blocking::Client,
    origin: &Url,
    token: &str,
    sender: &SyncSender<GatewayEvent>,
    commands: &Receiver<GatewayCommand>,
    last_presence: &mut (String, Option<CustomStatus>, Option<GameActivity>),
    outbox: &mut Outbox,
    node: Option<&QueueBytes>,
) -> io::Result<bool> {
    let pin = node.is_some();
    let endpoint = api_url(origin, "/gateway").ok_or_else(|| invalid("Invalid gateway API URL"))?;
    let resp = client
        .get(endpoint)
        .header("Authorization", token)
        .send()
        .map_err(io::Error::other)?
        .error_for_status()
        .map_err(io::Error::other)?;
    let data: Value = crate::api::read_json(resp).map_err(|e| io::Error::other(e.message))?; // bounded: a node is untrusted
    let address = data
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Gateway URL missing"))?;
    let address = Url::parse(address).map_err(|_| invalid("Gateway URL invalid"))?;
    if pin && !gateway_allowed(origin, &address) {
        return Err(invalid("Gateway on another host"));
    }
    let mut socket = WebSocket::connect(&address)?;
    let _ = sender.send(GatewayEvent::Connected);
    let mut protocol = Gateway::default();
    let mut heartbeat: Option<(Duration, Instant)> = None;
    outbox.reconnect();
    loop {
        while let Ok(cmd) = commands.try_recv() {
            if matches!(cmd, GatewayCommand::Shutdown) {
                return Ok(true);
            }
            if let Some(env) = outbox.command(cmd, last_presence) {
                socket.send(Opcode::Text, &serde_json::to_vec(&env).map_err(io::Error::other)?)?;
            }
        }
        match socket.read_frame() {
            Ok(frame) => match frame.opcode {
                Opcode::Text => {
                    let envelope: Envelope =
                        serde_json::from_slice(&frame.payload).map_err(io::Error::other)?;
                    outbox.identified |= envelope.op == 10;
                    let ready = envelope.op == 0 && matches!(envelope.t.as_deref(), Some("READY" | "RESUMED"));
                    let actions = protocol.receive_with_presence(
                        envelope,
                        Some(token),
                        &last_presence.0,
                        last_presence.1.as_ref(),
                        last_presence.2.as_ref(),
                    );
                    let (actions, sized) = match node {
                        Some(q) => node_actions(actions, frame.payload.len(), q)?,
                        None => (actions, None),
                    };
                    if !apply_actions(&mut socket, &mut heartbeat, actions, sender, sized)? {
                        return Ok(false);
                    }
                    if ready {
                        outbox.ready(last_presence, |env| {
                            socket.send(Opcode::Text, &serde_json::to_vec(env).map_err(io::Error::other)?)
                        })?;
                    }
                }
                Opcode::Ping => socket.send(Opcode::Pong, &frame.payload)?,
                Opcode::Close => {
                    let code = if frame.payload.len() >= 2 {
                        u16::from_be_bytes([frame.payload[0], frame.payload[1]])
                    } else {
                        1000
                    };
                    if protocol.closed(code) == Action::RejectedToken {
                        let _ = sender.send(GatewayEvent::RejectedToken);
                        return Ok(true);
                    }
                    return Err(io::Error::from(io::ErrorKind::ConnectionAborted));
                }
                _ => {}
            },
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) => {}
            Err(error) => return Err(error),
        }
        if let Some((interval, deadline)) = heartbeat {
            if Instant::now() >= deadline {
                heartbeat = Some((interval, Instant::now() + interval));
                if !apply_actions(
                    &mut socket,
                    &mut heartbeat,
                    vec![protocol.heartbeat_due()],
                    sender,
                    None,
                )? {
                    return Err(io::Error::from(io::ErrorKind::ConnectionAborted));
                }
            }
        }
    }
}

type Presence = (String, Option<CustomStatus>, Option<GameActivity>);

/// Before READY the hub accepts only IDENTIFY and heartbeats (anything else closes the socket with 4003).
/// Presence is kept for IDENTIFY and sent again after READY only if it changed after IDENTIFY went out;
/// other commands wait for READY.
const MAX_HELD: usize = 100;

#[derive(Default)]
struct Outbox {
    identified: bool,
    ready: bool,
    held: Vec<Envelope>,
    presence_changed: bool,
}

impl Outbox {
    /// What to send now for a UI command (Shutdown is handled by the caller).
    fn command(&mut self, cmd: GatewayCommand, presence: &mut Presence) -> Option<Envelope> {
        let env = match cmd {
            GatewayCommand::UpdatePresence { status, custom_status, game } => {
                *presence = (status, custom_status, game);
                if !self.ready {
                    self.presence_changed |= self.identified;
                    return None;
                }
                Gateway::presence_envelope(&presence.0, presence.1.as_ref(), presence.2.as_ref())
            }
            GatewayCommand::UpdateVoiceState { guild_id, channel_id, self_mute, self_deaf, self_video, self_stream } => {
                Gateway::voice_state_envelope(guild_id.as_deref(), channel_id.as_deref(), self_mute, self_deaf, self_video, self_stream)
            }
            GatewayCommand::Send(env) => env,
            GatewayCommand::Shutdown => return None,
        };
        if self.ready {
            return Some(env);
        }
        if self.held.len() >= MAX_HELD {
            self.held.remove(0); // bounded: a connection that never gets READY cannot pile up commands
        }
        self.held.push(env);
        None
    }

    /// A new connection: nothing is sent before its READY; held commands stay.
    fn reconnect(&mut self) {
        self.identified = false;
        self.ready = false;
    }

    /// READY arrived: writes everything held, in order. Each command leaves the queue only after its write
    /// succeeded, so a write error keeps the rest for the next connection.
    fn ready(&mut self, presence: &Presence, mut write: impl FnMut(&Envelope) -> io::Result<()>) -> io::Result<()> {
        self.ready = true;
        if self.presence_changed {
            write(&Gateway::presence_envelope(&presence.0, presence.1.as_ref(), presence.2.as_ref()))?;
            self.presence_changed = false;
        }
        while let Some(env) = self.held.first() {
            write(env)?;
            self.held.remove(0);
        }
        Ok(())
    }
}

fn apply_actions(
    socket: &mut WebSocket,
    heartbeat: &mut Option<(Duration, Instant)>,
    actions: Vec<Action>,
    sender: &SyncSender<GatewayEvent>,
    sized: Option<usize>,
) -> io::Result<bool> {
    for action in actions {
        match action {
            Action::Send(envelope) => socket.send(
                Opcode::Text,
                &serde_json::to_vec(&envelope).map_err(io::Error::other)?,
            )?,
            Action::StartHeartbeat(ms) => {
                let interval = Duration::from_millis(ms.max(1000));
                *heartbeat = Some((interval, Instant::now() + interval));
            }
            Action::Reconnect => return Ok(false),
            Action::RejectedToken => {
                let _ = sender.send(GatewayEvent::RejectedToken);
                return Ok(false);
            }
            Action::Dispatch(name, payload) => {
                let _ = sender.send(match sized {
                    Some(n) => GatewayEvent::NodeDispatch(name, payload, n),
                    None => GatewayEvent::Dispatch(name, payload),
                });
            }
        }
    }
    Ok(true)
}

/// A node frame's actions: events not on NODE_EVENTS dropped here, before they are queued; a dispatch waits until
/// the node's queue has room for its bytes (the frame size), then counts them. Err when no room comes.
fn node_actions(actions: Vec<Action>, bytes: usize, queued: &QueueBytes) -> io::Result<(Vec<Action>, Option<usize>)> {
    use std::sync::atomic::Ordering;
    let actions: Vec<Action> = actions.into_iter().filter(|a| !matches!(a, Action::Dispatch(n, _) if !NODE_EVENTS.contains(&n.as_str()))).collect();
    if !actions.iter().any(|a| matches!(a, Action::Dispatch(..))) {
        return Ok((actions, None));
    }
    let since = Instant::now();
    while queued.load(Ordering::SeqCst) + bytes > NODE_QUEUE_BYTES {
        if since.elapsed() > NODE_QUEUE_WAIT {
            return Err(invalid("The node sends faster than this app can take"));
        }
        thread::sleep(Duration::from_millis(10));
    }
    queued.fetch_add(bytes, Ordering::SeqCst);
    Ok((actions, Some(bytes)))
}

/// A node's gateway must be on the node's own host and port: wss, or ws only for an http loopback node.
fn gateway_allowed(origin: &Url, gateway: &Url) -> bool {
    let scheme = match origin.scheme() {
        "https" => "wss",
        "http" if matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]")) => "ws",
        _ => return false,
    };
    gateway.scheme() == scheme
        && gateway.host_str() == origin.host_str()
        && gateway.port_or_known_default() == origin.port_or_known_default()
        && gateway.username().is_empty()
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn node_frames_are_filtered_and_bounded_in_bytes() {
        use std::sync::atomic::Ordering;
        let q = QueueBytes::default();
        let ev = |n: &str| vec![Action::Dispatch(n.into(), serde_json::json!({}))];
        let (kept, sized) = node_actions(ev("USER_SETTINGS_UPDATE"), 100, &q).unwrap();
        assert!(kept.is_empty() && sized.is_none() && q.load(Ordering::SeqCst) == 0, "dropped before the queue");
        let (kept, sized) = node_actions(ev("MESSAGE_CREATE"), 100, &q).unwrap();
        assert_eq!((kept.len(), sized, q.load(Ordering::SeqCst)), (1, Some(100), 100));
        q.store(NODE_QUEUE_BYTES, Ordering::SeqCst); // full: the reader waits (then gives up)
        let t = Instant::now();
        let waiter = std::thread::spawn({
            let q = q.clone();
            move || node_actions(ev("MESSAGE_CREATE"), 100, &q).map(|(_, s)| s)
        });
        std::thread::sleep(Duration::from_millis(50));
        q.store(0, Ordering::SeqCst); // the UI took them
        assert_eq!(waiter.join().unwrap().unwrap(), Some(100));
        assert!(t.elapsed() >= Duration::from_millis(50), "it waited for room");
    }

    #[test]
    fn node_gateway_must_be_on_the_node_itself() {
        let u = |s: &str| Url::parse(s).unwrap();
        assert!(gateway_allowed(&u("https://node.example.org"), &u("wss://node.example.org/gateway")));
        assert!(gateway_allowed(&u("https://node.example.org:8443"), &u("wss://node.example.org:8443/gateway")));
        assert!(gateway_allowed(&u("http://127.0.0.1:3394"), &u("ws://127.0.0.1:3394/gateway")));
        for bad in ["wss://node.example.org:9443/gateway", "ws://node.example.org/gateway", "wss://hub.example.org/gateway", "wss://a@node.example.org/gateway"] {
            assert!(!gateway_allowed(&u("https://node.example.org"), &u(bad)), "{bad}");
        }
        assert!(!gateway_allowed(&u("http://127.0.0.1:3394"), &u("ws://127.0.0.1:3390/gateway")), "another port");
    }

    #[test]
    fn nothing_but_identify_before_ready() {
        let mut out = Outbox::default();
        let mut presence: Presence = ("online".into(), None, None);
        let set = |s: &str| GatewayCommand::UpdatePresence { status: s.into(), custom_status: None, game: None };
        // queued at login, before HELLO: only remembered, IDENTIFY carries it
        assert_eq!(out.command(set("idle"), &mut presence), None);
        assert_eq!(presence.0, "idle");
        out.identified = true;
        let voice = GatewayCommand::UpdateVoiceState { guild_id: None, channel_id: None, self_mute: false, self_deaf: false, self_video: false, self_stream: false };
        assert_eq!(out.command(voice, &mut presence), None);
        assert_eq!(out.command(set("dnd"), &mut presence), None);
        let sent = flush(&mut out, &presence);
        assert_eq!(sent.iter().map(|e| e.op).collect::<Vec<_>>(), vec![3, 4]);
        assert_eq!(sent[0].d["status"], "dnd");
        assert_eq!(out.command(set("online"), &mut presence).map(|e| e.op), Some(3));
        assert!(flush(&mut Outbox::default(), &presence).is_empty(), "an unchanged presence is not sent twice");
    }

    #[test]
    fn held_commands_survive_a_reconnect_and_stay_bounded() {
        let mut out = Outbox::default();
        let mut presence: Presence = ("online".into(), None, None);
        let send = |i: usize| GatewayCommand::Send(Envelope { op: 99, d: serde_json::json!(i), s: None, t: None });
        for i in 0..MAX_HELD + 5 {
            assert_eq!(out.command(send(i), &mut presence), None);
        }
        out.reconnect();
        // the third write fails: the two written are gone, the rest waits for the next READY
        let mut n = 0;
        let r = out.ready(&presence, |_| {
            n += 1;
            if n == 3 { Err(io::ErrorKind::BrokenPipe.into()) } else { Ok(()) }
        });
        assert!(r.is_err());
        out.reconnect();
        let sent = flush(&mut out, &presence);
        assert_eq!(sent.len(), MAX_HELD - 2);
        assert_eq!(sent[0].d, serde_json::json!(7), "the oldest went first, none lost after the failed write");
    }

    fn flush(out: &mut Outbox, presence: &Presence) -> Vec<Envelope> {
        let mut sent = Vec::new();
        out.ready(presence, |e| {
            sent.push(e.clone());
            Ok(())
        })
        .unwrap();
        sent
    }
}
