use serde_json::Value;
use std::collections::HashMap;
use url::Url;

/// Matches the web client's server address policy: HTTPS, or HTTP on loopback.
pub fn normalize_server_url(input: &str) -> Option<Url> {
    let input = input.trim();
    if input.is_empty() {
        return None;
    }
    let address = if input.contains("://") {
        input.to_owned()
    } else {
        format!("https://{input}")
    };
    let mut url = Url::parse(&address).ok()?;
    let host = url.host_str()?;
    let local = host == "localhost"
        || host.ends_with(".localhost")
        || host == "127.0.0.1"
        || host == "[::1]";
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return None;
    }
    if !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    url.set_path("");
    url.set_query(None);
    url.set_fragment(None);
    Some(url)
}

pub fn api_url(origin: &Url, path: &str) -> Option<Url> {
    if !path.starts_with('/') || path.starts_with("//") {
        return None;
    }
    origin.join(&format!("/api/v9{path}")).ok()
}

pub fn cdn_url(origin: &Url, path: &str) -> String {
    if path.starts_with("http://") || path.starts_with("https://") || path.starts_with("data:") {
        return path.to_string();
    }
    let clean = path.trim_start_matches('/');
    origin
        .join(&format!("/cdn/{clean}"))
        .map(|u| u.to_string())
        .unwrap_or_else(|_| path.to_string())
}

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: u64,
    pub message: String,
    pub fields: HashMap<String, String>,
    pub retry_after: Option<f64>,
    pub raw: Value,
}

impl ApiError {
    /// The server asks to accept its terms first (403 with required_actions accept_terms).
    pub fn accept_terms(&self) -> bool {
        self.raw.get("required_actions").and_then(Value::as_array).is_some_and(|a| a.iter().any(|v| v == "accept_terms"))
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.fields.is_empty() {
            write!(f, "{}", self.message)
        } else {
            let details: Vec<String> = self
                .fields
                .iter()
                .map(|(k, v)| format!("{k}: {v}"))
                .collect();
            write!(f, "{} ({})", self.message, details.join(", "))
        }
    }
}

pub fn parse_api_error(status: u16, data: Value) -> ApiError {
    let code = data.get("code").and_then(Value::as_u64).unwrap_or(0);
    let message = data
        .get("message")
        .and_then(Value::as_str)
        .unwrap_or("Request failed")
        .to_string();
    let retry_after = data.get("retry_after").and_then(Value::as_f64);
    let mut fields = HashMap::new();
    if let Some(errors) = data.get("errors").and_then(Value::as_object) {
        flatten_errors("", errors, &mut fields);
    }
    ApiError {
        status,
        code,
        message,
        fields,
        retry_after,
        raw: data,
    }
}

fn flatten_errors(
    prefix: &str,
    obj: &serde_json::Map<String, Value>,
    out: &mut HashMap<String, String>,
) {
    if let Some(errs) = obj.get("_errors").and_then(Value::as_array) {
        if let Some(first) = errs
            .first()
            .and_then(|e| e.get("message"))
            .and_then(Value::as_str)
        {
            out.insert(
                if prefix.is_empty() {
                    "_".to_string()
                } else {
                    prefix.to_string()
                },
                first.to_string(),
            );
        }
    }
    for (k, v) in obj {
        if k == "_errors" {
            continue;
        }
        if let Some(sub) = v.as_object() {
            let next = if prefix.is_empty() {
                k.clone()
            } else {
                format!("{prefix}.{k}")
            };
            flatten_errors(&next, sub, out);
        }
    }
}

/// The type a browser would claim for an upload; the hub checks image bytes itself.
pub fn mime_for(filename: &str) -> &'static str {
    let ext = filename.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "txt" | "log" | "md" => "text/plain",
        _ => "application/octet-stream",
    }
}

/// payload_json for a message with files, as the web client builds it (actions.ts sendMessage):
/// one `attachments` entry per files[n] with id "n".
pub fn upload_payload(content: &str, filenames: &[String], reply_to: Option<&str>) -> Value {
    let mut payload = serde_json::json!({
        "content": content,
        "attachments": filenames.iter().enumerate()
            .map(|(i, f)| serde_json::json!({ "id": i.to_string(), "filename": f }))
            .collect::<Vec<_>>(),
    });
    if let Some(id) = reply_to {
        payload["message_reference"] = serde_json::json!({ "message_id": id });
    }
    payload
}

/// Which connection a request belongs to: the hub, or the private node that owns the guild or channel it names.
/// Ids of node servers are recorded in `owner` as their events arrive (the hub wins an id both name). Our user id
/// differs per node, so node paths, bodies and answers swap it with the hub one (the web's registry.ts aliasing).
#[derive(Debug, Default)]
pub struct Routes {
    pub hub_me: String,
    /// node origin -> (its token, our user id there; empty before its READY)
    pub nodes: HashMap<String, (String, String)>,
    /// guild and channel ids of node servers -> node origin
    pub owner: HashMap<String, String>,
}

impl Routes {
    /// The node origin a REST path (or its guild_id/channel_id in query or body) belongs to; None = the hub.
    pub fn route(&self, path: &str, body: Option<&Value>) -> Option<&str> {
        let (p, q) = path.split_once('?').unwrap_or((path, ""));
        // a node may name any user id, so /users/... goes to a node only through a node guild/channel in the query
        if !p.starts_with("/users/") {
            if let Some(o) = p.split('/').find_map(|seg| self.owner.get(seg)) {
                return Some(o);
            }
        }
        let query = url::form_urlencoded::parse(q.as_bytes());
        let from_query = query.filter(|(k, _)| k == "guild_id" || k == "channel_id").find_map(|(_, v)| self.owner.get(v.as_ref()));
        let from_body = || ["guild_id", "channel_id"].iter().find_map(|k| body?.get(k)?.as_str().and_then(|v| self.owner.get(v)));
        from_query.or_else(from_body).map(String::as_str)
    }
}

/// `<@id>` mentions of `from` as `to`.
fn swap_mentions(s: &str, from: &str, to: &str) -> String {
    if from.is_empty() || !s.contains(from) {
        return s.to_string();
    }
    s.replace(&format!("<@{from}>"), &format!("<@{to}>")).replace(&format!("<@!{from}>"), &format!("<@{to}>"))
}

/// A node payload as the hub-centred state expects it: our node user id becomes the hub one, root-relative URLs
/// point at the node, and media the client would load by itself must come from the node's own origin.
pub fn inbound(v: &mut Value, origin: &str, node_me: &str, hub_me: &str) {
    fn walk(v: &mut Value, key: &str, origin: &str, node_me: &str, hub_me: &str) {
        match v {
            Value::String(s) => {
                let on_node = s.starts_with(&format!("{origin}/"));
                if !node_me.is_empty() && s == node_me {
                    *s = hub_me.to_string();
                } else if matches!(key, "url" | "proxy_url" | "icon_url" | "proxy_icon_url" | "avatar_url" | "sound_url") && s.starts_with('/') && !s.starts_with("//") {
                    *s = format!("{origin}{s}");
                } else if (key.starts_with("proxy_") || key == "avatar_url" || key == "sound_url") && !on_node {
                    *v = Value::Null;
                } else if !node_me.is_empty() && !hub_me.is_empty() {
                    *s = swap_mentions(s, node_me, hub_me);
                }
            }
            Value::Array(a) => {
                if key == "attachments" {
                    // attachments are downloaded by the client: only the node's own
                    a.retain(|x| x.get("url").and_then(Value::as_str).is_none_or(|u| u.starts_with(&format!("{origin}/")) || (u.starts_with('/') && !u.starts_with("//"))));
                }
                a.iter_mut().for_each(|x| walk(x, key, origin, node_me, hub_me));
            }
            Value::Object(m) => m.iter_mut().for_each(|(k, x)| walk(x, k, origin, node_me, hub_me)),
            _ => {}
        }
    }
    walk(v, "", origin, node_me, hub_me)
}

/// The reverse for a body going to the node: our hub user id becomes the node one.
pub fn outbound(v: &mut Value, node_me: &str, hub_me: &str) {
    if node_me.is_empty() || hub_me.is_empty() {
        return;
    }
    match v {
        Value::String(s) if s == hub_me => *s = node_me.to_string(),
        Value::String(s) => *s = swap_mentions(s, hub_me, node_me),
        Value::Array(a) => a.iter_mut().for_each(|x| outbound(x, node_me, hub_me)),
        Value::Object(m) => m.values_mut().for_each(|x| outbound(x, node_me, hub_me)),
        _ => {}
    }
}

#[cfg(feature = "native-net")]
#[derive(Clone)]
pub struct ApiClient {
    pub client: reqwest::blocking::Client,
    pub origin: Url,
    pub token: Option<String>,
    /// Set on the hub client: requests about node servers go to that node with its token instead.
    pub routes: Option<std::sync::Arc<std::sync::RwLock<Routes>>>,
}

/// Where one request goes: (origin, token, path, body, (node origin, our node id, hub id) for node answers).
#[cfg(feature = "native-net")]
type Target = (Url, Option<String>, String, Option<Value>, Option<(String, String, String)>);

#[cfg(feature = "native-net")]
impl ApiClient {
    pub fn new(origin: Url, token: Option<String>) -> Self {
        Self {
            client: no_redirect_client(15),
            origin,
            token,
            routes: None,
        }
    }

    /// The origin and token for `path`, chosen together: the hub token only for the hub, a node token only for its
    /// node. A node server whose node is not connected gets an error, never the hub.
    fn target(&self, path: &str, mut body: Option<Value>) -> Result<Target, ApiError> {
        let Some(routes) = &self.routes else { return Ok((self.origin.clone(), self.token.clone(), path.to_string(), body, None)) };
        let r = routes.read().unwrap_or_else(|e| e.into_inner());
        let Some(origin) = r.route(path, body.as_ref()) else { return Ok((self.origin.clone(), self.token.clone(), path.to_string(), body, None)) };
        let fail = |m: &str| ApiError { status: 0, code: 0, message: m.to_string(), fields: HashMap::new(), retry_after: None, raw: Value::Null };
        let (token, me) = r.nodes.get(origin).ok_or_else(|| fail("This node is not connected."))?;
        let url = Url::parse(origin).map_err(|_| fail("Invalid node address"))?;
        let path = if me.is_empty() || r.hub_me.is_empty() {
            path.to_string()
        } else {
            path.split('/').map(|s| if s == r.hub_me { me.as_str() } else { s }).collect::<Vec<_>>().join("/")
        };
        if let Some(b) = &mut body {
            outbound(b, me, &r.hub_me);
        }
        Ok((url, Some(token.clone()), path, body, Some((origin.to_string(), me.clone(), r.hub_me.clone()))))
    }
}

/// For every request that carries a token or credentials: a redirect could replay the body (password, MFA code,
/// reset token) to another host or over plain HTTP, so none is followed.
#[cfg(feature = "native-net")]
pub fn no_redirect_client(timeout_secs: u64) -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(timeout_secs))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("TLS backend")
}

#[cfg(feature = "native-net")]
impl ApiClient {
    pub fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
        extra_headers: Option<&[(&str, &str)]>,
    ) -> Result<Value, ApiError> {
        let (origin, token, path, body, node) = self.target(path, body)?;
        let url = api_url(&origin, &path).ok_or_else(|| ApiError {
            status: 0,
            code: 0,
            message: "Invalid API path".to_string(),
            fields: HashMap::new(),
            retry_after: None,
            raw: Value::Null,
        })?;
        let mut req = self.client.request(method, url);
        if let Some(token) = &token {
            req = req.header("Authorization", token);
        }
        if let Some(headers) = extra_headers {
            for (k, v) in headers {
                req = req.header(*k, *v);
            }
        }
        if let Some(body) = body {
            req = req.json(&body);
        }
        let resp = req.send().map_err(|e| ApiError {
            status: 0,
            code: 0,
            message: e.to_string(),
            fields: HashMap::new(),
            retry_after: None,
            raw: Value::Null,
        })?;
        let status = resp.status().as_u16();
        if status == 204 {
            return Ok(Value::Null);
        }
        let mut data: Value = resp.json().unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            return Err(parse_api_error(status, data));
        }
        if let Some((o, me, hub_me)) = node {
            inbound(&mut data, &o, &me, &hub_me);
        }
        Ok(data)
    }

    pub fn get(&self, path: &str) -> Result<Value, ApiError> {
        self.request(reqwest::Method::GET, path, None, None)
    }

    pub fn post(&self, path: &str, body: Value) -> Result<Value, ApiError> {
        self.request(reqwest::Method::POST, path, Some(body), None)
    }

    pub fn patch(&self, path: &str, body: Value) -> Result<Value, ApiError> {
        self.request(reqwest::Method::PATCH, path, Some(body), None)
    }

    pub fn put(&self, path: &str, body: Option<Value>) -> Result<Value, ApiError> {
        self.request(reqwest::Method::PUT, path, body, None)
    }

    pub fn delete(&self, path: &str) -> Result<Value, ApiError> {
        self.request(reqwest::Method::DELETE, path, None, None)
    }

    pub fn upload_message(
        &self,
        channel_id: &str,
        payload_json: &Value,
        files: &[(String, Vec<u8>)],
    ) -> Result<Value, ApiError> {
        let mut payload_json = payload_json.clone();
        let (origin, token, path, _, node) = self.target(&format!("/channels/{channel_id}/messages"), None)?;
        if let Some((_, me, hub_me)) = &node {
            outbound(&mut payload_json, me, hub_me);
        }
        let url = api_url(&origin, &path).ok_or_else(|| ApiError {
            status: 0,
            code: 0,
            message: "Invalid API path".to_string(),
            fields: HashMap::new(),
            retry_after: None,
            raw: Value::Null,
        })?;
        let mut form = reqwest::blocking::multipart::Form::new()
            .text("payload_json", payload_json.to_string());
        for (idx, (filename, bytes)) in files.iter().enumerate() {
            let part = reqwest::blocking::multipart::Part::bytes(bytes.clone())
                .file_name(filename.clone())
                .mime_str(mime_for(filename))
                .expect("static mime type");
            form = form.part(format!("files[{idx}]"), part);
        }
        let mut req = self.client.post(url).multipart(form);
        if let Some(token) = &token {
            req = req.header("Authorization", token);
        }
        let resp = req.send().map_err(|e| ApiError {
            status: 0,
            code: 0,
            message: e.to_string(),
            fields: HashMap::new(),
            retry_after: None,
            raw: Value::Null,
        })?;
        let status = resp.status().as_u16();
        let mut data: Value = resp.json().unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            return Err(parse_api_error(status, data));
        }
        if let Some((o, me, hub_me)) = node {
            inbound(&mut data, &o, &me, &hub_me);
        }
        Ok(data)
    }
}

/// A local HTTP server for tests: answers `n` requests with `answer(request)` -> (status, JSON body), returns them all.
#[cfg(all(test, feature = "native-net"))]
pub mod testing {
    use std::io::{Read, Write};
    pub fn serve(n: usize, answer: impl Fn(&str) -> (u16, String) + Send + 'static) -> (String, std::thread::JoinHandle<Vec<String>>) {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://127.0.0.1:{}", listener.local_addr().unwrap().port());
        let t = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for _ in 0..n {
                let Ok((mut sock, _)) = listener.accept() else { break };
                sock.set_read_timeout(Some(std::time::Duration::from_secs(5))).unwrap();
                let mut req = Vec::new();
                let mut buf = [0u8; 4096];
                while let Ok(k) = sock.read(&mut buf) {
                    if k == 0 {
                        break;
                    }
                    req.extend_from_slice(&buf[..k]);
                    let text = String::from_utf8_lossy(&req).to_string();
                    let Some(end) = text.find("\r\n\r\n") else { continue };
                    let len = text.lines().find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length: ").and_then(|v| v.trim().parse::<usize>().ok())).unwrap_or(0);
                    if req.len() >= end + 4 + len {
                        break;
                    }
                }
                let req = String::from_utf8_lossy(&req).to_string();
                let (status, body) = answer(&req);
                let head = format!("HTTP/1.1 {status} X\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = sock.write_all(head.as_bytes());
                let _ = sock.write_all(body.as_bytes());
                seen.push(req);
            }
            seen
        });
        (origin, t)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[cfg(feature = "native-net")]
    #[test]
    fn each_request_carries_only_its_own_origins_token() {
        use std::sync::{Arc, RwLock};
        let (hub, hub_seen) = testing::serve(2, |_| (200, "{}".into()));
        let (node, node_seen) = testing::serve(1, |_| {
            (200, r#"{"author":{"id":"9"},"content":"hi <@9>","attachments":[{"url":"/attachments/a.png"},{"url":"https://evil.example/b.png"}]}"#.into())
        });
        let mut routes = Routes { hub_me: "1".into(), ..Default::default() };
        routes.nodes.insert(node.clone(), ("node-token".into(), "9".into()));
        routes.owner.insert("77".into(), node.clone());
        routes.owner.insert("78".into(), "http://127.0.0.1:1".into()); // a node server whose node is not connected
        let mut api = ApiClient::new(Url::parse(&hub).unwrap(), Some("hub-token".into()));
        api.routes = Some(Arc::new(RwLock::new(routes)));

        let out = api.post("/channels/77/messages", json!({ "content": "hey <@1>" })).unwrap();
        assert_eq!((out["author"]["id"].as_str(), out["content"].as_str()), (Some("1"), Some("hi <@1>")), "our node id reads as the hub one");
        assert_eq!(out["attachments"].as_array().unwrap().len(), 1, "media only from the node itself");
        assert_eq!(out["attachments"][0]["url"], format!("{node}/attachments/a.png"));
        api.get("/channels/5/messages").unwrap();
        api.get("/users/@me/settings?guild_id=5").unwrap();
        assert_eq!(api.get("/channels/78/messages").unwrap_err().status, 0, "never sent to the hub instead");

        let node_seen = node_seen.join().unwrap();
        assert!(node_seen[0].starts_with("POST /api/v9/channels/77/messages "));
        assert!(node_seen[0].contains("node-token") && !node_seen[0].contains("hub-token"));
        assert!(node_seen[0].contains("hey <@9>"), "the body names our node account");
        let hub_seen = hub_seen.join().unwrap();
        assert!(hub_seen.iter().all(|r| r.contains("hub-token") && !r.contains("node-token")));
    }

    #[test]
    fn server_address_policy() {
        assert_eq!(
            normalize_server_url("chat.example.org/").unwrap().as_str(),
            "https://chat.example.org/"
        );
        assert!(normalize_server_url("http://chat.example.org").is_none());
        assert_eq!(
            normalize_server_url("http://localhost:3000/x")
                .unwrap()
                .as_str(),
            "http://localhost:3000/"
        );
        assert!(normalize_server_url("ftp://chat.example.org").is_none());
        assert!(normalize_server_url("https://user:pass@chat.example.org").is_none());
        assert!(normalize_server_url(" ").is_none());
    }

    #[test]
    fn api_path_stays_on_origin() {
        let origin = normalize_server_url("https://chat.example.org").unwrap();
        assert_eq!(
            api_url(&origin, "/channels/123/messages").unwrap().as_str(),
            "https://chat.example.org/api/v9/channels/123/messages"
        );
        assert!(api_url(&origin, "//evil.example.org").is_none());
    }

    #[cfg(feature = "native-net")]
    #[test]
    fn upload_sends_the_web_clients_multipart_form() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut sock, _) = listener.accept().unwrap();
            sock.set_read_timeout(Some(std::time::Duration::from_secs(2))).unwrap();
            let mut req = Vec::new();
            let mut buf = [0u8; 4096];
            while let Ok(n) = sock.read(&mut buf) {
                if n == 0 {
                    break;
                }
                req.extend_from_slice(&buf[..n]);
                if req.ends_with(b"--\r\n") {
                    break;
                }
            }
            let body = br#"{"id":"m1","channel_id":"c1"}"#;
            let head = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n", body.len());
            sock.write_all(head.as_bytes()).unwrap();
            sock.write_all(body).unwrap();
            String::from_utf8_lossy(&req).to_string()
        });
        let origin = normalize_server_url(&format!("http://localhost:{port}")).unwrap();
        let api = ApiClient::new(origin, Some("dummy-token".into()));
        let names = vec!["board.png".to_string()];
        let payload = upload_payload("look", &names, Some("m0"));
        let out = api.upload_message("c1", &payload, &[(names[0].clone(), vec![0x89, b'P', b'N', b'G'])]).unwrap();
        assert_eq!(out["id"], "m1");
        let req = server.join().unwrap();
        assert!(req.starts_with("POST /api/v9/channels/c1/messages "));
        assert!(req.contains("name=\"payload_json\""));
        assert!(req.contains(r#""attachments":[{"filename":"board.png","id":"0"}]"#), "{req}");
        assert!(req.contains(r#""message_reference":{"message_id":"m0"}"#));
        assert!(req.contains("name=\"files[0]\"; filename=\"board.png\""));
        assert!(req.contains("Content-Type: image/png"));
    }

    #[cfg(feature = "native-net")]
    #[test]
    fn login_body_never_follows_a_redirect() {
        use std::io::{Read, Write};
        let hub = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let other = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        other.set_nonblocking(true).unwrap();
        let (hub_port, other_port) = (hub.local_addr().unwrap().port(), other.local_addr().unwrap().port());
        let server = std::thread::spawn(move || {
            let (mut sock, _) = hub.accept().unwrap();
            let mut buf = [0u8; 4096];
            let _ = sock.read(&mut buf);
            let head = format!("HTTP/1.1 307 Temporary Redirect\r\nLocation: http://127.0.0.1:{other_port}/collect\r\nContent-Length: 0\r\n\r\n");
            sock.write_all(head.as_bytes()).unwrap();
        });
        let api = ApiClient::new(normalize_server_url(&format!("http://localhost:{hub_port}")).unwrap(), None);
        let err = api.post("/auth/login", json!({ "login": "alex", "password": "secret" })).unwrap_err();
        server.join().unwrap();
        assert_eq!(err.status, 307);
        assert!(other.accept().is_err(), "the password went to the redirect target");
    }

    #[test]
    fn terms_gate_is_recognised() {
        let gated = parse_api_error(403, json!({ "code": 0, "message": "Accept the terms.", "required_actions": ["accept_terms"] }));
        assert!(gated.accept_terms());
        assert!(!parse_api_error(403, json!({ "code": 0, "message": "x", "required_actions": ["update_password"] })).accept_terms());
    }

    #[test]
    fn parses_50035_field_errors() {
        let err = parse_api_error(
            400,
            json!({
                "code": 50035,
                "message": "Invalid Form Body",
                "errors": {
                    "username": { "_errors": [{ "code": "BASE_TYPE_BAD_LENGTH", "message": "Must be between 2 and 32" }] }
                }
            }),
        );
        assert_eq!(err.code, 50035);
        assert_eq!(
            err.fields.get("username").map(String::as_str),
            Some("Must be between 2 and 32")
        );
    }
}
