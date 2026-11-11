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

/// The connection of a saved node next to the hub (Settings › Private Nodes and the rail).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NodeLink {
    /// signing in or waiting for the node's READY
    Connecting,
    Ready,
    /// offline or refused, with the reason; retried with backoff
    Down(String),
    /// not linked to this hub, or the node signs in only its own accounts
    OwnLogin,
    /// a node version without the background sign-in
    Old,
}

/// Retry delay after `tries` failures in a row: 5 s doubling, at most 5 minutes.
pub fn backoff_secs(tries: u32) -> u64 {
    (5u64 << tries.saturating_sub(1).min(6)).min(300)
}

/// The hub's record (GET /federation/nodes) for a saved origin: (node id, name, active).
pub fn find_record(records: &serde_json::Value, origin: &str) -> Option<(String, String, bool)> {
    records.as_array()?.iter().find_map(|r| {
        let url = r.get("url")?.as_str()?;
        (node_origin(url.trim_end_matches('/')).as_deref() == Some(origin)).then(|| {
            let s = |k: &str| r.get(k).and_then(|v| v.as_str()).unwrap_or("").to_string();
            (s("node_id"), clean_name(&s("name")), s("status") == "active")
        })
    })
}

#[derive(Debug, PartialEq, Eq)]
pub enum SignInFail {
    OwnLogin,
    Old,
    /// the session that started it ended (logout, other account): nothing was sent to the hub after that
    Stale,
    Down(String),
}

/// Signs in on a saved node with the hub account, without a window (the node's hub-login?answer=json). The user
/// agreed when adding the node, so the consent is given here. Every address the node names is checked: the consent
/// goes only to our hub's /oauth2/authorize for this node id, the code only to the node's own callback; no redirects
/// are followed and the hub token never goes to the node. `alive` is asked right before the consent is posted.
/// Blocking: call it on a worker.
#[cfg(feature = "native-net")]
pub fn sign_in(hub: &url::Url, hub_token: &str, origin: &str, node_id: &str, alive: &dyn Fn() -> bool) -> Result<String, SignInFail> {
    use crate::i18n::trf;
    use serde_json::Value;
    let name = origin.split("://").nth(1).unwrap_or(origin);
    let bad = || SignInFail::Down(trf("{name} sent an invalid answer.", &[("name", name)]));
    let client = crate::api::no_redirect_client(10);
    let call = |url: url::Url| -> Result<serde_json::Map<String, Value>, SignInFail> {
        let res = client.get(url).send().map_err(|_| SignInFail::Down(trf("{name} is not reachable right now.", &[("name", name)])))?;
        if res.status().is_redirection() {
            return Err(SignInFail::Old);
        }
        let status = res.status().as_u16();
        let failed = || SignInFail::Down(trf("Request failed ({status})", &[("status", &status.to_string())]));
        match res.json::<Value>() {
            Ok(Value::Object(m)) if m.get("error").and_then(Value::as_str) == Some("unavailable") => Err(SignInFail::OwnLogin),
            Ok(Value::Object(_)) if !(200..300).contains(&status) => Err(failed()),
            Ok(Value::Object(m)) => Ok(m),
            _ => Err(failed()),
        }
    };
    let mut state = [0u8; 16];
    getrandom::getrandom(&mut state).map_err(|_| bad())?;
    let state: String = state.iter().map(|b| format!("{b:02x}")).collect();
    let hub_origin = hub.origin().ascii_serialization();
    let start = url::Url::parse_with_params(
        &format!("{origin}/api/v9/federation/hub-login"),
        [("return_to", format!("{hub_origin}/instances/callback").as_str()), ("state", &state), ("answer", "json")],
    )
    .map_err(|_| bad())?;
    let start = call(start)?;
    let consent = start.get("authorize_url").and_then(Value::as_str).and_then(|u| url::Url::parse(u).ok()).ok_or_else(bad)?;
    let q: Vec<(String, String)> = consent.query_pairs().into_owned().collect();
    let client_id = q.iter().find(|(k, _)| k == "client_id").map(|(_, v)| v.as_str());
    if consent.origin().ascii_serialization() != hub_origin || consent.path() != "/oauth2/authorize" || client_id != Some(node_id) {
        return Err(bad());
    }
    const KEEP: [&str; 7] = ["client_id", "redirect_uri", "response_type", "scope", "code_challenge", "code_challenge_method", "state"];
    let keep = url::form_urlencoded::Serializer::new(String::new()).extend_pairs(q.iter().filter(|(k, _)| KEEP.contains(&k.as_str()))).finish();
    if !alive() {
        return Err(SignInFail::Stale);
    }
    let answer = crate::api::ApiClient::new(hub.clone(), Some(hub_token.to_string()))
        .post(&format!("/oauth2/authorize?{keep}"), serde_json::json!({ "authorize": true }))
        .map_err(|e| SignInFail::Down(e.to_string()))?;
    let back = answer.get("location").and_then(Value::as_str).and_then(|u| url::Url::parse(u).ok()).ok_or_else(bad)?;
    if back.origin().ascii_serialization() != origin || back.path() != "/api/v9/federation/hub-callback" {
        return Err(bad());
    }
    let out = call(back)?;
    if let Some(e) = out.get("error") {
        let why = out.get("error_description").unwrap_or(e).as_str().unwrap_or("").chars().take(200).collect::<String>();
        return Err(SignInFail::Down(trf("{name} refused the sign-in: {error}", &[("name", name), ("error", &why)])));
    }
    match (out.get("state").and_then(Value::as_str), out.get("node_id").and_then(Value::as_str), out.get("token").and_then(Value::as_str)) {
        (Some(s), Some(id), Some(t)) if s == state && id == node_id && !t.is_empty() => Ok(t.to_string()),
        _ => Err(bad()),
    }
}

/// Ends our session on a node (its token is revoked there): no redirects; network errors, 429 and 5xx are retried
/// up to 5 times, a 2xx or 401 is final. Blocking (sleeps between tries): run it on its own thread.
#[cfg(feature = "native-net")]
pub fn revoke(origin: &str, token: &str) -> bool {
    let Ok(o) = url::Url::parse(origin) else { return false };
    let api = crate::api::ApiClient::new(o, Some(token.to_string()));
    for i in 0..5 {
        match api.post("/auth/logout", serde_json::json!({})) {
            Ok(_) => return true,
            Err(e) if e.status == 401 => return true, // already not valid there
            Err(e) if e.status != 0 && e.status != 429 && e.status < 500 => break,
            Err(_) => std::thread::sleep(std::time::Duration::from_secs(1 << i)),
        }
    }
    eprintln!("cillhub: could not sign out on {origin}");
    false
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
    fn retry_backoff_and_hub_record() {
        assert_eq!((1..=8).map(backoff_secs).collect::<Vec<_>>(), vec![5, 10, 20, 40, 80, 160, 300, 300]);
        let records = serde_json::json!([{ "node_id": "42", "name": "Robin\u{7}s", "url": "https://node.example.org/", "status": "active" }]);
        assert_eq!(find_record(&records, "https://node.example.org"), Some(("42".into(), "Robins".into(), true)));
        assert_eq!(find_record(&records, "https://other.example.org"), None);
    }

    /// The hub token goes only to our hub's consent, the node never sees it; a consent page anywhere else is refused
    /// and a session that ended stops the flow before the consent is posted.
    #[cfg(feature = "native-net")]
    #[test]
    fn hub_sign_in_keeps_each_token_on_its_origin() {
        use crate::api::testing::serve;
        use serde_json::json;
        use std::sync::{Arc, Mutex};
        let flow = |consent_at: Option<&str>, alive: bool| {
            let peer = Arc::new(Mutex::new(String::new()));
            let p = peer.clone();
            let (hub, hub_seen) = serve(1, move |_| {
                (200, json!({ "location": format!("{}/api/v9/federation/hub-callback?code=c&state=k", p.lock().unwrap()) }).to_string())
            });
            let consent = consent_at.map_or(hub.clone(), String::from);
            let ours = Arc::new(Mutex::new(String::new()));
            let (node, node_seen) = serve(2, move |req| {
                if req.contains("/hub-login?") {
                    *ours.lock().unwrap() = req.split("&state=").nth(1).unwrap_or("").split('&').next().unwrap_or("").to_string();
                    let q = "client_id=42&redirect_uri=x&response_type=code&scope=identify&code_challenge=c&code_challenge_method=S256&state=k&extra=1";
                    (200, json!({ "authorize_url": format!("{consent}/oauth2/authorize?{q}") }).to_string())
                } else {
                    (200, json!({ "token": "node-token", "node_id": "42", "state": *ours.lock().unwrap() }).to_string())
                }
            });
            *peer.lock().unwrap() = node.clone();
            let r = sign_in(&url::Url::parse(&hub).unwrap(), "hub-token", &node, "42", &|| alive);
            for o in [&hub, &hub, &node, &node] {
                let _ = std::net::TcpStream::connect(o.trim_start_matches("http://")); // ends idle test servers
            }
            (r, hub_seen.join().unwrap(), node_seen.join().unwrap())
        };
        let (r, hub_seen, node_seen) = flow(None, true);
        assert_eq!(r, Ok("node-token".to_string()));
        assert!(hub_seen[0].starts_with("POST /api/v9/oauth2/authorize?client_id=42&"), "{}", hub_seen[0]);
        assert!(hub_seen[0].contains("hub-token") && !hub_seen[0].contains("extra="));
        assert!(node_seen.iter().all(|r| !r.contains("hub-token") && !r.to_ascii_lowercase().contains("authorization")));
        assert!(node_seen[1].starts_with("GET /api/v9/federation/hub-callback?code=c&state=k "));

        let (r, hub_seen, _) = flow(Some("http://127.0.0.1:1"), true);
        assert!(matches!(r, Err(SignInFail::Down(_))), "{r:?}");
        assert!(hub_seen.iter().all(|r| !r.contains("hub-token")));
        let (r, hub_seen, _) = flow(None, false);
        assert_eq!(r, Err(SignInFail::Stale));
        assert!(hub_seen.iter().all(|r| !r.contains("hub-token")));
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
