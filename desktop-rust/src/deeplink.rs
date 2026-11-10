//! cillhub://invite/<code> (or the older cillcord://) → "/invite/<code>"; anything else is ignored. Plus the unread
//! count the web client puts in its title.

use crate::config::DEEP_LINK_SCHEMES;

pub fn deep_link_path(raw: &str) -> Option<String> {
    let rest = DEEP_LINK_SCHEMES.iter().find_map(|s| raw.get(..s.len() + 3).filter(|p| p.eq_ignore_ascii_case(&format!("{s}://"))).map(|_| &raw[s.len() + 3..]))?;
    let code = rest.strip_prefix("invite/")?.trim_end_matches('/');
    ((2..=32).contains(&code.len()) && code.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')).then(|| format!("/invite/{code}"))
}

/// "(N) …" = N mentions, "• …" = unread without a count (-1), else 0.
pub fn parse_unread(title: &str) -> i32 {
    let t = title.trim_start();
    if let Some(rest) = t.strip_prefix('(') {
        if let Some(end) = rest.find(')') {
            return rest[..end].trim_end_matches('+').parse().unwrap_or(0);
        }
    }
    if t.starts_with('•') || t.starts_with('●') { -1 } else { 0 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn deep_links() {
        assert_eq!(deep_link_path("cillhub://invite/abc-123").as_deref(), Some("/invite/abc-123"));
        assert_eq!(deep_link_path("CILLCORD://invite/ab/").as_deref(), Some("/invite/ab"));
        assert_eq!(deep_link_path("cillhub://invite/a"), None);
        assert_eq!(deep_link_path("cillhub://invite/../x"), None);
        assert_eq!(deep_link_path("cillhub://channels/1/2"), None);
        assert_eq!(deep_link_path("https://example.com/invite/abc"), None);
    }

    #[test]
    fn unread() {
        assert_eq!(parse_unread("Cillhub"), 0);
        assert_eq!(parse_unread("(5) Cillhub"), 5);
        assert_eq!(parse_unread("(99+) Cillhub"), 99);
        assert_eq!(parse_unread("● #general — Cillhub"), -1);
        assert_eq!(parse_unread("(x) Cillhub"), 0);
    }
}
