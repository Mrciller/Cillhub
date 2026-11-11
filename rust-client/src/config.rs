//! Addresses and the URL rules the native desktop client applies.

use url::Url;

pub const PROD_HUB: &str = match option_env!("CILLCORD_HUB_URL") {
    Some(h) => h,
    None => "https://cillhub.cillerian.org",
};
pub const HUB_URL: &str = PROD_HUB;
pub const APP_ID: &str = "io.github.mrciller.cillhub";
pub const DEEP_LINK_SCHEMES: &[&str] = &["cillhub", "cillcord"];
pub const FEED_PATH: &str = "/download/desktop/";
pub const APP_ORIGIN: &str = if cfg!(windows) {
    "http://cillhub.localhost"
} else {
    "cillhub://localhost"
};

const SPA_SECTIONS: &[&str] = &[
    "",
    "channels",
    "invite",
    "template",
    "login",
    "register",
    "oauth2",
    "instances",
    "developers",
    "admin",
    "directory",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PermissionKind {
    Microphone,
    Camera,
    Notifications,
    DisplayCapture,
    Geolocation,
    ClipboardRead,
}

pub fn is_app_url(u: &Url) -> bool {
    ((u.scheme() == "cillhub" || u.scheme() == "tauri") && u.host_str() == Some("localhost"))
        || u.host_str() == Some("cillhub.localhost")
        || u.host_str() == Some("tauri.localhost")
}

pub fn is_http_url(u: &Url) -> bool {
    matches!(u.scheme(), "http" | "https")
}

pub fn app_url_for(u: &Url) -> Option<Url> {
    let hub = Url::parse(PROD_HUB).ok()?;
    if u.origin() != hub.origin()
        || !SPA_SECTIONS.contains(&u.path().split('/').nth(1).unwrap_or(""))
    {
        return None;
    }
    let mut app = Url::parse(APP_ORIGIN).ok()?;
    app.set_path(u.path());
    app.set_query(u.query());
    app.set_fragment(u.fragment());
    Some(app)
}

#[derive(Debug, PartialEq, Eq)]
pub enum Nav {
    Allow,
    Redirect(Url),
    Deny,
}

pub fn navigation(u: &Url) -> Nav {
    if is_app_url(u) || u.as_str() == "about:blank" {
        Nav::Allow
    } else if let Some(app) = app_url_for(u) {
        Nav::Redirect(app)
    } else if is_http_url(u) {
        Nav::Allow
    } else {
        Nav::Deny
    }
}

pub fn permission_allowed(page: Option<&Url>, kind: &PermissionKind) -> bool {
    use PermissionKind as K;
    page.is_some_and(is_app_url)
        && matches!(
            kind,
            K::Microphone | K::Camera | K::Notifications | K::DisplayCapture
        )
}

#[cfg(test)]
mod tests {
    use super::*;
    use PermissionKind as K;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn navigation_guard() {
        let app = u(&format!("{APP_ORIGIN}/channels/1"));
        assert!(matches!(navigation(&app), Nav::Allow));
        assert!(matches!(navigation(&u("about:blank")), Nav::Allow));
        match navigation(&u(&format!(
            "{PROD_HUB}/instances/callback?x=1#token=t&state=s"
        ))) {
            Nav::Redirect(r) => assert_eq!(
                r.as_str(),
                format!("{APP_ORIGIN}/instances/callback?x=1#token=t&state=s")
            ),
            _ => panic!("hub client page not redirected"),
        }
        assert!(matches!(
            navigation(&u(&format!("{PROD_HUB}/invite/abc"))),
            Nav::Redirect(_)
        ));
        assert!(matches!(
            navigation(&u(&format!("{PROD_HUB}/api/v9/users/@me"))),
            Nav::Allow
        ));
        assert!(matches!(
            navigation(&u("https://node.example/api/v9/federation/hub-login")),
            Nav::Allow
        ));
        assert!(matches!(navigation(&u("file:///etc/passwd")), Nav::Deny));
        assert!(matches!(navigation(&u("javascript:alert(1)")), Nav::Deny));
        assert!(matches!(navigation(&u("cillhub://evil/")), Nav::Deny));
        assert!(
            !is_app_url(&u("http://cillhub.localhost.evil.com/"))
                && !is_app_url(&u("cillhub://localhost.evil.com/"))
        );
    }

    #[test]
    fn permissions() {
        let app = u(&format!("{APP_ORIGIN}/"));
        let hub = u(&format!("{PROD_HUB}/"));
        for k in [
            K::Microphone,
            K::Camera,
            K::Notifications,
            K::DisplayCapture,
        ] {
            assert!(permission_allowed(Some(&app), &k));
            assert!(!permission_allowed(Some(&hub), &k), "hub page got {k:?}");
        }
        assert!(!permission_allowed(Some(&app), &K::Geolocation));
        assert!(!permission_allowed(Some(&app), &K::ClipboardRead));
        assert!(!permission_allowed(None, &K::Microphone));
    }
}
