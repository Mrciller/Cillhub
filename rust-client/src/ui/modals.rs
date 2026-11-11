//! Modals and Right-Side Drawers: Game Lobby Invite, User Settings (Game Activity,
//! Custom Games, League LCU, Voice, Appearance, Security, Desktop/Updates),
//! Server Settings & Role Permissions, Create/Join Server, Create Poll, Send Later,
//! Quick Switcher, and Threads/Pins/Saved/Search/Canvas Drawers.

use super::report;
use crate::model::{
    Channel, Guild, Message, Role,
};
use crate::theme::{display_font, palette::*};
use crate::ui::{CillhubApp, DrawerKind, ModalKind};
use egui::{
    Align, Color32, Context, CornerRadius, Frame, Layout, Margin, RichText, ScrollArea,
    Stroke, TextEdit, Ui, Vec2,
};
use serde_json::json;
use crate::i18n::{tr, trf};
use crate::theme::ui_font;

/// What adding a private node agrees to (the add-link dialog and Settings › Private Nodes).
pub const SIGN_IN_NOTE: &str = "Cillhub signs you in there with your account here: the node gets your user name and avatar, never your password. Its servers then show up in your server list.";

impl CillhubApp {
    pub fn render_modals(&mut self, ctx: &Context) {
        if let Some(invite) = self.pending_game_invite.clone() {
            let (cancel, dim) = overlay(ctx, "game_invite", 448.0, |ui| {
                modal_title(ui, tr("Game invite"));
                self.render_game_invite_card(ui, &invite);
                ui.add_space(12.0);
                secondary_btn(ui, tr("Cancel")).clicked()
            });
            if cancel || dim {
                self.pending_game_invite = None;
            }
            return;
        }
        if self.pending_add_node.is_some() {
            return self.render_add_node(ctx);
        }
        let Some(modal) = self.active_modal else {
            return;
        };

        match modal {
            ModalKind::UserSettings => self.render_user_settings(ctx),
            ModalKind::ServerSettings => self.render_server_settings(ctx),
            ModalKind::CreateJoinGuild => self.render_create_join_guild_modal(ctx),
            ModalKind::CreatePoll => self.render_create_poll_modal(ctx),
            ModalKind::SendLater => self.render_send_later_modal(ctx),
            ModalKind::QuickSwitcher => self.render_quick_switcher_modal(ctx),
            ModalKind::CreateChannel => self.render_create_channel(ctx),
            ModalKind::Events => self.render_events(ctx),
        }
    }

    /// `cillhub://add-node#<address>`: the node's name and full address, that it is a separate server; only Add saves it.
    fn render_add_node(&mut self, ctx: &Context) {
        use crate::nodes::NodeCheck;
        let Some(p) = self.pending_add_node.clone() else { return };
        if p.check.is_none() {
            if let Some(q) = &mut self.pending_add_node {
                q.check = Some(NodeCheck::Checking);
            }
            let origin = p.origin.clone();
            self.spawn_bg(false, move || crate::nodes::fetch_name(&origin), |app, name| {
                if let Some(q) = &mut app.pending_add_node {
                    q.check = Some(name.map_or(NodeCheck::Down, NodeCheck::Up));
                }
            });
        }
        let host = p.origin.split("://").nth(1).unwrap_or(&p.origin).to_string();
        let error = p.error.clone().or_else(|| (p.check == Some(NodeCheck::Down)).then(|| tr("Could not connect to node at this address.").to_string()));
        let (mut add, mut close) = (false, false);
        let (_, dim) = overlay(ctx, "add_node", 448.0, |ui| {
            ui.label(RichText::new(if p.added { tr("Node added") } else { tr("Add a private node?") }).font(ui_font(15.0)).color(TEXT_MUTED()));
            ui.add_space(4.0);
            let name = match &p.check {
                Some(NodeCheck::Up(n)) if !n.is_empty() => n.clone(),
                _ => host.clone(),
            };
            modal_title(ui, &name);
            ui.label(RichText::new(&p.origin).font(crate::theme::mono_font(13.0)).color(TEXT()));
            ui.add_space(10.0);
            if !p.added {
                ui.label(RichText::new(tr("This is a separate server with its own accounts and admins.")).font(ui_font(14.0)).color(TEXT_MUTED()));
                ui.label(RichText::new(tr(SIGN_IN_NOTE)).font(ui_font(14.0)).color(TEXT_MUTED()));
            }
            if let Some(e) = &error {
                ui.add_space(8.0);
                ui.label(RichText::new(e).font(ui_font(13.0)).color(DANGER()));
            }
            ui.add_space(18.0);
            actions_row(ui, |ui| {
                if p.added {
                    close = primary_btn(ui, tr("Done")).clicked();
                    return;
                }
                if error.is_none() {
                    let ready = matches!(p.check, Some(NodeCheck::Up(_))) && !self.node_busy;
                    add = ui.add_enabled_ui(ready, |ui| primary_btn(ui, tr("Add and sign in"))).inner.clicked();
                }
                close = secondary_btn(ui, tr("Cancel")).clicked();
            });
        });
        if add {
            self.add_node(p.origin.clone(), false);
        }
        if close || dim || ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
            self.pending_add_node = None;
        }
    }

    fn render_create_join_guild_modal(&mut self, ctx: &Context) {
        if self.new_guild_name_input.is_empty() {
            if let Some(me) = &self.state.me {
                self.new_guild_name_input = trf("{name}'s server", &[("name", me.display_name())]);
            }
        }
        let (mut create, mut join) = (false, false);
        let (_, dim) = overlay(ctx, "add_server", 448.0, |ui| {
            modal_title(ui, tr("Add a server"));
            ui.label(RichText::new(tr("Create a server")).font(crate::theme::bold_font(16.0)).color(TEXT_HEADER()));
            ui.add_space(12.0);
            field_label(ui, tr("Server name"));
            text_input(ui, &mut self.new_guild_name_input, "");
            ui.add_space(12.0);
            if primary_btn(ui, tr("Create")).clicked() {
                create = true;
            }
            ui.add_space(16.0);
            let (r, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 1.0), egui::Sense::hover());
            ui.painter().hline(r.x_range(), r.center().y, Stroke::new(1.0_f32, BORDER()));
            ui.add_space(16.0);
            ui.label(RichText::new(tr("Join a server")).font(crate::theme::bold_font(16.0)).color(TEXT_HEADER()));
            ui.add_space(12.0);
            field_label(ui, tr("Invite link or code"));
            text_input(ui, &mut self.join_invite_code_input, "https://…/invite/hTKzmak");
            ui.add_space(12.0);
            if secondary_btn(ui, tr("Join server")).clicked() {
                join = true;
            }
        });
        if create && !self.new_guild_name_input.trim().is_empty() {
            self.create_guild();
            self.active_modal = None;
        }
        if join && !self.join_invite_code_input.trim().is_empty() {
            self.join_invite_code();
            self.active_modal = None;
        }
        if dim {
            self.active_modal = None;
        }
    }

    /// "Create a Poll" (polls/PollComposer.tsx): question, answers, duration, multiple answers.
    fn render_create_poll_modal(&mut self, ctx: &Context) {
        let mut close = false;
        let mut post = false;
        let (_, dim) = overlay(ctx, "create_poll", 448.0, |ui| {
            modal_title(ui, tr("Create a Poll"));
            field_label(ui, tr("Question"));
            text_input(ui, &mut self.poll_question_input, tr("What question do you want to ask?"));
            ui.add_space(20.0);
            field_label(ui, tr("Answers"));
            let mut remove = None;
            for (i, a) in self.poll_answers.iter_mut().enumerate() {
                ui.horizontal(|ui| {
                    ui.spacing_mut().item_spacing.x = 8.0;
                    let w = ui.available_width() - if i >= 2 { 40.0 } else { 0.0 };
                    ui.allocate_ui(Vec2::new(w, 40.0), |ui| text_input(ui, a, tr("Type your answer")));
                    if i >= 2 && crate::ui::chat::toolbar_btn(ui, crate::theme::IconKind::Trash, false, true).clicked() {
                        remove = Some(i);
                    }
                });
                ui.add_space(6.0);
            }
            if let Some(i) = remove {
                self.poll_answers.remove(i);
            }
            if self.poll_answers.len() < 10 && secondary_btn(ui, tr("+ Add another answer")).clicked() {
                self.poll_answers.push(String::new());
            }
            ui.add_space(20.0);
            field_label(ui, tr("Duration"));
            let durations: [(u32, &str); 7] = [
                (1, tr("1 hour")), (4, tr("4 hours")), (8, tr("8 hours")), (24, tr("24 hours")),
                (72, tr("3 days")), (168, tr("1 week")), (336, tr("2 weeks")),
            ];
            let current = durations.iter().find(|d| d.0 == self.poll_hours).map_or("", |d| d.1);
            select_box(ui, "poll_duration", current, |ui| {
                for (h, l) in durations {
                    ui.selectable_value(&mut self.poll_hours, h, l);
                }
            });
            ui.add_space(8.0);
            switch_row(ui, tr("Allow Multiple Answers"), None, &mut self.poll_multi);
            ui.add_space(18.0);
            let filled = self.poll_answers.iter().filter(|a| !a.trim().is_empty()).count();
            actions_row(ui, |ui| {
                let ok = !self.poll_question_input.trim().is_empty() && filled >= 1;
                if ui.add_enabled_ui(ok, |ui| primary_btn(ui, tr("Post"))).inner.clicked() {
                    post = true;
                }
                if secondary_btn(ui, tr("Cancel")).clicked() {
                    close = true;
                }
            });
        });
        if post {
            self.post_poll();
        }
        if close || post || dim {
            self.active_modal = None;
        }
    }

    /// "Send Later" (scheduling/Scheduling.tsx): where it goes, the text, the time.
    fn render_send_later_modal(&mut self, ctx: &Context) {
        let mut close = false;
        let mut send = false;
        let ch_name = self
            .selected_channel_id
            .as_ref()
            .and_then(|c| self.state.channels.get(c))
            .map(|c| c.display_name(self.state.me.as_ref().map(|u| u.id.as_str())))
            .unwrap_or_default();
        let when = chrono::NaiveDateTime::parse_from_str(self.schedule_time_input.trim(), "%Y-%m-%d %H:%M")
            .ok()
            .and_then(|t| t.and_local_timezone(chrono::Local).single());
        let future = when.is_some_and(|w| w > chrono::Local::now() + chrono::Duration::seconds(30));
        let (_, dim) = overlay(ctx, "send_later", 448.0, |ui| {
            modal_title(ui, tr("Send Later"));
            ui.label(RichText::new(trf("Sends to {where}", &[("where", &format!("#{ch_name}"))])).font(ui_font(14.0)).color(TEXT_MUTED()));
            ui.add_space(8.0);
            let r = Frame::new()
                .fill(BG_SIDEBAR())
                .corner_radius(CornerRadius::same(2))
                .inner_margin(Margin { left: 16, right: 12, top: 10, bottom: 10 })
                .show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    let quote: String = self.composer_text.chars().take(300).collect();
                    ui.label(RichText::new(quote).font(ui_font(15.0)).color(TEXT()));
                })
                .response
                .rect;
            ui.painter().rect_filled(egui::Rect::from_min_size(r.min, Vec2::new(4.0, r.height())), 0.0, ACCENT());
            ui.add_space(16.0);
            field_label(ui, tr("Date and time"));
            text_input(ui, &mut self.schedule_time_input, "YYYY-MM-DD HH:MM");
            if !future {
                ui.add_space(6.0);
                ui.label(RichText::new(tr("Pick a time in the future.")).font(ui_font(14.0)).color(DANGER()));
            }
            ui.add_space(18.0);
            actions_row(ui, |ui| {
                if ui.add_enabled_ui(future, |ui| primary_btn(ui, tr("Schedule Message"))).inner.clicked() {
                    send = true;
                }
                if secondary_btn(ui, tr("Cancel")).clicked() {
                    close = true;
                }
            });
        });
        if let (true, Some(w), Some(cid)) = (send, when, &self.selected_channel_id) {
            let body = json!({ "content": self.composer_text.trim(), "send_at": w.with_timezone(&chrono::Utc).to_rfc3339() });
            let path = format!("/channels/{cid}/scheduled-messages");
            self.api_bg(true, move |api| api.post(&path, body), |app, r| {
                if report(&mut app.status_banner, r).is_some() {
                    app.composer_text.clear();
                    app.active_modal = None;
                }
            });
        }
        if close || dim {
            self.active_modal = None;
        }
    }

    pub fn open_create_channel(&mut self, parent: Option<String>) {
        self.create_channel_parent = parent;
        self.create_channel_kind = 0;
        self.new_channel_name_input.clear();
        self.active_modal = Some(ModalKind::CreateChannel);
    }

    /// "Create channel" (GuildSidebar.tsx CreateChannelModal): channel type cards, name.
    /// Media and forum channels are left out: this app cannot open them yet.
    fn render_create_channel(&mut self, ctx: &Context) {
        use crate::theme::IconKind;
        let Some(gid) = self.selected_guild_id.clone() else {
            self.active_modal = None;
            return;
        };
        let types: [(u8, &str, Option<IconKind>, &str); 4] = [
            (0, tr("Text"), None, tr("Send messages, images, GIFs, emoji, opinions, and puns")),
            (2, tr("Voice"), Some(IconKind::Speaker), tr("Hang out together with voice, video, and screen share")),
            (5, tr("Announcement"), Some(IconKind::Announcement), tr("Important updates for people in and out of the server")),
            (13, tr("Stage"), Some(IconKind::Stage), tr("Host events with a moderated audience")),
        ];
        let mut close = false;
        let mut create = false;
        let (_, dim) = overlay(ctx, "create_channel", 448.0, |ui| {
            modal_title(ui, tr("Create channel"));
            field_label(ui, tr("Channel Type"));
            for (kind, label, icon, note) in types {
                let on = self.create_channel_kind == kind;
                let resp = Frame::new()
                    .fill(if on { BG_SELECTED() } else { BG_SIDEBAR() })
                    .stroke(Stroke::new(1.0_f32, if on { ACCENT() } else { BORDER() }))
                    .corner_radius(CornerRadius::same(2))
                    .inner_margin(Margin::symmetric(12, 10))
                    .show(ui, |ui| {
                        ui.set_width(ui.available_width());
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 8.0;
                            radio_dot(ui, on);
                            let (r, _) = ui.allocate_exact_size(Vec2::splat(18.0), egui::Sense::hover());
                            match icon {
                                Some(k) => crate::theme::draw_icon(ui.painter(), r, k, INTERACTIVE()),
                                None => {
                                    ui.painter().text(r.center(), egui::Align2::CENTER_CENTER, "#", ui_font(18.0), OFFLINE());
                                }
                            }
                            ui.vertical(|ui| {
                                ui.spacing_mut().item_spacing.y = 0.0;
                                ui.label(RichText::new(label).font(ui_font(15.0)).color(TEXT_HEADER()));
                                ui.label(RichText::new(note).font(ui_font(12.0)).color(TEXT()));
                            });
                        });
                    })
                    .response
                    .interact(egui::Sense::click());
                if resp.clicked() {
                    self.create_channel_kind = kind;
                }
                ui.add_space(8.0);
            }
            ui.add_space(12.0);
            field_label(ui, tr("Channel name"));
            let hint = if matches!(self.create_channel_kind, 2 | 13) { tr("General") } else { tr("new-channel") };
            let r = text_input(ui, &mut self.new_channel_name_input, hint);
            if r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) {
                create = true;
            }
            ui.add_space(18.0);
            actions_row(ui, |ui| {
                if primary_btn(ui, tr("Create Channel")).clicked() {
                    create = true;
                }
                if secondary_btn(ui, tr("Cancel")).clicked() {
                    close = true;
                }
            });
        });
        let name = self.new_channel_name_input.trim().to_string();
        if create && !name.is_empty() {
            let mut body = json!({ "name": name, "type": self.create_channel_kind });
            if let Some(p) = &self.create_channel_parent {
                body["parent_id"] = json!(p);
            }
            let path = format!("/guilds/{gid}/channels");
            self.api_bg(true, move |api| api.post(&path, body), |app, r| {
                if let Some(v) = report(&mut app.status_banner, r) {
                    if let Ok(ch) = serde_json::from_value::<Channel>(v) {
                        app.state.channels.insert(ch.id.clone(), ch);
                    }
                    app.active_modal = None;
                }
            });
        }
        if close || dim {
            self.active_modal = None;
        }
    }

    /// Edit Category: rename or delete a category.
    pub fn render_edit_channel(&mut self, ctx: &Context) {
        let Some((id, mut name)) = self.edit_channel.clone() else { return };
        let mut close = false;
        let mut save = false;
        let mut delete = false;
        let (_, dim) = overlay(ctx, "edit_channel", 448.0, |ui| {
            modal_title(ui, tr("Edit Category"));
            field_label(ui, tr("Category name"));
            text_input(ui, &mut name, tr("New Category"));
            ui.add_space(18.0);
            ui.horizontal(|ui| {
                if danger_btn(ui, tr("Delete Category")).clicked() {
                    delete = true;
                }
                actions_row(ui, |ui| {
                    if primary_btn(ui, tr("Save Changes")).clicked() {
                        save = true;
                    }
                    if secondary_btn(ui, tr("Cancel")).clicked() {
                        close = true;
                    }
                });
            });
        });
        if let Some(e) = self.edit_channel.as_mut() {
            e.1 = name.clone();
        }
        if self.api.is_some() {
            let path = format!("/channels/{id}");
            if save && !name.trim().is_empty() {
                let (path, id, name) = (path.clone(), id.clone(), name.trim().to_string());
                let body = json!({ "name": name });
                self.api_then(move |api| api.patch(&path, body), move |app| {
                    if let Some(c) = app.state.channels.get_mut(&id) {
                        c.name = Some(name);
                    }
                    app.edit_channel = None;
                });
            }
            if delete {
                self.api_then(move |api| api.delete(&path), move |app| {
                    app.state.channels.remove(&id);
                    app.edit_channel = None;
                });
            }
        }
        if close || dim {
            self.edit_channel = None;
        }
    }

    pub fn load_events(&mut self, gid: &str) {
        self.events.clear();
        self.api_get(format!("/guilds/{gid}/scheduled-events?with_user_count=true"), |app, r| {
            if let Some(v) = report(&mut app.status_banner, r) {
                app.events = v.as_array().cloned().unwrap_or_default();
            }
        });
    }

    /// Events list (events/Events.tsx, the list view).
    fn render_events(&mut self, ctx: &Context) {
        let (_, dim) = overlay(ctx, "events", 560.0, |ui| {
            modal_title(ui, tr("Events"));
            let n = self.events.len();
            let count = if n == 1 { tr("{n} Event") } else { tr("{n} Events") };
            ui.label(RichText::new(count.replace("{n}", &n.to_string())).font(ui_font(14.0)).color(TEXT_MUTED()));
            ui.add_space(12.0);
            if self.events.is_empty() {
                ui.add_space(24.0);
                ui.vertical_centered(|ui| {
                    ui.label(RichText::new(tr("There are no upcoming events.")).font(ui_font(14.0)).color(TEXT_MUTED()));
                });
                ui.add_space(24.0);
            }
            ScrollArea::vertical().max_height(520.0).show(ui, |ui| {
                for e in &self.events {
                    let get = |k: &str| e.get(k).and_then(|v| v.as_str()).unwrap_or("");
                    let live = e.get("status").and_then(|v| v.as_u64()) == Some(2);
                    Frame::new()
                        .fill(BG_SIDEBAR())
                        .stroke(if live { Stroke::new(1.0_f32, GREEN()) } else { Stroke::NONE })
                        .corner_radius(CornerRadius::same(3))
                        .inner_margin(Margin::same(16))
                        .show(ui, |ui| {
                            ui.set_width(ui.available_width());
                            let when = if live {
                                tr("Live Now").to_string()
                            } else {
                                crate::ui::chat::stamp(get("scheduled_start_time"))
                            };
                            ui.horizontal(|ui| {
                                let (r, _) = ui.allocate_exact_size(Vec2::splat(16.0), egui::Sense::hover());
                                crate::theme::draw_icon(ui.painter(), r, crate::theme::IconKind::Calendar, if live { GREEN() } else { TEXT_MUTED() });
                                ui.label(RichText::new(when).font(crate::theme::bold_font(13.0)).color(if live { GREEN() } else { TEXT_MUTED() }));
                            });
                            ui.label(RichText::new(get("name")).font(crate::theme::bold_font(18.0)).color(TEXT_HEADER()));
                            if !get("description").is_empty() {
                                ui.label(RichText::new(get("description")).font(ui_font(14.0)).color(TEXT()));
                            }
                            let users = e.get("user_count").and_then(|v| v.as_u64()).unwrap_or(0);
                            ui.label(RichText::new(format!("{users} interested")).font(ui_font(12.0)).color(TEXT_MUTED()));
                        });
                    ui.add_space(12.0);
                }
            });
        });
        if dim {
            self.active_modal = None;
        }
    }

    /// Quick switcher (Ctrl+K, keyboard/QuickSwitcher.tsx): servers, channels and DMs by name.
    fn render_quick_switcher_modal(&mut self, ctx: &Context) {
        let my_id = self.state.me.as_ref().map(|u| u.id.clone());
        let q = self.quick_switcher_query.trim().to_lowercase();
        let mut items: Vec<(String, String, Option<String>)> = Vec::new(); // label, channel id, guild id
        for ch in self.state.channels.values() {
            if matches!(ch.kind, 4 | 10 | 11 | 12) {
                continue;
            }
            let name = ch.display_name(my_id.as_deref());
            if q.is_empty() || name.to_lowercase().contains(&q) {
                let prefix = if matches!(ch.kind, 1 | 3) { "@" } else { "#" };
                items.push((format!("{prefix} {name}"), ch.id.clone(), ch.guild_id.clone()));
            }
        }
        items.sort();
        items.truncate(12);
        let mut go = None;
        let (_, dim) = overlay(ctx, "quick_switcher", 560.0, |ui| {
            let r = text_input(ui, &mut self.quick_switcher_query, tr("Where would you like to go?"));
            r.request_focus();
            ui.add_space(12.0);
            for (label, cid, gid) in &items {
                let (rect, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 34.0), egui::Sense::click());
                if resp.hovered() {
                    ui.painter().rect_filled(rect, CornerRadius::same(2), BG_HOVER());
                }
                ui.painter().text(rect.left_center() + Vec2::new(10.0, 0.0), egui::Align2::LEFT_CENTER, label, ui_font(15.0), if resp.hovered() { TEXT_HEADER() } else { TEXT() });
                if resp.clicked() {
                    go = Some((cid.clone(), gid.clone()));
                }
            }
            if items.is_empty() {
                ui.label(RichText::new(tr("No results")).font(ui_font(14.0)).color(TEXT_MUTED()));
            }
        });
        if let Some((cid, gid)) = go {
            self.selected_guild_id = gid;
            self.selected_channel_id = Some(cid.clone());
            self.load_channel_history(&cid);
            self.quick_switcher_query.clear();
            self.active_modal = None;
        }
        if dim {
            self.active_modal = None;
        }
    }

    pub fn render_drawer(&mut self, ui: &mut Ui, drawer: DrawerKind) {
        ui.horizontal(|ui| {
            let title = match drawer {
                DrawerKind::Threads => tr("Threads"),
                DrawerKind::Pins => tr("Pinned Messages"),
                DrawerKind::Saved => tr("Bookmarks"),
                DrawerKind::Search => tr("Search"),
                DrawerKind::Canvas => tr("Canvas"),
            };
            ui.label(
                RichText::new(title.to_uppercase())
                    .font(display_font(18.0))
                    .color(TEXT_HEADER()),
            );
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if crate::ui::chat::toolbar_btn(ui, crate::theme::IconKind::Close, false, false).on_hover_text(tr("Close")).clicked() {
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
                        ui.label(RichText::new(tr("No threads in this channel yet.")).color(TEXT_MUTED()));
                    }
                    for th in threads {
                        if ui
                            .button(th.name.as_deref().unwrap_or(tr("Thread")))
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
                        ui.label(RichText::new(tr("This channel doesn't have any pinned messages yet.")).color(TEXT_MUTED()));
                    }
                    for m in pinned {
                        Frame::new()
                            .fill(BG_SIDEBAR())
                            .inner_margin(Margin::same(8))
                            .show(ui, |ui| {
                                ui.label(RichText::new(&m.content).color(TEXT()));
                            });
                        ui.add_space(4.0);
                    }
                }
                DrawerKind::Saved => {
                    if self.state.saved_messages.is_empty() {
                        ui.label(RichText::new(tr("No bookmarks yet. Click the bookmark icon on any message to save it here.")).color(TEXT_MUTED()));
                    }
                    for sm in &self.state.saved_messages {
                        Frame::new()
                            .fill(BG_SIDEBAR())
                            .inner_margin(Margin::same(8))
                            .show(ui, |ui| {
                                if let Some(m) = &sm.message {
                                    ui.label(RichText::new(&m.content).color(TEXT()));
                                } else {
                                    ui.label(RichText::new(&sm.message_id).color(TEXT_MUTED()));
                                }
                            });
                        ui.add_space(4.0);
                    }
                }
                DrawerKind::Search => {
                    // the server's results; without a server (demo) the loaded messages of this channel
                    let (hits, total, loading) = match &self.search {
                        Some(sr) => (sr.hits.clone(), sr.total, sr.loading),
                        None => {
                            let q = self.search_query.to_lowercase();
                            let cid = self.selected_channel_id.clone().unwrap_or_default();
                            let local: Vec<Message> = self.state.messages.get(&cid).into_iter().flatten()
                                .filter(|m| m.content.to_lowercase().contains(&q))
                                .cloned()
                                .collect();
                            let n = local.len();
                            (local, n, false)
                        }
                    };
                    ui.label(
                        RichText::new(if total == 1 { tr("{n} Result") } else { tr("{n} Results") }.replace("{n}", &total.to_string()))
                            .size(11.5)
                            .color(TEXT_MUTED()),
                    );
                    for m in &hits {
                        Frame::new()
                            .fill(BG_SIDEBAR())
                            .inner_margin(Margin::same(8))
                            .show(ui, |ui| {
                                if let Some(a) = &m.author {
                                    ui.label(RichText::new(a.display_name()).font(crate::theme::bold_font(13.0)).color(TEXT_HEADER()));
                                }
                                ui.label(RichText::new(&m.content).color(TEXT()));
                            });
                        ui.add_space(4.0);
                    }
                    if loading {
                        ui.label(RichText::new(tr("Searching…")).color(TEXT_MUTED()));
                    } else if hits.len() < total && secondary_btn(ui, tr("Load more")).clicked() {
                        self.run_search(true);
                    }
                }
                DrawerKind::Canvas => {
                    ui.add_sized(
                        Vec2::new(ui.available_width(), 220.0),
                        TextEdit::multiline(&mut self.canvas_doc_input)
                            .hint_text(tr("Write shared notes, guidelines, or resources in Markdown…")),
                    );
                    ui.add_space(8.0);
                    if primary_btn(ui, tr("Save")).clicked() {
                        if let Some(cid) = &self.canvas_cid {
                            // the web's saveCanvas: PUT { content }
                            let (path, body) = (format!("/channels/{cid}/canvas"), json!({ "content": self.canvas_doc_input }));
                            self.api_bg(true, move |api| api.put(&path, Some(body)), |app, r| {
                                report(&mut app.status_banner, r);
                            });
                        }
                    }
                }
            });
    }

    pub fn create_guild(&mut self) {
        let name = self.new_guild_name_input.trim().to_string();
        if name.is_empty() {
            return;
        }
        // a failed request reports why and keeps the name for a retry
        if self.api_bg(true, move |api| api.post("/guilds", json!({ "name": name })), |app, r| {
            if let Some(val) = report(&mut app.status_banner, r) {
                app.new_guild_name_input.clear();
                report(&mut app.status_banner, app.state.apply("GUILD_CREATE", val));
            }
        }) {
            return;
        }
        let name = self.new_guild_name_input.trim().to_string();
        // demo mode (--demo, no server) only
        self.new_guild_name_input.clear();
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
            // like the web: the last path part of an invite link
            _ => raw.split('/').filter(|p| !p.is_empty()).next_back().unwrap_or_default().to_string(),
        };
        self.join_invite(code);
    }

    /// `POST /invites/<code>` (Add a server, deep links, invite cards in messages), then opens the server like
    /// the web's joinInvite. A failure shows on the code's invite card if there is one, else in the banner.
    pub fn join_invite(&mut self, code: String) {
        if let Some(c) = self.invite_cards.get_mut(&code) {
            c.joining = true;
            c.error = None;
        }
        let path = format!("/invites/{code}");
        self.api_bg(true, move |api| api.post(&path, json!({})), move |app, r| match r {
            Ok(v) => {
                app.invite_cards.remove(&code); // the member count changed: look it up again
                let gid = v.get("id").and_then(serde_json::Value::as_str).map(String::from);
                if report(&mut app.status_banner, app.state.apply("GUILD_CREATE", v)).is_some() {
                    if let Some(gid) = gid {
                        app.open_guild(&gid);
                    }
                }
            }
            Err(e) => match app.invite_cards.get_mut(&code) {
                Some(c) => (c.joining, c.error) = (false, Some(e.to_string())),
                None => drop(report(&mut app.status_banner, Err::<(), _>(e))),
            },
        });
    }

    fn post_poll(&mut self) {
        let Some(cid) = self.selected_channel_id.clone() else {
            return;
        };
        let answers: Vec<_> = self
            .poll_answers
            .iter()
            .filter(|a| !a.trim().is_empty())
            .map(|a| json!({ "poll_media": { "text": a.trim() } }))
            .collect();
        let poll = json!({
            "question": { "text": self.poll_question_input.trim() },
            "answers": answers,
            "duration": self.poll_hours,
            "allow_multiselect": self.poll_multi,
            "layout_type": 1,
        });
        let path = format!("/channels/{cid}/messages");
        self.api_bg(true, move |api| api.post(&path, json!({ "content": "", "poll": poll })), |app, r| {
            if let Some(v) = report(&mut app.status_banner, r) {
                if let Ok(msg) = crate::model::parse::<Message>(v) {
                    app.state.push_message(msg);
                }
            }
        });
    }
}

/// A dialog like the web's `.modal`: page dimmed (rgb 0 0 0 / .72), centred notched card with
/// the 4px accent top, `--chat` fill, 24px padding. Returns whether the dim area was clicked.
pub fn overlay<R>(ctx: &Context, id: &str, width: f32, add: impl FnOnce(&mut Ui) -> R) -> (R, bool) {
    overlay_in(ctx, id, width, egui::Order::Middle, add)
}

/// `overlay` above a full-screen settings page (both in the Foreground layer, moved on top every frame).
pub fn overlay_top<R>(ctx: &Context, id: &str, width: f32, add: impl FnOnce(&mut Ui) -> R) -> (R, bool) {
    let r = overlay_in(ctx, id, width, egui::Order::Foreground, add);
    ctx.move_to_top(egui::LayerId::new(egui::Order::Foreground, egui::Id::new((id, "dim"))));
    ctx.move_to_top(egui::LayerId::new(egui::Order::Foreground, egui::Id::new((id, "card"))));
    r
}

fn overlay_in<R>(ctx: &Context, id: &str, width: f32, dim_order: egui::Order, add: impl FnOnce(&mut Ui) -> R) -> (R, bool) {
    let screen = ctx.screen_rect();
    let dim = egui::Area::new(egui::Id::new((id, "dim")))
        .order(dim_order)
        .fixed_pos(screen.min)
        .show(ctx, |ui| {
            let (r, resp) = ui.allocate_exact_size(screen.size(), egui::Sense::click());
            ui.painter().rect_filled(r, 0.0, Color32::from_black_alpha(184));
            resp
        })
        .inner;
    let inner = egui::Area::new(egui::Id::new((id, "card")))
        .order(egui::Order::Foreground)
        .anchor(egui::Align2::CENTER_CENTER, Vec2::ZERO)
        .show(ctx, |ui| {
            crate::theme::show_notched_card(ui, BG_CHAT(), BORDER(), 12.0, Some(ACCENT()), None, Margin::same(24), |ui| {
                ui.set_width(width - 48.0);
                ui.set_max_height(screen.height() - 96.0);
                add(ui)
            })
            .inner
        })
        .inner;
    (inner, dim.clicked())
}

fn button(ui: &mut Ui, label: &str, fill: Color32, hover: Color32, fg: Color32, border: Option<Color32>) -> egui::Response {
    // `.primary:disabled`: secondary fill, muted text
    let (fill, hover, fg) = if ui.is_enabled() { (fill, hover, fg) } else { (BTN_SECONDARY(), BTN_SECONDARY(), TEXT_MUTED()) };
    let galley = ui.painter().layout_no_wrap(label.to_uppercase(), display_font(16.0), fg);
    let size = Vec2::new(galley.size().x + 32.0, 36.0);
    let (rect, resp) = ui.allocate_exact_size(size, egui::Sense::click());
    let rect = if resp.hovered() { rect.translate(Vec2::new(0.0, -1.0)) } else { rect };
    ui.painter().rect_filled(rect, CornerRadius::same(2), if resp.hovered() { hover } else { fill });
    if let Some(b) = border {
        ui.painter().rect_stroke(rect, CornerRadius::same(2), Stroke::new(1.0_f32, b), egui::StrokeKind::Inside);
    }
    ui.painter().galley(rect.center() - galley.size() / 2.0, galley, fg);
    resp
}

/// `.primary`
pub fn primary_btn(ui: &mut Ui, label: &str) -> egui::Response {
    button(ui, label, ACCENT(), ACCENT_HOVER(), ON_ACCENT(), None)
}

/// `.secondary`
pub fn secondary_btn(ui: &mut Ui, label: &str) -> egui::Response {
    button(ui, label, BTN_SECONDARY(), BTN_SECONDARY_HOVER(), Color32::WHITE, Some(BORDER()))
}

/// `.danger-btn`
pub fn danger_btn(ui: &mut Ui, label: &str) -> egui::Response {
    button(ui, label, DANGER_STRONG(), Color32::from_rgb(0xb5, 0x20, 0x2a), Color32::WHITE, None)
}

/// `.modal-actions`: buttons right-aligned in one 36px row (add them right to left).
pub fn actions_row(ui: &mut Ui, add: impl FnOnce(&mut Ui)) {
    let w = ui.available_width();
    ui.allocate_ui_with_layout(Vec2::new(w, 36.0), egui::Layout::right_to_left(egui::Align::Center), |ui| {
        ui.spacing_mut().item_spacing.x = 8.0;
        add(ui)
    });
}

/// `.modal-body > h2`: 28px condensed uppercase title.
pub fn modal_title(ui: &mut Ui, text: &str) {
    ui.label(RichText::new(text.to_uppercase()).font(display_font(28.0)).color(TEXT_HEADER()));
    ui.add_space(16.0);
}

/// `.field label`: 13px semibold, interactive colour.
pub fn field_label(ui: &mut Ui, text: &str) {
    ui.label(RichText::new(text).font(crate::theme::bold_font(13.0)).color(INTERACTIVE()));
    ui.add_space(6.0);
}

/// `.input`: 40px, rail fill, 1px border (focus colour when focused).
pub fn text_input(ui: &mut Ui, value: &mut String, hint: &str) -> egui::Response {
    let id = ui.next_auto_id();
    let focused = ui.memory(|m| m.has_focus(id));
    Frame::new()
        .fill(BG_RAIL())
        .stroke(Stroke::new(1.0_f32, if focused { FOCUS() } else { BORDER() }))
        .corner_radius(CornerRadius::same(2))
        .inner_margin(Margin::symmetric(12, 10))
        .show(ui, |ui| {
            ui.add(
                TextEdit::singleline(value)
                    .id(id)
                    .font(crate::theme::ui_font(15.0))
                    .text_color(TEXT())
                    .hint_text(RichText::new(hint).color(TEXT_MUTED()))
                    .desired_width(f32::INFINITY)
                    .frame(false)
                    .margin(Margin::ZERO),
            )
        })
        .inner
}

/// `.switch-row`: label (and note) left, 42x24 switch right, line below.
pub fn switch_row(ui: &mut Ui, label: &str, note: Option<&str>, on: &mut bool) -> bool {
    let mut changed = false;
    ui.add_space(14.0);
    ui.horizontal_top(|ui| {
        let w = ui.available_width() - 58.0;
        ui.allocate_ui(Vec2::new(w, 24.0), |ui| {
            ui.vertical(|ui| {
                ui.spacing_mut().item_spacing.y = 2.0;
                ui.label(RichText::new(label).font(crate::theme::ui_font(15.0)).color(TEXT_HEADER()));
                if let Some(n) = note {
                    ui.label(RichText::new(n).font(crate::theme::ui_font(12.0)).color(TEXT_MUTED()));
                }
            });
        });
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Min), |ui| {
            let (r, resp) = ui.allocate_exact_size(Vec2::new(42.0, 24.0), egui::Sense::click());
            ui.painter().rect_filled(r, CornerRadius::same(2), if *on { GREEN() } else { OFFLINE() });
            let knob_x = if *on { r.max.x - 21.0 } else { r.min.x + 3.0 };
            ui.painter().rect_filled(egui::Rect::from_min_size(egui::pos2(knob_x, r.min.y + 3.0), Vec2::splat(18.0)), CornerRadius::same(2), Color32::WHITE);
            if resp.clicked() {
                *on = !*on;
                changed = true;
            }
        });
    });
    ui.add_space(14.0);
    let (r, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 1.0), egui::Sense::hover());
    ui.painter().hline(r.x_range(), r.center().y, Stroke::new(1.0_f32, BORDER()));
    changed
}

/// `select.input`: a 40px field like `.input` that opens a list.
pub fn select_box(ui: &mut Ui, id: &str, current: &str, add: impl FnOnce(&mut Ui)) {
    ui.scope(|ui| {
        let v = ui.visuals_mut();
        for w in [&mut v.widgets.inactive, &mut v.widgets.hovered, &mut v.widgets.active, &mut v.widgets.open] {
            w.weak_bg_fill = BG_RAIL();
            w.bg_fill = BG_RAIL();
            w.corner_radius = CornerRadius::same(2);
            w.fg_stroke.color = TEXT();
        }
        v.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, BORDER());
        v.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, BTN_SECONDARY_HOVER());
        v.widgets.open.bg_stroke = Stroke::new(1.0_f32, FOCUS());
        ui.spacing_mut().interact_size.y = 40.0;
        ui.spacing_mut().button_padding = Vec2::new(12.0, 10.0);
        egui::ComboBox::from_id_salt(id)
            .selected_text(RichText::new(current).font(crate::theme::ui_font(15.0)).color(TEXT()))
            .width(ui.available_width())
            .height(320.0)
            .show_ui(ui, add);
    });
}

/// A radio circle like the browser's (accent fill when picked).
pub fn radio_dot(ui: &mut Ui, on: bool) {
    let (r, _) = ui.allocate_exact_size(Vec2::splat(16.0), egui::Sense::hover());
    let c = r.center();
    if on {
        ui.painter().circle_filled(c, 7.0, FOCUS());
        ui.painter().circle_filled(c, 3.0, BG_RAIL());
    } else {
        ui.painter().circle(c, 6.5, BG_RAIL(), Stroke::new(1.0_f32, INTERACTIVE()));
    }
}
