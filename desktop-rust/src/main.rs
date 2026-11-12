#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Cillhub desktop binary (`cillhub`): 100% pure-Rust native GUI (`egui`/`eframe`),
//! with zero Tauri/WebView dependencies.

fn main() {
    if let Err(err) = cillhub_core::run_desktop_app() {
        eprintln!("Cillhub error: {err}");
        std::process::exit(1);
    }
}
