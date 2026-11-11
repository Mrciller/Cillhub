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
        Self::load_from(&Self::settings_file_path())
    }

    /// Reads the file; a plaintext token from an older version moves to the keyring, or the
    /// file is at least rewritten with tight permissions.
    pub fn load_from(path: &Path) -> Self {
        let mut s: Self = fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        if let Some(token) = s.saved_token.clone() {
            if keyring_entry().is_some_and(|k| k.set_password(&token).is_ok()) {
                s.saved_token = None;
            }
            if let Err(e) = s.save_to(path) {
                eprintln!("cillhub: could not rewrite settings: {e}");
            }
        }
        s
    }

    pub fn save(&self) -> std::io::Result<()> {
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
        keyring_entry()
            .and_then(|k| k.get_password().ok())
            .or_else(|| self.saved_token.clone())
    }

    /// Stores (Some) or forgets (None) the session token and saves the settings.
    pub fn set_token(&mut self, token: Option<&str>) -> std::io::Result<()> {
        let keyring = keyring_entry();
        self.saved_token = match (token, &keyring) {
            (Some(t), Some(k)) if k.set_password(t).is_ok() => None,
            (Some(t), _) => {
                // Keyring failed: drop any older keyring copy so token() does not return it.
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
        };
        self.save()
    }
}

/// None in tests (they must not touch the developer's keyring) and when no keyring backend exists.
fn keyring_entry() -> Option<keyring::Entry> {
    if cfg!(test) {
        return None;
    }
    keyring::Entry::new("Cillhub", "session-token").ok()
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
