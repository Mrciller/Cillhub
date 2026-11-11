use crate::games::GameActivity;
use crate::model::CustomStatus;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Envelope {
    pub op: u8,
    #[serde(default)]
    pub d: Value,
    #[serde(default)]
    pub s: Option<u64>,
    #[serde(default)]
    pub t: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum Action {
    Send(Envelope),
    StartHeartbeat(u64),
    Reconnect,
    RejectedToken,
    Dispatch(String, Value),
}

/// Transport independent gateway protocol. The runtime owns the WebSocket and timer.
#[derive(Default, Debug)]
pub struct Gateway {
    sequence: Option<u64>,
    awaiting_ack: bool,
}

impl Gateway {
    pub fn reset(&mut self) {
        self.sequence = None;
        self.awaiting_ack = false;
    }

    pub fn receive(&mut self, frame: Envelope, token: Option<&str>) -> Vec<Action> {
        self.receive_with_presence(frame, token, "online", None, None)
    }

    pub fn receive_with_presence(
        &mut self,
        frame: Envelope,
        token: Option<&str>,
        status: &str,
        custom_status: Option<&CustomStatus>,
        game: Option<&GameActivity>,
    ) -> Vec<Action> {
        if let Some(sequence) = frame.s {
            self.sequence = Some(sequence);
        }
        match frame.op {
            10 => {
                let interval = frame
                    .d
                    .get("heartbeat_interval")
                    .and_then(Value::as_u64)
                    .unwrap_or(45_000);
                let activities = build_activities(game);
                let mut presence = json!({
                    "status": status,
                    "since": 0,
                    "afk": false,
                    "activities": activities
                });
                if let Some(cs) = custom_status {
                    presence["custom_status"] = serde_json::to_value(cs).unwrap_or(Value::Null);
                }
                vec![
                    Action::StartHeartbeat(interval),
                    Action::Send(Envelope {
                        op: 2,
                        d: json!({
                            "token": token,
                            "properties": {
                                "os": std::env::consts::OS,
                                "browser": "Cillhub Rust",
                                "device": ""
                            },
                            "presence": presence
                        }),
                        s: None,
                        t: None,
                    }),
                ]
            }
            11 => {
                self.awaiting_ack = false;
                vec![]
            }
            1 => vec![self.heartbeat_frame()],
            9 => vec![Action::Reconnect],
            0 => frame
                .t
                .map(|name| vec![Action::Dispatch(name, frame.d)])
                .unwrap_or_default(),
            _ => vec![],
        }
    }

    pub fn presence_envelope(
        status: &str,
        custom_status: Option<&CustomStatus>,
        game: Option<&GameActivity>,
    ) -> Envelope {
        Envelope {
            op: 3,
            d: json!({
                "status": status,
                "custom_status": custom_status,
                "activities": build_activities(game),
                "since": 0,
                "afk": false,
            }),
            s: None,
            t: None,
        }
    }

    pub fn voice_state_envelope(
        guild_id: Option<&str>,
        channel_id: Option<&str>,
        self_mute: bool,
        self_deaf: bool,
        self_video: bool,
        self_stream: bool,
    ) -> Envelope {
        Envelope {
            op: 4,
            d: json!({
                "guild_id": guild_id,
                "channel_id": channel_id,
                "self_mute": self_mute,
                "self_deaf": self_deaf,
                "self_video": self_video,
                "self_stream": self_stream,
            }),
            s: None,
            t: None,
        }
    }

    pub fn heartbeat_due(&mut self) -> Action {
        if self.awaiting_ack {
            return Action::Reconnect;
        }
        self.awaiting_ack = true;
        self.heartbeat_frame()
    }

    fn heartbeat_frame(&self) -> Action {
        Action::Send(Envelope {
            op: 1,
            d: json!(self.sequence),
            s: None,
            t: None,
        })
    }

    pub fn closed(&mut self, code: u16) -> Action {
        self.reset();
        if code == 4004 {
            Action::RejectedToken
        } else {
            Action::Reconnect
        }
    }
}

pub fn build_activities(game: Option<&GameActivity>) -> Vec<Value> {
    match game {
        Some(g) => vec![json!({
            "type": 0,
            "name": g.name,
            "timestamps": { "start": g.start }
        })],
        None => vec![],
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_heartbeat_and_dispatch() {
        let mut gateway = Gateway::default();
        let hello = Envelope {
            op: 10,
            d: json!({"heartbeat_interval": 2000}),
            s: None,
            t: None,
        };
        let actions = gateway.receive(hello, Some("secret"));
        assert_eq!(actions[0], Action::StartHeartbeat(2000));
        assert_eq!(
            actions[1],
            Action::Send(Envelope {
                op: 2,
                d: json!({"token": "secret", "properties": {"os": std::env::consts::OS, "browser": "Cillhub Rust", "device": ""}, "presence": {"status": "online", "since": 0, "afk": false, "activities": []}}),
                s: None,
                t: None
            })
        );
        gateway.receive(
            Envelope {
                op: 0,
                d: json!({}),
                s: Some(17),
                t: Some("READY".into()),
            },
            Some("secret"),
        );
        assert_eq!(
            gateway.heartbeat_due(),
            Action::Send(Envelope {
                op: 1,
                d: json!(17),
                s: None,
                t: None
            })
        );
        assert_eq!(gateway.heartbeat_due(), Action::Reconnect);
        gateway.receive(
            Envelope {
                op: 11,
                d: Value::Null,
                s: None,
                t: None,
            },
            None,
        );
        assert!(matches!(gateway.heartbeat_due(), Action::Send(_)));
    }

    #[test]
    fn presence_envelope_includes_game_activity() {
        let game = GameActivity {
            name: "League of Legends".into(),
            start: 1700000000000,
        };
        let env = Gateway::presence_envelope("online", None, Some(&game));
        assert_eq!(env.op, 3);
        assert_eq!(env.d["activities"][0]["name"], "League of Legends");
        assert_eq!(env.d["activities"][0]["type"], 0);
        assert_eq!(env.d["activities"][0]["timestamps"]["start"], 1700000000000u64);
    }

    #[test]
    fn invalid_token_stops_reconnect() {
        assert_eq!(Gateway::default().closed(4004), Action::RejectedToken);
    }
}
