//! Zero-process game activity scanner using sysinfo

use crate::settings::CustomGame;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

pub const GAMES: &[(&str, &[&str])] = &[
    ("Counter-Strike 2", &["cs2.exe"]),
    ("VALORANT", &["VALORANT-Win64-Shipping.exe"]),
    ("League of Legends", &["League of Legends.exe", "LeagueClientUx.exe", "LeagueClient.exe"]),
    ("Dota 2", &["dota2.exe"]),
    ("Rocket League", &["RocketLeague.exe"]),
    (
        "Fortnite",
        &[
            "FortniteClient-Win64-Shipping.exe",
            "FortniteClient-Win64-Shipping_EAC_EOS.exe",
        ],
    ),
    ("Apex Legends", &["r5apex.exe", "r5apex_dx12.exe"]),
    ("Overwatch 2", &["Overwatch.exe"]),
    ("Minecraft", &["Minecraft.Windows.exe"]),
    ("Grand Theft Auto V", &["GTA5.exe", "GTA5_Enhanced.exe"]),
    (
        "Tom Clancy's Rainbow Six Siege",
        &["RainbowSix.exe", "RainbowSix_Vulkan.exe"],
    ),
    ("PUBG: BATTLEGROUNDS", &["TslGame.exe"]),
    ("Deadlock", &["deadlock.exe", "project8.exe"]),
    ("Marvel Rivals", &["Marvel-Win64-Shipping.exe"]),
];

pub fn normalize_key(exe: &str) -> String {
    let lower = exe.trim().to_lowercase();
    if let Some(stripped) = lower.strip_suffix(".exe") {
        stripped.to_string()
    } else {
        lower
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameActivity {
    pub name: String,
    pub start: u64,
}

#[derive(Debug, Clone)]
pub struct ProcessInfo {
    pub names: Vec<String>,
    pub cmdline: String,
}

pub fn detect_game(
    procs: &[ProcessInfo],
    custom: &[CustomGame],
    current: Option<&str>,
) -> Option<String> {
    let mut table: HashMap<String, String> = HashMap::new();
    for (name, exes) in GAMES {
        for exe in *exes {
            table.insert(normalize_key(exe), name.to_string());
        }
    }
    for g in custom {
        table.insert(normalize_key(&g.exe), g.name.clone());
    }

    let java_keys: HashSet<&str> = ["java", "javaw"].iter().copied().collect();

    let mut found = Vec::new();
    for p in procs {
        for n in &p.names {
            let k = normalize_key(n);
            if let Some(matched) = table.get(&k) {
                found.push(matched.clone());
            } else if java_keys.contains(k.as_str())
                && p.cmdline.to_lowercase().contains("minecraft")
            {
                found.push("Minecraft".to_string());
            }
        }
    }

    if let Some(cur) = current {
        if found.iter().any(|g| g == cur) {
            return Some(cur.to_string());
        }
    }

    found.into_iter().next()
}

pub fn scan_system_processes(sys: &mut System) -> Vec<ProcessInfo> {
    sys.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing().with_cmd(UpdateKind::OnlyIfNotSet),
    );

    let mut list = Vec::new();
    for (_pid, proc) in sys.processes() {
        let name = proc.name().to_string_lossy().to_string();
        let mut names = vec![name];
        if let Some(exe_path) = proc.exe() {
            if let Some(file_name) = exe_path.file_name() {
                let s = file_name.to_string_lossy().to_string();
                if !names.contains(&s) {
                    names.push(s);
                }
            }
        }

        let cmdline = proc
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy())
            .collect::<Vec<_>>()
            .join(" ");

        list.push(ProcessInfo { names, cmdline });
    }
    list
}

pub struct GameTracker {
    sys: System,
    current: Option<GameActivity>,
    last_procs: Vec<ProcessInfo>,
}

impl Default for GameTracker {
    fn default() -> Self {
        Self::new()
    }
}

impl GameTracker {
    pub fn new() -> Self {
        // sysinfo keeps every /proc/N[/task/N]/stat open between refreshes (thousands of fds);
        // 0 makes it reopen them per scan instead.
        sysinfo::set_open_files_limit(0);
        Self {
            sys: System::new(),
            current: None,
            last_procs: Vec::new(),
        }
    }

    pub fn current(&self) -> Option<&GameActivity> {
        self.current.as_ref()
    }

    pub fn last_processes(&self) -> &[ProcessInfo] {
        &self.last_procs
    }

    pub fn reset(&mut self) {
        self.current = None;
    }

    pub fn poll(&mut self, custom: &[CustomGame]) -> Option<GameActivity> {
        self.scan(custom)
    }

    pub fn scan(&mut self, custom: &[CustomGame]) -> Option<GameActivity> {
        let procs = scan_system_processes(&mut self.sys);
        let cur_name = self.current.as_ref().map(|c| c.name.as_str());
        let detected = detect_game(&procs, custom, cur_name);
        self.last_procs = procs;

        match (self.current.as_ref(), detected) {
            (Some(cur), Some(new_name)) if cur.name == new_name => self.current.clone(),
            (_, Some(new_name)) => {
                let now = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64;
                let act = GameActivity {
                    name: new_name,
                    start: now,
                };
                self.current = Some(act.clone());
                Some(act)
            }
            (_, None) => {
                self.current = None;
                None
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "linux")]
    #[test]
    fn scanning_keeps_no_proc_files_open() {
        let proc_stat_fds = || {
            std::fs::read_dir("/proc/self/fd")
                .unwrap()
                .filter_map(|e| std::fs::read_link(e.ok()?.path()).ok())
                .filter(|p| p.starts_with("/proc") && p.ends_with("stat"))
                .count()
        };
        let mut tracker = GameTracker::new();
        for _ in 0..3 {
            tracker.scan(&[]);
        }
        assert!(!tracker.last_processes().is_empty());
        assert_eq!(proc_stat_fds(), 0);
    }

    #[test]
    fn test_normalize_key() {
        assert_eq!(normalize_key("cs2.exe"), "cs2");
        assert_eq!(normalize_key("CS2.EXE"), "cs2");
        assert_eq!(normalize_key("dota2"), "dota2");
    }

    #[test]
    fn test_detect_builtin() {
        let procs = vec![
            ProcessInfo {
                names: vec!["cs2.exe".into()],
                cmdline: "".into(),
            },
            ProcessInfo {
                names: vec!["chrome.exe".into()],
                cmdline: "".into(),
            },
        ];
        let detected = detect_game(&procs, &[], None);
        assert_eq!(detected, Some("Counter-Strike 2".into()));
    }

    #[test]
    fn test_detect_minecraft_java() {
        let procs = vec![ProcessInfo {
            names: vec!["javaw.exe".into()],
            cmdline: "-Xmx4G -Dminecraft.launcher=true net.minecraft.client.main.Main".into(),
        }];
        let detected = detect_game(&procs, &[], None);
        assert_eq!(detected, Some("Minecraft".into()));
    }

    #[test]
    fn test_detect_custom_override() {
        let custom = vec![CustomGame {
            exe: "mygame.exe".into(),
            name: "My Awesome Game".into(),
        }];
        let procs = vec![ProcessInfo {
            names: vec!["mygame.exe".into()],
            cmdline: "".into(),
        }];
        let detected = detect_game(&procs, &custom, None);
        assert_eq!(detected, Some("My Awesome Game".into()));
    }
}
