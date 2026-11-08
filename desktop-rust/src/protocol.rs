//! Protocol handling and path traversal security for app://cillhub

use percent_encoding::percent_decode_str;
use std::path::{Component, Path, PathBuf};

pub const STRICT_CSP: &str = "default-src 'self' app: blob:; script-src 'self' app: 'wasm-unsafe-eval'; style-src 'self' app: 'unsafe-inline'; img-src 'self' app: data: blob: https:; media-src 'self' app: data: blob: https:; connect-src 'self' app: https: wss:; font-src 'self' app: data:; frame-src https://www.youtube-nocookie.com; object-src 'none'; base-uri 'none';";

/// Resolve a requested URI path within the frontend directory, blocking directory traversal.
/// Returns Ok(PathBuf) if safe, Err(&'static str) if traversal or invalid path detected.
pub fn sanitize_app_path(base_dir: &Path, raw_path: &str) -> Result<PathBuf, &'static str> {
    let clean = raw_path.split('?').next().unwrap_or(raw_path);
    // URL-decode percent-encoded paths (e.g. %2e%2e -> ..) matching decodeURIComponent in desktop/src/protocol.js
    let decoded = percent_decode_str(clean)
        .decode_utf8()
        .map_err(|_| "invalid utf-8 path")?;
    // Normalize Windows backslashes to forward slashes across all platforms
    let normalized = decoded.replace('\\', "/");
    let trimmed = normalized.trim_start_matches('/');
    let target = if trimmed.is_empty() { "index.html" } else { trimmed };

    // Explicit segment check for ".."
    for segment in target.split('/') {
        if segment == ".." {
            return Err("directory traversal blocked");
        }
    }

    let p = Path::new(target);
    for comp in p.components() {
        match comp {
            Component::ParentDir => return Err("directory traversal blocked"),
            Component::RootDir | Component::Prefix(_) => return Err("invalid path component"),
            Component::Normal(_) | Component::CurDir => {}
        }
    }

    let full_path = base_dir.join(target);

    // Double-check path stays inside base_dir
    if !full_path.starts_with(base_dir) {
        return Err("directory traversal blocked");
    }

    // If file has an extension (.js, .css, .wasm, .png) and does not exist -> 404
    if let Some(ext) = full_path.extension() {
        let ext_str = ext.to_string_lossy();
        if ["js", "css", "wasm", "png", "svg", "jpg", "jpeg", "woff2", "json"].contains(&ext_str.as_ref()) {
            if full_path.exists() {
                return Ok(full_path);
            } else {
                return Err("asset not found");
            }
        }
    }

    // SPA fallback: routes like /channels/123 or /invite/abc serve index.html
    if full_path.exists() && full_path.is_file() {
        Ok(full_path)
    } else {
        let index = base_dir.join("index.html");
        if index.exists() {
            Ok(index)
        } else {
            Err("index.html not found")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn test_traversal_prevention() {
        let tmp = std::env::temp_dir().join("cillhub_proto_test");
        let _ = fs::create_dir_all(&tmp);
        let _ = fs::write(tmp.join("index.html"), "<html></html>");

        assert!(sanitize_app_path(&tmp, "../secret.txt").is_err());
        assert!(sanitize_app_path(&tmp, "foo/../../secret.txt").is_err());
        assert!(sanitize_app_path(&tmp, "/../etc/passwd").is_err());

        // Valid index route
        assert!(sanitize_app_path(&tmp, "/").is_ok());
        assert!(sanitize_app_path(&tmp, "/channels/123").is_ok());

        let _ = fs::remove_dir_all(tmp);
    }
}
