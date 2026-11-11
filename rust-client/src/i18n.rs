//! UI strings like the web client's i18n: the English text is the key, German comes from the
//! web client's dictionary (assets/i18n-de.json, made by scripts/gen-web-assets.mjs) and, for
//! the few strings only this app has, from NATIVE_DE. A missing translation shows the English text.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static GERMAN: AtomicBool = AtomicBool::new(false);

/// Strings the web client does not have (keep short; prefer the web's wording).
const NATIVE_DE: &[(&str, &str)] = &[
    ("Voice calls are not available in this app yet.", "Sprachanrufe gibt es in dieser App noch nicht."),
    ("Nobody is in this channel.", "Niemand ist in diesem Kanal."),
    ("In this channel: {names}", "In diesem Kanal: {names}"),
    ("A new version of Cillhub is available ({version}).", "Eine neue Version von Cillhub ist verfügbar ({version})."),
    ("Restart to Update", "Neu starten und aktualisieren"),
    ("Dismiss for an hour", "Für eine Stunde ausblenden"),
    ("Open in Browser", "Im Browser öffnen"),
    ("Load older", "Ältere laden"),
    ("Delete Category", "Kategorie löschen"),
    ("Channel Canvas", "Kanal-Canvas"),
    ("No results", "Keine Ergebnisse"),
    ("Game Activity", "Spielaktivität"),
    ("Desktop", "Desktop"),
    ("Share my game activity", "Meine Spielaktivität teilen"),
    ("Shows the game you are playing as your status.", "Zeigt das Spiel, das du spielst, als deinen Status."),
    ("No game detected.", "Kein Spiel erkannt."),
    ("Scan Now", "Jetzt suchen"),
    ("Add a game", "Spiel hinzufügen"),
    ("Open Cillhub when you log in", "Cillhub bei der Anmeldung öffnen"),
    ("Server URL", "Server-URL"),
    ("Connect directly to a self-hosted Cillhub node.", "Direkt mit einem selbst gehosteten Cillhub-Node verbinden."),
    ("Reset token (if received)", "Reset-Token (falls erhalten)"),
    ("This server asks for a captcha check, which this app cannot show yet. Please register on the website, then log in here.", "Dieser Server verlangt eine Captcha-Prüfung, die diese App noch nicht anzeigen kann. Registriere dich bitte auf der Website und melde dich dann hier an."),
    ("Email is required.", "E-Mail ist erforderlich."),
    ("Password updated! You can now log in.", "Passwort geändert! Du kannst dich jetzt anmelden."),
    // the web shows these in English (missing in its dictionary)
    ("Active Now", "Gerade aktiv"),
    ("It's quiet for now…", "Gerade ist es ruhig …"),
    ("When friends are playing games or streaming, you'll see them here!", "Wenn Freunde spielen oder streamen, siehst du sie hier!"),
    ("Canvas", "Canvas"),
    ("No threads in this channel yet.", "In diesem Kanal gibt es noch keine Threads."),
    ("Write shared notes, guidelines, or resources in Markdown…", "Schreibe gemeinsame Notizen, Regeln oder Links in Markdown …"),
    ("No active stage topic", "Kein aktives Stage-Thema"),
    ("Party: {members}/{max}", "Gruppe: {members}/{max}"),
    ("Uploads need a connection to a server.", "Uploads brauchen eine Verbindung zu einem Server."),
    ("Joining {game} lobby...", "Trete der {game}-Lobby bei …"),
    ("Could not join lobby. Ensure League of Legends is running.", "Lobby-Beitritt fehlgeschlagen. Läuft League of Legends?"),
    ("Open Party", "Offene Gruppe"),
    ("Join Party", "Gruppe beitreten"),
    ("Join my League of Legends party!", "Tritt meiner League-of-Legends-Gruppe bei!"),
    ("Share League Lobby ({members}/{max})", "League-Lobby teilen ({members}/{max})"),
    ("Session expired. Please log in again.", "Sitzung abgelaufen. Bitte melde dich erneut an."),
    ("Gateway reconnecting: {error}", "Verbindung wird wiederhergestellt: {error}"),
];

fn table() -> &'static HashMap<&'static str, &'static str> {
    static T: OnceLock<HashMap<&'static str, &'static str>> = OnceLock::new();
    T.get_or_init(|| {
        let web: HashMap<String, String> =
            serde_json::from_str(include_str!("../assets/i18n-de.json")).expect("i18n-de.json");
        let mut m: HashMap<&'static str, &'static str> = web
            .into_iter()
            .map(|(k, v)| (&*Box::leak(k.into_boxed_str()), &*Box::leak(v.into_boxed_str())))
            .collect();
        m.extend(NATIVE_DE.iter().copied());
        m
    })
}

/// Switches the UI language ("de…" = German, anything else = English).
pub fn set_locale(locale: &str) {
    GERMAN.store(locale.starts_with("de"), Ordering::Relaxed);
}

pub fn is_german() -> bool {
    GERMAN.load(Ordering::Relaxed)
}

/// The UI text for `key` (English source text) in the current language.
pub fn tr(key: &'static str) -> &'static str {
    if is_german() {
        table().get(key).copied().unwrap_or(key)
    } else {
        key
    }
}

/// `tr` with `{name}` placeholders filled in.
pub fn trf(key: &'static str, vars: &[(&str, &str)]) -> String {
    let mut s = tr(key).to_string();
    for (k, v) in vars {
        s = s.replace(&format!("{{{k}}}"), v);
    }
    s
}

#[cfg(test)]
pub fn has_german(key: &str) -> bool {
    table().contains_key(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_dictionary_loads_and_fills_placeholders() {
        assert_eq!(table().get("Today at {time}"), Some(&"Heute um {time}"));
        assert!(table().len() > 2000);
        assert!(has_german("Voice calls are not available in this app yet."));
    }

    /// Every literal the UI passes to tr()/trf() has a German text.
    #[test]
    fn every_ui_string_has_german() {
        let re = regex::Regex::new(r#"\btrf?\(\s*"((?:[^"\\]|\\.)*)""#).unwrap();
        let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/src");
        let mut missing = Vec::new();
        let mut seen = 0;
        let mut files = vec![std::path::PathBuf::from(dir)];
        while let Some(p) = files.pop() {
            if p.is_dir() {
                files.extend(std::fs::read_dir(&p).unwrap().map(|e| e.unwrap().path()));
                continue;
            }
            if p.extension().is_none_or(|e| e != "rs") || p.ends_with("i18n.rs") {
                continue;
            }
            let src = std::fs::read_to_string(&p).unwrap();
            for c in re.captures_iter(&src) {
                let key = c[1].replace("\\\"", "\"").replace("\\n", "\n");
                seen += 1;
                if !has_german(&key) {
                    missing.push(format!("{}: {key}", p.file_name().unwrap().to_string_lossy()));
                }
            }
        }
        assert!(seen > 0);
        assert!(missing.is_empty(), "no German text for:\n{}", missing.join("\n"));
    }
}
