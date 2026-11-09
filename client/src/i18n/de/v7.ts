// German UI strings for v7 (self-hosting and the hub network): setup wizard, other instances, server directory, admin pages.
export const v7: Record<string, string> = {
  'Main Hub': 'Haupt-Hub', 'Private Node': 'Privater Node', Default: 'Standard', 'Server selection': 'Serverauswahl',
  'Use an https:// address (http only for localhost).': 'Verwende eine https://-Adresse (http nur für localhost).',
  'Could not connect to node at this address.': 'Konnte keine Verbindung zum Node unter dieser Adresse herstellen.',
  'Connected to {name}': 'Verbunden mit {name}',
  // Setup wizard
  'Set up Cillhub': 'Cillhub einrichten', 'Setup steps': 'Einrichtungsschritte', 'Setup code': 'Einrichtungscode', Instance: 'Instanz', 'Admin account': 'Admin-Konto',
  'Two-factor authentication': 'Zwei-Faktor-Authentifizierung', 'Hub connection': 'Hub-Verbindung', 'Voice check': 'Sprachtest', Finish: 'Abschluss',
  'Welcome! This instance is not set up yet. Enter the setup code that the installer printed (also in /opt/cillhub/.env as CILLCORD_SETUP_CODE).':
    'Willkommen! Diese Instanz ist noch nicht eingerichtet. Gib den Einrichtungscode ein, den das Installationsprogramm ausgegeben hat (auch in /opt/cillhub/.env als CILLCORD_SETUP_CODE).',
  'Shown on the login page, in the browser tab and to people who join from other instances.': 'Erscheint auf der Anmeldeseite, im Browser-Tab und bei Leuten, die von anderen Instanzen beitreten.',
  'The admin account {name} was created.': 'Das Admin-Konto {name} wurde angelegt.',
  'The first account becomes the instance admin. It must use two-factor authentication, set up in the next step.': 'Das erste Konto wird Admin der Instanz. Es braucht Zwei-Faktor-Authentifizierung, die du im nächsten Schritt einrichtest.',
  'Email (optional)': 'E-Mail (optional)', 'Repeat password': 'Passwort wiederholen', 'The passwords do not match.': 'Die Passwörter stimmen nicht überein.',
  'Admins of this instance must protect their account with an authenticator app.': 'Admins dieser Instanz müssen ihr Konto mit einer Authenticator-App schützen.',
  'I saved my backup codes': 'Ich habe meine Backup-Codes gespeichert',
  'Who can create an account?': 'Wer darf ein Konto anlegen?', 'Anyone (open registration)': 'Alle (offene Registrierung)', 'Only people with a registration code': 'Nur mit Registrierungscode',
  'Nobody (admins create accounts)': 'Niemand (Admins legen Konten an)', 'You can change this later in the admin dashboard.': 'Das kannst du später im Admin-Dashboard ändern.',
  Mode: 'Modus', Standalone: 'Eigenständig', 'Connected to the hub': 'Mit dem Hub verbunden',
  'Fully independent: own accounts, nothing is shared with the hub. Only an optional update check.': 'Völlig unabhängig: eigene Konten, nichts wird mit dem Hub geteilt. Nur eine abschaltbare Update-Prüfung.',
  "Hub accounts can sign in here, your public servers can appear in the hub's server directory and hub users see them next to their other servers.":
    'Hub-Konten können sich hier anmelden, deine öffentlichen Server können im Serververzeichnis des Hubs erscheinen und Hub-Nutzer sehen sie neben ihren anderen Servern.',
  'Hub address': 'Hub-Adresse', 'Link code': 'Verknüpfungscode',
  "A hub admin creates the code in the hub's admin dashboard → Nodes. It works once and for 24 hours.": 'Ein Hub-Admin erstellt den Code im Admin-Dashboard des Hubs → Nodes. Er gilt einmal und 24 Stunden lang.',
  'Voice backend: {name}. Cillhub checks that browsers can reach it.': 'Sprach-Backend: {name}. Cillhub prüft, ob Browser es erreichen.',
  'No voice backend is configured. Voice channels will say so until one is set up.': 'Es ist kein Sprach-Backend eingerichtet. Sprachkanäle weisen darauf hin, bis eines eingerichtet ist.',
  'Checking…': 'Wird geprüft …', passed: 'bestanden', failed: 'fehlgeschlagen', skipped: 'übersprungen', 'Check again': 'Erneut prüfen',
  'Voice may not work for everyone until this passes. Usually the UDP port is not open in the firewall or router. You can finish setup and run the check again later from the admin dashboard.':
    'Bis dieser Test besteht, funktioniert Sprache vielleicht nicht für alle. Meist ist der UDP-Port in Firewall oder Router nicht offen. Du kannst die Einrichtung trotzdem abschließen und den Test später im Admin-Dashboard wiederholen.',
  '2FA on': '2FA aktiv', 'Connected to {hub}': 'Verbunden mit {hub}', 'Finish setup': 'Einrichtung abschließen', 'Please wait…': 'Bitte warten …',
  // Other instances
  Connected: 'Verbunden', 'Suspended by the hub': 'Vom Hub gesperrt', 'Signed out': 'Abgemeldet', Suspended: 'Gesperrt', Banned: 'Verbannt',
  'Disconnect from {name}?': 'Verbindung zu {name} trennen?', 'Disconnect from {name}': 'Verbindung zu {name} trennen', 'Disconnect from instance': 'Von der Instanz trennen',
  'Its servers disappear from your server list and Cillhub forgets your sign-in there. You stay a member and can add them again later.':
    'Ihre Server verschwinden aus deiner Serverliste und Cillhub vergisst deine Anmeldung dort. Du bleibst Mitglied und kannst sie später wieder hinzufügen.',
  '{name} is not reachable right now. Messages may be out of date; Cillhub keeps trying.': '{name} ist gerade nicht erreichbar. Nachrichten sind vielleicht nicht aktuell; Cillhub versucht es weiter.',
  '{name} was suspended or unlinked by the hub admins. Its servers are read-only here.': '{name} wurde von den Hub-Admins gesperrt oder getrennt. Ihre Server sind hier nur lesbar.',
  '{name} signed you out.': '{name} hat dich abgemeldet.', 'Connecting to {name}…': 'Verbinde mit {name} …', 'Sign in again': 'Erneut anmelden',
  '{server} on {instance} ({status})': '{server} auf {instance} ({status})',
  'Add a server from another instance': 'Server von einer anderen Instanz hinzufügen',
  'Servers on instances linked to this hub can be used with your account here. You sign in there once with this account; the other instance never sees your password.':
    'Server auf Instanzen, die mit diesem Hub verknüpft sind, kannst du mit deinem Konto hier nutzen. Du meldest dich dort einmal mit diesem Konto an; die andere Instanz sieht dein Passwort nie.',
  'Your other instances': 'Deine anderen Instanzen',
  'Invite link from another instance': 'Einladungslink einer anderen Instanz', 'Waiting for sign-in…': 'Warte auf Anmeldung …', 'Sign in and join': 'Anmelden und beitreten',
  'Paste the full invite link of the other instance, e.g. https://chat.example.org/invite/abc.': 'Füge den vollständigen Einladungslink der anderen Instanz ein, z. B. https://chat.example.org/invite/abc.',
  'That is not an invite link.': 'Das ist kein Einladungslink.', 'This hub does not list other instances.': 'Dieser Hub listet keine anderen Instanzen.',
  '{host} is not linked to this hub. Open the invite on its own site instead.': '{host} ist nicht mit diesem Hub verknüpft. Öffne die Einladung stattdessen auf ihrer eigenen Seite.',
  '{name} is suspended by the hub admins.': '{name} ist von den Hub-Admins gesperrt.',
  'Or explore public servers in the server directory.': 'Oder entdecke öffentliche Server im Serververzeichnis.', 'Explore servers': 'Server entdecken',
  'Another instance': 'Andere Instanz', 'Finishing sign-in…': 'Anmeldung wird abgeschlossen …', 'Signed in. You can close this window.': 'Angemeldet. Du kannst dieses Fenster schließen.',
  'This sign-in has expired or was not started here. Try again.': 'Diese Anmeldung ist abgelaufen oder wurde nicht hier gestartet. Versuch es noch einmal.',
  'Sign-in was cancelled.': 'Die Anmeldung wurde abgebrochen.', '{name} refused the sign-in: {error}': '{name} hat die Anmeldung abgelehnt: {error}',
  '{name} sent an invalid answer.': '{name} hat eine ungültige Antwort geschickt.', 'The sign-in window was closed.': 'Das Anmeldefenster wurde geschlossen.',
  // Consent screen on the hub
  'Another Cillhub instance': 'Eine andere Cillhub-Instanz', 'Sign in to {name} with your Cillhub account': 'Mit deinem Cillhub-Konto bei {name} anmelden',
  '{name} will get:': '{name} erhält:', '{name} will not get:': '{name} erhält nicht:', 'Your username, display name and avatar': 'Deinen Benutzernamen, Anzeigenamen und Avatar',
  'Your password, email, direct messages, friends or other servers': 'Dein Passwort, deine E-Mail, Direktnachrichten, Freunde oder andere Server',
  'The hub answered with an unexpected address.': 'Der Hub hat mit einer unerwarteten Adresse geantwortet.',
  // Directory
  'Server Directory': 'Serververzeichnis', 'Public servers on this hub and on instances linked to it.': 'Öffentliche Server auf diesem Hub und auf damit verknüpften Instanzen.',
  'Search servers': 'Server suchen', 'All languages': 'Alle Sprachen', Categories: 'Kategorien', Results: 'Ergebnisse', '1 server': '1 Server', '{n} servers': '{n} Server',
  'No servers match. Try another search or category.': 'Keine passenden Server. Versuch eine andere Suche oder Kategorie.',
  'on {instance}': 'auf {instance}', 'on this hub': 'auf diesem Hub', '{n} Online': '{n} online', 'Open {name}': '{name} öffnen', 'Join {name}': '{name} beitreten',
  'Joining…': 'Trete bei …', Unavailable: 'Nicht verfügbar', 'Report {name}': '{name} melden', 'What is wrong with this listing?': 'Was stimmt mit diesem Eintrag nicht?',
  'Thanks. The hub admins will review this server.': 'Danke. Die Hub-Admins sehen sich diesen Server an.',
  Esports: 'E-Sport', Gaming: 'Gaming', Music: 'Musik', Education: 'Bildung', 'Science & Tech': 'Wissenschaft & Technik', Entertainment: 'Unterhaltung',
  "Listed servers appear in the hub's server directory, where anyone with an account there can find and join them.": 'Gelistete Server erscheinen im Serververzeichnis des Hubs, wo alle mit einem Konto dort sie finden und beitreten können.',
  'The hub admins removed this server from the directory. Contact them if you think this is a mistake.': 'Die Hub-Admins haben diesen Server aus dem Verzeichnis entfernt. Melde dich bei ihnen, wenn du das für einen Fehler hältst.',
  'List this server in the server directory': 'Diesen Server im Serververzeichnis listen', 'Tags (comma-separated, up to 5)': 'Schlagwörter (durch Kommas getrennt, bis zu 5)',
  'Use at most 5 tags of up to 30 characters.': 'Höchstens 5 Schlagwörter mit je bis zu 30 Zeichen.',
  // Admin: hub
  Nodes: 'Nodes', Federation: 'Föderation', Updates: 'Updates', 'Link codes': 'Verknüpfungscodes', 'Create Link Code': 'Verknüpfungscode erstellen', 'New link code:': 'Neuer Verknüpfungscode:',
  'A node admin pastes a link code in their setup wizard or Federation page to connect their instance to this hub. Each code works once, for 24 hours.':
    'Ein Node-Admin fügt einen Verknüpfungscode im Einrichtungsassistenten oder auf der Föderationsseite ein, um seine Instanz mit diesem Hub zu verbinden. Jeder Code gilt einmal, 24 Stunden lang.',
  'Copied.': 'Kopiert.', 'Expires {when}': 'Läuft ab: {when}', 'Used by': 'Verwendet von', Used: 'Verwendet', 'Linked nodes': 'Verknüpfte Nodes', 'Search by name or address': 'Nach Name oder Adresse suchen',
  Version: 'Version', Public: 'Öffentlich', 'No nodes are linked yet.': 'Noch keine Nodes verknüpft.', 'Node {name}': 'Node {name}', 'Node ID': 'Node-ID', Address: 'Adresse',
  Linked: 'Verknüpft', 'Node actions': 'Node-Aktionen', '{n} members in public servers': '{n} Mitglieder in öffentlichen Servern', '{n} public': '{n} öffentlich',
  Suspend: 'Sperren', 'Suspend {name}?': '{name} sperren?', 'Reason (shown in the audit log)': 'Grund (steht im Protokoll)',
  'Its servers disappear from the directory and hub accounts can no longer sign in there until you lift the suspension.': 'Ihre Server verschwinden aus dem Verzeichnis und Hub-Konten können sich dort nicht mehr anmelden, bis du die Sperre aufhebst.',
  'Node suspended.': 'Node gesperrt.', 'Lift Suspension': 'Sperre aufheben', 'Lift the suspension of {name}?': 'Sperre von {name} aufheben?', 'Suspension lifted.': 'Sperre aufgehoben.',
  'Ban Node': 'Node verbannen', 'Ban {name}?': '{name} verbannen?', 'The node is unlinked and can never link again from this address. Hub sign-ins there stop at once.':
    'Der Node wird getrennt und kann sich von dieser Adresse nie wieder verknüpfen. Hub-Anmeldungen dort enden sofort.', 'Node banned.': 'Node verbannt.',
  Unlink: 'Trennen', 'Unlink {name}?': '{name} trennen?', 'The node goes back to standalone. Its admin can link it again with a new code.': 'Der Node wird wieder eigenständig. Sein Admin kann ihn mit einem neuen Code erneut verknüpfen.',
  'Node unlinked.': 'Node getrennt.', 'All listings': 'Alle Einträge', Reported: 'Gemeldet', Hidden: 'Ausgeblendet', 'Nothing here.': 'Hier ist nichts.',
  'Hide {name} from the directory?': '{name} im Verzeichnis ausblenden?', 'Reason (the server owner sees it)': 'Grund (sieht der Server-Eigentümer)', Hide: 'Ausblenden',
  'Hidden from the directory.': 'Im Verzeichnis ausgeblendet.', 'Listed again.': 'Wieder gelistet.', 'Reports dismissed.': 'Meldungen verworfen.', 'Hidden because: {reason}': 'Ausgeblendet, weil: {reason}',
  '{n} report': '{n} Meldung', '{n} reports': '{n} Meldungen', 'List Again': 'Wieder listen', 'Dismiss Reports': 'Meldungen verwerfen',
  // Admin: node
  'Not linked': 'Nicht verknüpft', 'Banned by the hub': 'Vom Hub verbannt', 'Hub not reachable': 'Hub nicht erreichbar', Hub: 'Hub', 'Last heartbeat': 'Letztes Lebenszeichen',
  'Local and hub accounts': 'Lokale und Hub-Konten', 'People can register here or sign in with their hub account.': 'Man kann sich hier registrieren oder mit dem Hub-Konto anmelden.',
  'Local accounts only': 'Nur lokale Konten', 'Hub accounts cannot sign in here.': 'Hub-Konten können sich hier nicht anmelden.', 'Hub accounts only': 'Nur Hub-Konten',
  'New people sign in with their hub account; existing local accounts keep working.': 'Neue Leute melden sich mit ihrem Hub-Konto an; bestehende lokale Konten funktionieren weiter.',
  'Sign-in methods': 'Anmeldemethoden', 'Standalone instances only have local accounts.': 'Eigenständige Instanzen haben nur lokale Konten.', 'Connect to a hub': 'Mit einem Hub verbinden',
  'Ask a hub admin for a link code (hub admin dashboard → Nodes). Connected, hub accounts can sign in here and your public servers can be listed in the hub directory. No other data is shared.':
    'Bitte einen Hub-Admin um einen Verknüpfungscode (Admin-Dashboard des Hubs → Nodes). Verbunden können sich Hub-Konten hier anmelden und deine öffentlichen Server im Hub-Verzeichnis erscheinen. Andere Daten werden nicht geteilt.',
  'Linked to the hub.': 'Mit dem Hub verknüpft.', 'Unlink from Hub': 'Vom Hub trennen', 'Unlink from the hub?': 'Vom Hub trennen?',
  'Hub accounts can no longer sign in here and your public servers leave the hub directory. Linked accounts stay, but can only sign in again after you link again.':
    'Hub-Konten können sich hier nicht mehr anmelden und deine öffentlichen Server verlassen das Hub-Verzeichnis. Verknüpfte Konten bleiben, können sich aber erst nach einer neuen Verknüpfung wieder anmelden.',
  'Unlinked. This instance is standalone now.': 'Getrennt. Diese Instanz ist jetzt eigenständig.',
  'Downloading the signed image…': 'Signiertes Image wird geladen …', 'Verifying the signature…': 'Signatur wird geprüft …', 'Backing up the database…': 'Datenbank wird gesichert …',
  'Migrating the database…': 'Datenbank wird migriert …', 'Restarting…': 'Neustart …', 'Rolling back…': 'Wird zurückgesetzt …', 'The last update failed': 'Das letzte Update ist fehlgeschlagen',
  'Current version': 'Aktuelle Version', Available: 'Verfügbar', 'Up to date': 'Aktuell', 'Last checked': 'Zuletzt geprüft', 'Last backup': 'Letzte Sicherung', 'Previous version': 'Vorherige Version',
  'Update Now': 'Jetzt aktualisieren', 'Update to {v}': 'Auf {v} aktualisieren', 'Update to {v}?': 'Auf {v} aktualisieren?', 'Check Now': 'Jetzt prüfen', 'Roll Back': 'Zurücksetzen',
  'Roll back to {v}?': 'Auf {v} zurücksetzen?', Refresh: 'Aktualisieren', 'Release notes for {v}': 'Versionshinweise zu {v}',
  'The database is backed up first. Cillhub restarts, which drops calls for a few seconds. You can roll back afterwards.': 'Zuerst wird die Datenbank gesichert. Cillhub startet neu, laufende Anrufe brechen für ein paar Sekunden ab. Danach kannst du zurücksetzen.',
  'Cillhub restarts with the previous image and restores the database backup taken before the update. Messages sent since then are lost.':
    'Cillhub startet mit dem vorherigen Image neu und spielt die Datenbanksicherung von vor dem Update zurück. Seitdem gesendete Nachrichten gehen verloren.',
  'Version {v} is available.': 'Version {v} ist verfügbar.', 'Cillhub is up to date.': 'Cillhub ist aktuell.', 'Check the hub for updates once a day': 'Einmal täglich beim Hub nach Updates suchen',
  // Integration (v7): hub sign-in on a node, voice self-check, updates, release channel, user link codes
  'Sign in with {hub}': 'Mit {hub} anmelden',
  'A voice backend is configured': 'Ein Sprach-Backend ist eingerichtet', 'cillvoice listens on UDP port {port}': 'cillvoice lauscht auf UDP-Port {port}',
  'This browser reaches {where} over UDP': 'Dieser Browser erreicht {where} über UDP',
  'LiveKit is reached through its own address; test it with a call after setup': 'LiveKit läuft über eine eigene Adresse; teste es nach der Einrichtung mit einem Anruf',
  'Check failed: {error}': 'Prüfung fehlgeschlagen: {error}', 'Log of the failed start': 'Protokoll des fehlgeschlagenen Starts',
  'No updater runs next to this instance, so it is updated by hand on the server. Installations made with install.sh have one.':
    'Neben dieser Instanz läuft kein Updater, sie wird also von Hand auf dem Server aktualisiert. Installationen mit install.sh haben einen.',
  'The database is backed up first. Cillhub restarts, which drops calls for a few seconds. If the new version does not start, the previous one comes back automatically.':
    'Zuerst wird die Datenbank gesichert. Cillhub startet neu, Anrufe brechen dabei kurz ab. Startet die neue Version nicht, kommt die vorherige automatisch zurück.',
  'The previous version was restored.': 'Die vorherige Version wurde wiederhergestellt.', 'The updater is not reachable: {error}': 'Der Updater ist nicht erreichbar: {error}',
  'Hub users with two-factor authentication may create link codes (at most 3 unused each)': 'Hub-Nutzer mit Zwei-Faktor-Authentifizierung dürfen Verknüpfungscodes erstellen (höchstens 3 unbenutzte je Person)',
  'Release Channel': 'Release-Kanal', 'Release published.': 'Release veröffentlicht.', 'Offered version': 'Angebotene Version', 'None yet': 'Noch keine',
  Published: 'Veröffentlicht', 'Offer a version': 'Version anbieten', 'Release notes': 'Versionshinweise',
  'Nodes see this version and its notes on their Updates page. The image itself comes from the signed release files under /download/server/.':
    'Nodes sehen diese Version und ihre Hinweise auf ihrer Update-Seite. Das Image selbst kommt aus den signierten Release-Dateien unter /download/server/.',
  // Screen share encoder (GPU encoding)
  'Screen Share Encoder': 'Encoder für die Bildschirmübertragung', 'not supported here': 'hier nicht unterstützt',
  'H.264 lets your graphics card encode the stream (NVENC, AMF, Quick Sync, VideoToolbox, VA-API), which saves CPU in games. VP8 and VP9 are usually encoded by the CPU. Applies the next time you share your screen.':
    'Mit H.264 kodiert deine Grafikkarte den Stream (NVENC, AMF, Quick Sync, VideoToolbox, VA-API) und entlastet in Spielen die CPU. VP8 und VP9 kodiert meist die CPU. Gilt ab der nächsten Bildschirmübertragung.',
  'GPU encoding is on in the desktop app.': 'In der Desktop-App ist die GPU-Kodierung an.',
  'Auto (AV1 on a capable graphics card, else H.264)': 'Automatisch (AV1 mit passender Grafikkarte, sonst H.264)',
  'With Clarity, AV1 keeps text sharper at the same bitrate. Auto uses it only when your graphics card encodes AV1 (NVIDIA RTX 40/50, AMD RX 7000 and newer, Intel Arc; on Windows in the desktop app). Chosen here, AV1 may be encoded by the CPU, which takes about twice the CPU of H.264. Viewers who cannot play AV1 get H.264 or VP8.':
    'Mit „Schärfe“ hält AV1 Text bei gleicher Bitrate schärfer. Automatisch nutzt es nur, wenn deine Grafikkarte AV1 kodiert (NVIDIA RTX 40/50, AMD RX 7000 und neuer, Intel Arc; unter Windows in der Desktop-App). Hier gewählt, kodiert AV1 notfalls die CPU, und das kostet etwa doppelt so viel Rechenleistung wie H.264. Wer AV1 nicht abspielen kann, bekommt H.264 oder VP8.',
  'Screen share encoder': 'Encoder (Bildschirmübertragung)', 'Screen share sent': 'Bildschirmübertragung gesendet', 'Screen share decoder': 'Decoder (Bildschirmübertragung)',
  'Screen share received': 'Bildschirmübertragung empfangen', GPU: 'GPU', software: 'Software', 'Encoder: {name}': 'Encoder: {name}',
  // automatic updates (2026-11-05)
  'Automatic updates': 'Automatische Updates', 'Automatic updates need the updater.': 'Automatische Updates brauchen den Updater.',
  'Last automatic run {when}: {decision}': 'Letzter automatischer Lauf {when}: {decision}',
  'Let the network hub ask this server to update now': 'Dem Netzwerk-Hub erlauben, diesen Server um ein sofortiges Update zu bitten',
  'Updates only ever come from signed releases; a request from the hub starts the same update as the button above.':
    'Updates kommen immer nur aus signierten Releases; eine Anfrage des Hubs startet dasselbe Update wie die Schaltfläche oben.',
  'Install updates automatically': 'Updates automatisch installieren', 'Off: I update by hand': 'Aus: Ich aktualisiere selbst',
  'Security and patch releases only (recommended)': 'Nur Sicherheits- und Patch-Releases (empfohlen)', 'All releases': 'Alle Releases',
  'Maintenance window': 'Wartungsfenster', '{h}:00 UTC ({local} your time)': '{h}:00 UTC ({local} bei dir)',
  'The database is backed up first; if the new version does not start, the previous one comes back automatically. Calls drop for a few seconds.':
    'Zuerst wird die Datenbank gesichert; startet die neue Version nicht, kommt die vorige automatisch zurück. Anrufe brechen für ein paar Sekunden ab.',
  'Updates come only from the signed releases of the Cillhub network hub. We recommend security and patch releases in a quiet hour; you can change this later on the admin Updates page.':
    'Updates kommen nur aus den signierten Releases des Cillhub-Netzwerk-Hubs. Wir empfehlen Sicherheits- und Patch-Releases zu einer ruhigen Stunde; ändern kannst du das später auf der Admin-Seite Updates.',
  'Security and patch': 'Sicherheit und Patches', 'No updater': 'Kein Updater', Rollback: 'Zurücksetzen', 'previous version restored': 'vorige Version wiederhergestellt',
  Succeeded: 'Erfolgreich', Failed: 'Fehlgeschlagen', Running: 'Läuft', 'Rolling back': 'Wird zurückgesetzt', 'Not started': 'Nicht gestartet',
  'Update failed': 'Update fehlgeschlagen', 'Ask {name} to update now?': '{name} um ein sofortiges Update bitten?',
  'The node installs the release its signed feed offers, with a backup first and an automatic rollback if it does not start. Its admin can turn these requests off.':
    'Der Node installiert das Release aus seinem signierten Feed, mit Sicherung vorab und automatischem Zurücksetzen, falls es nicht startet. Sein Admin kann solche Anfragen abschalten.',
  'Request Update': 'Update anfordern', 'The node started the update.': 'Der Node hat das Update gestartet.',
  'The node did not start the update: {reason}': 'Der Node hat das Update nicht gestartet: {reason}', unreachable: 'nicht erreichbar',
  'Latest release seen': 'Neuestes gesehenes Release', 'update available': 'Update verfügbar', 'Remote update requests': 'Update-Anfragen vom Hub',
  Allowed: 'Erlaubt', 'Turned off by the node': 'Vom Node abgeschaltet', 'Last update': 'Letztes Update', 'Last automatic run': 'Letzter automatischer Lauf',
  'Last report': 'Letzte Meldung',
  // What's New (src/whatsnew)
  "What's New": 'Neuigkeiten', Changelog: 'Änderungsprotokoll', Unreleased: 'Noch nicht veröffentlicht', Close: 'Schließen',
  // old Android app (src/android/MovedBanner.tsx)
  'Cillhub moved to a new app. Install it, log in, then uninstall this old app.': 'Cillhub ist in eine neue App umgezogen. Installiere sie, melde dich an und deinstalliere dann diese alte App.',
  'Download the new app': 'Neue App herunterladen', 'Dismiss until the app restarts': 'Bis zum nächsten App-Start ausblenden',
}
