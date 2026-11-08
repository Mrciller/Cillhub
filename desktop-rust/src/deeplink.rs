//! Deep link parsing for cillhub:// and legacy cillcord:// URLs

use crate::config::DEEP_LINK_SCHEMES;

/// Parse a deep link URL into an in-app path (e.g. /channels/123/456, /invite/code)
pub fn deep_link_path(raw_url: &str) -> Option<String> {
    for scheme in DEEP_LINK_SCHEMES {
        let prefix = format!("{}://", scheme);
        if let Some(rest) = raw_url.strip_prefix(&prefix) {
            let trimmed = rest.trim_start_matches('/');
            return Some(format!("/{}", trimmed));
        }
    }
    None
}

/// Parse unread mentions from window title (e.g. "(3) Cillhub", "● Cillhub")
#[derive(Debug, PartialEq, Eq)]
pub enum UnreadState {
    None,
    UnreadPill,
    Mentions(u32),
}

pub fn parse_unread(title: &str) -> UnreadState {
    let trimmed = title.trim();
    if trimmed.starts_with('●') {
        return UnreadState::UnreadPill;
    }
    if trimmed.starts_with('(') {
        if let Some(close_idx) = trimmed.find(')') {
            let num_str = &trimmed[1..close_idx];
            if let Ok(count) = num_str.parse::<u32>() {
                if count > 0 {
                    return UnreadState::Mentions(count);
                }
            }
        }
    }
    UnreadState::None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deep_link_path() {
        assert_eq!(deep_link_path("cillhub://channels/123/456"), Some("/channels/123/456".into()));
        assert_eq!(deep_link_path("cillcord://invite/my-server"), Some("/invite/my-server".into()));
        assert_eq!(deep_link_path("https://example.com"), None);
    }

    #[test]
    fn test_parse_unread() {
        assert_eq!(parse_unread("Cillhub"), UnreadState::None);
        assert_eq!(parse_unread("● #general — Cillhub"), UnreadState::UnreadPill);
        assert_eq!(parse_unread("(5) Cillhub"), UnreadState::Mentions(5));
        assert_eq!(parse_unread("(0) Cillhub"), UnreadState::None);
    }
}
