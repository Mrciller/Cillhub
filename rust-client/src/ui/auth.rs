//! Authentication screen matching `client/src/components/Auth.tsx` and `client/src/index.css`:
//! 40px × 40px `.auth-bg` arena grid, notched `.auth-card` HUD polygon with 4px top accent bar,
//! `.auth-brand` badge, `Barlow Condensed` display headings (`READY UP` / `JOIN THE ROSTER`),
//! `.server-choice` selector (Main Hub / Private Node), and styled inputs/buttons.

use crate::i18n::tr;
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
                BG_SIDEBAR(),
                BORDER(),
                12.0,
                Some(ACCENT()),
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
                            ui.painter().rect_filled(mark_rect, 0.0, ACCENT());
                            // letter-spacing .2em like `.auth-brand`
                            let mut job = egui::text::LayoutJob::default();
                            job.append("CILLHUB", 0.0, egui::TextFormat { font_id: display_font(18.0), color: ACCENT(), extra_letter_spacing: 3.6, ..Default::default() });
                            ui.label(job);
                        });

                        ui.add_space(6.0);

                        let (heading, subtitle) = match self.auth_mode {
                            AuthMode::Login => (
                                &tr("Ready up").to_uppercase(),
                                tr("Log in to get back to your team."),
                            ),
                            AuthMode::Register => (
                                &tr("Join the roster").to_uppercase(),
                                tr("Create your account to join your team."),
                            ),
                            AuthMode::Mfa => (
                                &tr("Multi-Factor Authentication").to_uppercase(),
                                tr("Enter the 6-digit code from your authenticator app."),
                            ),
                            AuthMode::ResetPassword => (
                                &tr("Forgot password?").to_uppercase(),
                                tr("Enter the email address of your account. You get a link to choose a new password."),
                            ),
                        };

                        ui.label(
                            RichText::new(heading)
                                .font(display_font(38.0))
                                .color(TEXT_HEADER()),
                        );
                        ui.add_space(2.0);
                        ui.label(
                            RichText::new(subtitle)
                                .font(ui_font(15.0))
                                .color(TEXT_MUTED()),
                        );

                        ui.add_space(18.0);

                        // .server-choice box matching Auth.tsx
                        Frame::new()
                            .fill(BG_PANEL())
                            .stroke(Stroke::new(1.0_f32, BORDER()))
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
                                        &format!("🌐 {}", tr("Main Hub")),
                                        Some(&tr("Default").to_uppercase()),
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
                                        &format!("🔒 {}", tr("Private Node")),
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
                                        RichText::new(tr("Server URL"))
                                            .font(bold_font(12.5))
                                            .color(INTERACTIVE()),
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
                                            tr("Connect directly to a self-hosted Cillhub node."),
                                        )
                                        .font(ui_font(12.0))
                                        .color(TEXT_MUTED()),
                                    );
                                } else {
                                    let host = self
                                        .auth_server_url
                                        .trim_start_matches("https://")
                                        .trim_start_matches("http://");
                                    ui.horizontal(|ui| {
                                        ui.spacing_mut().item_spacing.x = 4.0;
                                        ui.label(
                                            RichText::new(crate::i18n::trf("Connected to {hub}", &[("hub", &host)]))
                                                .font(ui_font(12.0))
                                                .color(TEXT_MUTED()),
                                        );
                                    });
                                }
                            });

                        ui.add_space(14.0);

                        match self.auth_mode {
                            AuthMode::Mfa => {
                                Self::field_label(ui, tr("Authentication code"));
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
                                if Self::primary_wide_btn(ui, tr("Log In")).clicked() {
                                    self.submit_mfa();
                                }
                                ui.add_space(10.0);
                                if ui
                                    .add(
                                        egui::Button::new(
                                            RichText::new(tr("Go back to login"))
                                                .font(ui_font(13.0))
                                                .color(FOCUS()).underline(),
                                        )
                                        .frame(false),
                                    )
                                    .clicked()
                                {
                                    self.auth_mode = AuthMode::Login;
                                }
                            }
                            AuthMode::ResetPassword => {
                                Self::field_label(ui, tr("Email or username"));
                                Self::auth_text_input(
                                    ui,
                                    &mut self.auth_login_input,
                                    "you@example.org",
                                    false,
                                );
                                ui.add_space(10.0);
                                Self::field_label(ui, tr("Reset token (if received)"));
                                Self::auth_text_input(
                                    ui,
                                    &mut self.auth_reset_token,
                                    "paste reset token",
                                    false,
                                );
                                if !self.auth_reset_token.trim().is_empty() {
                                    ui.add_space(10.0);
                                    Self::field_label(ui, tr("New Password"));
                                    Self::auth_text_input(
                                        ui,
                                        &mut self.auth_password_input,
                                        "",
                                        true,
                                    );
                                }
                                ui.add_space(16.0);
                                let btn_txt = if self.auth_reset_token.trim().is_empty() {
                                    tr("Send link")
                                } else {
                                    tr("Change Password")
                                };
                                if Self::primary_wide_btn(ui, btn_txt).clicked() {
                                    self.submit_password_reset();
                                }
                                ui.add_space(10.0);
                                if ui
                                    .add(
                                        egui::Button::new(
                                            RichText::new(tr("Go back to login"))
                                                .font(ui_font(13.0))
                                                .color(FOCUS()).underline(),
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
                                self.load_instance_info(); // registration mode, captcha and the 7.10.3 legal block

                                // register: Email, Username, Password like the web
                                if is_reg {
                                    if registration_closed(self.instance_info.as_ref()) {
                                        ui.add_space(8.0);
                                        ui.label(
                                            RichText::new(tr("Registration is closed on this instance. Ask its admin for an account."))
                                                .font(ui_font(13.0))
                                                .color(YELLOW()),
                                        );
                                    }
                                    if self.instance_info.as_ref().is_some_and(|i| !i["captcha"].is_null()) {
                                        ui.add_space(8.0);
                                        ui.label(
                                            RichText::new(tr("This server asks for a captcha check, which this app cannot show yet. Please register on the website, then log in here."))
                                                .font(ui_font(13.0))
                                                .color(YELLOW()),
                                        );
                                    }
                                    Self::field_label(ui, tr("Email"));
                                    Self::auth_text_input(
                                        ui,
                                        &mut self.auth_email_input,
                                        "",
                                        false,
                                    );
                                    ui.add_space(12.0);
                                }
                                Self::field_label(
                                    ui,
                                    if is_reg {
                                        tr("Username")
                                    } else {
                                        tr("Email or username")
                                    },
                                );
                                Self::auth_text_input(
                                    ui,
                                    &mut self.auth_login_input,
                                    "",
                                    false,
                                );

                                ui.add_space(12.0);
                                Self::field_label(ui, tr("Password"));
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

                                if let Some((ask_terms, min_age)) = signup_checks(self.instance_info.as_ref()).filter(|_| is_reg) {
                                    ui.add_space(12.0);
                                    if ask_terms {
                                        ui.checkbox(&mut self.auth_terms_ok, RichText::new(tr("I accept the terms of use and have read the privacy notice.")).font(ui_font(13.0)).color(TEXT()));
                                        self.legal_links(ui, &["terms", "privacy"]);
                                    }
                                    let age = crate::i18n::trf("I am at least {n} years old.", &[("n", &min_age.to_string())]);
                                    ui.checkbox(&mut self.auth_age_ok, RichText::new(age).font(ui_font(13.0)).color(TEXT()));
                                }

                                if let Some(err) = &self.auth_error {
                                    ui.add_space(10.0);
                                    ui.label(
                                        RichText::new(err)
                                            .font(ui_font(13.0))
                                            .color(DANGER()),
                                    );
                                }

                                ui.add_space(16.0);
                                if Self::primary_wide_btn(
                                    ui,
                                    if is_reg { tr("Continue") } else { tr("Log In") },
                                )
                                .clicked()
                                {
                                    self.submit_auth();
                                }

                                ui.add_space(14.0);
                                ui.horizontal(|ui| {
                                    ui.spacing_mut().item_spacing.x = 4.0;
                                    ui.label(
                                        RichText::new(if is_reg {
                                            tr("Already have an account?")
                                        } else {
                                            tr("Need an account?")
                                        })
                                        .font(ui_font(13.0))
                                        .color(TEXT_MUTED()),
                                    );
                                    if ui
                                        .add(
                                            egui::Button::new(
                                                RichText::new(if is_reg {
                                                    tr("Log In")
                                                } else {
                                                    tr("Register")
                                                })
                                                .font(ui_font(14.0))
                                                .color(FOCUS()).underline(),
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
                                                            RichText::new(tr("Forgot password?"))
                                                                .font(ui_font(13.0))
                                                                .color(FOCUS()).underline(),
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
                                if signup_checks(self.instance_info.as_ref()).is_some() {
                                    ui.add_space(14.0);
                                    self.legal_links(ui, &["imprint", "privacy", "terms", "report-content"]);
                                }
                            }
                        }

                    });
                },
            );
        });
    }

    /// Links to the picked server's own legal pages (7.10.3), opened in the browser.
    fn legal_links(&mut self, ui: &mut Ui, pages: &[&str]) {
        let Some(origin) = normalize_server_url(self.picked_server_url()) else { return };
        ui.horizontal_wrapped(|ui| {
            for page in pages {
                let label = match *page {
                    "imprint" => tr("Imprint"),
                    "privacy" => tr("Privacy notice"),
                    "terms" => tr("Terms of use"),
                    _ => tr("Report illegal content"),
                };
                let link = egui::Button::new(RichText::new(label).font(ui_font(12.5)).color(FOCUS()).underline()).frame(false);
                if ui.add(link).clicked() {
                    super::open_external(&mut self.status_banner, &format!("{origin}/{page}"));
                }
            }
        });
    }

    fn field_label(ui: &mut Ui, label: &str) {
        ui.label(
            RichText::new(label)
                .font(bold_font(13.0))
                .color(INTERACTIVE()),
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
            .fill(BG_RAIL())
            .stroke(Stroke::new(1.0_f32, BORDER()))
            .corner_radius(CornerRadius::same(2))
            .inner_margin(Margin::symmetric(12, 9))
            .show(ui, |ui| {
                ui.set_width(desired.x - 24.0);
                let edit = TextEdit::singleline(value)
                    .font(ui_font(14.5))
                    .text_color(TEXT())
                    .hint_text(RichText::new(hint).font(ui_font(14.0)).color(TEXT_MUTED()))
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
                Stroke::new(1.5_f32, FOCUS()),
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
            BG_HOVER()
        } else {
            BG_SIDEBAR()
        };
        let border = if active { ACCENT() } else { BORDER() };
        let fg = if active || hovered {
            TEXT_HEADER()
        } else {
            TEXT_MUTED()
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
            painter.rect_filled(badge_rect, CornerRadius::same(2), ACCENT());
            painter.text(
                badge_rect.center(),
                Align2::CENTER_CENTER,
                b,
                bold_font(9.0),
                ON_ACCENT(),
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
            ACCENT_HOVER()
        } else {
            ACCENT()
        };
        ui.painter()
            .rect_filled(rect, CornerRadius::same(2), fill);
        ui.painter().text(
            rect.center(),
            Align2::CENTER_CENTER,
            label.to_uppercase(),
            display_font(17.0),
            ON_ACCENT(),
        );
        resp
    }

    pub fn secondary_wide_btn(ui: &mut Ui, label: &str) -> egui::Response {
        let (rect, resp) =
            ui.allocate_exact_size(Vec2::new(ui.available_width(), 42.0), Sense::click());
        let fill = if resp.hovered() {
            BTN_SECONDARY_HOVER()
        } else {
            BTN_SECONDARY()
        };
        ui.painter().rect(
            rect,
            CornerRadius::same(2),
            fill,
            Stroke::new(1.0_f32, BORDER()),
            StrokeKind::Inside,
        );
        ui.painter().text(
            rect.center(),
            Align2::CENTER_CENTER,
            label.to_uppercase(),
            display_font(15.5),
            TEXT_HEADER(),
        );
        resp
    }

    /// Fetches the picked server's public instance info once, like the web client's useInstance().
    fn load_instance_info(&mut self) {
        let url = self.picked_server_url().to_string();
        if self.instance_for == url {
            return;
        }
        self.instance_for = url.clone();
        self.instance_info = None;
        let Some(origin) = normalize_server_url(&url) else { return };
        self.spawn_bg(false, move || crate::api::ApiClient::new(origin, None).get("/instance").ok(), move |app, info| {
            if app.instance_for == url {
                app.instance_info = info;
            }
        });
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
            // The hub requires an email to register (server/src/routes/auth.js emailField).
            let email = self.auth_email_input.trim();
            if email.is_empty() {
                self.auth_error = Some(tr("Email is required.").to_string());
                return;
            }
            body["email"] = Value::String(email.to_string());
            // 7.10.3 servers: the boxes must be ticked; older servers send no legal block and get no fields
            if let Some((ask_terms, _)) = signup_checks(self.instance_info.as_ref()) {
                if !self.auth_age_ok || (ask_terms && !self.auth_terms_ok) {
                    self.auth_error = Some(tr("Tick the boxes above to create an account.").to_string());
                    return;
                }
                body["age_confirmed"] = Value::Bool(true);
                body["terms_accepted"] = Value::Bool(true);
            }
            ("/auth/register", body)
        } else {
            ("/auth/login", login_body)
        };
        self.spawn_bg(true, move || api.post(result.0, result.1), move |app, result| match result {
            Ok(data) => {
                if let Some(token) = data.get("token").and_then(Value::as_str) {
                    app.complete_login(origin, token.to_string());
                } else if data.get("mfa").and_then(Value::as_bool) == Some(true) {
                    app.auth_mfa_ticket = data.get("ticket").and_then(Value::as_str).unwrap_or("").to_string();
                    app.auth_password_input.clear(); // the ticket replaces it
                    app.auth_mode = AuthMode::Mfa;
                    app.auth_error = None;
                } else {
                    app.auth_error = Some("Unexpected login response from server.".to_string());
                }
            }
            Err(err) => app.auth_error = Some(err.to_string()),
        });
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
        let body = json!({ "ticket": self.auth_mfa_ticket, "code": code });
        self.spawn_bg(true, move || api.post(path, body), move |app, r| match r {
            Ok(data) => {
                if let Some(token) = data.get("token").and_then(Value::as_str) {
                    app.complete_login(origin, token.to_string());
                }
            }
            Err(err) => app.auth_error = Some(err.to_string()),
        });
    }

    pub fn submit_password_reset(&mut self) {
        let raw_url = self.picked_server_url();
        let Some(origin) = normalize_server_url(raw_url) else {
            return;
        };
        let api = crate::api::ApiClient::new(origin, None);
        if self.auth_reset_token.trim().is_empty() {
            let body = json!({ "login": self.auth_login_input.trim() });
            self.spawn_bg(true, move || api.post("/auth/forgot", body), |app, r| match r {
                Ok(_) => {
                    app.status_banner =
                        Some(tr("If an account with this address exists, a mail with a link is on its way.").to_string());
                }
                Err(e) => app.auth_error = Some(e.to_string()),
            });
        } else {
            let body = json!({ "token": self.auth_reset_token.trim(), "password": self.auth_password_input });
            self.spawn_bg(true, move || api.post("/auth/reset", body), |app, r| match r {
                Ok(_) => {
                    app.auth_reset_token.clear();
                    app.auth_password_input.clear();
                    app.auth_mode = AuthMode::Login;
                    app.status_banner = Some(tr("Password updated! You can now log in.").to_string());
                }
                Err(e) => app.auth_error = Some(e.to_string()),
            });
        }
    }
}

/// The web client shows the "registration is closed" notice for registration_mode "closed".
pub fn registration_closed(instance: Option<&Value>) -> bool {
    instance.and_then(|i| i.get("registration_mode")).and_then(Value::as_str) == Some("closed")
}

/// The 7.10.3 sign-up checks from the instance's `legal` block: (ask for the terms, minimum age).
/// None for a server from before 7.10.3 (no block): no checkboxes, no fields.
pub fn signup_checks(instance: Option<&Value>) -> Option<(bool, u64)> {
    let legal = instance?.get("legal")?.as_object()?;
    let ask_terms = legal.get("accept_version").is_some_and(|v| !v.is_null());
    Some((ask_terms, legal.get("min_age").and_then(Value::as_u64).unwrap_or(14)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signup_checks_follow_the_legal_block() {
        assert_eq!(signup_checks(Some(&json!({"registration_mode": "open"}))), None, "old server");
        assert_eq!(signup_checks(None), None);
        assert_eq!(signup_checks(Some(&json!({"legal": {"accept_version": null, "min_age": 16}}))), Some((false, 16)));
        assert_eq!(signup_checks(Some(&json!({"legal": {"accept_version": 3, "min_age": 14}}))), Some((true, 14)));
    }

    #[test]
    fn closed_registration_is_read_from_instance_info() {
        assert!(registration_closed(Some(&json!({"registration_mode": "closed"}))));
        assert!(!registration_closed(Some(&json!({"registration_mode": "open"}))));
        assert!(!registration_closed(None));
    }
}
