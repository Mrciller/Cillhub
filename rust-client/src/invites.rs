//! Server invite links in messages, like the web's chat/inviteLinks.ts and chat/ServerInvite.tsx:
//! `<hub origin>/invite/<code>` (the form the invite dialogs copy) becomes a card with Join.
//! Links to other hosts never match, so no request goes to a host named in a message.

use crate::api::ApiError;
use serde_json::Value;
use std::time::{Duration, Instant};

/// At most this many cards per message.
pub const MAX_CARDS: usize = 3;

fn link_prefix(origin: &str) -> String {
    format!("{}/invite/", origin.trim_end_matches('/'))
}

/// Invite codes linked in `content`, each once, at most `max`. The link starts the text or follows a space,
/// `<` or `(`; the code is 2-32 of letters, digits, `_` and `-` (generated and vanity codes).
pub fn invite_codes(content: &str, origin: &str, max: usize) -> Vec<String> {
    let needle = link_prefix(origin).to_ascii_lowercase();
    // ASCII lowercasing keeps byte offsets, so indexes into `hay` are valid in `content`
    let hay = content.to_ascii_lowercase();
    let mut out: Vec<String> = Vec::new();
    let mut from = 0;
    while let Some(i) = hay[from..].find(&needle).map(|i| i + from) {
        from = i + needle.len();
        let rest = &content[from..];
        let code = &rest[..rest.find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')).unwrap_or(rest.len())];
        let starts_ok = content[..i].chars().next_back().is_none_or(|c| c.is_whitespace() || c == '<' || c == '(');
        let ends_ok = !rest[code.len()..].starts_with('/');
        if starts_ok && ends_ok && (2..=32).contains(&code.len()) && !out.iter().any(|c| c == code) {
            out.push(code.to_string());
            if out.len() >= max {
                break;
            }
        }
    }
    out
}

/// True when the message is nothing but one invite link (then the card replaces the text).
pub fn only_invite(content: &str, origin: &str) -> bool {
    let s = content.trim();
    let s = s.strip_prefix('<').and_then(|s| s.strip_suffix('>')).unwrap_or(s);
    let codes = invite_codes(s, origin, 2);
    codes.len() == 1 && s.eq_ignore_ascii_case(&format!("{}{}", link_prefix(origin), codes[0]))
}

/// What `GET /invites/<code>?with_counts=true` said.
#[derive(Debug, Clone, PartialEq)]
pub enum InviteLookup {
    Loading,
    Found { guild_id: String, name: String, members: Option<u64>, channel_id: Option<String> },
    /// `expired`: unknown code (expired, used up or revoked); else `error` is the server's message.
    Invalid { expired: bool, error: String },
}

impl InviteLookup {
    pub fn from_result(r: &Result<Value, ApiError>) -> Self {
        match r {
            Ok(v) => {
                let s = |p: &str| v.pointer(p).and_then(Value::as_str).map(String::from);
                match (s("/guild/id"), s("/guild/name")) {
                    (Some(guild_id), Some(name)) => InviteLookup::Found {
                        guild_id,
                        name,
                        members: v.get("approximate_member_count").or(v.pointer("/guild/member_count")).and_then(Value::as_u64),
                        channel_id: s("/channel/id"),
                    },
                    _ => InviteLookup::Invalid { expired: true, error: String::new() },
                }
            }
            Err(e) => InviteLookup::Invalid { expired: e.code == 10006 || e.status == 404, error: e.message.clone() },
        }
    }
}

/// The card's button: Join, Joined (opens the server) or none (loading, invalid).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InviteButton {
    Join,
    Joined,
    None,
}

pub fn invite_button(lookup: &InviteLookup, member_of: impl Fn(&str) -> bool) -> InviteButton {
    match lookup {
        InviteLookup::Found { guild_id, .. } if member_of(guild_id) => InviteButton::Joined,
        InviteLookup::Found { .. } => InviteButton::Join,
        _ => InviteButton::None,
    }
}

/// One code's card: looked up once, kept 5 minutes (failures 30 seconds).
#[derive(Debug, Clone)]
pub struct InviteCard {
    pub lookup: InviteLookup,
    pub at: Instant,
    pub joining: bool,
    pub error: Option<String>,
}

impl InviteCard {
    pub fn loading() -> Self {
        Self { lookup: InviteLookup::Loading, at: Instant::now(), joining: false, error: None }
    }

    pub fn stale(&self) -> bool {
        let ttl = match self.lookup {
            InviteLookup::Loading => return false,
            InviteLookup::Found { .. } => 300,
            InviteLookup::Invalid { .. } => 30,
        };
        self.at.elapsed() > Duration::from_secs(ttl)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HUB: &str = "https://hub.example.org";

    #[test]
    fn links_of_this_hub_are_found_once() {
        assert_eq!(invite_codes("join https://hub.example.org/invite/hTKzmakQ now", HUB, 3), ["hTKzmakQ"]);
        let s = format!("{HUB}/invite/abc {HUB}/invite/abc ({HUB}/invite/my-club_2).");
        assert_eq!(invite_codes(&s, HUB, 3), ["abc", "my-club_2"]);
        assert_eq!(invite_codes(&format!("<{HUB}/invite/abcDEF12>"), HUB, 3), ["abcDEF12"]);
        // the client's origin is a Url, which ends in a slash
        assert_eq!(invite_codes(&format!("{HUB}/invite/abc"), "https://hub.example.org/", 3), ["abc"]);
        assert_eq!(invite_codes("Ä HTTPS://HUB.example.org/invite/abc", HUB, 3), ["abc"]);
    }

    #[test]
    fn other_hosts_and_look_alikes_are_no_match() {
        for s in [
            "https://other.example.org/invite/abcDEF12",
            "https://hub.example.org.evil.test/invite/abcDEF12",
            "http://hub.example.org/invite/abcDEF12",
            "https://evil.test/?u=https://hub.example.org/invite/abcDEF12",
            "xhttps://hub.example.org/invite/abcDEF12",
            "https://hub.example.org/invite/abcDEF12/extra",
            "https://hub.example.org/invites/abcDEF12",
            "abcDEF12",
        ] {
            assert!(invite_codes(s, HUB, 3).is_empty(), "{s}");
        }
    }

    #[test]
    fn code_grammar_and_limit() {
        assert!(invite_codes(&format!("{HUB}/invite/a"), HUB, 3).is_empty());
        assert_eq!(invite_codes(&format!("{HUB}/invite/ab"), HUB, 3), ["ab"]);
        assert_eq!(invite_codes(&format!("{HUB}/invite/{}", "a".repeat(32)), HUB, 3).len(), 1);
        assert!(invite_codes(&format!("{HUB}/invite/{}", "a".repeat(33)), HUB, 3).is_empty());
        assert!(invite_codes(&format!("{HUB}/invite/a%20b"), HUB, 3).is_empty());
        let four = ["aa", "bb", "cc", "dd"].map(|c| format!("{HUB}/invite/{c}")).join(" ");
        assert_eq!(invite_codes(&four, HUB, MAX_CARDS), ["aa", "bb", "cc"]);
    }

    #[test]
    fn only_the_link() {
        assert!(only_invite(&format!(" {HUB}/invite/abcDEF12 "), HUB));
        assert!(only_invite(&format!("<{HUB}/invite/abcDEF12>"), HUB));
        assert!(!only_invite(&format!("hey {HUB}/invite/abcDEF12"), HUB));
        assert!(!only_invite(&format!("{HUB}/invite/aa {HUB}/invite/bb"), HUB));
        assert!(!only_invite("https://other.example.org/invite/abcDEF12", HUB));
    }

    fn err(status: u16, code: u64, message: &str) -> Result<Value, ApiError> {
        Err(ApiError { status, code, message: message.into(), fields: Default::default(), retry_after: None, raw: Value::Null })
    }

    #[test]
    fn state_mapping() {
        let ok = Ok(json!({ "code": "abc", "guild": { "id": "7", "name": "Night Owls" }, "channel": { "id": "8" }, "approximate_member_count": 12 }));
        let found = InviteLookup::from_result(&ok);
        assert_eq!(found, InviteLookup::Found { guild_id: "7".into(), name: "Night Owls".into(), members: Some(12), channel_id: Some("8".into()) });
        assert_eq!(invite_button(&found, |g| g == "7"), InviteButton::Joined, "member");
        assert_eq!(invite_button(&found, |_| false), InviteButton::Join, "not a member");

        let gone = InviteLookup::from_result(&err(404, 10006, "Unknown Invite"));
        assert_eq!(gone, InviteLookup::Invalid { expired: true, error: "Unknown Invite".into() });
        assert_eq!(invite_button(&gone, |_| true), InviteButton::None, "invalid");
        let limited = InviteLookup::from_result(&err(429, 0, "You are being rate limited."));
        assert!(matches!(limited, InviteLookup::Invalid { expired: false, .. }));
        assert_eq!(invite_button(&InviteLookup::Loading, |_| true), InviteButton::None);

        // no counts in the answer: no member line
        let bare = InviteLookup::from_result(&Ok(json!({ "guild": { "id": "7", "name": "N" } })));
        assert!(matches!(bare, InviteLookup::Found { members: None, channel_id: None, .. }));
        let card = InviteCard::loading();
        assert!(!card.stale());
    }
}
