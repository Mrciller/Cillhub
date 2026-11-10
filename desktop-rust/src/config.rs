//! Addresses and the URL rules the shell applies (navigation guard, permissions, hub links).

use url::Url;

/// The hub the bundled client talks to: the maintainer's instance, or CILLCORD_HUB_URL at build time (a fork's own
/// hub; scripts/build-web.js builds the client for the same address).
pub const PROD_HUB: &str = match option_env!("CILLCORD_HUB_URL") {
    Some(h) => h,
    None => "https://cillhub.cillerian.org",
};
pub const APP_ID: &str = "io.github.mrciller.cillhub";
pub const DEEP_LINK_SCHEMES: &[&str] = &["cillhub", "cillcord"];
/// The update feed next to the installers (latest.yml / latest-linux.yml, electron-builder layout: the 2.2.x apps read
/// it too and take this app as their last update).
pub const FEED_PATH: &str = "/download/desktop/";
/// Where the bundled client lives: tauri://localhost on Linux, http://tauri.localhost on Windows.
pub const APP_ORIGIN: &str = if cfg!(windows) { "http://tauri.localhost" } else { "tauri://localhost" };

/// Pages of the web client. A hub link to one of them (invite, message link, OAuth consent, sign-in callback) opens in
/// the app; any other hub path (/download, /api, files) is not part of the bundle and opens in the browser.
const SPA_SECTIONS: &[&str] = &["", "channels", "invite", "template", "login", "register", "oauth2", "instances", "developers", "admin", "directory"];

pub fn is_app_url(u: &Url) -> bool {
    (u.scheme() == "tauri" && u.host_str() == Some("localhost")) || u.host_str() == Some("tauri.localhost")
}

pub fn is_http_url(u: &Url) -> bool {
    matches!(u.scheme(), "http" | "https")
}

/// https://<hub>/invite/abc → <app origin>/invite/abc; None when the URL is not a client page on the hub.
pub fn app_url_for(u: &Url) -> Option<Url> {
    let hub = Url::parse(PROD_HUB).ok()?;
    if u.origin() != hub.origin() || !SPA_SECTIONS.contains(&u.path().split('/').nth(1).unwrap_or("")) {
        return None;
    }
    let mut app = Url::parse(APP_ORIGIN).ok()?;
    app.set_path(u.path());
    app.set_query(u.query());
    app.set_fragment(u.fragment());
    Some(app)
}

/// Main window: app pages load, hub client pages are redirected into the app, other http(s) pages load too (the node
/// sign-in flow hops node → hub consent → node → callback, which lands on a hub client page), the rest is refused.
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

/// Permissions the client needs (calls, screen share, notifications); only its own pages get them: a node's sign-in page
/// loaded in the same webview gets none.
pub fn permission_allowed(page: Option<&Url>, kind: &tauri::webview::PermissionKind) -> bool {
    use tauri::webview::PermissionKind as K;
    page.is_some_and(is_app_url) && matches!(kind, K::Microphone | K::Camera | K::Notifications | K::DisplayCapture)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::webview::PermissionKind as K;

    fn u(s: &str) -> Url {
        Url::parse(s).unwrap()
    }

    #[test]
    fn navigation_guard() {
        let app = u(&format!("{APP_ORIGIN}/channels/1"));
        assert!(matches!(navigation(&app), Nav::Allow));
        assert!(matches!(navigation(&u("about:blank")), Nav::Allow));
        // hub client pages go into the app, with query and fragment (the sign-in callback carries the token there)
        match navigation(&u(&format!("{PROD_HUB}/instances/callback?x=1#token=t&state=s"))) {
            Nav::Redirect(r) => assert_eq!(r.as_str(), format!("{APP_ORIGIN}/instances/callback?x=1#token=t&state=s")),
            _ => panic!("hub client page not redirected"),
        }
        assert!(matches!(navigation(&u(&format!("{PROD_HUB}/invite/abc"))), Nav::Redirect(_)));
        // other hub paths and other sites: plain http(s) navigation (node sign-in hops)
        assert!(matches!(navigation(&u(&format!("{PROD_HUB}/api/v9/users/@me"))), Nav::Allow));
        assert!(matches!(navigation(&u("https://node.example/api/v9/federation/hub-login")), Nav::Allow));
        // anything else is refused
        assert!(matches!(navigation(&u("file:///etc/passwd")), Nav::Deny));
        assert!(matches!(navigation(&u("javascript:alert(1)")), Nav::Deny));
        assert!(matches!(navigation(&u("tauri://evil/")), Nav::Deny));
        // a look-alike host is just another http site: no app rights
        assert!(!is_app_url(&u("http://tauri.localhost.evil.com/")) && !is_app_url(&u("tauri://localhost.evil.com/")));
    }

    #[test]
    fn permissions() {
        let app = u(&format!("{APP_ORIGIN}/"));
        let hub = u(&format!("{PROD_HUB}/"));
        for k in [K::Microphone, K::Camera, K::Notifications, K::DisplayCapture] {
            assert!(permission_allowed(Some(&app), &k));
            assert!(!permission_allowed(Some(&hub), &k), "hub page got {k:?}");
        }
        assert!(!permission_allowed(Some(&app), &K::Geolocation));
        assert!(!permission_allowed(Some(&app), &K::ClipboardRead));
        assert!(!permission_allowed(None, &K::Microphone));
    }
}
