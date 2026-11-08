//! Cillhub desktop configuration & constants

pub const PROD_HUB: &str = "https://cillhub.cillerian.org";
pub const APP_ORIGIN: &str = "app://cillhub";
pub const APP_ID: &str = "io.github.mrciller.cillhub";
pub const DEEP_LINK_SCHEMES: &[&str] = &["cillhub", "cillcord"];

/// Check if a URL belongs to the app origin
pub fn is_app_url(url: &str) -> bool {
    url == APP_ORIGIN || url.starts_with(&format!("{}/", APP_ORIGIN))
}

/// Convert a hub URL into an app URL if it targets the hub
pub fn app_url_for(url: &str, hub_base: &str) -> Option<String> {
    if is_app_url(url) {
        return Some(url.to_string());
    }
    let hub_clean = hub_base.trim_end_matches('/');
    if url.starts_with(hub_clean) {
        let path = &url[hub_clean.len()..];
        if path.is_empty() || path.starts_with('/') {
            return Some(format!("{}{}", APP_ORIGIN, path));
        }
    }
    None
}
