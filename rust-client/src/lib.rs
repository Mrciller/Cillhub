//! Pure-Rust native Cillhub desktop client and protocol engine.
//! Contains no Tauri, no WebView, and no JavaScript runtime.

pub mod api;
pub mod audio;
pub mod config;
pub mod deeplink;
pub mod games;
pub mod gateway;
pub mod i18n;
pub mod league;
pub mod model;
#[cfg(feature = "native-net")]
pub mod native_gateway;
pub mod permissions;
pub mod settings;
pub mod state;
#[cfg(feature = "native-gui")]
pub mod theme;
#[cfg(feature = "native-gui")]
pub mod ui;
pub mod update;
pub mod websocket;
#[cfg(feature = "native-net")]
pub mod websocket_transport;

#[cfg(feature = "native-gui")]
pub fn run_desktop_app() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();

    if args.iter().any(|a| a == "--version" || a == "-v") {
        println!(
            "cillhub-desktop {} (Pure Rust Native egui/eframe)",
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }

    if args.iter().any(|a| a == "--test-audio") {
        use crate::audio::denoise_rnnoise::RNNOISE_FRAME_SIZE;
        use crate::audio::pipeline::{AudioConfig, AudioPipeline};
        let cfg = AudioConfig::default();
        let mut proc = AudioPipeline::new(48_000, &cfg);
        let mut frame = vec![0.12_f32; RNNOISE_FRAME_SIZE];
        let metrics = proc.process_frame(&mut frame);
        println!(
            "48 kHz Audio DSP Pipeline OK — input: {:.1} dBFS, output: {:.1} dBFS, gate: {}",
            metrics.input_rms_dbfs, metrics.output_rms_dbfs, metrics.gate_state
        );
        return Ok(());
    }

    if args.iter().any(|a| a == "--scan-games") {
        let settings = crate::settings::AppSettings::load();
        let mut tracker = crate::games::GameTracker::default();
        match tracker.scan(&settings.custom_games) {
            Some(g) => println!("Active Game Detected: {} (start={})", g.name, g.start),
            None => println!(
                "No recognized game currently running ({} built-in signatures + {} custom).",
                crate::games::GAMES.len(),
                settings.custom_games.len()
            ),
        }
        return Ok(());
    }

    if args.iter().any(|a| a == "--scan-league") {
        let mut tracker = crate::games::GameTracker::default();
        let _ = tracker.scan(&[]);
        if let Some(lock_path) = crate::league::find_lockfile_path(tracker.last_processes()) {
            if let Some(creds) = crate::league::read_lockfile(&lock_path) {
                if let Ok(client) = crate::league::LeagueClient::new() {
                    match client.fetch_lobby(&creds) {
                        Ok(Some(lobby)) => println!(
                            "League Lobby Active: {} (party={:?}, {}/{})",
                            lobby.queue_name,
                            lobby.party_id,
                            lobby.member_count,
                            lobby.max_party_size
                        ),
                        Ok(None) => println!("League Client running, not currently in a lobby."),
                        Err(e) => println!("League Client lockfile found, LCU error: {e}"),
                    }
                    return Ok(());
                }
            }
        }
        println!("League of Legends client not currently running.");
        return Ok(());
    }

    if args.iter().any(|a| a == "--headless-smoke") {
        let ctx = egui::Context::default();
        let mut auth_app = crate::ui::CillhubApp::new(None, false);
        crate::theme::install_fonts(&ctx, false);
        crate::theme::apply_theme(&ctx, &auth_app.theme_name, auth_app.settings.font_scale);
        auth_app.mark_fonts_installed();
        let mut dummy_input = egui::RawInput::default();
        dummy_input.screen_rect = Some(egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::Vec2::new(1280.0, 800.0),
        ));
        let auth_out = ctx.run(dummy_input.clone(), |ctx| {
            auth_app.headless_tick(ctx);
        });

        let mut app = crate::ui::CillhubApp::new(None, true);
        app.mark_fonts_installed();
        let out = ctx.run(dummy_input, |ctx| {
            app.headless_tick(ctx);
        });
        println!(
            "Headless egui render OK — auth_shapes={}, chat_shapes={}, textures_delta={}, active_game={:?}",
            auth_out.shapes.len(),
            out.shapes.len(),
            out.textures_delta.set.len(),
            app.current_game.as_ref().map(|g| &g.name)
        );
        return Ok(());
    }

    let demo_mode = args.iter().any(|a| a == "--demo" || a == "--sandbox");
    let deep_link = args
        .iter()
        .skip(1)
        .find(|a| a.starts_with("cillhub://") || a.starts_with("cillcord://"))
        .cloned();

    let settings = crate::settings::AppSettings::load();
    let width = (settings.bounds.width as f32).max(940.0);
    let height = (settings.bounds.height as f32).max(600.0);

    let viewport = egui::ViewportBuilder::default()
        .with_title("Cillhub")
        .with_inner_size([width, height])
        .with_min_inner_size([940.0, 600.0]);

    let native_options = eframe::NativeOptions {
        viewport,
        ..Default::default()
    };

    eframe::run_native(
        "Cillhub",
        native_options,
        Box::new(move |cc| {
            let mut app = crate::ui::CillhubApp::new(deep_link, demo_mode);
            crate::theme::install_fonts(&cc.egui_ctx, app.state.user_settings.dyslexic_font);
            crate::theme::apply_theme(&cc.egui_ctx, &app.theme_name, app.settings.font_scale);
            app.mark_fonts_installed();
            Ok(Box::new(app))
        }),
    )
    .map_err(|e| e.to_string())
}
