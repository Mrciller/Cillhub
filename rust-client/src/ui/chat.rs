//! Main Chat View matching `client/src/components/Chat.tsx` and `Composer.tsx`:
//! 44px `.chat-header` with vector `icon_btn` toolbar, notched `.channel-start` HUD banner,
//! grouped `.msg.head` message rows with 36px `draw_avatar` and hover `.toolbar`,
//! notched `GameInviteCard`, and `.composer` bar with `+` popover menu.

use super::report;
use crate::i18n::t;
use crate::league::{parse_game_invite, GameInviteData};
use crate::model::{Channel, Emoji, Message, Reaction, SavedMessage};
use crate::theme::{
    bold_font, display_font, draw_avatar, draw_icon, icon_btn, mono_font, palette::*,
    show_notched_card, ui_font, IconKind,
};
use crate::ui::{CillhubApp, DrawerKind, ModalKind};
use egui::{
    Align, Align2, Color32, CornerRadius, Frame, Layout, Margin, Rect, RichText, ScrollArea,
    Sense, Stroke, TextEdit, Ui, Vec2,
};
use serde_json::json;

impl CillhubApp {
    pub fn render_chat_view(&mut self, ui: &mut Ui, channel: &Channel) {
        let cid = channel.id.clone();
        let ch_name = channel.display_name(self.state.me.as_ref().map(|u| u.id.as_str()));
        let ch_icon = match channel.kind {
            1 | 3 => IconKind::People,
            2 => IconKind::Speaker,
            13 => IconKind::Stage,
            15 => IconKind::Forum,
            _ => IconKind::Hash,
        };

        // 1. `.chat-header` (`44px` height, `border-bottom: 1px solid #2c3038`, `padding: 0 12px`)
        Frame::new()
            .fill(BG_CHAT)
            .inner_margin(Margin::symmetric(12, 6))
            .show(ui, |ui| {
                ui.set_height(32.0);
                ui.horizontal(|ui| {
                    let (ic_rect, _) = ui.allocate_exact_size(Vec2::splat(20.0), Sense::hover());
                    draw_icon(ui.painter(), ic_rect, ch_icon, TEXT_MUTED);
                    ui.label(
                        RichText::new(ch_name.to_uppercase())
                            .font(display_font(20.0))
                            .color(TEXT_HEADER),
                    );

                    if let Some(topic) = channel.topic.as_deref().filter(|s| !s.is_empty()) {
                        let (div_r, _) =
                            ui.allocate_exact_size(Vec2::new(8.0, 18.0), Sense::hover());
                        ui.painter().vline(
                            div_r.center().x,
                            div_r.y_range(),
                            Stroke::new(1.0_f32, BORDER),
                        );
                        ui.label(
                            RichText::new(topic)
                                .font(ui_font(12.5))
                                .color(TEXT_MUTED),
                        );
                    }

                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.spacing_mut().item_spacing.x = 4.0;

                        // Inbox / Saved Messages drawer
                        let saved_open = self.active_drawer == Some(DrawerKind::Saved);
                        if icon_btn(
                            ui,
                            IconKind::Inbox,
                            "Saved Messages & Bookmarks",
                            saved_open,
                            false,
                        )
                        .clicked()
                        {
                            self.active_drawer = if saved_open {
                                None
                            } else {
                                Some(DrawerKind::Saved)
                            };
                        }

                        // Compact `.search-input` (`#0b0c0f` fill, `1px` `#2c3038` border)
                        Frame::new()
                            .fill(BG_RAIL)
                            .stroke(Stroke::new(1.0_f32, BORDER))
                            .corner_radius(CornerRadius::same(2))
                            .inner_margin(Margin::symmetric(8, 4))
                            .show(ui, |ui| {
                                ui.horizontal(|ui| {
                                    let resp = ui.add_sized(
                                        Vec2::new(128.0, 18.0),
                                        TextEdit::singleline(&mut self.search_query)
                                            .font(ui_font(12.5))
                                            .hint_text(
                                                RichText::new("Search")
                                                    .font(ui_font(12.5))
                                                    .color(TEXT_MUTED),
                                            )
                                            .frame(false),
                                    );
                                    let (sr, _) =
                                        ui.allocate_exact_size(Vec2::splat(14.0), Sense::hover());
                                    draw_icon(ui.painter(), sr, IconKind::Search, TEXT_MUTED);
                                    if resp.lost_focus()
                                        && ui.input(|i| i.key_pressed(egui::Key::Enter))
                                        && !self.search_query.trim().is_empty()
                                    {
                                        self.active_drawer = Some(DrawerKind::Search);
                                        self.run_search();
                                    }
                                });
                            });

                        // Member List Toggle
                        if icon_btn(
                            ui,
                            IconKind::People,
                            "Toggle Member List",
                            self.show_member_list,
                            false,
                        )
                        .clicked()
                        {
                            self.show_member_list = !self.show_member_list;
                        }

                        // Channel Canvas Drawer
                        let canvas_open = self.active_drawer == Some(DrawerKind::Canvas);
                        if icon_btn(
                            ui,
                            IconKind::Canvas,
                            "Channel Canvas",
                            canvas_open,
                            false,
                        )
                        .clicked()
                        {
                            self.active_drawer = if canvas_open {
                                None
                            } else {
                                Some(DrawerKind::Canvas)
                            };
                        }

                        // Pinned Messages Drawer
                        let pins_open = self.active_drawer == Some(DrawerKind::Pins);
                        if icon_btn(
                            ui,
                            IconKind::Pin,
                            "Pinned Messages",
                            pins_open,
                            false,
                        )
                        .clicked()
                        {
                            self.active_drawer = if pins_open {
                                None
                            } else {
                                self.load_pins(&cid);
                                Some(DrawerKind::Pins)
                            };
                        }

                        // Threads Drawer
                        let threads_open = self.active_drawer == Some(DrawerKind::Threads);
                        if icon_btn(
                            ui,
                            IconKind::Thread,
                            "Threads",
                            threads_open,
                            false,
                        )
                        .clicked()
                        {
                            self.active_drawer = if threads_open {
                                None
                            } else {
                                Some(DrawerKind::Threads)
                            };
                        }

                        // Share Game Lobby Invite button
                        let lobby_open = self.active_modal == Some(ModalKind::GameLobbyInvite);
                        if icon_btn(
                            ui,
                            IconKind::Gamepad,
                            "Invite to Game Lobby / League Party",
                            lobby_open,
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

        // If this is a Stage channel (type 13), show Stage controls banner
        if channel.kind == 13 {
            self.render_stage_banner(ui, channel);
        } else if channel.kind == 2 {
            let mut here: Vec<String> = self
                .state
                .voice_states
                .values()
                .filter(|vs| vs.channel_id.as_deref() == Some(channel.id.as_str()))
                .map(|vs| {
                    self.state
                        .users
                        .get(&vs.user_id)
                        .map(|u| u.display_name().to_string())
                        .unwrap_or_else(|| vs.user_id.clone())
                })
                .collect();
            here.sort();
            let who = if here.is_empty() {
                "Nobody is in this channel.".to_string()
            } else {
                format!("In this channel: {}", here.join(", "))
            };
            Frame::new()
                .fill(BG_PANEL)
                .inner_margin(Margin::symmetric(16, 10))
                .show(ui, |ui| {
                    ui.label(RichText::new(who).font(bold_font(13.0)).color(TEXT_HEADER));
                    ui.label(
                        RichText::new(super::VOICE_UNAVAILABLE)
                            .font(ui_font(12.5))
                            .color(TEXT_MUTED),
                    );
                });
        }

        // 2. Bottom `.composer-wrap` reserved first so `.messages` fills remaining height
        egui::TopBottomPanel::bottom("chat_composer_panel")
            .frame(
                Frame::new()
                    .fill(BG_CHAT)
                    .inner_margin(Margin::from(egui:: Vec2::new(12.0, 12.0))),
            )
            .show_inside(ui, |ui| {
                self.render_composer(ui, &ch_name);
            });

        // 3. `.messages` scroller
        let messages = self
            .state
            .messages
            .get(&cid)
            .cloned()
            .unwrap_or_default();

        Frame::new()
            .fill(BG_CHAT)
            .inner_margin(Margin::symmetric(0, 8))
            .show(ui, |ui| {
                ScrollArea::vertical()
                    .id_salt(("msg_scroll", &cid))
                    .auto_shrink([false, false])
                    .stick_to_bottom(true)
                    .show(ui, |ui| {
                        // `.channel-start` notched HUD banner (`Chat.tsx`)
                        Frame::new()
                            .inner_margin(Margin::symmetric(16, 12))
                            .show(ui, |ui| {
                                show_notched_card(
                                    ui,
                                    BG_SIDEBAR,
                                    BORDER,
                                    10.0,
                                    None,
                                    Some(ACCENT),
                                    Margin::symmetric(20, 16),
                                    |ui| {
                                        ui.set_width(ui.available_width());
                                        let prefix = if channel.kind == 1 || channel.kind == 3 {
                                            "@"
                                        } else {
                                            "#"
                                        };
                                        ui.horizontal(|ui| {
                                            ui.label(
                                                RichText::new(format!(
                                                    "WELCOME TO {prefix}{}!",
                                                    ch_name.to_uppercase()
                                                ))
                                                .font(display_font(30.0))
                                                .color(TEXT_HEADER),
                                            );
                                            if !messages.is_empty() {
                                                ui.with_layout(
                                                    Layout::right_to_left(Align::Center),
                                                    |ui| {
                                                        if ui
                                                            .button(
                                                                RichText::new("Load older")
                                                                    .font(ui_font(12.0))
                                                                    .color(INTERACTIVE),
                                                            )
                                                            .clicked()
                                                        {
                                                            self.load_older_messages(&cid);
                                                        }
                                                    },
                                                );
                                            }
                                        });
                                        let sub = channel
                                            .topic
                                            .as_deref()
                                            .filter(|s| !s.is_empty())
                                            .map(|s| s.to_string())
                                            .unwrap_or_else(|| {
                                                format!(
                                                    "This is the start of the {prefix}{ch_name} channel."
                                                )
                                            });
                                        ui.label(
                                            RichText::new(sub)
                                                .font(ui_font(14.0))
                                                .color(TEXT_MUTED),
                                        );
                                    },
                                );
                            });

                        let mut prev_author_id: Option<String> = None;
                        for msg in &messages {
                            let cur_author = msg
                                .author
                                .as_ref()
                                .map(|u| u.id.clone())
                                .unwrap_or_default();
                            let is_head = prev_author_id.as_deref() != Some(cur_author.as_str())
                                || msg.referenced_message.is_some();
                            self.render_message_row(ui, &cid, msg, is_head);
                            prev_author_id = Some(cur_author);
                        }
                        ui.add_space(8.0);
                    });
            });
    }

    fn render_stage_banner(&mut self, ui: &mut Ui, channel: &Channel) {
        let stage = self.state.stage_instances.get(&channel.id).cloned();
        Frame::new()
            .fill(BG_PANEL)
            .stroke(Stroke::new(1.0_f32, ACCENT))
            .inner_margin(Margin::symmetric(16, 10))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new("STAGE CHANNEL")
                            .font(display_font(14.0))
                            .color(ACCENT),
                    );
                    if let Some(st) = &stage {
                        ui.label(
                            RichText::new(&st.topic)
                                .font(bold_font(13.5))
                                .color(TEXT_HEADER),
                        );
                    } else {
                        ui.label(
                            RichText::new("No active stage topic")
                                .font(ui_font(13.0))
                                .color(TEXT_MUTED),
                        );
                    }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.label(
                            RichText::new(super::VOICE_UNAVAILABLE)
                                .font(ui_font(12.5))
                                .color(TEXT_MUTED),
                        );
                    });
                });
            });
    }

    fn render_message_row(
        &mut self,
        ui: &mut Ui,
        channel_id: &str,
        msg: &Message,
        is_head: bool,
    ) {
        let author_name = msg
            .author
            .as_ref()
            .map(|u| u.display_name().to_string())
            .unwrap_or_else(|| "System".to_string());
        let author_id = msg
            .author
            .as_ref()
            .map(|u| u.id.clone())
            .unwrap_or_else(|| "system".to_string());
        let is_me = self.state.me.as_ref().map(|u| u.id.as_str()) == Some(author_id.as_str());
        let author_game = self.state.user_game(&author_id).map(|g| g.name.clone());
        let game_invite = parse_game_invite(&msg.content);

        if is_head {
            ui.add_space(8.0);
        }

        let row_bg = if msg.mention_everyone {
            MENTION_BG
        } else {
            Color32::TRANSPARENT
        };

        Frame::new()
            .fill(row_bg)
            .inner_margin(Margin::symmetric(16, if is_head { 4 } else { 2 }))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());

                // Referenced reply preview (`.msg-reply-ref`)
                if let Some(replied) = &msg.referenced_message {
                    ui.horizontal(|ui| {
                        ui.add_space(48.0);
                        let (r_rect, _) =
                            ui.allocate_exact_size(Vec2::splat(13.0), Sense::hover());
                        draw_icon(ui.painter(), r_rect, IconKind::Reply, ACCENT);
                        let rep_author = replied
                            .author
                            .as_ref()
                            .map(|u| u.display_name())
                            .unwrap_or("User");
                        ui.label(
                            RichText::new(format!("@{rep_author}"))
                                .font(bold_font(12.0))
                                .color(TEXT_HEADER),
                        );
                        ui.label(
                            RichText::new(&replied.content)
                                .font(ui_font(12.0))
                                .color(TEXT_MUTED),
                        );
                    });
                    ui.add_space(2.0);
                }

                ui.horizontal_top(|ui| {
                    ui.spacing_mut().item_spacing.x = 12.0;

                    // Left 36px column: Avatar on `.msg.head`, blank spacer on continuation
                    if is_head {
                        draw_avatar(ui, 36.0, &author_id, &author_name, None, BG_CHAT);
                    } else {
                        ui.allocate_exact_size(Vec2::new(36.0, 18.0), Sense::hover());
                    }

                    ui.vertical(|ui| {
                        ui.set_width(ui.available_width());

                        if is_head {
                            ui.horizontal(|ui| {
                                ui.spacing_mut().item_spacing.x = 8.0;
                                ui.label(
                                    RichText::new(&author_name)
                                        .font(bold_font(14.5))
                                        .color(if is_me { ACCENT } else { TEXT_HEADER }),
                                );

                                if let Some(gname) = author_game {
                                    Frame::new()
                                        .fill(Color32::from_rgba_unmultiplied(0x2f, 0xd3, 0x6a, 28))
                                        .stroke(Stroke::new(1.0_f32, GREEN))
                                        .corner_radius(CornerRadius::same(2))
                                        .inner_margin(Margin::symmetric(5, 1))
                                        .show(ui, |ui| {
                                            ui.label(
                                                RichText::new(format!("🎮 {}", gname.to_uppercase()))
                                                    .font(display_font(11.0))
                                                    .color(GREEN),
                                            );
                                        });
                                }

                                if let Some(ts) = &msg.timestamp {
                                    let short_ts = ts.get(11..16).unwrap_or(ts.as_str());
                                    ui.label(
                                        RichText::new(short_ts)
                                            .font(mono_font(11.0))
                                            .color(TEXT_MUTED),
                                    );
                                }
                                if msg.edited_timestamp.is_some() {
                                    ui.label(
                                        RichText::new("(edited)")
                                            .font(ui_font(11.0))
                                            .color(TEXT_MUTED),
                                    );
                                }
                                if msg.pinned {
                                    ui.label(
                                        RichText::new("PINNED")
                                            .font(display_font(11.0))
                                            .color(YELLOW),
                                    );
                                }

                                // Right `.toolbar` action buttons matching `Chat.tsx`
                                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                    ui.spacing_mut().item_spacing.x = 2.0;
                                    if is_me
                                        && Self::mini_toolbar_btn(ui, IconKind::Close, "Delete")
                                            .clicked()
                                    {
                                        self.delete_message(channel_id, &msg.id);
                                    }
                                    if is_me
                                        && Self::mini_toolbar_btn(ui, IconKind::Edit, "Edit")
                                            .clicked()
                                    {
                                        self.editing_message_id = Some(msg.id.clone());
                                        self.composer_text = msg.content.clone();
                                    }
                                    if Self::mini_toolbar_btn(ui, IconKind::Inbox, "Bookmark")
                                        .clicked()
                                    {
                                        self.bookmark_message(msg);
                                    }
                                    if Self::mini_toolbar_btn(ui, IconKind::Pin, "Pin / Unpin")
                                        .clicked()
                                    {
                                        self.toggle_pin_message(channel_id, msg);
                                    }
                                    if Self::mini_toolbar_btn(ui, IconKind::Thread, "Create Thread")
                                        .clicked()
                                    {
                                        self.create_thread_from_message(channel_id, msg);
                                    }
                                    if Self::mini_toolbar_btn(ui, IconKind::Reply, "Reply")
                                        .clicked()
                                    {
                                        self.reply_to_message = Some(msg.clone());
                                    }
                                    if Self::mini_toolbar_btn(ui, IconKind::Smile, "React 🔥")
                                        .clicked()
                                    {
                                        self.toggle_reaction(channel_id, &msg.id, "🔥");
                                    }
                                });
                            });
                            ui.add_space(2.0);
                        }

                        // Message Content OR GameInviteCard
                        if let Some(invite) = game_invite {
                            let clean_text: String = msg
                                .content
                                .lines()
                                .filter(|l| !l.contains("cillhub://game-invite?"))
                                .collect::<Vec<_>>()
                                .join("\n");
                            if !clean_text.trim().is_empty() {
                                ui.label(
                                    RichText::new(clean_text.trim())
                                        .font(ui_font(14.5))
                                        .color(TEXT),
                                );
                                ui.add_space(6.0);
                            }
                            self.render_game_invite_card(ui, &invite);
                        } else if !msg.content.is_empty() {
                            self.render_formatted_content(ui, &msg.content);
                        }

                        // Attachments: images inline (fit into 400x300, click = full size), other files as a card
                        for att in &msg.attachments {
                            ui.add_space(4.0);
                            let url = self.absolute_url(&att.url);
                            if let Some(size) = inline_image_size(att) {
                                let uri = format!("bytes://attachment/{}/{}", att.id, att.filename);
                                self.request_image(&uri, url.clone());
                                if self.images.get(&uri) == Some(&super::ImageLoad::Ready) {
                                    let resp = ui.add(
                                        egui::Image::new(uri.as_str())
                                            .fit_to_exact_size(size)
                                            .sense(Sense::click()),
                                    );
                                    if resp.on_hover_text(&att.filename).clicked() {
                                        self.lightbox = Some((uri, att.filename.clone(), url));
                                    }
                                    continue;
                                }
                                if self.images.get(&uri) == Some(&super::ImageLoad::Loading) {
                                    let (r, _) = ui.allocate_exact_size(size, Sense::hover());
                                    ui.painter().rect_filled(r, CornerRadius::same(2), BG_SIDEBAR);
                                    continue;
                                }
                            }
                            Frame::new()
                                .fill(BG_SIDEBAR)
                                .stroke(Stroke::new(1.0_f32, BORDER))
                                .corner_radius(CornerRadius::same(2))
                                .inner_margin(Margin::symmetric(10, 6))
                                .show(ui, |ui| {
                                    ui.horizontal(|ui| {
                                        ui.label(
                                            RichText::new(&att.filename)
                                                .font(bold_font(13.0))
                                                .color(FOCUS),
                                        );
                                        ui.label(
                                            RichText::new(format!(
                                                "({} KB)",
                                                (att.size / 1024).max(1)
                                            ))
                                            .font(mono_font(11.0))
                                            .color(TEXT_MUTED),
                                        );
                                        if ui.small_button("Open").clicked() {
                                            report(&mut self.status_banner, open::that(&url));
                                        }
                                    });
                                });
                        }

                        // Interactive Poll
                        if let Some(poll) = &msg.poll {
                            ui.add_space(6.0);
                            Frame::new()
                                .fill(BG_SIDEBAR)
                                .stroke(Stroke::new(1.0_f32, BORDER))
                                .corner_radius(CornerRadius::same(2))
                                .inner_margin(Margin::same(12))
                                .show(ui, |ui| {
                                    ui.label(
                                        RichText::new(format!(
                                            "📊 POLL — {}",
                                            poll.question
                                                .text
                                                .as_deref()
                                                .unwrap_or("Poll")
                                                .to_uppercase()
                                        ))
                                        .font(display_font(15.0))
                                        .color(TEXT_HEADER),
                                    );
                                    ui.add_space(6.0);
                                    for ans in &poll.answers {
                                        let count = poll
                                            .results
                                            .as_ref()
                                            .and_then(|r| {
                                                r.answer_counts
                                                    .iter()
                                                    .find(|a| a.id == ans.answer_id)
                                            })
                                            .map(|a| (a.count, a.me_voted))
                                            .unwrap_or((0, false));
                                        ui.horizontal(|ui| {
                                            let label = format!(
                                                "{} ({} votes)",
                                                ans.poll_media.text.as_deref().unwrap_or("Option"),
                                                count.0
                                            );
                                            if ui.selectable_label(count.1, label).clicked() {
                                                self.vote_poll(
                                                    channel_id,
                                                    &msg.id,
                                                    ans.answer_id,
                                                    !count.1,
                                                );
                                            }
                                        });
                                    }
                                });
                        }

                        // Reactions Bar (`.reactions`)
                        if !msg.reactions.is_empty() {
                            ui.add_space(4.0);
                            ui.horizontal_wrapped(|ui| {
                                for r in &msg.reactions {
                                    let ename = r.emoji.name.as_deref().unwrap_or("👍");
                                    let btn = egui::Button::new(
                                        RichText::new(format!("{ename} {}", r.count))
                                            .font(bold_font(12.0))
                                            .color(if r.me { ACCENT } else { TEXT }),
                                    )
                                    .fill(if r.me { ACCENT_SOFT } else { BG_SIDEBAR })
                                    .stroke(Stroke::new(
                                        1.0_f32,
                                        if r.me { ACCENT } else { BORDER },
                                    ));
                                    if ui.add(btn).clicked() {
                                        self.toggle_reaction(channel_id, &msg.id, ename);
                                    }
                                }
                            });
                        }
                    });
                });
            });
    }

    fn mini_toolbar_btn(ui: &mut Ui, kind: IconKind, tip: &str) -> egui::Response {
        let (rect, resp) = ui.allocate_exact_size(Vec2::splat(22.0), Sense::click());
        let hovered = resp.hovered();
        if hovered {
            ui.painter()
                .rect_filled(rect, CornerRadius::same(2), BG_HOVER);
        }
        let icon_r = Rect::from_center_size(rect.center(), Vec2::splat(13.0));
        draw_icon(
            ui.painter(),
            icon_r,
            kind,
            if hovered { TEXT_HEADER } else { TEXT_MUTED },
        );
        resp.on_hover_text(tip)
    }

    /// Notched HUD `GameInviteCard` matching `client/src/chat/GameInvite.tsx`:
    /// Teal `#0ac8b9` border + 4px left accent bar, `🎮 <Game>`, `"OPEN PARTY"` badge,
    /// Queue Name in `Barlow Condensed`, `Host: <host> • Party: <members>/<max>`, and `"▶ JOIN PARTY"` button.
    pub fn render_game_invite_card(&mut self, ui: &mut Ui, invite: &GameInviteData) {
        show_notched_card(
            ui,
            LEAGUE_BG,
            LEAGUE_TEAL,
            8.0,
            None,
            Some(LEAGUE_TEAL),
            Margin::symmetric(14, 12),
            |ui| {
                ui.set_max_width(360.0);
                ui.horizontal(|ui| {
                    let (ic_r, _) = ui.allocate_exact_size(Vec2::splat(16.0), Sense::hover());
                    draw_icon(ui.painter(), ic_r, IconKind::Gamepad, LEAGUE_TEAL);
                    ui.label(
                        RichText::new(invite.game.to_uppercase())
                            .font(display_font(15.5))
                            .color(TEXT_HEADER),
                    );
                    Frame::new()
                        .fill(Color32::from_rgb(0x06, 0x3b, 0x38))
                        .stroke(Stroke::new(1.0_f32, LEAGUE_TEAL))
                        .corner_radius(CornerRadius::same(2))
                        .inner_margin(Margin::symmetric(6, 2))
                        .show(ui, |ui| {
                            ui.label(
                                RichText::new(t(&self.locale, "game.open_party").to_uppercase())
                                    .font(display_font(11.0))
                                    .color(LEAGUE_TEAL),
                            );
                        });
                });

                ui.add_space(4.0);
                ui.label(
                    RichText::new(&invite.queue_name)
                        .font(bold_font(15.0))
                        .color(LEAGUE_TEAL),
                );
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new(format!("Host: {}", invite.host_name))
                            .font(ui_font(12.5))
                            .color(TEXT),
                    );
                    ui.label(RichText::new("•").color(TEXT_MUTED));
                    ui.label(
                        RichText::new(format!(
                            "Party: {}/{}",
                            invite.members, invite.max_members
                        ))
                        .font(mono_font(12.0))
                        .color(TEXT),
                    );
                });

                ui.add_space(8.0);
                let (btn_r, btn_resp) =
                    ui.allocate_exact_size(Vec2::new(164.0, 32.0), Sense::click());
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
                    t(&self.locale, "game.join_party").to_uppercase(),
                    display_font(14.5),
                    Color32::BLACK,
                );
                if btn_resp.clicked() {
                    self.join_game_party(invite);
                }
            },
        );
    }

    fn render_formatted_content(&self, ui: &mut Ui, content: &str) {
        if content.contains("```") {
            for (idx, part) in content.split("```").enumerate() {
                if idx % 2 == 1 {
                    Frame::new()
                        .fill(BG_RAIL)
                        .stroke(Stroke::new(1.0_f32, BORDER))
                        .corner_radius(CornerRadius::same(2))
                        .inner_margin(Margin::same(10))
                        .show(ui, |ui| {
                            ui.label(
                                RichText::new(part.trim())
                                    .font(mono_font(12.5))
                                    .color(TEXT_HEADER),
                            );
                        });
                } else if !part.trim().is_empty() {
                    ui.label(
                        RichText::new(part.trim())
                            .font(ui_font(14.5))
                            .color(TEXT),
                    );
                }
            }
        } else {
            ui.label(RichText::new(content).font(ui_font(14.5)).color(TEXT));
        }
    }

    fn render_composer(&mut self, ui: &mut Ui, ch_name: &str) {
        // Reply or Edit bar above `.composer` (`.composer-reply`)
        if let Some(reply) = self.reply_to_message.clone() {
            Frame::new()
                .fill(BG_SIDEBAR)
                .stroke(Stroke::new(1.0_f32, BORDER))
                .corner_radius(CornerRadius::same(2))
                .inner_margin(Margin::symmetric(12, 6))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        let author = reply
                            .author
                            .as_ref()
                            .map(|u| u.display_name())
                            .unwrap_or("User");
                        ui.label(
                            RichText::new(format!("Replying to @{author}"))
                                .font(bold_font(12.0))
                                .color(ACCENT),
                        );
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if Self::mini_toolbar_btn(ui, IconKind::Close, "Cancel Reply").clicked()
                            {
                                self.reply_to_message = None;
                            }
                        });
                    });
                });
            ui.add_space(4.0);
        }

        if self.editing_message_id.is_some() {
            Frame::new()
                .fill(BG_SIDEBAR)
                .stroke(Stroke::new(1.0_f32, YELLOW))
                .corner_radius(CornerRadius::same(2))
                .inner_margin(Margin::symmetric(12, 6))
                .show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.label(
                            RichText::new("Editing message — Press Enter to save")
                                .font(bold_font(12.0))
                                .color(YELLOW),
                        );
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if Self::mini_toolbar_btn(ui, IconKind::Close, "Cancel Edit").clicked()
                            {
                                self.editing_message_id = None;
                                self.composer_text.clear();
                            }
                        });
                    });
                });
            ui.add_space(4.0);
        }

        // `.composer-plus-menu` popover matching `Composer.tsx`
        if self.show_composer_plus_menu {
            Frame::new()
                .fill(BG_MENU)
                .stroke(Stroke::new(1.0_f32, BORDER))
                .corner_radius(CornerRadius::same(2))
                .inner_margin(Margin::same(8))
                .show(ui, |ui| {
                    ui.horizontal_wrapped(|ui| {
                        ui.spacing_mut().item_spacing.x = 6.0;
                        let lobby_label = if let Some(l) = &self.league_lobby {
                            format!(
                                "🎮 Share League Lobby ({}/{})",
                                l.member_count, l.max_party_size
                            )
                        } else if let Some(g) = &self.current_game {
                            format!("🎮 Share {} Lobby", g.name)
                        } else {
                            "🎮 Share Game Lobby Invite".to_string()
                        };
                        if ui
                            .add(
                                egui::Button::new(
                                    RichText::new(lobby_label)
                                        .font(bold_font(12.5))
                                        .color(LEAGUE_TEAL),
                                )
                                .fill(LEAGUE_BG)
                                .stroke(Stroke::new(1.0_f32, LEAGUE_TEAL)),
                            )
                            .clicked()
                        {
                            let invite_url = self.build_active_lobby_invite_url();
                            self.send_message_to_selected(&invite_url);
                            self.show_composer_plus_menu = false;
                        }

                        if ui.button("🎮 Custom Lobby / LCU Invite…").clicked() {
                            self.active_modal = Some(ModalKind::GameLobbyInvite);
                            self.show_composer_plus_menu = false;
                        }

                        if ui.button("📊 Create Poll").clicked() {
                            self.active_modal = Some(ModalKind::CreatePoll);
                            self.show_composer_plus_menu = false;
                        }

                        if ui.button("🕒 Send Later").clicked() {
                            self.active_modal = Some(ModalKind::SendLater);
                            self.show_composer_plus_menu = false;
                        }

                        if ui.button("📎 Upload a File").clicked() {
                            let tx = self.picked_tx.clone();
                            std::thread::spawn(move || {
                                if let Some(paths) = rfd::FileDialog::new().pick_files() {
                                    let _ = tx.send(paths); // the app may have closed
                                }
                            });
                            self.show_composer_plus_menu = false;
                        }
                    });
                });
            ui.add_space(6.0);
        }

        // Files dropped on the window join the pending uploads.
        let dropped: Vec<_> = ui
            .ctx()
            .input(|i| i.raw.dropped_files.iter().filter_map(|f| f.path.clone()).collect());
        self.pending_files.extend(dropped);
        if !self.pending_files.is_empty() {
            let mut remove = None;
            ui.horizontal_wrapped(|ui| {
                for (i, path) in self.pending_files.iter().enumerate() {
                    let name = path.file_name().map(|n| n.to_string_lossy().to_string());
                    Frame::new()
                        .fill(BG_SIDEBAR)
                        .stroke(Stroke::new(1.0_f32, BORDER))
                        .corner_radius(CornerRadius::same(2))
                        .inner_margin(Margin::symmetric(8, 4))
                        .show(ui, |ui| {
                            ui.horizontal(|ui| {
                                ui.label(
                                    RichText::new(name.unwrap_or_default())
                                        .font(ui_font(12.5))
                                        .color(TEXT),
                                );
                                if ui.small_button("x").on_hover_text("Remove").clicked() {
                                    remove = Some(i);
                                }
                            });
                        });
                }
            });
            if let Some(i) = remove {
                self.pending_files.remove(i);
            }
            ui.add_space(4.0);
        }

        // `.composer` bar (`background: var(--input)`, `border: 1px solid var(--border)`, `min-height: 44px`)
        Frame::new()
            .fill(BG_INPUT)
            .stroke(Stroke::new(1.0_f32, BORDER))
            .corner_radius(CornerRadius::same(2))
            .inner_margin(Margin::symmetric(10, 6))
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 8.0;

                    // `+` attachment/actions popover button
                    if icon_btn(
                        ui,
                        IconKind::Plus,
                        "More actions (Upload, Poll, Share Game Lobby)",
                        self.show_composer_plus_menu,
                        false,
                    )
                    .clicked()
                    {
                        self.show_composer_plus_menu = !self.show_composer_plus_menu;
                    }

                    // Input field
                    let avail_w = (ui.available_width() - 112.0).max(100.0);
                    let resp = ui.add_sized(
                        Vec2::new(avail_w, 28.0),
                        TextEdit::singleline(&mut self.composer_text)
                            .font(ui_font(14.5))
                            .text_color(TEXT)
                            .hint_text(
                                RichText::new(format!("Message #{ch_name}"))
                                    .font(ui_font(14.5))
                                    .color(TEXT_MUTED),
                            )
                            .frame(false),
                    );
                    if resp.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) {
                        self.submit_composer();
                    }

                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        ui.spacing_mut().item_spacing.x = 4.0;
                        if icon_btn(ui, IconKind::Send, "Send Message", false, false).clicked() {
                            self.submit_composer();
                        }
                        if icon_btn(
                            ui,
                            IconKind::Poll,
                            "Create Poll",
                            false,
                            false,
                        )
                        .clicked()
                        {
                            self.active_modal = Some(ModalKind::CreatePoll);
                        }
                        if icon_btn(
                            ui,
                            IconKind::Gamepad,
                            "Post Game Lobby Invite Card",
                            false,
                            false,
                        )
                        .clicked()
                        {
                            let invite_url = self.build_active_lobby_invite_url();
                            self.send_message_to_selected(&invite_url);
                        }
                    });
                });
            });
    }

    pub fn submit_composer(&mut self) {
        let content = self.composer_text.trim().to_string();
        if content.is_empty() && self.pending_files.is_empty() {
            return;
        }
        let Some(cid) = self.selected_channel_id.clone() else {
            return;
        };

        if let Some(edit_id) = self.editing_message_id.take() {
            self.composer_text.clear();
            if let Some(api) = &self.api {
                // The gateway's MESSAGE_UPDATE shows the edit; on failure keep the draft.
                let r = api.patch(
                    &format!("/channels/{cid}/messages/{edit_id}"),
                    json!({ "content": content }),
                );
                if report(&mut self.status_banner, r).is_none() {
                    self.editing_message_id = Some(edit_id);
                    self.composer_text = content;
                }
                return;
            }
            if let Some(list) = self.state.messages.get_mut(&cid) {
                if let Some(m) = list.iter_mut().find(|m| m.id == edit_id) {
                    m.content = content;
                    m.edited_timestamp = Some("just now".to_string());
                }
            }
            return;
        }

        if !self.pending_files.is_empty() {
            self.send_files(&cid, &content);
            return;
        }
        self.composer_text.clear();
        self.send_message_to_selected(&content);
    }

    /// Multipart upload like the web client: payload_json + files[n]. Pending files and the
    /// text stay in the composer when it fails.
    fn send_files(&mut self, cid: &str, content: &str) {
        let Some(api) = &self.api else {
            self.status_banner = Some("Uploads need a connection to a server.".to_string());
            return;
        };
        let mut files = Vec::new();
        for path in &self.pending_files {
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| "file".to_string());
            match std::fs::read(path) {
                Ok(bytes) => files.push((name, bytes)),
                Err(e) => {
                    self.status_banner = Some(format!("Could not read {}: {e}", path.display()));
                    return;
                }
            }
        }
        let names: Vec<String> = files.iter().map(|(n, _)| n.clone()).collect();
        let reply = self.reply_to_message.as_ref().map(|m| m.id.clone());
        let payload = crate::api::upload_payload(content, &names, reply.as_deref());
        let Some(val) = report(&mut self.status_banner, api.upload_message(cid, &payload, &files))
        else {
            return;
        };
        self.pending_files.clear();
        self.composer_text.clear();
        self.reply_to_message = None;
        if let Some(msg) = report(&mut self.status_banner, crate::model::parse::<Message>(val)) {
            if let Some(list) = self.state.messages.get_mut(cid) {
                if !list.iter().any(|m| m.id == msg.id) {
                    list.push(msg);
                }
            }
        }
    }

    pub fn send_message_to_selected(&mut self, content: &str) {
        let Some(cid) = self.selected_channel_id.clone() else {
            return;
        };
        let reply_ref = self.reply_to_message.take();

        if let Some(api) = &self.api {
            let mut body = json!({ "content": content });
            if let Some(rep) = &reply_ref {
                body["message_reference"] = json!({ "message_id": rep.id, "channel_id": cid });
            }
            match api.post(&format!("/channels/{cid}/messages"), body) {
                Ok(val) => {
                    if let Ok(msg) = crate::model::parse::<Message>(val) {
                        let list = self.state.messages.entry(cid).or_default();
                        if !list.iter().any(|m| m.id == msg.id) {
                            list.push(msg);
                        }
                    }
                    return;
                }
                Err(e) => {
                    // Keep the text so the user can retry; never show it as sent.
                    self.composer_text = content.to_string();
                    self.reply_to_message = reply_ref;
                    self.status_banner = Some(e.to_string());
                    return;
                }
            }
        }

        // Demo mode (no server): append locally.
        let msg = Message {
            id: format!("m_{}", self.next_local_id()),
            channel_id: cid.clone(),
            content: content.to_string(),
            author: self.state.me.clone(),
            timestamp: Some("2026-11-10T20:45:00Z".to_string()),
            referenced_message: reply_ref.map(Box::new),
            ..Default::default()
        };
        self.state.messages.entry(cid).or_default().push(msg);
    }

    pub fn delete_message(&mut self, channel_id: &str, message_id: &str) {
        if let Some(api) = &self.api {
            let r = api.delete(&format!("/channels/{channel_id}/messages/{message_id}"));
            if report(&mut self.status_banner, r).is_none() {
                return; // still there on the server
            }
        }
        if let Some(list) = self.state.messages.get_mut(channel_id) {
            list.retain(|m| m.id != message_id);
        }
    }

    pub fn toggle_reaction(&mut self, channel_id: &str, message_id: &str, emoji_name: &str) {
        let mut already_me = false;
        // With a server the gateway's MESSAGE_REACTION_ADD/REMOVE updates the count (no double count).
        let local = self.api.is_none();
        if let Some(list) = self.state.messages.get_mut(channel_id) {
            if let Some(msg) = list.iter_mut().find(|m| m.id == message_id) {
                if let Some(r) = msg
                    .reactions
                    .iter_mut()
                    .find(|r| r.emoji.name.as_deref() == Some(emoji_name))
                {
                    already_me = r.me;
                    if local {
                        r.count = if r.me { r.count.saturating_sub(1) } else { r.count + 1 };
                        r.me = !r.me;
                    }
                } else if local {
                    msg.reactions.push(Reaction {
                        count: 1,
                        me: true,
                        emoji: Emoji {
                            name: Some(emoji_name.to_string()),
                            ..Default::default()
                        },
                    });
                }
                msg.reactions.retain(|r| r.count > 0);
            }
        }
        if let Some(api) = &self.api {
            let encoded = percent_encoding::utf8_percent_encode(
                emoji_name,
                percent_encoding::NON_ALPHANUMERIC,
            )
            .to_string();
            let path =
                format!("/channels/{channel_id}/messages/{message_id}/reactions/{encoded}/@me");
            if already_me {
                report(&mut self.status_banner, api.delete(&path));
            } else {
                report(&mut self.status_banner, api.put(&path, None));
            }
        }
    }

    pub fn toggle_pin_message(&mut self, channel_id: &str, msg: &Message) {
        let new_pinned = !msg.pinned;
        if let Some(api) = &self.api {
            let path = format!("/channels/{channel_id}/pins/{}", msg.id);
            if new_pinned {
                report(&mut self.status_banner, api.put(&path, None));
            } else {
                report(&mut self.status_banner, api.delete(&path));
            }
        }
        if let Some(list) = self.state.messages.get_mut(channel_id) {
            if let Some(m) = list.iter_mut().find(|m| m.id == msg.id) {
                m.pinned = new_pinned;
            }
        }
    }

    pub fn bookmark_message(&mut self, msg: &Message) {
        if let Some(api) = &self.api {
            report(&mut self.status_banner, api.put(
                &format!("/users/@me/saved-messages/{}", msg.id),
                Some(json!({ "channel_id": msg.channel_id })),
            ));
        }
        if !self
            .state
            .saved_messages
            .iter()
            .any(|s| s.message_id == msg.id)
        {
            self.state.saved_messages.insert(
                0,
                SavedMessage {
                    message_id: msg.id.clone(),
                    channel_id: msg.channel_id.clone(),
                    guild_id: msg.guild_id.clone(),
                    note: None,
                    due_at: None,
                    created_at: "just now".to_string(),
                    message: Some(msg.clone()),
                },
            );
        }
        self.status_banner = Some("Message saved to bookmarks!".to_string());
    }

    pub fn create_thread_from_message(&mut self, channel_id: &str, msg: &Message) {
        let name = if msg.content.is_empty() {
            "Discussion Thread".to_string()
        } else {
            msg.content.chars().take(32).collect()
        };
        if let Some(api) = &self.api {
            if let Ok(val) = api.post(
                &format!("/channels/{channel_id}/messages/{}/threads", msg.id),
                json!({ "name": name }),
            ) {
                if let Ok(th) = serde_json::from_value::<Channel>(val) {
                    let tid = th.id.clone();
                    self.state.channels.insert(tid.clone(), th);
                    self.selected_channel_id = Some(tid);
                    return;
                }
            }
        }
        let tid = format!("th_{}", self.next_local_id());
        let th = Channel {
            id: tid.clone(),
            kind: 11,
            guild_id: self.selected_guild_id.clone(),
            parent_id: Some(channel_id.to_string()),
            name: Some(name),
            ..Default::default()
        };
        self.state.channels.insert(tid.clone(), th);
        self.selected_channel_id = Some(tid);
    }

    pub fn vote_poll(&mut self, channel_id: &str, message_id: &str, answer_id: u32, add: bool) {
        if let Some(api) = &self.api {
            let path =
                format!("/channels/{channel_id}/polls/{message_id}/answers/{answer_id}/@me");
            if add {
                report(&mut self.status_banner, api.put(&path, None));
            } else {
                report(&mut self.status_banner, api.delete(&path));
            }
        }
        let me_id = self
            .state
            .me
            .as_ref()
            .map(|u| u.id.clone())
            .unwrap_or_else(|| "me".to_string());
        let ev = if add {
            "MESSAGE_POLL_VOTE_ADD"
        } else {
            "MESSAGE_POLL_VOTE_REMOVE"
        };
        report(&mut self.status_banner, self.state.apply(
            ev,
            json!({
                "channel_id": channel_id,
                "message_id": message_id,
                "user_id": me_id,
                "answer_id": answer_id,
            }),
        ));
    }
}

/// Size of an inline image like the web client (chat/Attachments.tsx fit): only the types the
/// hub serves inline, scaled down to fit 400x300. None = show a file card.
pub fn inline_image_size(att: &crate::model::Attachment) -> Option<Vec2> {
    let ty = att.content_type.as_deref().unwrap_or("");
    if !matches!(ty, "image/png" | "image/jpeg" | "image/gif" | "image/webp") {
        return None;
    }
    Some(match (att.width, att.height) {
        (Some(w), Some(h)) if w > 0 && h > 0 => {
            let k = (400.0 / w as f32).min(300.0 / h as f32).min(1.0);
            Vec2::new((w as f32 * k).round(), (h as f32 * k).round())
        }
        _ => Vec2::new(400.0, 300.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Attachment;

    #[test]
    fn inline_images_fit_like_the_web_client() {
        let att = |ty: &str, w, h| Attachment {
            content_type: Some(ty.into()),
            width: w,
            height: h,
            ..Default::default()
        };
        assert_eq!(inline_image_size(&att("image/png", Some(1600), Some(900))), Some(Vec2::new(400.0, 225.0)));
        assert_eq!(inline_image_size(&att("image/jpeg", Some(200), Some(100))), Some(Vec2::new(200.0, 100.0)));
        assert_eq!(inline_image_size(&att("image/webp", None, None)), Some(Vec2::new(400.0, 300.0)));
        assert_eq!(inline_image_size(&att("image/svg+xml", Some(10), Some(10))), None);
        assert_eq!(inline_image_size(&att("application/pdf", None, None)), None);
    }
}
