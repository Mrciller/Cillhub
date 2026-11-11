//! Home / Friends / Direct Messages view + Active Now shelf matching
//! `client/src/components/Friends.tsx` and `client/src/components/ActiveNow.tsx`.

use super::report;
use crate::i18n::tr;
use crate::model::{Channel, Relationship, User};
use crate::theme::{
    bold_font, display_font, draw_avatar, draw_icon, draw_list_heading, icon_btn, palette::*,
    round_icon_btn, show_notched_card, ui_font, IconKind,
};
use crate::ui::{CillhubApp, FriendsTab, ModalKind};
use egui::{
    Align, Align2, Color32, CornerRadius, Frame, Layout, Margin, RichText, ScrollArea,
    Sense, SidePanel, Stroke, StrokeKind, TextEdit, Ui, Vec2,
};
use serde_json::json;

impl CillhubApp {
    pub fn render_friends_view(&mut self, ui: &mut Ui) {
        // 1. `.chat-header` (`44px` height, `border-bottom: 1px solid #2c3038`, `padding: 0 12px`)
        Frame::new()
            .fill(BG_CHAT)
            .inner_margin(Margin::symmetric(12, 6))
            .show(ui, |ui| {
                ui.set_height(32.0);
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 8.0;
                    let (ic_r, _) = ui.allocate_exact_size(Vec2::splat(20.0), Sense::hover());
                    draw_icon(ui.painter(), ic_r, IconKind::People, TEXT_MUTED);
                    ui.label(
                        RichText::new(tr("Friends").to_uppercase())
                            .font(display_font(20.0))
                            .color(TEXT_HEADER),
                    );

                    let (div_r, _) = ui.allocate_exact_size(Vec2::new(6.0, 18.0), Sense::hover());
                    ui.painter().vline(
                        div_r.center().x,
                        div_r.y_range(),
                        Stroke::new(1.0_f32, BORDER),
                    );

                    for (tab, label) in [
                        (FriendsTab::Online, tr("Online")),
                        (FriendsTab::All, tr("All")),
                        (FriendsTab::Pending, tr("Pending")),
                        (FriendsTab::Blocked, tr("Blocked")),
                    ] {
                        let active = self.friends_tab == tab;
                        if Self::friends_tab_pill(ui, &label, active, false).clicked() {
                            self.friends_tab = tab;
                        }
                    }

                    let add_active = self.friends_tab == FriendsTab::Add;
                    if Self::friends_tab_pill(
                        ui,
                        tr("Add Friend"),
                        add_active,
                        true,
                    )
                    .clicked()
                    {
                        self.friends_tab = FriendsTab::Add;
                    }

                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.spacing_mut().item_spacing.x = 6.0;
                        if icon_btn(
                            ui,
                            IconKind::Gamepad,
                            "Invite to Game Lobby",
                            self.active_modal == Some(ModalKind::GameLobbyInvite),
                            false,
                        )
                        .clicked()
                        {
                            self.active_modal = Some(ModalKind::GameLobbyInvite);
                        }
                    });
                });
            });

        let hr = ui.min_rect();
        ui.painter()
            .hline(hr.x_range(), hr.max.y, Stroke::new(1.0_f32, BORDER));

        // 2. Right `.active-now-shelf` (`330px` wide, `border-left: 1px solid #2c3038`) matching `ActiveNow.tsx`
        SidePanel::right("friends_active_now_shelf")
            .exact_width(330.0)
            .resizable(false)
            .frame(Frame::new().fill(BG_CHAT))
            .show_inside(ui, |ui| {
                let s_rect = ui.max_rect();
                ui.painter().vline(
                    s_rect.min.x + 0.5,
                    s_rect.y_range(),
                    Stroke::new(1.0_f32, BORDER),
                );
                Frame::new()
                    .inner_margin(Margin::symmetric(16, 16))
                    .show(ui, |ui| {
                        ScrollArea::vertical()
                            .id_salt("active_now_scroll")
                            .show(ui, |ui| {
                                ui.label(
                                    RichText::new("ACTIVE NOW")
                                        .font(display_font(22.0))
                                        .color(TEXT_HEADER),
                                );
                                ui.add_space(10.0);

                                // Card 1: Local Game Activity
                                show_notched_card(
                                    ui,
                                    BG_SIDEBAR,
                                    BORDER,
                                    8.0,
                                    None,
                                    Some(ACCENT),
                                    Margin::same(14),
                                    |ui| {
                                        ui.set_width(ui.available_width());
                                        ui.horizontal(|ui| {
                                            ui.label(
                                                RichText::new("YOUR GAME ACTIVITY")
                                                    .font(display_font(13.5))
                                                    .color(ACCENT),
                                            );
                                            ui.with_layout(
                                                Layout::right_to_left(Align::Center),
                                                |ui| {
                                                    let mut share = self.settings.share_activity;
                                                    if ui.checkbox(&mut share, "Share").changed() {
                                                        self.set_share_activity(share);
                                                    }
                                                },
                                            );
                                        });
                                        ui.add_space(6.0);
                                        if let Some(g) = &self.current_game {
                                            ui.label(
                                                RichText::new(format!("🎮 Playing {}", g.name))
                                                    .font(bold_font(14.5))
                                                    .color(GREEN),
                                            );
                                            ui.label(
                                                RichText::new(
                                                    "Broadcasting via Gateway Opcode 3",
                                                )
                                                .font(ui_font(11.5))
                                                .color(TEXT_MUTED),
                                            );
                                        } else {
                                            ui.label(
                                                RichText::new("No active game process detected.")
                                                    .font(ui_font(12.5))
                                                    .color(TEXT_MUTED),
                                            );
                                        }
                                        ui.add_space(8.0);
                                        ui.horizontal(|ui| {
                                            if ui.small_button("🔄 Rescan").clicked() {
                                                self.poll_game_activity(true);
                                            }
                                            if ui.small_button("⚙ Custom Games").clicked() {
                                                self.settings_tab = crate::ui::SettingsTab::Games;
                                                self.active_modal = Some(ModalKind::UserSettings);
                                            }
                                        });
                                    },
                                );

                                ui.add_space(10.0);

                                // Card 2: Game Lobby & League Party Invites
                                show_notched_card(
                                    ui,
                                    LEAGUE_BG,
                                    LEAGUE_TEAL,
                                    8.0,
                                    None,
                                    Some(LEAGUE_TEAL),
                                    Margin::same(14),
                                    |ui| {
                                        ui.set_width(ui.available_width());
                                        ui.label(
                                            RichText::new("GAME LOBBY & PARTY INVITES")
                                                .font(display_font(13.5))
                                                .color(LEAGUE_TEAL),
                                        );
                                        ui.add_space(4.0);
                                        if let Some(lobby) = &self.league_lobby {
                                            ui.label(
                                                RichText::new(format!(
                                                    "League of Legends — {}",
                                                    lobby.queue_name
                                                ))
                                                .font(bold_font(13.5))
                                                .color(TEXT_HEADER),
                                            );
                                            ui.label(
                                                RichText::new(format!(
                                                    "Party: {}/{} · Ready to Share",
                                                    lobby.member_count, lobby.max_party_size
                                                ))
                                                .font(ui_font(11.5))
                                                .color(TEXT_MUTED),
                                            );
                                        } else {
                                            ui.label(
                                                RichText::new(
                                                    "Share an interactive Open Party card or connect to LeagueClientUx.",
                                                )
                                                .font(ui_font(12.0))
                                                .color(TEXT_MUTED),
                                            );
                                        }
                                        ui.add_space(8.0);
                                        let (btn_r, btn_resp) = ui.allocate_exact_size(
                                            Vec2::new(ui.available_width(), 32.0),
                                            Sense::click(),
                                        );
                                        ui.painter().rect_filled(
                                            btn_r,
                                            CornerRadius::same(2),
                                            if btn_resp.hovered() {
                                                Color32::from_rgb(0x22, 0xe0, 0xd0)
                                            } else {
                                                LEAGUE_TEAL
                                            },
                                        );
                                        ui.painter().text(
                                            btn_r.center(),
                                            Align2::CENTER_CENTER,
                                            "🎮 SHARE GAME LOBBY INVITE",
                                            display_font(14.0),
                                            Color32::BLACK,
                                        );
                                        if btn_resp.clicked() {
                                            self.active_modal = Some(ModalKind::GameLobbyInvite);
                                        }
                                    },
                                );

                                ui.add_space(12.0);

                                // Active friends in games (`ActiveNow.tsx`)
                                let active_friends: Vec<(User, String)> = self
                                    .state
                                    .relationships
                                    .values()
                                    .filter(|r| r.kind == 1)
                                    .filter_map(|r| {
                                        let u = r
                                            .user
                                            .clone()
                                            .or_else(|| self.state.users.get(&r.id).cloned())?;
                                        let g = self.state.user_game(&u.id)?;
                                        Some((u, g.name.clone()))
                                    })
                                    .collect();

                                for (friend, gname) in active_friends {
                                    let st = self.state.user_status(&friend.id).to_string();
                                    Frame::new()
                                        .fill(BG_SIDEBAR)
                                        .stroke(Stroke::new(1.0_f32, BORDER))
                                        .corner_radius(CornerRadius::same(2))
                                        .inner_margin(Margin::same(12))
                                        .show(ui, |ui| {
                                            ui.set_width(ui.available_width());
                                            ui.horizontal(|ui| {
                                                draw_avatar(
                                                    ui,
                                                    34.0,
                                                    &friend.id,
                                                    friend.display_name(),
                                                    Some(&st),
                                                    BG_SIDEBAR,
                                                );
                                                ui.vertical(|ui| {
                                                    ui.label(
                                                        RichText::new(friend.display_name())
                                                            .font(bold_font(13.5))
                                                            .color(TEXT_HEADER),
                                                    );
                                                    ui.label(
                                                        RichText::new(format!("🎮 {gname}"))
                                                            .font(bold_font(12.0))
                                                            .color(GREEN),
                                                    );
                                                });
                                                ui.with_layout(
                                                    Layout::right_to_left(Align::Center),
                                                    |ui| {
                                                        if ui.small_button("Invite").clicked() {
                                                            self.open_or_create_dm(&friend);
                                                            let url = self
                                                                .build_active_lobby_invite_url();
                                                            self.send_message_to_selected(&url);
                                                        }
                                                    },
                                                );
                                            });
                                        });
                                    ui.add_space(6.0);
                                }
                            });
                    });
            });

        // 3. Left `.friends-body` (`padding: 16px 24px`) matching `Friends.tsx`
        Frame::new()
            .fill(BG_CHAT)
            .inner_margin(Margin::symmetric(24, 18))
            .show(ui, |ui| {
                if self.friends_tab == FriendsTab::Add {
                    ui.label(
                        RichText::new("ADD FRIEND")
                            .font(display_font(22.0))
                            .color(TEXT_HEADER),
                    );
                    ui.add_space(2.0);
                    ui.label(
                        RichText::new("You can add friends with their Cillhub username.")
                            .font(ui_font(13.5))
                            .color(TEXT_MUTED),
                    );
                    ui.add_space(14.0);

                    // `.add-friend-box` (`#0b0c0f` fill, `1px` `#2c3038` border)
                    Frame::new()
                        .fill(BG_RAIL)
                        .stroke(Stroke::new(1.0_f32, BORDER))
                        .corner_radius(CornerRadius::same(2))
                        .inner_margin(Margin::symmetric(12, 8))
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                let avail_w = (ui.available_width() - 180.0).max(120.0);
                                let resp = ui.add_sized(
                                    Vec2::new(avail_w, 32.0),
                                    TextEdit::singleline(&mut self.add_friend_input)
                                        .font(ui_font(14.5))
                                        .text_color(TEXT)
                                        .hint_text(
                                            RichText::new("You can add friends with their Cillhub username.")
                                                .font(ui_font(14.0))
                                                .color(TEXT_MUTED),
                                        )
                                        .frame(false),
                                );
                                if resp.lost_focus()
                                    && ui.input(|i| i.key_pressed(egui::Key::Enter))
                                {
                                    self.send_friend_request();
                                }

                                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                    let (b_rect, b_resp) = ui.allocate_exact_size(
                                        Vec2::new(164.0, 32.0),
                                        Sense::click(),
                                    );
                                    ui.painter().rect_filled(
                                        b_rect,
                                        CornerRadius::same(2),
                                        if b_resp.hovered() {
                                            ACCENT_HOVER
                                        } else {
                                            ACCENT
                                        },
                                    );
                                    ui.painter().text(
                                        b_rect.center(),
                                        Align2::CENTER_CENTER,
                                        "SEND FRIEND REQUEST",
                                        display_font(13.5),
                                        ON_ACCENT,
                                    );
                                    if b_resp.clicked() {
                                        self.send_friend_request();
                                    }
                                });
                            });
                        });
                    return;
                }

                let rels: Vec<Relationship> = self
                    .state
                    .relationships
                    .values()
                    .filter(|r| match self.friends_tab {
                        FriendsTab::Online => {
                            r.kind == 1 && self.state.user_status(&r.id) != "offline"
                        }
                        FriendsTab::All => r.kind == 1,
                        FriendsTab::Pending => r.kind == 3 || r.kind == 4,
                        FriendsTab::Blocked => r.kind == 2,
                        FriendsTab::Add => false,
                    })
                    .cloned()
                    .collect();

                draw_list_heading(
                    ui,
                    &format!("{} — {}", self.friends_tab.label(), rels.len()),
                );
                ui.add_space(8.0);

                ScrollArea::vertical()
                    .id_salt("friends_list_scroll")
                    .show(ui, |ui| {
                        if rels.is_empty() {
                            ui.add_space(24.0);
                            ui.vertical_centered(|ui| {
                                ui.label(
                                    RichText::new(match self.friends_tab {
                                        FriendsTab::Pending => "There are no pending friend requests.",
                                        FriendsTab::Blocked => "You have not blocked anyone.",
                                        FriendsTab::Online => "No one's around to play with.",
                                        _ => "You have no friends yet. Add some with their username!",
                                    })
                                        .font(ui_font(14.0))
                                        .color(TEXT_MUTED),
                                );
                            });
                        }

                        for rel in rels {
                            let user = rel
                                .user
                                .clone()
                                .or_else(|| self.state.users.get(&rel.id).cloned())
                                .unwrap_or(User {
                                    id: rel.id.clone(),
                                    username: rel.id.clone(),
                                    ..Default::default()
                                });
                            let status = self.state.user_status(&user.id).to_string();
                            let game = self.state.user_game(&user.id).cloned();

                            // Top hairline separator matching `.friend-row` (`border-top: 1px solid rgba(44,48,56,0.55)`)
                            let (line_r, _) = ui.allocate_exact_size(
                                Vec2::new(ui.available_width(), 1.0),
                                Sense::hover(),
                            );
                            ui.painter().hline(
                                line_r.x_range(),
                                line_r.center().y,
                                Stroke::new(
                                    1.0_f32,
                                    Color32::from_rgba_unmultiplied(0x2c, 0x30, 0x38, 140),
                                ),
                            );

                            let (row_r, row_resp) = ui.allocate_exact_size(
                                Vec2::new(ui.available_width(), 58.0),
                                Sense::click(),
                            );
                            let hovered = row_resp.hovered();
                            if hovered {
                                ui.painter()
                                    .rect_filled(row_r, CornerRadius::same(2), BG_HOVER);
                            }

                            let mut row_ui = ui.new_child(
                                egui::UiBuilder::new()
                                    .max_rect(row_r.shrink2(Vec2::new(10.0, 8.0)))
                                    .layout(Layout::left_to_right(Align::Center)),
                            );
                            row_ui.style_mut().interaction.selectable_labels = false;
                            row_ui.spacing_mut().item_spacing.x = 12.0;

                            draw_avatar(
                                &mut row_ui,
                                40.0,
                                &user.id,
                                user.display_name(),
                                Some(&status),
                                if hovered { BG_HOVER } else { BG_CHAT },
                            );

                            row_ui.vertical(|ui| {
                                ui.spacing_mut().item_spacing.y = 2.0;
                                ui.horizontal(|ui| {
                                    ui.spacing_mut().item_spacing.x = 6.0;
                                    ui.label(
                                        RichText::new(user.display_name())
                                            .font(bold_font(15.0))
                                            .color(TEXT_HEADER),
                                    );
                                    if hovered {
                                        ui.label(
                                            RichText::new(format!("@{}", user.username))
                                                .font(ui_font(12.5))
                                                .color(TEXT_MUTED),
                                        );
                                    }
                                });
                                if let Some(g) = game {
                                    ui.label(
                                        RichText::new(format!("🎮 Playing {}", g.name))
                                            .font(ui_font(12.5))
                                            .color(GREEN),
                                    );
                                } else {
                                    let st_label = match rel.kind {
                                        3 => "Incoming Friend Request",
                                        4 => "Outgoing Friend Request",
                                        2 => "Blocked",
                                        _ => status.as_str(),
                                    };
                                    ui.label(
                                        RichText::new(st_label)
                                            .font(ui_font(12.5))
                                            .color(TEXT_MUTED),
                                    );
                                }
                            });

                            row_ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                ui.spacing_mut().item_spacing.x = 8.0;
                                if round_icon_btn(
                                    ui,
                                    IconKind::Close,
                                    "Remove",
                                    false,
                                    true,
                                )
                                .clicked()
                                {
                                    self.remove_relationship(&rel.id);
                                }

                                if rel.kind == 1 {
                                    if round_icon_btn(
                                        ui,
                                        IconKind::Gamepad,
                                        "Send Game Lobby Invite",
                                        false,
                                        false,
                                    )
                                    .clicked()
                                    {
                                        self.open_or_create_dm(&user);
                                        let url = self.build_active_lobby_invite_url();
                                        self.send_message_to_selected(&url);
                                    }
                                    if round_icon_btn(
                                        ui,
                                        IconKind::ChatBubble,
                                        "Message",
                                        false,
                                        false,
                                    )
                                    .clicked()
                                    {
                                        self.open_or_create_dm(&user);
                                    }
                                } else if rel.kind == 3 {
                                    if round_icon_btn(
                                        ui,
                                        IconKind::Check,
                                        "Accept Friend Request",
                                        true,
                                        false,
                                    )
                                    .clicked()
                                    {
                                        self.accept_friend(&rel.id);
                                    }
                                }
                            });
                        }
                    });
            });
    }

    fn friends_tab_pill(
        ui: &mut Ui,
        label: &str,
        active: bool,
        is_add: bool,
    ) -> egui::Response {
        let w = (label.len() as f32 * 7.2 + 20.0).max(54.0);
        let (rect, resp) = ui.allocate_exact_size(Vec2::new(w, 26.0), Sense::click());
        let hovered = resp.hovered();
        let painter = ui.painter();

        if is_add {
            let fill = if active {
                 Color32::from_rgba_unmultiplied(0x2f, 0xd3, 0x6a, 40)
            } else {
                GREEN
            };
            let fg = if active { GREEN } else { Color32::BLACK };
            painter.rect_filled(rect, CornerRadius::same(2), fill);
            painter.text(
                rect.center(),
                Align2::CENTER_CENTER,
                label,
                bold_font(13.0),
                fg,
            );
        } else {
            if active || hovered {
                painter.rect(
                    rect,
                    CornerRadius::same(2),
                    if active { BG_SELECTED } else { BG_HOVER },
                    if active {
                        Stroke::new(1.0_f32, ACCENT)
                    } else {
                        Stroke::NONE
                    },
                    StrokeKind::Inside,
                );
            }
            painter.text(
                rect.center(),
                Align2::CENTER_CENTER,
                label,
                if active {
                    bold_font(13.5)
                } else {
                    ui_font(13.5)
                },
                if active || hovered {
                    TEXT_HEADER
                } else {
                    INTERACTIVE
                },
            );
        }
        resp
    }

    pub fn open_or_create_dm(&mut self, target: &User) {
        if let Some(existing) = self
            .state
            .channels
            .values()
            .find(|c| c.kind == 1 && c.recipients.iter().any(|u| u.id == target.id))
            .cloned()
        {
            self.selected_guild_id = None;
            self.selected_channel_id = Some(existing.id.clone());
            self.load_channel_history(&existing.id);
            return;
        }
        if let Some(api) = &self.api {
            if let Ok(val) =
                api.post("/users/@me/channels", json!({ "recipient_id": target.id }))
            {
                if let Ok(ch) = serde_json::from_value::<Channel>(val) {
                    let cid = ch.id.clone();
                    self.state.channels.insert(cid.clone(), ch);
                    self.selected_guild_id = None;
                    self.selected_channel_id = Some(cid.clone());
                    self.load_channel_history(&cid);
                    return;
                }
            }
        }
        // Fallback for local/demo mode
        let cid = format!("dm_{}", target.id);
        let ch = Channel {
            id: cid.clone(),
            kind: 1,
            recipients: vec![target.clone()],
            ..Default::default()
        };
        self.state.channels.insert(cid.clone(), ch);
        self.selected_guild_id = None;
        self.selected_channel_id = Some(cid);
    }

    pub fn send_friend_request(&mut self) {
        let username = self.add_friend_input.trim().to_string();
        if username.is_empty() {
            return;
        }
        if let Some(api) = &self.api {
            match api.post("/users/@me/relationships", json!({ "username": username })) {
                Ok(_) => {
                    self.status_banner = Some(format!("Friend request sent to {username}!"));
                    self.add_friend_input.clear();
                }
                Err(e) => self.status_banner = Some(e.to_string()),
            }
        } else {
            let id = format!("u_{username}");
            let user = User {
                id: id.clone(),
                username: username.clone(),
                global_name: Some(username.clone()),
                ..Default::default()
            };
            self.state.users.insert(id.clone(), user.clone());
            self.state.relationships.insert(
                id.clone(),
                Relationship {
                    id,
                    kind: 1,
                    user: Some(user),
                    nickname: None,
                },
            );
            self.add_friend_input.clear();
            self.status_banner = Some(format!("Added {username} as a friend."));
        }
    }

    pub fn accept_friend(&mut self, user_id: &str) {
        if let Some(api) = &self.api {
            report(&mut self.status_banner, api.put(
                &format!("/users/@me/relationships/{user_id}"),
                Some(json!({ "type": 1 })),
            ));
        }
        if let Some(rel) = self.state.relationships.get_mut(user_id) {
            rel.kind = 1;
        }
    }

    pub fn remove_relationship(&mut self, user_id: &str) {
        if let Some(api) = &self.api {
            report(&mut self.status_banner, api.delete(&format!("/users/@me/relationships/{user_id}")));
        }
        self.state.relationships.remove(user_id);
    }
}
