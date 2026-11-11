//! Friends home like the web's friends/Friends.tsx and friends/ActiveNow.tsx: header with the
//! tabs, the friend cards with round buttons, Add Friend, and the Active Now shelf.

use super::report;
use crate::i18n::{tr, trf};
use crate::model::{Channel, Relationship, User};
use crate::theme::{bold_font, display_font, draw_avatar, draw_icon, draw_list_heading, palette::*, ui_font, IconKind};
use crate::ui::{CillhubApp, FriendsTab};
use egui::{Align, Align2, Color32, CornerRadius, Frame, Layout, Margin, Pos2, Rect, RichText, ScrollArea, Sense, Stroke, Ui, Vec2};
use serde_json::json;

/// `.round-btn`: 40px square, sidebar fill, border; hover: selected fill (green / red for ok / danger).
fn round_btn(ui: &mut Ui, icon: IconKind, tip: &str, ok: bool, danger: bool) -> egui::Response {
    let (r, resp) = ui.allocate_exact_size(Vec2::splat(40.0), Sense::click());
    let hov = resp.hovered();
    let (border, fg) = match (hov, ok, danger) {
        (true, true, _) => (GREEN(), GREEN()),
        (true, _, true) => (DANGER(), DANGER()),
        (true, _, _) => (BORDER(), TEXT_HEADER()),
        _ => (BORDER(), INTERACTIVE()),
    };
    let r2 = if hov { r.expand(1.0) } else { r };
    ui.painter().rect(r2, CornerRadius::same(3), if hov { BG_SELECTED() } else { BG_SIDEBAR() }, Stroke::new(1.0_f32, border), egui::StrokeKind::Inside);
    draw_icon(ui.painter(), Rect::from_center_size(r.center(), Vec2::splat(20.0)), icon, fg);
    resp.on_hover_text(tip)
}

impl CillhubApp {
    pub fn render_friends_view(&mut self, ui: &mut Ui) {
        // `.chat-header` of the friends page: icon, FRIENDS, rule, tabs
        let (hdr, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 44.0), Sense::hover());
        ui.painter().rect_filled(hdr, 0.0, BG_CHAT().lerp_to_gamma(BG_SIDEBAR(), 0.06));
        ui.painter().hline(hdr.x_range(), hdr.max.y - 0.5, Stroke::new(1.0_f32, BORDER()));
        let incoming = self.state.relationships.values().filter(|r| r.kind == 3).count();
        let mut hui = ui.new_child(egui::UiBuilder::new().max_rect(hdr.shrink2(Vec2::new(14.0, 0.0))).layout(Layout::left_to_right(Align::Center)));
        hui.spacing_mut().item_spacing.x = 12.0;
        let (ir, _) = hui.allocate_exact_size(Vec2::splat(22.0), Sense::hover());
        draw_icon(hui.painter(), ir, IconKind::People, TEXT_MUTED());
        hui.label(RichText::new(tr("Friends").to_uppercase()).font(display_font(20.0)).color(TEXT_HEADER()));
        let (sep, _) = hui.allocate_exact_size(Vec2::new(1.0, 24.0), Sense::hover());
        hui.painter().vline(sep.center().x, sep.y_range(), Stroke::new(1.0_f32, BORDER()));
        hui.spacing_mut().item_spacing.x = 8.0;
        for (tab, label) in [
            (FriendsTab::Online, tr("Online")),
            (FriendsTab::All, tr("All")),
            (FriendsTab::Pending, tr("Pending")),
            (FriendsTab::Blocked, tr("Blocked")),
            (FriendsTab::Add, tr("Add Friend")),
        ] {
            let badge = (tab == FriendsTab::Pending && incoming > 0).then_some(incoming);
            if self.friends_tab_pill(&mut hui, tab, label, badge).clicked() {
                self.friends_tab = tab;
            }
        }

        // `.active-now-shelf`: 320px, sidebar fill, left border
        let body = ui.available_rect_before_wrap();
        let shelf = Rect::from_min_max(Pos2::new(body.max.x - 320.0, body.min.y), body.max);
        ui.painter().rect_filled(shelf, 0.0, BG_SIDEBAR());
        ui.painter().vline(shelf.min.x + 0.5, shelf.y_range(), Stroke::new(1.0_f32, BORDER()));
        let mut sui = ui.new_child(egui::UiBuilder::new().max_rect(shelf.shrink(16.0)).layout(Layout::top_down(Align::Min)));
        self.active_now(&mut sui);

        // `.friends-body`: padding 16px 24px 20px 30px
        let main = Rect::from_min_max(body.min + Vec2::new(30.0, 16.0), Pos2::new(shelf.min.x - 24.0, body.max.y - 20.0));
        let mut mui = ui.new_child(egui::UiBuilder::new().max_rect(main).layout(Layout::top_down(Align::Min)));
        ScrollArea::vertical().id_salt("friends_body").show(&mut mui, |ui| {
            ui.set_width(main.width());
            if self.friends_tab == FriendsTab::Add {
                self.add_friend_panel(ui);
            } else {
                self.friend_list(ui);
            }
        });
    }

    /// `.tab`: 4px 10px, interactive; selected: selected fill, strong, accent underline; `.tab.add`: accent.
    fn friends_tab_pill(&self, ui: &mut Ui, tab: FriendsTab, label: &str, badge: Option<usize>) -> egui::Response {
        let on = self.friends_tab == tab;
        let add = tab == FriendsTab::Add;
        let font = if on || add { bold_font(14.0) } else { ui_font(14.0) };
        let g = ui.painter().layout_no_wrap(label.to_string(), font, Color32::WHITE);
        let extra = if badge.is_some() { 24.0 } else { 0.0 };
        let (r, resp) = ui.allocate_exact_size(Vec2::new(g.size().x + 20.0 + extra, 28.0), Sense::click());
        let hov = resp.hovered();
        let (fill, fg) = match (add, on) {
            (true, false) => (ACCENT(), ON_ACCENT()),
            (true, true) => (ACCENT().gamma_multiply(0.14), ACCENT()),
            (false, true) => (BG_SELECTED(), TEXT_HEADER()),
            (false, false) if hov => (BG_HOVER(), TEXT_HEADER()),
            _ => (Color32::TRANSPARENT, INTERACTIVE()),
        };
        let p = ui.painter();
        p.rect_filled(r, CornerRadius::same(2), fill);
        if on {
            let h = if add { 2.0 } else { 3.0 };
            p.rect_filled(Rect::from_min_max(Pos2::new(r.min.x, r.max.y - h), r.max), 0.0, ACCENT());
        }
        p.galley_with_override_text_color(Pos2::new(r.min.x + 10.0, r.center().y - g.size().y / 2.0), g, fg);
        if let Some(n) = badge {
            let b = Rect::from_center_size(Pos2::new(r.max.x - 18.0, r.center().y), Vec2::new(18.0, 16.0));
            p.rect_filled(b, CornerRadius::same(2), SIGNAL_STRONG());
            p.text(b.center(), Align2::CENTER_CENTER, n.to_string(), bold_font(11.0), Color32::WHITE);
        }
        resp
    }

    fn friend_list(&mut self, ui: &mut Ui) {
        let mut list: Vec<Relationship> = self
            .state
            .relationships
            .values()
            .filter(|r| match self.friends_tab {
                FriendsTab::Online => r.kind == 1 && !matches!(self.state.user_status(&r.id), "offline" | "invisible"),
                FriendsTab::All => r.kind == 1,
                FriendsTab::Pending => matches!(r.kind, 3 | 4),
                FriendsTab::Blocked => r.kind == 2,
                FriendsTab::Add => false,
            })
            .cloned()
            .collect();
        let name_of = |r: &Relationship| {
            self.state.users.get(&r.id).or(r.user.as_ref()).map(|u| u.display_name().to_lowercase()).unwrap_or_default()
        };
        list.sort_by_key(name_of);
        let heading = match self.friends_tab {
            FriendsTab::Online => tr("Online"),
            FriendsTab::All => tr("All Friends"),
            FriendsTab::Pending => tr("Pending"),
            _ => tr("Blocked"),
        };
        ui.add_space(8.0);
        draw_list_heading(ui, &format!("{} — {}", heading.to_uppercase(), list.len()));
        ui.add_space(16.0);
        if list.is_empty() {
            let text = match self.friends_tab {
                FriendsTab::Pending => tr("There are no pending friend requests."),
                FriendsTab::Blocked => tr("You have not blocked anyone."),
                FriendsTab::Online => tr("No one's around to play with."),
                _ => tr("You have no friends yet. Add some with their username!"),
            };
            // `.empty-state`: dashed box, centred hint
            ui.add_space(32.0);
            ui.vertical_centered(|ui| {
                let r = Frame::new()
                    .fill(BG_SIDEBAR().gamma_multiply(0.45))
                    .corner_radius(CornerRadius::same(4))
                    .inner_margin(Margin::symmetric(24, 32))
                    .show(ui, |ui| {
                        ui.set_width(372.0);
                        ui.label(RichText::new(text).font(ui_font(14.0)).color(TEXT_MUTED()));
                    })
                    .response
                    .rect;
                let q = r.shrink(0.5);
                let pts = [q.left_top(), q.right_top(), q.right_bottom(), q.left_bottom(), q.left_top()];
                ui.painter().extend(egui::Shape::dashed_line(&pts, Stroke::new(1.0_f32, BORDER()), 4.0, 3.0));
            });
            return;
        }
        for r in list {
            let user = self.state.users.get(&r.id).cloned().or(r.user.clone()).unwrap_or(User { id: r.id.clone(), username: r.id.clone(), ..Default::default() });
            let status = self.state.user_status(&r.id).to_string();
            let sub = match r.kind {
                2 => tr("Blocked").to_string(),
                3 => tr("Incoming Friend Request").to_string(),
                4 => tr("Outgoing Friend Request").to_string(),
                _ => match self.state.user_game(&r.id) {
                    Some(g) => trf("Playing {name}", &[("name", &g.name)]),
                    None => tr(match status.as_str() {
                        "online" => "Online",
                        "idle" => "Idle",
                        "dnd" => "Do Not Disturb",
                        _ => "Offline",
                    })
                    .to_string(),
                },
            };
            // `.friend`: card, 76px, padding 14px 22px, avatar 48, gap 20
            Frame::new()
                .fill(BG_CARD())
                .stroke(Stroke::new(1.0_f32, BORDER()))
                .corner_radius(CornerRadius::same(3))
                .inner_margin(Margin::symmetric(22, 14))
                .show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        ui.spacing_mut().item_spacing.x = 20.0;
                        draw_avatar(ui, 48.0, &user.id, user.display_name(), (r.kind == 1).then_some(status.as_str()), BG_CARD());
                        ui.vertical(|ui| {
                            ui.spacing_mut().item_spacing.y = 2.0;
                            ui.add_space(4.0);
                            ui.horizontal(|ui| {
                                ui.spacing_mut().item_spacing.x = 8.0;
                                ui.label(RichText::new(user.display_name()).font(bold_font(15.0)).color(TEXT_HEADER()));
                                ui.label(RichText::new(&user.username).font(ui_font(14.0)).color(TEXT_MUTED()));
                            });
                            ui.label(RichText::new(sub).font(ui_font(14.0)).color(TEXT_MUTED()));
                        });
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            ui.spacing_mut().item_spacing.x = 12.0;
                            match r.kind {
                                1 => {
                                    if round_btn(ui, IconKind::Close, tr("Remove Friend"), false, true).clicked() {
                                        self.remove_relationship(&r.id);
                                    }
                                    if round_btn(ui, IconKind::ChatBubble, tr("Message"), false, false).clicked() {
                                        self.open_or_create_dm(&user);
                                    }
                                }
                                3 => {
                                    if round_btn(ui, IconKind::Close, tr("Ignore"), false, true).clicked() {
                                        self.remove_relationship(&r.id);
                                    }
                                    if round_btn(ui, IconKind::Check, tr("Accept"), true, false).clicked() {
                                        self.accept_friend(&r.id);
                                    }
                                }
                                2 => {
                                    if round_btn(ui, IconKind::Block, tr("Unblock"), false, false).clicked() {
                                        self.remove_relationship(&r.id);
                                    }
                                }
                                _ => {
                                    if round_btn(ui, IconKind::Close, tr("Cancel"), false, true).clicked() {
                                        self.remove_relationship(&r.id);
                                    }
                                }
                            }
                        });
                    });
                });
            ui.add_space(14.0);
        }
    }

    /// `.add-friend`: title, hint, the input box with Send Friend Request inside.
    fn add_friend_panel(&mut self, ui: &mut Ui) {
        ui.add_space(8.0);
        ui.label(RichText::new(tr("Add Friend").to_uppercase()).font(display_font(26.0)).color(TEXT_HEADER()));
        ui.add_space(8.0);
        ui.label(RichText::new(tr("You can add friends with their username.")).font(ui_font(14.0)).color(TEXT_MUTED()));
        ui.add_space(16.0);
        let id = ui.make_persistent_id("add_friend_input");
        let focused = ui.memory(|m| m.has_focus(id));
        let ok = self.add_friend_result.as_ref().map(|r| r.0);
        let border = match ok {
            Some(true) => GREEN(),
            Some(false) => DANGER(),
            None if focused => FOCUS(),
            None => BORDER(),
        };
        let mut send = false;
        Frame::new()
            .fill(BG_RAIL())
            .stroke(Stroke::new(1.0_f32, border))
            .corner_radius(CornerRadius::same(3))
            .inner_margin(Margin { left: 16, right: 12, top: 7, bottom: 7 })
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    let w = ui.available_width() - 220.0;
                    let r = ui.add_sized(
                        Vec2::new(w, 36.0),
                        egui::TextEdit::singleline(&mut self.add_friend_input)
                            .id(id)
                            .font(ui_font(15.0))
                            .text_color(TEXT())
                            .hint_text(RichText::new(tr("You can add friends with their username.")).color(TEXT_MUTED()))
                            .frame(false)
                            .vertical_align(Align::Center),
                    );
                    if r.changed() {
                        self.add_friend_result = None;
                    }
                    if r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter)) {
                        send = true;
                    }
                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                        let enabled = !self.add_friend_input.trim().is_empty();
                        if ui.add_enabled_ui(enabled, |ui| super::modals::primary_btn(ui, tr("Send Friend Request"))).inner.clicked() {
                            send = true;
                        }
                    });
                });
            });
        if let Some((good, text)) = &self.add_friend_result {
            ui.add_space(8.0);
            ui.label(RichText::new(text).font(ui_font(14.0)).color(if *good { GREEN() } else { DANGER() }));
        }
        if send {
            self.send_friend_request();
        }
    }

    /// Active Now: friends who are online with a game, or the web's quiet text.
    fn active_now(&mut self, ui: &mut Ui) {
        ui.label(RichText::new(tr("Active Now").to_uppercase()).font(display_font(22.0)).color(TEXT_HEADER()));
        ui.add_space(14.0);
        let mut active: Vec<(User, String)> = self
            .state
            .relationships
            .values()
            .filter(|r| r.kind == 1 && !matches!(self.state.user_status(&r.id), "offline" | "invisible"))
            .filter_map(|r| {
                let game = self.state.user_game(&r.id)?.name.clone();
                let user = self.state.users.get(&r.id).cloned().or(r.user.clone())?;
                Some((user, game))
            })
            .collect();
        active.sort_by(|a, b| a.0.display_name().cmp(b.0.display_name()));
        if active.is_empty() {
            ui.add_space(24.0);
            ui.vertical_centered(|ui| {
                ui.label(RichText::new(tr("It's quiet for now…")).font(ui_font(15.0)).color(TEXT_MUTED()));
                ui.label(RichText::new(tr("When friends are playing games or streaming, you'll see them here!")).font(ui_font(12.0)).color(TEXT_MUTED()));
            });
            return;
        }
        for (user, game) in active {
            Frame::new()
                .fill(BG_CARD())
                .stroke(Stroke::new(1.0_f32, BORDER()))
                .corner_radius(CornerRadius::same(3))
                .inner_margin(Margin::same(12))
                .show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        let st = self.state.user_status(&user.id).to_string();
                        draw_avatar(ui, 36.0, &user.id, user.display_name(), Some(&st), BG_CARD());
                        ui.vertical(|ui| {
                            ui.label(RichText::new(user.display_name()).font(bold_font(14.0)).color(TEXT_HEADER()));
                            ui.label(RichText::new(&game).font(ui_font(12.0)).color(TEXT_MUTED()));
                        });
                    });
                    ui.add_space(8.0);
                    if super::modals::secondary_btn(ui, tr("Message")).clicked() {
                        self.open_or_create_dm(&user);
                    }
                });
            ui.add_space(10.0);
        }
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
        if self.api.is_some() {
            let body = json!({ "recipient_id": target.id });
            self.api_bg(true, move |api| api.post("/users/@me/channels", body), |app, r| {
                let ch = report(&mut app.status_banner, r).map(serde_json::from_value::<Channel>);
                if let Some(ch) = ch.and_then(|c| report(&mut app.status_banner, c)) {
                    let cid = ch.id.clone();
                    app.state.channels.insert(cid.clone(), ch);
                    app.selected_guild_id = None;
                    app.selected_channel_id = Some(cid.clone());
                    app.load_channel_history(&cid);
                }
            });
            return;
        }
        // demo mode (--demo, no server) only
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
        if self.api.is_some() {
            let body = json!({ "username": username });
            self.api_bg(true, move |api| api.post("/users/@me/relationships", body), move |app, r| match r {
                Ok(_) => {
                    app.add_friend_result = Some((true, trf("Success! Your friend request to {name} was sent.", &[("name", &username)])));
                    app.add_friend_input.clear();
                }
                Err(e) => app.add_friend_result = Some((false, e.to_string())),
            });
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
        }
    }

    pub fn accept_friend(&mut self, user_id: &str) {
        let (path, uid) = (format!("/users/@me/relationships/{user_id}"), user_id.to_string());
        self.api_then(move |api| api.put(&path, Some(json!({ "type": 1 }))), move |app| {
            if let Some(rel) = app.state.relationships.get_mut(&uid) {
                rel.kind = 1;
            }
        });
    }

    pub fn remove_relationship(&mut self, user_id: &str) {
        let (path, uid) = (format!("/users/@me/relationships/{user_id}"), user_id.to_string());
        self.api_then(move |api| api.delete(&path), move |app| {
            app.state.relationships.remove(&uid);
        });
    }
}
