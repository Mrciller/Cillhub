//! Pure-Rust native Cillhub Arena desktop UI (`egui` / `eframe`).
//! No Tauri, no WebView, no JavaScript frontend.

pub mod auth;
pub mod background;
pub mod chat;
pub mod friends;
pub mod images;
pub mod modals;
pub mod settings_view;

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
use crate::i18n::tr;
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
/// The only way a URL reaches the OS opener: http(s) after resolving, never file:, smb: or an app's custom scheme.
pub fn open_external(banner: &mut Option<String>, url: &str) {
    match crate::markdown::safe_url(url) {
        Some(u) => {
            report(banner, open::that(u));
        }
        None => *banner = Some(tr("Only web links can be opened.").to_string()),
    }
}

/// Messages of a GET /channels/{id}/messages answer (newest first) in reading order.
pub fn parse_messages(val: &Value) -> Vec<Message> {
    let items = val.as_array().map(|a| a.iter().rev()).into_iter().flatten();
    items
        .filter_map(|item| {
            crate::model::parse::<Message>(item.clone())
                .map_err(|e| eprintln!("cillhub: skipped message: {e}"))
                .ok()
        })
        .collect()
}

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

#[derive(Debug, Clone, Default, PartialEq)]
pub struct SearchResults {
    pub query: String,
    pub total: usize,
    pub hits: Vec<Message>,
    pub loading: bool,
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


#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModalKind {
    UserSettings,
    ServerSettings,
    CreateJoinGuild,
    CreatePoll,
    SendLater,
    QuickSwitcher,
    CreateChannel,
    Events,
}

/// What a sidebar row shows before its name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RowIcon {
    Hash,
    Icon(IconKind),
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DrawerKind {
    Threads,
    Pins,
    Saved,
    Search,
    Canvas,
}

pub use settings_view::{ServerTab, SettingsTab};

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
    /// GET /instance of the picked server (registration mode), and which server it is for.
    pub instance_info: Option<Value>,
    instance_for: String,

    // Navigation & View state
    pub selected_guild_id: Option<String>,
    pub selected_channel_id: Option<String>,
    pub friends_tab: FriendsTab,
    pub add_friend_input: String,
    /// Result line under Add Friend: (ok, text).
    pub add_friend_result: Option<(bool, String)>,
    pub show_member_list: bool,
    pub active_modal: Option<ModalKind>,
    pub active_drawer: Option<DrawerKind>,
    pub settings_tab: SettingsTab,
    pub server_tab: ServerTab,
    pub role_draft: Option<Role>,
    pub account_name_draft: Option<String>,
    pub guild_name_draft: Option<String>,
    pub status_banner: Option<String>,

    // Chat & Composer state
    pub composer_text: String,
    /// Inline image attachments by egui URI; bytes arrive from fetch threads.
    pub images: std::collections::HashMap<String, ImageLoad>,
    image_jobs: Sender<(String, String)>,
    image_rx: Receiver<(String, Option<Vec<u8>>)>,
    image_cache: images::Cache,
    /// Full-size image view: (egui URI, file name, absolute URL).
    pub lightbox: Option<(String, String, String)>,
    pub bg: background::Workers,
    /// Bumped by login and logout; background results of an older session are dropped.
    session_gen: u64,
    /// Channels whose history request is in flight.
    loading_history: std::collections::HashSet<String>,
    /// Set by logout: the next frame drops every image egui holds.
    forget_images: bool,
    /// Results of the file dialog, which runs off the UI thread (a stuck portal must not freeze the app).
    pub picked_tx: Sender<Vec<std::path::PathBuf>>,
    picked_rx: Receiver<Vec<std::path::PathBuf>>,
    /// Files picked or dropped, sent with the next message.
    pub pending_files: Vec<std::path::PathBuf>,
    pub show_composer_plus_menu: bool,
    pub plus_anchor: Pos2,
    pub poll_answers: Vec<String>,
    pub poll_hours: u32,
    pub poll_multi: bool,
    pub reply_to_message: Option<Message>,
    pub editing_message_id: Option<String>,
    /// Spoilers clicked open: (message id, spoiler index).
    pub revealed_spoilers: std::collections::HashSet<(String, u16)>,
    /// Parsed message Markdown by content: (made at, for guild, blocks).
    #[allow(clippy::type_complexity)]
    md_cache: (Instant, Option<String>, std::collections::HashMap<String, std::rc::Rc<Vec<crate::markdown::Block>>>),
    /// Message whose toolbar was shown last frame (keeps it while the pointer is on the toolbar).
    pub toolbar_msg: Option<String>,
    /// Open "More" menu: (message id, anchor).
    pub msg_menu: Option<(String, Pos2)>,
    pub emoji_picker: Option<(chat::EmojiTarget, Pos2)>,
    pub emoji_query: String,
    pub confirm_delete: Option<Message>,
    /// Categories folded in the channel list.
    pub collapsed_categories: std::collections::HashSet<String>,
    /// Edit Category dialog: (channel id, name being edited).
    pub edit_channel: Option<(String, String)>,
    /// Create Channel dialog: parent category and channel type.
    pub create_channel_parent: Option<String>,
    pub create_channel_kind: u8,
    /// Scheduled events of the open server (Events dialog).
    pub events: Vec<Value>,
    pub search_query: String,
    /// The server's answer to the last search.
    pub search: Option<SearchResults>,
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
    /// A League request is running (started then); it has a 5 s timeout.
    league_busy_since: Option<Instant>,
    pub lobby_form_game: String,
    pub lobby_form_queue: String,
    pub lobby_form_host: String,
    pub lobby_form_party_id: String,
    /// A game invite from a deep link, waiting for the user to click Join.
    pub pending_game_invite: Option<GameInviteData>,
    pub lobby_form_members: u32,
    pub lobby_form_max_members: u32,
    pub custom_game_exe_input: String,
    pub custom_game_name_input: String,

    // Modals & Settings inputs
    pub my_status: String,
    pub custom_status_input: String,
    pub theme_name: String,
    theme_applied: String,
    pub locale: String,
    pub new_guild_name_input: String,
    pub join_invite_code_input: String,
    pub new_channel_name_input: String,
    pub poll_question_input: String,
    pub poll_options_input: String,
    pub schedule_time_input: String,
    /// A downloaded installer that passed update::accept: (version, path).
    pub update_ready: Option<crate::update::Staged>,
    update_rx: Option<Receiver<Result<Option<crate::update::Staged>, String>>>,
    last_update_check: Option<Instant>,
    update_dismissed_until: Option<Instant>,

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
        let (image_tx, image_rx) = mpsc::channel();
        let (picked_tx, picked_rx) = mpsc::channel();
        let (theme_name, locale) = (settings.theme.clone(), settings.locale.clone());
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
            instance_info: None,
            instance_for: String::new(),
            selected_guild_id: None,
            selected_channel_id: None,
            friends_tab: FriendsTab::Online,
            add_friend_input: String::new(),
            add_friend_result: None,
            show_member_list: true,
            active_modal: None,
            active_drawer: None,
            settings_tab: SettingsTab::Account,
            server_tab: ServerTab::Overview,
            role_draft: None,
            account_name_draft: None,
            guild_name_draft: None,
            status_banner: None,
            composer_text: String::new(),
            pending_files: Vec::new(),
            picked_tx,
            picked_rx,
            images: Default::default(),
            image_jobs: images::spawn_workers(image_tx),
            image_rx,
            image_cache: images::Cache::default(),
            lightbox: None,
            forget_images: false,
            bg: background::Workers::new(),
            session_gen: 0,
            loading_history: Default::default(),
            md_cache: (Instant::now(), None, Default::default()),
            show_composer_plus_menu: false,
            plus_anchor: Pos2::ZERO,
            poll_answers: vec![String::new(), String::new()],
            poll_hours: 24,
            poll_multi: false,
            reply_to_message: None,
            editing_message_id: None,
            revealed_spoilers: Default::default(),
            toolbar_msg: None,
            msg_menu: None,
            emoji_picker: None,
            emoji_query: String::new(),
            confirm_delete: None,
            collapsed_categories: Default::default(),
            edit_channel: None,
            create_channel_parent: None,
            create_channel_kind: 0,
            events: Vec::new(),
            search_query: String::new(),
            search: None,
            quick_switcher_query: String::new(),
            canvas_doc_input: String::new(),
            self_mute: false,
            self_deaf: false,
            self_video: false,
            self_stream: false,
            game_tracker: tracker,
            current_game: initial_game,
            last_game_scan: Instant::now(),
            league_lobby: None,
            league_busy_since: None,
            last_league_scan: Instant::now(),
            lobby_form_game: "League of Legends".to_string(),
            lobby_form_queue: "Ranked Solo/Duo".to_string(),
            lobby_form_host: String::new(),
            lobby_form_party_id: "arena-party-77".to_string(),
            pending_game_invite: None,
            lobby_form_members: 2,
            lobby_form_max_members: 5,
            custom_game_exe_input: String::new(),
            custom_game_name_input: String::new(),
            my_status: "online".to_string(),
            custom_status_input: String::new(),
            theme_name,
            theme_applied: String::new(),
            locale,
            new_guild_name_input: String::new(),
            join_invite_code_input: String::new(),
            new_channel_name_input: String::new(),
            poll_question_input: "Which game mode tonight?".to_string(),
            poll_options_input: "League Ranked 5v5, Counter-Strike 2, Valorant".to_string(),
            schedule_time_input: "2026-11-10T22:00:00Z".to_string(),
            update_ready: None,
            update_rx: None,
            last_update_check: None,
            update_dismissed_until: None,
            local_counter: 100,
            fonts_installed: false,
        };

        app.poll_league_lobby();
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
                // shown first: only the user's click on Join accepts it
                DeepLinkTarget::GameInvite(invite) => self.pending_game_invite = Some(invite),
            }
        }
    }

    pub fn complete_login(&mut self, origin: Url, token: String) {
        self.new_session();
        report(&mut self.status_banner, self.settings.set_token(Some(&token)));
        self.api = Some(ApiClient::new(origin.clone(), Some(token.clone())));
        let (ev_tx, ev_rx) = mpsc::channel();
        let (cmd_tx, cmd_rx) = mpsc::channel();
        spawn_with_commands(origin, token, ev_tx, cmd_rx);
        self.gateway_rx = Some(ev_rx);
        self.gateway_cmd_tx = Some(cmd_tx);
        self.authenticated = true;
        self.auth_error = None;
        self.clear_auth_secrets();
        self.broadcast_presence();
    }

    /// Nothing that could log in again stays in memory once it has been used.
    fn clear_auth_secrets(&mut self) {
        self.auth_password_input.clear();
        self.auth_mfa_ticket.clear();
        self.auth_mfa_code.clear();
        self.auth_reset_token.clear();
    }

    pub fn logout(&mut self) {
        self.new_session();
        self.loading_history.clear();
        if let Some(tx) = &self.gateway_cmd_tx {
            let _ = tx.send(GatewayCommand::Shutdown);
        }
        self.gateway_rx = None;
        self.gateway_cmd_tx = None;
        self.api = None;
        self.authenticated = false;
        // nothing of this account may show up in the next session
        self.state = State::default();
        self.selected_guild_id = None;
        self.selected_channel_id = None;
        self.reply_to_message = None;
        self.editing_message_id = None;
        self.pending_files.clear();
        self.composer_text.clear();
        report(&mut self.status_banner, self.settings.set_token(None));
        self.active_modal = None;
        self.clear_auth_secrets();
        self.auth_login_input.clear();
        self.auth_email_input.clear();
        self.auth_mode = AuthMode::Login;
        // account-bound views and caches
        self.lightbox = None;
        self.images.clear();
        self.image_cache = images::Cache::default();
        self.forget_images = true;
        self.revealed_spoilers.clear();
        self.msg_menu = None;
        self.emoji_picker = None;
        self.confirm_delete = None;
        self.edit_channel = None;
        self.toolbar_msg = None;
        self.active_drawer = None;
        self.role_draft = None;
        self.account_name_draft = None;
        self.guild_name_draft = None;
        self.add_friend_input.clear();
        self.add_friend_result = None;
        self.events.clear();
        self.search_query.clear();
        self.search = None;
        self.quick_switcher_query.clear();
        self.canvas_doc_input.clear();
        self.custom_status_input.clear();
        self.pending_game_invite = None;
        self.show_composer_plus_menu = false;
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

    /// Asks the local League client for its lobby, in the background.
    pub fn poll_league_lobby(&mut self) {
        self.last_league_scan = Instant::now();
        if self.league_busy_since.is_some_and(|t| t.elapsed() < Duration::from_secs(15)) {
            return;
        }
        self.league_busy_since = Some(Instant::now());
        let procs = self.game_tracker.last_processes().to_vec();
        self.spawn_bg(
            false,
            move || {
                let creds = find_lockfile_path(&procs).and_then(|p| read_lockfile(&p))?;
                LeagueClient::new().ok()?.fetch_lobby(&creds).ok()
            },
            |app, lobby| {
                app.league_busy_since = None;
                if let Some(lobby) = lobby {
                    app.league_lobby = lobby;
                }
            },
        );
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

    /// Join Party on a game invite card: accepts the invite in the local League client, like the
    /// web's desktop bridge (acceptLeagueInvite).
    pub fn join_game_party(&mut self, invite: &GameInviteData) {
        self.pending_game_invite = None;
        let (procs, party_id, game) = (self.game_tracker.last_processes().to_vec(), invite.party_id.clone(), invite.game.clone());
        self.spawn_bg(
            false,
            move || {
                let creds = find_lockfile_path(&procs).and_then(|p| read_lockfile(&p));
                let client = creds.and_then(|creds| LeagueClient::new().ok().map(|c| (c, creds)));
                client.map(|(c, creds)| c.accept_invite(&creds, &party_id))
            },
            move |app, r| {
                app.status_banner = Some(match r {
                    Some(Ok(_)) => crate::i18n::trf("Joining {game} lobby...", &[("game", &game)]),
                    Some(Err(e)) => e,
                    None => tr("Could not join lobby. Ensure League of Legends is running.").to_string(),
                });
            },
        );
    }

    /// Voice calls need audio I/O and the hub's media transport, which this app does not have
    /// yet. It does not send a voice state either: others would see a silent member.
    pub fn show_voice_unavailable(&mut self) {
        self.status_banner = Some(tr(VOICE_UNAVAILABLE).to_string());
    }

    pub fn load_channel_history(&mut self, channel_id: &str) {
        if self.state.messages.contains_key(channel_id) || !self.loading_history.insert(channel_id.to_string()) {
            return;
        }
        let cid = channel_id.to_string();
        let sent = self.api_get(format!("/channels/{cid}/messages?limit=50"), move |app, r| {
            app.loading_history.remove(&cid);
            if let Some(list) = report(&mut app.status_banner, r).map(|v| parse_messages(&v)) {
                app.state.set_history(cid, list);
            }
        });
        if !sent {
            self.loading_history.remove(channel_id);
        }
    }

    /// READY has no member lists; fetch them like the web client (GET /guilds/{id}/members).
    pub fn load_members(&mut self, guild_id: &str) {
        let gid = guild_id.to_string();
        self.api_get(format!("/guilds/{gid}/members?limit=1000"), move |app, r| {
            if let Some(list) = report(&mut app.status_banner, r) {
                report(&mut app.status_banner, app.state.set_members(&gid, list));
            }
        });
    }

    pub fn load_older_messages(&mut self, channel_id: &str) {
        let oldest = self.state.messages.get(channel_id).and_then(|l| l.first()).map(|m| m.id.clone());
        let Some(before) = oldest else { return };
        let cid = channel_id.to_string();
        self.api_get(format!("/channels/{cid}/messages?limit=50&before={before}"), move |app, r| {
            let Some(mut older) = report(&mut app.status_banner, r).map(|v| parse_messages(&v)) else { return };
            for m in &older {
                if let Some(a) = &m.author {
                    app.state.users.entry(a.id.clone()).or_insert_with(|| a.clone());
                }
            }
            // still the same window (no reload in between)
            if let Some(existing) = app.state.messages.get_mut(&cid).filter(|l| l.first().is_some_and(|m| m.id == before)) {
                older.append(existing);
                *existing = older;
            }
        });
    }

    pub fn load_pins(&mut self, channel_id: &str) {
        let cid = channel_id.to_string();
        self.api_get(format!("/channels/{cid}/pins"), move |app, r| {
            let Some(val) = report(&mut app.status_banner, r) else { return };
            let ids: Vec<&str> = val.as_array().into_iter().flatten().filter_map(|p| p.get("id").and_then(Value::as_str)).collect();
            for m in app.state.messages.get_mut(&cid).into_iter().flatten() {
                if ids.contains(&m.id.as_str()) {
                    m.pinned = true;
                }
            }
        });
    }

    /// The server's message search (guild-wide in a server, the channel in a DM), 25 hits per page.
    /// `more` fetches the next page of the current query.
    pub fn run_search(&mut self, more: bool) {
        let q = if more { self.search.as_ref().map(|s| s.query.clone()).unwrap_or_default() } else { self.search_query.trim().to_string() };
        let Some(cid) = self.selected_channel_id.clone() else { return };
        if q.is_empty() || self.api.is_none() {
            return;
        }
        let offset = if more { self.search.as_ref().map_or(0, |s| s.hits.len()) } else { 0 };
        if !more {
            self.search = Some(SearchResults { query: q.clone(), ..Default::default() });
        }
        if let Some(s) = self.search.as_mut() {
            s.loading = true;
        }
        let encoded = percent_encoding::utf8_percent_encode(&q, percent_encoding::NON_ALPHANUMERIC).to_string();
        let scope = match &self.selected_guild_id {
            Some(gid) => format!("/guilds/{gid}"),
            None => format!("/channels/{cid}"),
        };
        self.api_get(format!("{scope}/messages/search?content={encoded}&offset={offset}"), move |app, r| {
            let Some(s) = app.search.as_mut().filter(|s| s.query == q) else { return };
            s.loading = false;
            let Some(v) = report(&mut app.status_banner, r) else { return };
            s.total = v.get("total_results").and_then(Value::as_u64).unwrap_or(0) as usize;
            // each hit is [message, ...context]
            let hits = v.get("messages").and_then(Value::as_array).into_iter().flatten().filter_map(|h| h.get(0));
            for m in hits.filter_map(|m| crate::model::parse::<Message>(m.clone()).ok()) {
                if !s.hits.iter().any(|h| h.id == m.id) {
                    s.hits.push(m);
                }
            }
        });
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
                    if (is_ready || name == "USER_SETTINGS_UPDATE")
                        && self.settings.adopt_server_appearance(&self.state.user_settings)
                    {
                        self.theme_name = self.settings.theme.clone();
                        self.locale = self.settings.locale.clone();
                        report(&mut self.status_banner, self.settings.save());
                    }
                    if is_ready {
                        let ids: Vec<String> = self.state.guilds.keys().cloned().collect();
                        ids.iter().for_each(|id| self.load_members(id));
                    }
                    if let Some(id) = new_guild {
                        self.load_members(&id);
                    }
                    if is_ready {
                        // READY replaced the state: keep a selection that still exists and load its history again
                        let gone = |c: &Option<String>, ok: &dyn Fn(&str) -> bool| c.as_deref().is_some_and(|c| !ok(c));
                        if gone(&self.selected_guild_id, &|g| self.state.guilds.contains_key(g))
                            || gone(&self.selected_channel_id, &|c| self.state.channels.contains_key(c))
                        {
                            self.selected_guild_id = None;
                            self.selected_channel_id = None;
                        }
                        if let Some(cid) = self.selected_channel_id.clone() {
                            self.load_channel_history(&cid);
                        }
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
                    self.status_banner = Some(crate::i18n::trf("Gateway reconnecting: {error}", &[("error", &err.to_string())]));
                }
                GatewayEvent::RejectedToken => {
                    self.logout();
                    self.auth_error = Some(tr("Session expired. Please log in again.").to_string());
                }
                GatewayEvent::Connected => {
                    self.status_banner = None;
                }
            }
        }

        self.poll_update();
        self.maybe_check_for_update(self.api.is_none() && self.authenticated);
        if self.last_game_scan.elapsed() >= Duration::from_secs(5) {
            self.poll_game_activity(false);
        }
        if self.last_league_scan.elapsed() >= Duration::from_secs(4) {
            self.poll_league_lobby();
        }
    }

    /// `.rail` (GuildRail.tsx): Direct Messages, separator, servers, add a server. No download
    /// entry (this is the desktop app) and no Explore servers (no directory in this app yet).
    fn render_guild_rail(&mut self, ui: &mut Ui) {
        let rail_rect = ui.max_rect();
        ui.painter().vline(
            rail_rect.max.x - 0.5,
            rail_rect.y_range(),
            Stroke::new(1.0_f32, BORDER().gamma_multiply(0.65)),
        );

        ui.vertical_centered(|ui| {
            ui.spacing_mut().item_spacing.y = 6.0;
            ui.add_space(10.0);

            let home_active = self.selected_guild_id.is_none();
            let home_resp = Self::rail_icon_slot(ui, rail_rect.min.x, home_active, false, |painter, rect, fg| {
                draw_icon(painter, Rect::from_center_size(rect.center(), Vec2::splat(26.0)), IconKind::Home, fg);
            });
            if home_resp.on_hover_text(tr("Direct Messages")).clicked() {
                self.selected_guild_id = None;
                self.selected_channel_id = None;
            }

            // `.rail-sep`: 32x1, 2px margin
            let (sep_rect, _) = ui.allocate_exact_size(Vec2::new(32.0, 5.0), Sense::hover());
            ui.painter().hline(sep_rect.x_range(), sep_rect.center().y, Stroke::new(1.0_f32, BORDER()));

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
                    painter.text(rect.center(), Align2::CENTER_CENTER, &abbr, display_font(20.0), fg);
                });
                if resp.on_hover_text(&gname).clicked() {
                    self.open_guild(&gid);
                }
            }

            let add_resp = Self::rail_icon_slot(ui, rail_rect.min.x, false, true, |painter, rect, fg| {
                draw_icon(painter, Rect::from_center_size(rect.center(), Vec2::splat(24.0)), IconKind::Plus, fg);
            });
            if add_resp.on_hover_text(tr("Add a server")).clicked() {
                self.active_modal = Some(ModalKind::CreateJoinGuild);
            }

        });
    }

    /// Opens a server at its first text channel (web firstText: the system channel if visible).
    pub fn open_guild(&mut self, gid: &str) {
        self.selected_guild_id = Some(gid.to_string());
        let groups = self.sidebar_groups(gid);
        let texts: Vec<&Channel> = groups.iter().flat_map(|(_, l)| l).filter(|c| matches!(c.kind, 0 | 5)).collect();
        let sys = self.state.guilds.get(gid).and_then(|g| g.system_channel_id.clone());
        let pick = texts.iter().find(|c| Some(&c.id) == sys.as_ref()).or(texts.first()).map(|c| c.id.clone());
        if let Some(cid) = pick {
            self.selected_channel_id = Some(cid.clone());
            self.load_channel_history(&cid);
        }
    }

    /// `.rail-icon` (46px, radius 4, card fill) with the `.rail-item::before` pill.
    fn rail_icon_slot(
        ui: &mut Ui,
        rail_left_x: f32,
        active: bool,
        is_add: bool,
        paint_inner: impl FnOnce(&egui::Painter, Rect, Color32),
    ) -> egui::Response {
        let (rect, resp) = ui.allocate_exact_size(Vec2::splat(46.0), Sense::click());
        let hovered = resp.hovered();
        if hovered {
            ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
        }
        let painter = ui.painter();
        let r = if hovered && !active { rect.translate(Vec2::new(0.0, -2.0)) } else { rect };
        if is_add {
            // `.rail-add`: online colour, dashed border, faint green fill
            let fill = if hovered { GREEN().gamma_multiply(0.16).blend(BG_SELECTED().gamma_multiply(0.84)) } else { GREEN().gamma_multiply(0.06).blend(BG_CARD().gamma_multiply(0.94)) };
            painter.rect_filled(r, CornerRadius::same(4), fill);
            let border = GREEN().gamma_multiply(0.4).blend(BORDER().gamma_multiply(0.6));
            if hovered {
                painter.rect_stroke(r, CornerRadius::same(4), Stroke::new(1.0_f32, border), StrokeKind::Inside);
            } else {
                let q = r.shrink(0.5);
                let pts = [q.left_top(), q.right_top(), q.right_bottom(), q.left_bottom(), q.left_top()];
                painter.extend(egui::Shape::dashed_line(&pts, Stroke::new(1.0_f32, border), 3.0, 3.0));
            }
            paint_inner(painter, r, GREEN());
            return resp;
        }
        let (fill, fg) = if active || hovered { (BG_SELECTED(), TEXT_HEADER()) } else { (BG_CARD(), TEXT()) };
        painter.rect_filled(r, CornerRadius::same(4), fill);
        if active {
            painter.rect_stroke(r, CornerRadius::same(4), Stroke::new(2.0_f32, ACCENT()), StrokeKind::Inside);
        }
        if active || hovered {
            let (h, c) = if active { (38.0, ACCENT()) } else { (18.0, TEXT_MUTED()) };
            let pill = Rect::from_min_size(Pos2::new(rail_left_x, rect.center().y - h * 0.5), Vec2::new(3.0, h));
            painter.rect_filled(pill, 0.0, c);
        }
        paint_inner(painter, r, fg);
        resp
    }

    /// Channel groups like the web's sidebar(): uncategorized first, then categories by
    /// position; text-like channels above voice; no threads; only channels I can view.
    pub fn sidebar_groups(&self, gid: &str) -> Vec<(Option<Channel>, Vec<Channel>)> {
        use crate::permissions::{has, is_thread, p};
        let snow = |id: &str| id.parse::<u64>().unwrap_or(u64::MAX);
        let all: Vec<&Channel> = self
            .state
            .channels
            .values()
            .filter(|c| c.guild_id.as_deref() == Some(gid) && !is_thread(c))
            .collect();
        let view = |c: &Channel| has(self.my_perms(&c.id), p::VIEW_CHANNEL);
        let mut cats: Vec<&Channel> = all.iter().copied().filter(|c| c.kind == 4).collect();
        cats.sort_by_key(|c| (c.position, snow(&c.id)));
        let cat_ids: std::collections::HashSet<&str> = cats.iter().map(|c| c.id.as_str()).collect();
        let children = |id: Option<&str>| {
            let mut v: Vec<Channel> = all
                .iter()
                .filter(|c| c.kind != 4)
                .filter(|c| match id {
                    Some(id) => c.parent_id.as_deref() == Some(id),
                    None => c.parent_id.as_deref().is_none_or(|p| !cat_ids.contains(p)),
                })
                .filter(|c| view(c))
                .map(|c| (*c).clone())
                .collect();
            v.sort_by_key(|c| (matches!(c.kind, 2 | 13), c.position, snow(&c.id)));
            v
        };
        let mut groups = vec![(None, children(None))];
        for cat in cats {
            let ch = children(Some(&cat.id));
            if !ch.is_empty() || view(cat) {
                groups.push((Some(cat.clone()), ch));
            }
        }
        groups
    }

    fn render_channel_sidebar(&mut self, ui: &mut Ui) {
        let sb_rect = ui.max_rect();
        ui.painter().vline(
            sb_rect.max.x - 0.5,
            sb_rect.y_range(),
            Stroke::new(1.0_f32, BORDER()),
        );

        // Bottom dock: `.voice-bar` (if connected) + `.user-panel` matching `UserPanel.tsx`
        TopBottomPanel::bottom("sidebar_user_dock")
            .frame(Frame::new().fill(BG_PANEL()))
            .show_inside(ui, |ui| {
                // Top border of user dock
                let r = ui.max_rect();
                ui.painter()
                    .hline(r.x_range(), r.min.y, Stroke::new(1.0_f32, BORDER()));

                // `.user-panel`: 48px, padding 0 10px, avatar 32, name + username, three icon buttons
                Frame::new()
                    .fill(BG_PANEL())
                    .inner_margin(Margin::symmetric(10, 8))
                    .show(ui, |ui| {
                        ui.set_height(32.0);
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 8.0;
                            let (me_id, me_name, me_tag) = match &self.state.me {
                                Some(me) => (me.id.clone(), me.display_name().to_string(), me.username.clone()),
                                None => (String::new(), String::new(), String::new()),
                            };
                            let av_resp = draw_avatar(ui, 32.0, &me_id, &me_name, Some(&self.my_status), BG_PANEL());
                            if av_resp.on_hover_text(tr("Status")).clicked() {
                                self.my_status = match self.my_status.as_str() {
                                    "online" => "idle".to_string(),
                                    "idle" => "dnd".to_string(),
                                    "dnd" => "invisible".to_string(),
                                    _ => "online".to_string(),
                                };
                                self.broadcast_presence();
                            }
                            // name block gets what the three 32px buttons leave
                            let w = (ui.available_width() - 3.0 * 32.0 - 8.0).max(20.0);
                            ui.allocate_ui_with_layout(Vec2::new(w, 32.0), Layout::top_down(Align::Min), |ui| {
                                ui.set_width(w);
                                ui.spacing_mut().item_spacing.y = 0.0;
                                ui.add(egui::Label::new(RichText::new(&me_name).font(bold_font(14.0)).color(TEXT_HEADER())).truncate());
                                let sub = if !self.custom_status_input.trim().is_empty() {
                                    self.custom_status_input.trim().to_string()
                                } else {
                                    me_tag
                                };
                                ui.add(egui::Label::new(RichText::new(sub).font(ui_font(12.0)).color(TEXT_MUTED())).truncate());
                            });
                            ui.spacing_mut().item_spacing.x = 0.0;
                            let mute_icon = if self.self_mute { IconKind::MicOff } else { IconKind::Mic };
                            if icon_btn(ui, mute_icon, if self.self_mute { tr("Unmute") } else { tr("Mute") }, false, self.self_mute).clicked() {
                                self.self_mute = !self.self_mute;
                            }
                            let deaf_icon = if self.self_deaf { IconKind::HeadsetOff } else { IconKind::Headset };
                            if icon_btn(ui, deaf_icon, if self.self_deaf { tr("Undeafen") } else { tr("Deafen") }, false, self.self_deaf).clicked() {
                                self.self_deaf = !self.self_deaf;
                            }
                            if icon_btn(ui, IconKind::Gear, tr("User Settings"), false, false).clicked() {
                                self.active_modal = Some(ModalKind::UserSettings);
                            }
                        });
                    });
            });

        // Top `.sidebar-header` (`44px` height, `border-bottom: 1px solid #2c3038`) + `.sidebar-scroller`
        if let Some(gid) = self.selected_guild_id.clone() {
            let guild_name = self.state.guilds.get(&gid).map(|g| g.name.clone()).unwrap_or_default();

            // `.sidebar-header`: 44px, padding 0 14px, 19px display, chevron
            let (hdr_rect, hdr_resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 44.0), Sense::click());
            if hdr_resp.hovered() {
                ui.painter().rect_filled(hdr_rect, 0.0, BG_HOVER());
            }
            ui.painter().hline(hdr_rect.x_range(), hdr_rect.max.y - 0.5, Stroke::new(1.0_f32, BORDER()));
            let title = ui.painter().layout(
                guild_name.to_uppercase(),
                display_font(19.0),
                TEXT_HEADER(),
                hdr_rect.width() - 28.0 - 24.0,
            );
            ui.painter().galley(Pos2::new(hdr_rect.min.x + 14.0, hdr_rect.center().y - title.size().y / 2.0), title, TEXT_HEADER());
            draw_icon(
                ui.painter(),
                Rect::from_center_size(Pos2::new(hdr_rect.max.x - 24.0, hdr_rect.center().y), Vec2::splat(20.0)),
                IconKind::ChevronDown,
                TEXT_HEADER(),
            );
            if hdr_resp.on_hover_text(tr("Server Settings")).clicked() {
                self.active_modal = Some(ModalKind::ServerSettings);
            }

            let manage = crate::permissions::has(self.guild_perms(&gid), crate::permissions::p::MANAGE_CHANNELS);
            let groups = self.sidebar_groups(&gid);

            ScrollArea::vertical()
                .id_salt("guild_channels_scroll")
                .show(ui, |ui| {
                    // `.events-entry` (padding 8px 8px 0) + `.sidebar-list` (padding 8px)
                    Frame::new().inner_margin(Margin { left: 8, right: 8, top: 8, bottom: 0 }).show(ui, |ui| {
                        if Self::sidebar_row(ui, RowIcon::Icon(IconKind::Calendar), tr("Events"), false, None).clicked() {
                            self.load_events(&gid);
                            self.active_modal = Some(ModalKind::Events);
                        }
                    });
                    Frame::new().inner_margin(Margin::same(8)).show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 1.0;
                        for (gi, (cat, channels)) in groups.iter().enumerate() {
                            if gi > 0 {
                                ui.add_space(8.0);
                            }
                            let closed = cat.as_ref().is_some_and(|c| self.collapsed_categories.contains(&c.id));
                            if let Some(cat) = cat {
                                let (toggle, gear, plus) = Self::category_head(ui, cat.name.as_deref().unwrap_or(""), closed, manage);
                                if toggle {
                                    if !self.collapsed_categories.remove(&cat.id) {
                                        self.collapsed_categories.insert(cat.id.clone());
                                    }
                                }
                                if gear {
                                    self.edit_channel = Some((cat.id.clone(), cat.name.clone().unwrap_or_default()));
                                }
                                if plus {
                                    self.open_create_channel(Some(cat.id.clone()));
                                }
                            }
                            for ch in channels {
                                let active = self.selected_channel_id.as_deref() == Some(ch.id.as_str());
                                if closed && !active {
                                    continue;
                                }
                                let icon = match ch.kind {
                                    2 => RowIcon::Icon(IconKind::Speaker),
                                    13 => RowIcon::Icon(IconKind::Stage),
                                    5 => RowIcon::Icon(IconKind::Announcement),
                                    15 => RowIcon::Icon(IconKind::Forum),
                                    16 => RowIcon::Icon(IconKind::Grid),
                                    _ => RowIcon::Hash,
                                };
                                let name = ch.name.as_deref().unwrap_or("");
                                if Self::sidebar_row(ui, icon, name, active, None).clicked() {
                                    self.selected_channel_id = Some(ch.id.clone());
                                    self.load_channel_history(&ch.id);
                                }
                                if matches!(ch.kind, 2 | 13) {
                                    self.voice_members(ui, &ch.id);
                                }
                            }
                        }
                    });
                });
        } else {
            // Direct Messages sidebar (`DmSidebar.tsx`): 44px search header, Friends, the DM list
            let (hdr, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 44.0), Sense::hover());
            ui.painter().hline(hdr.x_range(), hdr.max.y - 0.5, Stroke::new(1.0_f32, BORDER()));
            let btn_r = Rect::from_center_size(hdr.center(), Vec2::new(hdr.width() - 20.0, 30.0));
            let btn_resp = ui.interact(btn_r, ui.id().with("dm_search"), Sense::click());
            ui.painter().rect(btn_r, CornerRadius::same(2), BG_RAIL(), Stroke::new(1.0_f32, BORDER()), StrokeKind::Inside);
            ui.painter().text(
                Pos2::new(btn_r.min.x + 10.0, btn_r.center().y),
                Align2::LEFT_CENTER,
                tr("Find or start a conversation"),
                bold_font(12.0),
                if btn_resp.hovered() { TEXT() } else { INTERACTIVE() },
            );
            if btn_resp.clicked() {
                self.active_modal = Some(ModalKind::QuickSwitcher);
            }

            ScrollArea::vertical()
                .id_salt("dm_channels_scroll")
                .show(ui, |ui| {
                    Frame::new()
                        .inner_margin(Margin::same(8))
                        .show(ui, |ui| {
                            ui.spacing_mut().item_spacing.y = 1.0;
                            let friends_selected = self.selected_channel_id.is_none();
                            let pending_count = self.state.relationships.values().filter(|r| r.kind == 3).count();
                            let badge = (pending_count > 0).then(|| pending_count.to_string());
                            if Self::sidebar_row(ui, RowIcon::Icon(IconKind::People), tr("Friends"), friends_selected, badge.as_deref())
                                .clicked()
                            {
                                self.selected_channel_id = None;
                            }

                            ui.add_space(14.0);
                            draw_list_heading(ui, &tr("Direct Messages").to_uppercase());
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
                                        if active { BG_SELECTED() } else { BG_HOVER() },
                                    );
                                }
                                if active {
                                    let bar = Rect::from_min_size(
                                        rect.min,
                                        Vec2::new(3.0, rect.height()),
                                    );
                                    ui.painter().rect_filled(bar, 0.0, ACCENT());
                                }

                                let mut row_ui = ui.new_child(
                                    egui::UiBuilder::new()
                                        .max_rect(rect.shrink2(Vec2::new(8.0, 4.0)))
                                        .layout(Layout::left_to_right(Align::Center)),
                                );
                                // the labels must not take the row's click
                                row_ui.style_mut().interaction.selectable_labels = false;
                                draw_avatar(
                                    &mut row_ui,
                                    26.0,
                                    other_id,
                                    &label,
                                    Some(&status),
                                    if active { BG_SELECTED() } else { BG_SIDEBAR() },
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
                                                TEXT_HEADER()
                                            } else {
                                                TEXT_MUTED()
                                            }),
                                    );
                                    if let Some(gname) = game {
                                        ui.label(
                                            RichText::new(crate::i18n::trf("Playing {name}", &[("name", &gname)]))
                                                .font(ui_font(11.0))
                                                .color(GREEN()),
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

    /// `.row`: 30px, padding 4px 8px, gap 8, 14px muted text; hover tint and 2px nudge;
    /// active: selected fill, strong 600 text, 3px accent bar, accent icon.
    fn sidebar_row(ui: &mut Ui, icon: RowIcon, label: &str, active: bool, badge: Option<&str>) -> egui::Response {
        let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 30.0), Sense::click());
        let hovered = resp.hovered();
        let painter = ui.painter();
        let r = if hovered && !active { rect.translate(Vec2::new(2.0, 0.0)) } else { rect };
        if active || hovered {
            painter.rect_filled(r, CornerRadius::same(2), if active { BG_SELECTED() } else { BG_HOVER() });
        }
        if active {
            painter.rect_filled(Rect::from_min_size(r.min, Vec2::new(3.0, r.height())), 0.0, ACCENT());
        }
        let icon_color = if active { ACCENT() } else { OFFLINE() };
        let icon_rect = Rect::from_center_size(Pos2::new(r.min.x + 17.0, r.center().y), Vec2::splat(20.0));
        match icon {
            RowIcon::Hash => {
                painter.text(icon_rect.center(), Align2::CENTER_CENTER, "#", ui_font(18.0), icon_color);
            }
            RowIcon::Icon(k) => draw_icon(painter, icon_rect, k, icon_color),
            RowIcon::None => {}
        }
        let text_color = if active { TEXT_HEADER() } else if hovered { TEXT() } else { TEXT_MUTED() };
        let font = if active { bold_font(14.0) } else { ui_font(14.0) };
        let x = if matches!(icon, RowIcon::None) { r.min.x + 8.0 } else { r.min.x + 35.0 };
        let galley = painter.layout(label.to_string(), font, text_color, r.max.x - x - 30.0);
        painter.galley(Pos2::new(x, r.center().y - galley.size().y / 2.0), galley, text_color);
        if let Some(b) = badge {
            let b_rect = Rect::from_center_size(Pos2::new(r.max.x - 16.0, r.center().y), Vec2::new(18.0, 16.0));
            painter.rect_filled(b_rect, CornerRadius::same(2), SIGNAL_STRONG());
            painter.text(b_rect.center(), Align2::CENTER_CENTER, b, bold_font(11.0), Color32::WHITE);
        }
        if hovered {
            ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
        }
        resp
    }

    /// `.category`: chevron + 12px display name + rule, then gear and + (when allowed).
    /// Returns (toggle clicked, gear clicked, plus clicked).
    fn category_head(ui: &mut Ui, name: &str, closed: bool, manage: bool) -> (bool, bool, bool) {
        ui.add_space(12.0);
        let w = ui.available_width();
        let (rect, _) = ui.allocate_exact_size(Vec2::new(w, 18.0), Sense::hover());
        ui.add_space(4.0);
        let btns = if manage { 44.0 } else { 0.0 };
        let toggle_rect = Rect::from_min_max(rect.min, Pos2::new(rect.max.x - btns - 4.0, rect.max.y));
        let toggle = ui.interact(toggle_rect, ui.id().with(("cat", name)), Sense::click());
        let color = if toggle.hovered() { TEXT_HEADER() } else { TEXT_MUTED() };
        let p = ui.painter();
        let chev = Rect::from_center_size(Pos2::new(rect.min.x + 6.0, rect.center().y), Vec2::splat(12.0));
        draw_icon(p, chev, if closed { IconKind::ChevronRight } else { IconKind::Expand }, color);
        let galley = crate::theme::spaced_text(ui, &name.to_uppercase(), 12.0, color);
        let p = ui.painter();
        let gx = rect.min.x + 15.0;
        let gw = galley.size().x;
        p.galley(Pos2::new(gx, rect.center().y - galley.size().y / 2.0), galley, color);
        let line_x = gx + gw + 6.0;
        if line_x < toggle_rect.max.x {
            p.hline(line_x..=toggle_rect.max.x, rect.center().y, Stroke::new(1.0_f32, BORDER().gamma_multiply(0.75)));
        }
        let mut out = (toggle.clicked(), false, false);
        if manage {
            let tiny = |ui: &mut Ui, x: f32, icon: IconKind, size: f32, tip: &str, salt: &str| {
                let r = Rect::from_center_size(Pos2::new(x, rect.center().y), Vec2::splat(20.0));
                let resp = ui.interact(r, ui.id().with((salt, name)), Sense::click());
                if resp.hovered() {
                    ui.painter().rect_filled(r, CornerRadius::same(4), BG_HOVER());
                }
                let c = if resp.hovered() { TEXT_HEADER() } else { INTERACTIVE().gamma_multiply(0.75) };
                draw_icon(ui.painter(), Rect::from_center_size(r.center(), Vec2::splat(size)), icon, c);
                resp.on_hover_text(tip).clicked()
            };
            out.1 = tiny(ui, rect.max.x - 32.0, IconKind::Gear, 14.0, tr("Edit Category"), "gear");
            out.2 = tiny(ui, rect.max.x - 10.0, IconKind::Plus, 16.0, tr("New Channel"), "plus");
        }
        out
    }

    /// People in a voice channel, under its row.
    fn voice_members(&self, ui: &mut Ui, channel_id: &str) {
        let mut in_vc: Vec<(String, String, bool)> = self
            .state
            .voice_states
            .values()
            .filter(|vs| vs.channel_id.as_deref() == Some(channel_id))
            .map(|vs| {
                let name = self.state.users.get(&vs.user_id).map(|u| u.display_name().to_string()).unwrap_or_else(|| vs.user_id.clone());
                (vs.user_id.clone(), name, vs.self_stream)
            })
            .collect();
        in_vc.sort_by(|a, b| a.1.cmp(&b.1));
        for (uid, uname, live) in in_vc {
            ui.horizontal(|ui| {
                ui.add_space(30.0);
                draw_avatar(ui, 20.0, &uid, &uname, None, BG_SIDEBAR());
                ui.label(RichText::new(&uname).font(ui_font(13.0)).color(INTERACTIVE()));
                if live {
                    Frame::new()
                        .fill(SIGNAL_STRONG())
                        .corner_radius(CornerRadius::same(2))
                        .inner_margin(Margin::symmetric(4, 1))
                        .show(ui, |ui| {
                            ui.label(RichText::new(tr("LIVE")).font(display_font(10.0)).color(Color32::WHITE));
                        });
                }
            });
        }
    }

    /// My server-wide permissions.
    pub fn guild_perms(&self, gid: &str) -> u64 {
        let (Some(g), Some(me)) = (self.state.guilds.get(gid), self.state.me.as_ref()) else { return 0 };
        let member = self.state.members.get(gid).and_then(|m| m.get(&me.id));
        crate::permissions::base_perms(g, &me.id, member)
    }

    fn render_member_list(&mut self, ui: &mut Ui, guild_id: &str) {
        let m_rect = ui.max_rect();
        ui.painter().vline(
            m_rect.min.x + 0.5,
            m_rect.y_range(),
            Stroke::new(1.0_f32, BORDER()),
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
        let key = |(uid, m, _): &(String, Member, String)| {
            m.nick.clone().or_else(|| m.user.as_ref().map(|u| u.display_name().to_string())).or_else(|| self.state.users.get(uid).map(|u| u.display_name().to_string())).unwrap_or_default().to_lowercase()
        };
        online.sort_by_key(key);
        offline.sort_by_key(key);

        // `.members`: padding 0 6px 14px; `.list-heading` padding 16px 8px 6px
        Frame::new()
            .inner_margin(Margin { left: 6, right: 6, top: 0, bottom: 14 })
            .show(ui, |ui| {
                ScrollArea::vertical()
                    .id_salt("guild_members_scroll")
                    .show(ui, |ui| {
                        ui.spacing_mut().item_spacing.y = 1.0;
                        for (title, list, off) in [(tr("Online"), &online, false), (tr("Offline"), &offline, true)] {
                            if list.is_empty() && off {
                                continue;
                            }
                            ui.add_space(16.0);
                            Frame::new().inner_margin(Margin::symmetric(8, 0)).show(ui, |ui| {
                                draw_list_heading(ui, &format!("{} – {}", title.to_uppercase(), list.len()));
                            });
                            ui.add_space(6.0);
                            for (uid, m, st) in list {
                                self.render_member_item(ui, &guild, &owner_id, uid, m, st, off);
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

        // `.members .row`: 30px, avatar 28, 14px name (muted when offline, avatar at half opacity)
        let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 30.0), Sense::click());
        if resp.hovered() {
            ui.painter().rect_filled(rect, CornerRadius::same(2), BG_HOVER());
        }
        let mut row_ui = ui.new_child(
            egui::UiBuilder::new()
                .max_rect(rect.shrink2(Vec2::new(4.0, 1.0)))
                .layout(Layout::left_to_right(Align::Center)),
        );
        row_ui.style_mut().interaction.selectable_labels = false;
        row_ui.spacing_mut().item_spacing.x = 8.0;
        if is_offline {
            row_ui.set_opacity(0.5);
        }
        draw_avatar(&mut row_ui, 28.0, uid, name, Some(status), if resp.hovered() { BG_HOVER() } else { BG_SIDEBAR() });
        row_ui.set_opacity(1.0);
        let base_col = if is_offline { TEXT_MUTED() } else { role_color.unwrap_or(TEXT()) };
        let w = row_ui.available_width() - 20.0;
        row_ui.allocate_ui_with_layout(Vec2::new(w, 28.0), Layout::top_down(Align::Min).with_main_align(Align::Center), |ui| {
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 0.0;
                ui.add(egui::Label::new(RichText::new(name).font(ui_font(14.0)).color(base_col)).truncate());
                if let Some(gname) = &game {
                    ui.add(egui::Label::new(RichText::new(gname).font(ui_font(11.0)).color(TEXT_MUTED())).truncate());
                }
            });
        });
        if uid == owner_id {
            row_ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                ui.label(RichText::new("♛").font(ui_font(13.0)).color(YELLOW())).on_hover_text(tr("Server Owner"));
            });
        }

        if resp.clicked() {
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

    /// Queues an image for the download workers; the bytes reach egui in headless_tick.
    pub fn request_image(&mut self, uri: &str, url: String) {
        if self.images.contains_key(uri) {
            return;
        }
        let queued = self.api.is_some() && self.image_jobs.send((uri.to_string(), url)).is_ok();
        self.images.insert(uri.to_string(), if queued { ImageLoad::Loading } else { ImageLoad::Failed });
    }

    /// Saves a theme or language choice locally and, for what the hub stores, in the user's
    /// server-side settings (PATCH /users/@me/settings, like the web client's patchSettings).
    pub fn set_appearance(&mut self, theme: Option<&str>, locale: Option<&str>) {
        let mut patch = serde_json::Map::new();
        if let Some(t) = theme {
            self.theme_name = t.to_string();
            self.settings.theme = t.to_string();
            if crate::settings::SERVER_THEMES.contains(&t) {
                patch.insert("theme".into(), t.into());
            }
        }
        if let Some(l) = locale {
            self.locale = l.to_string();
            self.settings.locale = l.to_string();
            patch.insert("locale".into(), l.into());
        }
        report(&mut self.status_banner, self.settings.save());
        if !patch.is_empty() {
            self.api_bg(true, move |api| api.patch("/users/@me/settings", Value::Object(patch)), |app, r| {
                report(&mut app.status_banner, r);
            });
        }
    }

    /// Starts an update check in the background (at start, then every four hours like the
    /// old desktop app). Only a verified installer ever reaches `update_ready`.
    fn maybe_check_for_update(&mut self, demo: bool) {
        const EVERY: Duration = Duration::from_secs(4 * 60 * 60);
        if cfg!(test) || demo || self.update_ready.is_some() || self.update_rx.is_some() {
            return;
        }
        if self.last_update_check.is_some_and(|t| t.elapsed() < EVERY) {
            return;
        }
        let first = self.last_update_check.is_none();
        self.last_update_check = Some(Instant::now());
        let (tx, rx) = mpsc::channel();
        self.update_rx = Some(rx);
        std::thread::spawn(move || {
            if first {
                std::thread::sleep(Duration::from_secs(5)); // never slow down the start
            }
            let base = format!("{}{}", crate::config::PROD_HUB, crate::config::FEED_PATH);
            let _ = tx.send(crate::update::fetch_update(&base, env!("CARGO_PKG_VERSION")));
        });
    }

    fn poll_update(&mut self) {
        let Some(rx) = &self.update_rx else { return };
        let Ok(result) = rx.try_recv() else { return };
        self.update_rx = None;
        match result {
            Ok(ready) => self.update_ready = ready,
            Err(e) => eprintln!("cillhub: update check: {e}"),
        }
    }

    pub fn mark_fonts_installed(&mut self) {
        self.fonts_installed = true;
    }

    pub fn headless_tick(&mut self, ctx: &Context) {
        if !self.fonts_installed {
            install_fonts(ctx, self.state.user_settings.dyslexic_font);
            egui_extras::install_image_loaders(ctx);
            self.fonts_installed = true;
        }
        if self.theme_applied != self.theme_name {
            apply_theme(ctx, &self.theme_name, self.settings.font_scale);
            self.theme_applied = self.theme_name.clone();
        }
        let families_ready = ctx.fonts(|f| {
            f.families()
                .contains(&egui::FontFamily::Name("display".into()))
        });
        crate::theme::set_custom_families_ready(families_ready);

        crate::i18n::set_locale(&self.locale);
        self.pump_bg();
        self.process_background_events();
        while let Ok(paths) = self.picked_rx.try_recv() {
            self.pending_files.extend(paths);
        }
        if std::mem::take(&mut self.forget_images) {
            ctx.forget_all_images();
        }
        while let Ok((uri, bytes)) = self.image_rx.try_recv() {
            let state = match bytes {
                Some(b) => {
                    for old in self.image_cache.add(uri.clone(), b.len()) {
                        ctx.forget_image(&old);
                        self.images.remove(&old);
                    }
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
            self.msg_menu = None;
            self.emoji_picker = None;
            self.confirm_delete = None;
            self.edit_channel = None;
        }

        // Full-size image view (the web's lightbox: dimmed page, the image, a link to open it)
        if let Some((uri, _name, url)) = self.lightbox.clone() {
            let max = ctx.screen_rect().size() * 0.85;
            let banner = &mut self.status_banner;
            let (_, dim) = modals::overlay(ctx, "lightbox", max.x.min(900.0), |ui| {
                ui.add(egui::Image::new(uri.as_str()).max_size(max - Vec2::splat(48.0)).shrink_to_fit());
                ui.add_space(8.0);
                if ui.add(egui::Label::new(RichText::new(tr("Open in Browser")).color(FOCUS())).sense(Sense::click())).clicked() {
                    open_external(banner, &url);
                }
            });
            if dim {
                self.lightbox = None;
            }
        }

        // Update banner (the web client's UpdateBanner): only for a verified installer
        let update_shown = self
            .update_dismissed_until
            .is_none_or(|t| Instant::now() >= t);
        if let (Some(staged), true) = (self.update_ready.clone(), update_shown) {
            let version = staged.version.clone();
            TopBottomPanel::top("update_banner_panel")
                .frame(Frame::new().fill(ACCENT()).inner_margin(Margin::symmetric(14, 6)))
                .show(ctx, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new(crate::i18n::trf("A new version of Cillhub is available ({version}).", &[("version", &version)]))
                                .strong()
                                .size(12.5)
                                .color(Color32::BLACK),
                        );
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if ui.small_button("✕").on_hover_text(tr("Dismiss for an hour")).clicked() {
                                self.update_dismissed_until =
                                    Some(Instant::now() + Duration::from_secs(3600));
                            }
                            if ui.button(tr("Restart to Update")).clicked()
                                && report(&mut self.status_banner, crate::update::run_installer(&staged))
                                    .is_some()
                            {
                                std::process::exit(0);
                            }
                        });
                    });
                });
        }

        // Optional status notification banner at top
        if let Some(banner) = self.status_banner.clone() {
            TopBottomPanel::top("status_banner_panel")
                .frame(
                    Frame::new()
                        .fill(ACCENT_SOFT())
                        .stroke(Stroke::new(1.0_f32, ACCENT()))
                        .inner_margin(Margin::symmetric(14, 6)),
                )
                .show(ctx, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(&banner).strong().size(12.5).color(TEXT_HEADER()));
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if ui.small_button(tr("Dismiss")).clicked() {
                                self.status_banner = None;
                            }
                        });
                    });
                });
        }

        if !self.authenticated {
            CentralPanel::default()
                .frame(Frame::new().fill(BG_CHAT()))
                .show(ctx, |ui| {
                    self.render_auth(ui);
                });
            return;
        }

        // 1. Leftmost Guild Rail (64px)
        SidePanel::left("guild_rail_panel")
            .exact_width(64.0)
            .resizable(false)
            .frame(Frame::new().fill(BG_RAIL()))
            .show(ctx, |ui| {
                self.render_guild_rail(ui);
            });

        // 2. Channel / DM Sidebar (216px)
        SidePanel::left("channel_sidebar_panel")
            .exact_width(216.0)
            .resizable(false)
            .frame(Frame::new().fill(BG_SIDEBAR()))
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
                        .fill(BG_PANEL())
                        .inner_margin(Margin::same(12)),
                )
                .show(ctx, |ui| {
                    self.render_drawer(ui, drawer);
                });
        } else if self.show_member_list
            && !self
                .selected_channel_id
                .as_ref()
                .and_then(|c| self.state.channels.get(c))
                .is_some_and(|c| matches!(c.kind, 2 | 13))
        {
            if let Some(gid) = self.selected_guild_id.clone() {
                SidePanel::right("member_list_panel")
                    .exact_width(216.0)
                    .resizable(false)
                    .frame(Frame::new().fill(BG_SIDEBAR()))
                    .show(ctx, |ui| {
                        self.render_member_list(ui, &gid);
                    });
            }
        }

        // 4. Center Main View (Chat / Stage / Friends)
        CentralPanel::default()
            .frame(Frame::new().fill(BG_CHAT()))
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
        self.render_message_menu(ctx);
        self.render_emoji_picker(ctx);
        self.render_confirm_delete(ctx);
        self.render_edit_channel(ctx);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_web_links_reach_the_os_opener() {
        let app = CillhubApp::new(None, true);
        for evil in ["file:///C:/Windows/System32/calc.exe", "smb://host/share", "cillhub://invite/x", "javascript:alert(1)", "/relative"] {
            let mut banner = None;
            open_external(&mut banner, &app.absolute_url(evil));
            assert_eq!(banner.as_deref(), Some("Only web links can be opened."), "{evil}");
        }
    }

    #[test]
    fn failed_actions_change_nothing_locally() {
        let mut app = CillhubApp::new(None, true);
        // A server that refuses every connection.
        app.api = Some(ApiClient::new(Url::parse("http://localhost:9/").unwrap(), None));
        let before = app.state.messages["c_general"].clone();
        let id = before[0].id.clone();
        app.toggle_reaction("c_general", &id, "🔥");
        app.delete_message("c_general", &id);
        app.selected_channel_id = Some("c_general".into());
        app.send_message_to_selected("not sent");
        settle(&mut app);
        assert_eq!(app.state.messages["c_general"], before);
        assert_eq!(app.composer_text, "not sent", "the draft stays for a retry");
        assert!(app.status_banner.is_some());

        // failed creations make up nothing and keep the input
        let (guilds, channels) = (app.state.guilds.len(), app.state.channels.len());
        app.new_guild_name_input = "Taylor's server".into();
        app.create_guild();
        app.create_thread_from_message("c_general", &before[0]);
        let kim = User { id: "u_kim".into(), username: "kim".into(), ..Default::default() };
        app.open_or_create_dm(&kim);
        settle(&mut app);
        assert_eq!((app.state.guilds.len(), app.state.channels.len()), (guilds, channels));
        assert_eq!(app.new_guild_name_input, "Taylor's server");
        assert_eq!(app.selected_channel_id.as_deref(), Some("c_general"));
    }

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
    }

    /// A one-shot HTTP server answering `body` to every request; returns its origin and the request lines.
    fn fake_hub(body: &'static str, requests: usize) -> (Url, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = Url::parse(&format!("http://localhost:{}/", listener.local_addr().unwrap().port())).unwrap();
        let t = std::thread::spawn(move || {
            let mut seen = Vec::new();
            for _ in 0..requests {
                let (mut sock, _) = listener.accept().unwrap();
                let mut buf = [0u8; 8192];
                let n = sock.read(&mut buf).unwrap_or(0);
                seen.push(String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string());
                let head = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
                let _ = sock.write_all(head.as_bytes());
                let _ = sock.write_all(body.as_bytes());
            }
            seen
        });
        (origin, t)
    }

    fn dispatch(app: &mut CillhubApp, name: &str, payload: Value) {
        let (tx, rx) = mpsc::channel();
        tx.send(GatewayEvent::Dispatch(name.into(), payload)).unwrap();
        app.gateway_rx = Some(rx);
        app.process_background_events();
    }

    #[test]
    fn reconnect_reloads_the_open_channel() {
        let mut app = CillhubApp::new(None, true);
        let (origin, hub) = fake_hub(r#"[{"id":"m9","channel_id":"c_general","content":"again","author":{"id":"u_sam","username":"sam"},"timestamp":"2026-11-10T20:30:00Z"}]"#, 2);
        app.api = Some(ApiClient::new(origin, None));
        app.selected_guild_id = Some("g_arena".into());
        app.selected_channel_id = Some("c_general".into());
        let ready = serde_json::json!({"session_id": "s", "user": {"id": "u_me", "username": "alex"},
            "guilds": [{"id": "g_arena", "name": "Arena", "owner_id": "u_me", "channels": [{"id": "c_general", "type": 0, "guild_id": "g_arena", "name": "general"}]}]});
        dispatch(&mut app, "READY", ready);
        settle(&mut app);
        assert_eq!(app.selected_channel_id.as_deref(), Some("c_general"));
        assert_eq!(app.state.messages.get("c_general").map(|l| l[0].content.as_str()), Some("again"));
        let seen = hub.join().unwrap();
        assert!(seen.iter().any(|r| r.starts_with("GET /api/v9/channels/c_general/messages")), "{seen:?}");
    }

    #[test]
    fn votes_and_pins_follow_the_server() {
        let mut app = CillhubApp::new(None, true);
        let mut msg = app.state.messages["c_general"][0].clone();
        msg.poll = Some(serde_json::from_value(serde_json::json!({"question": {"text": "Mode?"}, "answers": [{"answer_id": 1, "poll_media": {"text": "ARAM"}}]})).unwrap());
        app.state.messages.get_mut("c_general").unwrap()[0] = msg.clone();
        let (origin, hub) = fake_hub("{}", 1);
        app.api = Some(ApiClient::new(origin, None));
        app.vote_poll("c_general", &msg.id, 1, true);
        settle(&mut app);
        let seen = hub.join().unwrap();
        assert!(seen[0].starts_with(&format!("PUT /api/v9/channels/c_general/polls/{}/answers/@me ", msg.id)), "{seen:?}");
        assert_eq!(app.state.messages["c_general"][0], msg, "the count comes with the gateway event");
        dispatch(&mut app, "MESSAGE_POLL_VOTE_ADD", serde_json::json!({"channel_id": "c_general", "message_id": msg.id, "user_id": "u_me", "answer_id": 1}));
        let counts = &app.state.messages["c_general"][0].poll.as_ref().unwrap().results.as_ref().unwrap().answer_counts;
        assert_eq!(counts[0].count, 1);

        app.api = Some(ApiClient::new(Url::parse("http://localhost:9/").unwrap(), None));
        let before = app.state.messages["c_general"].clone();
        app.toggle_pin_message("c_general", &before[0]);
        app.vote_poll("c_general", &msg.id, 1, false);
        settle(&mut app);
        assert_eq!(app.state.messages["c_general"], before, "a failed request changes nothing");
    }

    #[test]
    fn a_stalled_hub_never_blocks_a_frame() {
        let mut app = CillhubApp::new(None, true);
        let stalled = std::net::TcpListener::bind("127.0.0.1:0").unwrap(); // accepts, never answers
        app.api = Some(ApiClient::new(Url::parse(&format!("http://localhost:{}/", stalled.local_addr().unwrap().port())).unwrap(), None));
        let t = Instant::now();
        app.load_members("g_arena");
        app.load_channel_history("c_new");
        app.selected_channel_id = Some("c_general".into());
        app.send_message_to_selected("hi");
        app.poll_league_lobby();
        app.pump_bg();
        assert!(t.elapsed() < Duration::from_millis(500), "{:?}", t.elapsed());
        assert!(app.bg.pending >= 3);
    }

    #[test]
    fn only_visible_message_rows_are_drawn() {
        let shapes = |n: usize| {
            let mut app = CillhubApp::new(None, true);
            let m = app.state.messages["c_general"][0].clone();
            let list = (0..n).map(|i| Message { id: format!("m{i}"), content: format!("line {i}"), ..m.clone() }).collect();
            app.state.messages.insert("c_general".into(), list);
            let ctx = egui::Context::default();
            install_fonts(&ctx, false);
            let mut input = egui::RawInput::default();
            input.screen_rect = Some(Rect::from_min_size(Pos2::ZERO, Vec2::new(1280.0, 800.0)));
            (0..3).map(|_| ctx.run(input.clone(), |ctx| app.headless_tick(ctx)).shapes.len()).last().unwrap()
        };
        let (few, many) = (shapes(40), shapes(500));
        assert!(many < few * 2, "{few} shapes for 40 messages, {many} for 500");
    }

    #[test]
    fn search_shows_the_servers_results() {
        let mut app = CillhubApp::new(None, true);
        let (origin, hub) = fake_hub(r#"{"total_results": 30, "messages": [[{"id": "m_old", "channel_id": "c_lfg", "content": "an old one", "author": {"id": "u_kim", "username": "kim"}}]]}"#, 2);
        app.api = Some(ApiClient::new(origin, None));
        app.search_query = "old one".into();
        app.run_search(false);
        settle(&mut app);
        let sr = app.search.clone().unwrap();
        assert_eq!((sr.total, sr.hits.len(), sr.hits[0].content.as_str()), (30, 1, "an old one"));
        app.run_search(true);
        settle(&mut app);
        let seen = hub.join().unwrap();
        assert!(seen[0].starts_with("GET /api/v9/guilds/g_arena/messages/search?content=old%20one&offset=0 "), "{seen:?}");
        assert!(seen[1].contains("&offset=1 "), "{seen:?}");
    }

    /// Against a real test hub with the seed data of the review scripts (user alex, a poll and 60+ newer messages in
    /// #general). Restarts the hub container to check the reconnect. Run with XDG_CONFIG_HOME/HOME pointing at a
    /// scratch dir: CILLHUB_TEST_HUB=http://127.0.0.1:3391 CILLHUB_TEST_CONTAINER=<name> cargo test real_hub -- --ignored
    #[test]
    #[ignore]
    fn real_hub_login_reconnect_vote_search_logout() {
        let hub = std::env::var("CILLHUB_TEST_HUB").expect("CILLHUB_TEST_HUB");
        let wait = |app: &mut CillhubApp, what: &str, ok: &dyn Fn(&CillhubApp) -> bool| {
            let t = Instant::now();
            while !ok(app) {
                assert!(t.elapsed() < Duration::from_secs(30), "timed out waiting for {what}: {:?}", app.status_banner);
                app.pump_bg();
                app.process_background_events();
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        let mut app = CillhubApp::new(None, false);
        app.settings.server_target = "node".into();
        app.auth_server_url = hub;
        app.auth_login_input = "alex".into();
        app.auth_password_input = "review-pass-1234".into();
        app.submit_auth();
        wait(&mut app, "READY", &|a| a.state.me.is_some());
        assert!(app.auth_password_input.is_empty(), "password cleared after login");
        let cid = app.selected_channel_id.clone().expect("a channel is open");
        wait(&mut app, "history", &|a| a.state.messages.get(&cid).is_some_and(|l| l.len() == 50));

        let session = app.state.session_id.clone();
        let container = std::env::var("CILLHUB_TEST_CONTAINER").expect("CILLHUB_TEST_CONTAINER");
        assert!(std::process::Command::new("docker").args(["restart", &container]).status().unwrap().success());
        wait(&mut app, "a new READY", &|a| a.state.session_id.is_some() && a.state.session_id != session);
        wait(&mut app, "history after reconnect", &|a| a.state.messages.get(&cid).is_some_and(|l| l.len() == 50));
        assert_eq!(app.selected_channel_id.as_deref(), Some(cid.as_str()));

        let poll_id = app.state.messages[&cid].iter().rev().find(|m| m.poll.is_some()).expect("the seeded poll").id.clone();
        let count = |a: &CillhubApp| {
            let m = a.state.messages[&cid].iter().find(|m| m.id == poll_id).cloned().unwrap();
            m.poll.and_then(|p| p.results).and_then(|r| r.answer_counts.into_iter().find(|c| c.id == 1)).map_or(0, |c| c.count)
        };
        let before = count(&app);
        app.vote_poll(&cid, &poll_id, 1, true);
        wait(&mut app, "the vote event", &|a| count(a) > before);
        let t = Instant::now();
        while t.elapsed() < Duration::from_secs(2) {
            app.pump_bg();
            app.process_background_events();
        }
        assert_eq!(count(&app), before + 1, "one vote counts once");

        app.search_query = "Morning everyone".into();
        app.run_search(false);
        wait(&mut app, "search", &|a| a.search.as_ref().is_some_and(|s| !s.loading));
        let hit = app.search.as_ref().unwrap().hits.iter().find(|m| m.content.starts_with("Morning everyone")).cloned().expect("old message found");
        assert!(!app.state.messages[&cid].iter().any(|m| m.id == hit.id), "outside the loaded window");

        app.logout();
        assert!(app.auth_login_input.is_empty() && app.auth_password_input.is_empty() && app.auth_mode == AuthMode::Login);
        assert!(!app.authenticated && app.state.me.is_none());
    }

    /// Applies background results until no request is in flight.
    fn settle(app: &mut CillhubApp) {
        let t = Instant::now();
        while app.bg.pending > 0 && t.elapsed() < Duration::from_secs(20) {
            app.pump_bg();
            std::thread::sleep(Duration::from_millis(5));
        }
        app.pump_bg();
    }

    #[test]
    fn logout_forgets_the_session() {
        let mut app = CillhubApp::new(None, true);
        app.auth_login_input = "alex".into();
        app.auth_password_input = "secret".into();
        app.auth_mfa_ticket = "ticket".into();
        app.auth_mfa_code = "123456".into();
        app.auth_reset_token = "reset".into();
        app.auth_mode = AuthMode::Mfa;
        app.lightbox = Some(("bytes://a".into(), "a.png".into(), "https://x/a.png".into()));
        app.images.insert("bytes://a".into(), ImageLoad::Ready);
        app.logout();
        assert!(app.auth_login_input.is_empty() && app.auth_password_input.is_empty());
        assert!(app.auth_mfa_ticket.is_empty() && app.auth_mfa_code.is_empty() && app.auth_reset_token.is_empty());
        assert_eq!(app.auth_mode, AuthMode::Login);
        assert!(app.lightbox.is_none() && app.images.is_empty());
        assert!(app.state.guilds.is_empty() && app.state.me.is_none());
        assert!(app.selected_guild_id.is_none() && app.selected_channel_id.is_none());
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
        app.active_modal = Some(ModalKind::CreatePoll);
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
        app.settings_tab = SettingsTab::Appearance;
        let out_voice = ctx.run(input, |ctx| {
            app.headless_tick(ctx);
        });
        assert!(!out_voice.shapes.is_empty());
    }
}
