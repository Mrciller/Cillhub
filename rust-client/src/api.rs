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
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .unwrap_or_else(|_| reqwest::blocking::Client::new());
        Self {
            client,
            origin,
            token,
        }
    }

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
        let data: Value = resp.json().unwrap_or(Value::Null);
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
                .file_name(filename.clone());
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
        let data: Value = resp.json().unwrap_or(Value::Null);
        if !(200..300).contains(&status) {
            return Err(parse_api_error(status, data));
        }
        Ok(data)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
