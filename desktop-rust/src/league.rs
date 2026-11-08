//! League of Legends LCU (League Client Update) local API bridge
//! Communicates with the local League client via HTTPS on 127.0.0.1 using the lockfile.

use crate::games::ProcessInfo;
use base64::prelude::*;
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

/// Searches running processes on Linux/Wine or Windows for the LeagueClientUx directory
pub fn find_lockfile_path(procs: &[ProcessInfo]) -> Option<PathBuf> {
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
    pub members: Vec<LobbyMember>,
}

pub struct LeagueClient {
    client: reqwest::blocking::Client,
}

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
        let url = format!("https://127.0.0.1:{}/lol-lobby/v2/lobby", creds.port);
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
        if let Some(arr) = members_val {
            for m in arr {
                let summoner_id = m.get("summonerId").and_then(|id| id.as_i64());
                let summoner_name = m
                    .get("summonerName")
                    .and_then(|s| s.as_str())
                    .unwrap_or("Summoner")
                    .to_string();
                let is_leader = m
                    .get("isLeader")
                    .and_then(|l| l.as_bool())
                    .unwrap_or(false);

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

        Ok(Some(LeagueLobbyInfo {
            queue_id,
            queue_name: queue_name(queue_id),
            party_type,
            member_count: members.len(),
            max_party_size,
            can_invite,
            invitation_id,
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
            "https://127.0.0.1:{}/lol-lobby/v2/lobby/invitations",
            creds.port
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

    /// Accepts an invitation to join a party lobby
    pub fn accept_invite(
        &self,
        creds: &LockfileCredentials,
        invitation_id: &str,
    ) -> Result<bool, String> {
        let url = format!(
            "https://127.0.0.1:{}/lol-lobby/v2/received-invitations/{}/accept",
            creds.port, invitation_id
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

        // Invalid lockfile cases
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
        let tmp_dir = std::env::temp_dir().join("cillhub_league_test");
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
}
