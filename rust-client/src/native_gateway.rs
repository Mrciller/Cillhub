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
    sync::mpsc::{self, Receiver, Sender},
    thread,
    time::{Duration, Instant},
};
use url::Url;

#[derive(Debug)]
pub enum GatewayEvent {
    Dispatch(String, Value),
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

pub fn spawn(origin: Url, token: String, sender: Sender<GatewayEvent>) -> thread::JoinHandle<()> {
    let (_cmd_tx, cmd_rx) = mpsc::channel();
    spawn_with_commands(origin, token, sender, cmd_rx)
}

pub fn spawn_with_commands(
    origin: Url,
    token: String,
    sender: Sender<GatewayEvent>,
    commands: Receiver<GatewayCommand>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let client = crate::api::no_redirect_client(10);
        let mut backoff = 1u64;
        let mut last_presence: (String, Option<CustomStatus>, Option<GameActivity>) =
            ("online".to_string(), None, None);
        loop {
            match run_once(
                &client,
                &origin,
                &token,
                &sender,
                &commands,
                &mut last_presence,
            ) {
                Ok(true) => break, // clean shutdown
                Ok(false) => backoff = 1,
                Err(error) => {
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
                                _ => {}
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

fn run_once(
    client: &reqwest::blocking::Client,
    origin: &Url,
    token: &str,
    sender: &Sender<GatewayEvent>,
    commands: &Receiver<GatewayCommand>,
    last_presence: &mut (String, Option<CustomStatus>, Option<GameActivity>),
) -> io::Result<bool> {
    let endpoint = api_url(origin, "/gateway").ok_or_else(|| invalid("Invalid gateway API URL"))?;
    let data: Value = client
        .get(endpoint)
        .header("Authorization", token)
        .send()
        .map_err(io::Error::other)?
        .error_for_status()
        .map_err(io::Error::other)?
        .json()
        .map_err(io::Error::other)?;
    let address = data
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid("Gateway URL missing"))?;
    let address = Url::parse(address).map_err(|_| invalid("Gateway URL invalid"))?;
    let mut socket = WebSocket::connect(&address)?;
    let _ = sender.send(GatewayEvent::Connected);
    let mut protocol = Gateway::default();
    let mut heartbeat: Option<(Duration, Instant)> = None;
    loop {
        while let Ok(cmd) = commands.try_recv() {
            match cmd {
                GatewayCommand::Shutdown => return Ok(true),
                GatewayCommand::UpdatePresence {
                    status,
                    custom_status,
                    game,
                } => {
                    *last_presence = (status.clone(), custom_status.clone(), game.clone());
                    let env = Gateway::presence_envelope(
                        &status,
                        custom_status.as_ref(),
                        game.as_ref(),
                    );
                    socket.send(
                        Opcode::Text,
                        &serde_json::to_vec(&env).map_err(io::Error::other)?,
                    )?;
                }
                GatewayCommand::UpdateVoiceState {
                    guild_id,
                    channel_id,
                    self_mute,
                    self_deaf,
                    self_video,
                    self_stream,
                } => {
                    let env = Gateway::voice_state_envelope(
                        guild_id.as_deref(),
                        channel_id.as_deref(),
                        self_mute,
                        self_deaf,
                        self_video,
                        self_stream,
                    );
                    socket.send(
                        Opcode::Text,
                        &serde_json::to_vec(&env).map_err(io::Error::other)?,
                    )?;
                }
                GatewayCommand::Send(env) => {
                    socket.send(
                        Opcode::Text,
                        &serde_json::to_vec(&env).map_err(io::Error::other)?,
                    )?;
                }
            }
        }
        match socket.read_frame() {
            Ok(frame) => match frame.opcode {
                Opcode::Text => {
                    let envelope: Envelope =
                        serde_json::from_slice(&frame.payload).map_err(io::Error::other)?;
                    let actions = protocol.receive_with_presence(
                        envelope,
                        Some(token),
                        &last_presence.0,
                        last_presence.1.as_ref(),
                        last_presence.2.as_ref(),
                    );
                    if !apply_actions(&mut socket, &mut heartbeat, actions, sender)? {
                        return Ok(false);
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
                )? {
                    return Err(io::Error::from(io::ErrorKind::ConnectionAborted));
                }
            }
        }
    }
}

fn apply_actions(
    socket: &mut WebSocket,
    heartbeat: &mut Option<(Duration, Instant)>,
    actions: Vec<Action>,
    sender: &Sender<GatewayEvent>,
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
                let _ = sender.send(GatewayEvent::Dispatch(name, payload));
            }
        }
    }
    Ok(true)
}

fn invalid(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}
