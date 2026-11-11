//! settings.json in the app's config dir: tray behaviour, activity sharing, added games,
//! window bounds, audio DSP config, and saved session. Written atomically.

use crate::audio::AudioConfig;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::env;
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

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
    #[serde(default = "yes")]
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
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
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
            open_on_startup: true,
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
            extra: HashMap::new(),
        }
    }
}

impl AppSettings {
    pub fn settings_file_path() -> PathBuf {
        default_config_dir().join("settings.json")
    }

    pub fn load() -> Self {
        let path = Self::settings_file_path();
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn save(&self) -> std::io::Result<()> {
        let path = Self::settings_file_path();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let json = serde_json::to_string_pretty(self).unwrap_or_default();
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, json)?;
        fs::rename(&tmp, &path)
    }
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

#[derive(Clone)]
pub struct SettingsManager {
    path: PathBuf,
    current: Arc<Mutex<AppSettings>>,
}

impl SettingsManager {
    pub fn new(path: PathBuf) -> Self {
        let loaded = fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        Self {
            path,
            current: Arc::new(Mutex::new(loaded)),
        }
    }

    pub fn get(&self) -> AppSettings {
        self.current.lock().unwrap().clone()
    }

    pub fn update(&self, f: impl FnOnce(&mut AppSettings)) {
        let mut lock = self.current.lock().unwrap();
        f(&mut lock);
        let json = serde_json::to_string_pretty(&*lock).unwrap_or_default();
        drop(lock);
        let tmp = self.path.with_extension("json.tmp");
        let _ = self.path.parent().map(fs::create_dir_all);
        let _ = fs::write(&tmp, json).and_then(|_| fs::rename(&tmp, &self.path));
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
    fn persists() {
        let dir = std::env::temp_dir().join(format!("cillhub-settings-{}", std::process::id()));
        let file = dir.join("settings.json");
        let mgr = SettingsManager::new(file.clone());
        assert!(mgr.get().close_to_tray);
        mgr.update(|s| {
            s.close_to_tray = false;
            s.custom_games.push(CustomGame {
                exe: "factorio.exe".into(),
                name: "Factorio".into(),
            });
        });
        let again = SettingsManager::new(file).get();
        assert!(!again.close_to_tray && again.share_activity);
        assert_eq!(again.custom_games[0].name, "Factorio");
        let _ = fs::remove_dir_all(dir);
    }
}
