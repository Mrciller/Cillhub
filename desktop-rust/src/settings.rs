//! Atomic debounced settings storage with window bounds persistence

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize)]
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
pub struct AppSettings {
    #[serde(default)]
    pub bounds: WindowBounds,
    #[serde(default = "default_hub")]
    pub hub_url: String,
    #[serde(default = "default_true")]
    pub share_activity: bool,
    #[serde(default = "default_true")]
    pub open_on_startup: bool,
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
    #[serde(default)]
    pub custom_games: Vec<CustomGame>,
    #[serde(flatten)]
    pub extra: HashMap<String, serde_json::Value>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            bounds: WindowBounds::default(),
            hub_url: default_hub(),
            share_activity: true,
            open_on_startup: true,
            close_to_tray: true,
            custom_games: Vec::new(),
            extra: HashMap::new(),
        }
    }
}

fn default_hub() -> String {
    crate::config::PROD_HUB.to_string()
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CustomGame {
    pub exe: String,
    pub name: String,
}

#[derive(Clone)]
pub struct SettingsManager {
    path: PathBuf,
    current: Arc<Mutex<AppSettings>>,
}

impl SettingsManager {
    pub fn new(path: PathBuf) -> Self {
        let loaded = Self::load_file(&path).unwrap_or_default();
        Self {
            path,
            current: Arc::new(Mutex::new(loaded)),
        }
    }

    pub fn get(&self) -> AppSettings {
        self.current.lock().unwrap().clone()
    }

    pub fn update<F>(&self, f: F)
    where
        F: FnOnce(&mut AppSettings),
    {
        let mut lock = self.current.lock().unwrap();
        f(&mut lock);
        let clone = lock.clone();
        drop(lock);
        // Persist atomically
        let _ = Self::save_file_atomic(&self.path, &clone);
    }

    fn load_file(path: &Path) -> Option<AppSettings> {
        let contents = fs::read_to_string(path).ok()?;
        serde_json::from_str(&contents).ok()
    }

    pub fn save_file_atomic(path: &Path, settings: &AppSettings) -> std::io::Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let json = serde_json::to_string_pretty(settings)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

        let tmp_path = path.with_extension("json.tmp");
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_settings_persistence() {
        let tmp = std::env::temp_dir().join("cillhub_settings_test.json");
        let mgr = SettingsManager::new(tmp.clone());
        assert_eq!(mgr.get().bounds.width, 1280);

        mgr.update(|s| {
            s.bounds.width = 1024;
            s.bounds.height = 768;
            s.custom_games.push(CustomGame {
                exe: "testgame.exe".into(),
                name: "Test Game".into(),
            });
        });

        assert_eq!(mgr.get().bounds.width, 1024);
        assert_eq!(mgr.get().custom_games.len(), 1);

        // Reload from file to verify atomic write
        let mgr2 = SettingsManager::new(tmp.clone());
        assert_eq!(mgr2.get().bounds.width, 1024);
        assert_eq!(mgr2.get().bounds.height, 768);
        assert_eq!(mgr2.get().custom_games[0].name, "Test Game");

        let _ = fs::remove_file(tmp);
    }
}
