//! Full-screen User Settings and Server Settings like the web's SettingsLayout
//! (settings/Layout.tsx + `.settings*` in index.css): sidebar nav on the left (224px column,
//! right-aligned), content up to 740px, the round close button with "ESC". Only tabs whose
//! function this app has are listed.

use super::modals::{
    actions_row, danger_btn, field_label, primary_btn, secondary_btn, switch_row, text_input,
};
use super::{report, CillhubApp};
use crate::i18n::{tr, trf};
use crate::model::Role;
use crate::settings::CustomGame;
use crate::theme::{bold_font, display_font, draw_avatar, draw_icon, palette, palette::*, space, spaced_text, ui_font, IconKind};
use egui::{Align, Color32, Context, CornerRadius, Frame, Layout, Margin, Pos2, Rect, RichText, ScrollArea, Sense, Stroke, Ui, Vec2};
use serde_json::json;

/// User Settings tabs, in the web's order (only the ones this app has), then this app's own.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettingsTab {
    Account,
    Appearance,
    Language,
    Nodes,
    Games,
    Desktop,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerTab {
    Overview,
    Roles,
}

/// The web's role colour swatches (Roles.tsx SWATCHES).
const SWATCHES: [u32; 10] = [0x1abc9c, 0x2ecc71, 0x3498db, 0x9b59b6, 0xe91e63, 0xf1c40f, 0xe67e22, 0xe74c3c, 0x95a5a6, 0x607d8b];

#[derive(serde::Deserialize)]
struct PermInfo {
    bit: u32,
    label: String,
    note: String,
}

#[derive(serde::Deserialize)]
struct PermGroup {
    title: String,
    perms: Vec<PermInfo>,
}

/// The web's permission groups with labels and notes (assets/perm-groups.json from permInfo.ts).
fn perm_groups() -> &'static [PermGroup] {
    static G: std::sync::OnceLock<Vec<PermGroup>> = std::sync::OnceLock::new();
    G.get_or_init(|| serde_json::from_str(include_str!("../../assets/perm-groups.json")).expect("perm-groups.json"))
}

/// Web strings are keys; the JSON ones are looked up the same way (leaked once, they never change).
fn tr_owned(s: &str) -> &'static str {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, &'static str>>> = std::sync::OnceLock::new();
    let mut m = CACHE.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
    let key: &'static str = m.entry(s.to_string()).or_insert_with(|| Box::leak(s.to_string().into_boxed_str()));
    tr(key)
}

/// What the page frame reports back.
enum Nav {
    Tab(usize),
    Footer,
    Close,
}

/// Draws the settings page frame: nav (sections of tabs), close button; `content` fills the right side.
fn settings_page(
    ctx: &Context,
    id: &str,
    sections: &[(String, Vec<&str>)],
    current: usize,
    footer: Option<&str>,
    content: impl FnOnce(&mut Ui),
) -> Option<Nav> {
    let screen = ctx.screen_rect();
    let mut out = None;
    egui::Area::new(egui::Id::new(id))
        .order(egui::Order::Foreground)
        .fixed_pos(screen.min)
        .show(ctx, |ui| {
            let (rect, _) = ui.allocate_exact_size(screen.size(), Sense::click());
            let p = ui.painter();
            p.rect_filled(rect, 0.0, BG_CHAT());
            // `.settings-nav { flex: 1 0 224px }` beside `.settings-content { max-width: 740px }`
            let nav_w = ((rect.width() - 740.0 - 56.0) * 0.67).max(224.0);
            let nav = Rect::from_min_size(rect.min, Vec2::new(nav_w, rect.height()));
            p.rect_filled(nav, 0.0, BG_SIDEBAR());
            p.vline(nav.max.x - 0.5, nav.y_range(), Stroke::new(1.0_f32, BORDER()));

            let inner = Rect::from_min_max(Pos2::new(nav.max.x - 224.0 + 20.0, nav.min.y), Pos2::new(nav.max.x - 10.0, nav.max.y));
            let mut nui = ui.new_child(egui::UiBuilder::new().max_rect(inner).layout(Layout::top_down(Align::Min)));
            ScrollArea::vertical().id_salt((id, "nav")).show(&mut nui, |ui| {
                ui.add_space(60.0);
                ui.spacing_mut().item_spacing.y = 2.0;
                let mut i = 0;
                for (heading, tabs) in sections {
                    // `.settings-nav .list-heading { padding: 6px 10px }`
                    ui.add_space(6.0);
                    let g = spaced_text(ui, &heading.to_uppercase(), 12.0, TEXT_MUTED());
                    let (r, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 16.0), Sense::hover());
                    let w = g.size().x;
                    ui.painter().galley(Pos2::new(r.min.x + 10.0, r.center().y - g.size().y / 2.0), g, TEXT_MUTED());
                    if r.min.x + 18.0 + w < r.max.x {
                        ui.painter().hline((r.min.x + 18.0 + w)..=r.max.x, r.center().y, Stroke::new(1.0_f32, BORDER().gamma_multiply(0.75)));
                    }
                    ui.add_space(6.0);
                    for label in tabs {
                        if settings_tab(ui, label, i == current, false).clicked() {
                            out = Some(Nav::Tab(i));
                        }
                        i += 1;
                    }
                }
                if let Some(f) = footer {
                    ui.add_space(8.0);
                    let (r, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 1.0), Sense::hover());
                    ui.painter().hline(r.x_range(), r.center().y, Stroke::new(1.0_f32, BORDER()));
                    ui.add_space(8.0);
                    if settings_tab(ui, f, false, true).clicked() {
                        out = Some(Nav::Footer);
                    }
                }
                ui.add_space(60.0);
            });

            // `.settings-content`: padding 60px 40px 80px
            let content_rect = Rect::from_min_max(Pos2::new(nav.max.x + 40.0, rect.min.y), Pos2::new(nav.max.x + 700.0, rect.max.y));
            let mut cui = ui.new_child(egui::UiBuilder::new().max_rect(content_rect).layout(Layout::top_down(Align::Min)));
            ScrollArea::vertical().id_salt((id, "content")).show(&mut cui, |ui| {
                ui.set_width(content_rect.width());
                ui.add_space(60.0);
                content(ui);
                ui.add_space(80.0);
            });

            // `.settings-close`: 36px round-cornered X with "ESC" under it
            let x = Rect::from_min_size(Pos2::new(nav.max.x + 740.0, rect.min.y + 60.0), Vec2::splat(36.0));
            let resp = ui.interact(x, egui::Id::new((id, "close")), Sense::click());
            let hov = resp.hovered();
            let p = ui.painter();
            if hov {
                p.rect_filled(x, CornerRadius::same(3), BG_HOVER());
            }
            p.rect_stroke(x, CornerRadius::same(3), Stroke::new(2.0_f32, if hov { INTERACTIVE() } else { BORDER() }), egui::StrokeKind::Inside);
            draw_icon(p, Rect::from_center_size(x.center(), Vec2::splat(18.0)), IconKind::Close, if hov { TEXT_HEADER() } else { INTERACTIVE() });
            p.text(Pos2::new(x.center().x, x.max.y + 12.0), egui::Align2::CENTER_CENTER, "ESC", bold_font(12.0), TEXT_MUTED());
            if resp.clicked() {
                out = Some(Nav::Close);
            }
        });
    out
}

/// `.settings-tab`: 7px 12px padding, 14.5px; active: selected fill, accent bar, 600.
fn settings_tab(ui: &mut Ui, label: &str, active: bool, danger: bool) -> egui::Response {
    let (r, resp) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 34.0), Sense::click());
    let hov = resp.hovered();
    let p = ui.painter();
    if active || hov {
        p.rect_filled(r, CornerRadius::same(2), if active { BG_SELECTED() } else { BG_HOVER() });
    }
    if active {
        p.rect_filled(Rect::from_min_size(r.min, Vec2::new(3.0, r.height())), 0.0, ACCENT());
    }
    let color = if danger {
        DANGER()
    } else if active {
        TEXT_HEADER()
    } else if hov {
        TEXT_HEADER()
    } else {
        INTERACTIVE()
    };
    let font = if active { bold_font(14.5) } else { ui_font(14.5) };
    p.text(Pos2::new(r.min.x + 12.0, r.center().y), egui::Align2::LEFT_CENTER, label, font, color);
    resp
}

/// `.settings-content h1`: 34px condensed uppercase.
fn page_title(ui: &mut Ui, text: &str) {
    ui.label(RichText::new(text.to_uppercase()).font(display_font(34.0)).color(TEXT_HEADER()));
    ui.add_space(20.0);
}

/// `fieldset.choice` card: sidebar fill, border; `on`: selected fill, accent border.
fn choice_card<R>(ui: &mut Ui, on: bool, add: impl FnOnce(&mut Ui) -> R) -> egui::Response {
    let resp = Frame::new()
        .fill(if on { BG_SELECTED() } else { BG_SIDEBAR() })
        .stroke(Stroke::new(1.0_f32, if on { ACCENT() } else { BORDER() }))
        .corner_radius(CornerRadius::same(2))
        .inner_margin(Margin::symmetric(12, 10))
        .show(ui, |ui| {
            ui.set_width(ui.available_width());
            add(ui)
        })
        .response;
    let resp = resp.interact(Sense::click());
    if resp.hovered() {
        ui.ctx().set_cursor_icon(egui::CursorIcon::PointingHand);
    }
    resp
}

fn role_color(c: u32) -> Color32 {
    Color32::from_rgb((c >> 16) as u8, (c >> 8) as u8, c as u8)
}

impl CillhubApp {
    pub fn render_user_settings(&mut self, ctx: &Context) {
        self.keep_view_consistent(); // account data is the hub's: never drawn (or drafted) from a node's
        let tabs = [SettingsTab::Account, SettingsTab::Appearance, SettingsTab::Language, SettingsTab::Nodes, SettingsTab::Games, SettingsTab::Desktop];
        let sections = vec![
            (tr("User Settings").to_string(), vec![tr("My Account")]),
            (tr("App Settings").to_string(), vec![tr("Appearance"), tr("Language"), tr("Private Nodes"), tr("Game Activity"), tr("Desktop")]),
        ];
        let current = tabs.iter().position(|t| *t == self.settings_tab).unwrap_or(0);
        let nav = settings_page(ctx, "user_settings", &sections, current, Some(tr("Log Out")), |ui| match self.settings_tab {
            SettingsTab::Account => self.account_tab(ui),
            SettingsTab::Appearance => self.appearance_tab(ui),
            SettingsTab::Language => self.language_tab(ui),
            SettingsTab::Nodes => self.nodes_tab(ui),
            SettingsTab::Games => self.games_tab(ui),
            SettingsTab::Desktop => self.desktop_tab(ui),
        });
        self.render_confirm_remove_node(ctx);
        if nav.is_some() {
            self.node_status = None; // checked again the next time the tab opens
        }
        match nav {
            Some(Nav::Tab(i)) => self.settings_tab = tabs[i],
            Some(Nav::Close) => self.active_modal = None,
            Some(Nav::Footer) => {
                self.active_modal = None;
                self.logout();
            }
            None => {}
        }
    }

    fn account_tab(&mut self, ui: &mut Ui) {
        page_title(ui, tr("My Account"));
        let Some(me) = self.state.me.clone() else { return };
        if self.account_name_draft.is_none() {
            self.account_name_draft = Some(me.global_name.clone().unwrap_or_default());
        }
        // `.account-card`: accent banner, big avatar, name and username, then the fields
        Frame::new()
            .fill(BG_SIDEBAR())
            .stroke(Stroke::new(1.0_f32, BORDER()))
            .corner_radius(CornerRadius::same(4))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                let (banner, _) = ui.allocate_exact_size(Vec2::new(ui.available_width(), 72.0), Sense::hover());
                ui.painter().rect_filled(banner, CornerRadius { nw: 4, ne: 4, sw: 0, se: 0 }, ACCENT());
                Frame::new().inner_margin(Margin { left: 16, right: 16, top: 0, bottom: 16 }).show(ui, |ui| {
                    ui.horizontal(|ui| {
                        ui.add_space(0.0);
                        let (r, _) = ui.allocate_exact_size(Vec2::new(88.0, 56.0), Sense::hover());
                        let av = Rect::from_min_size(r.min + Vec2::new(0.0, -36.0), Vec2::splat(88.0));
                        ui.painter().circle_filled(av.center(), 44.0, BG_SIDEBAR());
                        let mut c = ui.new_child(egui::UiBuilder::new().max_rect(av.shrink(6.0)));
                        draw_avatar(&mut c, 76.0, &me.id, me.display_name(), None, BG_SIDEBAR());
                        ui.vertical(|ui| {
                            ui.add_space(8.0);
                            let name = self.account_name_draft.clone().filter(|n| !n.trim().is_empty()).unwrap_or(me.username.clone());
                            ui.label(RichText::new(name.to_uppercase()).font(display_font(26.0)).color(TEXT_HEADER()));
                            ui.label(RichText::new(&me.username).font(ui_font(14.0)).color(TEXT_MUTED()));
                        });
                    });
                    ui.add_space(16.0);
                    field_label(ui, tr("Display Name"));
                    if let Some(d) = self.account_name_draft.as_mut() {
                        text_input(ui, d, &me.username);
                    }
                    ui.add_space(20.0);
                    for (k, v) in [(tr("Username"), Some(me.username.clone())), (tr("Email"), me.email.clone())] {
                        if let Some(v) = v {
                            ui.label(RichText::new(k).font(bold_font(12.0)).color(TEXT_MUTED()));
                            ui.label(RichText::new(v).font(ui_font(14.0)).color(TEXT()));
                            ui.add_space(8.0);
                        }
                    }
                });
            });
        ui.add_space(16.0);
        let draft = self.account_name_draft.clone().unwrap_or_default();
        let dirty = draft.trim() != me.global_name.as_deref().unwrap_or("");
        let mut save = false;
        actions_row(ui, |ui| {
            if ui.add_enabled_ui(dirty, |ui| primary_btn(ui, tr("Save Changes"))).inner.clicked() {
                save = true;
            }
            if ui.add_enabled(dirty, egui::Button::new(RichText::new(tr("Reset")).color(FOCUS())).frame(false)).clicked() {
                self.account_name_draft = None;
            }
        });
        if save {
            let name = draft.trim();
            let body = json!({ "global_name": if name.is_empty() { serde_json::Value::Null } else { json!(name) } });
            self.api_bg(true, move |api| api.patch("/users/@me", body), |app, r| {
                if let Some(v) = report(&mut app.status_banner, r) {
                    report(&mut app.status_banner, app.state.apply("USER_UPDATE", v));
                    app.account_name_draft = None;
                }
            });
        }
    }

    fn appearance_tab(&mut self, ui: &mut Ui) {
        page_title(ui, tr("Appearance"));
        // `.theme-preview`: one message on the chat colour
        Frame::new()
            .fill(BG_CHAT())
            .stroke(Stroke::new(1.0_f32, BORDER()))
            .corner_radius(CornerRadius::same(3))
            .inner_margin(Margin { left: 74, right: 16, top: 28, bottom: 28 })
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    ui.label(RichText::new(tr("Cillhub")).font(bold_font(15.0)).color(TEXT_HEADER()));
                    let now = chrono::Local::now().naive_local();
                    let t = now.format(if crate::i18n::is_german() { "%H:%M" } else { "%I:%M %p" }).to_string();
                    ui.label(RichText::new(t).font(ui_font(12.0)).color(TEXT_MUTED()));
                });
                ui.label(RichText::new(tr("Waiting for the patch to drop? Pick a look you like.")).font(ui_font(15.0)).color(TEXT()));
            });
        ui.add_space(space::S6);
        field_label(ui, tr("Theme"));
        let themes = [("light", tr("Light")), ("ash", tr("Ash")), ("dark", tr("Dark")), ("onyx", tr("Onyx"))];
        let mut pick = None;
        ui.horizontal_top(|ui| {
            ui.spacing_mut().item_spacing.x = space::S5;
            let w = (ui.available_width() - 3.0 * space::S5) / 4.0;
            for (id, label) in themes {
                let on = self.theme_name == id;
                let resp = ui
                    .allocate_ui(Vec2::new(w, 78.0), |ui| {
                        Frame::new()
                            .fill(BG_SIDEBAR())
                            .stroke(Stroke::new(1.0_f32, BORDER()))
                            .corner_radius(CornerRadius::same(2))
                            .inner_margin(Margin::symmetric(12, 10))
                            .show(ui, |ui| {
                                ui.set_width(w - 26.0);
                                ui.horizontal(|ui| {
                                    let (r, _) = ui.allocate_exact_size(Vec2::splat(56.0), Sense::hover());
                                    if on {
                                        ui.painter().circle_stroke(r.center(), 31.5, Stroke::new(3.0_f32, ACCENT()));
                                    }
                                    ui.painter().circle(r.center(), 27.0, palette::for_theme(id).bg_chat, Stroke::new(if on { 0.0_f32 } else { 2.0 }, BORDER()));
                                    ui.label(RichText::new(label).font(ui_font(13.0)).color(TEXT_MUTED()));
                                });
                            })
                            .response
                            .interact(Sense::click())
                    })
                    .inner;
                if resp.clicked() {
                    pick = Some(id);
                }
            }
        });
        if let Some(id) = pick {
            self.set_appearance(Some(id), None);
        }
        ui.add_space(24.0);
        // Zoom Level (the web's range, 50-200 %)
        let mut zoom = (self.settings.font_scale * 100.0).round() as i32;
        ui.horizontal(|ui| {
            ui.label(RichText::new(tr("Zoom Level")).font(bold_font(13.0)).color(INTERACTIVE()));
            ui.label(RichText::new(format!("{zoom}%")).font(ui_font(14.0)).color(TEXT_MUTED()));
        });
        ui.add_space(6.0);
        ui.spacing_mut().slider_width = ui.available_width();
        if ui.add(egui::Slider::new(&mut zoom, 50..=200).step_by(10.0).show_value(false)).changed() {
            self.settings.font_scale = zoom as f32 / 100.0;
            self.theme_applied.clear(); // re-apply with the new scale
            report(&mut self.status_banner, self.settings.save());
        }
    }

    fn language_tab(&mut self, ui: &mut Ui) {
        page_title(ui, tr("Language"));
        field_label(ui, tr("Select a language"));
        for (id, label) in [("en-US", "English, US"), ("de", "Deutsch")] {
            let on = if id == "de" { self.locale.starts_with("de") } else { !self.locale.starts_with("de") };
            let r = choice_card(ui, on, |ui| {
                ui.horizontal(|ui| {
                    super::modals::radio_dot(ui, on);
                    ui.label(RichText::new(label).font(ui_font(15.0)).color(TEXT_HEADER()));
                });
            });
            if r.clicked() {
                self.set_appearance(None, Some(id));
            }
            ui.add_space(8.0);
        }
    }

    /// This app's own: what the game detection shares.
    fn games_tab(&mut self, ui: &mut Ui) {
        page_title(ui, tr("Game Activity"));
        let mut share = self.settings.share_activity;
        if switch_row(ui, tr("Share my game activity"), Some(tr("Shows the game you are playing as your status.")), &mut share) {
            self.set_share_activity(share);
        }
        ui.add_space(16.0);
        let now = match &self.current_game {
            Some(g) => trf("Playing {name}", &[("name", &g.name)]),
            None => tr("No game detected.").to_string(),
        };
        ui.horizontal(|ui| {
            ui.label(RichText::new(now).font(ui_font(15.0)).color(TEXT()));
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                if secondary_btn(ui, tr("Scan Now")).clicked() {
                    self.poll_game_activity(true);
                }
            });
        });
        ui.add_space(24.0);
        field_label(ui, tr("Add a game"));
        ui.horizontal(|ui| {
            let w = (ui.available_width() - 16.0 - 90.0) / 2.0;
            ui.allocate_ui(Vec2::new(w, 40.0), |ui| text_input(ui, &mut self.custom_game_exe_input, "game.exe"));
            ui.allocate_ui(Vec2::new(w, 40.0), |ui| text_input(ui, &mut self.custom_game_name_input, tr("Name")));
            if primary_btn(ui, tr("Add")).clicked()
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
        ui.add_space(12.0);
        let mut remove = None;
        for (i, g) in self.settings.custom_games.iter().enumerate() {
            Frame::new()
                .fill(BG_SIDEBAR())
                .stroke(Stroke::new(1.0_f32, BORDER()))
                .corner_radius(CornerRadius::same(2))
                .inner_margin(Margin::symmetric(12, 8))
                .show(ui, |ui| {
                    ui.set_width(ui.available_width());
                    ui.horizontal(|ui| {
                        ui.label(RichText::new(&g.name).font(bold_font(14.0)).color(TEXT_HEADER()));
                        ui.label(RichText::new(&g.exe).font(crate::theme::mono_font(12.0)).color(TEXT_MUTED()));
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if super::chat::toolbar_btn(ui, IconKind::Trash, false, true).on_hover_text(tr("Remove")).clicked() {
                                remove = Some(i);
                            }
                        });
                    });
                });
            ui.add_space(6.0);
        }
        if let Some(i) = remove {
            self.settings.custom_games.remove(i);
            report(&mut self.status_banner, self.settings.save());
            self.poll_game_activity(true);
        }
    }

    /// Settings › Private Nodes (the web's settings/PrivateNodes.tsx): the Main Hub, then the saved nodes with
    /// whether they answered when the tab opened; add (checked first), copy add link, remove (asks first).
    fn nodes_tab(&mut self, ui: &mut Ui) {
        page_title(ui, tr("Private Nodes"));
        ui.label(RichText::new(tr("Private nodes you use besides the Main Hub, all connected at once. Each node is a separate server with its own accounts and admins. The list is saved with your account.")).font(ui_font(14.0)).color(TEXT_MUTED()));
        ui.add_space(16.0);
        // the hub this app is signed in to (else the default one)
        let hub = self.api.as_ref().map_or_else(|| crate::nodes::node_origin(crate::config::HUB_URL).unwrap_or_default(), |a| a.origin.origin().ascii_serialization());
        if self.node_status.is_none() {
            self.node_status = Some(Default::default());
            let all: Vec<String> = std::iter::once(hub.clone()).chain(self.settings.private_nodes.iter().map(|n| n.origin.clone())).collect();
            for origin in all {
                self.check_node(origin);
            }
        }
        let host = |o: &str| o.split("://").nth(1).unwrap_or(o).to_string();
        self.node_row(ui, &hub, &host(&hub), None);
        for n in self.settings.private_nodes.clone() {
            let fallback = if n.name.is_empty() { host(&n.origin) } else { n.name.clone() };
            self.node_row(ui, &n.origin, &fallback, Some(&n));
        }
        let pending = self.settings.pending_revokes.len() + self.unsaved_revokes.len() + self.settings.pending_removals.len();
        if pending > 0 {
            ui.label(RichText::new(trf("Sign-out still pending on {n} node(s).", &[("n", &pending.to_string())])).font(ui_font(13.0)).color(TEXT_MUTED()));
            ui.add_space(6.0);
        }
        if self.settings.private_nodes.is_empty() {
            ui.label(RichText::new(tr("No private nodes saved yet.")).font(ui_font(14.0)).color(TEXT_MUTED()));
            ui.add_space(8.0);
        }
        ui.add_space(8.0);
        field_label(ui, tr("Node address"));
        // adding is the consent to the background sign-in
        ui.label(RichText::new(tr(super::modals::SIGN_IN_NOTE)).font(ui_font(13.0)).color(TEXT_MUTED()));
        ui.add_space(6.0);
        let mut submit = false;
        ui.horizontal(|ui| {
            let w = ui.available_width() - 160.0;
            let r = ui.allocate_ui(Vec2::new(w, 40.0), |ui| text_input(ui, &mut self.node_input, "https://chat.example.org")).inner;
            if r.changed() {
                self.node_error = None;
            }
            submit = r.lost_focus() && ui.input(|i| i.key_pressed(egui::Key::Enter));
            let ok = !self.node_busy && !self.node_input.trim().is_empty();
            if ui.add_enabled_ui(ok, |ui| secondary_btn(ui, if self.node_busy { tr("Checking…") } else { tr("Add node") })).inner.clicked() {
                submit = true;
            }
        });
        if let Some(e) = &self.node_error {
            ui.add_space(6.0);
            ui.label(RichText::new(e).font(ui_font(13.0)).color(DANGER()));
        }
        if submit && !self.node_busy && !self.node_input.trim().is_empty() {
            let address = self.node_input.clone();
            self.add_node(address, true);
        }
    }

    fn node_row(&mut self, ui: &mut Ui, origin: &str, fallback: &str, saved: Option<&crate::nodes::SavedNode>) {
        use crate::nodes::NodeCheck;
        let check = self.node_status.as_ref().and_then(|m| m.get(origin)).cloned().unwrap_or(NodeCheck::Checking);
        let name = match &check {
            NodeCheck::Up(n) if !n.is_empty() => n.clone(),
            _ => fallback.to_string(),
        };
        use crate::nodes::NodeLink;
        // signed in to the hub: a saved node shows its connection, else whether it answered when the tab opened
        let link = saved.and(self.api.as_ref()).and_then(|_| self.conns.get(origin)).map(|c| c.link.clone());
        let own_login = tr("Needs its own login · not connected").to_string();
        let (dot, state, hint) = match (link, check) {
            (Some(NodeLink::Ready), _) => (GREEN(), tr("Connected").to_string(), None),
            (Some(NodeLink::Connecting), _) => (YELLOW(), tr("Connecting…").to_string(), None),
            (Some(NodeLink::Down(why)), _) => (YELLOW(), trf("Not connected: {reason} Retrying…", &[("reason", &why)]), None),
            (Some(NodeLink::OwnLogin), _) => (TEXT_MUTED(), own_login, None),
            (Some(NodeLink::Old), _) => (TEXT_MUTED(), own_login, Some(tr("Update the node so this app can sign you in there."))),
            (None, NodeCheck::Checking) => (TEXT_MUTED(), tr("Checking…").to_string(), None),
            (None, NodeCheck::Up(_)) => (GREEN(), tr("Reachable").to_string(), None),
            (None, NodeCheck::Down) => (DANGER(), tr("Not reachable").to_string(), None),
        };
        Frame::new()
            .fill(BG_SIDEBAR())
            .stroke(Stroke::new(1.0_f32, BORDER()))
            .corner_radius(CornerRadius::same(2))
            .inner_margin(Margin::symmetric(12, 10))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.horizontal(|ui| {
                    ui.vertical(|ui| {
                        // long reasons wrap left of the buttons
                        ui.set_max_width(ui.available_width() - if saved.is_some() { 250.0 } else { 0.0 });
                        ui.horizontal(|ui| {
                            ui.label(RichText::new(name).font(bold_font(15.0)).color(TEXT_HEADER()));
                            if saved.is_none() {
                                ui.label(RichText::new(tr("Main Hub")).font(bold_font(11.5)).color(TEXT_MUTED()));
                            }
                        });
                        ui.label(RichText::new(origin).font(crate::theme::mono_font(12.0)).color(TEXT_MUTED()));
                        ui.horizontal(|ui| {
                            let (r, _) = ui.allocate_exact_size(Vec2::splat(8.0), Sense::hover());
                            ui.painter().circle_filled(r.center(), 4.0, dot);
                            ui.add(egui::Label::new(RichText::new(state).font(ui_font(12.5)).color(TEXT_MUTED())).wrap());
                        });
                        if let Some(h) = hint {
                            ui.label(RichText::new(h).font(ui_font(12.5)).color(TEXT_MUTED()));
                        }
                    });
                    if let Some(n) = saved {
                        ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                            if super::chat::toolbar_btn(ui, IconKind::Trash, false, true).on_hover_text(tr("Remove")).clicked() {
                                self.confirm_remove_node = Some(n.clone());
                            }
                            if secondary_btn(ui, tr("Copy add link")).clicked() {
                                let base = self.api.as_ref().map_or_else(|| crate::config::HUB_URL.to_string(), |a| a.origin.origin().ascii_serialization());
                                ui.ctx().copy_text(crate::nodes::add_link(&base, &n.origin));
                                self.status_banner = Some(tr("Link copied.").to_string());
                            }
                        });
                    }
                });
            });
        ui.add_space(6.0);
    }

    fn render_confirm_remove_node(&mut self, ctx: &Context) {
        let Some(n) = self.confirm_remove_node.clone() else { return };
        let (mut remove, mut close) = (false, false);
        let (_, dim) = super::modals::overlay_top(ctx, "confirm_remove_node", 448.0, |ui| {
            super::modals::modal_title(ui, &trf("Remove {name}?", &[("name", if n.name.is_empty() { &n.origin } else { &n.name })]));
            ui.label(RichText::new(trf("{address} leaves the list on all your devices. Cillhub signs you out there and its servers leave your server list. Your account there stays as it is.", &[("address", &n.origin)])).font(ui_font(15.0)).color(TEXT()));
            ui.add_space(18.0);
            actions_row(ui, |ui| {
                remove = danger_btn(ui, tr("Remove")).clicked();
                close = secondary_btn(ui, tr("Cancel")).clicked();
            });
        });
        if remove {
            self.remove_saved_node(&n.origin);
        }
        if remove || close || dim || ctx.input(|i| i.key_pressed(egui::Key::Escape)) {
            self.confirm_remove_node = None;
        }
    }

    /// Checks one node off the UI thread; the result lands in this opening's status map.
    fn check_node(&mut self, origin: String) {
        if let Some(m) = &mut self.node_status {
            m.insert(origin.clone(), crate::nodes::NodeCheck::Checking);
        }
        let o = origin.clone();
        self.spawn_bg(false, move || crate::nodes::fetch_name(&o), move |app, name| {
            if let Some(m) = &mut app.node_status {
                m.insert(origin, name.map_or(crate::nodes::NodeCheck::Down, crate::nodes::NodeCheck::Up));
            }
        });
    }

    /// Validates, checks the node off the UI thread, then saves it under the name it gives itself.
    /// `from_tab`: errors go to the tab's field, else to the add-link dialog.
    pub fn add_node(&mut self, address: String, from_tab: bool) {
        let hub = self.api.as_ref().map_or_else(|| crate::config::HUB_URL.to_string(), |a| a.origin.origin().ascii_serialization());
        // the add-link dialog that asked: another link may have replaced it meanwhile
        let dialog = self.add_dialog_gen;
        let fail = move |app: &mut CillhubApp, origin: &str, e: String| {
            if from_tab {
                app.node_error = Some(e);
            } else if let Some(p) = app.add_dialog(origin, dialog) {
                p.error = Some(e);
            }
        };
        let origin = match crate::nodes::add_node(&self.settings.private_nodes, &address, "", &hub) {
            Ok(n) => n.origin,
            Err(r) => return fail(self, &address, trf(r.message(), &[("n", &crate::nodes::MAX_NODES.to_string())])),
        };
        self.node_busy = true;
        let o = origin.clone();
        self.spawn_bg(false, move || crate::nodes::fetch_name(&o), move |app, name| {
            app.node_busy = false;
            let Some(name) = name else { return fail(app, &origin, tr("Could not connect to node at this address.").to_string()) };
            let name = if name.is_empty() { origin.split("://").nth(1).unwrap_or(&origin).to_string() } else { name };
            match crate::nodes::add_node(&app.settings.private_nodes, &origin, &name, &hub) {
                Ok(n) => {
                    app.save_added_node(n);
                    if from_tab {
                        app.node_input.clear();
                        if let Some(m) = &mut app.node_status {
                            m.insert(origin, crate::nodes::NodeCheck::Up(name));
                        }
                    } else if let Some(p) = app.add_dialog(&origin, dialog) {
                        p.added = true;
                    }
                }
                Err(r) => fail(app, &origin, trf(r.message(), &[("n", &crate::nodes::MAX_NODES.to_string())])),
            }
        });
    }

    /// This app's own: start with the system, version, update.
    fn desktop_tab(&mut self, ui: &mut Ui) {
        page_title(ui, tr("Desktop"));
        let mut on = self.settings.open_on_startup;
        if switch_row(ui, tr("Open Cillhub when you log in"), None, &mut on) {
            self.settings.open_on_startup = on;
            report(&mut self.status_banner, crate::settings::set_autostart(on));
            report(&mut self.status_banner, self.settings.save());
        }
        ui.add_space(16.0);
        ui.label(RichText::new(trf("Version {v}", &[("v", env!("CARGO_PKG_VERSION"))])).font(ui_font(14.0)).color(TEXT_MUTED()));
        if let Some(crate::update::Staged { version: v, .. }) = &self.update_ready {
            ui.label(RichText::new(trf("A new version of Cillhub is available ({version}).", &[("version", v)])).font(ui_font(14.0)).color(GREEN()));
        }
    }

    pub fn render_server_settings(&mut self, ctx: &Context) {
        let Some(gid) = self.selected_guild_id.clone() else {
            self.active_modal = None;
            return;
        };
        let Some(guild) = self.state.guilds.get(&gid).cloned() else {
            self.active_modal = None;
            return;
        };
        use crate::permissions::{has, p};
        let perms = self.guild_perms(&gid);
        let mut tabs = Vec::new();
        let mut labels = Vec::new();
        if has(perms, p::MANAGE_GUILD) {
            tabs.push(ServerTab::Overview);
            labels.push(tr("Overview"));
        }
        if has(perms, p::MANAGE_ROLES) {
            tabs.push(ServerTab::Roles);
            labels.push(tr("Roles"));
        }
        if tabs.is_empty() {
            self.active_modal = None;
            return;
        }
        if !tabs.contains(&self.server_tab) {
            self.server_tab = tabs[0];
        }
        let current = tabs.iter().position(|t| *t == self.server_tab).unwrap_or(0);
        let sections = vec![(guild.name.clone(), labels)];
        let nav = settings_page(ctx, "server_settings", &sections, current, None, |ui| match self.server_tab {
            ServerTab::Overview => self.overview_tab(ui, &guild),
            ServerTab::Roles => self.roles_tab(ui, &guild),
        });
        match nav {
            Some(Nav::Tab(i)) => self.server_tab = tabs[i],
            Some(Nav::Close) => {
                self.active_modal = None;
                self.role_draft = None;
                self.guild_name_draft = None;
            }
            _ => {}
        }
    }

    fn overview_tab(&mut self, ui: &mut Ui, guild: &crate::model::Guild) {
        page_title(ui, tr("Server Overview"));
        let draft = self.guild_name_draft.get_or_insert_with(|| guild.name.clone());
        field_label(ui, tr("Server Name"));
        text_input(ui, draft, "");
        let dirty = draft.trim() != guild.name && !draft.trim().is_empty();
        let name = draft.trim().to_string();
        ui.add_space(20.0);
        let mut save = false;
        actions_row(ui, |ui| {
            if ui.add_enabled_ui(dirty, |ui| primary_btn(ui, tr("Save Changes"))).inner.clicked() {
                save = true;
            }
            if ui.add_enabled(dirty, egui::Button::new(RichText::new(tr("Reset")).color(FOCUS())).frame(false)).clicked() {
                self.guild_name_draft = None;
            }
        });
        if save && self.api.is_some() {
            let (path, gid, body) = (format!("/guilds/{}", guild.id), guild.id.clone(), json!({ "name": name }));
            self.api_then(move |api| api.patch(&path, body), move |app| {
                if let Some(g) = app.state.guilds.get_mut(&gid) {
                    g.name = name;
                }
                app.guild_name_draft = None;
            });
        }
    }

    /// Roles (settings/Roles.tsx): list with Create Role, the editor with name, colour,
    /// switches and the web's permission groups; Delete Role, Reset, Save Changes.
    fn roles_tab(&mut self, ui: &mut Ui, guild: &crate::model::Guild) {
        page_title(ui, tr("Roles"));
        ui.label(RichText::new(tr("Use roles to group your server members and assign permissions. Members use the color of their highest role. Use the arrows to change the hierarchy.")).font(ui_font(14.0)).color(TEXT_MUTED()));
        ui.add_space(16.0);
        let mut roles: Vec<Role> = guild.roles.clone();
        roles.sort_by(|a, b| b.position.cmp(&a.position).then(a.id.cmp(&b.id)));
        let everyone_last = |r: &Role| r.id == guild.id;
        roles.sort_by_key(everyone_last);
        let selected = self
            .role_draft
            .as_ref()
            .map(|d| d.id.clone())
            .or_else(|| roles.first().map(|r| r.id.clone()));
        if self.role_draft.as_ref().map(|d| &d.id) != selected.as_ref() || self.role_draft.is_none() {
            self.role_draft = selected.and_then(|id| roles.iter().find(|r| r.id == id).cloned());
        }
        let mut select = None;
        let mut create = false;
        let mut swap: Option<((String, i32), (String, i32))> = None;
        ui.horizontal_top(|ui| {
            ui.spacing_mut().item_spacing.x = 24.0;
            // `.roles-list` (220px)
            ui.allocate_ui_with_layout(Vec2::new(220.0, 0.0), Layout::top_down(Align::Min), |ui| {
                ui.set_width(220.0);
                ui.spacing_mut().item_spacing.y = 2.0;
                let (r, resp) = ui.allocate_exact_size(Vec2::new(220.0, 36.0), Sense::click());
                ui.painter().rect_filled(r, CornerRadius::same(2), if resp.hovered() { ACCENT_HOVER() } else { ACCENT() });
                ui.painter().text(r.center(), egui::Align2::CENTER_CENTER, tr("Create Role").to_uppercase(), display_font(16.0), ON_ACCENT());
                if resp.clicked() {
                    create = true;
                }
                ui.add_space(6.0);
                for role in &roles {
                    let on = self.role_draft.as_ref().is_some_and(|d| d.id == role.id);
                    let (r, resp) = ui.allocate_exact_size(Vec2::new(220.0, 33.0), Sense::click());
                    if on || resp.hovered() {
                        ui.painter().rect_filled(r, CornerRadius::same(2), if on { BG_SELECTED() } else { BG_HOVER() });
                    }
                    let dot = if role.color != 0 { role_color(role.color) } else { OFFLINE() };
                    ui.painter().circle_filled(Pos2::new(r.min.x + 15.0, r.center().y), 5.0, dot);
                    let name = if role.id == guild.id { "@everyone".to_string() } else { role.name.clone() };
                    ui.painter().text(Pos2::new(r.min.x + 28.0, r.center().y), egui::Align2::LEFT_CENTER, name, ui_font(15.0), TEXT_HEADER());
                    // `.role-move`: up / down (swaps position with the neighbour, not past @everyone)
                    let movable: Vec<&Role> = roles.iter().filter(|r| r.id != guild.id).collect();
                    if let Some(i) = movable.iter().position(|r| r.id == role.id) {
                        for (dir, icon, x) in [(-1i32, IconKind::Up, r.max.x - 44.0), (1, IconKind::Down, r.max.x - 22.0)] {
                            let j = i as i32 + dir;
                            let ok = j >= 0 && (j as usize) < movable.len();
                            let br = Rect::from_center_size(Pos2::new(x, r.center().y), Vec2::splat(20.0));
                            let b = ui.interact(br, egui::Id::new(("role_move", &role.id, dir)), if ok { Sense::click() } else { Sense::hover() });
                            let c = if !ok { TEXT_MUTED().gamma_multiply(0.4) } else if b.hovered() { TEXT_HEADER() } else { TEXT_MUTED() };
                            draw_icon(ui.painter(), Rect::from_center_size(br.center(), Vec2::splat(14.0)), icon, c);
                            if ok && b.clicked() {
                                let other = movable[j as usize];
                                swap = Some(((role.id.clone(), other.position), (other.id.clone(), role.position)));
                            }
                        }
                    }
                    if resp.clicked() && swap.is_none() {
                        select = Some(role.clone());
                    }
                }
            });
            // `.role-editor`
            ui.allocate_ui_with_layout(Vec2::new(ui.available_width(), 0.0), Layout::top_down(Align::Min), |ui| {
                self.role_editor(ui, guild);
            });
        });
        if let Some(r) = select {
            self.role_draft = Some(r);
        }
        let (path, gid) = (format!("/guilds/{}/roles", guild.id), guild.id.clone());
        if let (Some(((a, pa), (b, pb))), true) = (swap, self.api.is_some()) {
            let body = json!([{ "id": a, "position": pa }, { "id": b, "position": pb }]);
            let (path, gid) = (path.clone(), gid.clone());
            self.api_then(move |api| api.patch(&path, body), move |app| {
                if let Some(g) = app.state.guilds.get_mut(&gid) {
                    for r in g.roles.iter_mut() {
                        if r.id == a {
                            r.position = pa;
                        } else if r.id == b {
                            r.position = pb;
                        }
                    }
                }
            });
        }
        if create {
            self.api_bg(true, move |api| api.post(&path, json!({})), move |app, r| {
                let Some(v) = report(&mut app.status_banner, r) else { return };
                if let Ok(role) = serde_json::from_value::<Role>(v) {
                    if let Some(g) = app.state.guilds.get_mut(&gid) {
                        if !g.roles.iter().any(|r| r.id == role.id) {
                            g.roles.push(role.clone());
                        }
                    }
                    app.role_draft = Some(role);
                }
            });
        }
    }

    fn role_editor(&mut self, ui: &mut Ui, guild: &crate::model::Guild) {
        let Some(mut d) = self.role_draft.clone() else { return };
        let Some(orig) = guild.roles.iter().find(|r| r.id == d.id).cloned() else { return };
        let everyone = d.id == guild.id;
        let shown = if everyone { "@everyone".to_string() } else { orig.name.clone() };
        ui.label(RichText::new(trf("Edit Role — {name}", &[("name", &shown)]).to_uppercase()).font(display_font(22.0)).color(TEXT_HEADER()));
        ui.add_space(16.0);
        if !everyone {
            field_label(ui, tr("Role Name"));
            text_input(ui, &mut d.name, "");
            ui.add_space(20.0);
            field_label(ui, tr("Role Color"));
            ui.horizontal_wrapped(|ui| {
                ui.spacing_mut().item_spacing = Vec2::splat(8.0);
                for c in std::iter::once(0).chain(SWATCHES) {
                    let (r, resp) = ui.allocate_exact_size(Vec2::splat(32.0), Sense::click());
                    let fill = if c == 0 { OFFLINE() } else { role_color(c) };
                    let r2 = if resp.hovered() { r.expand(1.0) } else { r };
                    ui.painter().rect_filled(r2, CornerRadius::same(2), fill);
                    if d.color == c {
                        ui.painter().rect_stroke(r.expand(3.0), CornerRadius::same(3), Stroke::new(2.0_f32, TEXT_HEADER()), egui::StrokeKind::Inside);
                    }
                    if resp.on_hover_text(if c == 0 { tr("Default color").to_string() } else { format!("#{c:06x}") }).clicked() {
                        d.color = c;
                    }
                }
            });
            ui.add_space(8.0);
            switch_row(ui, tr("Display role members separately from online members"), None, &mut d.hoist);
            switch_row(ui, tr("Allow anyone to @mention this role"), None, &mut d.mentionable);
        }
        ui.add_space(24.0);
        ui.label(RichText::new(tr("Permissions")).font(bold_font(16.0)).color(TEXT_HEADER()));
        let mut bits = crate::permissions::parse_bits(&d.permissions);
        for g in perm_groups() {
            ui.add_space(20.0);
            crate::theme::draw_list_heading(ui, tr_owned(&g.title));
            ui.add_space(4.0);
            for p in &g.perms {
                let bit = 1u64 << p.bit;
                let mut on = bits & bit != 0;
                if switch_row(ui, tr_owned(&p.label), Some(tr_owned(&p.note)), &mut on) {
                    bits = if on { bits | bit } else { bits & !bit };
                }
            }
        }
        d.permissions = bits.to_string();
        let dirty = d.name != orig.name || d.color != orig.color || d.hoist != orig.hoist || d.mentionable != orig.mentionable || d.permissions != orig.permissions;
        ui.add_space(20.0);
        let (mut save, mut delete, mut reset) = (false, false, false);
        ui.horizontal(|ui| {
            if !everyone && danger_btn(ui, tr("Delete Role")).clicked() {
                delete = true;
            }
            actions_row(ui, |ui| {
                if ui.add_enabled_ui(dirty && (everyone || !d.name.trim().is_empty()), |ui| primary_btn(ui, tr("Save Changes"))).inner.clicked() {
                    save = true;
                }
                if ui.add_enabled(dirty, egui::Button::new(RichText::new(tr("Reset")).color(FOCUS())).frame(false)).clicked() {
                    reset = true;
                }
            });
        });
        self.role_draft = Some(if reset { orig.clone() } else { d.clone() });
        if self.api.is_none() {
            return;
        }
        let (path, gid) = (format!("/guilds/{}/roles/{}", guild.id, d.id), guild.id.clone());
        if save {
            let body = json!({ "name": d.name.trim(), "color": d.color, "hoist": d.hoist, "mentionable": d.mentionable, "permissions": d.permissions });
            let (path, gid, d) = (path.clone(), gid.clone(), d.clone());
            self.api_bg(true, move |api| api.patch(&path, body), move |app, r| {
                let Some(v) = report(&mut app.status_banner, r) else { return };
                let role = serde_json::from_value::<Role>(v).unwrap_or(d);
                if let Some(g) = app.state.guilds.get_mut(&gid) {
                    if let Some(r) = g.roles.iter_mut().find(|r| r.id == role.id) {
                        *r = role.clone();
                    }
                }
                app.role_draft = Some(role);
            });
        }
        if delete {
            let rid = d.id.clone();
            self.api_then(move |api| api.delete(&path), move |app| {
                if let Some(g) = app.state.guilds.get_mut(&gid) {
                    g.roles.retain(|r| r.id != rid);
                }
                app.role_draft = None;
            });
        }
    }
}
