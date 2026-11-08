//! End-to-end integration tests for Cillhub Native Desktop Client (Rust Core)

use cillhub_core::audio::{AudioConfig, AudioPipeline};
use cillhub_core::config::{APP_ID, APP_ORIGIN, PROD_HUB};
use cillhub_core::deeplink::{deep_link_path, parse_unread, UnreadState};
use cillhub_core::games::{detect_game, ProcessInfo};
use cillhub_core::league::{parse_lockfile, queue_name};
use cillhub_core::protocol::{sanitize_app_path, STRICT_CSP};
use cillhub_core::settings::{CustomGame, SettingsManager};
use std::fs;

#[test]
fn test_app_config_constants() {
    assert_eq!(APP_ID, "io.github.mrciller.cillhub");
    assert_eq!(APP_ORIGIN, "app://cillhub");
    assert_eq!(PROD_HUB, "https://cillhub.cillerian.org");
    assert!(STRICT_CSP.contains("default-src 'self' app: blob:;"));
}

#[test]
fn test_settings_atomic_save_and_reload() {
    let tmp_dir = std::env::temp_dir().join("cillhub_integ_settings");
    let _ = fs::create_dir_all(&tmp_dir);
    let settings_file = tmp_dir.join("settings.json");

    let mgr = SettingsManager::new(settings_file.clone());
    assert_eq!(mgr.get().bounds.width, 1280);
    assert_eq!(mgr.get().bounds.height, 800);
    assert!(mgr.get().share_activity);

    mgr.update(|s| {
        s.bounds.width = 1600;
        s.bounds.height = 900;
        s.bounds.is_maximized = true;
        s.share_activity = false;
        s.custom_games.push(CustomGame {
            exe: "factorio.exe".into(),
            name: "Factorio".into(),
        });
    });

    let reloaded = SettingsManager::new(settings_file.clone());
    let current = reloaded.get();
    assert_eq!(current.bounds.width, 1600);
    assert_eq!(current.bounds.height, 900);
    assert!(current.bounds.is_maximized);
    assert!(!current.share_activity);
    assert_eq!(current.custom_games.len(), 1);
    assert_eq!(current.custom_games[0].name, "Factorio");

    let _ = fs::remove_dir_all(tmp_dir);
}

#[test]
fn test_game_activity_detection_pipeline() {
    let procs = vec![
        ProcessInfo {
            names: vec!["terminal.exe".into()],
            cmdline: "".into(),
        },
        ProcessInfo {
            names: vec!["cs2.exe".into()],
            cmdline: "".into(),
        },
    ];

    let game = detect_game(&procs, &[], None);
    assert_eq!(game, Some("Counter-Strike 2".into()));

    // Custom game overrides built-in detection
    let custom = vec![CustomGame {
        exe: "cs2.exe".into(),
        name: "CS2 Tournament Client".into(),
    }];
    let custom_game = detect_game(&procs, &custom, None);
    assert_eq!(custom_game, Some("CS2 Tournament Client".into()));
}

#[test]
fn test_league_lcu_integration() {
    let raw_lockfile = "LeagueClient:8412:59912:verySecretKey123:https";
    let creds = parse_lockfile(raw_lockfile).expect("valid LCU lockfile");
    assert_eq!(creds.port, 59912);
    assert_eq!(creds.password, "verySecretKey123");
    assert_eq!(creds.protocol, "https");

    assert_eq!(queue_name(420), "Ranked Solo/Duo");
    assert_eq!(queue_name(440), "Ranked Flex");
    assert_eq!(queue_name(450), "ARAM");
}

#[test]
fn test_audio_realtime_dsp_metrics() {
    let config = AudioConfig::default();
    let mut pipeline = AudioPipeline::new(48000, &config);

    // 10 ms speech-like buffer (480 samples @ 48 kHz)
    let mut speech_buffer = vec![0.0f32; 480];
    for (i, sample) in speech_buffer.iter_mut().enumerate() {
        *sample = (2.0 * std::f32::consts::PI * 440.0 * (i as f32) / 48000.0).sin() * 0.2;
    }

    // Process a couple frames so attack time engages gate
    let _ = pipeline.process_frame(&mut speech_buffer.clone());
    let metrics = pipeline.process_frame(&mut speech_buffer);
    assert!(metrics.input_rms_dbfs > -30.0);
    assert_eq!(metrics.gate_state, "open");

    // Verify silence/noise gating: feed silence until the 150 ms hold timer expires
    let silence_buffer = vec![0.0001f32; 480];
    
    // First frame absorbs filter decay, second frame transitions to holding
    let _ = pipeline.process_frame(&mut silence_buffer.clone());
    let holding_metrics = pipeline.process_frame(&mut silence_buffer.clone());
    assert_eq!(holding_metrics.gate_state, "holding");

    // 20 frames of 10 ms silence = 200 ms (> 150 ms hold_time)
    let mut last_metrics = holding_metrics;
    for _ in 0..20 {
        last_metrics = pipeline.process_frame(&mut silence_buffer.clone());
    }
    assert_eq!(last_metrics.gate_state, "closed");
}

#[test]
fn test_deeplink_and_unread_parsing() {
    assert_eq!(parse_unread("Cillhub"), UnreadState::None);
    assert_eq!(parse_unread("(1) Cillhub"), UnreadState::Mentions(1));
    assert_eq!(parse_unread("(42) #general - Cillhub"), UnreadState::Mentions(42));
    assert_eq!(parse_unread("● Cillhub"), UnreadState::UnreadPill);

    assert_eq!(deep_link_path("cillhub://channels/123/456"), Some("/channels/123/456".into()));
    assert_eq!(deep_link_path("cillcord://invite/code123"), Some("/invite/code123".into()));
}

#[test]
fn test_protocol_security_and_traversal() {
    let tmp = std::env::temp_dir().join("cillhub_proto_integ");
    let _ = fs::create_dir_all(&tmp);
    let _ = fs::write(tmp.join("index.html"), "<html>Cillhub</html>");
    let _ = fs::write(tmp.join("bundle.js"), "console.log('hi');");

    // Traversal attempts must fail
    assert!(sanitize_app_path(&tmp, "../etc/shadow").is_err());
    assert!(sanitize_app_path(&tmp, "foo/bar/../../secret").is_err());

    // Valid asset
    let asset = sanitize_app_path(&tmp, "/bundle.js").expect("valid asset");
    assert!(asset.ends_with("bundle.js"));

    // Missing asset with extension returns Err
    assert!(sanitize_app_path(&tmp, "/missing.png").is_err());

    // SPA client route falls back to index.html
    let route = sanitize_app_path(&tmp, "/channels/guild1/chan2").expect("SPA route");
    assert!(route.ends_with("index.html"));

    let _ = fs::remove_dir_all(tmp);
}
