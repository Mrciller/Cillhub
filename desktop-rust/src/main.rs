#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Cillhub desktop: the web client bundled as a program (tauri://localhost, http://tauri.localhost on Windows), talking
//! to the hub; a locked-down Tauri shell with tray, deep links, signed auto-update and game activity.

use cillhub_core::config::{self, Nav, APP_ORIGIN, FEED_PATH, PROD_HUB};
use cillhub_core::deeplink::{deep_link_path, parse_unread};
use cillhub_core::games::{GameActivity, GameTracker};
use cillhub_core::settings::SettingsManager;
use cillhub_core::update::{self, Package};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PermissionResponse};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_deep_link::DeepLinkExt;
use url::Url;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const FOUR_HOURS: Duration = Duration::from_secs(4 * 60 * 60);

/// What the page's update banner shows (client/src/update.ts AppUpdateStatus).
#[derive(Clone, Serialize)]
struct UpdateStatus {
    state: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    percent: Option<u32>,
}

fn status(state: &'static str, version: Option<String>, percent: Option<u32>) -> UpdateStatus {
    UpdateStatus { state, version, percent }
}

struct Shell {
    settings: SettingsManager,
    update: Mutex<UpdateStatus>,
    /// The verified installer: only set after the signature check, the only way to "ready".
    ready: Mutex<Option<(String, PathBuf)>>,
    checking: AtomicBool,
    install_when_ready: AtomicBool,
    game: Mutex<Option<GameActivity>>,
    unread: Mutex<String>,
}

fn main() {
    if std::env::args().any(|a| a == "--version") {
        println!("Cillhub {VERSION}");
        return;
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| show(app))) // first: a second start just shows us
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None))
        .plugin(tauri_plugin_opener::init())
        // Only the bundled client gets the permissions it needs; a node's sign-in page in the same webview gets none.
        .on_permission_request(|webview, kind| {
            if config::permission_allowed(webview.url().ok().as_ref(), &kind) { PermissionResponse::Allow } else { PermissionResponse::Deny }
        })
        .on_window_event(|w, e| {
            if let WindowEvent::CloseRequested { api, .. } = e {
                if w.app_handle().state::<Shell>().settings.get().close_to_tray {
                    api.prevent_close();
                    let _ = w.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![update_status_current, update_check, update_install, game_activity_current])
        .setup(|app| {
            let handle = app.handle().clone();
            app.manage(Shell {
                settings: SettingsManager::new(app.path().app_config_dir()?.join("settings.json")),
                update: Mutex::new(status("none", None, None)),
                ready: Mutex::new(None),
                checking: AtomicBool::new(false),
                install_when_ready: AtomicBool::new(false),
                game: Mutex::new(None),
                unread: Mutex::new(String::new()),
            });

            let _ = app.deep_link().register_all(); // AppImage and dev runs; the installers register at install time
            let h = handle.clone();
            app.deep_link().on_open_url(move |e| {
                if let Some(p) = e.urls().iter().find_map(|u| deep_link_path(u.as_str())) {
                    open_in_app(&h, &p);
                }
            });
            let start = app.deep_link().get_current().ok().flatten().and_then(|urls| urls.iter().find_map(|u| deep_link_path(u.as_str()))).unwrap_or_else(|| "/".into());

            let bridge = include_str!("bridge.js").replace("__PLATFORM__", if cfg!(windows) { "win32" } else { "linux" }).replace("__VERSION__", VERSION);
            let nav = handle.clone();
            WebviewWindowBuilder::new(app, "main", WebviewUrl::App(start.into()))
                .title("Cillhub")
                .inner_size(1280.0, 800.0)
                .min_inner_size(380.0, 320.0)
                .center()
                .background_color(tauri::window::Color(0x17, 0x19, 0x1e, 0xff))
                .initialization_script(bridge)
                .on_navigation(move |u| match config::navigation(u) {
                    Nav::Allow => true,
                    Nav::Deny => false,
                    Nav::Redirect(app_url) => {
                        let h = nav.clone();
                        std::thread::spawn(move || { if let Some(w) = h.get_webview_window("main") { let _ = w.navigate(app_url); } }); // not inside the refused navigation
                        false
                    }
                })
                // window.open: links go to the browser; the node sign-in popup gets no window, so the client redirects instead.
                .on_new_window(|u, _| {
                    if config::is_http_url(&u) { let _ = tauri_plugin_opener::open_url(u.as_str(), None::<&str>); }
                    NewWindowResponse::Deny
                })
                .on_document_title_changed(|w, title| {
                    let n = parse_unread(&title);
                    let _ = w.set_title(&if n > 0 { format!("({n}) Cillhub") } else { "Cillhub".into() });
                    let text = if n > 0 { format!("{n} unread mention{}", if n == 1 { "" } else { "s" }) } else if n < 0 { "unread messages".into() } else { String::new() };
                    *w.app_handle().state::<Shell>().unread.lock().unwrap() = text;
                    refresh_tray(w.app_handle());
                })
                .build()?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("no icon")?.to_owned())
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, e| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = e { show(tray.app_handle()); }
                })
                .on_menu_event(|app, e| {
                    let shell = app.state::<Shell>();
                    match e.id().as_ref() {
                        "open" => {
                            if let Some(w) = app.get_webview_window("main") {
                                if !w.url().is_ok_and(|u| config::is_app_url(&u)) { let _ = w.navigate(Url::parse(APP_ORIGIN).unwrap()); } // stranded on a node page: back home
                            }
                            show(app);
                        }
                        "update" => { let a = app.clone(); std::thread::spawn(move || install(&a)); }
                        "tray" => shell.settings.update(|s| s.close_to_tray = !s.close_to_tray),
                        "activity" => {
                            shell.settings.update(|s| s.share_activity = !s.share_activity);
                            push(app, "game-activity", &shared_activity(&shell));
                        }
                        "autostart" => {
                            let al = app.autolaunch();
                            let _ = if al.is_enabled().unwrap_or(false) { al.disable() } else { al.enable() };
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                    refresh_tray(app);
                })
                .build(app)?;
            refresh_tray(&handle);

            let h = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(5)); // never block startup
                loop {
                    check(h.clone());
                    std::thread::sleep(FOUR_HOURS);
                }
            });
            let h = handle.clone();
            std::thread::spawn(move || {
                let mut tracker = GameTracker::new();
                loop {
                    std::thread::sleep(Duration::from_secs(15));
                    let shell = h.state::<Shell>();
                    let s = shell.settings.get();
                    let act = tracker.scan(&s.custom_games);
                    let changed = { let mut cur = shell.game.lock().unwrap(); (*cur != act).then(|| *cur = act.clone()).is_some() };
                    if changed && s.share_activity { push(&h, "game-activity", &act); }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("Cillhub could not start (is the WebView2 runtime / webkit2gtk installed?)");
}

fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn open_in_app(app: &AppHandle, path: &str) {
    if let (Some(w), Ok(u)) = (app.get_webview_window("main"), Url::parse(&format!("{APP_ORIGIN}{path}"))) {
        let _ = w.navigate(u);
    }
    show(app);
}

/// Bridge events go only to the app's own pages (bridge.js).
fn push(app: &AppHandle, channel: &str, value: &impl Serialize) {
    if let Some(w) = app.get_webview_window("main") {
        if w.url().is_ok_and(|u| config::is_app_url(&u)) {
            let _ = w.eval(format!("window.__cillhubPush&&window.__cillhubPush({},{})", serde_json::to_string(channel).unwrap_or_default(), serde_json::to_string(value).unwrap_or_default()));
        }
    }
}

fn shared_activity(shell: &Shell) -> Option<GameActivity> {
    if shell.settings.get().share_activity { shell.game.lock().unwrap().clone() } else { None }
}

fn refresh_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id("main") else { return };
    let shell = app.state::<Shell>();
    let s = shell.settings.get();
    let ready = shell.ready.lock().unwrap().as_ref().map(|r| r.0.clone());
    let parts = ["Cillhub".to_string(), shell.unread.lock().unwrap().clone(), ready.as_ref().map(|v| format!("update {v} ready")).unwrap_or_default()];
    let _ = tray.set_tooltip(Some(parts.iter().filter(|p| !p.is_empty()).cloned().collect::<Vec<_>>().join(" – ")));
    let menu = (|| -> tauri::Result<Menu<tauri::Wry>> {
        let m = Menu::new(app)?;
        m.append(&MenuItem::with_id(app, "open", "Open Cillhub", true, None::<&str>)?)?;
        if let Some(v) = &ready {
            m.append(&PredefinedMenuItem::separator(app)?)?;
            m.append(&MenuItem::with_id(app, "update", format!("Restart to update ({v})"), true, None::<&str>)?)?;
        }
        m.append(&PredefinedMenuItem::separator(app)?)?;
        m.append(&CheckMenuItem::with_id(app, "tray", "Close to tray", true, s.close_to_tray, None::<&str>)?)?;
        m.append(&CheckMenuItem::with_id(app, "activity", "Share game activity", true, s.share_activity, None::<&str>)?)?;
        m.append(&CheckMenuItem::with_id(app, "autostart", "Start Cillhub when I log in", true, app.autolaunch().is_enabled().unwrap_or(false), None::<&str>)?)?;
        m.append(&PredefinedMenuItem::separator(app)?)?;
        m.append(&MenuItem::with_id(app, "quit", "Quit Cillhub", true, None::<&str>)?)?;
        Ok(m)
    })();
    if let Ok(m) = menu { let _ = tray.set_menu(Some(m)); }
}

fn set_status(app: &AppHandle, s: UpdateStatus) {
    let shell = app.state::<Shell>();
    *shell.update.lock().unwrap() = s.clone();
    push(app, "update-status", &s);
}

/// Checks the feed and downloads + verifies a newer release (in a thread); "ready" is reached only after the signature check.
fn check(app: AppHandle) {
    let shell = app.state::<Shell>();
    if shell.ready.lock().unwrap().is_some() || shell.checking.swap(true, Ordering::SeqCst) { return; }
    std::thread::spawn(move || {
        let result = fetch_update(&app);
        let shell = app.state::<Shell>();
        shell.checking.store(false, Ordering::SeqCst);
        match result {
            Ok(Some((version, path))) => {
                *shell.ready.lock().unwrap() = Some((version.clone(), path));
                set_status(&app, status("ready", Some(version), None));
                refresh_tray(&app);
                if shell.install_when_ready.swap(false, Ordering::SeqCst) { install(&app); }
            }
            Ok(None) => set_status(&app, status("none", None, None)),
            Err(e) => {
                eprintln!("update: {e}");
                shell.install_when_ready.store(false, Ordering::SeqCst);
                set_status(&app, status("error", None, None));
            }
        }
    });
}

fn fetch_update(app: &AppHandle) -> Result<Option<(String, PathBuf)>, String> {
    let Some(pkg) = update::package() else { return Ok(None) };
    set_status(app, status("checking", None, None));
    let client = reqwest::blocking::Client::builder().https_only(true).redirect(reqwest::redirect::Policy::none()).connect_timeout(Duration::from_secs(15)).timeout(None).build().map_err(|e| e.to_string())?;
    let base = format!("{PROD_HUB}{FEED_PATH}");
    let text = |url: String| client.get(url).send().and_then(|r| r.error_for_status()).map_err(|e| e.to_string());
    let yml = text(format!("{base}{}", if cfg!(windows) { "latest.yml" } else { "latest-linux.yml" }))?.text().map_err(|e| e.to_string())?;
    let feed = update::parse_feed(&yml).ok_or("feed has no version")?;
    if !update::is_newer(&feed.version, VERSION) { return Ok(None); }
    let file = update::pick_file(&feed, &pkg).ok_or("feed lists no installer for this package")?.to_string();
    let dest = match &pkg { Package::AppImage(p) => p.with_extension("update"), _ => std::env::temp_dir().join(&file) };
    let v = feed.version.clone();
    set_status(app, status("downloading", Some(v.clone()), Some(0)));
    let sha = update::download(&client, &format!("{base}{file}"), &dest, |pct| set_status(app, status("downloading", Some(v.clone()), Some(pct))))?;
    let sig = text(format!("{base}{file}.sig"))?.bytes().map_err(|e| e.to_string())?;
    if !update::verify(&sha, &feed.version, &sig, update::PINNED_KEYS) {
        let _ = std::fs::remove_file(&dest);
        return Err("update signature does not verify against the pinned release keys".into());
    }
    Ok(Some((feed.version, dest)))
}

/// "Update" in the page or the tray: restart into the verified installer, or fetch one first and restart when it is ready.
fn install(app: &AppHandle) {
    let ready = app.state::<Shell>().ready.lock().unwrap().clone();
    match ready {
        Some((_, path)) => run_installer(app, &path),
        None => {
            app.state::<Shell>().install_when_ready.store(true, Ordering::SeqCst);
            check(app.clone());
        }
    }
}

fn run_installer(app: &AppHandle, path: &Path) {
    let Some(pkg) = update::package() else { return };
    let r: std::io::Result<()> = match &pkg {
        Package::Nsis => Command::new(path).args(["/P", "/R"]).spawn().map(|_| ()), // passive NSIS: progress only, relaunches us
        Package::AppImage(image) => (|| {
            #[cfg(unix)]
            std::fs::set_permissions(path, <std::fs::Permissions as std::os::unix::fs::PermissionsExt>::from_mode(0o755))?;
            std::fs::rename(path, image)?; // same name: launchers keep working
            Command::new(image).spawn().map(|_| ())
        })(),
        Package::Deb => Command::new("pkexec").args(["dpkg", "-i"]).arg(path).status().and_then(|s| if s.success() { Ok(()) } else { Err(std::io::Error::other(format!("dpkg: {s}"))) }),
    };
    match r {
        Ok(()) if pkg == Package::Deb => app.restart(),
        Ok(()) => app.exit(0),
        Err(e) => {
            eprintln!("update install: {e}");
            set_status(app, status("error", None, None));
        }
    }
}

#[tauri::command]
fn update_status_current(shell: State<Shell>) -> UpdateStatus {
    shell.update.lock().unwrap().clone()
}

#[tauri::command]
fn update_check(app: AppHandle) {
    check(app);
}

#[tauri::command]
fn update_install(app: AppHandle) {
    std::thread::spawn(move || install(&app)); // pkexec blocks
}

#[tauri::command]
fn game_activity_current(shell: State<Shell>) -> Option<GameActivity> {
    shared_activity(&shell)
}
