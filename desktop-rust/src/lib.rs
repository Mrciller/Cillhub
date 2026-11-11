//! Cillhub pure-Rust native desktop client (`cillhub_core`).
//! Re-exports all protocol, audio DSP, game activity, League LCU lobby,
//! Ed25519 auto-update, and native `egui`/`eframe` UI modules from `cillhub_client_core`.

pub use cillhub_client_core::{
    api, audio, config, deeplink, games, gateway, i18n, league, model, native_gateway,
    permissions, run_desktop_app, settings, state, theme, ui, update, websocket,
    websocket_transport,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_core_reexports_game_and_league_invite() {
        let invite = league::GameInviteData {
            game: "League of Legends".into(),
            queue_name: "Ranked Solo/Duo".into(),
            queue_id: Some(420),
            party_id: "party-100".into(),
            host_name: "Cillerian".into(),
            host_puuid: None,
            members: 2,
            max_members: 5,
        };
        let url = league::format_game_invite_url(&invite);
        assert_eq!(league::parse_game_invite(&url), Some(invite));

        let procs = vec![games::ProcessInfo {
            names: vec!["LeagueClientUx.exe".into()],
            cmdline: String::new(),
        }];
        assert_eq!(
            games::detect_game(&procs, &[], None).as_deref(),
            Some("League of Legends")
        );
    }
}
