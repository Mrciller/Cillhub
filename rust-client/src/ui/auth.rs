//! Authentication screen matching `client/src/components/Auth.tsx` and `client/src/index.css`:
//! 40px × 40px `.auth-bg` arena grid, notched `.auth-card` HUD polygon with 4px top accent bar,
//! `.auth-brand` badge, `Barlow Condensed` display headings (`READY UP` / `JOIN THE ROSTER`),
//! `.server-choice` selector (Main Hub / Private Node), and styled inputs/buttons.

use super::report;
use crate::api::normalize_server_url;
use crate::config::HUB_URL;
use crate::theme::{
    bold_font, display_font, draw_auth_grid, palette::*, show_notched_card, ui_font,
};
use crate::ui::{AuthMode, CillhubApp};
use egui::{
    Align, Align2, Color32, CornerRadius, Frame, Layout, Margin, Pos2, Rect, RichText, Sense,
    Stroke, StrokeKind, TextEdit, Ui, Vec2,
};
use serde_json::{json, Value};

impl CillhubApp {
    pub fn render_auth(&mut self, ui: &mut Ui) {
        let full_rect = ui.max_rect();
        draw_auth_grid(ui.painter(), full_rect);

        ui.vertical_centered(|ui| {
            let top_pad = ((full_rect.height() - 560.0) * 0.45).max(24.0);
            ui.add_space(top_pad);

            let card_width = 440.0_f32.min(full_rect.width() - 32.0);
            show_notched_card(
                ui,
                BG_SIDEBAR,
                BORDER,
                12.0,
                Some(ACCENT),
                None,
                Margin::symmetric(32, 34),
                |ui| {
                    ui.set_width(card_width - 64.0);
                    ui.with_layout(Layout::top_down(Align::Min), |ui| {
                        // .auth-brand: 10px × 10px accent square + CILLHUB
                        ui.horizontal(|ui| {
                            ui.spacing_mut().item_spacing.x = 10.0;
                            let (mark_rect, _) =
                                ui.allocate_exact_size(Vec2::splat(10.0), Sense::hover());
                            ui.painter().rect_filled(mark_rect, 0.0, ACCENT);
                            ui.label(
                                RichText::new("CILLHUB")
                                    .font(display_font(18.0))
                                    .color(ACCENT),
                            );
                        });

                        ui.add_space(6.0);

                        let (heading, subtitle) = match self.auth_mode {
                            AuthMode::Login => (
                                "READY UP",
                                "Log in to get back to your team.",
                            ),
                            AuthMode::Register => (
                                "JOIN THE ROSTER",
                                "Create your Cillhub account in seconds.",
                            ),
                            AuthMode::Mfa => (
                                "VERIFY ACCESS",
                                "Enter your 6-digit authenticator code or 8-character backup code.",
                            ),
                            AuthMode::ResetPassword => (
                                "RESET PASSWORD",
                                "Enter your account email or username to reset your password.",
                            ),
                        };

                        ui.label(
                            RichText::new(heading)
                                .font(display_font(38.0))
                                .color(TEXT_HEADER),
                        );
                        ui.add_space(2.0);
                        ui.label(
                            RichText::new(subtitle)
                                .font(ui_font(15.0))
                                .color(TEXT_MUTED),
                        );

                        ui.add_space(18.0);

                        // .server-choice box matching Auth.tsx
                        Frame::new()
                            .fill(BG_PANEL)
                            .stroke(Stroke::new(1.0_f32, BORDER))
                            .corner_radius(CornerRadius::same(2))
                            .inner_margin(Margin::same(10))
                            .show(ui, |ui| {
                                ui.set_width(ui.available_width());
                                let is_hub = self.settings.server_target != "node";
                                let is_node = self.settings.server_target == "node";

                                ui.horizontal(|ui| {
                                    ui.spacing_mut().item_spacing.x = 6.0;
                                    let tab_w = (ui.available_width() - 6.0) / 2.0;

                                    if Self::server_tab_btn(
                                        ui,
                                        Vec2::new(tab_w, 32.0),
                                        "🌐 Main Hub",
                                        Some("DEFAULT"),
                                        is_hub,
                                    )
                                    .clicked()
                                    {
                                        self.settings.server_target = "hub".to_string();
                                        self.auth_server_url = HUB_URL.to_string();
                                        report(&mut self.status_banner, self.settings.save());
                                    }

                                    if Self::server_tab_btn(
                                        ui,
                                        Vec2::new(tab_w, 32.0),
                                        "🔒 Private Node",
                                        None,
                                        is_node,
                                    )
                                    .clicked()
                                    {
                                        self.settings.server_target = "node".to_string();
                                        if !self.settings.custom_node_url.is_empty() {
                                            self.auth_server_url =
                                                self.settings.custom_node_url.clone();
                                        }
                                        report(&mut self.status_banner, self.settings.save());
                                    }
                                });

                                ui.add_space(6.0);

                                if is_node {
                                    ui.label(
                                        RichText::new("Node Server URL")
                                            .font(bold_font(12.5))
                                            .color(INTERACTIVE),
                                    );
                                    ui.add_space(4.0);
                                    let resp = Self::auth_text_input(
                                        ui,
                                        &mut self.auth_server_url,
                                        "https://chat.yourteam.gg",
                                        false,
                                    );
                                    if resp.changed() {
                                        self.settings.custom_node_url =
                                            self.auth_server_url.clone();
                                    }
                                    ui.add_space(4.0);
                                    ui.label(
                                        RichText::new(
                                            "Connect directly to a self-hosted Cillhub node.",
                                        )
                                        .font(ui_font(12.0))
                                        .color(TEXT_MUTED),
                                    );
                                } else {
                                    let host = self
                                        .auth_server_url
                                        .trim_start_matches("https://")
                                        .trim_start_matches("http://");
                                    ui.horizontal(|ui| {
                                        ui.spacing_mut().item_spacing.x = 4.0;
                                        ui.label(
                                            RichText::new("Connected to")
                                                .font(ui_font(12.0))
                                                .color(TEXT_MUTED),
                                        );
                                        ui.label(
                                            RichText::new(host)
                                                .font(bold_font(12.0))
                                                .color(TEXT),
                                        );
                                    });
                                }
                            });

                        ui.add_space(14.0);

                        match self.auth_mode {
                            AuthMode::Mfa => {
                                Self::field_label(ui, "6-digit code or 8-char backup code");
                                let code_resp = Self::auth_text_input(
                                    ui,
                                    &mut self.auth_mfa_code,
                                    "123456",
                                    false,
                                );
                                if code_resp.lost_focus()
                                    && ui.input(|i| i.key_pressed(egui::Key::Enter))
                                {
                                    self.submit_mfa();
                                }
                                ui.add_space(16.0);
                                if Self::primary_wide_btn(ui, "VERIFY").clicked() {
                                    self.submit_mfa();
                                }
                                ui.add_space(10.0);
                                if ui
                                    .add(
                                        egui::Button::new(
                                            RichText::new("← Back to login")
                                                .font(ui_font(13.0))
                                                .color(ACCENT),
                                        )
                                        .frame(false),
                                    )
                                    .clicked()
                                {
                                    self.auth_mode = AuthMode::Login;
                                }
                            }
                            AuthMode::ResetPassword => {
                                Self::field_label(ui, "Email or username");
                                Self::auth_text_input(
                                    ui,
                                    &mut self.auth_login_input,
                                    "you@example.org",
                                    false,
                                );
                                ui.add_space(10.0);
                                Self::field_label(ui, "Reset token (if received)");
                                Self::auth_text_input(
                                    ui,
                                    &mut self.auth_reset_token,
                                    "paste reset token",
                                    false,
                                );
                                if !self.auth_reset_token.trim().is_empty() {
                                    ui.add_space(10.0);
                                    Self::field_label(ui, "New password");
                                    Self::auth_text_input(
                                        ui,
                                        &mut self.auth_password_input,
                                        "",
                                        true,
                                    );
                                }
                                ui.add_space(16.0);
                                let btn_txt = if self.auth_reset_token.trim().is_empty() {
                                    "SEND RESET LINK"
                                } else {
                                    "SET NEW PASSWORD"
                                };
                                if Self::primary_wide_btn(ui, btn_txt).clicked() {
                                    self.submit_password_reset();
                                }
                                ui.add_space(10.0);
                                if ui
                                    .add(
                                        egui::Button::new(
                                            RichText::new("← Back to login")
                                                .font(ui_font(13.0))
                                                .color(ACCENT),
                                        )
                                        .frame(false),
                                    )
                                    .clicked()
                                {
                                    self.auth_mode = AuthMode::Login;
                                }
                            }
                            AuthMode::Login | AuthMode::Register => {
                                let is_reg = self.auth_mode == AuthMode::Register;

                                Self::field_label(
                                    ui,
                                    if is_reg {
                                        "Username"
                                    } else {
                                        "Email or username"
                                    },
                                );
                                Self::auth_text_input(
                                    ui,
                                    &mut self.auth_login_input,
                                    "",
                                    false,
                                );

                                if is_reg {
                                    ui.add_space(12.0);
                                    Self::field_label(ui, "Email (optional)");
                                    Self::auth_text_input(
                                        ui,
                                        &mut self.auth_email_input,
                                        "",
                                        false,
                                    );
                                }

                                ui.add_space(12.0);
                                Self::field_label(ui, "Password");
                                let pw_resp = Self::auth_text_input(
                                    ui,
                                    &mut self.auth_password_input,
                                    "",
                                    true,
                                );
                                if pw_resp.lost_focus()
                                    && ui.input(|i| i.key_pressed(egui::Key::Enter))
                                {
                                    self.submit_auth();
                                }

                                if let Some(err) = &self.auth_error {
                                    ui.add_space(10.0);
                                    ui.label(
                                        RichText::new(err)
                                            .font(ui_font(13.0))
                                            .color(DANGER),
                                    );
                                }

                                ui.add_space(16.0);
                                if Self::primary_wide_btn(
                                    ui,
                                    if is_reg { "CONTINUE" } else { "LOG IN" },
                                )
                                .clicked()
                                {
                                    self.submit_auth();
                                }

                                if !is_reg {
                                    ui.add_space(8.0);
                                    if Self::secondary_wide_btn(ui, "🔑 SIGN IN WITH PASSKEY")
                                        .clicked()
                                    {
                                        self.auth_error = Some(
                                            "Enter your username above or use password login on desktop."
                                                .to_string(),
                                        );
                                    }
                                }

                                ui.add_space(14.0);
                                ui.horizontal(|ui| {
                                    ui.spacing_mut().item_spacing.x = 4.0;
                                    ui.label(
                                        RichText::new(if is_reg {
                                            "Already have an account?"
                                        } else {
                                            "Need an account?"
                                        })
                                        .font(ui_font(13.0))
                                        .color(TEXT_MUTED),
                                    );
                                    if ui
                                        .add(
                                            egui::Button::new(
                                                RichText::new(if is_reg {
                                                    "Log in"
                                                } else {
                                                    "Register"
                                                })
                                                .font(bold_font(13.0))
                                                .color(ACCENT),
                                            )
                                            .frame(false),
                                        )
                                        .clicked()
                                    {
                                        self.auth_mode = if is_reg {
                                            AuthMode::Login
                                        } else {
                                            AuthMode::Register
                                        };
                                        self.auth_error = None;
                                    }

                                    if !is_reg {
                                        ui.with_layout(
                                            Layout::right_to_left(Align::Center),
                                            |ui| {
                                                if ui
                                                    .add(
                                                        egui::Button::new(
                                                            RichText::new("Forgot your password?")
                                                                .font(ui_font(13.0))
                                                                .color(ACCENT),
                                                        )
                                                        .frame(false),
                                                    )
                                                    .clicked()
                                                {
                                                    self.auth_mode = AuthMode::ResetPassword;
                                                }
                                            },
                                        );
                                    }
                                });
                            }
                        }

                        ui.add_space(12.0);
                        ui.horizontal(|ui| {
                            let game_txt = if let Some(g) = &self.current_game {
                                format!("🎮 Active: {}", g.name)
                            } else {
                                "🎮 Game Activity Ready".to_string()
                            };
                            ui.label(
                                RichText::new(game_txt)
                                    .font(ui_font(11.5))
                                    .color(TEXT_MUTED),
                            );
                            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                if ui
                                    .add(
                                        egui::Button::new(
                                            RichText::new("Preview UI Offline →")
                                                .font(ui_font(11.5))
                                                .color( TEXT_MUTED ),
                                        )
                                        .frame(false),
                                    )
                                    .clicked()
                                {
                                    self.enter_demo_arena();
                                }
                            });
                        });
                    });
                },
            );
        });
    }

    fn field_label(ui: &mut Ui, label: &str) {
        ui.label(
            RichText::new(label)
                .font(bold_font(13.0))
                .color(INTERACTIVE),
        );
        ui.add_space(5.0);
    }

    fn auth_text_input(
        ui: &mut Ui,
        value: &mut String,
        hint: &str,
        password: bool,
    ) -> egui::Response {
        let desired = Vec2::new(ui.available_width(), 40.0);
        let mut resp_out = None;
        Frame::new()
            .fill(BG_RAIL)
            .stroke(Stroke::new(1.0_f32, BORDER))
            .corner_radius(CornerRadius::same(2))
            .inner_margin(Margin::symmetric(12, 9))
            .show(ui, |ui| {
                ui.set_width(desired.x - 24.0);
                let edit = TextEdit::singleline(value)
                    .font(ui_font(14.5))
                    .text_color(TEXT)
                    .hint_text(RichText::new(hint).font(ui_font(14.0)).color(TEXT_MUTED))
                    .password(password)
                    .frame(false)
                    .desired_width(f32::INFINITY);
                resp_out = Some(ui.add(edit));
            });
        let resp = resp_out.unwrap();
        if resp.has_focus() {
            ui.painter().rect_stroke(
                resp.rect.expand2(Vec2::new(12.0, 9.0)),
                CornerRadius::same(2),
                Stroke::new(1.5_f32, FOCUS),
                StrokeKind::Inside,
            );
        }
        resp
    }

    fn server_tab_btn(
        ui: &mut Ui,
        size: Vec2,
        label: &str,
        badge: Option<&str>,
        active: bool,
    ) -> egui::Response {
        let (rect, resp) = ui.allocate_exact_size(size, Sense::click());
        let hovered = resp.hovered();
        let painter = ui.painter();
        let fill = if active {
            Color32::from_rgba_unmultiplied(0xff, 0x6a, 0x1f, 38)
        } else if hovered {
            BG_HOVER
        } else {
            BG_SIDEBAR
        };
        let border = if active { ACCENT } else { BORDER };
        let fg = if active || hovered {
            TEXT_HEADER
        } else {
            TEXT_MUTED
        };
        painter.rect(
            rect,
            CornerRadius::same(2),
            fill,
            Stroke::new(1.0_f32, border),
            StrokeKind::Inside,
        );

        if let Some(b) = badge {
            painter.text(
                Pos2::new(rect.min.x + 8.0, rect.center().y),
                Align2::LEFT_CENTER,
                label,
                bold_font(12.0),
                fg,
            );
            let badge_rect = Rect::from_min_max(
                Pos2::new(rect.max.x - 50.0, rect.center().y - 8.0),
                Pos2::new(rect.max.x - 5.0, rect.center().y + 8.0),
            );
            painter.rect_filled(badge_rect, CornerRadius::same(2), ACCENT);
            painter.text(
                badge_rect.center(),
                Align2::CENTER_CENTER,
                b,
                bold_font(9.0),
                ON_ACCENT,
            );
        } else {
            painter.text(
                rect.center(),
                Align2::CENTER_CENTER,
                label,
                bold_font(12.0),
                fg,
            );
        }
        resp
    }

    pub fn primary_wide_btn(ui: &mut Ui, label: &str) -> egui::Response {
        let (rect, resp) =
            ui.allocate_exact_size(Vec2::new(ui.available_width(), 44.0), Sense::click());
        let fill = if resp.hovered() {
            ACCENT_HOVER
        } else {
            ACCENT
        };
        ui.painter()
            .rect_filled(rect, CornerRadius::same(2), fill);
        ui.painter().text(
            rect.center(),
            Align2::CENTER_CENTER,
            label.to_uppercase(),
            display_font(17.0),
            ON_ACCENT,
        );
        resp
    }

    pub fn secondary_wide_btn(ui: &mut Ui, label: &str) -> egui::Response {
        let (rect, resp) =
            ui.allocate_exact_size(Vec2::new(ui.available_width(), 42.0), Sense::click());
        let fill = if resp.hovered() {
            BTN_SECONDARY_HOVER
        } else {
            BTN_SECONDARY
        };
        ui.painter().rect(
            rect,
            CornerRadius::same(2),
            fill,
            Stroke::new(1.0_f32, BORDER),
            StrokeKind::Inside,
        );
        ui.painter().text(
            rect.center(),
            Align2::CENTER_CENTER,
            label.to_uppercase(),
            display_font(15.5),
            TEXT_HEADER,
        );
        resp
    }

    /// The server the user picked on the login screen: the hub or their private node.
    fn picked_server_url(&self) -> &str {
        match self.settings.server_target.as_str() {
            "node" => self.auth_server_url.trim(),
            _ => HUB_URL,
        }
    }

    pub fn submit_auth(&mut self) {
        let raw_url = self.picked_server_url();
        let Some(origin) = normalize_server_url(raw_url) else {
            self.auth_error =
                Some("Invalid server URL. Use https:// or http://localhost.".to_string());
            return;
        };
        let api = crate::api::ApiClient::new(origin.clone(), None);
        let is_reg = self.auth_mode == AuthMode::Register;
        let login_body = json!({
            "login": self.auth_login_input.trim(),
            "password": self.auth_password_input,
        });
        // Credentials go only to the server the user picked.
        let result = if is_reg {
            let mut body = json!({
                "username": self.auth_login_input.trim(),
                "password": self.auth_password_input,
            });
            if !self.auth_email_input.trim().is_empty() {
                body["email"] = Value::String(self.auth_email_input.trim().to_string());
            }
            api.post("/auth/register", body)
        } else {
            api.post("/auth/login", login_body.clone())
        };

        match result {
            Ok(data) => {
                if let Some(token) = data.get("token").and_then(Value::as_str) {
                    self.complete_login(origin, token.to_string());
                } else if data.get("mfa").and_then(Value::as_bool) == Some(true) {
                    self.auth_mfa_ticket = data
                        .get("ticket")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string();
                    self.auth_mode = AuthMode::Mfa;
                    self.auth_error = None;
                } else {
                    self.auth_error = Some("Unexpected login response from server.".to_string());
                }
            }
            Err(err) => {
                self.auth_error = Some(err.to_string());
            }
        }
    }

    pub fn submit_mfa(&mut self) {
        let raw_url = self.picked_server_url();
        let Some(origin) = normalize_server_url(raw_url) else {
            return;
        };
        let api = crate::api::ApiClient::new(origin.clone(), None);
        let code = self.auth_mfa_code.trim();
        let path = if code.len() == 8 {
            "/auth/mfa/backup"
        } else {
            "/auth/mfa/totp"
        };
        match api.post(
            path,
            json!({
                "ticket": self.auth_mfa_ticket,
                "code": code,
            }),
        ) {
            Ok(data) => {
                if let Some(token) = data.get("token").and_then(Value::as_str) {
                    self.complete_login(origin, token.to_string());
                }
            }
            Err(err) => {
                self.auth_error = Some(err.to_string());
            }
        }
    }

    pub fn submit_password_reset(&mut self) {
        let raw_url = self.picked_server_url();
        let Some(origin) = normalize_server_url(raw_url) else {
            return;
        };
        let api = crate::api::ApiClient::new(origin, None);
        if self.auth_reset_token.trim().is_empty() {
            match api.post(
                "/auth/forgot",
                json!({ "login": self.auth_login_input.trim() }),
            ) {
                Ok(_) => {
                    self.status_banner =
                        Some("Password reset instructions sent if account exists.".to_string());
                }
                Err(e) => self.auth_error = Some(e.to_string()),
            }
        } else {
            match api.post(
                "/auth/reset",
                json!({
                    "token": self.auth_reset_token.trim(),
                    "password": self.auth_password_input,
                }),
            ) {
                Ok(_) => {
                    self.auth_mode = AuthMode::Login;
                    self.status_banner =
                        Some("Password updated! You can now log in.".to_string());
                }
                Err(e) => self.auth_error = Some(e.to_string()),
            }
        }
    }
}
