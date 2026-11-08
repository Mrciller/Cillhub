// German UI strings for the v5 areas (Watch Together, noise suppression, desktop activity, Cillhub Bot, scheduling, voice status, templates).
export const v5: Record<string, string> = {
  // Watch Together
  'Watch Together': 'Gemeinsam schauen', 'Watch Together volume': 'Lautstärke „Gemeinsam schauen“', 'Mute video': 'Video stummschalten', 'Voice server': 'Sprachserver', 'Zoom is saved on this device only.': 'Der Zoom gilt nur für dieses Gerät.', 'Voice Server': 'Sprachserver', 'Instance default ({name})': 'Standard der Instanz ({name})', 'Used for new calls in this server. A call that is running keeps its voice server until everyone has left.': 'Gilt für neue Anrufe auf diesem Server. Ein laufender Anruf behält seinen Sprachserver, bis alle gegangen sind.', none: 'keiner', 'Unmute video': 'Video-Ton einschalten', 'Video volume': 'Video-Lautstärke', 'Lower while people talk': 'Leiser, wenn jemand spricht', 'Lowered volume': 'Abgesenkte Lautstärke', 'to {n} %': 'auf {n} %', 'Watching: {title}': 'Schaut: {title}', 'Join voice to watch along.': 'Tritt dem Sprachkanal bei, um mitzuschauen.',
  'This video cannot be played here.': 'Dieses Video kann hier nicht abgespielt werden.', 'Click to watch along': 'Klicke, um mitzuschauen', 'In sync': 'Synchron',
  'Syncing… ({n} s off)': 'Wird synchronisiert … ({n} s Abweichung)', 'Paste a YouTube link (youtube.com/watch, youtu.be or shorts).': 'Füge einen YouTube-Link ein (youtube.com/watch, youtu.be oder Shorts).',
  'YouTube link': 'YouTube-Link', 'Start Watching': 'Schauen starten', 'Add to Queue': 'Zur Warteschlange hinzufügen', 'Stop Watch Together?': 'Gemeinsames Schauen beenden?',
  'The video stops for everyone in {name}.': 'Das Video stoppt für alle in {name}.', Stop: 'Beenden', 'Host: {name}': 'Host: {name}', 'Control: everyone': 'Steuerung: alle',
  'Close Watch Together': 'Gemeinsam schauen schließen', 'The queue is empty. Add a video to keep watching.': 'Die Warteschlange ist leer. Füge ein Video hinzu, um weiterzuschauen.',
  'Playback controls': 'Wiedergabesteuerung', Pause: 'Pause', Play: 'Abspielen', 'Only the host controls playback': 'Nur der Host steuert die Wiedergabe', 'Next video': 'Nächstes Video',
  Seek: 'Spulen', Queue: 'Warteschlange', 'Now playing': 'Läuft gerade', 'added by {name}': 'hinzugefügt von {name}', 'Remove {title} from the queue': '{title} aus der Warteschlange entfernen',
  'You need Connect and Video permission here to start Watch Together.': 'Du brauchst hier die Berechtigungen „Verbinden“ und „Video“, um gemeinsames Schauen zu starten.',
  'Could not load the YouTube player.': 'Der YouTube-Player konnte nicht geladen werden.',
  // Noise suppression
  'Standard (browser)': 'Standard (Browser)', 'Enhanced (RNNoise)': 'Erweitert (RNNoise)',
  'Standard uses your browser’s filter. Enhanced runs RNNoise on your device and removes keyboard clicks, fans and hum better; it turns the browser’s filter off. Turn suppression off for studio or XLR mics if your voice sounds crackly or static.':
    'Standard nutzt den Filter deines Browsers. Erweitert führt RNNoise auf deinem Gerät aus und entfernt Tastaturklicks, Lüfter und Brummen besser; der Browserfilter wird dabei abgeschaltet. Schalte die Unterdrückung bei Studio- oder XLR-Mikrofonen aus, wenn deine Stimme knistert oder rauscht.',
  'Enhanced noise suppression is unavailable ({reason}). Using Standard.': 'Erweiterte Rauschunterdrückung ist nicht verfügbar ({reason}). Standard wird verwendet.',
  'This browser has no AudioWorklet or WebAssembly.': 'Dieser Browser hat kein AudioWorklet oder WebAssembly.', 'RNNoise needs 48 kHz audio.': 'RNNoise braucht 48-kHz-Audio.',
  // Microphone choice and noise-removing virtual mics
  'Microphone “{name}” not found. Using the default microphone.': 'Mikrofon „{name}“ nicht gefunden. Das Standardmikrofon wird verwendet.',
  'Your chosen microphone was not found. Using the default microphone.': 'Das gewählte Mikrofon wurde nicht gefunden. Das Standardmikrofon wird verwendet.',
  'Microphone in use: {name}': 'Verwendetes Mikrofon: {name}', 'No microphone in use right now (not in a call, or muted).': 'Gerade wird kein Mikrofon verwendet (nicht in einem Anruf oder stummgeschaltet).',
  '{name} detected: Cillhub’s noise suppression and auto gain are off so they don’t fight it.': '{name} erkannt: Cillhubs Rauschunterdrückung und automatische Verstärkung sind aus, damit sie nicht dagegen arbeiten.',
  '{name} detected: you turned Cillhub’s noise suppression and auto gain back on.': '{name} erkannt: Du hast Cillhubs Rauschunterdrückung und automatische Verstärkung wieder eingeschaltet.',
  'Use Cillhub’s noise suppression and auto gain anyway': 'Cillhubs Rauschunterdrückung und automatische Verstärkung trotzdem verwenden',
  // Activity
  '{time} elapsed': '{time} vergangen',
  // Cillhub Bot
  'Cillhub Bot': 'Cillhub-Bot', 'Add Cillhub Bot': 'Cillhub-Bot hinzufügen', Giveaway: 'Gewinnspiel', Scrim: 'Scrim', 'Looking for Group': 'Suche Gruppe',
  'Built-in commands for your server: dice, reminders, giveaways, scrim rosters and looking-for-group posts. It runs inside this Cillhub server; no token leaves it.':
    'Eingebaute Befehle für deinen Server: Würfel, Erinnerungen, Gewinnspiele, Scrim-Aufstellungen und Gruppensuchen. Er läuft in diesem Cillhub-Server; kein Token verlässt ihn.',
  'Cillhub Bot is in this server. Type / in a channel to use its commands.': 'Der Cillhub-Bot ist auf diesem Server. Tippe / in einem Kanal, um seine Befehle zu nutzen.',
  'Ends {time}': 'Endet {time}', 'Ended {time}': 'Beendet {time}', 'Starts {time}': 'Beginnt {time}',
  // Scheduled messages and reminders
  'Send later': 'Später senden', 'Send Later': 'Später senden', 'Schedule Message': 'Nachricht planen', 'Message scheduled for {time}.': 'Nachricht geplant für {time}.', 'A scheduled message to {where} could not be sent.': 'Eine geplante Nachricht an {where} konnte nicht gesendet werden.', 'a channel': 'einen Kanal',
  'Sends to {where}': 'Wird gesendet an {where}', 'Pick a time in the future.': 'Wähle einen Zeitpunkt in der Zukunft.', 'Date and time': 'Datum und Uhrzeit',
  'Cancel scheduled message?': 'Geplante Nachricht abbrechen?', 'Cancel Message': 'Nachricht abbrechen', 'Cancel scheduled message': 'Geplante Nachricht abbrechen',
  'Messages you scheduled with Send later. They are sent at the chosen time.': 'Nachrichten, die du mit „Später senden“ geplant hast. Sie werden zum gewählten Zeitpunkt gesendet.',
  'No scheduled messages.': 'Keine geplanten Nachrichten.', 'Scheduled messages': 'Geplante Nachrichten', 'Edit Scheduled Message': 'Geplante Nachricht bearbeiten', Scheduled: 'Geplant',
  'Remind Me': 'Erinnere mich', Reminders: 'Erinnerungen', Reminder: 'Erinnerung', 'Reminder: {text}': 'Erinnerung: {text}', Due: 'Fällig', '{n} due': '{n} fällig',
  'No reminders. Right-click a message and pick Remind Me.': 'Keine Erinnerungen. Klicke mit rechts auf eine Nachricht und wähle „Erinnere mich“.',
  'Mark reminder done': 'Erinnerung erledigt', 'Remove reminder': 'Erinnerung entfernen', "Got it. We'll remind you {time}.": 'Alles klar. Wir erinnern dich am {time}.',
  'In 20 minutes': 'In 20 Minuten', 'In 1 hour': 'In 1 Stunde', 'In 3 hours': 'In 3 Stunden', Tomorrow: 'Morgen', 'Set Reminder': 'Erinnerung setzen', 'Custom…': 'Benutzerdefiniert …',
  'A message': 'Eine Nachricht', Keep: 'Behalten',
  Bookmarks: 'Lesezeichen', 'Bookmark Message': 'Lesezeichen setzen', 'Remove Bookmark': 'Lesezeichen entfernen', 'Message bookmarked.': 'Lesezeichen gesetzt.', 'Bookmark removed.': 'Lesezeichen entfernt.',
  'No bookmarks yet. Click the bookmark icon on any message to save it here.': 'Noch keine Lesezeichen. Klicke auf das Lesezeichen-Symbol bei einer Nachricht, um sie hier zu speichern.',
  // Voice channel status
  'Set Channel Status': 'Kanalstatus festlegen', 'Edit Channel Status': 'Kanalstatus bearbeiten', 'Clear Channel Status': 'Kanalstatus löschen', Status: 'Status',
  'What’s happening here? e.g. Scrim vs Team X': 'Was ist hier los? z. B. Scrim gegen Team X', 'Edit channel status': 'Kanalstatus bearbeiten', 'Set a channel status': 'Kanalstatus festlegen',
  // Templates
  'Server Template': 'Servervorlage', 'Delete Template': 'Vorlage löschen', 'Anyone with the link can no longer use it.': 'Niemand kann den Link danach noch verwenden.',
  'Link copied.': 'Link kopiert.', 'A template copies roles, channels, categories, permissions and settings into a new server. Messages and members are not included.':
    'Eine Vorlage kopiert Rollen, Kanäle, Kategorien, Berechtigungen und Einstellungen in einen neuen Server. Nachrichten und Mitglieder sind nicht enthalten.',
  'Template {name}': 'Vorlage {name}', 'Template Link': 'Vorlagenlink', 'Used {n} times': '{n}-mal verwendet', 'Last synced {time}': 'Zuletzt synchronisiert {time}',
  'This template has unsynced changes.': 'Diese Vorlage hat nicht synchronisierte Änderungen.', 'Template synced.': 'Vorlage synchronisiert.', 'Sync Template': 'Vorlage synchronisieren',
  'Template Title': 'Vorlagentitel', 'Template Description': 'Vorlagenbeschreibung', 'Generate Template': 'Vorlage erstellen', 'Export Server': 'Server exportieren',
  'Download the same snapshot as a JSON file, as a backup or to create a copy with "Create from file".': 'Lade denselben Schnappschuss als JSON-Datei herunter, als Sicherung oder um mit „Aus Datei erstellen“ eine Kopie anzulegen.',
  'Create from template': 'Aus Vorlage erstellen', 'Template link or code': 'Vorlagenlink oder -code', 'Create Server': 'Server erstellen', 'Preview Template': 'Vorlage ansehen',
  'Create from file': 'Aus Datei erstellen', 'Server export (.json)': 'Serverexport (.json)', 'Import Server': 'Server importieren', '{roles} roles, {channels} channels': '{roles} Rollen, {channels} Kanäle',
  'This file is not valid JSON.': 'Diese Datei ist kein gültiges JSON.', 'This file is not a Cillhub server export.': 'Diese Datei ist kein Cillhub-Serverexport.',
  'This export has too many roles or channels.': 'Dieser Export hat zu viele Rollen oder Kanäle.', 'This export has a broken role or channel.': 'Dieser Export enthält eine fehlerhafte Rolle oder einen fehlerhaften Kanal.',
  // starter templates (templates/starters.ts)
  'Start from a template': 'Mit einer Vorlage starten', 'Use Template': 'Vorlage verwenden', 'Template links from other chat apps work too; their channels, categories, roles and permissions are copied.': 'Vorlagen-Links aus anderen Chat-Apps funktionieren auch; Kanäle, Kategorien, Rollen und Berechtigungen werden übernommen.', Template: 'Vorlage', Gaming: 'Gaming', 'Hang out and play together.': 'Abhängen und zusammen spielen.',
  'Esports Team': 'E-Sport-Team', 'Practice, scrims and match days, with staff and player roles.': 'Training, Scrims und Spieltage, mit Rollen für Staff und Spieler.',
  Friends: 'Freunde', 'A small place for your group.': 'Ein kleiner Ort für eure Gruppe.', 'Study Group': 'Lerngruppe', 'Notes, homework help and quiet study rooms.': 'Notizen, Hausaufgabenhilfe und ruhige Lernräume.',
  Community: 'Community', 'Announcements, discussion and moderators.': 'Ankündigungen, Diskussionen und Moderatoren.',
  'Text Channels': 'Textkanäle', 'Voice Channels': 'Sprachkanäle', Information: 'Informationen', Team: 'Team', Staff: 'Staff', Welcome: 'Willkommen', Discussion: 'Diskussion', Moderators: 'Moderatoren',
  Coach: 'Coach', Player: 'Spieler', Sub: 'Ersatz', Moderator: 'Moderator',
  general: 'allgemein', 'clips-and-highlights': 'clips-und-highlights', 'looking-for-group': 'mitspieler-gesucht', announcements: 'ankündigungen', schedule: 'zeitplan',
  strategy: 'strategie', 'vod-review': 'vod-analyse', fans: 'fans', 'staff-chat': 'staff-chat', memes: 'memes', plans: 'pläne', 'homework-help': 'hausaufgabenhilfe',
  resources: 'material', rules: 'regeln', introductions: 'vorstellungen', ideas: 'ideen', 'mod-chat': 'mod-chat',
  Lobby: 'Lobby', AFK: 'AFK', 'Team Comms': 'Team-Funk', 'Staff Meeting': 'Staff-Meeting', Hangout: 'Treffpunkt',
  'Stream Room': 'Stream-Raum', 'Study Room 1': 'Lernraum 1', 'Study Room 2': 'Lernraum 2', Lounge: 'Lounge', Events: 'Events',
}
