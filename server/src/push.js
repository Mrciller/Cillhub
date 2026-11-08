// Web Push (RFC 8030/8291/8292 via web-push): VAPID keys, subscriptions, and who gets pushed when
import webpush from 'web-push';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, get, all, run, userById } from './db.js';
import { isActive } from './gateway.js';
import { notifies } from './userdata.js';
import { blockedEither } from './routes/relationships.js';
import { safeFetch } from './ssrf.js';
import { fcmEnabled, sendFcm } from './fcm.js';
import { relayPush } from './federation.js';

// generated once per installation; 'wx' keeps a concurrent first start from overwriting it
const KEY_FILE = join(DATA_DIR, 'vapid.json');
function loadKeys() {
  try { return JSON.parse(readFileSync(KEY_FILE, 'utf8')); } catch { /* first start */ }
  try { writeFileSync(KEY_FILE, JSON.stringify(webpush.generateVAPIDKeys()), { flag: 'wx', mode: 0o600 }); } catch { /* lost the race */ }
  return JSON.parse(readFileSync(KEY_FILE, 'utf8'));
}
const KEYS = loadKeys();
export const vapidPublicKey = KEYS.publicKey;
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@cillhub.invalid';

const truncate = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

// encrypted (aes128gcm) and VAPID-signed; the endpoint is user-supplied, so it goes through the SSRF guard
async function deliver(sub, payload) {
  let details;
  try {
    details = webpush.generateRequestDetails({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), {
      vapidDetails: { subject: SUBJECT, publicKey: KEYS.publicKey, privateKey: KEYS.privateKey }, TTL: 3600, contentEncoding: 'aes128gcm',
    });
    const res = await safeFetch(details.endpoint, { method: 'POST', headers: details.headers, body: details.body, maxBytes: 4096, timeout: 10_000 });
    if (res.status === 404 || res.status === 410) run('DELETE FROM push_subscriptions WHERE endpoint = ?', sub.endpoint);
  } catch (e) {
    console.error(`push failed: ${e.message}`); // never log the endpoint: it is a capability URL
  }
}

// Android app registrations (FCM) share the table: endpoint 'fcm:<registration token>', empty keys
async function deliverFcm(sub, data, ttl) {
  if (await sendFcm(sub.endpoint.slice(4), data, ttl) === 'gone') run('DELETE FROM push_subscriptions WHERE endpoint = ?', sub.endpoint);
}

// payload {title, body, url, tag} to every subscription of these users, unless they are active or the channel's settings say no.
// fcm: the data message for the Android app (ids only); without it the app gets the payload as a plain notice.
export function pushTo(userIds, ch, kind, payload, fcm) {
  const out = { ...payload, body: truncate(payload.body ?? '', 100) };
  const data = fcm ?? { type: 'notice', title: out.title, body: out.body, url: out.url };
  for (const id of userIds) {
    if (isActive(id)) continue;
    if (ch && [10, 11, 12].includes(ch.type)) {
      const tm = get('SELECT flags FROM thread_members WHERE channel_id = ? AND user_id = ?', ch.id, id);
      if (tm) {
        if (tm.flags === 2) continue;
        if (tm.flags === 1 && kind !== 'user') continue;
      }
    }
    if (ch && !notifies(id, ch, kind)) continue;
    relayPush(id, out, data); // v7 node: a linked hub account also gets it through the hub (signed NOTIFY)
    for (const sub of all('SELECT * FROM push_subscriptions WHERE user_id = ?', id)) {
      if (!sub.endpoint.startsWith('fcm:')) deliver(sub, out);
      else if (fcmEnabled) deliverFcm(sub, data, data.type === 'call' ? 60 : 3600);
    }
  }
}

// a stored message: DMs (every message) and guild mentions; nothing from someone the recipient blocked or who blocked them
export function notifyMessage(ch, m, kinds) {
  const author = userById(m.author_id);
  const name = author ? author.global_name ?? author.username : 'Someone';
  const body = m.content || (all('SELECT 1 FROM attachments WHERE message_id = ?', m.id).length ? 'sent an attachment' : '');
  const where = ch.guild_id ? `${name} (#${ch.name ?? 'channel'})` : ch.type === 3 ? `${name} (${ch.name ?? 'group'})` : name;
  for (const [id, kind] of kinds) {
    if (!m.webhook_id && blockedEither(m.author_id, id)) continue;
    pushTo([id], ch, kind, { title: where, body, url: `/channels/${ch.guild_id ?? '@me'}/${ch.id}/${m.id}`, tag: ch.id }, { type: 'message', channel_id: ch.id, message_id: m.id });
  }
}
