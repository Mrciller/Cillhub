//! Cillhub Arena & Argon visual theme, bundled web fonts, notched HUD card renderer,
//! status dot shapes, and crisp vector icons matching `client/src/index.css` & `client/src/components/ui.tsx`.

#[cfg(feature = "native-gui")]
use egui::{
    Align2, Color32, Context, CornerRadius, FontData, FontDefinitions, FontFamily, FontId,
    Painter, Pos2, Rect, Response, Sense, Shape, Stroke, StrokeKind, Ui, Vec2, Visuals,
};

#[cfg(feature = "native-gui")]
pub mod palette {
    use egui::Color32;

    // Exact CSS custom properties from `client/src/index.css`
    pub const BG_RAIL: Color32 = Color32::from_rgb(0x0b, 0x0c, 0x0f); // --rail: #0b0c0f
    pub const BG_SIDEBAR: Color32 = Color32::from_rgb(0x12, 0x14, 0x18); // --sidebar: #121418
    pub const BG_CHAT: Color32 = Color32::from_rgb(0x17, 0x19, 0x1e); // --chat: #17191e
    pub const BG_PANEL: Color32 = Color32::from_rgb(0x0e, 0x0f, 0x12); // --panel: #0e0f12
    pub const BG_INPUT: Color32 = Color32::from_rgb(0x1f, 0x22, 0x28); // --input: #1f2228
    pub const BG_HOVER: Color32 = Color32::from_rgb(0x20, 0x23, 0x29); // --hover: #202329
    pub const BG_SELECTED: Color32 = Color32::from_rgb(0x2a, 0x2e, 0x36); // --selected: #2a2e36
    pub const BG_CARD: Color32 = Color32::from_rgb(0x1a, 0x1d, 0x23); // --card: #1a1d23
    pub const BG_MENU: Color32 = Color32::from_rgb(0x15, 0x17, 0x1c); // --menu: #15171c
    pub const BG_FLOATING: Color32 = Color32::from_rgb(0x15, 0x17, 0x1c); // --menu: #15171c
    pub const BTN_SECONDARY: Color32 = Color32::from_rgb(0x2b, 0x2f, 0x38); // --btn-secondary: #2b2f38
    pub const BTN_SECONDARY_HOVER: Color32 = Color32::from_rgb(0x36, 0x3b, 0x46); // --btn-secondary-hover: #363b46
    pub const BORDER: Color32 = Color32::from_rgb(0x2c, 0x30, 0x38); // --border: #2c3038
    pub const BORDER_SUBTLE: Color32 = Color32::from_rgb(0x22, 0x26, 0x2e); // subtle border
    pub const TEXT: Color32 = Color32::from_rgb(0xe3, 0xe6, 0xec); // --text: #e3e6ec
    pub const TEXT_HEADER: Color32 = Color32::from_rgb(0xf7, 0xf8, 0xfa); // --header: #f7f8fa
    pub const TEXT_MUTED: Color32 = Color32::from_rgb(0x9a, 0xa1, 0xad); // --muted: #9aa1ad
    pub const INTERACTIVE: Color32 = Color32::from_rgb(0xc0, 0xc6, 0xd0); // --interactive: #c0c6d0
    pub const ACCENT: Color32 = Color32::from_rgb(0xff, 0x6a, 0x1f); // --accent: #ff6a1f
    pub const ACCENT_HOVER: Color32 = Color32::from_rgb(0xff, 0x87, 0x47); // --accent-hover: #ff8747
    pub const ON_ACCENT: Color32 = Color32::from_rgb(0x17, 0x09, 0x00); // --on-accent: #170900
    pub const ACCENT_SOFT: Color32 = Color32::from_rgb(0x3a, 0x20, 0x14);
    pub const ARGON_ACCENT: Color32 = Color32::from_rgb(0x00, 0xd2, 0xeb); // #00d2eb
    pub const GREEN: Color32 = Color32::from_rgb(0x2f, 0xd3, 0x6a); // --online: #2fd36a
    pub const YELLOW: Color32 = Color32::from_rgb(0xff, 0xb0, 0x20); // --idle: #ffb020
    pub const DANGER: Color32 = Color32::from_rgb(0xff, 0x4d, 0x4d); // --danger: #ff4d4d
    pub const DANGER_STRONG: Color32 = Color32::from_rgb(0xc8, 0x22, 0x2c); // --danger-strong: #c8222c
    pub const SIGNAL_STRONG: Color32 = Color32::from_rgb(0xe1, 0x1d, 0x3c); // --signal-strong: #e11d3c
    pub const OFFLINE: Color32 = Color32::from_rgb(0x7d, 0x85, 0x91); // --offline: #7d8591
    pub const FOCUS: Color32 = Color32::from_rgb(0x7c, 0xc4, 0xff); // --focus: #7cc4ff
    pub const LEAGUE_TEAL: Color32 = Color32::from_rgb(0x0a, 0xc8, 0xb9); // #0ac8b9
    pub const LEAGUE_BG: Color32 = Color32::from_rgb(0x0d, 0x22, 0x26);
    pub const MENTION_BG: Color32 = Color32::from_rgb(0x33, 0x22, 0x18);
}

#[cfg(feature = "native-gui")]
pub fn install_fonts(ctx: &Context, dyslexic: bool) {
    let mut fonts = FontDefinitions::default();

    fonts.font_data.insert(
        "inter".to_owned(),
        FontData::from_static(include_bytes!("../assets/fonts/Inter-Regular.ttf")).into(),
    );
    fonts.font_data.insert(
        "inter-bold".to_owned(),
        FontData::from_static(include_bytes!("../assets/fonts/Inter-Bold.ttf")).into(),
    );
    fonts.font_data.insert(
        "barlow".to_owned(),
        FontData::from_static(include_bytes!("../assets/fonts/BarlowCondensed-Bold.ttf")).into(),
    );
    fonts.font_data.insert(
        "orbitron".to_owned(),
        FontData::from_static(include_bytes!("../assets/fonts/Orbitron-Bold.ttf")).into(),
    );
    fonts.font_data.insert(
        "jetbrains".to_owned(),
        FontData::from_static(include_bytes!("../assets/fonts/JetBrainsMono-Regular.ttf")).into(),
    );
    fonts.font_data.insert(
        "opendyslexic".to_owned(),
        FontData::from_static(include_bytes!(
            "../assets/fonts/opendyslexic-latin-400-normal.ttf"
        ))
        .into(),
    );

    let primary = if dyslexic { "opendyslexic" } else { "inter" };
    fonts
        .families
        .entry(FontFamily::Proportional)
        .or_default()
        .insert(0, primary.to_owned());
    fonts
        .families
        .entry(FontFamily::Monospace)
        .or_default()
        .insert(0, "jetbrains".to_owned());

    let mut display_chain = vec!["barlow".to_owned(), "inter-bold".to_owned(), primary.to_owned()];
    if let Some(default_prop) = fonts.families.get(&FontFamily::Proportional).cloned() {
        for f in default_prop {
            if !display_chain.contains(&f) {
                display_chain.push(f);
            }
        }
    }
    fonts
        .families
        .insert(FontFamily::Name("display".into()), display_chain);

    let mut bold_chain = vec!["inter-bold".to_owned(), primary.to_owned()];
    if let Some(default_prop) = fonts.families.get(&FontFamily::Proportional).cloned() {
        for f in default_prop {
            if !bold_chain.contains(&f) {
                bold_chain.push(f);
            }
        }
    }
    fonts
        .families
        .insert(FontFamily::Name("bold".into()), bold_chain);

    ctx.set_fonts(fonts);
}

#[cfg(feature = "native-gui")]
static CUSTOM_FAMILIES_READY: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

#[cfg(feature = "native-gui")]
pub fn set_custom_families_ready(ready: bool) {
    CUSTOM_FAMILIES_READY.store(ready, std::sync::atomic::Ordering::Relaxed);
}

#[cfg(feature = "native-gui")]
pub fn display_font(size: f32) -> FontId {
    if CUSTOM_FAMILIES_READY.load(std::sync::atomic::Ordering::Relaxed) {
        FontId::new(size, FontFamily::Name("display".into()))
    } else {
        FontId::new(size, FontFamily::Proportional)
    }
}

#[cfg(feature = "native-gui")]
pub fn bold_font(size: f32) -> FontId {
    if CUSTOM_FAMILIES_READY.load(std::sync::atomic::Ordering::Relaxed) {
        FontId::new(size, FontFamily::Name("bold".into()))
    } else {
        FontId::new(size, FontFamily::Proportional)
    }
}

#[cfg(feature = "native-gui")]
pub fn ui_font(size: f32) -> FontId {
    FontId::new(size, FontFamily::Proportional)
}

#[cfg(feature = "native-gui")]
pub fn mono_font(size: f32) -> FontId {
    FontId::new(size, FontFamily::Monospace)
}

#[cfg(feature = "native-gui")]
pub fn apply_theme(ctx: &Context, theme_name: &str, font_scale: f32) {
    use palette::*;
    let is_light = theme_name == "light";
    let mut visuals = if is_light {
        Visuals::light()
    } else {
        Visuals::dark()
    };

    if !is_light {
        let (chat_bg, sidebar_bg, input_bg, accent) = match theme_name {
            "argon" => (
                Color32::from_rgb(0x14, 0x1a, 0x26),
                Color32::from_rgb(0x0f, 0x14, 0x1e),
                Color32::from_rgb(0x1b, 0x23, 0x33),
                ARGON_ACCENT,
            ),
            "midnight" => (
                Color32::from_rgb(0x0c, 0x0d, 0x10),
                BG_SIDEBAR,
                BG_INPUT,
                ACCENT,
            ),
            "nord" => (
                Color32::from_rgb(0x2e, 0x34, 0x40),
                Color32::from_rgb(0x24, 0x29, 0x33),
                Color32::from_rgb(0x3b, 0x42, 0x52),
                Color32::from_rgb(0x88, 0xc0, 0xd0),
            ),
            "high-contrast" => (Color32::BLACK, Color32::BLACK, BG_INPUT, ACCENT),
            _ => (BG_CHAT, BG_SIDEBAR, BG_INPUT, ACCENT),
        };
        visuals.panel_fill = chat_bg;
        visuals.window_fill = BG_FLOATING;
        visuals.faint_bg_color = sidebar_bg;
        visuals.extreme_bg_color = input_bg;
        visuals.code_bg_color = BG_RAIL;
        visuals.override_text_color = Some(TEXT);
        visuals.hyperlink_color = FOCUS;
        visuals.warn_fg_color = YELLOW;
        visuals.error_fg_color = DANGER;
        visuals.window_stroke = Stroke::new(1.0_f32, BORDER);
        visuals.window_corner_radius = CornerRadius::same(4);

        visuals.widgets.noninteractive.bg_fill = sidebar_bg;
        visuals.widgets.noninteractive.weak_bg_fill = sidebar_bg;
        visuals.widgets.noninteractive.bg_stroke = Stroke::new(1.0_f32, BORDER);
        visuals.widgets.noninteractive.fg_stroke = Stroke::new(1.0_f32, TEXT);
        visuals.widgets.noninteractive.corner_radius = CornerRadius::same(3);

        visuals.widgets.inactive.bg_fill = input_bg;
        visuals.widgets.inactive.weak_bg_fill = input_bg;
        visuals.widgets.inactive.bg_stroke = Stroke::new(1.0_f32, BORDER);
        visuals.widgets.inactive.fg_stroke = Stroke::new(1.0_f32, TEXT);
        visuals.widgets.inactive.corner_radius = CornerRadius::same(3);

        visuals.widgets.hovered.bg_fill = BG_HOVER;
        visuals.widgets.hovered.weak_bg_fill = BG_HOVER;
        visuals.widgets.hovered.bg_stroke = Stroke::new(1.0_f32, accent);
        visuals.widgets.hovered.fg_stroke = Stroke::new(1.0_f32, TEXT_HEADER);
        visuals.widgets.hovered.corner_radius = CornerRadius::same(3);

        visuals.widgets.active.bg_fill = BG_SELECTED;
        visuals.widgets.active.weak_bg_fill = BG_SELECTED;
        visuals.widgets.active.bg_stroke = Stroke::new(1.0_f32, accent);
        visuals.widgets.active.fg_stroke = Stroke::new(1.0_f32, TEXT_HEADER);
        visuals.widgets.active.corner_radius = CornerRadius::same(3);

        visuals.selection.bg_fill = ACCENT_SOFT;
        visuals.selection.stroke = Stroke::new(1.0_f32, accent);
    }

    ctx.set_visuals(visuals);
    ctx.set_pixels_per_point(font_scale.clamp(0.8, 1.5));
}

#[cfg(feature = "native-gui")]
pub fn status_color(status: &str) -> Color32 {
    use palette::*;
    match status {
        "online" => GREEN,
        "idle" => YELLOW,
        "dnd" => DANGER,
        _ => OFFLINE,
    }
}

/// Deterministic avatar background color matching `COLORS` in `client/src/components/ui.tsx`.
#[cfg(feature = "native-gui")]
pub fn avatar_color(id: &str) -> Color32 {
    const COLORS: [Color32; 6] = [
        Color32::from_rgb(0x0b, 0x6e, 0x85), // #0b6e85
        Color32::from_rgb(0x3d, 0x4a, 0x6b), // #3d4a6b
        Color32::from_rgb(0x15, 0x7f, 0x49), // #157f49
        Color32::from_rgb(0x8a, 0x5a, 0x00), // #8a5a00
        Color32::from_rgb(0xb8, 0x1c, 0x55), // #b81c55
        Color32::from_rgb(0x6b, 0x3f, 0xd1), // #6b3fd1
    ];
    let sum: usize = id.bytes().map(|b| b as usize).sum();
    COLORS[sum % COLORS.len()]
}

/// Extracts up to `max` initials from a display name or guild name, matching `initials()` in `ui.tsx`.
pub fn initials(name: &str, max: usize) -> String {
    let out: String = name
        .trim()
        .split_whitespace()
        .filter_map(|w| w.chars().next())
        .take(max)
        .collect();
    if out.is_empty() {
        name.chars().take(max).collect()
    } else {
        out.to_uppercase()
    }
}

/// Draws the 40px × 40px `.auth-bg` arena floor grid from `client/src/index.css`.
#[cfg(feature = "native-gui")]
pub fn draw_auth_grid(painter: &Painter, rect: Rect) {
    use palette::*;
    painter.rect_filled(rect, 0.0, BG_RAIL);
    let grid_color = Color32::from_rgba_unmultiplied(0x2c, 0x30, 0x38, 115);
    let step = 40.0_f32;
    let mut x = (rect.min.x / step).floor() * step;
    while x <= rect.max.x {
        painter.vline(x, rect.y_range(), Stroke::new(1.0_f32, grid_color));
        x += step;
    }
    let mut y = (rect.min.y / step).floor() * step;
    while y <= rect.max.y {
        painter.hline(rect.x_range(), y, Stroke::new(1.0_f32, grid_color));
        y += step;
    }
}

/// Builds the shapes for a notched HUD card polygon with optional 4px top or left accent bar.
#[cfg(feature = "native-gui")]
pub fn notched_card_shapes(
    rect: Rect,
    fill: Color32,
    border: Color32,
    notch: f32,
    top_accent: Option<Color32>,
    left_accent: Option<Color32>,
) -> Vec<Shape> {
    let n = notch.min(rect.width() * 0.25).min(rect.height() * 0.25);
    let pts = vec![
        Pos2::new(rect.min.x + n, rect.min.y),
        Pos2::new(rect.max.x, rect.min.y),
        Pos2::new(rect.max.x, rect.max.y - n),
        Pos2::new(rect.max.x - n, rect.max.y),
        Pos2::new(rect.min.x, rect.max.y),
        Pos2::new(rect.min.x, rect.min.y + n),
    ];
    let mut shapes = vec![Shape::convex_polygon(
        pts,
        fill,
        Stroke::new(1.0_f32, border),
    )];

    if let Some(accent) = top_accent {
        let bar_h = 4.0_f32;
        let top_pts = vec![
            Pos2::new(rect.min.x + n, rect.min.y),
            Pos2::new(rect.max.x, rect.min.y),
            Pos2::new(rect.max.x, rect.min.y + bar_h),
            Pos2::new(rect.min.x + (n - bar_h).max(0.0), rect.min.y + bar_h),
        ];
        shapes.push(Shape::convex_polygon(top_pts, accent, Stroke::NONE));
    }

    if let Some(accent) = left_accent {
        let bar_w = 4.0_f32;
        let left_pts = vec![
            Pos2::new(rect.min.x, rect.min.y + n),
            Pos2::new(rect.min.x + bar_w, rect.min.y + (n - bar_w).max(0.0)),
            Pos2::new(rect.min.x + bar_w, rect.max.y),
            Pos2::new(rect.min.x, rect.max.y),
        ];
        shapes.push(Shape::convex_polygon(left_pts, accent, Stroke::NONE));
    }
    shapes
}

/// Draws a notched HUD card (`clip-path: polygon(notch 0, 100% 0, 100% calc(100% - notch), calc(100% - notch) 100%, 0 100%, 0 notch)`)
/// with optional 4px top or left accent bar, matching `.auth-card`, `.channel-start`, and `.modal` in `client/src/index.css`.
#[cfg(feature = "native-gui")]
pub fn draw_notched_card(
    painter: &Painter,
    rect: Rect,
    fill: Color32,
    border: Color32,
    notch: f32,
    top_accent: Option<Color32>,
    left_accent: Option<Color32>,
) {
    for s in notched_card_shapes(rect, fill, border, notch, top_accent, left_accent) {
        painter.add(s);
    }
}

/// Renders a container whose background is a notched HUD polygon painted behind `add_contents`.
#[cfg(feature = "native-gui")]
pub fn show_notched_card<R>(
    ui: &mut Ui,
    fill: Color32,
    border: Color32,
    notch: f32,
    top_accent: Option<Color32>,
    left_accent: Option<Color32>,
    margin: egui::Margin,
    add_contents: impl FnOnce(&mut Ui) -> R,
) -> egui::InnerResponse<R> {
    let bg_idx = ui.painter().add(Shape::Noop);
    let inner = egui::Frame::new().inner_margin(margin).show(ui, add_contents);
    let shapes = notched_card_shapes(
        inner.response.rect,
        fill,
        border,
        notch,
        top_accent,
        left_accent,
    );
    ui.painter().set(bg_idx, Shape::Vec(shapes));
    inner
}

/// Draws the exact status dot shapes from `client/src/index.css` lines 339-350:
/// - `online`: solid green circle
/// - `idle`: amber crescent
/// - `dnd`: red circle with inner horizontal bar
/// - `offline` / `invisible`: grey ring
#[cfg(feature = "native-gui")]
pub fn draw_status_dot(
    painter: &Painter,
    center: Pos2,
    radius: f32,
    status: &str,
    dot_bg: Color32,
) {
    painter.circle_filled(center, radius + 2.2, dot_bg);
    let color = status_color(status);
    painter.circle_filled(center, radius, color);
    match status {
        "idle" => {
            painter.circle_filled(
                Pos2::new(center.x - radius * 0.32, center.y - radius * 0.32),
                radius * 0.58,
                dot_bg,
            );
        }
        "dnd" => {
            let bar = Rect::from_center_size(center, Vec2::new(radius * 1.35, radius * 0.45));
            painter.rect_filled(bar, 1.0, dot_bg);
        }
        "offline" | "invisible" => {
            painter.circle_filled(center, radius * 0.46, dot_bg);
        }
        _ => {}
    }
}

/// Draws a circular user avatar with deterministic hue, bold white initials, and optional status indicator.
#[cfg(feature = "native-gui")]
pub fn draw_avatar(
    ui: &mut Ui,
    size: f32,
    user_id: &str,
    name: &str,
    status: Option<&str>,
    dot_bg: Color32,
) -> Response {
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(size), Sense::click());
    let painter = ui.painter();
    let center = rect.center();
    let radius = size * 0.5;
    painter.circle_filled(center, radius, avatar_color(user_id));
    painter.circle_stroke(
        center,
        radius,
        Stroke::new(1.0_f32, Color32::from_white_alpha(20)),
    );
    let init = initials(name, 2);
    painter.text(
        center,
        Align2::CENTER_CENTER,
        init,
        bold_font((size * 0.40).max(10.0)),
        Color32::WHITE,
    );
    if let Some(st) = status {
        let dot_r = (size * 0.17).clamp(4.5, 6.5);
        let dot_pos = Pos2::new(rect.max.x - dot_r * 0.35, rect.max.y - dot_r * 0.35);
        draw_status_dot(painter, dot_pos, dot_r, st, dot_bg);
    }
    resp
}

/// Draws a `.list-heading` section label (`12px` uppercase Display font + trailing 1px horizontal hairline rule).
#[cfg(feature = "native-gui")]
pub fn draw_list_heading(ui: &mut Ui, label: &str) {
    use palette::*;
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 8.0;
        ui.label(
            egui::RichText::new(label.to_uppercase())
                .font(display_font(13.0))
                .color(TEXT_MUTED),
        );
        let avail = ui.available_width();
        if avail > 6.0 {
            let (line_rect, _) = ui.allocate_exact_size(Vec2::new(avail, 14.0), Sense::hover());
            ui.painter().hline(
                line_rect.x_range(),
                line_rect.center().y,
                Stroke::new(1.0_f32, Color32::from_rgba_unmultiplied(0x2c, 0x30, 0x38, 190)),
            );
        }
    });
}

#[cfg(feature = "native-gui")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconKind {
    Home,
    Plus,
    Compass,
    ChevronDown,
    ChevronRight,
    People,
    Hash,
    Speaker,
    Stage,
    Forum,
    Mic,
    MicOff,
    Headset,
    HeadsetOff,
    Gear,
    Thread,
    Pin,
    Canvas,
    Grid,
    Search,
    Inbox,
    Phone,
    ChatBubble,
    Check,
    Close,
    Reply,
    Smile,
    Send,
    Poll,
    Clock,
    Gamepad,
    Lock,
    Globe,
    Edit,
}

/// Renders crisp vector icons matching `ICONS` in `client/src/components/ui.tsx`.
#[cfg(feature = "native-gui")]
pub fn draw_icon(painter: &Painter, rect: Rect, kind: IconKind, color: Color32) {
    let c = rect.center();
    let r = rect.width().min(rect.height()) * 0.42;
    let stroke = Stroke::new(1.75_f32, color);
    let thin = Stroke::new(1.4_f32, color);

    match kind {
        IconKind::Home => {
            // Speech-bubble home icon from `ICONS.home`
            let body = Rect::from_center_size(Pos2::new(c.x, c.y - r * 0.1), Vec2::new(r * 1.7, r * 1.3));
            painter.rect_stroke(body, 2.5, stroke, StrokeKind::Inside);
            let tail = vec![
                Pos2::new(body.min.x + r * 0.3, body.max.y),
                Pos2::new(body.min.x + r * 0.15, body.max.y + r * 0.42),
                Pos2::new(body.min.x + r * 0.75, body.max.y),
            ];
            painter.add(Shape::line(tail, stroke));
        }
        IconKind::Plus => {
            painter.line_segment([Pos2::new(c.x - r * 0.75, c.y), Pos2::new(c.x + r * 0.75, c.y)], stroke);
            painter.line_segment([Pos2::new(c.x, c.y - r * 0.75), Pos2::new(c.x, c.y + r * 0.75)], stroke);
        }
        IconKind::Compass => {
            painter.circle_stroke(c, r * 0.9, stroke);
            let diamond = vec![
                Pos2::new(c.x + r * 0.45, c.y - r * 0.45),
                Pos2::new(c.x + r * 0.15, c.y + r * 0.15),
                Pos2::new(c.x - r * 0.45, c.y + r * 0.45),
                Pos2::new(c.x - r * 0.15, c.y - r * 0.15),
                Pos2::new(c.x + r * 0.45, c.y - r * 0.45),
            ];
            painter.add(Shape::line(diamond, thin));
        }
        IconKind::ChevronDown => {
            painter.add(Shape::line(
                vec![
                    Pos2::new(c.x - r * 0.55, c.y - r * 0.22),
                    Pos2::new(c.x, c.y + r * 0.32),
                    Pos2::new(c.x + r * 0.55, c.y - r * 0.22),
                ],
                stroke,
            ));
        }
        IconKind::ChevronRight => {
            painter.add(Shape::line(
                vec![
                    Pos2::new(c.x - r * 0.25, c.y - r * 0.5),
                    Pos2::new(c.x + r * 0.3, c.y),
                    Pos2::new(c.x - r * 0.25, c.y + r * 0.5),
                ],
                stroke,
            ));
        }
        IconKind::People => {
            painter.circle_stroke(Pos2::new(c.x - r * 0.25, c.y - r * 0.32), r * 0.34, stroke);
            painter.add(Shape::line(
                vec![
                    Pos2::new(c.x - r * 0.85, c.y + r * 0.7),
                    Pos2::new(c.x - r * 0.65, c.y + r * 0.22),
                    Pos2::new(c.x + r * 0.15, c.y + r * 0.22),
                    Pos2::new(c.x + r * 0.35, c.y + r * 0.7),
                ],
                stroke,
            ));
            painter.circle_stroke(Pos2::new(c.x + r * 0.42, c.y - r * 0.28), r * 0.26, thin);
        }
        IconKind::Hash => {
            let d = r * 0.34;
            let h = r * 0.78;
            painter.line_segment([Pos2::new(c.x - d + 1.5, c.y - h), Pos2::new(c.x - d - 1.5, c.y + h)], stroke);
            painter.line_segment([Pos2::new(c.x + d + 1.5, c.y - h), Pos2::new(c.x + d - 1.5, c.y + h)], stroke);
            painter.line_segment([Pos2::new(c.x - h, c.y - d), Pos2::new(c.x + h, c.y - d)], stroke);
            painter.line_segment([Pos2::new(c.x - h, c.y + d), Pos2::new(c.x + h, c.y + d)], stroke);
        }
        IconKind::Speaker => {
            let pts = vec![
                Pos2::new(c.x - r * 0.75, c.y - r * 0.28),
                Pos2::new(c.x - r * 0.35, c.y - r * 0.28),
                Pos2::new(c.x + r * 0.15, c.y - r * 0.72),
                Pos2::new(c.x + r * 0.15, c.y + r * 0.72),
                Pos2::new(c.x - r * 0.35, c.y + r * 0.28),
                Pos2::new(c.x - r * 0.75, c.y + r * 0.28),
            ];
            painter.add(Shape::convex_polygon(pts, color, Stroke::NONE));
            painter.line_segment(
                [Pos2::new(c.x + r * 0.45, c.y - r * 0.38), Pos2::new(c.x + r * 0.65, c.y)],
                thin,
            );
            painter.line_segment(
                [Pos2::new(c.x + r * 0.65, c.y), Pos2::new(c.x + r * 0.45, c.y + r * 0.38)],
                thin,
            );
        }
        IconKind::Stage => {
            painter.circle_filled(c, r * 0.25, color);
            painter.circle_stroke(c, r * 0.58, thin);
            painter.circle_stroke(c, r * 0.88, thin);
        }
        IconKind::Forum => {
            let b1 = Rect::from_center_size(Pos2::new(c.x - r * 0.15, c.y - r * 0.15), Vec2::new(r * 1.3, r * 0.95));
            painter.rect_stroke(b1, 2.0, stroke, StrokeKind::Inside);
            let b2 = Rect::from_center_size(Pos2::new(c.x + r * 0.22, c.y + r * 0.25), Vec2::new(r * 1.1, r * 0.8));
            painter.rect_stroke(b2, 2.0, thin, StrokeKind::Inside);
        }
        IconKind::Mic | IconKind::MicOff => {
            let cap = Rect::from_center_size(Pos2::new(c.x, c.y - r * 0.22), Vec2::new(r * 0.68, r * 1.05));
            painter.rect_stroke(cap, r * 0.34, stroke, StrokeKind::Inside);
            painter.add(Shape::line(
                vec![
                    Pos2::new(c.x - r * 0.62, c.y),
                    Pos2::new(c.x - r * 0.45, c.y + r * 0.52),
                    Pos2::new(c.x + r * 0.45, c.y + r * 0.52),
                    Pos2::new(c.x + r * 0.62, c.y),
                ],
                stroke,
            ));
            painter.line_segment([Pos2::new(c.x, c.y + r * 0.52), Pos2::new(c.x, c.y + r * 0.88)], stroke);
            if kind == IconKind::MicOff {
                painter.line_segment(
                    [Pos2::new(c.x - r * 0.8, c.y - r * 0.8), Pos2::new(c.x + r * 0.8, c.y + r * 0.8)],
                    Stroke::new(2.0_f32, color),
                );
            }
        }
        IconKind::Headset | IconKind::HeadsetOff => {
            painter.add(Shape::line(
                vec![
                    Pos2::new(c.x - r * 0.75, c.y + r * 0.2),
                    Pos2::new(c.x - r * 0.75, c.y - r * 0.35),
                    Pos2::new(c.x - r * 0.35, c.y - r * 0.78),
                    Pos2::new(c.x + r * 0.35, c.y - r * 0.78),
                    Pos2::new(c.x + r * 0.75, c.y - r * 0.35),
                    Pos2::new(c.x + r * 0.75, c.y + r * 0.2),
                ],
                stroke,
            ));
            let left_ear = Rect::from_center_size(Pos2::new(c.x - r * 0.62, c.y + r * 0.38), Vec2::new(r * 0.36, r * 0.62));
            let right_ear = Rect::from_center_size(Pos2::new(c.x + r * 0.62, c.y + r * 0.38), Vec2::new(r * 0.36, r * 0.62));
            painter.rect_filled(left_ear, 2.0, color);
            painter.rect_filled(right_ear, 2.0, color);
            if kind == IconKind::HeadsetOff {
                painter.line_segment(
                    [Pos2::new(c.x - r * 0.8, c.y - r * 0.8), Pos2::new(c.x + r * 0.8, c.y + r * 0.8)],
                    Stroke::new(2.0_f32, color),
                );
            }
        }
        IconKind::Gear => {
            painter.circle_stroke(c, r * 0.42, stroke);
            for i in 0..8 {
                let a = (i as f32) * std::f32::consts::FRAC_PI_4;
                let p1 = Pos2::new(c.x + a.cos() * r * 0.52, c.y + a.sin() * r * 0.52);
                let p2 = Pos2::new(c.x + a.cos() * r * 0.88, c.y + a.sin() * r * 0.88);
                painter.line_segment([p1, p2], stroke);
            }
        }
        IconKind::Thread | IconKind::ChatBubble => {
            let box_r = Rect::from_center_size(Pos2::new(c.x, c.y - r * 0.08), Vec2::new(r * 1.65, r * 1.25));
            painter.rect_stroke(box_r, 2.5, stroke, StrokeKind::Inside);
            if kind == IconKind::Thread {
                painter.line_segment([Pos2::new(c.x - r * 0.45, c.y - r * 0.25), Pos2::new(c.x + r * 0.45, c.y - r * 0.25)], thin);
                painter.line_segment([Pos2::new(c.x - r * 0.45, c.y + r * 0.12), Pos2::new(c.x + r * 0.25, c.y + r * 0.12)], thin);
            }
        }
        IconKind::Pin => {
            painter.line_segment([Pos2::new(c.x - r * 0.45, c.y - r * 0.72), Pos2::new(c.x + r * 0.45, c.y - r * 0.72)], stroke);
            let body = Rect::from_center_size(Pos2::new(c.x, c.y - r * 0.25), Vec2::new(r * 0.65, r * 0.8));
            painter.rect_stroke(body, 1.0, stroke, StrokeKind::Inside);
            painter.line_segment([Pos2::new(c.x - r * 0.6, c.y + r * 0.15), Pos2::new(c.x + r * 0.6, c.y + r * 0.15)], stroke);
            painter.line_segment([Pos2::new(c.x, c.y + r * 0.15), Pos2::new(c.x, c.y + r * 0.85)], stroke);
        }
        IconKind::Canvas => {
            let page = Rect::from_center_size(c, Vec2::new(r * 1.35, r * 1.65));
            painter.rect_stroke(page, 2.0, stroke, StrokeKind::Inside);
            painter.line_segment([Pos2::new(c.x - r * 0.38, c.y - r * 0.2), Pos2::new(c.x + r * 0.38, c.y - r * 0.2)], thin);
            painter.line_segment([Pos2::new(c.x - r * 0.38, c.y + r * 0.22), Pos2::new(c.x + r * 0.38, c.y + r * 0.22)], thin);
        }
        IconKind::Grid => {
            let s = r * 0.65;
            let g = r * 0.16;
            for (dx, dy) in [(-1.0, -1.0), (1.0, -1.0), (-1.0, 1.0), (1.0, 1.0)] {
                let cell = Rect::from_center_size(
                    Pos2::new(c.x + dx * (s * 0.5 + g), c.y + dy * (s * 0.5 + g)),
                    Vec2::splat(s),
                );
                painter.rect_stroke(cell, 1.5, thin, StrokeKind::Inside);
            }
        }
        IconKind::Search => {
            let sc = Pos2::new(c.x - r * 0.15, c.y - r * 0.15);
            painter.circle_stroke(sc, r * 0.56, stroke);
            painter.line_segment(
                [Pos2::new(sc.x + r * 0.38, sc.y + r * 0.38), Pos2::new(c.x + r * 0.78, c.y + r * 0.78)],
                stroke,
            );
        }
        IconKind::Edit => {
            // pencil: shaft from top-right to bottom-left plus the tip
            let a = Pos2::new(c.x + r * 0.7, c.y - r * 0.7);
            let b = Pos2::new(c.x - r * 0.45, c.y + r * 0.45);
            painter.line_segment([a, b], Stroke::new(3.0_f32, color));
            painter.line_segment([b, Pos2::new(c.x - r * 0.75, c.y + r * 0.75)], thin);
        }
        IconKind::Inbox => {
            let box_r = Rect::from_center_size(c, Vec2::new(r * 1.6, r * 1.45));
            painter.rect_stroke(box_r, 2.0, stroke, StrokeKind::Inside);
            painter.line_segment([Pos2::new(box_r.min.x, c.y + r * 0.15), Pos2::new(box_r.max.x, c.y + r * 0.15)], thin);
        }
        IconKind::Phone => {
            painter.add(Shape::line(
                vec![
                    Pos2::new(c.x - r * 0.65, c.y - r * 0.45),
                    Pos2::new(c.x - r * 0.35, c.y - r * 0.75),
                    Pos2::new(c.x - r * 0.1, c.y - r * 0.25),
                    Pos2::new(c.x + r * 0.25, c.y + r * 0.1),
                    Pos2::new(c.x + r * 0.75, c.y + r * 0.35),
                    Pos2::new(c.x + r * 0.45, c.y + r * 0.65),
                    Pos2::new(c.x - r * 0.2, c.y + r * 0.2),
                    Pos2::new(c.x - r * 0.65, c.y - r * 0.45),
                ],
                stroke,
            ));
        }
        IconKind::Check => {
            painter.add(Shape::line(
                vec![
                    Pos2::new(c.x - r * 0.65, c.y + r * 0.05),
                    Pos2::new(c.x - r * 0.18, c.y + r * 0.55),
                    Pos2::new(c.x + r * 0.72, c.y - r * 0.48),
                ],
                Stroke::new(2.1_f32, color),
            ));
        }
        IconKind::Close => {
            painter.line_segment([Pos2::new(c.x - r * 0.6, c.y - r * 0.6), Pos2::new(c.x + r * 0.6, c.y + r * 0.6)], stroke);
            painter.line_segment([Pos2::new(c.x + r * 0.6, c.y - r * 0.6), Pos2::new(c.x - r * 0.6, c.y + r * 0.6)], stroke);
        }
        IconKind::Reply => {
            painter.add(Shape::line(
                vec![
                    Pos2::new(c.x - r * 0.2, c.y - r * 0.55),
                    Pos2::new(c.x - r * 0.75, c.y),
                    Pos2::new(c.x - r * 0.2, c.y + r * 0.55),
                ],
                stroke,
            ));
            painter.add(Shape::line(
                vec![
                    Pos2::new(c.x - r * 0.7, c.y),
                    Pos2::new(c.x + r * 0.35, c.y),
                    Pos2::new(c.x + r * 0.72, c.y + r * 0.55),
                ],
                stroke,
            ));
        }
        IconKind::Smile => {
            painter.circle_stroke(c, r * 0.85, stroke);
            painter.circle_filled(Pos2::new(c.x - r * 0.3, c.y - r * 0.2), 1.6, color);
            painter.circle_filled(Pos2::new(c.x + r * 0.3, c.y - r * 0.2), 1.6, color);
            painter.add(Shape::line(
                vec![
                    Pos2::new(c.x - r * 0.38, c.y + r * 0.2),
                    Pos2::new(c.x, c.y + r * 0.42),
                    Pos2::new(c.x + r * 0.38, c.y + r * 0.2),
                ],
                thin,
            ));
        }
        IconKind::Send => {
            let pts = vec![
                Pos2::new(c.x - r * 0.7, c.y - r * 0.65),
                Pos2::new(c.x + r * 0.8, c.y),
                Pos2::new(c.x - r * 0.7, c.y + r * 0.65),
                Pos2::new(c.x - r * 0.35, c.y),
                Pos2::new(c.x - r * 0.7, c.y - r * 0.65),
            ];
            painter.add(Shape::line(pts, stroke));
        }
        IconKind::Poll => {
            painter.line_segment([Pos2::new(c.x - r * 0.5, c.y + r * 0.7), Pos2::new(c.x - r * 0.5, c.y - r * 0.1)], Stroke::new(2.5_f32, color));
            painter.line_segment([Pos2::new(c.x, c.y + r * 0.7), Pos2::new(c.x, c.y - r * 0.65)], Stroke::new(2.5_f32, color));
            painter.line_segment([Pos2::new(c.x + r * 0.5, c.y + r * 0.7), Pos2::new(c.x + r * 0.5, c.y + r * 0.2)], Stroke::new(2.5_f32, color));
        }
        IconKind::Clock => {
            painter.circle_stroke(c, r * 0.85, stroke);
            painter.line_segment([c, Pos2::new(c.x, c.y - r * 0.48)], stroke);
            painter.line_segment([c, Pos2::new(c.x + r * 0.38, c.y + r * 0.2)], stroke);
        }
        IconKind::Gamepad => {
            let pad = Rect::from_center_size(c, Vec2::new(r * 1.75, r * 1.05));
            painter.rect_stroke(pad, 4.0, stroke, StrokeKind::Inside);
            painter.line_segment([Pos2::new(c.x - r * 0.52, c.y), Pos2::new(c.x - r * 0.18, c.y)], thin);
            painter.line_segment([Pos2::new(c.x - r * 0.35, c.y - r * 0.17), Pos2::new(c.x - r * 0.35, c.y + r * 0.17)], thin);
            painter.circle_filled(Pos2::new(c.x + r * 0.32, c.y - r * 0.12), 1.6, color);
            painter.circle_filled(Pos2::new(c.x + r * 0.52, c.y + r * 0.12), 1.6, color);
        }
        IconKind::Lock => {
            let body = Rect::from_center_size(Pos2::new(c.x, c.y + r * 0.22), Vec2::new(r * 1.25, r * 1.0));
            painter.rect_stroke(body, 2.0, stroke, StrokeKind::Inside);
            painter.add(Shape::line(
                vec![
                    Pos2::new(c.x - r * 0.35, c.y - r * 0.28),
                    Pos2::new(c.x - r * 0.35, c.y - r * 0.65),
                    Pos2::new(c.x + r * 0.35, c.y - r * 0.65),
                    Pos2::new(c.x + r * 0.35, c.y - r * 0.28),
                ],
                stroke,
            ));
        }
        IconKind::Globe => {
            painter.circle_stroke(c, r * 0.85, stroke);
            painter.line_segment([Pos2::new(c.x - r * 0.82, c.y), Pos2::new(c.x + r * 0.82, c.y)], thin);
            painter.line_segment([Pos2::new(c.x, c.y - r * 0.82), Pos2::new(c.x, c.y + r * 0.82)], thin);
        }
    }
}

/// Draws a `32px × 32px` `.icon-btn` matching `client/src/index.css`.
#[cfg(feature = "native-gui")]
pub fn icon_btn(
    ui: &mut Ui,
    kind: IconKind,
    tooltip: &str,
    active: bool,
    danger_off: bool,
) -> Response {
    use palette::*;
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(32.0), Sense::click());
    let hovered = resp.hovered();
    let painter = ui.painter();
    if hovered || active {
        painter.rect_filled(
            rect,
            CornerRadius::same(2),
            if active { BG_SELECTED } else { BG_HOVER },
        );
    }
    let fg = if danger_off {
        DANGER
    } else if hovered || active {
        TEXT_HEADER
    } else {
        INTERACTIVE
    };
    let icon_rect = Rect::from_center_size(rect.center(), Vec2::splat(18.0));
    draw_icon(painter, icon_rect, kind, fg);
    resp.on_hover_text(tooltip)
}

/// Draws a circular `36px × 36px` `.round-btn` matching `client/src/components/Friends.tsx`.
#[cfg(feature = "native-gui")]
pub fn round_icon_btn(
    ui: &mut Ui,
    kind: IconKind,
    tooltip: &str,
    accept: bool,
    danger: bool,
) -> Response {
    use palette::*;
    let (rect, resp) = ui.allocate_exact_size(Vec2::splat(36.0), Sense::click());
    let hovered = resp.hovered();
    let painter = ui.painter();
    let fill = if hovered && danger {
        DANGER
    } else if hovered && accept {
        GREEN
    } else if hovered {
        BG_SELECTED
    } else {
        BG_PANEL
    };
    let border = if hovered && danger {
        DANGER
    } else if hovered && accept {
        GREEN
    } else {
        BORDER
    };
    let fg = if hovered && (danger || accept) {
        Color32::BLACK
    } else if hovered {
        TEXT_HEADER
    } else {
        INTERACTIVE
    };
    painter.circle(rect.center(), 17.5, fill, Stroke::new(1.0_f32, border));
    let icon_rect = Rect::from_center_size(rect.center(), Vec2::splat(16.0));
    draw_icon(painter, icon_rect, kind, fg);
    resp.on_hover_text(tooltip)
}
