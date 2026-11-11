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
    // 7.10.3 legal (same wording as the web client)
    ("I accept the terms of use and have read the privacy notice.", "Ich akzeptiere die Nutzungsbedingungen und habe die Datenschutzerklärung gelesen."),
    ("I am at least {n} years old.", "Ich bin mindestens {n} Jahre alt."),
    ("Imprint", "Impressum"),
    ("Privacy notice", "Datenschutzerklärung"),
    ("Terms of use", "Nutzungsbedingungen"),
    ("Report illegal content", "Rechtswidrige Inhalte melden"),
    ("Tick the boxes above to create an account.", "Setze die Häkchen oben, um ein Konto zu erstellen."),
    ("Open the website", "Website öffnen"),
    ("Not sent", "Nicht gesendet"),
    ("Older messages: use search.", "Ältere Nachrichten: nutze die Suche."),
    ("The server changed while logging in. Log in again.", "Der Server wurde während der Anmeldung gewechselt. Melde dich erneut an."),
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
    // private nodes connected next to the hub (the web's wording)
    ("Private nodes you use besides the Main Hub, all connected at once. Each node is a separate server with its own accounts and admins. The list is saved with your account.",
     "Private Nodes, die du neben dem Haupt-Hub nutzt, alle gleichzeitig verbunden. Jeder Node ist ein eigener Server mit eigenen Konten und Admins. Die Liste wird mit deinem Konto gespeichert."),
    ("{address} leaves the list on all your devices. Cillhub signs you out there and its servers leave your server list. Your account there stays as it is.",
     "{address} wird auf allen deinen Geräten aus der Liste entfernt. Cillhub meldet dich dort ab und seine Server verschwinden aus deiner Serverliste. Dein Konto dort bleibt, wie es ist."),
    ("Needs its own login · not connected", "Braucht eigene Anmeldung · nicht verbunden"),
    ("Not connected: {reason} Retrying…", "Nicht verbunden: {reason} Neuer Versuch folgt …"),
    ("Not connected", "Nicht verbunden"),
    ("Sign-out pending", "Abmeldung steht aus"),
    ("Too much is going on right now. Try again in a moment.", "Gerade ist zu viel los. Versuch es gleich noch einmal."),
    ("Direct messages and friends are not available on private nodes yet.", "Direktnachrichten und Freunde gibt es auf Private Nodes noch nicht."),
    ("This node sent more data than the app keeps.", "Dieser Node hat mehr Daten geschickt, als die App behält."),
    ("Sign-out still pending on {n} node(s).", "Abmeldung auf {n} Node(s) steht noch aus."),
    ("This is a separate server with its own accounts and admins.", "Das ist ein eigener Server mit eigenen Konten und Admins."),
    ("Cillhub signs you in there with your account here: the node gets your user name and avatar, never your password. Its servers then show up in your server list.",
     "Cillhub meldet dich dort mit deinem Konto von hier an: Der Node bekommt deinen Benutzernamen und dein Profilbild, nie dein Passwort. Seine Server erscheinen dann in deiner Serverliste."),
    ("Add and sign in", "Hinzufügen und anmelden"),
    ("{name} is not reachable right now.", "{name} ist gerade nicht erreichbar."),
    ("Update the node so this app can sign you in there.", "Aktualisiere den Node, damit dich diese App dort anmelden kann."),
    ("Could not join lobby. Ensure League of Legends is running.", "Lobby-Beitritt fehlgeschlagen. Läuft League of Legends?"),
    ("Open Party", "Offene Gruppe"),
    ("Join Party", "Gruppe beitreten"),
    ("Join my League of Legends party!", "Tritt meiner League-of-Legends-Gruppe bei!"),
    ("Share League Lobby ({members}/{max})", "League-Lobby teilen ({members}/{max})"),
    ("Session expired. Please log in again.", "Sitzung abgelaufen. Bitte melde dich erneut an."),
    ("Gateway reconnecting: {error}", "Verbindung wird wiederhergestellt: {error}"),
    ("Game invite", "Spieleinladung"),
    ("Only web links can be opened.", "Nur Weblinks können geöffnet werden."),
    // this app has the arrows only, no drag and drop
    ("Use roles to group your server members and assign permissions. Members use the color of their highest role. Use the arrows to change the hierarchy.", "Mit Rollen gruppierst du Servermitglieder und vergibst Berechtigungen. Mitglieder tragen die Farbe ihrer höchsten Rolle. Nutze die Pfeile, um die Hierarchie zu ändern."),
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
