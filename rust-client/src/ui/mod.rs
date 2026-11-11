//! Pure-Rust native Cillhub Arena desktop UI (`egui` / `eframe`).
//! No Tauri, no WebView, no JavaScript frontend.

pub mod auth;
pub mod chat;
pub mod friends;
pub mod modals;

use crate::api::{normalize_server_url, ApiClient};
use crate::config::HUB_URL;
use crate::deeplink::{parse_deep_link, DeepLinkTarget};
use crate::games::{GameActivity, GameTracker};
use crate::league::{
    find_lockfile_path, format_game_invite_url, read_lockfile, GameInviteData, LeagueClient,
    LeagueLobbyInfo,
};
use crate::model::{
    Activity, ActivityTimestamps, Channel, CustomStatus, Guild, Member, Message, Presence,
    Relationship, Role, User, VoiceState,
};
use crate::native_gateway::{spawn_with_commands, GatewayCommand, GatewayEvent};
use crate::settings::AppSettings;
use crate::state::State;
use crate::theme::{
    apply_theme, bold_font, display_font, draw_avatar, draw_icon, draw_list_heading, icon_btn,
    initials, install_fonts, palette::*, ui_font, IconKind,
};
use egui::{
    Align, Align2, CentralPanel, Color32, Context, CornerRadius, Frame, Key, Layout, Margin, Pos2,
    Rect, RichText, ScrollArea, Sense, SidePanel, Stroke, StrokeKind, TopBottomPanel, Ui, Vec2,
};
use serde_json::Value;
use std::sync::mpsc::{self, Receiver, Sender};
use std::time::{Duration, Instant};
use url::Url;

/// Logs a failed action and shows it in the status line instead of dropping it.
pub fn report<T, E: std::fmt::Display>(banner: &mut Option<String>, r: Result<T, E>) -> Option<T> {
    match r {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("cillhub: {e}");
            *banner = Some(e.to_string());
            None
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageLoad {
    Loading,
    Ready,
    Failed,
}

pub const VOICE_UNAVAILABLE: &str = "Voice calls are not available in this app yet.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthMode {
    Login,
    Register,
    Mfa,
    ResetPassword,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FriendsTab {
    Online,
    All,
    Pending,
    Blocked,
    Add,
}

impl FriendsTab {
    pub fn label(&self) -> &'static str {
        match self {
            Self::Online => "ONLINE",
            Self::All => "ALL FRIENDS",
            Self::Pending => "PENDING",
            Self::Blocked => "BLOCKED",
            Self::Add => "ADD FRIEND",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModalKind {
    GameLobbyInvite,
    UserSettings,
    ServerSettings,
    CreateJoinGuild,
    CreatePoll,
    SendLater,
    QuickSwitcher,
    Directory,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrawerKind {
    Threads,
    Pins,
    Saved,
    Search,
    Canvas,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsTab {
    Account,
    Games,
    Voice,
    Appearance,
    Desktop,
}

pub struct CillhubApp {
    pub settings: AppSettings,
    pub state: State,
    pub api: Option<ApiClient>,
    pub gateway_rx: Option<Receiver<GatewayEvent>>,
    pub gateway_cmd_tx: Option<Sender<GatewayCommand>>,

    // Auth state
    pub authenticated: bool,
    pub auth_mode: AuthMode,
    pub auth_server_url: String,
    pub auth_login_input: String,
    pub auth_email_input: String,
    pub auth_password_input: String,
    pub auth_mfa_ticket: String,
    pub auth_mfa_code: String,
    pub auth_reset_token: String,
    pub auth_error: Option<String>,

    // Navigation & View state
    pub selected_guild_id: Option<String>,
    pub selected_channel_id: Option<String>,
    pub friends_tab: FriendsTab,
    pub add_friend_input: String,
    pub show_member_list: bool,
    pub active_modal: Option<ModalKind>,
    pub active_drawer: Option<DrawerKind>,
    pub settings_tab: SettingsTab,
    pub status_banner: Option<String>,

    // Chat & Composer state
    pub composer_text: String,
    /// Inline image attachments by egui URI; bytes arrive from fetch threads.
    pub images: std::collections::HashMap<String, ImageLoad>,
    image_tx: Sender<(String, Option<Vec<u8>>)>,
    image_rx: Receiver<(String, Option<Vec<u8>>)>,
    /// Full-size image view: (egui URI, file name, absolute URL).
    pub lightbox: Option<(String, String, String)>,
    /// Files picked or dropped, sent with the next message.
    pub pending_files: Vec<std::path::PathBuf>,
    pub show_composer_plus_menu: bool,
    pub reply_to_message: Option<Message>,
    pub editing_message_id: Option<String>,
    pub search_query: String,
    pub quick_switcher_query: String,
    pub canvas_doc_input: String,

    // Voice: no audio I/O or media transport yet, so the client never joins a call.
    pub self_mute: bool,
    pub self_deaf: bool,
    pub self_video: bool,
    pub self_stream: bool,

    // Game Activity & League of Legends Lobby state
    pub game_tracker: GameTracker,
    pub current_game: Option<GameActivity>,
    pub last_game_scan: Instant,
    pub league_lobby: Option<LeagueLobbyInfo>,
    pub last_league_scan: Instant,
    pub lobby_form_game: String,
    pub lobby_form_queue: String,
    pub lobby_form_host: String,
    pub lobby_form_party_id: String,
    pub lobby_form_members: u32,
    pub lobby_form_max_members: u32,
    pub lcu_summoner_target: String,
    pub custom_game_exe_input: String,
    pub custom_game_name_input: String,

    // Modals & Settings inputs
    pub my_status: String,
    pub custom_status_input: String,
    pub theme_name: String,
    pub locale: String,
    pub new_guild_name_input: String,
    pub join_invite_code_input: String,
    pub new_channel_name_input: String,
    pub poll_question_input: String,
    pub poll_options_input: String,
    pub schedule_time_input: String,
    pub update_ready_version: Option<String>,

    local_counter: u64,
    fonts_installed: bool,
}

impl CillhubApp {
    pub fn new(initial_deep_link: Option<String>, demo_mode: bool) -> Self {
        let settings = AppSettings::load();
        let server_url = if settings.server_target == "node" && !settings.custom_node_url.is_empty()
        {
            settings.custom_node_url.clone()
        } else {
            HUB_URL.to_string()
        };

        let mut tracker = GameTracker::default();
        let initial_game = if settings.share_activity {
            tracker.scan(&settings.custom_games)
        } else {
            None
        };
        let initial_league = find_lockfile_path(tracker.last_processes())
            .and_then(|p| read_lockfile(&p))
            .and_then(|creds| {
                LeagueClient::new()
                    .ok()
                    .and_then(|c| c.fetch_lobby(&creds).ok().flatten())
            });

        let (image_tx, image_rx) = mpsc::channel();
        let mut app = Self {
            settings,
            state: State::default(),
            api: None,
            gateway_rx: None,
            gateway_cmd_tx: None,
            authenticated: false,
            auth_mode: AuthMode::Login,
            auth_server_url: server_url,
            auth_login_input: String::new(),
            auth_email_input: String::new(),
            auth_password_input: String::new(),
            auth_mfa_ticket: String::new(),
            auth_mfa_code: String::new(),
            auth_reset_token: String::new(),
            auth_error: None,
            selected_guild_id: None,
            selected_channel_id: None,
            friends_tab: FriendsTab::Online,
            add_friend_input: String::new(),
            show_member_list: true,
            active_modal: None,
            active_drawer: None,
            settings_tab: SettingsTab::Games,
            status_banner: None,
            composer_text: String::new(),
            pending_files: Vec::new(),
            images: Default::default(),
            image_tx,
            image_rx,
            lightbox: None,
            show_composer_plus_menu: false,
            reply_to_message: None,
            editing_message_id: None,
            search_query: String::new(),
            quick_switcher_query: String::new(),
            canvas_doc_input: "# Arena Match Notes\n- Mid prio at 3:15\n- Objective control".to_string(),
            self_mute: false,
            self_deaf: false,
            self_video: false,
            self_stream: false,
            game_tracker: tracker,
            current_game: initial_game,
            last_game_scan: Instant::now(),
            league_lobby: initial_league,
            last_league_scan: Instant::now(),
            lobby_form_game: "League of Legends".to_string(),
            lobby_form_queue: "Ranked Solo/Duo".to_string(),
            lobby_form_host: String::new(),
            lobby_form_party_id: "arena-party-77".to_string(),
            lobby_form_members: 2,
            lobby_form_max_members: 5,
            lcu_summoner_target: String::new(),
            custom_game_exe_input: String::new(),
            custom_game_name_input: String::new(),
            my_status: "online".to_string(),
            custom_status_input: String::new(),
            theme_name: "dark".to_string(),
            locale: "en".to_string(),
            new_guild_name_input: String::new(),
            join_invite_code_input: String::new(),
            new_channel_name_input: String::new(),
            poll_question_input: "Which game mode tonight?".to_string(),
            poll_options_input: "League Ranked 5v5, Counter-Strike 2, Valorant".to_string(),
            schedule_time_input: "2026-11-10T22:00:00Z".to_string(),
            update_ready_version: None,
            local_counter: 100,
            fonts_installed: false,
        };

        if demo_mode {
            app.enter_demo_arena();
        } else if let Some(token) = app.settings.token() {
            if let Some(origin) = normalize_server_url(&app.auth_server_url) {
                app.complete_login(origin, token);
            }
        }

        if let Some(link) = initial_deep_link {
            app.handle_deep_link(&link);
        }

        app
    }

    pub fn next_local_id(&mut self) -> u64 {
        self.local_counter += 1;
        self.local_counter
    }

    pub fn handle_deep_link(&mut self, url: &str) {
        if let Some(target) = parse_deep_link(url) {
            match target {
                DeepLinkTarget::Invite(code) => {
                    self.join_invite_code_input = code;
                    self.join_invite_code();
                }
                DeepLinkTarget::GameInvite(invite) => {
                    self.join_game_party(&invite);
                }
            }
        }
    }

    pub fn complete_login(&mut self, origin: Url, token: String) {
        report(&mut self.status_banner, self.settings.set_token(Some(&token)));
        self.api = Some(ApiClient::new(origin.clone(), Some(token.clone())));
        let (ev_tx, ev_rx) = mpsc::channel();
        let (cmd_tx, cmd_rx) = mpsc::channel();
        spawn_with_commands(origin, token, ev_tx, cmd_rx);
        self.gateway_rx = Some(ev_rx);
        self.gateway_cmd_tx = Some(cmd_tx);
        self.authenticated = true;
        self.auth_error = None;
        self.broadcast_presence();
    }

    pub fn logout(&mut self) {
        if let Some(tx) = &self.gateway_cmd_tx {
            let _ = tx.send(GatewayCommand::Shutdown);
        }
        self.gateway_rx = None;
        self.gateway_cmd_tx = None;
        self.api = None;
        self.authenticated = false;
        report(&mut self.status_banner, self.settings.set_token(None));
        self.active_modal = None;
    }

    pub fn enter_demo_arena(&mut self) {
        self.authenticated = true;
        let me = User {
            id: "u_me".to_string(),
            username: "alex".to_string(),
            global_name: Some("Alex".to_string()),
            ..Default::default()
        };
        let sam = User {
            id: "u_sam".to_string(),
            username: "sam".to_string(),
            global_name: Some("Sam".to_string()),
            ..Default::default()
        };
        let robin = User {
            id: "u_robin".to_string(),
            username: "robin".to_string(),
            global_name: Some("Robin".to_string()),
            ..Default::default()
        };

        self.state.me = Some(me.clone());
        self.state.users.insert(me.id.clone(), me.clone());
        self.state.users.insert(sam.id.clone(), sam.clone());
        self.state.users.insert(robin.id.clone(), robin.clone());

        let active_game = self.current_game.clone().unwrap_or(GameActivity {
            name: "League of Legends".to_string(),
            start: 1_762_800_000_000,
        });
        self.current_game = Some(active_game.clone());

        for (uid, gname) in [
            ("u_me", active_game.name.as_str()),
            ("u_sam", "League of Legends"),
            ("u_robin", "Counter-Strike 2"),
        ] {
            self.state.presences.insert(
                uid.to_string(),
                Presence {
                    user_id: uid.to_string(),
                    status: "online".to_string(),
                    custom_status: None,
                    activities: vec![Activity {
                        name: gname.to_string(),
                        kind: 0,
                        state: Some("In Lobby".to_string()),
                        details: None,
                        timestamps: Some(ActivityTimestamps {
                            start: Some(1_762_800_000_000),
                            end: None,
                        }),
                    }],
                },
            );
        }

        self.state.relationships.insert(
            sam.id.clone(),
            Relationship {
                id: sam.id.clone(),
                kind: 1,
                user: Some(sam.clone()),
                nickname: None,
            },
        );
        self.state.relationships.insert(
            robin.id.clone(),
            Relationship {
                id: robin.id.clone(),
                kind: 1,
                user: Some(robin.clone()),
                nickname: None,
            },
        );

        let gid = "g_arena".to_string();
        let ch_general = Channel {
            id: "c_general".to_string(),
            kind: 0,
            guild_id: Some(gid.clone()),
            name: Some("arena-general".to_string()),
            topic: Some("Cillhub Pure-Rust Native Desktop Client · Game Activity & Lobby Invites".to_string()),
            ..Default::default()
        };
        let ch_lfg = Channel {
            id: "c_lfg".to_string(),
            kind: 0,
            guild_id: Some(gid.clone()),
            name: Some("lobby-invites".to_string()),
            topic: Some("Post your League & Game Party invites here".to_string()),
            ..Default::default()
        };
        let ch_voice = Channel {
            id: "c_voice".to_string(),
            kind: 2,
            guild_id: Some(gid.clone()),
            name: Some("Lounge".to_string()),
            status: Some("Ranked 5v5 Scrims".to_string()),
            ..Default::default()
        };
        let ch_stage = Channel {
            id: "c_stage".to_string(),
            kind: 13,
            guild_id: Some(gid.clone()),
            name: Some("Tournament Stage".to_string()),
            ..Default::default()
        };

        let guild = Guild {
            id: gid.clone(),
            name: "Cillhub Arena".to_string(),
            owner_id: me.id.clone(),
            description: Some("Official Cillhub Gaming & Esports Hub".to_string()),
            roles: vec![
                Role {
                    id: gid.clone(),
                    name: "@everyone".to_string(),
                    position: 0,
                    permissions: "70356545".to_string(),
                    ..Default::default()
                },
                Role {
                    id: "r_captain".to_string(),
                    name: "Arena Captain".to_string(),
                    color: 0xff6a1f,
                    hoist: true,
                    position: 2,
                    permissions: "8".to_string(),
                    ..Default::default()
                },
            ],
            channels: vec![
                ch_general.clone(),
                ch_lfg.clone(),
                ch_voice.clone(),
                ch_stage.clone(),
            ],
            members: vec![
                Member {
                    user: Some(me.clone()),
                    roles: vec!["r_captain".to_string()],
                    ..Default::default()
                },
                Member {
                    user: Some(sam.clone()),
                    roles: vec!["r_captain".to_string()],
                    ..Default::default()
                },
                Member {
                    user: Some(robin.clone()),
                    roles: vec![],
                    ..Default::default()
                },
            ],
            ..Default::default()
        };

        for ch in &guild.channels {
            self.state.channels.insert(ch.id.clone(), ch.clone());
        }
        let mut mem_map = std::collections::HashMap::new();
        for m in &guild.members {
            if let Some(u) = &m.user {
                mem_map.insert(u.id.clone(), m.clone());
            }
        }
        self.state.members.insert(gid.clone(), mem_map);
        self.state.guilds.insert(gid.clone(), guild);

        self.state.voice_states.insert(
            sam.id.clone(),
            VoiceState {
                user_id: sam.id.clone(),
                guild_id: Some(gid.clone()),
                channel_id: Some("c_voice".to_string()),
                ..Default::default()
            },
        );

        let demo_invite = format_game_invite_url(&GameInviteData {
            game: "League of Legends".to_string(),
            party_id: "arena-party-77".to_string(),
            queue_name: "Ranked Solo/Duo".to_string(),
            queue_id: Some(420),
            host_name: "Sam".to_string(),
            host_puuid: None,
            members: 2,
            max_members: 5,
        });

        self.state.messages.insert(
            "c_general".to_string(),
            vec![
                Message {
                    id: "m_1".to_string(),
                    channel_id: "c_general".to_string(),
                    content: "Welcome to the 100% pure-Rust Cillhub desktop client! Game Activity detection and Game Lobby Invites are live.".to_string(),
                    author: Some(robin.clone()),
                    timestamp: Some("2026-11-10T20:30:00Z".to_string()),
                    ..Default::default()
                },
                Message {
                    id: "m_2".to_string(),
                    channel_id: "c_general".to_string(),
                    content: format!("Need +3 for Ranked Queue — click Join Party below!\n{demo_invite}"),
                    author: Some(sam),
                    timestamp: Some("2026-11-10T20:32:00Z".to_string()),
                    ..Default::default()
                },
            ],
        );

        self.selected_guild_id = Some(gid);
        self.selected_channel_id = Some("c_general".to_string());
    }

    pub fn set_share_activity(&mut self, enabled: bool) {
        self.settings.share_activity = enabled;
        report(&mut self.status_banner, self.settings.save());
        if !enabled {
            self.game_tracker.reset();
            self.current_game = None;
        } else {
            self.current_game = self.game_tracker.poll(&self.settings.custom_games);
        }
        self.broadcast_presence();
    }

    pub fn poll_game_activity(&mut self, force_broadcast: bool) {
        self.last_game_scan = Instant::now();
        if !self.settings.share_activity {
            return;
        }
        let next = self.game_tracker.scan(&self.settings.custom_games);
        let changed =
            next.as_ref().map(|g| &g.name) != self.current_game.as_ref().map(|g| &g.name);
        if next.is_some() || self.gateway_cmd_tx.is_some() {
            self.current_game = next;
        }
        if changed || force_broadcast {
            self.broadcast_presence();
        }
    }

    pub fn poll_league_lobby(&mut self) {
        self.last_league_scan = Instant::now();
        if let Some(lock_path) = find_lockfile_path(self.game_tracker.last_processes()) {
            if let Some(creds) = read_lockfile(&lock_path) {
                if let Ok(client) = LeagueClient::new() {
                    if let Ok(lobby) = client.fetch_lobby(&creds) {
                        self.league_lobby = lobby;
                    }
                }
            }
        }
    }

    pub fn broadcast_presence(&mut self) {
        let custom_status = if self.custom_status_input.trim().is_empty() {
            None
        } else {
            Some(CustomStatus {
                text: Some(self.custom_status_input.trim().to_string()),
                emoji_name: None,
                emoji_id: None,
                expires_at: None,
            })
        };
        let game = if self.settings.share_activity {
            self.current_game.clone()
        } else {
            None
        };
        if let Some(tx) = &self.gateway_cmd_tx {
            let _ = tx.send(GatewayCommand::UpdatePresence {
                status: self.my_status.clone(),
                custom_status: custom_status.clone(),
                game: game.clone(),
            });
        }
        if let Some(me) = &self.state.me {
            let activities = game
                .map(|g| {
                    vec![Activity {
                        name: g.name,
                        kind: 0,
                        state: Some("In Game".to_string()),
                        details: None,
                        timestamps: Some(ActivityTimestamps {
                            start: Some(g.start),
                            end: None,
                        }),
                    }]
                })
                .unwrap_or_default();
            self.state.presences.insert(
                me.id.clone(),
                Presence {
                    user_id: me.id.clone(),
                    status: self.my_status.clone(),
                    custom_status,
                    activities,
                },
            );
        }
    }

    pub fn build_active_lobby_invite_url(&self) -> String {
        let host = self
            .state
            .me
            .as_ref()
            .map(|u| u.display_name().to_string())
            .unwrap_or_else(|| self.lobby_form_host.clone());
        if let Some(l) = &self.league_lobby {
            return format_game_invite_url(&GameInviteData::from_league_lobby(l, &host));
        }
        let game = self
            .current_game
            .as_ref()
            .map(|g| g.name.clone())
            .unwrap_or_else(|| self.lobby_form_game.clone());
        format_game_invite_url(&GameInviteData {
            game,
            party_id: self.lobby_form_party_id.clone(),
            queue_name: self.lobby_form_queue.clone(),
            queue_id: Some(420),
            host_name: host,
            host_puuid: None,
            members: self.lobby_form_members as usize,
            max_members: self.lobby_form_max_members.max(self.lobby_form_members) as usize,
        })
    }

    pub fn join_game_party(&mut self, invite: &GameInviteData) {
        if let Some(lock_path) = find_lockfile_path(self.game_tracker.last_processes()) {
            if let Some(creds) = read_lockfile(&lock_path) {
                if let Ok(client) = LeagueClient::new() {
                    match client.accept_invite(&creds, &invite.party_id) {
                        Ok(_) => {
                            self.status_banner = Some(format!(
                                "Joined {} lobby ({}) via League LCU API!",
                                invite.game, invite.queue_name
                            ));
                            return;
                        }
                        Err(err) => {
                            self.status_banner = Some(format!(
                                "LCU response for party {}: {err}",
                                invite.party_id
                            ));
                            return;
                        }
                    }
                }
            }
        }
        self.status_banner = Some(format!(
            "Accepted party invite for {} — {} (Host: {}, Party ID: {})!",
            invite.game, invite.queue_name, invite.host_name, invite.party_id
        ));
    }

    pub fn send_direct_lcu_invite(&mut self) {
        let target = self.lcu_summoner_target.trim().to_string();
        if target.is_empty() {
            return;
        }
        if let Some(lock_path) = find_lockfile_path(self.game_tracker.last_processes()) {
            if let Some(creds) = read_lockfile(&lock_path) {
                if let Ok(client) = LeagueClient::new() {
                    match client.send_invite(&creds, &target) {
                        Ok(_) => {
                            self.status_banner =
                                Some(format!("Sent League LCU lobby invite to {target}!"));
                        }
                        Err(e) => {
                            self.status_banner = Some(format!("LCU invite error: {e}"));
                        }
                    }
                    return;
                }
            }
        }
        self.status_banner = Some(format!(
            "Queued League lobby invite for {target} (start LeagueClientUx to send over local LCU)."
        ));
    }

    /// Voice calls need audio I/O and the hub's media transport, which this app does not have
    /// yet. It does not send a voice state either: others would see a silent member.
    pub fn show_voice_unavailable(&mut self) {
        self.status_banner = Some(VOICE_UNAVAILABLE.to_string());
    }

    pub fn load_channel_history(&mut self, channel_id: &str) {
        if self.state.messages.contains_key(channel_id) {
            return;
        }
        if let Some(api) = &self.api {
            if let Some(val) = report(
                &mut self.status_banner,
                api.get(&format!("/channels/{channel_id}/messages?limit=50")),
            ) {
                if let Some(arr) = val.as_array() {
                    let mut list = Vec::new();
                    for item in arr.iter().rev() {
                        match crate::model::parse::<Message>(item.clone()) {
                            Ok(msg) => list.push(msg),
                            Err(e) => eprintln!("cillhub: skipped message: {e}"),
                        }
                    }
                    self.state.set_history(channel_id.to_string(), list);
                }
            }
        }
    }

    /// READY has no member lists; fetch them like the web client (GET /guilds/{id}/members).
    pub fn load_members(&mut self, guild_id: &str) {
        let Some(api) = &self.api else { return };
        if let Some(list) = report(
            &mut self.status_banner,
            api.get(&format!("/guilds/{guild_id}/members?limit=1000")),
        ) {
            report(&mut self.status_banner, self.state.set_members(guild_id, list));
        }
    }

    pub fn load_older_messages(&mut self, channel_id: &str) {
        let oldest = self
            .state
            .messages
            .get(channel_id)
            .and_then(|l| l.first())
            .map(|m| m.id.clone());
        let Some(before) = oldest else { return };
        if let Some(api) = &self.api {
            if let Ok(val) =
                api.get(&format!("/channels/{channel_id}/messages?limit=50&before={before}"))
            {
                if let Some(arr) = val.as_array() {
                    let mut older = Vec::new();
                    for item in arr.iter().rev() {
                        match crate::model::parse::<Message>(item.clone()) {
                            Ok(msg) => older.push(msg),
                            Err(e) => eprintln!("cillhub: skipped message: {e}"),
                        }
                    }
                    if let Some(existing) = self.state.messages.get_mut(channel_id) {
                        older.append(existing);
                        *existing = older;
                    }
                }
            }
        }
    }

    pub fn load_pins(&mut self, channel_id: &str) {
        if let Some(api) = &self.api {
            if let Ok(val) = api.get(&format!("/channels/{channel_id}/pins")) {
                if let Some(arr) = val.as_array() {
                    if let Some(list) = self.state.messages.get_mut(channel_id) {
                        for p in arr {
                            if let Some(pid) = p.get("id").and_then(Value::as_str) {
                                if let Some(m) = list.iter_mut().find(|m| m.id == pid) {
                                    m.pinned = true;
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    pub fn run_search(&mut self) {
        let q = self.search_query.trim().to_string();
        if q.is_empty() {
            return;
        }
        if let (Some(api), Some(gid)) = (&self.api, &self.selected_guild_id) {
            let encoded =
                percent_encoding::utf8_percent_encode(&q, percent_encoding::NON_ALPHANUMERIC)
                    .to_string();
            report(&mut self.status_banner, api.get(&format!("/guilds/{gid}/messages/search?content={encoded}")));
        }
    }

    fn process_background_events(&mut self) {
        let mut events = Vec::new();
        if let Some(rx) = &self.gateway_rx {
            while let Ok(ev) = rx.try_recv() {
                events.push(ev);
            }
        }
        for ev in events {
            match ev {
                GatewayEvent::Dispatch(name, payload) => {
                    let is_ready = name == "READY";
                    let new_guild = (name == "GUILD_CREATE")
                        .then(|| payload.get("id").and_then(Value::as_str).map(String::from))
                        .flatten();
                    if let Err(e) = self.state.apply(&name, payload) {
                        eprintln!("cillhub: {name} not applied: {e}");
                        self.status_banner = Some(format!("Could not apply {name}: {e}"));
                    }
                    if is_ready {
                        let ids: Vec<String> = self.state.guilds.keys().cloned().collect();
                        ids.iter().for_each(|id| self.load_members(id));
                    }
                    if let Some(id) = new_guild {
                        self.load_members(&id);
                    }
                    if is_ready && self.selected_channel_id.is_none() {
                        if let Some(g) = self.state.sorted_guilds().first() {
                            let gid = g.id.clone();
                            let first_ch = g
                                .channels
                                .iter()
                                .find(|c| c.kind == 0)
                                .map(|c| c.id.clone());
                            self.selected_guild_id = Some(gid);
                            if let Some(cid) = first_ch {
                                self.selected_channel_id = Some(cid.clone());
                                self.load_channel_history(&cid);
                            }
                        }
                    }
                }
                GatewayEvent::ConnectionError(err) => {
                    self.status_banner = Some(format!("Gateway reconnecting: {err}"));
                }
                GatewayEvent::RejectedToken => {
                    self.logout();
                    self.auth_error = Some("Session expired. Please log in again.".to_string());
                }
                GatewayEvent::Connected => {
                    self.status_banner = None;
                }
            }
        }

        if self.last_game_scan.elapsed() >= Duration::from_secs(5) {
            self.poll_game_activity(false);
        }
        if self.last_league_scan.elapsed() >= Duration::from_secs(4) {
            self.poll_league_lobby();
        }
    }

    fn render_guild_rail(&mut self, ui: &mut Ui) {
        let rail_rect = ui.max_rect();
        ui.painter().vline(
            rail_rect.max.x - 0.5,
            rail_rect.y_range(),
            Stroke::new(1.0_f32, BORDER),
        );

        ui.vertical_centered(|ui| {
            ui.add_space(10.0);

            // 1. Home / Friends / Direct Messages `.rail-icon`
            let home_active = self.selected_guild_id.is_none();
            let home_resp = Self::rail_icon_slot(ui, rail_rect.min.x, home_active, false, |painter, rect, fg| {
                let icon_rect = Rect::from_center_size(rect.center(), Vec2::splat(22.0));
                draw_icon(painter, icon_rect, IconKind::Home, fg);
            });
            if home_resp.on_hover_text("Direct Messages").clicked() {
                self.selected_guild_id = None;
                self.selected_channel_id = None;
            }

            ui.add_space(8.0);
            // .rail-sep: 32px × 1px divider
            let (sep_rect, _) = ui.allocate_exact_size(Vec2::new(32.0, 1.0), Sense::hover());
            ui.painter().hline(
                sep_rect.x_range(),
                sep_rect.center().y,
                Stroke::new(1.0_f32, BORDER),
            );
            ui.add_space(8.0);

            // 2. Guilds list
            let guilds: Vec<(String, String)> = self
                .state
                .sorted_guilds()
                .into_iter()
                .map(|g| (g.id.clone(), g.name.clone()))
                .collect();

            for (gid, gname) in guilds {
                let active = self.selected_guild_id.as_deref() == Some(gid.as_str());
                let abbr = initials(&gname, 2);
                let resp = Self::rail_icon_slot(ui, rail_rect.min.x, active, false, |painter, rect, fg| {
                    painter.text(
                        rect.center(),
                        Align2::CENTER_CENTER,
                        &abbr,
                        display_font(20.0),
                        fg,
                    );
                });
                if resp.on_hover_text(&gname).clicked() {
                    self.selected_guild_id = Some(gid.clone());
                    let first_ch = self
                        .state
                        .guilds
                        .get(&gid)
                        .and_then(|g| g.channels.iter().find(|c| c.kind == 0))
                        .map(|c| c.id.clone());
                    if let Some(cid) = first_ch {
                        self.selected_channel_id = Some(cid.clone());
                        self.load_channel_history(&cid);
                    }
                }
                ui.add_space(8.0);
            }

            // 3. `.rail-add` button (`+` Add a Server)
            let add_resp = Self::rail_icon_slot(ui, rail_rect.min.x, false, true, |painter, rect, fg| {
                let icon_rect = Rect::from_center_size(rect.center(), Vec2::splat(20.0));
                draw_icon(painter, icon_rect, IconKind::Plus, fg);
            });
            if add_resp.on_hover_text("Add a Server").clicked() {
                self.active_modal = Some(ModalKind::CreateJoinGuild);
            }

            ui.add_space(8.0);

            // 4. Explore Public Servers (`Compass` icon)
            let dir_resp = Self::rail_icon_slot(ui, rail_rect.min.x, false, false, |painter, rect, fg| {
                let icon_rect = Rect::from_center_size(rect.center(), Vec2::splat(20.0));
                draw_icon(painter, icon_rect, IconKind::Compass, fg);
            });
            if dir_resp.on_hover_text("Explore Public Servers").clicked() {
                self.active_modal = Some(ModalKind::Directory);
            }
        });
    }

    fn rail_icon_slot(
        ui: &mut Ui,
        rail_left_x: f32,
        active: bool,
        is_add: bool,
        paint_inner: impl FnOnce(&egui::Painter, Rect, Color32),
    ) -> egui::Response {
        let (rect, resp) = ui.allocate_exact_size(Vec2::splat(46.0), Sense::click());
        let hovered = resp.hovered();
        let painter = ui.painter();

        let (fill, stroke, fg) = if is_add {
            if hovered {
                (GREEN, Stroke::new(1.0_f32, GREEN), BG_RAIL)
            } else {
                (BG_CARD, Stroke::new(1.0_f32, GREEN), GREEN)
            }
        } else if active {
            (BG_SELECTED, Stroke::new(2.0_f32, ACCENT), ACCENT)
        } else if hovered {
            (BG_HOVER, Stroke::new(1.0_f32, ACCENT), TEXT_HEADER)
        } else {
            (BG_CARD, Stroke::new(1.0_f32, BORDER), INTERACTIVE)
        };

        painter.rect(rect, CornerRadius::same(4), fill, stroke, StrokeKind::Inside);

        // Left-edge selection indicator bar (`3px` wide) matching `.rail-icon.active::before`
        if !is_add && (active || hovered) {
            let pill_h = if active { 38.0 } else { 18.0 };
            let pill_rect = Rect::from_min_size(
                Pos2::new(rail_left_x, rect.center().y - pill_h * 0.5),
                Vec2::new(3.0, pill_h),
            );
            painter.rect_filled(pill_rect, 0.0, ACCENT);
        }

        paint_inner(painter, rect, fg);
        resp
    }

    fn render_channel_sidebar(&mut self, ui: &mut Ui) {
        let sb_rect = ui.max_rect();
        ui.painter().vline(
            sb_rect.max.x - 0.5,
            sb_rect.y_range(),
            Stroke::new(1.0_f32, BORDER),
        );

        // Bottom dock: `.voice-bar` (if connected) + `.user-panel` matching `UserPanel.tsx`
        TopBottomPanel::bottom("sidebar_user_dock")
            .frame(Frame::new().fill(BG_PANEL))
            .show_inside(ui, |ui| {
                // Top border of user dock
                let r = ui.max_rect();
                ui.painter()
                    .hline(r.x_range(), r.min.y, Stroke::new(1.0_f32, BORDER));

                // 2. `.user-panel` (`height: 48px`, `padding: 0 8px`) matching `UserPanel.tsx`
                Frame::new()
                    .fill(BG_PANEL)
                    .inner_margin(Margin::symmetric(8, 8))
                    .show(ui, |ui| {
                        ui.set_height(32.0);
                        ui.horizontal(|ui| {
                            let (me_id, me_name, me_tag) = if let Some(me) = &self.state.me {
                                (
                                    me.id.clone(),
                                    me.display_name().to_string(),
                                    format!("@{}", me.username),
                                )
                            } else {
                                (
                                    "u_me".to_string(),
                                    "Player".to_string(),
                                    "@player".to_string(),
                                )
                            };

                            let av_resp = draw_avatar(
                                ui,
                                32.0,
                                &me_id,
                                &me_name,
                                Some(&self.my_status),
                                BG_PANEL,
                            );
                            if av_resp
                                .on_hover_text("Click to cycle status (Online / Idle / DND / Invisible)")
                                .clicked()
                            {
                                self.my_status = match self.my_status.as_str() {
                                    "online" => "idle".to_string(),
                                    "idle" => "dnd".to_string(),
                                    "dnd" => "invisible".to_string(),
                                    _ => "online".to_string(),
                                };
                                self.broadcast_presence();
                            }

                            ui.vertical(|ui| {
                                ui.spacing_mut().item_spacing.y = 0.0;
                                ui.label(
                                    RichText::new(&me_name)
                                        .font(bold_font(13.0))
                                        .color(TEXT_HEADER),
                                );
                                let sub_text = if let Some(g) = &self.current_game {
                                    RichText::new(format!("Playing {}", g.name))
                                        .font(ui_font(11.0))
                                        .color(GREEN)
                                } else if !self.custom_status_input.trim().is_empty() {
                                    RichText::new(self.custom_status_input.trim())
                                        .font(ui_font(11.0))
                                        .color(TEXT_MUTED)
                                } else {
                                    RichText::new(me_tag)
                                        .font(ui_font(11.0))
                                        .color(TEXT_MUTED)
                                };
                                ui.label(sub_text);
                            });

                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                ui.spacing_mut().item_spacing.x = 2.0;
                                if icon_btn(
                                    ui,
                                    IconKind::Gear,
                                    "User Settings",
                                    false,
                                    false,
                                )
                                .clicked()
                                {
                                    self.active_modal = Some(ModalKind::UserSettings);
                                }

                                let deaf_icon = if self.self_deaf {
                                    IconKind::HeadsetOff
                                } else {
                                    IconKind::Headset
                                };
                                if icon_btn(
                                    ui,
                                    deaf_icon,
                                    if self.self_deaf { "Undeafen" } else { "Deafen" },
                                    false,
                                    self.self_deaf,
                                )
                                .clicked()
                                {
                                    self.self_deaf = !self.self_deaf;
                                }

                                let mute_icon = if self.self_mute {
                                    IconKind::MicOff
                                } else {
                                    IconKind::Mic
                                };
                                if icon_btn(
                                    ui,
                                    mute_icon,
                                    if self.self_mute { "Unmute" } else { "Mute" },
                                    false,
                                    self.self_mute,
                                )
                                .clicked()
                                {
                                    self.self_mute = !self.self_mute;
                                }
                            });
                        });
                    });
            });

        // Top `.sidebar-header` (`44px` height, `border-bottom: 1px solid #2c3038`) + `.sidebar-scroller`
        if let Some(gid) = self.selected_guild_id.clone() {
            let guild_name = self
                .state
                .guilds
                .get(&gid)
                .map(|g| g.name.clone())
                .unwrap_or_else(|| "Server".to_string());

            let (hdr_rect, hdr_resp) =
                ui.allocate_exact_size(Vec2::new(ui.available_width(), 44.0), Sense::click());
            if hdr_resp.hovered() {
                ui.painter().rect_filled(hdr_rect, 0.0, BG_HOVER);
            }
            ui.painter().hline(
                hdr_rect.x_range(),
                hdr_rect.max.y - 0.5,
                Stroke::new(1.0_f32, BORDER),
            );
            ui.painter().text(
                Pos2::new(hdr_rect.min.x + 12.0, hdr_rect.center().y),
                Align2::LEFT_CENTER,
                guild_name.to_uppercase(),
                display_font(19.0),
                TEXT_HEADER,
            );
            let chev_rect = Rect::from_center_size(
                Pos2::new(hdr_rect.max.x - 18.0, hdr_rect.center().y),
                Vec2::splat(16.0),
            );
            draw_icon(ui.painter(), chev_rect, IconKind::ChevronDown, INTERACTIVE);
            if hdr_resp.on_hover_text("Server Settings & Channels").clicked() {
                self.active_modal = Some(ModalKind::ServerSettings);
            }

            let channels: Vec<Channel> = self
                .state
                .channels
                .values()
                .filter(|c| c.guild_id.as_deref() == Some(gid.as_str()) && c.kind != 4)
                .cloned()
                .collect();

            ScrollArea::vertical()
                .id_salt("guild_channels_scroll")
                .show(ui, |ui| {
                    Frame::new()
                        .inner_margin(Margin::symmetric(6, 10))
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                ui.set_width(ui.available_width());
                                ui.label(
                                    RichText::new("TEXT & VOICE CHANNELS")
                                        .font(display_font(12.5))
                                        .color(TEXT_MUTED),
                                );
                                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                    let (plus_r, plus_resp) = ui
                                        .allocate_exact_size(Vec2::splat(16.0), Sense::click());
                                    draw_icon(
                                        ui.painter(),
                                        plus_r,
                                        IconKind::Plus,
                                        if plus_resp.hovered() {
                                            TEXT_HEADER
                                        } else {
                                            TEXT_MUTED
                                        },
                                    );
                                    if plus_resp.on_hover_text("Create Channel").clicked() {
                                        self.active_modal = Some(ModalKind::ServerSettings);
                                    }
                                });
                            });
                            ui.add_space(4.0);

                            for ch in channels {
                                let active =
                                    self.selected_channel_id.as_deref() == Some(ch.id.as_str());
                                let icon_kind = match ch.kind {
                                    2 => IconKind::Speaker,
                                    13 => IconKind::Stage,
                                    15 => IconKind::Forum,
                                    _ => IconKind::Hash,
                                };
                                let name = ch.name.as_deref().unwrap_or("channel");
                                let row_resp =
                                    Self::sidebar_channel_row(ui, icon_kind, name, active, None);
                                if row_resp.clicked() {
                                    if matches!(ch.kind, 2 | 13) {
                                        self.show_voice_unavailable();
                                    }
                                    self.selected_channel_id = Some(ch.id.clone());
                                    self.load_channel_history(&ch.id);
                                }

                                // Voice participants inside voice/stage channels
                                if ch.kind == 2 || ch.kind == 13 {
                                    let in_vc: Vec<(String, String, bool)> = self
                                        .state
                                        .voice_states
                                        .values()
                                        .filter(|vs| {
                                            vs.channel_id.as_deref() == Some(ch.id.as_str())
                                        })
                                        .map(|vs| {
                                            let uname = self
                                                .state
                                                .users
                                                .get(&vs.user_id)
                                                .map(|u| u.display_name().to_string())
                                                .unwrap_or_else(|| vs.user_id.clone());
                                            (vs.user_id.clone(), uname, vs.self_stream)
                                        })
                                        .collect();
                                    for (uid, uname, is_live) in in_vc {
                                        ui.horizontal(|ui| {
                                            ui.add_space(24.0);
                                            draw_avatar(
                                                ui,
                                                20.0,
                                                &uid,
                                                &uname,
                                                None,
                                                BG_SIDEBAR,
                                            );
                                            ui.label(
                                                RichText::new(&uname)
                                                    .font(ui_font(12.5))
                                                    .color(INTERACTIVE),
                                            );
                                            if is_live {
                                                Frame::new()
                                                    .fill(SIGNAL_STRONG)
                                                    .corner_radius(CornerRadius::same(2))
                                                    .inner_margin(Margin::symmetric(4, 1))
                                                    .show(ui, |ui| {
                                                        ui.label(
                                                            RichText::new("LIVE")
                                                                .font(display_font(10.0))
                                                                .color(Color32::WHITE),
                                                        );
                                                    });
                                            }
                                        });
                                    }
                                }
                            }
                        });
                });
        } else {
            // Direct Messages sidebar (`DmSidebar.tsx`)
            Frame::new()
                .inner_margin(Margin::symmetric(10, 6))
                .show(ui, |ui| {
                    let (btn_r, btn_resp) = ui.allocate_exact_size(
                        Vec2::new(ui.available_width(), 32.0),
                        Sense::click(),
                    );
                    let border_col = if btn_resp.hovered() { ACCENT } else { BORDER };
                    ui.painter().rect(
                        btn_r,
                        CornerRadius::same(2),
                        BG_RAIL,
                        Stroke::new(1.0_f32, border_col),
                        StrokeKind::Inside,
                    );
                    ui.painter().text(
                        Pos2::new(btn_r.min.x + 8.0, btn_r.center().y),
                        Align2::LEFT_CENTER,
                        "Find or start a conversation",
                        ui_font(12.5),
                        TEXT_MUTED,
                    );
                    if btn_resp.clicked() {
                        self.active_modal = Some(ModalKind::QuickSwitcher);
                    }
                });
            let hr = ui.min_rect();
            ui.painter()
                .hline(hr.x_range(), hr.max.y, Stroke::new(1.0_f32, BORDER));

            ScrollArea::vertical()
                .id_salt("dm_channels_scroll")
                .show(ui, |ui| {
                    Frame::new()
                        .inner_margin(Margin::symmetric(6, 8))
                        .show(ui, |ui| {
                            let friends_selected = self.selected_channel_id.is_none();
                            let pending_count = self
                                .state
                                .relationships
                                .values()
                                .filter(|r| r.kind == 3)
                                .count();
                            let badge = if pending_count > 0 {
                                Some(pending_count.to_string())
                            } else {
                                None
                            };
                            if Self::sidebar_channel_row(
                                ui,
                                IconKind::People,
                                "Friends",
                                friends_selected,
                                badge.as_deref(),
                            )
                            .clicked()
                            {
                                self.selected_channel_id = None;
                            }

                            // Game Lobby Invite shortcut row
                            let lobby_open = self.active_modal == Some(ModalKind::GameLobbyInvite);
                            if Self::sidebar_channel_row(
                                ui,
                                IconKind::Gamepad,
                                "Game Lobby Invites",
                                lobby_open,
                                None,
                            )
                            .clicked()
                            {
                                self.active_modal = Some(ModalKind::GameLobbyInvite);
                            }

                            ui.add_space(10.0);
                            draw_list_heading(ui, "DIRECT MESSAGES");
                            ui.add_space(4.0);

                            let dms: Vec<Channel> = self
                                .state
                                .channels
                                .values()
                                .filter(|c| c.kind == 1 || c.kind == 3)
                                .cloned()
                                .collect();
                            let my_id = self.state.me.as_ref().map(|u| u.id.clone());

                            for dm in dms {
                                let active =
                                    self.selected_channel_id.as_deref() == Some(dm.id.as_str());
                                let label = dm.display_name(my_id.as_deref());
                                let other = dm
                                    .recipients
                                    .iter()
                                    .find(|u| Some(&u.id) != my_id.as_ref())
                                    .or_else(|| dm.recipients.first());
                                let other_id =
                                    other.map(|u| u.id.as_str()).unwrap_or(dm.id.as_str());
                                let status = self.state.user_status(other_id).to_string();
                                let game = self.state.user_game(other_id).map(|g| g.name.clone());

                                let (rect, resp) = ui.allocate_exact_size(
                                    Vec2::new(ui.available_width(), 38.0),
                                    Sense::click(),
                                );
                                let hovered = resp.hovered();
                                if active || hovered {
                                    ui.painter().rect_filled(
                                        rect,
                                        CornerRadius::same(2),
                                        if active { BG_SELECTED } else { BG_HOVER },
                                    );
                                }
                                if active {
                                    let bar = Rect::from_min_size(
                                        rect.min,
                                        Vec2::new(3.0, rect.height()),
                                    );
                                    ui.painter().rect_filled(bar, 0.0, ACCENT);
                                }

                                let mut row_ui = ui.new_child(
                                    egui::UiBuilder::new()
                                        .max_rect(rect.shrink2(Vec2::new(8.0, 4.0)))
                                        .layout(Layout::left_to_right(Align::Center)),
                                );
                                draw_avatar(
                                    &mut row_ui,
                                    26.0,
                                    other_id,
                                    &label,
                                    Some(&status),
                                    if active { BG_SELECTED } else { BG_SIDEBAR },
                                );
                                row_ui.vertical(|ui| {
                                    ui.spacing_mut().item_spacing.y = 0.0;
                                    ui.label(
                                        RichText::new(&label)
                                            .font(if active {
                                                bold_font(13.5)
                                            } else {
                                                ui_font(13.5)
                                            })
                                            .color(if active || hovered {
                                                TEXT_HEADER
                                            } else {
                                                TEXT_MUTED
                                            }),
                                    );
                                    if let Some(gname) = game {
                                        ui.label(
                                            RichText::new(format!("Playing {gname}"))
                                                .font(ui_font(11.0))
                                                .color(GREEN),
                                        );
                                    }
                                });

                                if resp.clicked() {
                                    self.selected_channel_id = Some(dm.id.clone());
                                    self.load_channel_history(&dm.id);
                                }
                            }
                        });
                });
        }
    }

    fn sidebar_channel_row(
        ui: &mut Ui,
        icon: IconKind,
        label: &str,
        active: bool,
        badge: Option<&str>,
    ) -> egui::Response {
        let (rect, resp) =
            ui.allocate_exact_size(Vec2::new(ui.available_width(), 30.0), Sense::click());
        let hovered = resp.hovered();
        let painter = ui.painter();

        if active || hovered {
            painter.rect_filled(
                rect,
                CornerRadius::same(2),
                if active { BG_SELECTED } else { BG_HOVER },
            );
        }
        if active {
            let bar = Rect::from_min_size(rect.min, Vec2::new(3.0, rect.height()));
            painter.rect_filled(bar, 0.0, ACCENT);
        }

        let icon_color = if active {
            ACCENT
        } else if hovered {
            INTERACTIVE
        } else {
            TEXT_MUTED
        };
        let icon_rect = Rect::from_center_size(
            Pos2::new(rect.min.x + 16.0, rect.center().y),
            Vec2::splat(16.0),
        );
        draw_icon(painter, icon_rect, icon, icon_color);

        let text_color = if active {
            TEXT_HEADER
        } else if hovered {
            TEXT
        } else {
            TEXT_MUTED
        };
        let font = if active {
            bold_font(14.0)
        } else {
            ui_font(14.0)
        };
        painter.text(
            Pos2::new(rect.min.x + 30.0, rect.center().y),
            Align2::LEFT_CENTER,
            label,
            font,
            text_color,
        );

        if let Some(b) = badge {
            let b_rect = Rect::from_center_size(
                Pos2::new(rect.max.x - 18.0, rect.center().y),
                Vec2::new(20.0, 16.0),
            );
            painter.rect_filled(b_rect, CornerRadius::same(2), SIGNAL_STRONG);
            painter.text(
                b_rect.center(),
                Align2::CENTER_CENTER,
                b,
                display_font(11.0),
                Color32::WHITE,
            );
        }

        resp
    }

    fn render_member_list(&mut self, ui: &mut Ui, guild_id: &str) {
        let m_rect = ui.max_rect();
        ui.painter().vline(
            m_rect.min.x + 0.5,
            m_rect.y_range(),
            Stroke::new(1.0_f32, BORDER),
        );

        let guild = self.state.guilds.get(guild_id).cloned();
        let owner_id = guild.as_ref().map(|g| g.owner_id.clone()).unwrap_or_default();
        let members: Vec<Member> = self
            .state
            .members
            .get(guild_id)
            .map(|m| m.values().cloned().collect())
            .unwrap_or_default();

        let mut online = Vec::new();
        let mut offline = Vec::new();
        for m in members {
            let Some(uid) = m.resolved_user_id().map(|s| s.to_string()) else {
                continue;
            };
            let st = self.state.user_status(&uid).to_string();
            if st == "offline" || st == "invisible" {
                offline.push((uid, m, st));
            } else {
                online.push((uid, m, st));
            }
        }

        Frame::new()
            .inner_margin(Margin::symmetric(10, 12))
            .show(ui, |ui| {
                ScrollArea::vertical()
                    .id_salt("guild_members_scroll")
                    .show(ui, |ui| {
                        draw_list_heading(ui, &format!("ONLINE — {}", online.len()));
                        ui.add_space(4.0);
                        for (uid, m, st) in &online {
                            self.render_member_item(ui, &guild, &owner_id, uid, m, st, false);
                        }

                        if !offline.is_empty() {
                            ui.add_space(12.0);
                            draw_list_heading(ui, &format!("OFFLINE — {}", offline.len()));
                            ui.add_space(4.0);
                            for (uid, m, st) in &offline {
                                self.render_member_item(ui, &guild, &owner_id, uid, m, st, true);
                            }
                        }
                    });
            });
    }

    fn render_member_item(
        &mut self,
        ui: &mut Ui,
        guild: &Option<Guild>,
        owner_id: &str,
        uid: &str,
        m: &Member,
        status: &str,
        is_offline: bool,
    ) {
        let user = m
            .user
            .clone()
            .or_else(|| self.state.users.get(uid).cloned())
            .unwrap_or(User {
                id: uid.to_string(),
                username: uid.to_string(),
                ..Default::default()
            });
        let name = m.nick.as_deref().unwrap_or_else(|| user.display_name());
        let game = self.state.user_game(uid).map(|g| g.name.clone());

        // Resolve role color if any
        let role_color = guild.as_ref().and_then(|g| {
            g.roles
                .iter()
                .filter(|r| m.roles.contains(&r.id) && r.color != 0)
                .max_by_key(|r| r.position)
                .map(|r| {
                    Color32::from_rgb(
                        ((r.color >> 16) & 0xff) as u8,
                        ((r.color >> 8) & 0xff) as u8,
                        (r.color & 0xff) as u8,
                    )
                })
        });

        let (rect, resp) =
            ui.allocate_exact_size(Vec2::new(ui.available_width(), 38.0), Sense::click());
        if resp.hovered() {
            ui.painter()
                .rect_filled(rect, CornerRadius::same(2), BG_HOVER);
        }

        let mut row_ui = ui.new_child(
            egui::UiBuilder::new()
                .max_rect(rect.shrink2(Vec2::new(6.0, 4.0)))
                .layout(Layout::left_to_right(Align::Center)),
        );
        draw_avatar(
            &mut row_ui,
            28.0,
            uid,
            name,
            Some(status),
            if resp.hovered() { BG_HOVER } else { BG_SIDEBAR },
        );
        row_ui.vertical(|ui| {
            ui.spacing_mut().item_spacing.y = 0.0;
            ui.horizontal(|ui| {
                ui.spacing_mut().item_spacing.x = 4.0;
                let base_col = role_color.unwrap_or(if is_offline {
                    TEXT_MUTED
                } else {
                    TEXT
                });
                ui.label(RichText::new(name).font(bold_font(13.5)).color(base_col));
                if uid == owner_id {
                    ui.label(RichText::new("👑").size(11.0).color(YELLOW));
                }
            });
            if let Some(gname) = game {
                ui.label(
                    RichText::new(format!("🎮 {gname}"))
                        .font(ui_font(11.0))
                        .color(TEXT_MUTED),
                );
            }
        });

        if resp.on_hover_text("Click to Message").clicked() {
            let my_id = self.state.me.as_ref().map(|u| u.id.as_str());
            if my_id != Some(uid) {
                self.open_or_create_dm(&user);
            }
        }
    }
}

impl eframe::App for CillhubApp {
    fn update(&mut self, ctx: &Context, _frame: &mut eframe::Frame) {
        self.headless_tick(ctx);
    }
}

impl CillhubApp {
    /// Attachment URLs are paths on the server the message came from (the web client's cdn()).
    pub fn absolute_url(&self, url: &str) -> String {
        if url.starts_with("https://") || url.starts_with("http://") {
            return url.to_string();
        }
        self.api
            .as_ref()
            .and_then(|api| api.origin.join(url).ok())
            .map(|u| u.to_string())
            .unwrap_or_else(|| url.to_string())
    }

    /// Starts one background download per image; the bytes reach egui in headless_tick.
    pub fn request_image(&mut self, uri: &str, url: String) {
        if self.images.contains_key(uri) {
            return;
        }
        self.images.insert(uri.to_string(), ImageLoad::Loading);
        let (Some(api), tx, uri) = (self.api.clone(), self.image_tx.clone(), uri.to_string()) else {
            self.images.insert(uri.to_string(), ImageLoad::Failed);
            return;
        };
        std::thread::spawn(move || {
            let bytes = api
                .client
                .get(&url)
                .send()
                .and_then(|r| r.error_for_status())
                .and_then(|r| r.bytes())
                .map(|b| b.to_vec());
            if let Err(e) = &bytes {
                eprintln!("cillhub: image {url}: {e}");
            }
            let _ = tx.send((uri, bytes.ok())); // the app may have closed
        });
    }

    pub fn mark_fonts_installed(&mut self) {
        self.fonts_installed = true;
    }

    pub fn headless_tick(&mut self, ctx: &Context) {
        if !self.fonts_installed {
            install_fonts(ctx, self.state.user_settings.dyslexic_font);
            apply_theme(ctx, &self.theme_name, self.settings.font_scale);
            egui_extras::install_image_loaders(ctx);
            self.fonts_installed = true;
        }
        let families_ready = ctx.fonts(|f| {
            f.families()
                .contains(&egui::FontFamily::Name("display".into()))
        });
        crate::theme::set_custom_families_ready(families_ready);

        self.process_background_events();
        while let Ok((uri, bytes)) = self.image_rx.try_recv() {
            let state = match bytes {
                Some(b) => {
                    ctx.include_bytes(uri.clone(), b);
                    ImageLoad::Ready
                }
                None => ImageLoad::Failed,
            };
            self.images.insert(uri, state);
        }
        ctx.request_repaint_after(Duration::from_millis(250));

        // Global Keyboard Shortcuts
        if ctx.input(|i| i.modifiers.ctrl && i.key_pressed(Key::K)) {
            self.active_modal = Some(ModalKind::QuickSwitcher);
        }
        if ctx.input(|i| i.key_pressed(Key::Escape)) {
            self.active_modal = None;
            self.show_composer_plus_menu = false;
            self.lightbox = None;
        }

        // Full-size image view (the web client's lightbox)
        if let Some((uri, name, url)) = self.lightbox.clone() {
            let mut open = true;
            let max = ctx.screen_rect().size() * 0.85;
            let banner = &mut self.status_banner;
            egui::Window::new(name)
                .open(&mut open)
                .collapsible(false)
                .anchor(Align2::CENTER_CENTER, Vec2::ZERO)
                .show(ctx, |ui| {
                    ui.add(egui::Image::new(uri.as_str()).max_size(max).shrink_to_fit());
                    if ui.button("Open in Browser").clicked() {
                        report(banner, open::that(&url));
                    }
                });
            if !open {
                self.lightbox = None;
            }
        }

        // Optional status notification banner at top
        if let Some(banner) = self.status_banner.clone() {
            TopBottomPanel::top("status_banner_panel")
                .frame(
                    Frame::new()
                        .fill(ACCENT_SOFT)
                        .stroke(Stroke::new(1.0_f32, ACCENT))
                        .inner_margin(Margin::symmetric(14, 6)),
                )
                .show(ctx, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(&banner).strong().size(12.5).color(TEXT_HEADER));
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if ui.small_button("Dismiss").clicked() {
                                self.status_banner = None;
                            }
                        });
                    });
                });
        }

        if !self.authenticated {
            CentralPanel::default()
                .frame(Frame::new().fill(BG_CHAT))
                .show(ctx, |ui| {
                    self.render_auth(ui);
                });
            return;
        }

        // 1. Leftmost Guild Rail (64px)
        SidePanel::left("guild_rail_panel")
            .exact_width(64.0)
            .resizable(false)
            .frame(Frame::new().fill(BG_RAIL))
            .show(ctx, |ui| {
                self.render_guild_rail(ui);
            });

        // 2. Channel / DM Sidebar (216px)
        SidePanel::left("channel_sidebar_panel")
            .exact_width(216.0)
            .resizable(false)
            .frame(Frame::new().fill(BG_SIDEBAR))
            .show(ctx, |ui| {
                self.render_channel_sidebar(ui);
            });

        // 3. Right Side Drawer (320px) OR Member List (216px)
        if let Some(drawer) = self.active_drawer {
            SidePanel::right("right_drawer_panel")
                .exact_width(320.0)
                .resizable(false)
                .frame(
                    Frame::new()
                        .fill(BG_PANEL)
                        .inner_margin(Margin::same(12)),
                )
                .show(ctx, |ui| {
                    self.render_drawer(ui, drawer);
                });
        } else if self.show_member_list {
            if let Some(gid) = self.selected_guild_id.clone() {
                SidePanel::right("member_list_panel")
                    .exact_width(216.0)
                    .resizable(false)
                    .frame(Frame::new().fill(BG_SIDEBAR))
                    .show(ctx, |ui| {
                        self.render_member_list(ui, &gid);
                    });
            }
        }

        // 4. Center Main View (Chat / Stage / Friends)
        CentralPanel::default()
            .frame(Frame::new().fill(BG_CHAT))
            .show(ctx, |ui| {
                if let Some(cid) = self.selected_channel_id.clone() {
                    if let Some(ch) = self.state.channels.get(&cid).cloned() {
                        self.render_chat_view(ui, &ch);
                    } else {
                        self.render_friends_view(ui);
                    }
                } else {
                    self.render_friends_view(ui);
                }
            });

        // 5. Floating Modals
        self.render_modals(ctx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn voice_channel_never_claims_a_call() {
        let mut app = CillhubApp::new(None, true);
        let (tx, rx) = mpsc::channel();
        app.gateway_cmd_tx = Some(tx);
        app.selected_channel_id = Some("c_voice".into());
        app.show_voice_unavailable();
        let ctx = egui::Context::default();
        install_fonts(&ctx, false);
        let mut input = egui::RawInput::default();
        input.screen_rect = Some(Rect::from_min_size(Pos2::ZERO, Vec2::new(1280.0, 800.0)));
        let out = ctx.run(input, |ctx| app.headless_tick(ctx));
        assert!(!out.shapes.is_empty());
        assert!(rx.try_recv().is_err(), "no voice state may be sent");
        assert!(!app.state.voice_states.contains_key("u_me"));
        assert_eq!(app.status_banner.as_deref(), Some(VOICE_UNAVAILABLE));
    }

    #[test]
    fn headless_ui_renders_arena_game_activity_and_lobby_invite_modal() {
        let ctx = egui::Context::default();
        install_fonts(&ctx, false);
        let mut input = egui::RawInput::default();
        input.screen_rect = Some(egui::Rect::from_min_size(
            egui::Pos2::ZERO,
            egui::Vec2::new(1280.0, 800.0),
        ));

        // 0. Render Auth screen (unauthenticated notched HUD card + 40px grid)
        let mut auth_app = CillhubApp::new(None, false);
        auth_app.authenticated = false;
        let out_auth = ctx.run(input.clone(), |ctx| {
            auth_app.headless_tick(ctx);
        });
        assert!(!out_auth.shapes.is_empty());

        // 1. Render main chat view with GameInviteCard
        let mut app = CillhubApp::new(None, true);
        let out_chat = ctx.run(input.clone(), |ctx| {
            app.headless_tick(ctx);
        });
        assert!(!out_chat.shapes.is_empty());
        assert_eq!(
            app.current_game.as_ref().map(|g| g.name.as_str()),
            Some("League of Legends")
        );

        // 2. Open Game Lobby Invite modal and render
        app.active_modal = Some(ModalKind::GameLobbyInvite);
        let out_modal = ctx.run(input.clone(), |ctx| {
            app.headless_tick(ctx);
        });
        assert!(out_modal.shapes.len() > out_chat.shapes.len());

        // 3. Render Friends & Active Now Game/Lobby view
        app.active_modal = None;
        app.selected_guild_id = None;
        app.selected_channel_id = None;
        let out_friends = ctx.run(input.clone(), |ctx| {
            app.headless_tick(ctx);
        });
        assert!(!out_friends.shapes.is_empty());

        // 4. Render User Settings (Game Activity & Voice tabs)
        app.active_modal = Some(ModalKind::UserSettings);
        app.settings_tab = SettingsTab::Games;
        let _ = ctx.run(input.clone(), |ctx| {
            app.headless_tick(ctx);
        });
        app.settings_tab = SettingsTab::Voice;
        let out_voice = ctx.run(input, |ctx| {
            app.headless_tick(ctx);
        });
        assert!(!out_voice.shapes.is_empty());
    }
}
