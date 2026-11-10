//! settings.json in the app's config dir: tray behaviour, activity sharing, added games (window bounds are kept by the
//! window-state plugin). Written atomically.

use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct CustomGame {
    pub exe: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    #[serde(default = "yes")]
    pub close_to_tray: bool,
    #[serde(default = "yes")]
    pub share_activity: bool,
    #[serde(default)]
    pub custom_games: Vec<CustomGame>,
}

fn yes() -> bool {
    true
}

impl Default for AppSettings {
    fn default() -> Self {
        Self { close_to_tray: true, share_activity: true, custom_games: Vec::new() }
    }
}

#[derive(Clone)]
pub struct SettingsManager {
    path: PathBuf,
    current: Arc<Mutex<AppSettings>>,
}

impl SettingsManager {
    pub fn new(path: PathBuf) -> Self {
        let loaded = fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        Self { path, current: Arc::new(Mutex::new(loaded)) }
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
        // non-fatal: the settings just won't persist
        let _ = self.path.parent().map(fs::create_dir_all);
        let _ = fs::write(&tmp, json).and_then(|_| fs::rename(&tmp, &self.path));
    }
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
            s.custom_games.push(CustomGame { exe: "factorio.exe".into(), name: "Factorio".into() });
        });
        let again = SettingsManager::new(file).get();
        assert!(!again.close_to_tray && again.share_activity);
        assert_eq!(again.custom_games[0].name, "Factorio");
        let _ = fs::remove_dir_all(dir);
    }
}
