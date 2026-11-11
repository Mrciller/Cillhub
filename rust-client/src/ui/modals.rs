//! Modals and Right-Side Drawers: Game Lobby Invite, User Settings (Game Activity,
//! Custom Games, League LCU, Voice, Appearance, Security, Desktop/Updates),
//! Server Settings & Role Permissions, Create/Join Server, Create Poll, Send Later,
//! Quick Switcher, and Threads/Pins/Saved/Search/Canvas Drawers.

use super::report;
use crate::league::{format_game_invite_url, GameInviteData};
use crate::model::{
    Channel, Guild, Message, Poll, PollAnswer, PollMedia, PollResults, Role,
};
use crate::permissions::{has, parse_bits, PERMISSION_LIST};
use crate::settings::{set_autostart, CustomGame};
use crate::theme::{apply_theme, display_font, install_fonts, palette::*};
use crate::ui::{CillhubApp, DrawerKind, ModalKind, SettingsTab};
use egui::{
    Align, Color32, Context, CornerRadius, Frame, Layout, Margin, RichText, ScrollArea, Slider,
    Stroke, TextEdit, Ui, Vec2, Window,
};
use serde_json::json;

impl CillhubApp {
    pub fn render_modals(&mut self, ctx: &Context) {
        let Some(modal) = self.active_modal else {
            return;
        };

        match modal {
            ModalKind::GameLobbyInvite => self.render_game_lobby_modal(ctx),
            ModalKind::UserSettings => self.render_user_settings_modal(ctx),
            ModalKind::ServerSettings => self.render_server_settings_modal(ctx),
            ModalKind::CreateJoinGuild => self.render_create_join_guild_modal(ctx),
            ModalKind::CreatePoll => self.render_create_poll_modal(ctx),
            ModalKind::SendLater => self.render_send_later_modal(ctx),
            ModalKind::QuickSwitcher => self.render_quick_switcher_modal(ctx),
            ModalKind::Directory => self.render_directory_modal(ctx),
        }
    }

    fn render_game_lobby_modal(&mut self, ctx: &Context) {
        let mut open = true;
        Window::new("🎮 Invite to Game Lobby & League Party")
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .default_width(460.0)
            .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
            .show(ctx, |ui| {
                ui.label(
                    RichText::new("SHARE AN INTERACTIVE GAME LOBBY INVITE CARD IN CHAT")
                        .size(11.5)
                        .strong()
                        .color(LEAGUE_TEAL),
                );
                ui.add_space(6.0);

                // If a live League LCU lobby is detected, show a one-click sync banner
                if let Some(l) = self.league_lobby.clone() {
                    Frame::new()
                        .fill(LEAGUE_BG)
                        .stroke(Stroke::new(1.0_f32, LEAGUE_TEAL))
                        .corner_radius(CornerRadius::same(4))
                        .inner_margin(Margin::same(10))
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                ui.vertical(|ui| {
                                    ui.label(
                                        RichText::new(format!(
                                            "✅ Live LCU Lobby: {}",
                                            l.queue_name
                                        ))
                                        .strong()
                                        .color(LEAGUE_TEAL),
                                    );
                                    ui.label(
                                        RichText::new(format!(
                                            "Party ID: {} · Members: {}/{}",
                                            l.party_id.as_deref().unwrap_or("open"),
                                            l.member_count,
                                            l.max_party_size
                                        ))
                                        .size(11.5)
                                        .color(TEXT_MUTED),
                                    );
                                });
                                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                    if ui.button("Use LCU Lobby").clicked() {
                                        self.lobby_form_game = "League of Legends".to_string();
                                        self.lobby_form_queue = l.queue_name.clone();
                                        self.lobby_form_party_id = l
                                            .party_id
                                            .clone()
                                            .unwrap_or_else(|| "lol-party".to_string());
                                        self.lobby_form_members = l.member_count.max(1) as u32;
                                        self.lobby_form_max_members = l.max_party_size.max(5) as u32;
                                    }
                                });
                            });
                        });
                    ui.add_space(8.0);
                }

                egui::Grid::new("lobby_invite_form")
                    .num_columns(2)
                    .spacing([12.0, 8.0])
                    .show(ui, |ui| {
                        ui.label(RichText::new("Game Title:").color(TEXT_MUTED));
                        ui.add_sized(
                            Vec2::new(280.0, 28.0),
                            TextEdit::singleline(&mut self.lobby_form_game),
                        );
                        ui.end_row();

                        ui.label(RichText::new("Queue / Mode:").color(TEXT_MUTED));
                        ui.add_sized(
                            Vec2::new(280.0, 28.0),
                            TextEdit::singleline(&mut self.lobby_form_queue),
                        );
                        ui.end_row();

                        ui.label(RichText::new("Host Name:").color(TEXT_MUTED));
                        ui.add_sized(
                            Vec2::new(280.0, 28.0),
                            TextEdit::singleline(&mut self.lobby_form_host),
                        );
                        ui.end_row();

                        ui.label(RichText::new("Party / Lobby ID:").color(TEXT_MUTED));
                        ui.add_sized(
                            Vec2::new(280.0, 28.0),
                            TextEdit::singleline(&mut self.lobby_form_party_id),
                        );
                        ui.end_row();

                        ui.label(RichText::new("Party Size:").color(TEXT_MUTED));
                        ui.horizontal(|ui| {
                            ui.add(
                                Slider::new(&mut self.lobby_form_members, 1..=10).text("Current"),
                            );
                            ui.add(
                                Slider::new(&mut self.lobby_form_max_members, 1..=10).text("Max"),
                            );
                        });
                        ui.end_row();
                    });

                ui.add_space(10.0);
                let preview = GameInviteData {
                    game: self.lobby_form_game.clone(),
                    party_id: self.lobby_form_party_id.clone(),
                    queue_name: self.lobby_form_queue.clone(),
                    queue_id: Some(420),
                    host_name: self.lobby_form_host.clone(),
                    host_puuid: None,
                    members: self.lobby_form_members as usize,
                    max_members: self.lobby_form_max_members.max(self.lobby_form_members) as usize,
                };

                ui.label(
                    RichText::new("CARD PREVIEW")
                        .size(11.0)
                        .strong()
                        .color(TEXT_MUTED),
                );
                self.render_game_invite_card(ui, &preview);

                ui.add_space(10.0);
                if ui
                    .add_sized(
                        Vec2::new(ui.available_width(), 34.0),
                        egui::Button::new(
                            RichText::new("🎮 Post Lobby Invite Card to Current Channel")
                                .strong()
                                .color(Color32::BLACK),
                        )
                        .fill(LEAGUE_TEAL),
                    )
                    .clicked()
                {
                    let url = format_game_invite_url(&preview);
                    self.send_message_to_selected(&url);
                    self.active_modal = None;
                }

                ui.add_space(10.0);
                ui.separator();
                ui.add_space(6.0);

                // Direct League of Legends LCU Summoner Invite
                ui.label(
                    RichText::new("DIRECT LEAGUE CLIENT (LCU) SUMMONER INVITE")
                        .size(11.0)
                        .strong()
                        .color(TEXT_MUTED),
                );
                ui.horizontal(|ui| {
                    ui.add_sized(
                        Vec2::new(260.0, 28.0),
                        TextEdit::singleline(&mut self.lcu_summoner_target)
                            .hint_text("Summoner Name or Numeric ID"),
                    );
                    if ui
                        .button(RichText::new("Send LCU Invite").color(LEAGUE_TEAL))
                        .clicked()
                    {
                        self.send_direct_lcu_invite();
                    }
                });
            });

        if !open {
            self.active_modal = None;
        }
    }

    fn render_user_settings_modal(&mut self, ctx: &Context) {
        let mut open = true;
        Window::new("⚙ User Settings")
            .open(&mut open)
            .collapsible(false)
            .resizable(true)
            .default_size(Vec2::new(720.0, 520.0))
            .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
            .show(ctx, |ui| {
                ui.columns(2, |cols| {
                    // Left settings navigation
                    let nav = &mut cols[0];
                    nav.set_max_width(180.0);
                    Frame::new()
                        .fill(BG_SIDEBAR)
                        .inner_margin(Margin::same(10))
                        .show(nav, |ui| {
                            for (tab, label) in [
                                (SettingsTab::Account, "👤 My Account & Profile"),
                                (SettingsTab::Games, "🎮 Game Activity & Lobby"),
                                (SettingsTab::Voice, "🎙 Voice"),
                                (SettingsTab::Appearance, "🎨 Appearance & Locale"),
                                (SettingsTab::Desktop, "🖥 Desktop & Updates"),
                            ] {
                                let selected = self.settings_tab == tab;
                                if ui
                                    .add_sized(
                                        Vec2::new(ui.available_width(), 30.0),
                                        egui::Button::new(
                                            RichText::new(label).color(if selected {
                                                Color32::BLACK
                                            } else {
                                                TEXT
                                            }),
                                        )
                                        .fill(if selected { ACCENT } else { BG_INPUT }),
                                    )
                                    .clicked()
                                {
                                    self.settings_tab = tab;
                                }
                                ui.add_space(4.0);
                            }

                            ui.separator();
                            if ui
                                .add_sized(
                                    Vec2::new(ui.available_width(), 30.0),
                                    egui::Button::new(RichText::new("🚪 Log Out").color(DANGER))
                                        .fill(BG_INPUT),
                                )
                                .clicked()
                            {
                                self.logout();
                            }
                        });

                    // Right settings content pane
                    let body = &mut cols[1];
                    ScrollArea::vertical()
                        .id_salt("user_settings_scroll")
                        .show(body, |ui| match self.settings_tab {
                            SettingsTab::Account => {
                                ui.heading("My Account & Presence");
                                ui.add_space(8.0);
                                if let Some(me) = &self.state.me {
                                    ui.label(
                                        RichText::new(format!(
                                            "Signed in as {} (@{})",
                                            me.display_name(),
                                            me.username
                                        ))
                                        .strong()
                                        .color(TEXT_HEADER),
                                    );
                                }
                                ui.add_space(8.0);
                                ui.label(RichText::new("ONLINE STATUS").size(11.0).color(TEXT_MUTED));
                                ui.horizontal(|ui| {
                                    for st in ["online", "idle", "dnd", "invisible"] {
                                        let active = self.my_status == st;
                                        if ui.selectable_label(active, st.to_uppercase()).clicked()
                                        {
                                            self.my_status = st.to_string();
                                            self.broadcast_presence();
                                        }
                                    }
                                });
                                ui.add_space(8.0);
                                ui.label(RichText::new("CUSTOM STATUS").size(11.0).color(TEXT_MUTED));
                                ui.horizontal(|ui| {
                                    ui.add_sized(
                                        Vec2::new(260.0, 28.0),
                                        TextEdit::singleline(&mut self.custom_status_input)
                                            .hint_text("What are you up to?"),
                                    );
                                    if ui.button("Save Status").clicked() {
                                        self.broadcast_presence();
                                    }
                                });
                            }
                            SettingsTab::Games => {
                                ui.heading("Game Activity & League Lobby");
                                ui.add_space(6.0);
                                let mut share = self.settings.share_activity;
                                if ui
                                    .checkbox(
                                        &mut share,
                                        "Display currently running game as a status message (Gateway Op 3)",
                                    )
                                    .changed()
                                {
                                    self.set_share_activity(share);
                                }

                                ui.add_space(8.0);
                                Frame::new()
                                    .fill(BG_SIDEBAR)
                                    .stroke(Stroke::new(1.0_f32, BORDER))
                                    .corner_radius(CornerRadius::same(4))
                                    .inner_margin(Margin::same(10))
                                    .show(ui, |ui| {
                                        ui.horizontal(|ui| {
                                            if let Some(g) = &self.current_game {
                                                ui.label(
                                                    RichText::new(format!(
                                                        "🟢 Active Game: {}",
                                                        g.name
                                                    ))
                                                    .strong()
                                                    .color(GREEN),
                                                );
                                            } else {
                                                ui.label(
                                                    RichText::new("⚪ No active game detected")
                                                        .color(TEXT_MUTED),
                                                );
                                            }
                                            if ui.small_button("🔄 Scan Now").clicked() {
                                                self.poll_game_activity(true);
                                            }
                                        });
                                    });

                                ui.add_space(10.0);
                                ui.label(
                                    RichText::new("ADD CUSTOM GAME PROCESS OVERRIDE")
                                        .size(11.0)
                                        .strong()
                                        .color(TEXT_MUTED),
                                );
                                ui.horizontal(|ui| {
                                    ui.add_sized(
                                        Vec2::new(160.0, 26.0),
                                        TextEdit::singleline(&mut self.custom_game_exe_input)
                                            .hint_text("executable (e.g. eldenring.exe)"),
                                    );
                                    ui.add_sized(
                                        Vec2::new(160.0, 26.0),
                                        TextEdit::singleline(&mut self.custom_game_name_input)
                                            .hint_text("Display Name"),
                                    );
                                    if ui.button("Add Game").clicked()
                                        && !self.custom_game_exe_input.trim().is_empty()
                                        && !self.custom_game_name_input.trim().is_empty()
                                    {
                                        self.settings.custom_games.push(CustomGame {
                                            exe: self.custom_game_exe_input.trim().to_string(),
                                            name: self.custom_game_name_input.trim().to_string(),
                                        });
                                        report(&mut self.status_banner, self.settings.save());
                                        self.custom_game_exe_input.clear();
                                        self.custom_game_name_input.clear();
                                        self.poll_game_activity(true);
                                    }
                                });

                                ui.add_space(6.0);
                                let mut remove_idx = None;
                                for (idx, cg) in self.settings.custom_games.iter().enumerate() {
                                    ui.horizontal(|ui| {
                                        ui.label(
                                            RichText::new(&cg.name).strong().color(TEXT_HEADER),
                                        );
                                        ui.label(
                                            RichText::new(format!("({})", cg.exe))
                                                .monospace()
                                                .size(11.0)
                                                .color(TEXT_MUTED),
                                        );
                                        if ui.small_button("Remove").clicked() {
                                            remove_idx = Some(idx);
                                        }
                                    });
                                }
                                if let Some(idx) = remove_idx {
                                    self.settings.custom_games.remove(idx);
                                    report(&mut self.status_banner, self.settings.save());
                                    self.poll_game_activity(true);
                                }
                            }
                            SettingsTab::Voice => {
                                ui.heading("Voice");
                                ui.add_space(6.0);
                                ui.label(RichText::new(super::VOICE_UNAVAILABLE).color(TEXT_MUTED));
                            }
                            SettingsTab::Appearance => {
                                ui.heading("Appearance & Language");
                                ui.add_space(6.0);
                                ui.label(RichText::new("THEME").size(11.0).color(TEXT_MUTED));
                                ui.horizontal_wrapped(|ui| {
                                    for th in [
                                        "dark",
                                        "argon",
                                        "midnight",
                                        "nord",
                                        "solarized",
                                        "high-contrast",
                                        "light",
                                    ] {
                                        if ui
                                            .selectable_label(self.theme_name == th, th)
                                            .clicked()
                                        {
                                            self.set_appearance(Some(th), None);
                                        }
                                    }
                                });
                                ui.add_space(8.0);
                                if ui
                                    .add(
                                        Slider::new(&mut self.settings.font_scale, 0.85..=1.35)
                                            .text("UI Scale"),
                                    )
                                    .changed()
                                {
                                    apply_theme(ctx, &self.theme_name, self.settings.font_scale);
                                    report(&mut self.status_banner, self.settings.save());
                                }
                                if ui
                                    .checkbox(
                                        &mut self.state.user_settings.dyslexic_font,
                                        "Use OpenDyslexic Font",
                                    )
                                    .changed()
                                {
                                    install_fonts(ctx, self.state.user_settings.dyslexic_font);
                                }
                                ui.add_space(8.0);
                                ui.label(RichText::new("LANGUAGE").size(11.0).color(TEXT_MUTED));
                                ui.horizontal(|ui| {
                                    if ui
                                        .selectable_label(!self.locale.starts_with("de"), "English (EN)")
                                        .clicked()
                                    {
                                        self.set_appearance(None, Some("en-US"));
                                    }
                                    if ui
                                        .selectable_label(self.locale.starts_with("de"), "Deutsch (DE)")
                                        .clicked()
                                    {
                                        self.set_appearance(None, Some("de"));
                                    }
                                });
                            }
                            SettingsTab::Desktop => {
                                ui.heading("Desktop");
                                ui.add_space(6.0);
                                if ui
                                    .checkbox(
                                        &mut self.settings.open_on_startup,
                                        "Launch Cillhub automatically at OS Login",
                                    )
                                    .changed()
                                {
                                    report(&mut self.status_banner, set_autostart(self.settings.open_on_startup));
                                    report(&mut self.status_banner, self.settings.save());
                                }
                                ui.add_space(10.0);
                                ui.label(
                                    RichText::new(format!(
                                        "Client Version: v{} (Pure Rust egui/eframe)",
                                        env!("CARGO_PKG_VERSION")
                                    ))
                                    .strong()
                                    .color(TEXT_HEADER),
                                );
                                if let Some((ver, _)) = &self.update_ready {
                                    ui.label(
                                        RichText::new(format!("Update ready: v{ver}"))
                                            .color(GREEN),
                                    );
                                }
                            }
                        });
                });
            });

        if !open {
            self.active_modal = None;
        }
    }

    fn render_server_settings_modal(&mut self, ctx: &Context) {
        let Some(gid) = self.selected_guild_id.clone() else {
            self.active_modal = None;
            return;
        };
        let Some(guild) = self.state.guilds.get(&gid).cloned() else {
            self.active_modal = None;
            return;
        };
        let mut open = true;
        Window::new(format!("🛡 Server Settings — {}", guild.name))
            .open(&mut open)
            .collapsible(false)
            .default_size(Vec2::new(620.0, 460.0))
            .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
            .show(ctx, |ui| {
                ui.horizontal(|ui| {
                    ui.label(RichText::new("CREATE CHANNEL:").color(TEXT_MUTED));
                    ui.add_sized(
                        Vec2::new(180.0, 26.0),
                        TextEdit::singleline(&mut self.new_channel_name_input)
                            .hint_text("new-channel"),
                    );
                    if ui.button("+ Text").clicked() {
                        self.create_channel_in_guild(&gid, 0);
                    }
                    if ui.button("+ Voice").clicked() {
                        self.create_channel_in_guild(&gid, 2);
                    }
                    if ui.button("+ Stage").clicked() {
                        self.create_channel_in_guild(&gid, 13);
                    }
                });
                ui.separator();
                ui.label(
                    RichText::new("ROLES & PERMISSIONS BITFIELD")
                        .strong()
                        .color(TEXT_HEADER),
                );
                ScrollArea::vertical()
                    .id_salt("roles_perms_scroll")
                    .show(ui, |ui| {
                        for role in &guild.roles {
                            let bits = parse_bits(&role.permissions);
                            ui.collapsing(format!("Role: {} (pos {})", role.name, role.position), |ui| {
                                for (code, flag, desc) in PERMISSION_LIST.iter().take(12) {
                                    let mut enabled = has(bits, *flag);
                                    if ui
                                        .checkbox(&mut enabled, format!("{desc} ({code})"))
                                        .changed()
                                    {
                                        let next = if enabled {
                                            bits | *flag
                                        } else {
                                            bits & !*flag
                                        };
                                        self.update_role_permissions(&gid, &role.id, next);
                                    }
                                }
                            });
                        }
                    });
            });
        if !open {
            self.active_modal = None;
        }
    }

    fn render_create_join_guild_modal(&mut self, ctx: &Context) {
        let mut open = true;
        Window::new("➕ Create or Join a Server")
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .default_width(400.0)
            .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
            .show(ctx, |ui| {
                ui.label(RichText::new("CREATE A NEW SERVER").strong().color(TEXT_HEADER));
                ui.add_sized(
                    Vec2::new(ui.available_width(), 30.0),
                    TextEdit::singleline(&mut self.new_guild_name_input)
                        .hint_text("Server Name"),
                );
                ui.add_space(6.0);
                if ui
                    .add_sized(
                        Vec2::new(ui.available_width(), 32.0),
                        egui::Button::new(
                            RichText::new("Create Server").strong().color(Color32::BLACK),
                        )
                        .fill(ACCENT),
                    )
                    .clicked()
                {
                    self.create_guild();
                    self.active_modal = None;
                }

                ui.add_space(12.0);
                ui.separator();
                ui.add_space(8.0);

                ui.label(RichText::new("JOIN WITH AN INVITE CODE").strong().color(TEXT_HEADER));
                ui.add_sized(
                    Vec2::new(ui.available_width(), 30.0),
                    TextEdit::singleline(&mut self.join_invite_code_input)
                        .hint_text("cillhub://invite/arena or code"),
                );
                ui.add_space(6.0);
                if ui
                    .add_sized(
                        Vec2::new(ui.available_width(), 32.0),
                        egui::Button::new(
                            RichText::new("Join Server").strong().color(Color32::BLACK),
                        )
                        .fill(GREEN),
                    )
                    .clicked()
                {
                    self.join_invite_code();
                    self.active_modal = None;
                }
            });
        if !open {
            self.active_modal = None;
        }
    }

    fn render_create_poll_modal(&mut self, ctx: &Context) {
        let mut open = true;
        Window::new("📊 Create a Poll")
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .default_width(400.0)
            .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
            .show(ctx, |ui| {
                ui.label("Question:");
                ui.add_sized(
                    Vec2::new(ui.available_width(), 28.0),
                    TextEdit::singleline(&mut self.poll_question_input),
                );
                ui.add_space(6.0);
                ui.label("Options (comma-separated):");
                ui.add_sized(
                    Vec2::new(ui.available_width(), 28.0),
                    TextEdit::singleline(&mut self.poll_options_input),
                );
                ui.add_space(10.0);
                if ui
                    .add_sized(
                        Vec2::new(ui.available_width(), 32.0),
                        egui::Button::new(
                            RichText::new("Post Poll").strong().color(Color32::BLACK),
                        )
                        .fill(ACCENT),
                    )
                    .clicked()
                {
                    self.post_poll();
                    self.active_modal = None;
                }
            });
        if !open {
            self.active_modal = None;
        }
    }

    fn render_send_later_modal(&mut self, ctx: &Context) {
        let mut open = true;
        Window::new("🕒 Schedule Message (Send Later)")
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .default_width(400.0)
            .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
            .show(ctx, |ui| {
                ui.label("Message Content:");
                ui.add_sized(
                    Vec2::new(ui.available_width(), 28.0),
                    TextEdit::singleline(&mut self.composer_text),
                );
                ui.add_space(6.0);
                ui.label("Send At (ISO 8601):");
                ui.add_sized(
                    Vec2::new(ui.available_width(), 28.0),
                    TextEdit::singleline(&mut self.schedule_time_input),
                );
                ui.add_space(10.0);
                if ui
                    .add_sized(
                        Vec2::new(ui.available_width(), 32.0),
                        egui::Button::new(
                            RichText::new("Schedule Message").strong().color(Color32::BLACK),
                        )
                        .fill(ACCENT),
                    )
                    .clicked()
                {
                    if let (Some(api), Some(cid)) = (&self.api, &self.selected_channel_id) {
                        report(&mut self.status_banner, api.post(
                            &format!("/channels/{cid}/scheduled-messages"),
                            json!({
                                "content": self.composer_text,
                                "send_at": self.schedule_time_input,
                            }),
                        ));
                    }
                    self.status_banner = Some("Message scheduled!".to_string());
                    self.composer_text.clear();
                    self.active_modal = None;
                }
            });
        if !open {
            self.active_modal = None;
        }
    }

    fn render_quick_switcher_modal(&mut self, ctx: &Context) {
        let mut open = true;
        Window::new("⚡ Quick Switcher (Ctrl+K)")
            .open(&mut open)
            .collapsible(false)
            .resizable(false)
            .default_width(420.0)
            .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
            .show(ctx, |ui| {
                ui.add_sized(
                    Vec2::new(ui.available_width(), 30.0),
                    TextEdit::singleline(&mut self.quick_switcher_query)
                        .hint_text("Where would you like to go?"),
                );
                ui.add_space(8.0);
                let q = self.quick_switcher_query.to_lowercase();
                let channels: Vec<Channel> = self
                    .state
                    .channels
                    .values()
                    .filter(|c| {
                        c.name
                            .as_deref()
                            .unwrap_or("")
                            .to_lowercase()
                            .contains(&q)
                    })
                    .take(10)
                    .cloned()
                    .collect();
                for ch in channels {
                    let label = format!(
                        "# {}",
                        ch.display_name(self.state.me.as_ref().map(|u| u.id.as_str()))
                    );
                    if ui.button(label).clicked() {
                        self.selected_guild_id = ch.guild_id.clone();
                        self.selected_channel_id = Some(ch.id.clone());
                        self.load_channel_history(&ch.id);
                        self.active_modal = None;
                    }
                }
            });
        if !open {
            self.active_modal = None;
        }
    }

    fn render_directory_modal(&mut self, ctx: &Context) {
        let mut open = true;
        Window::new("🧭 Public Server Directory")
            .open(&mut open)
            .collapsible(false)
            .default_width(460.0)
            .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
            .show(ctx, |ui| {
                ui.label(
                    RichText::new("Discover communities on this Cillhub instance.")
                        .color(TEXT_MUTED),
                );
                ui.add_space(8.0);
                for g in self.state.sorted_guilds() {
                    Frame::new()
                        .fill(BG_SIDEBAR)
                        .inner_margin(Margin::same(10))
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                ui.label(RichText::new(&g.name).strong().color(TEXT_HEADER));
                                if let Some(desc) = &g.description {
                                    ui.label(RichText::new(desc).color(TEXT_MUTED));
                                }
                            });
                        });
                    ui.add_space(4.0);
                }
            });
        if !open {
            self.active_modal = None;
        }
    }

    pub fn render_drawer(&mut self, ui: &mut Ui, drawer: DrawerKind) {
        ui.horizontal(|ui| {
            let title = match drawer {
                DrawerKind::Threads => "THREADS",
                DrawerKind::Pins => "PINNED MESSAGES",
                DrawerKind::Saved => "SAVED BOOKMARKS",
                DrawerKind::Search => "SEARCH RESULTS",
                DrawerKind::Canvas => "SHARED CHANNEL CANVAS",
            };
            ui.label(
                RichText::new(title)
                    .font(display_font(18.0))
                    .color(TEXT_HEADER),
            );
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if ui.small_button("✕").clicked() {
                    self.active_drawer = None;
                }
            });
        });
        ui.separator();

        ScrollArea::vertical()
            .id_salt("drawer_scroll")
            .show(ui, |ui| match drawer {
                DrawerKind::Threads => {
                    let cid = self.selected_channel_id.clone();
                    let threads: Vec<Channel> = self
                        .state
                        .channels
                        .values()
                        .filter(|c| matches!(c.kind, 10 | 11 | 12) && c.parent_id == cid)
                        .cloned()
                        .collect();
                    if threads.is_empty() {
                        ui.label(RichText::new("No threads in this channel yet.").color(TEXT_MUTED));
                    }
                    for th in threads {
                        if ui
                            .button(format!("🧵 {}", th.name.as_deref().unwrap_or("Thread")))
                            .clicked()
                        {
                            self.selected_channel_id = Some(th.id);
                        }
                    }
                }
                DrawerKind::Pins => {
                    let cid = self.selected_channel_id.clone().unwrap_or_default();
                    let pinned: Vec<Message> = self
                        .state
                        .messages
                        .get(&cid)
                        .map(|list| list.iter().filter(|m| m.pinned).cloned().collect())
                        .unwrap_or_default();
                    if pinned.is_empty() {
                        ui.label(RichText::new("No pinned messages yet.").color(TEXT_MUTED));
                    }
                    for m in pinned {
                        Frame::new()
                            .fill(BG_SIDEBAR)
                            .inner_margin(Margin::same(8))
                            .show(ui, |ui| {
                                ui.label(RichText::new(&m.content).color(TEXT));
                            });
                        ui.add_space(4.0);
                    }
                }
                DrawerKind::Saved => {
                    if self.state.saved_messages.is_empty() {
                        ui.label(RichText::new("No saved messages yet.").color(TEXT_MUTED));
                    }
                    for sm in &self.state.saved_messages {
                        Frame::new()
                            .fill(BG_SIDEBAR)
                            .inner_margin(Margin::same(8))
                            .show(ui, |ui| {
                                if let Some(m) = &sm.message {
                                    ui.label(RichText::new(&m.content).color(TEXT));
                                } else {
                                    ui.label(RichText::new(&sm.message_id).color(TEXT_MUTED));
                                }
                            });
                        ui.add_space(4.0);
                    }
                }
                DrawerKind::Search => {
                    let q = self.search_query.to_lowercase();
                    let cid = self.selected_channel_id.clone().unwrap_or_default();
                    let hits: Vec<Message> = self
                        .state
                        .messages
                        .get(&cid)
                        .map(|list| {
                            list.iter()
                                .filter(|m| m.content.to_lowercase().contains(&q))
                                .cloned()
                                .collect()
                        })
                        .unwrap_or_default();
                    ui.label(
                        RichText::new(format!("{} results for '{}'", hits.len(), self.search_query))
                            .size(11.5)
                            .color(TEXT_MUTED),
                    );
                    for m in hits {
                        Frame::new()
                            .fill(BG_SIDEBAR)
                            .inner_margin(Margin::same(8))
                            .show(ui, |ui| {
                                ui.label(RichText::new(&m.content).color(TEXT));
                            });
                        ui.add_space(4.0);
                    }
                }
                DrawerKind::Canvas => {
                    ui.label(
                        RichText::new("Collaborative Markdown & Sticky Notes")
                            .size(11.5)
                            .color(TEXT_MUTED),
                    );
                    ui.add_space(6.0);
                    ui.add_sized(
                        Vec2::new(ui.available_width(), 220.0),
                        TextEdit::multiline(&mut self.canvas_doc_input)
                            .hint_text("Write shared strategy notes, scrim codes, or links…"),
                    );
                    if ui.button("Save Canvas").clicked() {
                        if let (Some(api), Some(cid)) = (&self.api, &self.selected_channel_id) {
                            report(&mut self.status_banner, api.put(
                                &format!("/channels/{cid}/canvas"),
                                Some(json!({ "doc": self.canvas_doc_input })),
                            ));
                        }
                        self.status_banner = Some("Channel canvas updated!".to_string());
                    }
                }
            });
    }

    fn create_channel_in_guild(&mut self, guild_id: &str, kind: u8) {
        let name = self.new_channel_name_input.trim().to_string();
        if name.is_empty() {
            return;
        }
        self.new_channel_name_input.clear();
        if let Some(api) = &self.api {
            if let Ok(val) = api.post(
                &format!("/guilds/{guild_id}/channels"),
                json!({ "name": name, "type": kind }),
            ) {
                report(&mut self.status_banner, self.state.apply("CHANNEL_CREATE", val));
                return;
            }
        }
        let cid = format!("ch_{}", self.next_local_id());
        report(&mut self.status_banner, self.state.apply(
            "CHANNEL_CREATE",
            json!({
                "id": cid,
                "guild_id": guild_id,
                "name": name,
                "type": kind,
            }),
        ));
    }

    fn update_role_permissions(&mut self, guild_id: &str, role_id: &str, bits: u64) {
        if let Some(api) = &self.api {
            report(&mut self.status_banner, api.patch(
                &format!("/guilds/{guild_id}/roles/{role_id}"),
                json!({ "permissions": bits.to_string() }),
            ));
        }
        if let Some(g) = self.state.guilds.get_mut(guild_id) {
            if let Some(r) = g.roles.iter_mut().find(|r| r.id == role_id) {
                r.permissions = bits.to_string();
            }
        }
    }

    fn create_guild(&mut self) {
        let name = self.new_guild_name_input.trim().to_string();
        if name.is_empty() {
            return;
        }
        self.new_guild_name_input.clear();
        if let Some(api) = &self.api {
            if let Ok(val) = api.post("/guilds", json!({ "name": name })) {
                report(&mut self.status_banner, self.state.apply("GUILD_CREATE", val));
                return;
            }
        }
        let gid = format!("g_{}", self.next_local_id());
        let cid = format!("c_{}", self.next_local_id());
        let ch = Channel {
            id: cid.clone(),
            kind: 0,
            guild_id: Some(gid.clone()),
            name: Some("general".to_string()),
            ..Default::default()
        };
        let guild = Guild {
            id: gid.clone(),
            name,
            owner_id: self
                .state
                .me
                .as_ref()
                .map(|u| u.id.clone())
                .unwrap_or_default(),
            roles: vec![Role {
                id: gid.clone(),
                name: "@everyone".to_string(),
                permissions: "70356545".to_string(),
                ..Default::default()
            }],
            channels: vec![ch.clone()],
            ..Default::default()
        };
        self.state.channels.insert(cid.clone(), ch);
        self.state.guilds.insert(gid.clone(), guild);
        self.selected_guild_id = Some(gid);
        self.selected_channel_id = Some(cid);
    }

    pub fn join_invite_code(&mut self) {
        let raw = self.join_invite_code_input.trim().to_string();
        if raw.is_empty() {
            return;
        }
        let code = match crate::deeplink::parse_deep_link(&raw) {
            Some(crate::deeplink::DeepLinkTarget::Invite(c)) => c,
            _ => raw.trim_start_matches('/').to_string(),
        };
        if let Some(api) = &self.api {
            match api.post(&format!("/invites/{code}"), json!({})) {
                Ok(_) => self.status_banner = Some(format!("Joined invite {code}!")),
                Err(e) => self.status_banner = Some(e.to_string()),
            }
        } else {
            self.status_banner = Some(format!("Processed invite code: {code}"));
        }
    }

    fn post_poll(&mut self) {
        let Some(cid) = self.selected_channel_id.clone() else {
            return;
        };
        let answers: Vec<PollAnswer> = self
            .poll_options_input
            .split(',')
            .enumerate()
            .filter_map(|(i, s)| {
                let t = s.trim();
                if t.is_empty() {
                    None
                } else {
                    Some(PollAnswer {
                        answer_id: (i + 1) as u32,
                        poll_media: PollMedia {
                            text: Some(t.to_string()),
                            emoji: None,
                        },
                    })
                }
            })
            .collect();
        let poll = Poll {
            question: PollMedia {
                text: Some(self.poll_question_input.clone()),
                emoji: None,
            },
            answers,
            expiry: None,
            allow_multiselect: false,
            layout_type: 1,
            results: Some(PollResults::default()),
        };
        if let Some(api) = &self.api {
            report(&mut self.status_banner, api.post(
                &format!("/channels/{cid}/messages"),
                json!({ "content": "", "poll": poll }),
            ));
        }
        let msg = Message {
            id: format!("m_{}", self.next_local_id()),
            channel_id: cid.clone(),
            content: String::new(),
            author: self.state.me.clone(),
            poll: Some(poll),
            timestamp: Some("just now".to_string()),
            ..Default::default()
        };
        self.state.messages.entry(cid).or_default().push(msg);
    }
}
