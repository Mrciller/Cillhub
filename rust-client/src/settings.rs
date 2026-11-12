//! settings.json in the app's config dir: tray behaviour, activity sharing, added games,
//! window bounds, audio DSP config. The session token lives in the OS keyring; only when
//! that is unavailable it is kept here, in a 0600 file inside a 0700 dir (Unix).
//! Written atomically.

use crate::audio::AudioConfig;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CustomGame {
    pub exe: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WindowBounds {
    pub x: Option<i32>,
    pub y: Option<i32>,
    pub width: u32,
    pub height: u32,
    #[serde(default)]
    pub is_maximized: bool,
}

impl Default for WindowBounds {
    fn default() -> Self {
        Self {
            x: None,
            y: None,
            width: 1280,
            height: 800,
            is_maximized: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default)]
    pub bounds: WindowBounds,
    #[serde(default = "default_hub")]
    pub hub_url: String,
    #[serde(default = "yes")]
    pub close_to_tray: bool,
    #[serde(default = "yes")]
    pub share_activity: bool,
    #[serde(default)]
    pub open_on_startup: bool,
    #[serde(default)]
    pub custom_games: Vec<CustomGame>,
    #[serde(default)]
    pub saved_token: Option<String>,
    #[serde(default = "default_target")]
    pub server_target: String,
    #[serde(default)]
    pub custom_node_url: String,
    /// Settings › Private Nodes (sanitized on load).
    #[serde(default)]
    pub private_nodes: Vec<crate::nodes::SavedNode>,
    /// Node tokens by node_key, only where the keyring failed (like saved_token); they win over the keyring.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub node_tokens: HashMap<String, String>,
    /// node_keys whose keyring entry could not be deleted: never loaded again.
    #[serde(default, skip_serializing_if = "std::collections::HashSet::is_empty")]
    pub node_tombstones: std::collections::HashSet<String>,
    /// Sign-outs on nodes not confirmed yet, by node_key: the token sits in the keyring entry `node-revoke:<key>`,
    /// or here when the keyring failed. Retried at every start until the node confirms.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub pending_revokes: HashMap<String, Option<String>>,
    #[serde(default)]
    pub audio_config: AudioConfig,
    #[serde(default)]
    pub drafts: HashMap<String, String>,
    #[serde(default = "yes")]
    pub show_members: bool,
    #[serde(default = "default_scale")]
    pub font_scale: f32,
    #[serde(default)]
    pub reduced_motion: bool,
    #[serde(default)]
    pub high_contrast: bool,
    #[serde(default)]
    pub dyslexic_font: bool,
    /// Theme and language as the web client names them ("dark", "en-US", ...).
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_locale")]
    pub locale: String,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

/// Themes the hub stores in the user's settings (server/src/userdata.js); others stay local.
pub const SERVER_THEMES: [&str; 4] = ["dark", "light", "ash", "onyx"];

fn default_theme() -> String {
    "dark".to_string()
}

fn default_locale() -> String {
    "en-US".to_string()
}

fn yes() -> bool {
    true
}

fn default_hub() -> String {
    crate::config::PROD_HUB.to_string()
}

fn default_target() -> String {
    "hub".to_string()
}

fn default_scale() -> f32 {
    1.0
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            bounds: WindowBounds::default(),
            hub_url: default_hub(),
            close_to_tray: true,
            share_activity: true,
            open_on_startup: false,
            custom_games: Vec::new(),
            saved_token: None,
            server_target: default_target(),
            custom_node_url: String::new(),
            private_nodes: Vec::new(),
            node_tokens: HashMap::new(),
            node_tombstones: Default::default(),
            pending_revokes: HashMap::new(),
            audio_config: AudioConfig::default(),
            drafts: HashMap::new(),
            show_members: true,
            font_scale: 1.0,
            reduced_motion: false,
            high_contrast: false,
            dyslexic_font: false,
            theme: default_theme(),
            locale: default_locale(),
            extra: HashMap::new(),
        }
    }
}

impl AppSettings {
    pub fn settings_file_path() -> PathBuf {
        default_config_dir().join("settings.json")
    }

    pub fn load() -> Self {
        if cfg!(test) {
            return Self::default(); // tests never read or write the developer's settings
        }
        Self::load_from(&Self::settings_file_path())
    }

    /// Reads the file; a plaintext token from an older version moves to the keyring, or the
    /// file is at least rewritten with tight permissions.
    pub fn load_from(path: &Path) -> Self {
        let mut s: Self = fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        s.private_nodes = crate::nodes::sanitize(std::mem::take(&mut s.private_nodes));
        if let Some(token) = s.saved_token.clone() {
            if keyring_entry(SESSION).is_some_and(|k| k.set_password(&token).is_ok()) {
                s.saved_token = None;
            }
            if let Err(e) = s.save_to(path) {
                eprintln!("cillhub: could not rewrite settings: {e}");
            }
        }
        s
    }

    pub fn save(&self) -> std::io::Result<()> {
        #[cfg(test)]
        if FAIL_SAVE.with(|f| f.get()) {
            return Err(std::io::Error::other("disk full (test)"));
        }
        if cfg!(test) {
            return Ok(());
        }
        self.save_to(&Self::settings_file_path())
    }

    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
            }
        }
        let json = serde_json::to_string_pretty(self).unwrap_or_default();
        let tmp = path.with_extension("json.tmp");
        // A fresh file, so the mode applies from the first byte.
        match fs::remove_file(&tmp) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
            _ => {}
        }
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        std::io::Write::write_all(&mut opts.open(&tmp)?, json.as_bytes())?;
        fs::rename(&tmp, path)
    }

    /// Takes theme and language from the user's server-side settings, like the web client.
    /// A local-only theme stays. Returns true when something changed.
    pub fn adopt_server_appearance(&mut self, server: &crate::model::UserSettings) -> bool {
        let before = (self.theme.clone(), self.locale.clone());
        if let Some(t) = server.theme.as_deref() {
            if SERVER_THEMES.contains(&self.theme.as_str()) && SERVER_THEMES.contains(&t) {
                self.theme = t.to_string();
            }
        }
        if let Some(l) = server.locale.as_deref().filter(|l| !l.is_empty()) {
            self.locale = l.to_string();
        }
        before != (self.theme.clone(), self.locale.clone())
    }

    /// The saved session token: keyring first, then the settings file fallback.
    pub fn token(&self) -> Option<String> {
        keyring_entry(SESSION)
            .and_then(|k| k.get_password().ok())
            .or_else(|| self.saved_token.clone())
    }

    /// Stores (Some) or forgets (None) the session token and saves the settings.
    pub fn set_token(&mut self, token: Option<&str>) -> std::io::Result<()> {
        self.saved_token = keep(SESSION, token);
        self.save()
    }

    /// A private node's token for this hub account (node_key): the file fallback first (it is newer when the
    /// keyring failed), then the keyring unless its entry is tombstoned.
    pub fn node_token(&self, key: &str) -> Option<String> {
        self.node_tokens.get(key).cloned().or_else(|| {
            if self.node_tombstones.contains(key) {
                return None;
            }
            keyring_entry(&format!("node-token:{key}")).and_then(|k| k.get_password().ok())
        })
    }

    /// node_token, telling "none stored" from "could not be read" (Err: a locked or failing keyring).
    pub fn node_token_checked(&self, key: &str) -> Result<Option<String>, keyring::Error> {
        if let Some(t) = self.node_tokens.get(key) {
            return Ok(Some(t.clone()));
        }
        if self.node_tombstones.contains(key) {
            return Ok(None);
        }
        match keyring_entry(&format!("node-token:{key}")).map(|k| k.get_password()) {
            None | Some(Err(keyring::Error::NoEntry)) => Ok(None), // no keyring here, or nothing in it
            Some(Ok(t)) => Ok(Some(t)),
            Some(Err(e)) => Err(e),
        }
    }

    /// Last resort when the journal cannot be saved: the token goes into one fixed keyring entry that the next
    /// start reads (`take_revoke_stash`). False when the keyring cannot take it either.
    pub fn stash_revoke(origin: &str, token: &str) -> bool {
        let Some(k) = keyring_entry(STASH) else { return false };
        // only an absent stash is empty: one that cannot be read or parsed is never overwritten
        let mut list: Vec<(String, String)> = match k.get_password() {
            Err(keyring::Error::NoEntry) => Vec::new(),
            Ok(s) => match serde_json::from_str(&s) {
                Ok(l) => l,
                Err(_) => return false,
            },
            Err(_) => return false,
        };
        list.push((origin.to_string(), token.to_string()));
        serde_json::to_string(&list).is_ok_and(|s| k.set_password(&s).is_ok())
    }

    /// The stashed sign-outs, moved into the journal; what cannot be journaled stays stashed.
    pub fn take_revoke_stash(&mut self) {
        let Some(k) = keyring_entry(STASH) else { return };
        let Some(list) = k.get_password().ok().and_then(|s| serde_json::from_str::<Vec<(String, String)>>(&s).ok()) else { return };
        let left: Vec<(String, String)> = list.into_iter().filter(|(o, t)| self.add_pending_revoke(o, t).is_err()).collect();
        let _ = if left.is_empty() { k.delete_credential() } else { serde_json::to_string(&left).map_or(Ok(()), |s| k.set_password(&s)) };
    }

    pub fn set_node_token(&mut self, key: &str, token: Option<&str>) -> std::io::Result<()> {
        let entry = keyring_entry(&format!("node-token:{key}"));
        self.node_tokens.remove(key);
        match token {
            Some(t) if entry.as_ref().is_some_and(|k| k.set_password(t).is_ok()) => {
                self.node_tombstones.remove(key); // replaced: the entry holds the new token
            }
            Some(t) => {
                self.node_tokens.insert(key.to_string(), t.to_string());
            }
            None => {
                // tombstone first (saved), lifted only when the keyring confirms the entry is gone
                self.node_tombstones.insert(key.to_string());
                self.save()?;
                if entry.is_some_and(|k| matches!(k.delete_credential(), Ok(()) | Err(keyring::Error::NoEntry))) {
                    self.node_tombstones.remove(key);
                }
            }
        }
        self.save()
    }

    /// Remembers a sign-out to confirm on the node (see pending_revokes); returns its key "<id>|<node origin>".
    /// The journal entry is saved first (its id names the keyring entry), then the token goes to the keyring (or,
    /// if that fails, into the entry). A keyring entry therefore always has a saved journal entry that finds it;
    /// an entry whose token is gone is cleaned up by `prune_pending_revokes`. Err: nothing durable, keep the credential.
    pub fn add_pending_revoke(&mut self, origin: &str, token: &str) -> std::io::Result<String> {
        let id = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_nanos());
        let key = format!("{id}-{}|{origin}", self.pending_revokes.len());
        self.pending_revokes.insert(key.clone(), Some(token.to_string())); // in the file until the keyring has it
        if let Err(e) = self.save() {
            self.pending_revokes.remove(&key);
            return Err(e);
        }
        if keyring_entry(&format!("node-revoke:{key}")).is_some_and(|k| k.set_password(token).is_ok()) {
            self.pending_revokes.insert(key.clone(), None);
            let _ = self.save(); // if this fails, the file still holds the token: still durable
        }
        Ok(key)
    }

    /// Journal entries whose keyring entry is confirmed gone cannot be signed out: dropped. Any other keyring
    /// error (locked, no backend right now) keeps the entry for a later try.
    pub fn prune_pending_revokes(&mut self) {
        let before = self.pending_revokes.len();
        self.pending_revokes.retain(|k, fallback| {
            fallback.is_some()
                || !keyring_entry(&format!("node-revoke:{k}")).is_some_and(|e| matches!(e.get_password(), Err(keyring::Error::NoEntry)))
        });
        if self.pending_revokes.len() != before {
            let _ = self.save();
        }
    }

    /// (key, node origin, token) of every sign-out not confirmed yet.
    pub fn pending_revoke_list(&self) -> Vec<(String, String, String)> {
        self.pending_revokes.iter().filter_map(|(key, fallback)| {
            let token = fallback.clone().or_else(|| keyring_entry(&format!("node-revoke:{key}")).and_then(|k| k.get_password().ok()))?;
            Some((key.clone(), key.rsplit('|').next()?.to_string(), token))
        }).collect()
    }

    pub fn clear_pending_revoke(&mut self, key: &str) -> std::io::Result<()> {
        if let Some(k) = keyring_entry(&format!("node-revoke:{key}")) {
            let _ = k.delete_credential(); // only read through pending_revokes, which forgets the key now
        }
        self.pending_revokes.remove(key);
        self.save()
    }
}

/// The key of a node token: one per hub, hub account and node.
pub fn node_key(hub_origin: &str, hub_user: &str, node_origin: &str) -> String {
    format!("{hub_origin}|{hub_user}|{node_origin}")
}

const SESSION: &str = "session-token";
const STASH: &str = "node-revoke-stash";

#[cfg(test)]
thread_local! {
    /// Makes save() fail on this test thread (tests never write the real file).
    pub static FAIL_SAVE: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Puts `token` into the keyring entry `account` (or deletes it); returns what the settings file must keep instead.
fn keep(account: &str, token: Option<&str>) -> Option<String> {
    let keyring = keyring_entry(account);
    match (token, &keyring) {
        (Some(t), Some(k)) if k.set_password(t).is_ok() => None,
        (Some(t), _) => {
            // Keyring failed: drop any older keyring copy so the getter does not return it.
            if let Some(k) = &keyring {
                let _ = k.delete_credential();
            }
            Some(t.to_string())
        }
        (None, k) => {
            if let Some(k) = k {
                let _ = k.delete_credential(); // NoEntry is fine
            }
            None
        }
    }
}

/// None in tests (they must not touch the developer's keyring) and when no keyring backend exists.
fn keyring_entry(account: &str) -> Option<keyring::Entry> {
    if cfg!(test) {
        return None;
    }
    keyring::Entry::new("Cillhub", account).ok()
}

pub fn default_config_dir() -> PathBuf {
    if let Ok(config_home) = env::var("XDG_CONFIG_HOME") {
        PathBuf::from(config_home).join("Cillhub")
    } else if let Ok(appdata) = env::var("APPDATA") {
        PathBuf::from(appdata).join("Cillhub")
    } else if let Ok(home) = env::var("HOME") {
        PathBuf::from(home).join(".config").join("Cillhub")
    } else {
        PathBuf::from(".").join("data")
    }
}

/// Manages OS autostart entry without Tauri plugins.
pub fn set_autostart(enabled: bool) -> std::io::Result<()> {
    let exe = env::current_exe()?;
    #[cfg(target_os = "linux")]
    {
        let autostart_dir = env::var("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .or_else(|_| env::var("HOME").map(|h| PathBuf::from(h).join(".config")))
            .unwrap_or_else(|_| PathBuf::from("/tmp"))
            .join("autostart");
        let desktop_file = autostart_dir.join("io.github.mrciller.cillhub.desktop");
        if enabled {
            fs::create_dir_all(&autostart_dir)?;
            let content = format!(
                "[Desktop Entry]\nType=Application\nName=Cillhub\nExec=\"{}\"\nTerminal=false\nX-GNOME-Autostart-enabled=true\n",
                exe.display()
            );
            fs::write(desktop_file, content)?;
        } else if desktop_file.exists() {
            let _ = fs::remove_file(desktop_file);
        }
    }
    #[cfg(target_os = "windows")]
    {
        let status = if enabled {
            std::process::Command::new("reg")
                .args([
                    "add",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v",
                    "Cillhub",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &format!("\"{}\"", exe.display()),
                    "/f",
                ])
                .status()
        } else {
            std::process::Command::new("reg")
                .args([
                    "delete",
                    r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run",
                    "/v",
                    "Cillhub",
                    "/f",
                ])
                .status()
        };
        let _ = status;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appearance_follows_the_server_unless_local_only() {
        let server = crate::model::UserSettings {
            theme: Some("light".into()),
            locale: Some("de".into()),
            ..Default::default()
        };
        let mut s = AppSettings::default();
        assert!(s.adopt_server_appearance(&server));
        assert_eq!((s.theme.as_str(), s.locale.as_str()), ("light", "de"));
        assert!(!s.adopt_server_appearance(&server));
        s.theme = "nord".into();
        s.adopt_server_appearance(&server);
        assert_eq!(s.theme, "nord");
        let json = serde_json::to_string(&s).unwrap();
        let back: AppSettings = serde_json::from_str(&json).unwrap();
        assert_eq!((back.theme.as_str(), back.locale.as_str()), ("nord", "de"));
    }

    #[test]
    fn node_tokens_and_pending_sign_outs() {
        let mut s = AppSettings::default();
        let key = node_key("https://hub.example.org", "1", "https://node.example.org");
        s.set_node_token(&key, Some("node-token")).unwrap();
        assert_eq!(s.node_token(&key).as_deref(), Some("node-token"));
        assert_eq!(s.node_token(&node_key("https://hub.example.org", "2", "https://node.example.org")), None, "another hub account");
        s.set_node_token(&key, None).unwrap();
        assert_eq!(s.node_token(&key), None);
        assert!(s.node_tombstones.contains(&key), "no keyring to confirm the delete: the entry stays tombstoned");
        s.set_node_token(&key, Some("newer")).unwrap();
        assert_eq!(s.node_token(&key).as_deref(), Some("newer"), "a replacement wins over the tombstone");
        let k = s.add_pending_revoke("https://node.example.org", "old-token").unwrap();
        let back: AppSettings = serde_json::from_str(&serde_json::to_string(&s).unwrap()).unwrap();
        assert_eq!(back.pending_revoke_list(), vec![(k.clone(), "https://node.example.org".to_string(), "old-token".to_string())]);
        s.clear_pending_revoke(&k).unwrap();
        assert!(s.pending_revoke_list().is_empty());
    }

    #[test]
    fn persists_with_private_modes() {
        let dir = std::env::temp_dir().join(format!("cillhub-settings-{}", std::process::id()));
        let file = dir.join("Cillhub").join("settings.json");
        let mut s = AppSettings::default();
        assert!(!s.open_on_startup, "autostart is opt-in");
        s.close_to_tray = false;
        s.saved_token = Some("dummy-token".into());
        s.save_to(&file).unwrap();
        // An older version left the file world-readable; loading tightens it again.
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
            let again = AppSettings::load_from(&file);
            assert_eq!(again.token().as_deref(), Some("dummy-token"));
            assert!(!again.close_to_tray && again.share_activity);
            let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode(&file), 0o600);
            assert_eq!(mode(file.parent().unwrap()), 0o700);
        }
        fs::remove_dir_all(dir).unwrap();
    }
}
