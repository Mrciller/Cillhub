#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Cillhub Native Desktop Client & Real-Time Voice Engine

use cillhub_core::audio::{AudioConfig, AudioPipeline};
use cillhub_core::config::APP_ID;
use cillhub_core::games::GameTracker;
use cillhub_core::settings::SettingsManager;
use std::env;
use std::path::PathBuf;
use std::time::Instant;

fn get_config_dir() -> PathBuf {
    if let Ok(config_home) = env::var("XDG_CONFIG_HOME") {
        PathBuf::from(config_home).join("Cillhub")
    } else if let Ok(home) = env::var("HOME") {
        PathBuf::from(home).join(".config").join("Cillhub")
    } else if let Ok(appdata) = env::var("APPDATA") {
        PathBuf::from(appdata).join("Cillhub")
    } else {
        PathBuf::from(".").join("data")
    }
}

fn main() {
    let args: Vec<String> = env::args().collect();

    if args.iter().any(|a| a == "--version" || a == "-v") {
        println!("Cillhub Desktop 2.2.1 (Rust native core, id: {})", APP_ID);
        return;
    }

    if args.iter().any(|a| a == "--test-audio") {
        println!("Benchmarking Cillhub Real-Time Audio DSP Pipeline (48 kHz)...");
        let config = AudioConfig::default();
        let mut pipeline = AudioPipeline::new(48000, &config);

        // Benchmark 10,000 frames of 480 samples (100 seconds of 48 kHz audio)
        let mut frame = vec![0.02f32; 480];
        let start = Instant::now();
        let iterations = 10_000;
        for _ in 0..iterations {
            let _ = pipeline.process_frame(&mut frame);
        }
        let elapsed = start.elapsed();
        let per_frame_us = elapsed.as_micros() as f64 / iterations as f64;
        let realtime_factor = (iterations as f64 * 0.010) / elapsed.as_secs_f64();

        println!("Processed {} frames (10 ms each) in {:?}", iterations, elapsed);
        println!("Latency per 10 ms frame: {:.2} µs (budget: 10,000 µs)", per_frame_us);
        println!("Realtime throughput: {:.1}x real-time", realtime_factor);
        assert!(per_frame_us < 1000.0, "Audio processing must stay well under 1 ms per frame");
        println!("Audio DSP benchmark passed!");
        return;
    }

    if args.iter().any(|a| a == "--scan-games") {
        println!("Scanning running processes via sysinfo (zero child processes)...");
        let start = Instant::now();
        let mut tracker = GameTracker::new();
        let game = tracker.scan(&[]);
        let elapsed = start.elapsed();
        println!("Scan completed in {:?}", elapsed);
        match game {
            Some(g) => println!("Detected active game: {} (started: {})", g.name, g.start),
            None => println!("No active game detected."),
        }
        return;
    }

    if args.iter().any(|a| a == "--scan-league") {
        println!("Checking local League Client Update (LCU) status...");
        let mut sys = sysinfo::System::new();
        let procs = cillhub_core::games::scan_system_processes(&mut sys);
        match cillhub_core::league::find_lockfile_path(&procs) {
            Some(path) => {
                println!("Found lockfile at: {}", path.display());
                if let Some(creds) = cillhub_core::league::read_lockfile(&path) {
                    println!("Lockfile credentials: port {}, protocol {}", creds.port, creds.protocol);
                    if let Ok(client) = cillhub_core::league::LeagueClient::new() {
                        match client.fetch_lobby(&creds) {
                            Ok(Some(lobby)) => println!("Active Lobby: {} (queue: {}, members: {}/{})", lobby.queue_name, lobby.queue_id, lobby.member_count, lobby.max_party_size),
                            Ok(None) => println!("League client is running but no active lobby."),
                            Err(e) => println!("Error querying lobby: {}", e),
                        }
                    }
                }
            }
            None => println!("League client lockfile not found (game client not running)."),
        }
        return;
    }

    let config_dir = get_config_dir();
    let settings_file = config_dir.join("settings.json");
    let settings = SettingsManager::new(settings_file);
    let current_settings = settings.get();

    println!("Starting Cillhub Native Desktop Client (Rust core)...");
    println!("  Hub URL: {}", current_settings.hub_url);
    println!("  Window bounds: {}x{} (resizable: true)", current_settings.bounds.width, current_settings.bounds.height);
    println!("  Share game activity: {}", current_settings.share_activity);

    #[cfg(feature = "gui")]
    {
        run_tauri_gui(settings);
    }

    #[cfg(not(feature = "gui"))]
    {
        println!("Native Rust audio DSP & game scanner daemon running. Press Ctrl+C to exit.");
        let mut tracker = GameTracker::new();
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(15));
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
            loop {
                interval.tick().await;
                if settings.get().share_activity {
                    if let Some(act) = tracker.scan(&settings.get().custom_games) {
                        println!("Game status: {}", act.name);
                    }
                }
            }
        });
    }
}

#[cfg(feature = "gui")]
fn run_tauri_gui(settings: SettingsManager) {
    let settings_clone = settings.clone();
    std::thread::spawn(move || {
        let mut tracker = GameTracker::new();
        loop {
            std::thread::sleep(std::time::Duration::from_secs(15));
            if settings_clone.get().share_activity {
                if let Some(act) = tracker.scan(&settings_clone.get().custom_games) {
                    println!("Game status: {}", act.name);
                }
            }
        }
    });

    let hub = url::Url::parse(&settings.get().hub_url).ok();
    let context = tauri::generate_context!();
    let res = tauri::Builder::default()
        // Only the bundled app (tauri://localhost, or http(s)://tauri.localhost on Windows) and the configured hub get
        // the permissions the client needs; any other page and any other permission is denied.
        .on_permission_request(move |webview, kind| {
            use tauri::webview::{PermissionKind as K, PermissionResponse as R};
            let trusted = webview.url().map_or(false, |u| {
                (u.scheme() == "tauri" && u.host_str() == Some("localhost"))
                    || u.host_str() == Some("tauri.localhost")
                    || hub.as_ref().map_or(false, |h| h.origin() == u.origin())
            });
            let needed = matches!(kind, K::Microphone | K::Camera | K::Notifications | K::DisplayCapture | K::ClipboardRead);
            if trusted && needed { R::Allow } else { R::Deny }
        })
        .setup(|_app| {
            println!("Tauri main window created with resizable: true");
            Ok(())
        })
        .run(context);

    if let Err(e) = res {
        eprintln!("Tauri GUI error: {}", e);
        #[cfg(target_os = "windows")]
        {
            let msg = format!("Cillhub Desktop could not open the native window:\n\n{}\n\nPlease ensure Microsoft Edge WebView2 runtime is installed.", e);
            let _ = std::process::Command::new("powershell")
                .args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &format!("[System.Windows.Forms.MessageBox]::Show('{}', 'Cillhub Desktop')", msg.replace("'", "''"))])
                .status();
        }
    }
}
