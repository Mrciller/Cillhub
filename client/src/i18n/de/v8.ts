// German UI strings for v8 (modules): Admin › Modules, the permission review, module settings and module panels.
export const v8: Record<string, string> = {
  // Admin › Modules: list and install
  Modules: 'Module', Module: 'Modul', MODULE: 'MODUL', 'Install Module': 'Modul installieren', 'No modules installed yet.': 'Noch keine Module installiert.',
  'Modules add commands, panels and automations to every server of this instance, or to the servers you choose. Each one may only do what you approve when you install it.':
    'Module bringen Befehle, Panels und Automatisierungen auf alle Server dieser Instanz oder auf die Server, die du auswählst. Jedes darf nur, was du bei der Installation genehmigst.',
  Enabled: 'Aktiviert', 'Enable {name}': '{name} aktivieren', Starting: 'Startet', Restarting: 'Startet neu', Crashed: 'Abgestürzt',
  'Install a module': 'Modul installieren', 'Nothing is installed yet: the package is checked first and you review what it may do.':
    'Noch wird nichts installiert: Das Paket wird zuerst geprüft und du siehst dir an, was es darf.',
  'From a file': 'Aus einer Datei', 'Package (.zip or .tgz, at most 5 MB)': 'Paket (.zip oder .tgz, höchstens 5 MB)', 'Upload and Review': 'Hochladen und prüfen',
  'From a Git repository': 'Aus einem Git-Repository', 'Git URL (https://)': 'Git-URL (https://)', 'Branch or tag (optional)': 'Branch oder Tag (optional)', 'Fetch and Review': 'Abrufen und prüfen',
  'Uploading and checking the package…': 'Paket wird hochgeladen und geprüft …', 'Fetching the repository…': 'Repository wird abgerufen …',
  'Back to Modules': 'Zurück zu den Modulen', '← All modules': '← Alle Module', 'Module sections': 'Modulbereiche',
  // Detail: overview, servers, logs, update, remove
  Settings: 'Einstellungen', Logs: 'Protokoll', 'Module ID': 'Modul-ID', Author: 'Autor', Installed: 'Installiert', Updated: 'Aktualisiert', 'Running since': 'Läuft seit',
  'Events handled': 'Verarbeitete Ereignisse', Errors: 'Fehler', 'Crashes / restarts': 'Abstürze / Neustarts', 'Last error': 'Letzter Fehler', '{used} of {quota}': '{used} von {quota}',
  'Web address': 'Webadresse', Restart: 'Neu starten', 'Restarted.': 'Neu gestartet.', 'Approved permissions': 'Genehmigte Berechtigungen',
  'Where the module works': 'Wo das Modul arbeitet', 'All servers, including new ones': 'Alle Server, auch neue', 'Only the servers I choose': 'Nur die Server, die ich auswähle',
  'Chosen servers': 'Ausgewählte Server', 'No servers chosen.': 'Keine Server ausgewählt.',
  'The module’s bot joins these servers. Leaving one makes it leave.': 'Der Bot des Moduls tritt diesen Servern bei. Fällt ein Server weg, verlässt er ihn.', 'Save Servers': 'Server speichern',
  Level: 'Stufe', 'All levels': 'Alle Stufen', 'No log lines.': 'Keine Protokollzeilen.', 'Log, newest first': 'Protokoll, neueste zuerst',
  'You review what changed before anything is replaced. Settings, stored data and logs stay.': 'Du prüfst die Änderungen, bevor etwas ersetzt wird. Einstellungen, gespeicherte Daten und Protokoll bleiben.',
  'From the Git source': 'Aus der Git-Quelle', 'Check for Update': 'Nach Update suchen',
  'Remove {name}?': '{name} entfernen?', 'Remove Module': 'Modul entfernen', '{name} was removed.': '{name} wurde entfernt.',
  'Its stored data and settings are kept for a later install of the same module.': 'Gespeicherte Daten und Einstellungen bleiben für eine spätere Installation desselben Moduls erhalten.',
  'Its stored data and settings are deleted too. This cannot be undone.': 'Gespeicherte Daten und Einstellungen werden ebenfalls gelöscht. Das lässt sich nicht rückgängig machen.',
  'The module stops, its bot leaves every server and its commands disappear. Messages it sent stay.': 'Das Modul stoppt, sein Bot verlässt alle Server und seine Befehle verschwinden. Nachrichten, die es gesendet hat, bleiben.',
  'Stored data and settings': 'Gespeicherte Daten und Einstellungen', 'Keep them': 'Behalten', 'Delete them': 'Löschen', 'Type the module ID ({id}) to confirm': 'Gib zur Bestätigung die Modul-ID ({id}) ein',
  // Permission review
  'Review {name} before installing': '{name} vor der Installation prüfen', 'Review the update of {name}': 'Update von {name} prüfen', '{from} → {to}': '{from} → {to}',
  Homepage: 'Website', Package: 'Paket', '{n} files, {size}': '{n} Dateien, {size}', 'Review until': 'Prüfen bis', Warnings: 'Warnungen', 'File {name}': 'Datei {name}',
  'What it may do': 'Was es darf', 'The module can do exactly this and nothing more. Approving is all or nothing.': 'Das Modul kann genau das und nichts darüber hinaus. Du genehmigst alles oder nichts.',
  'No permissions: it can only read its own settings and the servers it is enabled in.': 'Keine Berechtigungen: Es kann nur seine eigenen Einstellungen und die Server lesen, in denen es aktiviert ist.',
  New: 'Neu', 'No longer asks for: {list}': 'Braucht nicht mehr: {list}', 'New websites: {list}': 'Neue Websites: {list}', 'Websites no longer contacted: {list}': 'Websites, die es nicht mehr kontaktiert: {list}',
  Panels: 'Panels', 'Approve and Install': 'Genehmigen und installieren', 'Approve and Update': 'Genehmigen und aktualisieren', Install: 'Installieren',
  'Install {name}?': '{name} installieren?', 'Update {name}?': '{name} aktualisieren?', '{name} was updated to {version}.': '{name} wurde auf {version} aktualisiert.',
  '{name} was installed. It starts disabled: enable it when you are ready.': '{name} wurde installiert. Es ist zunächst deaktiviert: Aktiviere es, wenn du so weit bist.',
  'Read messages': 'Nachrichten lesen', 'Send messages': 'Nachrichten senden', 'See members': 'Mitglieder sehen', 'Give and remove roles': 'Rollen vergeben und entziehen',
  'See voice activity': 'Sprachaktivität sehen', 'Store data': 'Daten speichern', 'Contact websites': 'Websites kontaktieren', 'Receive web requests': 'Webanfragen empfangen',
  'Show panels': 'Panels anzeigen', 'Run on a schedule': 'Nach Zeitplan laufen',
  'Adds its own commands and answers when people use them, and their buttons and forms.': 'Fügt eigene Befehle hinzu und antwortet, wenn jemand sie, ihre Buttons oder Formulare benutzt.',
  'Reads messages, edits, deletions and reactions in channels it can see, including older messages.': 'Liest Nachrichten, Bearbeitungen, Löschungen und Reaktionen in Kanälen, die es sehen kann, auch ältere Nachrichten.',
  'Sends messages and adds reactions where it may write. It can only edit or delete its own messages.': 'Sendet Nachrichten und Reaktionen, wo es schreiben darf. Bearbeiten oder löschen kann es nur eigene Nachrichten.',
  'Sees who joins, changes or leaves a server and can look up members.': 'Sieht, wer einem Server beitritt, sich ändert oder ihn verlässt, und kann Mitglieder nachschlagen.',
  'Gives roles to members and takes them away, only roles below its own role.': 'Gibt Mitgliedern Rollen und nimmt sie wieder weg, nur Rollen unterhalb seiner eigenen.',
  'Sees who is in which voice channel.': 'Sieht, wer in welchem Sprachkanal ist.', 'Keeps its own data on this instance (at most 5 MB).': 'Speichert eigene Daten auf dieser Instanz (höchstens 5 MB).',
  'Sends requests to these websites, and only to these:': 'Sendet Anfragen an diese Websites und nur an diese:',
  'Anyone on the internet can send requests to its web address, for example webhooks from other services:': 'Jeder im Internet kann Anfragen an seine Webadresse schicken, zum Beispiel Webhooks anderer Dienste:',
  'Shows its own panels inside the app. Panels cannot read anyone’s account or the app’s data.': 'Zeigt eigene Panels in der App. Panels können weder Konten noch Daten der App lesen.',
  'Runs tasks at set times, even when nobody uses it.': 'Führt Aufgaben zu festen Zeiten aus, auch wenn es niemand benutzt.',
  'Unknown permission. This version of the app cannot explain it.': 'Unbekannte Berechtigung. Diese Version der App kann sie nicht erklären.',
  'Side panel in channels': 'Seitenpanel in Kanälen', 'Entry above the channel list': 'Eintrag über der Kanalliste', 'Under its own messages': 'Unter seinen eigenen Nachrichten',
  // Settings
  'This module has no settings.': 'Dieses Modul hat keine Einstellungen.', 'Allow different values per server': 'Unterschiedliche Werte pro Server erlauben',
  'Edit values for server': 'Werte bearbeiten für Server', 'Values for all servers': 'Werte für alle Server', 'Values for {name}': 'Werte für {name}',
  'Empty fields use the value for all servers.': 'Leere Felder nutzen den Wert für alle Server.', 'Reset this server': 'Diesen Server zurücksetzen', 'Reset {name}?': '{name} zurücksetzen?',
  'This server uses the values for all servers again.': 'Dieser Server nutzt wieder die Werte für alle Server.', 'Reset.': 'Zurückgesetzt.',
  'Nothing changed.': 'Nichts geändert.', 'Save Settings': 'Einstellungen speichern', 'Undo Changes': 'Änderungen verwerfen',
  'A value is set': 'Ein Wert ist gesetzt', 'No value set': 'Kein Wert gesetzt', 'New value': 'Neuer Wert', 'Cleared when you save.': 'Wird beim Speichern geleert.', 'Keep the current value': 'Aktuellen Wert behalten',
  'Current value: {id}': 'Aktueller Wert: {id}', 'Choose a server first': 'Zuerst einen Server wählen', Change: 'Ändern', 'Servers found': 'Gefundene Server', 'No servers found.': 'Keine Server gefunden.',
  // Panels
  'Close {name}': '{name} schließen',
  // Server invite card in messages
  "You've been invited to join a server": 'Du wurdest auf einen Server eingeladen', 'You sent an invite to join a server': 'Du hast eine Servereinladung gesendet',
  Joined: 'Beigetreten', 'This invite has expired or was revoked.': 'Diese Einladung ist abgelaufen oder wurde widerrufen.',
  // Settings › Private Nodes and add-node links
  'Private Nodes': 'Private Nodes', 'Node address': 'Node-Adresse', 'Add node': 'Node hinzufügen', Reachable: 'Erreichbar', 'Not reachable': 'Nicht erreichbar',
  'Copy add link': 'Hinzufügen-Link kopieren', 'No private nodes saved yet.': 'Noch keine privaten Nodes gespeichert.',
  'Private nodes you use besides the Main Hub, all connected at once. Each node is a separate server with its own accounts and admins. The list is saved with your account.':
    'Private Nodes, die du neben dem Haupt-Hub nutzt, alle gleichzeitig verbunden. Jeder Node ist ein eigener Server mit eigenen Konten und Admins. Die Liste wird mit deinem Konto gespeichert.',
  'This server is already in your list.': 'Dieser Server ist schon in deiner Liste.', 'You can save up to {n} nodes.': 'Du kannst bis zu {n} Nodes speichern.',
  '{address} leaves the list on all your devices. Cillhub signs you out there and its servers leave your server list. Your account there stays as it is.':
    '{address} wird auf allen deinen Geräten aus der Liste entfernt. Cillhub meldet dich dort ab und seine Server verschwinden aus deiner Serverliste. Dein Konto dort bleibt, wie es ist.',
  'Enter only the server address, with https:// (http only for localhost), e.g. https://chat.example.org.':
    'Gib nur die Serveradresse ein, mit https:// (http nur für localhost), z. B. https://chat.example.org.',
  'Add a private node?': 'Privaten Node hinzufügen?', 'Node added': 'Node hinzugefügt', 'Invalid link': 'Ungültiger Link',
  'This link does not contain a usable node address.': 'Dieser Link enthält keine gültige Node-Adresse.',
  // Private nodes connected next to the hub
  'This is a separate server with its own accounts and admins.': 'Das ist ein eigener Server mit eigenen Konten und Admins.',
  'Cillhub signs you in there with your account here: the node gets your user name and avatar, never your password. Its servers then show up in your server list.':
    'Cillhub meldet dich dort mit deinem Konto von hier an: Der Node bekommt deinen Benutzernamen und dein Profilbild, nie dein Passwort. Seine Server erscheinen dann in deiner Serverliste.',
  'Add {name}?': '{name} hinzufügen?', 'Add and sign in': 'Hinzufügen und anmelden', 'Sign in': 'Anmelden', 'Not connected': 'Nicht verbunden',
  'Needs its own login · not connected': 'Braucht eigene Anmeldung · nicht verbunden', 'Not connected: {reason} Retrying…': 'Nicht verbunden: {reason} Neuer Versuch folgt …',
  '{name} is not reachable right now.': '{name} ist gerade nicht erreichbar.',
  'That is on another server and cannot be used here.': 'Das liegt auf einem anderen Server und kann hier nicht verwendet werden.',
  'Cut off: sent too much data': 'Getrennt: zu viele Daten gesendet',
  '{name} sent more data than Cillhub keeps for one server and was disconnected. It connects again on the next start.':
    '{name} hat mehr Daten geschickt, als Cillhub für einen Server behält, und wurde getrennt. Beim nächsten Start verbindet es sich wieder.',
  'From {instance}, a separate server. What you enter goes there.': 'Von {instance}, einem eigenen Server. Was du eingibst, geht dorthin.',
}
