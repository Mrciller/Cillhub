//! Saved private nodes (Settings › Private Nodes, `cillhub://add-node#<address>`): a plain per-device list of
//! {origin, name} in settings.json, the same rules as the web client's src/privateNodes.ts.

use crate::api::normalize_server_url;
use crate::config::DEEP_LINK_SCHEMES;
use serde::{Deserialize, Serialize};

pub const MAX_NODES: usize = 20;

/// Plain {origin, name}: a later stage attaches a session per node by origin.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SavedNode {
    pub origin: String,
    pub name: String,
}

/// A reachability/name check of one node (run when the tab opens or a link is confirmed, never polled).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeCheck {
    Checking,
    Up(String),
    Down,
}

/// A node from an add link, waiting for the user's Add or Cancel. `check` None: not started yet.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PendingNode {
    pub origin: String,
    pub check: Option<NodeCheck>,
    pub added: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refused {
    Invalid,
    Duplicate,
    Full,
}

impl Refused {
    pub fn message(self) -> &'static str {
        match self {
            Refused::Invalid => "Enter only the server address, with https:// (http only for localhost), e.g. https://chat.example.org.",
            Refused::Duplicate => "This server is already in your list.",
            Refused::Full => "You can save up to {n} nodes.",
        }
    }
}

/// The origin of a typed or linked node address ("https://host[:port]", no trailing slash), or None for anything
/// with a path, query, fragment or user info, so what is shown and saved is exactly the host requests go to.
pub fn node_origin(input: &str) -> Option<String> {
    let v = input.trim();
    if v.contains(['?', '#']) {
        return None;
    }
    let with_scheme = if v.contains("://") { v.to_string() } else { format!("https://{v}") };
    if url::Url::parse(&with_scheme).ok()?.path() != "/" {
        return None;
    }
    let url = normalize_server_url(v)?;
    Some(url.origin().ascii_serialization())
}

/// The new entry for `address`, or why not (`hub` counts as already in the list).
pub fn add_node(list: &[SavedNode], address: &str, name: &str, hub: &str) -> Result<SavedNode, Refused> {
    let origin = node_origin(address).ok_or(Refused::Invalid)?;
    if list.iter().any(|n| n.origin == origin) || node_origin(hub).as_deref() == Some(origin.as_str()) {
        return Err(Refused::Duplicate);
    }
    if list.len() >= MAX_NODES {
        return Err(Refused::Full);
    }
    Ok(SavedNode { origin, name: clean_name(name) })
}

/// A node-supplied name as plain short text.
pub fn clean_name(name: &str) -> String {
    name.chars().filter(|c| !c.is_control()).collect::<String>().trim().chars().take(64).collect()
}

/// The stored list with anything malformed, doubled or over the cap dropped.
pub fn sanitize(list: Vec<SavedNode>) -> Vec<SavedNode> {
    let mut out: Vec<SavedNode> = Vec::new();
    for n in list {
        if let Ok(n) = add_node(&out, &n.origin, &n.name, "") {
            out.push(n);
        }
    }
    out
}

/// The one-click add link a node owner hands out; the same form the web client copies.
pub fn add_link(origin: &str, node: &str) -> String {
    format!("{}/add-node#{node}", origin.trim_end_matches('/'))
}

/// `cillhub://add-node#<address>` (address may be percent-encoded) → the node origin.
pub fn parse_add_deep_link(raw: &str) -> Option<String> {
    let rest = DEEP_LINK_SCHEMES.iter().find_map(|s| {
        raw.get(..s.len() + 3).filter(|p| p.eq_ignore_ascii_case(&format!("{s}://"))).map(|_| &raw[s.len() + 3..])
    })?;
    let address = rest.strip_prefix("add-node/#").or_else(|| rest.strip_prefix("add-node#"))?;
    node_origin(&percent_encoding::percent_decode_str(address).decode_utf8().ok()?)
}

/// The node's name from its open instance info (no token, no redirects, 5 s); None when it does not answer as Cillhub.
/// Blocking: call it on a background worker.
#[cfg(feature = "native-net")]
pub fn fetch_name(origin: &str) -> Option<String> {
    let res = crate::api::no_redirect_client(5).get(format!("{origin}/api/v9/instance")).send().ok()?;
    if !res.status().is_success() {
        return None;
    }
    let v: serde_json::Value = res.json().ok()?;
    v.is_object().then(|| clean_name(v.get("name").and_then(|n| n.as_str()).unwrap_or("")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn n(origin: &str) -> SavedNode {
        SavedNode { origin: origin.into(), name: String::new() }
    }

    #[test]
    fn addresses_become_origins() {
        assert_eq!(node_origin("chat.example.org/").as_deref(), Some("https://chat.example.org"));
        assert_eq!(node_origin("HTTPS://Chat.Example.org:443").as_deref(), Some("https://chat.example.org"));
        assert_eq!(node_origin("http://127.0.0.1:3399").as_deref(), Some("http://127.0.0.1:3399"));
        assert_eq!(node_origin("bücher.example").as_deref(), Some("https://xn--bcher-kva.example"));
        for bad in [
            "", " ", "http://chat.example.org", "ftp://a.b", "javascript:alert(1)", "https://chat.example.org/x",
            "https://chat.example.org/?a=1", "https://chat.example.org?", "https://chat.example.org#a",
            "https://user@chat.example.org", "https://chat.example.org@evil.test", "https://a b.org",
        ] {
            assert_eq!(node_origin(bad), None, "{bad}");
        }
    }

    #[test]
    fn duplicates_hub_and_cap() {
        let list = vec![n("https://chat.example.org")];
        assert_eq!(add_node(&list, "https://CHAT.example.org/", "x", ""), Err(Refused::Duplicate));
        assert_eq!(add_node(&list, "https://hub.example.org", "x", "https://hub.example.org"), Err(Refused::Duplicate));
        assert_eq!(add_node(&list, "http://other.example.org", "x", ""), Err(Refused::Invalid));
        assert_eq!(
            add_node(&list, "other.example.org", " Robin\u{7}s node ", ""),
            Ok(SavedNode { origin: "https://other.example.org".into(), name: "Robins node".into() })
        );
        let full: Vec<_> = (0..MAX_NODES).map(|i| n(&format!("https://n{i}.example.org"))).collect();
        assert_eq!(add_node(&full, "one-more.example.org", "", ""), Err(Refused::Full));
        assert_eq!(clean_name(&"x".repeat(100)).chars().count(), 64);
    }

    #[test]
    fn stored_list_is_sanitized() {
        let mut v = vec![n("https://a.org"), n("https://a.org/"), n("http://b.org"), n("https://c.org/path")];
        v.extend((0..30).map(|i| n(&format!("https://n{i}.org"))));
        let out = sanitize(v);
        assert_eq!(out.len(), MAX_NODES);
        assert_eq!(out[0].origin, "https://a.org");
        assert_eq!(out[1].origin, "https://n0.org");
    }

    #[test]
    fn add_links() {
        let link = add_link("https://hub.example.org/", "https://node.example.org");
        assert_eq!(link, "https://hub.example.org/add-node#https://node.example.org");
        assert_eq!(parse_add_deep_link("cillhub://add-node#https://node.example.org").as_deref(), Some("https://node.example.org"));
        assert_eq!(parse_add_deep_link("CILLCORD://add-node/#https%3A%2F%2Fnode.example.org").as_deref(), Some("https://node.example.org"));
        assert_eq!(parse_add_deep_link("cillhub://add-node#node.example.org").as_deref(), Some("https://node.example.org"));
        for bad in [
            "cillhub://add-node#", "cillhub://add-node#https://node.example.org/evil", "cillhub://add-node#https://a@node.example.org",
            "cillhub://add-node#http://node.example.org", "cillhub://invite/abc", "https://hub.example.org/add-node#https://node.example.org",
            "cillhub://add-node#%E0%A4%A",
        ] {
            assert_eq!(parse_add_deep_link(bad), None, "{bad}");
        }
    }
}
