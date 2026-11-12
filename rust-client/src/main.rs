//! Pure-Rust native Cillhub desktop client binary (`cillhub-native`).
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if let Err(err) = cillhub_client_core::run_desktop_app() {
        eprintln!("Cillhub error: {err}");
        std::process::exit(1);
    }
}
