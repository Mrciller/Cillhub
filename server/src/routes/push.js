// Web Push: the VAPID public key and the user's push subscriptions
import { all, run } from '../db.js';
import { invalid } from '../errors.js';
import { vapidPublicKey } from '../push.js';
import { fcmEnabled } from '../fcm.js';

const b64urlBytes = v => (typeof v === 'string' && /^[A-Za-z0-9_-]+={0,2}$/.test(v) ? Buffer.from(v, 'base64url') : null);

function endpointOf(v) {
  let u;
  try { u = new URL(v); } catch { /* invalid below */ }
  if (typeof v !== 'string' || v.length > 2048 || !u || !['https:', 'http:'].includes(u.protocol) || u.username || u.password) {
    throw invalid('endpoint', 'URL_TYPE_INVALID_URL', 'Must be a push service URL.');
  }
  return u.href;
}

// {endpoint, keys: {p256dh, auth}} as the browser's PushSubscription.toJSON() gives it; at most 10 per user
function subscribe({ body, user }) {
  const endpoint = endpointOf(body?.endpoint);
  const p256dh = b64urlBytes(body?.keys?.p256dh);
  const auth = b64urlBytes(body?.keys?.auth);
  if (p256dh?.length !== 65 || p256dh[0] !== 4) throw invalid('keys.p256dh', 'BASE_TYPE_BAD_VALUE', 'Must be an uncompressed P-256 public key.');
  if (auth?.length !== 16) throw invalid('keys.auth', 'BASE_TYPE_BAD_VALUE', 'Must be a 16-byte auth secret.');
  run(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`,
  endpoint, user.id, body.keys.p256dh, body.keys.auth, Date.now());
  const extra = all('SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 10', user.id);
  extra.forEach(r => run('DELETE FROM push_subscriptions WHERE endpoint = ?', r.endpoint));
}

// DELETE by endpoint, in the JSON body or as ?endpoint=
function unsubscribe({ body, query, user }) {
  const endpoint = endpointOf(body?.endpoint ?? query.get('endpoint'));
  run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', endpoint, user.id);
}

// Android app (FCM) registration tokens, stored as push subscriptions with endpoint 'fcm:<token>' (they count toward the 10)
function fcmToken(v) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_:-]{20,1024}$/.test(v)) throw invalid('token', 'BASE_TYPE_BAD_VALUE', 'Must be an FCM registration token.');
  return `fcm:${v}`;
}

function fcmSubscribe({ body, user }) {
  const endpoint = fcmToken(body?.token);
  run(`INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, '', '', ?)
       ON CONFLICT DO UPDATE SET user_id = excluded.user_id, created_at = excluded.created_at`, endpoint, user.id, Date.now());
  const extra = all('SELECT endpoint FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET 10', user.id);
  extra.forEach(r => run('DELETE FROM push_subscriptions WHERE endpoint = ?', r.endpoint));
}

export default [
  ['GET', '/push/fcm', () => ({ enabled: fcmEnabled }), { open: true }],
  ['POST', '/users/@me/fcm-tokens', fcmSubscribe, { userOnly: true }],
  ['DELETE', '/users/@me/fcm-tokens', ({ body, query, user }) => { run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', fcmToken(body?.token ?? query.get('token')), user.id); }, { userOnly: true }],
  ['GET', '/push/vapid-public-key', () => ({ public_key: vapidPublicKey }), { open: true }],
  ['POST', '/users/@me/push-subscriptions', subscribe, { userOnly: true }],
  ['DELETE', '/users/@me/push-subscriptions', unsubscribe, { userOnly: true }],
];
