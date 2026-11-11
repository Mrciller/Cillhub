//! Main Chat View matching `client/src/components/Chat.tsx` and `Composer.tsx`:
//! 44px `.chat-header` with vector `icon_btn` toolbar, notched `.channel-start` HUD banner,
//! grouped `.msg.head` message rows with 36px `draw_avatar` and hover `.toolbar`,
//! notched `GameInviteCard`, and `.composer` bar with `+` popover menu.

use super::{open_external, report};
use crate::i18n::{tr, trf};
use crate::league::{parse_game_invite, GameInviteData};
use crate::model::{Channel, Emoji, Message, Reaction, SavedMessage};
use crate::theme::{
    bold_font, display_font, draw_avatar, draw_icon, icon_btn, mono_font, palette::*,
    show_notched_card, ui_font, IconKind,
};
use crate::ui::{CillhubApp, DrawerKind, ModalKind};
use egui::{
    Align, Align2, Color32, CornerRadius, Frame, Layout, Margin, Rect, RichText, ScrollArea,
    Pos2, Sense, Stroke, TextEdit, Ui, Vec2,
};
use serde_json::json;

impl CillhubApp {
    pub fn render_chat_view(&mut self, ui: &mut Ui, channel: &Channel) {
        let cid = channel.id.clone();
        let ch_name = channel.display_name(self.state.me.as_ref().map(|u| u.id.as_str()));
        let ch_icon = match channel.kind {
            2 => IconKind::Speaker,
            5 => IconKind::Announcement,
            13 => IconKind::Stage,
            15 => IconKind::Forum,
            _ => IconKind::Hash,
        };

        // 1. `.chat-header` (Chat.tsx): 44px, padding 0 14px, title left, topic after a rule
        //    (cut to fit), the web's buttons right: threads, pins, canvas, members, search, inbox.
        let header_bg = BG_CHAT().lerp_to_gamma(BG_SIDEBAR(), 0.06);
        let (hdr, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 44.0), Sense::hover());
        ui.painter().rect_filled(hdr, 0.0, header_bg);
        ui.painter().hline(hdr.x_range(), hdr.max.y - 0.5, Stroke::new(1.0_f32, BORDER()));
        let in_guild = channel.guild_id.is_some();
        let text_like = matches!(channel.kind, 0 | 5);
        let n_btns = 2 + usize::from(text_like) + usize::from(in_guild) + 1; // pins, canvas, threads, members, inbox
        let right_w = n_btns as f32 * 32.0 + 168.0 + 8.0 * (n_btns as f32);
        let mut hui = ui.new_child(
            egui::UiBuilder::new()
                .max_rect(hdr.shrink2(Vec2::new(14.0, 0.0)))
                .layout(Layout::left_to_right(Align::Center)),
        );
        hui.spacing_mut().item_spacing.x = 8.0;
        let left_w = hui.available_width() - right_w - 16.0;
        hui.allocate_ui_with_layout(Vec2::new(left_w.max(60.0), 44.0), Layout::left_to_right(Align::Center), |ui| {
            ui.style_mut().interaction.selectable_labels = false;
            match ch_icon {
                IconKind::Hash => {
                    let hash = if matches!(channel.kind, 1 | 3) { "@" } else { "#" };
                    ui.label(RichText::new(hash).font(ui_font(20.0)).color(TEXT_MUTED()));
                }
                k => {
                    let (r, _) = ui.allocate_exact_size(Vec2::splat(22.0), Sense::hover());
                    draw_icon(ui.painter(), r, k, OFFLINE());
                }
            }
            let max_title = ui.available_width() * 0.5;
            ui.allocate_ui(Vec2::new(max_title, 44.0), |ui| {
                ui.add(
                    egui::Label::new(RichText::new(ch_name.to_uppercase()).font(display_font(20.0)).color(TEXT_HEADER()))
                        .truncate(),
                )
            });
            if let Some(topic) = channel.topic.as_deref().filter(|s| !s.is_empty()) {
                ui.add_space(0.0);
                let (div_r, _) = ui.allocate_exact_size(Vec2::new(1.0, 20.0), Sense::hover());
                ui.painter().vline(div_r.center().x, div_r.y_range(), Stroke::new(1.0_f32, BORDER()));
                ui.add(egui::Label::new(RichText::new(topic.replace('\n', " ")).font(ui_font(13.0)).color(TEXT_MUTED())).truncate());
            }
        });
        hui.with_layout(Layout::right_to_left(Align::Center), |ui| {
            ui.spacing_mut().item_spacing.x = 8.0;
            let saved_open = self.active_drawer == Some(DrawerKind::Saved);
            if icon_btn(ui, IconKind::Inbox, tr("Inbox"), saved_open, false).clicked() {
                self.active_drawer = if saved_open { None } else { Some(DrawerKind::Saved) };
            }
            // `.search-box`: 168x30, rail fill, icon at the right
            let (sr, _) = ui.allocate_exact_size(Vec2::new(168.0, 30.0), Sense::hover());
            let sid = ui.id().with("header_search");
            let focused = ui.memory(|m| m.has_focus(sid));
            ui.painter().rect(sr, CornerRadius::same(2), BG_RAIL(), Stroke::new(1.0_f32, if focused { FOCUS() } else { BORDER() }), egui::StrokeKind::Inside);
            let mut child = ui.new_child(egui::UiBuilder::new().max_rect(Rect::from_min_max(sr.min + Vec2::new(10.0, 7.0), sr.max - Vec2::new(28.0, 6.0))));
            let resp = child.add(
                TextEdit::singleline(&mut self.search_query)
                    .id(sid)
                    .font(ui_font(13.5))
                    .text_color(TEXT())
                    .hint_text(RichText::new(tr("Search")).font(ui_font(13.5)).color(TEXT_MUTED()))
                    .frame(false)
                    .margin(Margin::ZERO)
                    .desired_width(sr.width() - 38.0),
            );
            draw_icon(ui.painter(), Rect::from_center_size(Pos2::new(sr.max.x - 14.0, sr.center().y), Vec2::splat(16.0)), IconKind::Search, TEXT_MUTED());
            if resp.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) && !self.search_query.trim().is_empty() {
                self.active_drawer = Some(DrawerKind::Search);
                self.run_search();
            }
            if in_guild && !matches!(channel.kind, 2 | 13) && icon_btn(ui, IconKind::People, tr("Show Member List"), self.show_member_list, false).clicked() {
                self.show_member_list = !self.show_member_list;
            }
            let canvas_open = self.active_drawer == Some(DrawerKind::Canvas);
            if icon_btn(ui, IconKind::Canvas, tr("Channel Canvas"), canvas_open, false).clicked() {
                self.active_drawer = if canvas_open {
                    None
                } else {
                    self.load_canvas(&cid);
                    Some(DrawerKind::Canvas)
                };
            }
            let pins_open = self.active_drawer == Some(DrawerKind::Pins);
            if icon_btn(ui, IconKind::Pin, tr("Pinned Messages"), pins_open, false).clicked() {
                self.active_drawer = if pins_open {
                    None
                } else {
                    self.load_pins(&cid);
                    Some(DrawerKind::Pins)
                };
            }
            if text_like {
                let threads_open = self.active_drawer == Some(DrawerKind::Threads);
                if icon_btn(ui, IconKind::Thread, tr("Threads"), threads_open, false).clicked() {
                    self.active_drawer = if threads_open { None } else { Some(DrawerKind::Threads) };
                }
            }
        });

        // Voice and stage channels: the web's `.voice-view` (rail-dark body) with the people in
        // it and the notice in the web's `.voice-error` box. No call buttons: this app has no
        // audio yet, so none of them could work.
        if matches!(channel.kind, 2 | 13) {
            let body = ui.available_rect_before_wrap();
            ui.painter().rect_filled(body, 0.0, BG_RAIL());
            let mut here: Vec<(String, String)> = self
                .state
                .voice_states
                .values()
                .filter(|vs| vs.channel_id.as_deref() == Some(channel.id.as_str()))
                .map(|vs| {
                    let name = self.state.users.get(&vs.user_id).map(|u| u.display_name().to_string()).unwrap_or_else(|| vs.user_id.clone());
                    (vs.user_id.clone(), name)
                })
                .collect();
            here.sort_by(|a, b| a.1.cmp(&b.1));
            let mut v = ui.new_child(egui::UiBuilder::new().max_rect(body.shrink(16.0)).layout(Layout::top_down(Align::Center)));
            v.add_space(6.0);
            let notice = tr(super::VOICE_UNAVAILABLE);
            let g = v.painter().layout_no_wrap(notice.to_string(), ui_font(13.0), DANGER());
            let (r, _) = v.allocate_exact_size(g.size() + Vec2::new(28.0, 16.0), Sense::hover());
            v.painter().rect(r, CornerRadius::same(2), DANGER().gamma_multiply(0.15), Stroke::new(1.0_f32, DANGER().gamma_multiply(0.4)), egui::StrokeKind::Inside);
            v.painter().galley(r.min + Vec2::new(14.0, 8.0), g, DANGER());
            v.add_space(16.0);
            if here.is_empty() {
                v.label(RichText::new(tr("Nobody is in this channel.")).font(ui_font(14.0)).color(TEXT_MUTED()));
            }
            for (uid, name) in here {
                v.horizontal(|ui| {
                    draw_avatar(ui, 32.0, &uid, &name, None, BG_RAIL());
                    ui.label(RichText::new(name).font(bold_font(14.0)).color(TEXT_HEADER()));
                });
            }
            return;
        }

        // 2. Bottom `.composer-wrap` reserved first so `.messages` fills remaining height
        egui::TopBottomPanel::bottom("chat_composer_panel")
            .frame(
                Frame::new()
                    .fill(BG_CHAT())
                    .inner_margin(Margin { left: 16, right: 16, top: 0, bottom: 24 }),
            )
            .show_inside(ui, |ui| {
                // Chat.tsx label: "#name" in servers, "@name" in a DM, the name in a group
                let label = match channel.kind {
                    1 => format!("@{ch_name}"),
                    3 => ch_name.clone(),
                    _ => format!("#{ch_name}"),
                };
                self.render_composer(ui, &label);
            });

        // 3. `.messages` scroller
        let messages = self
            .state
            .messages
            .get(&cid)
            .cloned()
            .unwrap_or_default();

        Frame::new()
            .fill(BG_CHAT())
            .inner_margin(Margin::symmetric(0, 8))
            .show(ui, |ui| {
                ScrollArea::vertical()
                    .id_salt(("msg_scroll", &cid))
                    .auto_shrink([false, false])
                    .stick_to_bottom(true)
                    .show(ui, |ui| {
                        // few messages sit at the bottom like the web's list (space measured last frame)
                        let pad_id = ui.id().with("bottom_pad");
                        let pad = ui.data(|d| d.get_temp::<f32>(pad_id)).unwrap_or(0.0);
                        let top = ui.min_rect().min.y;
                        ui.add_space(pad);
                        // `.channel-start` notched HUD banner (`Chat.tsx`)
                        Frame::new()
                            .inner_margin(Margin::symmetric(16, 12))
                            .show(ui, |ui| {
                                show_notched_card(
                                    ui,
                                    BG_SIDEBAR(),
                                    BORDER(),
                                    10.0,
                                    None,
                                    Some(ACCENT()),
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
                                                RichText::new(
                                                    trf("Welcome to {label}!", &[("label", &format!("{prefix}{ch_name}"))]).to_uppercase(),
                                                )
                                                .font(display_font(30.0))
                                                .color(TEXT_HEADER()),
                                            );
                                            if !messages.is_empty() {
                                                ui.with_layout(
                                                    Layout::right_to_left(Align::Center),
                                                    |ui| {
                                                        if ui
                                                            .button(
                                                                RichText::new(tr("Load older"))
                                                                    .font(ui_font(12.0))
                                                                    .color(INTERACTIVE()),
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
                                                trf("This is the start of {label}.", &[("label", &format!("{prefix}{ch_name}"))])
                                            });
                                        ui.label(
                                            RichText::new(sub)
                                                .font(ui_font(14.0))
                                                .color(TEXT_MUTED()),
                                        );
                                    },
                                );
                            });

                        let mut prev_author_id: Option<String> = None;
                        let mut prev_day = None;
                        for msg in &messages {
                            // `.date-divider` before the first message of each day
                            let day = msg.timestamp.as_deref().and_then(local_time).map(|t| t.date());
                            if day.is_some() && day != prev_day {
                                date_divider(ui, day.unwrap_or_default());
                                prev_author_id = None;
                            }
                            prev_day = day;
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
                        let content = ui.min_rect().max.y - top - pad;
                        let free = (ui.clip_rect().height() - content).max(0.0);
                        if (free - pad).abs() > 0.5 {
                            ui.data_mut(|d| d.insert_temp(pad_id, free));
                            ui.ctx().request_repaint();
                        }
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
        let author_game = self.state.user_game(&author_id).map(|g| g.name.clone());
        let game_invite = parse_game_invite(&msg.content);

        if is_head {
            ui.add_space(10.0); // `.msg.head { margin-top: 10px }`
        }
        let name_color = self.member_color(&author_id).unwrap_or(TEXT_HEADER());
        let bg_idx = ui.painter().add(egui::Shape::Noop);

        // `.msg`: padding 2px 28px 2px 58px, avatar at left 12px
        let row = Frame::new()
            .inner_margin(Margin { left: 12, right: 28, top: 2, bottom: 2 })
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.style_mut().interaction.selectable_labels = false;

                // Referenced reply preview (`.msg-reply-ref`)
                if let Some(replied) = &msg.referenced_message {
                    ui.horizontal(|ui| {
                        ui.add_space(46.0);
                        let (r_rect, _) =
                            ui.allocate_exact_size(Vec2::splat(13.0), Sense::hover());
                        draw_icon(ui.painter(), r_rect, IconKind::Reply, TEXT_MUTED());
                        let rep_author = replied
                            .author
                            .as_ref()
                            .map(|u| u.display_name())
                            .unwrap_or("User");
                        ui.label(
                            RichText::new(format!("@{rep_author}"))
                                .font(bold_font(12.5))
                                .color(TEXT_HEADER()),
                        );
                        ui.add(
                            egui::Label::new(
                                RichText::new(replied.content.replace('\n', " "))
                                    .font(ui_font(12.5))
                                    .color(TEXT_MUTED()),
                            )
                            .truncate(),
                        );
                    });
                    ui.add_space(2.0);
                }

                ui.horizontal_top(|ui| {
                    ui.spacing_mut().item_spacing.x = 10.0;

                    // Left 36px column: avatar on `.msg.head`, gutter on continuation lines
                    if is_head {
                        ui.add_space(0.0);
                        let (r, _) = ui.allocate_exact_size(Vec2::new(36.0, 38.0), Sense::hover());
                        let mut av = ui.new_child(egui::UiBuilder::new().max_rect(Rect::from_min_size(r.min + Vec2::new(0.0, 2.0), Vec2::splat(36.0))));
                        draw_avatar(&mut av, 36.0, &author_id, &author_name, None, BG_CHAT());
                    } else {
                        ui.allocate_exact_size(Vec2::new(36.0, 20.0), Sense::hover());
                    }

                    ui.vertical(|ui| {
                        ui.set_width(ui.available_width());
                        ui.spacing_mut().item_spacing.y = 0.0;

                        if is_head {
                            ui.horizontal(|ui| {
                                ui.spacing_mut().item_spacing.x = 8.0;
                                ui.set_min_height(21.0);
                                ui.label(
                                    RichText::new(&author_name)
                                        .font(bold_font(14.5))
                                        .color(name_color),
                                );

                                if let Some(gname) = author_game {
                                    Frame::new()
                                        .fill(Color32::from_rgba_unmultiplied(0x2f, 0xd3, 0x6a, 28))
                                        .stroke(Stroke::new(1.0_f32, GREEN()))
                                        .corner_radius(CornerRadius::same(2))
                                        .inner_margin(Margin::symmetric(5, 1))
                                        .show(ui, |ui| {
                                            ui.label(
                                                RichText::new(format!("🎮 {}", gname.to_uppercase()))
                                                    .font(display_font(11.0))
                                                    .color(GREEN()),
                                            );
                                        });
                                }

                                if let Some(ts) = &msg.timestamp {
                                    ui.label(
                                        RichText::new(stamp(ts))
                                            .font(ui_font(11.5))
                                            .color(TEXT_MUTED()),
                                    );
                                }
                            });
                            ui.add_space(1.0);
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
                                        .color(TEXT()),
                                );
                                ui.add_space(6.0);
                            }
                            self.render_game_invite_card(ui, &invite);
                        } else if !msg.content.is_empty() {
                            self.render_formatted_content(ui, &msg.id, &msg.content);
                        }

                        // Attachments: images inline (fit into 400x300, click = full size), other files as a card
                        for att in &msg.attachments {
                            ui.add_space(4.0);
                            let url = self.absolute_url(&att.url);
                            if let Some(size) = inline_image_size(att) {
                                let uri = format!("bytes://attachment/{}/{}", att.id, att.filename);
                                self.request_image(&uri, url.clone());
                                if self.images.get(&uri) == Some(&super::ImageLoad::Ready) {
                                    // `.att-image`: 1px border, sidebar behind transparent pixels
                                    let resp = Frame::new()
                                        .fill(BG_SIDEBAR())
                                        .stroke(Stroke::new(1.0_f32, BORDER().gamma_multiply(0.7)))
                                        .corner_radius(CornerRadius::same(3))
                                        .inner_margin(Margin::same(1))
                                        .show(ui, |ui| {
                                            ui.add(egui::Image::new(uri.as_str()).fit_to_exact_size(size).sense(Sense::click()))
                                        })
                                        .inner;
                                    if resp.clicked() {
                                        self.lightbox = Some((uri, att.filename.clone(), url));
                                    }
                                    continue;
                                }
                                if self.images.get(&uri) == Some(&super::ImageLoad::Loading) {
                                    let (r, _) = ui.allocate_exact_size(size, Sense::hover());
                                                    ui.painter().rect_filled(r, CornerRadius::same(3), BG_SIDEBAR());
                                    continue;
                                }
                            }
                            Frame::new()
                                .fill(BG_SIDEBAR())
                                .stroke(Stroke::new(1.0_f32, BORDER()))
                                .corner_radius(CornerRadius::same(2))
                                .inner_margin(Margin::symmetric(10, 6))
                                .show(ui, |ui| {
                                    ui.horizontal(|ui| {
                                        ui.label(
                                            RichText::new(&att.filename)
                                                .font(bold_font(13.0))
                                                .color(FOCUS()),
                                        );
                                        ui.label(
                                            RichText::new(format!(
                                                "({} KB)",
                                                (att.size / 1024).max(1)
                                            ))
                                            .font(mono_font(11.0))
                                            .color(TEXT_MUTED()),
                                        );
                                        if ui.small_button(tr("Open in Browser")).clicked() {
                                            open_external(&mut self.status_banner, &url);
                                        }
                                    });
                                });
                        }

                        // Interactive Poll
                        if let Some(poll) = &msg.poll {
                            ui.add_space(6.0);
                            Frame::new()
                                .fill(BG_SIDEBAR())
                                .stroke(Stroke::new(1.0_f32, BORDER()))
                                .corner_radius(CornerRadius::same(2))
                                .inner_margin(Margin::same(12))
                                .show(ui, |ui| {
                                    ui.label(
                                        RichText::new(format!(
                                            "{} — {}",
                                            tr("Poll").to_uppercase(),
                                            poll.question
                                                .text
                                                .as_deref()
                                                .unwrap_or(tr("Poll"))
                                                .to_uppercase()
                                        ))
                                        .font(display_font(15.0))
                                        .color(TEXT_HEADER()),
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
                                            let votes = if count.0 == 1 { tr("{n} vote") } else { tr("{n} votes") };
                                            let label = format!(
                                                "{} ({})",
                                                ans.poll_media.text.as_deref().unwrap_or(""),
                                                votes.replace("{n}", &count.0.to_string())
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

                        if msg.edited_timestamp.is_some() {
                            ui.label(RichText::new(tr("(edited)")).font(ui_font(11.0)).color(TEXT_MUTED()));
                        }

                        // `.reactions`: 26px chips, 5px gap
                        if !msg.reactions.is_empty() {
                            ui.add_space(5.0);
                            ui.horizontal_wrapped(|ui| {
                                ui.spacing_mut().item_spacing = Vec2::splat(5.0);
                                for r in &msg.reactions {
                                    let ename = r.emoji.name.as_deref().unwrap_or("👍");
                                    let count = r.count.to_string();
                                    let cg = ui.painter().layout_no_wrap(count, bold_font(12.5), if r.me { TEXT_HEADER() } else { TEXT() });
                                    let (rect, resp) = ui.allocate_exact_size(Vec2::new(18.0 + 16.0 + 6.0 + cg.size().x, 26.0), Sense::click());
                                    let (fill, border) = match (r.me, resp.hovered()) {
                                        (true, _) => (ACCENT().gamma_multiply(0.16), ACCENT()),
                                        (false, true) => (BG_HOVER(), BTN_SECONDARY_HOVER()),
                                        _ => (BG_SIDEBAR(), BORDER()),
                                    };
                                    ui.painter().rect(rect, CornerRadius::same(2), fill, Stroke::new(1.0_f32, border), egui::StrokeKind::Inside);
                                    crate::theme::draw_emoji(ui.painter(), Rect::from_min_size(rect.min + Vec2::new(9.0, 5.0), Vec2::splat(16.0)), ename);
                                    ui.painter().galley(rect.min + Vec2::new(31.0, (26.0 - cg.size().y) / 2.0), cg, TEXT());
                                    let btn = resp;
                                    if btn.clicked() {
                                        self.toggle_reaction(channel_id, &msg.id, ename);
                                    }
                                }
                            });
                            ui.add_space(2.0);
                        }
                    });
                });
            })
            .response;

        // Hover: row tint, gutter time, floating toolbar (`.msg:hover .toolbar`)
        let ctx = ui.ctx().clone();
        let rect = row.rect;
        let buttons = self.toolbar_buttons(channel_id, msg);
        let tb_w = buttons.len() as f32 * 32.0 - 2.0 + 8.0;
        let tb = Rect::from_min_size(
            egui::pos2(rect.max.x - 16.0 - tb_w, (rect.min.y - 16.0).max(ui.clip_rect().min.y)),
            Vec2::new(tb_w, 38.0),
        );
        let over_tb = self.toolbar_msg.as_deref() == Some(msg.id.as_str())
            && ctx.pointer_hover_pos().is_some_and(|p| tb.contains(p));
        let busy = self.active_modal.is_some() || self.confirm_delete.is_some();
        let menu_open = self.msg_menu.as_ref().is_some_and(|(id, _)| id == &msg.id)
            || matches!(&self.emoji_picker, Some((EmojiTarget::Reaction(_, id), _)) if id == &msg.id);
        let hovered = !busy && (ui.rect_contains_pointer(rect) || over_tb) || menu_open;
        let fill = if msg.mention_everyone {
            MENTION_BG()
        } else if hovered {
            BG_HOVER().gamma_multiply(0.72)
        } else {
            Color32::TRANSPARENT
        };
        ui.painter().set(bg_idx, egui::Shape::rect_filled(rect, 0.0, fill));
        if hovered {
            if !is_head {
                if let Some(t) = msg.timestamp.as_deref().and_then(local_time) {
                    ui.painter().text(
                        egui::pos2(rect.min.x + 29.0, rect.min.y + 12.0),
                        Align2::CENTER_CENTER,
                        clock(&t),
                        ui_font(11.0),
                        TEXT_MUTED(),
                    );
                }
            }
            self.toolbar_msg = Some(msg.id.clone());
            self.render_toolbar(&ctx, tb, channel_id, msg, &buttons);
        }
    }

    /// The web toolbar's buttons for this message, in the web's order (MessageItem.tsx).
    fn toolbar_buttons(&self, channel_id: &str, msg: &Message) -> Vec<MsgAction> {
        let perms = self.my_perms(channel_id);
        let has = |b| crate::permissions::has(perms, b);
        use crate::permissions::p;
        let mine = self.state.me.as_ref().map(|u| u.id.as_str()) == msg.author.as_ref().map(|u| u.id.as_str());
        let channel = self.state.channels.get(channel_id);
        let threadable = channel.is_some_and(|c| c.guild_id.is_some() && matches!(c.kind, 0 | 5))
            && has(p::CREATE_PUBLIC_THREADS);
        let mut out = Vec::new();
        if has(p::ADD_REACTIONS) {
            out.push(MsgAction::React);
        }
        if has(p::SEND_MESSAGES) {
            out.push(MsgAction::Reply);
        }
        out.push(MsgAction::Bookmark);
        if threadable {
            out.push(MsgAction::Thread);
        }
        if mine && msg.poll.is_none() {
            out.push(MsgAction::Edit);
        }
        out.push(MsgAction::More);
        if mine || has(p::MANAGE_MESSAGES) {
            out.push(MsgAction::Delete);
        }
        out
    }

    fn render_toolbar(&mut self, ctx: &egui::Context, tb: Rect, channel_id: &str, msg: &Message, buttons: &[MsgAction]) {
        let bookmarked = self.state.saved_messages.iter().any(|s| s.message_id == msg.id && s.due_at.is_none());
        egui::Area::new(egui::Id::new(("msg_toolbar", &msg.id)))
            .order(egui::Order::Foreground)
            .fixed_pos(tb.min)
            .show(ctx, |ui| {
                Frame::new()
                    .fill(BG_MENU())
                    .stroke(Stroke::new(1.0_f32, BORDER()))
                    .corner_radius(CornerRadius::same(3))
                    .shadow(SHADOW())
                    .inner_margin(Margin::same(3))
                    .show(ui, |ui| {
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 2.0;
                            for &a in buttons {
                                let (icon, tip, pressed) = match a {
                                    MsgAction::React => (IconKind::Smile, tr("Add Reaction"), false),
                                    MsgAction::Reply => (IconKind::Reply, tr("Reply"), false),
                                    MsgAction::Bookmark if bookmarked => (IconKind::Bookmark, tr("Remove Bookmark"), true),
                                    MsgAction::Bookmark => (IconKind::Bookmark, tr("Bookmark Message"), false),
                                    MsgAction::Thread => (IconKind::Thread, tr("Create Thread"), false),
                                    MsgAction::Edit => (IconKind::Edit, tr("Edit"), false),
                                    MsgAction::More => (IconKind::More, tr("More"), false),
                                    MsgAction::Delete => (IconKind::Trash, tr("Delete"), false),
                                };
                                let resp = toolbar_btn(ui, icon, pressed, a == MsgAction::Delete).on_hover_text(tip);
                                if resp.clicked() {
                                    let at = resp.rect.left_bottom();
                                    self.message_action(a, channel_id, msg, at);
                                }
                            }
                        });
                    });
            });
    }

    pub fn message_action(&mut self, a: MsgAction, channel_id: &str, msg: &Message, at: egui::Pos2) {
        match a {
            MsgAction::React => {
                self.emoji_picker = Some((EmojiTarget::Reaction(channel_id.to_string(), msg.id.clone()), at));
                self.emoji_query.clear();
            }
            MsgAction::Reply => {
                self.editing_message_id = None;
                self.reply_to_message = Some(msg.clone());
            }
            MsgAction::Bookmark => self.toggle_bookmark(msg),
            MsgAction::Thread => self.create_thread_from_message(channel_id, msg),
            MsgAction::Edit => {
                self.reply_to_message = None;
                self.editing_message_id = Some(msg.id.clone());
                self.composer_text = msg.content.clone();
            }
            MsgAction::More => self.msg_menu = Some((msg.id.clone(), at)),
            MsgAction::Delete => self.confirm_delete = Some(msg.clone()),
        }
    }

    /// The "More" menu of a message (web: the message context menu, the parts this app has).
    pub fn render_message_menu(&mut self, ctx: &egui::Context) {
        let Some((mid, at)) = self.msg_menu.clone() else { return };
        let Some(cid) = self.selected_channel_id.clone() else { return };
        let Some(msg) = self.state.messages.get(&cid).and_then(|l| l.iter().find(|m| m.id == mid)).cloned() else {
            self.msg_menu = None;
            return;
        };
        let buttons = self.toolbar_buttons(&cid, &msg);
        let perms = self.my_perms(&cid);
        let can_pin = crate::permissions::has(perms, crate::permissions::p::MANAGE_MESSAGES);
        let bookmarked = self.state.saved_messages.iter().any(|s| s.message_id == msg.id && s.due_at.is_none());
        let mut picked: Option<&str> = None;
        let resp = egui::Area::new(egui::Id::new("msg_more_menu"))
            .order(egui::Order::Foreground)
            .fixed_pos(at + Vec2::new(-180.0, 4.0))
            .show(ctx, |ui| {
                menu_frame(ui, |ui| {
                    ui.set_width(188.0);
                    let item = |ui: &mut Ui, label: &str, danger: bool| menu_item(ui, label, danger).clicked();
                    if buttons.contains(&MsgAction::React) && item(ui, tr("Add Reaction"), false) {
                        picked = Some("react");
                    }
                    if buttons.contains(&MsgAction::Edit) && item(ui, tr("Edit Message"), false) {
                        picked = Some("edit");
                    }
                    if buttons.contains(&MsgAction::Reply) && item(ui, tr("Reply"), false) {
                        picked = Some("reply");
                    }
                    if item(ui, if bookmarked { tr("Remove Bookmark") } else { tr("Bookmark Message") }, false) {
                        picked = Some("bookmark");
                    }
                    if buttons.contains(&MsgAction::Thread) && item(ui, tr("Create Thread"), false) {
                        picked = Some("thread");
                    }
                    if can_pin && item(ui, if msg.pinned { tr("Unpin Message") } else { tr("Pin Message") }, false) {
                        picked = Some("pin");
                    }
                    if item(ui, tr("Copy Text"), false) {
                        picked = Some("copy");
                    }
                    if item(ui, tr("Copy Message ID"), false) {
                        picked = Some("copy_id");
                    }
                    if buttons.contains(&MsgAction::Delete) {
                        menu_sep(ui);
                        if item(ui, tr("Delete Message"), true) {
                            picked = Some("delete");
                        }
                    }
                });
            })
            .response;
        let clicked_outside = ctx.input(|i| i.pointer.any_pressed())
            && ctx.pointer_interact_pos().is_some_and(|p| !resp.rect.contains(p));
        if picked.is_some() || clicked_outside {
            self.msg_menu = None;
        }
        match picked {
            Some("react") => self.message_action(MsgAction::React, &cid, &msg, at),
            Some("edit") => self.message_action(MsgAction::Edit, &cid, &msg, at),
            Some("reply") => self.message_action(MsgAction::Reply, &cid, &msg, at),
            Some("bookmark") => self.toggle_bookmark(&msg),
            Some("thread") => self.create_thread_from_message(&cid, &msg),
            Some("pin") => self.toggle_pin_message(&cid, &msg),
            Some("copy") => ctx.copy_text(msg.content.clone()),
            Some("copy_id") => ctx.copy_text(msg.id.clone()),
            Some("delete") => self.confirm_delete = Some(msg.clone()),
            _ => {}
        }
    }

    /// `.emoji-picker`: search, curated emoji by category (the web's emoji/data.ts), 8 per row.
    pub fn render_emoji_picker(&mut self, ctx: &egui::Context) {
        let Some((target, at)) = self.emoji_picker.clone() else { return };
        let screen = ctx.screen_rect();
        let size = Vec2::new(364.0, 380.0);
        let pos = egui::pos2(
            (at.x - size.x).clamp(screen.min.x + 8.0, screen.max.x - size.x - 8.0),
            (at.y + 4.0).min(screen.max.y - size.y - 8.0).max(screen.min.y + 8.0),
        );
        let mut picked: Option<String> = None;
        let resp = egui::Area::new(egui::Id::new("emoji_picker"))
            .order(egui::Order::Foreground)
            .fixed_pos(pos)
            .show(ctx, |ui| {
                Frame::new()
                    .fill(BG_SIDEBAR())
                    .stroke(Stroke::new(1.0_f32, BORDER()))
                    .corner_radius(CornerRadius::same(3))
                    .shadow(SHADOW())
                    .inner_margin(Margin::same(12))
                    .show(ui, |ui| {
                        ui.set_width(size.x - 24.0);
                        let q = ui.add(
                            TextEdit::singleline(&mut self.emoji_query)
                                .hint_text(tr("Find the perfect emoji"))
                                .desired_width(f32::INFINITY)
                                .margin(Margin::symmetric(10, 8)),
                        );
                        q.request_focus();
                        ui.add_space(8.0);
                        let query = self.emoji_query.trim().to_lowercase();
                        ScrollArea::vertical().max_height(300.0).show(ui, |ui| {
                            for (category, list) in emoji_list() {
                                let shown: Vec<&(String, String)> = list
                                    .iter()
                                    .filter(|(_, kw)| query.is_empty() || kw.contains(&query))
                                    .collect();
                                if shown.is_empty() {
                                    continue;
                                }
                                ui.add_space(8.0);
                                crate::theme::draw_list_heading(ui, &tr(category).to_uppercase());
                                ui.add_space(4.0);
                                for chunk in shown.chunks(8) {
                                    ui.horizontal(|ui| {
                                        ui.spacing_mut().item_spacing.x = 2.0;
                                        for (ch, kw) in chunk {
                                            let (r, resp) = ui.allocate_exact_size(Vec2::new(38.0, 40.0), Sense::click());
                                            if resp.hovered() {
                                                ui.painter().rect_filled(r, CornerRadius::same(2), BG_SELECTED());
                                            }
                                            crate::theme::draw_emoji(ui.painter(), Rect::from_center_size(r.center(), Vec2::splat(24.0)), ch);
                                            if resp.on_hover_text(format!(":{}:", kw.split(' ').next().unwrap_or(""))).clicked() {
                                                picked = Some(ch.clone());
                                            }
                                        }
                                    });
                                    ui.add_space(2.0);
                                }
                            }
                        });
                    });
            })
            .response;
        let clicked_outside = ctx.input(|i| i.pointer.any_pressed())
            && ctx.pointer_interact_pos().is_some_and(|p| !resp.rect.contains(p));
        if clicked_outside && picked.is_none() {
            self.emoji_picker = None;
        }
        if let Some(e) = picked {
            self.emoji_picker = None;
            match target {
                EmojiTarget::Reaction(cid, mid) => self.toggle_reaction(&cid, &mid, &e),
                EmojiTarget::Composer => self.composer_text.push_str(&e),
            }
        }
    }

    /// The web's "Delete Message" dialog.
    pub fn render_confirm_delete(&mut self, ctx: &egui::Context) {
        let Some(msg) = self.confirm_delete.clone() else { return };
        let mut close = false;
        let mut delete = false;
        let (_, dim_clicked) = super::modals::overlay(ctx, "confirm_delete", 448.0, |ui| {
            ui.label(RichText::new(tr("Delete Message").to_uppercase()).font(display_font(28.0)).color(TEXT_HEADER()));
            ui.add_space(16.0);
            ui.label(RichText::new(tr("Are you sure you want to delete this message?")).font(ui_font(15.0)).color(TEXT()));
            if !msg.content.is_empty() {
                ui.add_space(8.0);
                let quote: String = msg.content.chars().take(300).collect();
                let r = Frame::new()
                    .fill(BG_SIDEBAR())
                    .corner_radius(CornerRadius::same(2))
                    .inner_margin(Margin { left: 16, right: 12, top: 10, bottom: 10 })
                    .show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.label(RichText::new(quote).font(ui_font(15.0)).color(TEXT()));
                    })
                    .response
                    .rect;
                ui.painter().rect_filled(Rect::from_min_size(r.min, Vec2::new(4.0, r.height())), 0.0, ACCENT());
            }
            ui.add_space(18.0);
            super::modals::actions_row(ui, |ui| {
                if super::modals::danger_btn(ui, tr("Delete")).clicked() {
                    delete = true;
                }
                if super::modals::secondary_btn(ui, tr("Cancel")).clicked() {
                    close = true;
                }
            });
        });
        if delete {
            self.delete_message(&msg.channel_id, &msg.id);
        }
        if close || delete || dim_clicked {
            self.confirm_delete = None;
        }
    }

    /// Role colour of a member of the open server (the web's StyledName), if any.
    pub fn member_color(&self, user_id: &str) -> Option<Color32> {
        let gid = self.selected_guild_id.as_ref()?;
        let g = self.state.guilds.get(gid)?;
        let m = self.state.members.get(gid)?.get(user_id)?;
        g.roles
            .iter()
            .filter(|r| m.roles.contains(&r.id) && r.color != 0)
            .max_by_key(|r| r.position)
            .map(|r| Color32::from_rgb((r.color >> 16) as u8, (r.color >> 8) as u8, r.color as u8))
    }

    /// My permissions in a channel; DMs allow messaging, reactions and deleting own messages.
    pub fn my_perms(&self, channel_id: &str) -> u64 {
        use crate::permissions::{channel_perms, p};
        let Some(ch) = self.state.channels.get(channel_id) else { return 0 };
        let Some(me) = self.state.me.as_ref() else { return 0 };
        let Some(g) = ch.guild_id.as_ref().and_then(|g| self.state.guilds.get(g)) else {
            return p::SEND_MESSAGES | p::ADD_REACTIONS | p::ATTACH_FILES | p::EMBED_LINKS;
        };
        let member = self.state.members.get(&g.id).and_then(|m| m.get(&me.id));
        let parent = ch.parent_id.as_ref().and_then(|id| self.state.channels.get(id));
        channel_perms(g, &me.id, member, ch, parent)
    }

    /// Notched HUD `GameInviteCard` matching `client/src/chat/GameInvite.tsx`:
    /// Teal `#0ac8b9` border + 4px left accent bar, `🎮 <Game>`, `"OPEN PARTY"` badge,
    /// Queue Name in `Barlow Condensed`, `Host: <host> • Party: <members>/<max>`, and `"▶ JOIN PARTY"` button.
    pub fn render_game_invite_card(&mut self, ui: &mut Ui, invite: &GameInviteData) {
        show_notched_card(
            ui,
            LEAGUE_BG(),
            LEAGUE_TEAL(),
            8.0,
            None,
            Some(LEAGUE_TEAL()),
            Margin::symmetric(14, 12),
            |ui| {
                ui.set_max_width(360.0);
                ui.horizontal(|ui| {
                    let (ic_r, _) = ui.allocate_exact_size(Vec2::splat(16.0), Sense::hover());
                    draw_icon(ui.painter(), ic_r, IconKind::Gamepad, LEAGUE_TEAL());
                    ui.label(
                        RichText::new(invite.game.to_uppercase())
                            .font(display_font(15.5))
                            .color(TEXT_HEADER()),
                    );
                    Frame::new()
                        .fill(Color32::from_rgb(0x06, 0x3b, 0x38))
                        .stroke(Stroke::new(1.0_f32, LEAGUE_TEAL()))
                        .corner_radius(CornerRadius::same(2))
                        .inner_margin(Margin::symmetric(6, 2))
                        .show(ui, |ui| {
                            ui.label(
                                RichText::new(tr("Open Party").to_uppercase())
                                    .font(display_font(11.0))
                                    .color(LEAGUE_TEAL()),
                            );
                        });
                });

                ui.add_space(4.0);
                ui.label(
                    RichText::new(&invite.queue_name)
                        .font(bold_font(15.0))
                        .color(LEAGUE_TEAL()),
                );
                ui.horizontal(|ui| {
                    ui.label(
                        RichText::new(trf("Host: {name}", &[("name", &invite.host_name)]))
                            .font(ui_font(12.5))
                            .color(TEXT()),
                    );
                    ui.label(RichText::new("•").color(TEXT_MUTED()));
                    ui.label(
                        RichText::new(trf(
                            "Party: {members}/{max}",
                            &[("members", &invite.members.to_string()), ("max", &invite.max_members.to_string())],
                        ))
                        .font(mono_font(12.0))
                        .color(TEXT()),
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
                        LEAGUE_TEAL()
                    },
                );
                ui.painter().text(
                    btn_r.center(),
                    Align2::CENTER_CENTER,
                    tr("Join Party").to_uppercase(),
                    display_font(14.5),
                    Color32::BLACK,
                );
                if btn_resp.clicked() {
                    self.join_game_party(invite);
                }
            },
        );
    }

    /// Message text through the web client's Markdown rules (see crate::markdown).
    fn render_formatted_content(&mut self, ui: &mut Ui, msg_id: &str, content: &str) {
        let gid = self.selected_guild_id.clone();
        // parsed once per content; names and relative times may be a minute old
        let (born, cache_gid, cache) = &mut self.md_cache;
        if born.elapsed() > std::time::Duration::from_secs(60) || *cache_gid != gid || cache.len() > 2000 {
            *born = std::time::Instant::now();
            cache_gid.clone_from(&gid);
            cache.clear();
        }
        if let Some(blocks) = cache.get(content).cloned() {
            self.render_md_blocks(ui, msg_id, &blocks);
            return;
        }
        let state = &self.state;
        let user = |id: &str| {
            let m = gid.as_ref().and_then(|g| state.members.get(g)).and_then(|m| m.get(id));
            m.and_then(|m| m.nick.clone())
                .or_else(|| state.users.get(id).map(|u| u.display_name().to_string()))
        };
        let role = |id: &str| {
            let g = gid.as_ref().and_then(|g| state.guilds.get(g));
            g.and_then(|g| g.roles.iter().find(|r| r.id == id)).map(|r| r.name.clone())
        };
        let channel = |id: &str| state.channels.get(id).and_then(|c| c.name.clone());
        let time = |unix: i64, style: char| unix_time(unix, style);
        let ctx = crate::markdown::Ctx { user: &user, role: &role, channel: &channel, time: &time };
        let blocks = std::rc::Rc::new(crate::markdown::parse(content, &ctx));
        self.md_cache.2.insert(content.to_string(), blocks.clone());
        self.render_md_blocks(ui, msg_id, &blocks);
    }

    fn render_md_blocks(&mut self, ui: &mut Ui, msg_id: &str, blocks: &[crate::markdown::Block]) {
        use crate::markdown::Block;
        for b in blocks {
            match b {
                Block::Text(spans) => self.md_line(ui, msg_id, spans, ui_font(15.0), TEXT()),
                Block::Heading(level, spans) => {
                    ui.add_space(6.0);
                    let size = [22.5, 18.75, 15.0][(*level as usize - 1).min(2)];
                    self.md_line(ui, msg_id, spans, bold_font(size), TEXT_HEADER());
                    ui.add_space(2.0);
                }
                Block::Sub(spans) => self.md_line(ui, msg_id, spans, ui_font(12.0), TEXT_MUTED()),
                Block::Item(depth, marker, spans) => {
                    ui.horizontal_top(|ui| {
                        ui.add_space(8.0 + 24.0 * *depth as f32);
                        ui.spacing_mut().item_spacing.x = 6.0;
                        ui.label(RichText::new(marker).font(ui_font(15.0)).color(TEXT()));
                        ui.vertical(|ui| self.md_line(ui, msg_id, spans, ui_font(15.0), TEXT()));
                    });
                }
                Block::Quote(inner) => {
                    // `.content blockquote`: 3px accent bar, light sidebar tint
                    let fill = BG_SIDEBAR().gamma_multiply(0.55);
                    let resp = Frame::new()
                        .fill(fill)
                        .inner_margin(Margin { left: 12, right: 10, top: 2, bottom: 2 })
                        .outer_margin(Margin::symmetric(0, 4))
                        .show(ui, |ui| {
                            ui.set_width(ui.available_width());
                            self.render_md_blocks(ui, msg_id, inner)
                        });
                    let r = resp.response.rect;
                    let bar = Rect::from_min_size(r.min, Vec2::new(3.0, r.height()));
                    ui.painter().rect_filled(bar, 0.0, ACCENT());
                }
                Block::Code { lang, code } => {
                    // `.code-block`: rail fill, border, 13.5px mono, language head with a copy button
                    Frame::new()
                        .fill(BG_RAIL())
                        .stroke(Stroke::new(1.0_f32, BORDER()))
                        .corner_radius(CornerRadius::same(2))
                        .outer_margin(Margin::symmetric(0, 6))
                        .show(ui, |ui| {
                            ui.set_max_width(ui.available_width() * 0.9);
                            Frame::new()
                                .fill(BG_SIDEBAR().lerp_to_gamma(BG_RAIL(), 0.35))
                                .inner_margin(Margin { left: 12, right: 10, top: 5, bottom: 5 })
                                .show(ui, |ui| {
                                    ui.set_width(ui.available_width());
                                    ui.horizontal(|ui| {
                                        ui.label(
                                            RichText::new(lang.as_deref().unwrap_or("").to_lowercase())
                                                .font(bold_font(12.0))
                                                .color(TEXT_MUTED()),
                                        );
                                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                            let copy = ui.add(
                                                egui::Label::new(
                                                    RichText::new(tr("Copy")).font(ui_font(12.0)).color(TEXT_MUTED()),
                                                )
                                                .sense(Sense::click()),
                                            );
                                            if copy.on_hover_text(tr("Copy code")).clicked() {
                                                ui.ctx().copy_text(code.clone());
                                            }
                                        });
                                    });
                                });
                            let r = ui.min_rect();
                            ui.painter().hline(r.x_range(), r.max.y, Stroke::new(1.0_f32, BORDER()));
                            Frame::new().inner_margin(Margin::symmetric(12, 8)).show(ui, |ui| {
                                let lines: Vec<&str> = code.split('\n').collect();
                                let numbered = lines.len() >= 3;
                                for (i, l) in lines.iter().enumerate() {
                                    ui.horizontal_top(|ui| {
                                        ui.spacing_mut().item_spacing.x = 12.0;
                                        if numbered {
                                            let (r, _) = ui.allocate_exact_size(Vec2::new(28.0, 18.0), Sense::hover());
                                            ui.painter().text(
                                                r.right_center(),
                                                Align2::RIGHT_CENTER,
                                                (i + 1).to_string(),
                                                mono_font(11.5),
                                                TEXT_MUTED().gamma_multiply(0.55),
                                            );
                                        }
                                        ui.label(RichText::new(*l).font(mono_font(13.5)).color(TEXT()));
                                    });
                                }
                            });
                        });
                }
            }
        }
    }

    /// One run of styled text; clicks open links and reveal spoilers.
    fn md_line(
        &mut self,
        ui: &mut Ui,
        msg_id: &str,
        spans: &[crate::markdown::Span],
        font: egui::FontId,
        color: Color32,
    ) {
        use egui::text::{LayoutJob, TextFormat};
        let mut job = LayoutJob::default();
        let mut ranges = Vec::new();
        for sp in spans {
            let st = sp.style;
            let hidden = st.spoiler.is_some_and(|n| !self.revealed_spoilers.contains(&(msg_id.to_string(), n)));
            let mut f = TextFormat {
                font_id: if st.bold || st.mention {
                    bold_font(font.size)
                } else if st.code {
                    mono_font(font.size * 0.85)
                } else {
                    font.clone()
                },
                color,
                italics: st.italic,
                line_height: Some((font.size * 1.44).round()), // `.content { line-height: 1.44 }`
                ..Default::default()
            };
            if st.code {
                f.background = BG_SIDEBAR();
            }
            if st.mention {
                f.background = ACCENT().gamma_multiply(0.18);
                f.color = TEXT_HEADER();
            }
            if sp.link.is_some() {
                f.color = FOCUS();
                f.underline = Stroke::new(1.0_f32, FOCUS());
            }
            if st.underline {
                f.underline = Stroke::new(1.0_f32, f.color);
            }
            if st.strike {
                f.strikethrough = Stroke::new(1.0_f32, f.color);
            }
            if st.spoiler.is_some() {
                f.background = if hidden { BG_RAIL() } else { Color32::from_white_alpha(23) };
            }
            if hidden {
                f.color = BG_RAIL();
                f.underline = Stroke::NONE;
                f.strikethrough = Stroke::NONE;
            }
            let start = job.text.chars().count();
            job.append(&sp.text, 0.0, f);
            ranges.push((start..start + sp.text.chars().count(), sp, hidden));
        }
        job.wrap.max_width = ui.available_width();
        let (pos, galley, resp) = egui::Label::new(job).sense(Sense::click()).layout_in_ui(ui);
        let hit = resp.hover_pos().and_then(|p| {
            let i = galley.cursor_from_pos(p - pos).ccursor.index;
            ranges.iter().find(|(r, sp, hidden)| r.contains(&i) && (*hidden || sp.link.is_some()))
        });
        if let Some((_, sp, hidden)) = hit {
            ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
            if resp.clicked() {
                if *hidden {
                    self.revealed_spoilers.insert((msg_id.to_string(), sp.style.spoiler.unwrap_or(0)));
                } else if let Some(url) = &sp.link {
                    open_external(&mut self.status_banner, url);
                }
            }
        }
        ui.painter().galley(pos, galley, color);
    }

    /// `.composer` like the web's Composer.tsx: reply bar, file chips, `+` menu (upload, poll),
    /// text box, emoji picker and send later on the right.
    fn render_composer(&mut self, ui: &mut Ui, ch_name: &str) {
        let cid = self.selected_channel_id.clone().unwrap_or_default();
        let perms = self.my_perms(&cid);
        use crate::permissions::{has, p};
        let can_send = has(perms, p::SEND_MESSAGES);
        let can_attach = can_send && has(perms, p::ATTACH_FILES);
        let can_poll = can_send && has(perms, p::SEND_POLLS);

        // Files dropped on the window join the pending uploads.
        if can_attach {
            let dropped: Vec<_> = ui
                .ctx()
                .input(|i| i.raw.dropped_files.iter().filter_map(|f| f.path.clone()).collect());
            self.pending_files.extend(dropped);
        }

        // `.reply-bar` (also used while editing a message here)
        let bar = if let Some(reply) = &self.reply_to_message {
            let who = reply.author.as_ref().map(|u| u.display_name().to_string()).unwrap_or_default();
            Some((tr("Replying to"), who))
        } else if self.editing_message_id.is_some() {
            Some((tr("Edit Message"), String::new()))
        } else {
            None
        };
        let attached = bar.is_some() || !self.pending_files.is_empty();
        if let Some((label, who)) = bar {
            Frame::new()
                .fill(BG_SIDEBAR())
                .stroke(Stroke::new(1.0_f32, BORDER()))
                .corner_radius(CornerRadius { nw: 3, ne: 3, sw: 0, se: 0 })
                .inner_margin(Margin { left: 16, right: 12, top: 5, bottom: 5 })
                .show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 4.0;
                        ui.label(RichText::new(label).font(ui_font(13.5)).color(INTERACTIVE()));
                        ui.label(RichText::new(who).font(bold_font(13.5)).color(TEXT_HEADER()));
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            let (r, resp) = ui.allocate_exact_size(Vec2::splat(24.0), Sense::click());
                            if resp.hovered() {
                                ui.painter().rect_filled(r, CornerRadius::same(2), BG_HOVER());
                            }
                            draw_icon(ui.painter(), Rect::from_center_size(r.center(), Vec2::splat(16.0)), IconKind::Close, INTERACTIVE());
                            if resp.on_hover_text(tr("Cancel")).clicked() {
                                if self.editing_message_id.take().is_some() {
                                    self.composer_text.clear();
                                }
                                self.reply_to_message = None;
                            }
                        });
                    });
                });
        }

        let te_id = ui.make_persistent_id(("composer_text", &cid));
        let focused = ui.memory(|m| m.has_focus(te_id));
        let box_resp = Frame::new()
            .fill(BG_INPUT())
            .stroke(Stroke::new(1.0_f32, if focused { FOCUS() } else { BORDER() }))
            .corner_radius(if attached { CornerRadius { nw: 0, ne: 0, sw: 3, se: 3 } } else { CornerRadius::same(3) })
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                // `.file-chips`: 200px cards with a preview, name, size and remove
                if !self.pending_files.is_empty() {
                    let mut remove = None;
                    Frame::new().inner_margin(Margin { left: 12, right: 12, top: 18, bottom: 10 }).show(ui, |ui| {
                        ScrollArea::horizontal().id_salt("file_chips").show(ui, |ui| {
                            ui.horizontal(|ui| {
                                ui.spacing_mut().item_spacing.x = 14.0;
                                for (i, path) in self.pending_files.iter().enumerate() {
                                    let name = path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                                    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
                                    Frame::new()
                                        .fill(BG_SIDEBAR())
                                        .stroke(Stroke::new(1.0_f32, BORDER()))
                                        .corner_radius(CornerRadius::same(2))
                                        .inner_margin(Margin::same(8))
                                        .show(ui, |ui| {
                                            ui.set_width(182.0);
                                            ui.spacing_mut().item_spacing.y = 4.0;
                                            let (r, _) = ui.allocate_exact_size(Vec2::new(182.0, 120.0), Sense::hover());
                                            ui.painter().rect_filled(r, CornerRadius::same(2), BG_RAIL());
                                            let is_img = matches!(
                                                path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()).as_deref(),
                                                Some("png" | "jpg" | "jpeg" | "gif" | "webp")
                                            );
                                            let uri = format!("bytes://pending/{}", path.display());
                                            if is_img && !self.images.contains_key(&uri) {
                                                // read once; egui keeps the bytes under the uri
                                                let bytes = std::fs::metadata(path)
                                                    .ok()
                                                    .filter(|m| m.len() <= super::images::MAX_IMAGE_BYTES)
                                                    .and_then(|_| std::fs::read(path).ok())
                                                    .filter(|b| super::images::check(b).is_ok());
                                                let state = match bytes {
                                                    Some(b) => {
                                                        ui.ctx().include_bytes(uri.clone(), b);
                                                        super::ImageLoad::Ready
                                                    }
                                                    None => super::ImageLoad::Failed,
                                                };
                                                self.images.insert(uri.clone(), state);
                                            }
                                            if is_img && self.images.get(&uri) == Some(&super::ImageLoad::Ready) {
                                                egui::Image::new(uri).fit_to_exact_size(r.size()).maintain_aspect_ratio(true).paint_at(ui, r);
                                            } else {
                                                draw_icon(ui.painter(), Rect::from_center_size(r.center(), Vec2::splat(40.0)), IconKind::File, INTERACTIVE());
                                            }
                                            ui.add(egui::Label::new(RichText::new(&name).font(ui_font(13.5)).color(TEXT())).truncate());
                                            ui.horizontal(|ui| {
                                                ui.label(RichText::new(format_size(size)).font(ui_font(12.0)).color(TEXT_MUTED()));
                                                ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                                    if toolbar_btn(ui, IconKind::Trash, false, true).on_hover_text(tr("Remove Attachment")).clicked() {
                                                        remove = Some(i);
                                                    }
                                                });
                                            });
                                        });
                                }
                            });
                        });
                    });
                    let r = ui.min_rect();
                    ui.painter().hline(r.x_range(), r.max.y, Stroke::new(1.0_f32, BORDER()));
                    if let Some(i) = remove {
                        self.pending_files.remove(i);
                    }
                }

                // `.composer-row`: 40x44 icon buttons around the text box
                Frame::new().inner_margin(Margin::symmetric(8, 0)).show(ui, |ui| {
                    ui.horizontal_top(|ui| {
                        ui.spacing_mut().item_spacing.x = 0.0;
                        if can_attach || can_poll {
                            let plus = composer_btn(ui, IconKind::AddCircle, 24.0, self.show_composer_plus_menu)
                                .on_hover_text(tr("More options"));
                            if plus.clicked() {
                                self.show_composer_plus_menu = !self.show_composer_plus_menu;
                                self.plus_anchor = plus.rect.left_top();
                            }
                        }
                        let right = if can_send { 40.0 * (1.0 + f32::from(u8::from(!self.composer_text.trim().is_empty() && self.pending_files.is_empty()))) } else { 0.0 };
                        let w = (ui.available_width() - right).max(80.0);
                        let submit = focused
                            && ui.input_mut(|i| i.consume_key(egui::Modifiers::NONE, egui::Key::Enter));
                        let hint = if can_send {
                            trf("Message {label}", &[("label", ch_name)])
                        } else {
                            tr("You do not have permission to send messages in this channel.").to_string()
                        };
                        Frame::new().inner_margin(Margin::symmetric(8, 11)).show(ui, |ui| {
                            ui.add_enabled(
                                can_send,
                                TextEdit::multiline(&mut self.composer_text)
                                    .id(te_id)
                                    .font(ui_font(15.0))
                                    .text_color(TEXT())
                                    .hint_text(RichText::new(hint).font(ui_font(15.0)).color(TEXT_MUTED()))
                                    .desired_rows(1)
                                    .desired_width(w - 16.0)
                                    .frame(false)
                                    .margin(Margin::ZERO),
                            );
                        });
                        if submit {
                            self.submit_composer();
                        }
                        if can_send {
                            let smile = composer_btn(ui, IconKind::Smile, 24.0, matches!(self.emoji_picker, Some((EmojiTarget::Composer, _))))
                                .on_hover_text(tr("Select emoji"));
                            if smile.clicked() {
                                self.emoji_picker = Some((EmojiTarget::Composer, smile.rect.right_top() - Vec2::new(0.0, 384.0)));
                                self.emoji_query.clear();
                            }
                            if !self.composer_text.trim().is_empty() && self.pending_files.is_empty() && self.editing_message_id.is_none() {
                                if composer_btn(ui, IconKind::Clock, 22.0, false).on_hover_text(tr("Send later")).clicked() {
                                    self.schedule_time_input = (chrono::Local::now() + chrono::Duration::hours(1)).format("%Y-%m-%d %H:%M").to_string();
                                    self.active_modal = Some(ModalKind::SendLater);
                                }
                            }
                        }
                    });
                });
            });
        let _ = box_resp;

        // `+` menu above the button (Composer.tsx Popover: Upload a File, Create Poll, League lobby)
        if self.show_composer_plus_menu {
            let lobby = self.league_lobby.clone();
            let items = usize::from(can_attach) + usize::from(can_poll) + usize::from(lobby.is_some());
            let at = self.plus_anchor + Vec2::new(0.0, -(items as f32 * 34.0 + 12.0 + 6.0));
            let mut pick = None;
            let resp = egui::Area::new(egui::Id::new("composer_plus_menu"))
                .order(egui::Order::Foreground)
                .fixed_pos(at)
                .show(ui.ctx(), |ui| {
                    menu_frame(ui, |ui| {
                        ui.set_width(210.0);
                        if can_attach && menu_item(ui, tr("Upload a File"), false).clicked() {
                            pick = Some(0);
                        }
                        if can_poll && menu_item(ui, tr("Create Poll"), false).clicked() {
                            pick = Some(1);
                        }
                        if let Some(l) = &lobby {
                            let label = format!("🎮 {}", trf("Share League Lobby ({members}/{max})", &[("members", &l.member_count.to_string()), ("max", &l.max_party_size.to_string())]));
                            if menu_item(ui, &label, false).clicked() {
                                pick = Some(2);
                            }
                        }
                    });
                })
                .response;
            let outside = ui.ctx().input(|i| i.pointer.any_pressed())
                && ui.ctx().pointer_interact_pos().is_some_and(|p| !resp.rect.contains(p) && !Rect::from_min_size(self.plus_anchor, Vec2::new(40.0, 44.0)).contains(p));
            if pick.is_some() || outside {
                self.show_composer_plus_menu = false;
            }
            match pick {
                Some(0) => {
                    let tx = self.picked_tx.clone();
                    std::thread::spawn(move || {
                        if let Some(paths) = rfd::FileDialog::new().pick_files() {
                            let _ = tx.send(paths); // the app may have closed
                        }
                    });
                }
                Some(1) => {
                    self.poll_question_input.clear();
                    self.poll_answers = vec![String::new(), String::new()];
                    self.poll_hours = 24;
                    self.poll_multi = false;
                    self.active_modal = Some(ModalKind::CreatePoll);
                }
                Some(2) => {
                    let text = format!("{}\n{}", tr("Join my League of Legends party!"), self.build_active_lobby_invite_url());
                    self.send_message_to_selected(&text);
                }
                _ => {}
            }
        }
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
            self.status_banner = Some(tr("Uploads need a connection to a server.").to_string());
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
                    self.status_banner = Some(format!("{}: {e}", path.display()));
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
            let r = if new_pinned { api.put(&path, None) } else { api.delete(&path) };
            if report(&mut self.status_banner, r).is_none() {
                return; // unchanged on the server
            }
        }
        if let Some(list) = self.state.messages.get_mut(channel_id) {
            if let Some(m) = list.iter_mut().find(|m| m.id == msg.id) {
                m.pinned = new_pinned;
            }
        }
    }

    /// The channel canvas text (web getCanvas: GET /channels/{id}/canvas -> { content }).
    pub fn load_canvas(&mut self, cid: &str) {
        self.canvas_doc_input.clear();
        if let Some(api) = &self.api {
            if let Ok(v) = api.get(&format!("/channels/{cid}/canvas")) {
                self.canvas_doc_input = v.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
            }
        }
    }

    /// Bookmark on/off like the web's toggleBookmark (saved messages without a due date).
    pub fn toggle_bookmark(&mut self, msg: &Message) {
        let path = format!("/users/@me/saved-messages/{}/{}", msg.channel_id, msg.id);
        let on = self.state.saved_messages.iter().any(|s| s.message_id == msg.id && s.due_at.is_none());
        if let Some(api) = &self.api {
            let r = if on { api.delete(&path).map(|_| ()) } else { api.put(&path, Some(json!({}))).map(|_| ()) };
            if report(&mut self.status_banner, r).is_none() {
                return;
            }
        }
        if on {
            self.state.saved_messages.retain(|s| s.message_id != msg.id);
        } else {
            self.state.saved_messages.insert(
                0,
                SavedMessage {
                    message_id: msg.id.clone(),
                    channel_id: msg.channel_id.clone(),
                    guild_id: msg.guild_id.clone(),
                    note: None,
                    due_at: None,
                    created_at: String::new(),
                    message: Some(msg.clone()),
                },
            );
        }
    }

    pub fn create_thread_from_message(&mut self, channel_id: &str, msg: &Message) {
        let name = if msg.content.is_empty() {
            tr("Thread").to_string()
        } else {
            msg.content.chars().take(32).collect()
        };
        if let Some(api) = &self.api {
            let r = api.post(&format!("/channels/{channel_id}/messages/{}/threads", msg.id), json!({ "name": name }));
            let th = report(&mut self.status_banner, r).map(serde_json::from_value::<Channel>);
            if let Some(th) = th.and_then(|t| report(&mut self.status_banner, t)) {
                let tid = th.id.clone();
                self.state.channels.insert(tid.clone(), th);
                self.selected_channel_id = Some(tid);
            }
            return;
        }
        // demo mode (--demo, no server) only
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
            let r = if add { api.put(&path, None) } else { api.delete(&path) };
            report(&mut self.status_banner, r);
            return; // the gateway's MESSAGE_POLL_VOTE_ADD/REMOVE updates the count (no double count)
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

/// `.composer-row .icon-btn`: 40x44, interactive colour, hover header colour.
fn composer_btn(ui: &mut Ui, icon: IconKind, size: f32, active: bool) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(40.0, 44.0), Sense::click());
    let fg = if resp.hovered() || active { TEXT_HEADER() } else { INTERACTIVE() };
    draw_icon(ui.painter(), Rect::from_center_size(rect.center(), Vec2::splat(size)), icon, fg);
    resp
}

/// File size like the web's formatSize.
pub fn format_size(bytes: u64) -> String {
    match bytes {
        b if b < 1024 => format!("{b} B"),
        b if b < 1024 * 1024 => format!("{:.1} KB", b as f64 / 1024.0),
        b => format!("{:.2} MB", b as f64 / (1024.0 * 1024.0)),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MsgAction {
    React,
    Reply,
    Bookmark,
    Thread,
    Edit,
    More,
    Delete,
}

/// Where a picked emoji goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EmojiTarget {
    Reaction(String, String),
    Composer,
}

/// `.toolbar button`: 30px, interactive colour, hover fill; `pressed` = accent (aria-pressed).
pub fn toolbar_btn(ui: &mut Ui, icon: IconKind, pressed: bool, danger: bool) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(30.0), Sense::click());
    let hov = resp.hovered();
    let (bg, fg) = if hov && danger {
        (DANGER().gamma_multiply(0.15).blend(BG_HOVER().gamma_multiply(0.85)), DANGER())
    } else if hov {
        (BG_HOVER(), TEXT_HEADER())
    } else if pressed {
        (ACCENT().gamma_multiply(0.14), ACCENT())
    } else {
        (Color32::TRANSPARENT, INTERACTIVE())
    };
    ui.painter().rect_filled(rect, CornerRadius::same(2), bg);
    draw_icon(ui.painter(), Rect::from_center_size(rect.center(), Vec2::splat(18.0)), icon, fg);
    resp
}

/// `.menu` popover frame.
pub fn menu_frame<R>(ui: &mut Ui, add: impl FnOnce(&mut Ui) -> R) -> R {
    Frame::new()
        .fill(BG_MENU())
        .stroke(Stroke::new(1.0_f32, BORDER()))
        .corner_radius(CornerRadius::same(3))
        .shadow(SHADOW())
        .inner_margin(Margin::same(6))
        .show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 0.0;
            add(ui)
        })
        .inner
}

/// `.menu button`: full-width row, 14px text, hover fill (danger rows turn red).
pub fn menu_item(ui: &mut Ui, label: &str, danger: bool) -> egui::Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 34.0), Sense::click());
    let hov = resp.hovered();
    if hov {
        ui.painter().rect_filled(rect, CornerRadius::same(2), if danger { DANGER() } else { BG_HOVER() });
    }
    let fg = match (danger, hov) {
        (true, true) => Color32::WHITE,
        (true, false) => DANGER(),
        (false, true) => TEXT_HEADER(),
        _ => TEXT(),
    };
    ui.painter().text(rect.left_center() + Vec2::new(10.0, 0.0), Align2::LEFT_CENTER, label, ui_font(14.0), fg);
    resp
}

pub fn menu_sep(ui: &mut Ui) {
    ui.add_space(4.0);
    let (r, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 1.0), Sense::hover());
    ui.painter().hline(r.x_range(), r.center().y, Stroke::new(1.0_f32, BORDER()));
    ui.add_space(4.0);
}

/// The web's curated emoji (assets/emoji.json): (category, [(char, "name keywords")]).
pub fn emoji_list() -> &'static [(&'static str, Vec<(String, String)>)] {
    static E: std::sync::OnceLock<Vec<(&'static str, Vec<(String, String)>)>> = std::sync::OnceLock::new();
    E.get_or_init(|| {
        let raw: Vec<(String, Vec<String>)> =
            serde_json::from_str(include_str!("../../assets/emoji.json")).expect("emoji.json");
        raw.into_iter()
            .map(|(cat, list)| {
                let cat: &'static str = Box::leak(cat.into_boxed_str());
                let items = list
                    .into_iter()
                    .filter_map(|e| e.split_once(' ').map(|(c, k)| (c.to_string(), k.to_string())))
                    .collect();
                (cat, items)
            })
            .collect()
    })
}

fn local_time(iso: &str) -> Option<chrono::NaiveDateTime> {
    chrono::DateTime::parse_from_rfc3339(iso).ok().map(|t| t.with_timezone(&chrono::Local).naive_local())
}

/// `.date-divider`: rule, 13px condensed date with .12em spacing, rule (margin 16px 16px 8px).
fn date_divider(ui: &mut Ui, day: chrono::NaiveDate) {
    use chrono::Datelike;
    const DE: [&str; 12] = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];
    let label = if crate::i18n::is_german() {
        format!("{}. {} {}", day.day(), DE[day.month0() as usize], day.year())
    } else {
        day.format("%B %-d, %Y").to_string()
    };
    ui.add_space(16.0);
    let g = crate::theme::spaced_text(ui, &label.to_uppercase(), 13.0, TEXT_MUTED());
    let (r, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 16.0), Sense::hover());
    let r = r.shrink2(Vec2::new(16.0, 0.0));
    let (w, y) = (g.size().x, r.center().y);
    let x0 = r.center().x - w / 2.0;
    let p = ui.painter();
    p.hline(r.min.x..=(x0 - 10.0), y, Stroke::new(1.0_f32, BORDER()));
    p.hline((x0 + w + 10.0)..=r.max.x, y, Stroke::new(1.0_f32, BORDER()));
    p.galley(Pos2::new(x0, y - g.size().y / 2.0), g, TEXT_MUTED());
    ui.add_space(8.0);
}

/// Hour and minute in the UI language (web appearance/format.ts clock()).
fn clock(t: &chrono::NaiveDateTime) -> String {
    t.format(if crate::i18n::is_german() { "%H:%M" } else { "%I:%M %p" }).to_string()
}

fn short_date(t: &chrono::NaiveDateTime) -> String {
    t.format(if crate::i18n::is_german() { "%-d.%-m.%Y" } else { "%-m/%-d/%Y" }).to_string()
}

/// "Today at 11:10 PM" like the web's stamp(), in local time; `now` is local too.
pub fn stamp_at(t: chrono::NaiveDateTime, now: chrono::NaiveDateTime) -> String {
    match (now.date() - t.date()).num_days() {
        0 => trf("Today at {time}", &[("time", &clock(&t))]),
        1 => trf("Yesterday at {time}", &[("time", &clock(&t))]),
        _ => format!("{} {}", short_date(&t), clock(&t)),
    }
}

/// A server time stamp (RFC 3339, UTC) as the web shows it, in the local time zone.
pub fn stamp(iso: &str) -> String {
    match local_time(iso) {
        Some(t) => stamp_at(t, chrono::Local::now().naive_local()),
        None => iso.to_string(),
    }
}

/// <t:unix:style> in local time: t/T time, d/D date, the rest date and time.
fn unix_time(unix: i64, style: char) -> String {
    use chrono::TimeZone;
    let Some(t) = chrono::Local.timestamp_opt(unix, 0).single().map(|t| t.naive_local()) else {
        return unix.to_string();
    };
    match style {
        't' | 'T' => clock(&t),
        'd' | 'D' => short_date(&t),
        _ => format!("{} {}", short_date(&t), clock(&t)),
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
    fn stamps_like_the_web_client() {
        let at = |s: &str| chrono::NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M").unwrap();
        let now = at("2026-11-11 09:00");
        assert_eq!(stamp_at(at("2026-11-11 23:10"), now), "Today at 11:10 PM");
        assert_eq!(stamp_at(at("2026-11-10 08:05"), now), "Yesterday at 08:05 AM");
        assert_eq!(stamp_at(at("2026-11-01 13:00"), now), "11/1/2026 01:00 PM");
    }

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
