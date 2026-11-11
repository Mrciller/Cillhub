//! League of Legends LCU (League Client Update) local API bridge & Game Lobby Invite protocol.
//! Communicates with the local League client via HTTPS on 127.0.0.1 using the lockfile, and formats/parses
//! `cillhub://game-invite?...` lobby invite links for chat messages and direct party joining.

use crate::games::ProcessInfo;
use base64::prelude::*;
use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

pub const COMMON_DIRS: &[&str] = &[
    "C:\\Riot Games\\League of Legends",
    "D:\\Riot Games\\League of Legends",
    "E:\\Riot Games\\League of Legends",
    "F:\\Riot Games\\League of Legends",
    "/c/Riot Games/League of Legends",
    "/d/Riot Games/League of Legends",
];

pub const GAME_INVITE_PREFIX: &str = "cillhub://game-invite?";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameInviteData {
    pub game: String,
    pub queue_name: String,
    pub queue_id: Option<i64>,
    pub party_id: String,
    pub host_name: String,
    pub host_puuid: Option<String>,
    pub members: usize,
    pub max_members: usize,
}

impl GameInviteData {
    pub fn from_league_lobby(lobby: &LeagueLobbyInfo, fallback_host: &str) -> Self {
        let leader = lobby
            .members
            .iter()
            .find(|m| m.is_leader)
            .or_else(|| lobby.members.first());
        let host_name = leader
            .map(|m| m.summoner_name.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback_host.to_string());
        let party_id = lobby
            .invitation_id
            .clone()
            .or_else(|| lobby.party_id.clone())
            .unwrap_or_else(|| format!("lol-party-{}", lobby.queue_id));
        Self {
            game: "League of Legends".to_string(),
            queue_name: lobby.queue_name.clone(),
            queue_id: if lobby.queue_id > 0 {
                Some(lobby.queue_id)
            } else {
                None
            },
            party_id,
            host_name,
            host_puuid: lobby.host_puuid.clone(),
            members: lobby.member_count.max(1),
            max_members: lobby.max_party_size.max(1),
        }
    }
}

fn encode_param(s: &str) -> String {
    utf8_percent_encode(s, NON_ALPHANUMERIC)
        .to_string()
        .replace("%20", "+")
}

fn decode_param(s: &str) -> String {
    let plus_replaced = s.replace('+', " ");
    percent_decode_str(&plus_replaced)
        .decode_utf8_lossy()
        .to_string()
}

/// Parses `cillhub://game-invite?...` inside a message content string (matching client/src/chat/GameInvite.tsx).
pub fn parse_game_invite(content: &str) -> Option<GameInviteData> {
    if content.is_empty() {
        return None;
    }
    let idx = content.find(GAME_INVITE_PREFIX)?;
    let after = &content[idx + GAME_INVITE_PREFIX.len()..];
    let query_str = after.split_whitespace().next().unwrap_or("");
    if query_str.is_empty() {
        return None;
    }
    let mut params: HashMap<String, String> = HashMap::new();
    for pair in query_str.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            params.insert(decode_param(k), decode_param(v));
        }
    }
    let game = params.get("game")?.trim().to_string();
    let party_id = params.get("partyId")?.trim().to_string();
    if game.is_empty() || party_id.is_empty() {
        return None;
    }
    let queue_name = params
        .get("queueName")
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Custom Game".to_string());
    let queue_id = params.get("queueId").and_then(|v| v.parse::<i64>().ok());
    let host_name = params
        .get("hostName")
        .cloned()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "Host".to_string());
    let host_puuid = params
        .get("hostPuuid")
        .cloned()
        .filter(|s| !s.is_empty());
    let members = params
        .get("members")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(1)
        .max(1);
    let max_members = params
        .get("maxMembers")
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(5)
        .max(1);

    Some(GameInviteData {
        game,
        queue_name,
        queue_id,
        party_id,
        host_name,
        host_puuid,
        members,
        max_members,
    })
}

/// Formats `GameInviteData` as a `cillhub://game-invite?...` link (matching client/src/chat/GameInvite.tsx).
pub fn format_game_invite_url(data: &GameInviteData) -> String {
    let mut pairs = Vec::new();
    pairs.push(format!("game={}", encode_param(&data.game)));
    pairs.push(format!("partyId={}", encode_param(&data.party_id)));
    pairs.push(format!("queueName={}", encode_param(&data.queue_name)));
    if let Some(qid) = data.queue_id {
        if qid != 0 {
            pairs.push(format!("queueId={qid}"));
        }
    }
    pairs.push(format!("hostName={}", encode_param(&data.host_name)));
    if let Some(puuid) = &data.host_puuid {
        if !puuid.is_empty() {
            pairs.push(format!("hostPuuid={}", encode_param(puuid)));
        }
    }
    pairs.push(format!("members={}", data.members));
    pairs.push(format!("maxMembers={}", data.max_members));
    format!("{GAME_INVITE_PREFIX}{}", pairs.join("&"))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LockfileCredentials {
    pub proc_name: String,
    pub pid: u32,
    pub port: u16,
    pub password: String,
    pub protocol: String,
}

/// Parses the lockfile content: "process_name:pid:port:password:protocol"
pub fn parse_lockfile(content: &str) -> Option<LockfileCredentials> {
    let trimmed = content.trim();
    let parts: Vec<&str> = trimmed.split(':').collect();
    if parts.len() < 5 {
        return None;
    }
    let proc_name = parts[0].to_string();
    let pid = parts[1].parse::<u32>().ok()?;
    let port = parts[2].parse::<u16>().ok()?;
    let password = parts[3].to_string();
    let protocol = if parts[4].is_empty() {
        "https".to_string()
    } else {
        parts[4].to_string()
    };

    if password.is_empty() || port == 0 {
        return None;
    }

    Some(LockfileCredentials {
        proc_name,
        pid,
        port,
        password,
        protocol,
    })
}

/// Searches running processes on Linux/Wine or Windows for the LeagueClientUx directory,
/// or checks `CILLHUB_LEAGUE_LOCKFILE` env var and `COMMON_DIRS`.
pub fn find_lockfile_path(procs: &[ProcessInfo]) -> Option<PathBuf> {
    if let Ok(env_path) = std::env::var("CILLHUB_LEAGUE_LOCKFILE") {
        let p = PathBuf::from(env_path);
        if p.exists() {
            return Some(p);
        }
    }

    let re = Regex::new(r#"--install-directory=([^\s"]+|"[^"]+")"#).ok()?;

    for p in procs {
        if let Some(caps) = re.captures(&p.cmdline) {
            if let Some(m) = caps.get(1) {
                let dir_str = m.as_str().trim_matches('"');
                let candidate = Path::new(dir_str).join("lockfile");
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }

    for dir in COMMON_DIRS {
        let candidate = Path::new(dir).join("lockfile");
        if candidate.exists() {
            return Some(candidate);
        }
    }

    None
}

/// Human-readable queue names for League match types
pub fn queue_name(queue_id: i64) -> String {
    let map: HashMap<i64, &'static str> = [
        (420, "Ranked Solo/Duo"),
        (440, "Ranked Flex"),
        (400, "Normal Draft"),
        (430, "Blind Pick"),
        (450, "ARAM"),
        (490, "Quickplay"),
        (1700, "Arena"),
        (1090, "Teamfight Tactics (Normal)"),
        (1100, "Teamfight Tactics (Ranked)"),
        (1130, "Teamfight Tactics (Hyper Roll)"),
        (1160, "Teamfight Tactics (Double Up)"),
        (700, "Clash"),
    ]
    .into_iter()
    .collect();

    map.get(&queue_id)
        .copied()
        .unwrap_or("Custom / Special Mode")
        .to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LobbyMember {
    pub summoner_id: Option<i64>,
    pub summoner_name: String,
    pub is_leader: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct LeagueLobbyInfo {
    pub queue_id: i64,
    pub queue_name: String,
    pub party_type: String, // "OPEN" | "CLOSED"
    pub member_count: usize,
    pub max_party_size: usize,
    pub can_invite: bool,
    pub invitation_id: Option<String>,
    #[serde(default)]
    pub party_id: Option<String>,
    #[serde(default)]
    pub host_puuid: Option<String>,
    pub members: Vec<LobbyMember>,
}

#[cfg(feature = "native-net")]
pub struct LeagueClient {
    client: reqwest::blocking::Client,
}

#[cfg(feature = "native-net")]
impl LeagueClient {
    pub fn new() -> Result<Self, reqwest::Error> {
        let client = reqwest::blocking::Client::builder()
            .danger_accept_invalid_certs(true) // Local self-signed Riot TLS cert
            .timeout(std::time::Duration::from_secs(5))
            .build()?;
        Ok(Self { client })
    }

    fn make_auth_header(&self, password: &str) -> String {
        let creds = format!("riot:{}", password);
        format!("Basic {}", BASE64_STANDARD.encode(creds.as_bytes()))
    }

    /// Queries the local LCU client for active lobby status
    pub fn fetch_lobby(
        &self,
        creds: &LockfileCredentials,
    ) -> Result<Option<LeagueLobbyInfo>, String> {
        let url = format!("{}://127.0.0.1:{}/lol-lobby/v2/lobby", creds.protocol, creds.port);
        let resp = self
            .client
            .get(&url)
            .header("Authorization", self.make_auth_header(&creds.password))
            .header("Accept", "application/json")
            .send()
            .map_err(|e| e.to_string())?;

        if resp.status() == reqwest::StatusCode::NOT_FOUND {
            return Ok(None);
        }

        if !resp.status().is_success() {
            return Err(format!("LCU HTTP error: {}", resp.status()));
        }

        let json: serde_json::Value = resp.json().map_err(|e| e.to_string())?;

        let game_config = json.get("gameConfig");
        let queue_id = game_config
            .and_then(|gc| gc.get("queueId"))
            .and_then(|q| q.as_i64())
            .unwrap_or(0);
        let max_party_size = game_config
            .and_then(|gc| gc.get("maxLobbySize"))
            .and_then(|s| s.as_u64())
            .unwrap_or(5) as usize;

        let members_val = json.get("members").and_then(|m| m.as_array());
        let mut members = Vec::new();
        let mut host_puuid = None;
        if let Some(arr) = members_val {
            for m in arr {
                let summoner_id = m.get("summonerId").and_then(|id| id.as_i64());
                let summoner_name = m
                    .get("summonerName")
                    .or_else(|| m.get("gameName"))
                    .and_then(|s| s.as_str())
                    .unwrap_or("Summoner")
                    .to_string();
                let is_leader = m
                    .get("isLeader")
                    .and_then(|l| l.as_bool())
                    .unwrap_or(false);
                if is_leader {
                    host_puuid = m.get("puuid").and_then(|p| p.as_str()).map(String::from);
                }

                members.push(LobbyMember {
                    summoner_id,
                    summoner_name,
                    is_leader,
                });
            }
        }

        let party_type = json
            .get("partyType")
            .and_then(|p| p.as_str())
            .unwrap_or("OPEN")
            .to_string();
        let can_invite = json
            .get("canInviteOthers")
            .and_then(|c| c.as_bool())
            .unwrap_or(true);
        let invitation_id = json
            .get("invitationId")
            .and_then(|i| i.as_str())
            .map(String::from);
        let party_id = json
            .get("partyId")
            .and_then(|i| i.as_str())
            .map(String::from)
            .or_else(|| invitation_id.clone());

        Ok(Some(LeagueLobbyInfo {
            queue_id,
            queue_name: queue_name(queue_id),
            party_type,
            member_count: members.len(),
            max_party_size,
            can_invite,
            invitation_id,
            party_id,
            host_puuid,
            members,
        }))
    }

    /// Sends an in-game lobby party invite to a summoner
    pub fn send_invite(
        &self,
        creds: &LockfileCredentials,
        summoner_name: &str,
    ) -> Result<bool, String> {
        let url = format!(
            "{}://127.0.0.1:{}/lol-lobby/v2/lobby/invitations",
            creds.protocol, creds.port
        );
        let body = serde_json::json!([{ "toSummonerName": summoner_name }]);

        let resp = self
            .client
            .post(&url)
            .header("Authorization", self.make_auth_header(&creds.password))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .map_err(|e| e.to_string())?;

        Ok(resp.status().is_success())
    }

    /// Accepts an invitation to join a party lobby (if invitation_id is empty, accepts the first pending invitation or joins party)
    pub fn accept_invite(
        &self,
        creds: &LockfileCredentials,
        invitation_id: &str,
    ) -> Result<bool, String> {
        let resolved_id = if invitation_id.is_empty() {
            let list_url = format!(
                "{}://127.0.0.1:{}/lol-lobby/v2/received-invitations",
                creds.protocol, creds.port
            );
            if let Ok(resp) = self
                .client
                .get(&list_url)
                .header("Authorization", self.make_auth_header(&creds.password))
                .send()
            {
                if let Ok(arr) = resp.json::<serde_json::Value>() {
                    arr.as_array()
                        .and_then(|a| a.first())
                        .and_then(|item| item.get("invitationId"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("default")
                        .to_string()
                } else {
                    "default".to_string()
                }
            } else {
                "default".to_string()
            }
        } else {
            invitation_id.to_string()
        };

        let url = format!(
            "{}://127.0.0.1:{}/lol-lobby/v2/received-invitations/{}/accept",
            creds.protocol, creds.port, resolved_id
        );

        let resp = self
            .client
            .post(&url)
            .header("Authorization", self.make_auth_header(&creds.password))
            .send()
            .map_err(|e| e.to_string())?;

        Ok(resp.status().is_success())
    }
}

pub fn read_lockfile(path: &Path) -> Option<LockfileCredentials> {
    let content = fs::read_to_string(path).ok()?;
    parse_lockfile(&content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;

    #[test]
    fn test_parse_lockfile() {
        let raw = "LeagueClient:1337:51234:secrettoken123:https";
        let creds = parse_lockfile(raw).expect("valid lockfile");
        assert_eq!(creds.proc_name, "LeagueClient");
        assert_eq!(creds.pid, 1337);
        assert_eq!(creds.port, 51234);
        assert_eq!(creds.password, "secrettoken123");
        assert_eq!(creds.protocol, "https");

        assert!(parse_lockfile("").is_none());
        assert!(parse_lockfile("not:enough:parts").is_none());
        assert!(parse_lockfile("LeagueClient:abc:notaport:pass:https").is_none());
    }

    #[test]
    fn test_queue_name() {
        assert_eq!(queue_name(420), "Ranked Solo/Duo");
        assert_eq!(queue_name(440), "Ranked Flex");
        assert_eq!(queue_name(450), "ARAM");
        assert_eq!(queue_name(1700), "Arena");
        assert_eq!(queue_name(99999), "Custom / Special Mode");
    }

    #[test]
    fn test_find_lockfile_path() {
        let tmp_dir = std::env::temp_dir().join(format!("cillhub_league_test_{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp_dir);
        let lock_file = tmp_dir.join("lockfile");
        {
            let mut f = File::create(&lock_file).unwrap();
            writeln!(f, "LeagueClient:123:456:pwd:https").unwrap();
        }

        let procs = vec![ProcessInfo {
            names: vec!["LeagueClientUx.exe".into()],
            cmdline: format!(
                r#""C:\Games\League\LeagueClientUx.exe" "--install-directory={}""#,
                tmp_dir.display()
            ),
        }];

        let found = find_lockfile_path(&procs);
        assert_eq!(found, Some(lock_file));

        let _ = fs::remove_dir_all(tmp_dir);
    }

    #[test]
    fn test_game_invite_roundtrip() {
        let invite = GameInviteData {
            game: "League of Legends".into(),
            queue_name: "Ranked Flex".into(),
            queue_id: Some(440),
            party_id: "party-xyz-99".into(),
            host_name: "Alex".into(),
            host_puuid: Some("puuid-123".into()),
            members: 3,
            max_members: 5,
        };
        let url = format_game_invite_url(&invite);
        let msg = format!("Join my League of Legends party!\n{url}");
        let parsed = parse_game_invite(&msg).expect("should parse game invite");
        assert_eq!(parsed, invite);
    }
}
