// "Insert template" in Admin → Instance Settings → Legal: a starting point built from the operator fields and from what
// this instance has switched on. Facts about how Cillhub handles data are stated; what the operator must decide is a
// [placeholder in brackets]. Not legal advice: the operator checks and completes the text.
import type { Features, LegalDocId, Operator } from './api'

type Lang = 'en' | 'de'
const P = (en: string, de: string) => (lang: Lang) => `[${lang === 'de' ? de : en}]`
const ph = {
  name: P('name of the operator', 'Name des Betreibers'), address: P('postal address', 'Anschrift'), email: P('contact email', 'Kontakt-E-Mail'),
  retention: P('retention period', 'Speicherdauer'), host: P('hosting provider and location', 'Hosting-Anbieter und Standort'),
  logs: P('how long the web server keeps access logs with IP addresses', 'wie lange der Webserver Zugriffsprotokolle mit IP-Adressen speichert'),
  authority: P('data protection authority, e.g. Österreichische Datenschutzbehörde, Barichgasse 40-42, 1030 Wien', 'Datenschutzbehörde, z. B. Österreichische Datenschutzbehörde, Barichgasse 40-42, 1030 Wien'),
  law: P('applicable law and place of jurisdiction', 'anwendbares Recht und Gerichtsstand'),
  rules: P('house rules of this server', 'Hausregeln dieses Servers'),
}

const lines = (...xs: (string | false | null | undefined)[]) => xs.filter((x): x is string => typeof x === 'string').join('\n')

function imprint(o: Operator, lang: Lang) {
  const de = lang === 'de'
  const addr = (o.address ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  return lines(
    de ? '# Impressum' : '# Imprint',
    de ? 'Angaben nach § 5 ECG, § 25 MedienG (Österreich) und § 5 DDG (Deutschland), soweit anwendbar.' : 'Information under § 5 ECG and § 25 MedienG (Austria) and § 5 DDG (Germany), where they apply.',
    '',
    `**${o.name || ph.name(lang)}**`,
    o.legal_form && o.legal_form,
    ...(addr.length ? addr : [ph.address(lang)]),
    '',
    `${de ? 'E-Mail' : 'Email'}: ${o.email || ph.email(lang)}`,
    o.phone && `${de ? 'Telefon' : 'Phone'}: ${o.phone}`,
    o.register && `${de ? 'Registernummer' : 'Register number'}: ${o.register}`,
    o.representatives && `${de ? 'Vertretungsbefugt' : 'Represented by'}: ${o.representatives.replace(/\n/g, ', ')}`,
    o.authority && `${de ? 'Aufsichtsbehörde' : 'Supervisory authority'}: ${o.authority}`,
    '',
    de ? '## Offenlegung nach § 25 MedienG' : '## Disclosure under § 25 MedienG',
    `${de ? 'Medieninhaber' : 'Media owner'}: ${o.name || ph.name(lang)}${addr.length ? `, ${addr.join(', ')}` : ''}`,
    `${de ? 'Grundlegende Richtung' : 'Editorial line'}: ${o.purpose || (de ? 'Betrieb eines Chat-Dienstes für die eigenen Nutzerinnen und Nutzer; Inhalte stammen von ihnen.' : 'Running a chat service for its users; the content comes from them.')}`,
    '',
    de ? '## Kontakt für Nutzer und Behörden' : '## Contact for users and authorities',
    de
      ? `Zentrale Kontaktstelle nach Art. 11 und 12 Digital Services Act und Kontaktstelle nach Art. 15 der Verordnung (EU) 2021/784: ${o.email || ph.email(lang)}. Sprachen: ${o.languages || 'Deutsch, Englisch'}.`
      : `Single point of contact under Art. 11 and 12 Digital Services Act and contact point under Art. 15 of Regulation (EU) 2021/784: ${o.email || ph.email(lang)}. Languages: ${o.languages || 'German, English'}.`,
    de ? 'Rechtswidrige Inhalte kann jede Person auch ohne Konto über das Formular „Rechtswidrige Inhalte melden“ melden.' : 'Anyone can report illegal content, also without an account, with the form "Report illegal content".',
  )
}

function privacy(o: Operator, f: Features, lang: Lang) {
  const de = lang === 'de'
  const third: string[] = []
  if (f.captcha) third.push(de
    ? '- **Google reCAPTCHA** (Google Ireland Ltd.): bei Registrierung, Passwort-Zurücksetzen und Meldeformular lädt dein Browser das Captcha von Google; Google erhält dabei deine IP-Adresse und Browserdaten, der Server sendet das Captcha-Ergebnis und deine IP-Adresse zur Prüfung. Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (Schutz vor Missbrauch). Eine Übermittlung in die USA ist möglich (EU-US Data Privacy Framework).'
    : '- **Google reCAPTCHA** (Google Ireland Ltd.): at sign-up, password reset and on the notice form your browser loads the captcha from Google, which receives your IP address and browser data; the server sends the captcha result and your IP address for checking. Legal basis: Art. 6(1)(f) GDPR (protection against abuse). Data may go to the USA (EU-US Data Privacy Framework).')
  if (f.watch_together) third.push(de
    ? '- **YouTube** (Google Ireland Ltd.): Link-Vorschauen holt der Server; das Video lädt erst, wenn du es startest. „Watch Together“ fragt vor dem Laden des YouTube-Players nach; danach erhält Google deine IP-Adresse und Browserdaten.'
    : '- **YouTube** (Google Ireland Ltd.): the server fetches link previews; a video loads only when you start it. Watch Together asks before it loads the YouTube player; after that Google receives your IP address and browser data.')
  if (f.gif_provider) third.push(de
    ? `- **${f.gif_provider === 'giphy' ? 'GIPHY' : 'Tenor (Google)'}**: deine GIF-Suchbegriffe gehen über den Server an den Anbieter; deine IP-Adresse nicht, die Bilder kommen über den Server.`
    : `- **${f.gif_provider === 'giphy' ? 'GIPHY' : 'Tenor (Google)'}**: your GIF search terms go to the provider through the server, not your IP address; images come through the server.`)
  third.push(de
    ? '- **Push-Dienst deines Browsers** (z. B. Google, Mozilla, Apple): nur wenn du Benachrichtigungen einschaltest; der Inhalt ist verschlüsselt.'
    : "- **Your browser's push service** (e.g. Google, Mozilla, Apple): only when you turn on notifications; the content is encrypted.")
  if (f.fcm) third.push(de
    ? '- **Firebase Cloud Messaging** (Google): Benachrichtigungen an die Android-App; bei Nachrichten nur Kennungen, keine Inhalte.'
    : '- **Firebase Cloud Messaging** (Google): notifications to the Android app; for messages only ids, no content.')
  if (f.module_hosts.length) third.push(de
    ? `- **Server-Module**: installierte Module dürfen diese Adressen ansprechen: ${f.module_hosts.join(', ')} [Zweck und Daten je Modul].`
    : `- **Server modules**: installed modules may contact these hosts: ${f.module_hosts.join(', ')} [purpose and data per module].`)
  third.push(de
    ? '- **Bots** von Server-Besitzern erhalten die Nachrichten und Interaktionen in den Servern, in die sie eingeladen wurden.'
    : '- **Bots** added by server owners receive the messages and interactions of the servers they were added to.')
  if (f.federation.role === 'hub') third.push(de
    ? '- **Verbundene Nodes**: Server auf Nodes werden von anderen Betreibern betrieben. Wenn du einen Node-Server öffnest oder dich dort mit diesem Konto anmeldest, gehen deine IP-Adresse, dein Profil und deine Beiträge dort an dessen Betreiber; für ihn gilt dessen Datenschutzerklärung.'
    : '- **Connected nodes**: servers on nodes are run by other operators. When you open a node server or sign in there with this account, your IP address, profile and posts there go to that operator, under its own privacy notice.')
  if (f.federation.mode === 'connected') third.push(de
    ? '- **Hub-Anmeldung**: dieser Server ist mit einem Hub verbunden; meldest du dich über den Hub an, erhalten wir von dort deinen Benutzernamen und dein Profilbild.'
    : '- **Hub sign-in**: this server is linked to a hub; when you sign in through the hub, we receive your username and avatar from it.')

  return lines(
    de ? '# Datenschutzerklärung' : '# Privacy notice',
    '',
    de ? '## Verantwortlicher' : '## Controller',
    `${o.name || ph.name(lang)}, ${(o.address ?? '').replace(/\n/g, ', ') || ph.address(lang)}, ${o.email || ph.email(lang)}`,
    '',
    de ? '## Welche Daten wir verarbeiten und warum' : '## What we process and why',
    de
      ? '- **Konto**: E-Mail-Adresse, Benutzername, Passwort (nur als Hash), Zwei-Faktor- und Passkey-Daten, Anmelde-Tokens (ohne IP-Adresse und Gerätedaten). Zweck: dein Konto. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO (Vertrag).'
      : '- **Account**: email address, username, password (hash only), two-factor and passkey data, login tokens (without IP address or device data). Purpose: your account. Legal basis: Art. 6(1)(b) GDPR (contract).',
    de
      ? '- **Profil und Inhalte**: Profilbild, Banner, Bio, Nachrichten, Dateien, Reaktionen, Umfragen, Lesezeichen, Erinnerungen, geplante Nachrichten. Zweck: der Chat-Dienst. Rechtsgrundlage: Art. 6 Abs. 1 lit. b DSGVO.'
      : '- **Profile and content**: avatar, banner, bio, messages, files, reactions, polls, bookmarks, reminders, scheduled messages. Purpose: the chat service. Legal basis: Art. 6(1)(b) GDPR.',
    de
      ? `- **IP-Adressen**: der Server hält sie nur im Arbeitsspeicher, um Anfragen zu begrenzen; das Admin-Protokoll speichert sie nur als Schlüssel-Hash. Der vorgeschaltete Webserver speichert ${ph.logs(lang)}. Rechtsgrundlage: Art. 6 Abs. 1 lit. f DSGVO (Sicherheit).`
      : `- **IP addresses**: the server keeps them in memory only, to limit requests; the admin log stores only a keyed hash. The web server in front stores ${ph.logs(lang)}. Legal basis: Art. 6(1)(f) GDPR (security).`,
    de
      ? '- **Sprache und Video** laufen über unseren eigenen Server und werden nicht aufgezeichnet.'
      : '- **Voice and video** run through our own server and are not recorded.',
    f.link_previews && (de
      ? '- **Link-Vorschauen und externe Bilder** holt der Server selbst und speichert Bilder bis zu 7 Tage zwischen; die fremde Seite sieht nur die Adresse des Servers.'
      : '- **Link previews and external images** are fetched by the server, which caches images for up to 7 days; the other site only sees the server\'s address.'),
    de
      ? `- **Meldungen und Moderation**: Meldungen (mit einer Kopie der gemeldeten Nachricht), Meldungen über das öffentliche Formular (Name und E-Mail der meldenden Person), Moderationsentscheidungen und Einsprüche. Zweck: Pflichten nach dem Digital Services Act. Rechtsgrundlage: Art. 6 Abs. 1 lit. c und f DSGVO. Gespeichert ${ph.retention(lang)}; entfernte Inhalte nach einer Entfernungsanordnung 6 Monate (Verordnung (EU) 2021/784).`
      : `- **Reports and moderation**: reports (with a copy of the reported message), notices from the public form (the notifier's name and email), moderation decisions and appeals. Purpose: duties under the Digital Services Act. Legal basis: Art. 6(1)(c) and (f) GDPR. Kept ${ph.retention(lang)}; content removed on a removal order for 6 months (Regulation (EU) 2021/784).`,
    f.mail && (de
      ? '- **E-Mails**: zum Zurücksetzen des Passworts und für Rückmeldungen zu Meldungen. [Name des E-Mail-Anbieters]'
      : '- **Emails**: for password resets and answers to notices. [name of the mail provider]'),
    '',
    de ? '## Speicher im Gerät' : '## Storage on your device',
    de
      ? 'Wir setzen keine Cookies. Im lokalen Speicher deines Browsers liegen dein Anmelde-Token und deine Einstellungen (Sprache, Design, Lautstärken); das ist für den Dienst nötig.'
      : 'We set no cookies. Your browser\'s local storage holds your login token and your settings (language, theme, volumes); the service needs them.',
    '',
    de ? '## Empfänger und Dienste Dritter' : '## Recipients and third-party services',
    `${de ? 'Hosting' : 'Hosting'}: ${ph.host(lang)} (${de ? 'Auftragsverarbeiter' : 'processor'}).`,
    ...third,
    '',
    de ? '## Speicherdauer' : '## How long we keep data',
    de
      ? `Kontodaten, bis du dein Konto löschst. Beim Löschen werden private Daten entfernt und dein Profil anonymisiert; deine Nachrichten bleiben als „Gelöschter Benutzer“ stehen, du kannst sie vorher selbst löschen. Inaktive Konten: ${ph.retention(lang)}.`
      : `Account data until you delete your account. Deleting removes your private data and anonymises your profile; your messages stay as "Deleted User", and you can delete them yourself beforehand. Inactive accounts: ${ph.retention(lang)}.`,
    '',
    de ? '## Deine Rechte' : '## Your rights',
    de
      ? `Auskunft, Berichtigung, Löschung, Einschränkung, Datenübertragbarkeit und Widerspruch (Art. 15-21 DSGVO). Eine Kopie deiner Daten lädst du unter Einstellungen → Mein Konto herunter; dort löschst du auch dein Konto. Beschwerden: ${ph.authority(lang)}.`
      : `Access, rectification, erasure, restriction, portability and objection (Art. 15-21 GDPR). Download a copy of your data in Settings → My Account, where you can also delete your account. Complaints: ${ph.authority(lang)}.`,
    '',
    de ? '## Mindestalter' : '## Minimum age',
    de ? 'Die Anmeldung ist ab dem bei der Registrierung genannten Alter erlaubt.' : 'Sign-up is allowed from the age named at registration.',
  )
}

function terms(o: Operator, f: Features, lang: Lang) {
  const de = lang === 'de'
  return lines(
    de ? '# Nutzungsbedingungen' : '# Terms of use',
    '',
    de ? `Diese Bedingungen gelten für die Nutzung dieses Servers, betrieben von ${o.name || ph.name(lang)}.` : `These terms apply to the use of this server, run by ${o.name || ph.name(lang)}.`,
    '',
    de ? '## Konto' : '## Account',
    de ? '- Ein Konto pro Person; halte deine Anmeldedaten geheim.\n- Du musst das bei der Registrierung genannte Mindestalter erreicht haben.' : '- One account per person; keep your login secret.\n- You must have reached the minimum age named at sign-up.',
    '',
    de ? '## Was nicht erlaubt ist' : '## What is not allowed',
    de
      ? '- rechtswidrige Inhalte, insbesondere Darstellungen sexuellen Kindesmissbrauchs, terroristische Inhalte, Verhetzung, Drohungen, Urheberrechtsverletzungen\n- Belästigung, Spam, Betrug, Identitätsmissbrauch\n- Angriffe auf den Dienst oder andere Nutzer'
      : '- illegal content, in particular child sexual abuse material, terrorist content, illegal hate speech, threats, copyright infringement\n- harassment, spam, fraud, impersonation\n- attacks on the service or on other users',
    ph.rules(lang),
    '',
    de ? '## Moderation' : '## Moderation',
    de
      ? '- Server-Besitzer moderieren ihre eigenen Server (Rollen, Sperren, AutoMod).\n- Jede Person kann Nachrichten in der App melden; rechtswidrige Inhalte kann jede Person auch ohne Konto über das Formular „Rechtswidrige Inhalte melden“ melden.\n- Die Administration prüft Meldungen von Hand. Sie kann Inhalte entfernen, Mitglieder stummschalten, aus Servern entfernen oder sperren, Server aus dem Verzeichnis ausblenden oder löschen und Konten sperren.\n- Bei jeder solchen Maßnahme erhältst du eine Begründung mit Grund und Rechtsgrundlage. Du kannst innerhalb von 6 Monaten einmal Einspruch erheben; ein Mensch prüft ihn.\n- Wiederholte Verstöße führen zur Sperre des Kontos.'
      : '- Server owners moderate their own servers (roles, bans, AutoMod).\n- Anyone can report messages in the app; anyone can report illegal content, also without an account, with the form "Report illegal content".\n- The administrators review reports by hand. They can remove content, time out, remove or ban members, hide servers from the directory or delete them, and disable accounts.\n- For every such action you get a statement with the reason and the legal ground. You can appeal once within 6 months; a person reviews the appeal.\n- Repeated violations lead to the account being disabled.',
    f.federation.role === 'hub' && (de
      ? '\n## Nodes\nServer auf verbundenen Nodes betreiben andere. Für sie gelten deren eigene Bedingungen; wir können nur ihren Eintrag im Verzeichnis ausblenden oder die Verbindung trennen.'
      : '\n## Nodes\nServers on connected nodes are run by others under their own terms; we can only hide their directory listings or end the link.'),
    '',
    de ? '## Verfügbarkeit und Haftung' : '## Availability and liability',
    de ? 'Der Dienst ist kostenlos und ohne Gewähr auf ständige Verfügbarkeit. [Haftungsregelung]' : 'The service is free and without a promise of constant availability. [liability clause]',
    '',
    de ? '## Änderungen' : '## Changes',
    de ? 'Ändern sich diese Bedingungen wesentlich, fragt dich die App beim nächsten Besuch nach deiner Zustimmung. Du kannst dein Konto jederzeit löschen.' : 'If these terms change in a material way, the app asks for your consent on your next visit. You can delete your account at any time.',
    '',
    de ? '## Recht' : '## Law',
    ph.law(lang),
  )
}

export function template(doc: LegalDocId, o: Operator, f: Features, lang: Lang) {
  return doc === 'imprint' ? imprint(o, lang) : doc === 'privacy' ? privacy(o, f, lang) : terms(o, f, lang)
}
