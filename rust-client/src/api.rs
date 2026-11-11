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

#[cfg(feature = "native-net")]
#[derive(Clone)]
pub struct ApiClient {
    pub client: reqwest::blocking::Client,
    pub origin: Url,
    pub token: Option<String>,
}

#[cfg(feature = "native-net")]
impl ApiClient {
    pub fn new(origin: Url, token: Option<String>) -> Self {
        Self {
            client: no_redirect_client(15),
            origin,
            token,
        }
    }

}

/// Largest answer body read; a bigger one is refused before it is parsed (a private node is untrusted).
pub const MAX_BODY: u64 = 16 << 20;

/// The answer as JSON (Null when it is not JSON), or an error when it is larger than MAX_BODY.
#[cfg(feature = "native-net")]
fn read_json(resp: reqwest::blocking::Response) -> Result<Value, ApiError> {
    use std::io::Read;
    let mut buf = Vec::new();
    let too_big = || ApiError { status: 0, code: 0, message: "The answer is too large.".into(), fields: HashMap::new(), retry_after: None, raw: Value::Null };
    resp.take(MAX_BODY + 1).read_to_end(&mut buf).map_err(|_| too_big())?;
    if buf.len() as u64 > MAX_BODY {
        return Err(too_big());
    }
    Ok(serde_json::from_slice(&buf).unwrap_or(Value::Null))
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
        let url = api_url(&self.origin, path).ok_or_else(|| ApiError {
            status: 0,
            code: 0,
            message: "Invalid API path".to_string(),
            fields: HashMap::new(),
            retry_after: None,
            raw: Value::Null,
        })?;
        let mut req = self.client.request(method, url);
        if let Some(token) = &self.token {
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
        let data = read_json(resp)?;
        if !(200..300).contains(&status) {
            return Err(parse_api_error(status, data));
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
        let path = format!("/channels/{channel_id}/messages");
        let url = api_url(&self.origin, &path).ok_or_else(|| ApiError {
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
        if let Some(token) = &self.token {
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
        let data = read_json(resp)?;
        if !(200..300).contains(&status) {
            return Err(parse_api_error(status, data));
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
    fn an_oversized_answer_is_refused_before_parsing() {
        let (origin, seen) = testing::serve(1, |_| (200, format!("[\"{}\"]", "x".repeat(MAX_BODY as usize))));
        let api = ApiClient::new(Url::parse(&origin).unwrap(), None);
        assert_eq!(api.get("/channels/1/messages").unwrap_err().message, "The answer is too large.");
        seen.join().unwrap();
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
