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
