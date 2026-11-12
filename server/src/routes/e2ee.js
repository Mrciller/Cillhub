// Encrypted DMs: account keys (public key + sealed backup) and the per-epoch channel keys wrapped for each member.
import { get, all, run, tx, channelUserIds, channelObj, userById } from '../db.js';
import { HttpError, invalid, notFound } from '../errors.js';
import { sendToUsers } from '../gateway.js';
import { publicKey, backupField, wrapField, wrappedUsers } from '../e2ee.js';
import { loadChannel } from './channels.js';

function putKeys({ user, body }) {
  const pub = publicKey(body?.public_key);
  if (!pub) throw invalid('public_key', 'E2EE_KEY_INVALID', 'Must be a raw P-256 public key (65 bytes, base64url).');
  const backup = backupField(body.backup);
  const old = get('SELECT public_key FROM user_e2ee_keys WHERE user_id = ?', user.id);
  const now = new Date().toISOString();
  tx(() => {
    run(`INSERT INTO user_e2ee_keys (user_id, public_key, backup, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET public_key = excluded.public_key, backup = excluded.backup, updated_at = excluded.updated_at`,
    user.id, pub, backup, now, now);
    // a reset: the wraps of the current epochs open only with the old key. They become tombstones ('') that no PUT wraps can
    // replace, so nobody plants a second key for this member in an epoch; senders renew the epoch instead (checkWrapsCurrent)
    if (old && old.public_key !== pub) {
      run(`UPDATE dm_keys SET wrapped = '' WHERE user_id = ? AND epoch = (SELECT c.e2ee_epoch FROM channels c WHERE c.id = dm_keys.channel_id)`, user.id);
    }
  });
  return { public_key: pub, backup };
}

function ownKeys({ user }) {
  const row = get('SELECT public_key, backup FROM user_e2ee_keys WHERE user_id = ?', user.id);
  if (!row) throw notFound(10070, 'Encryption keys');
  return { public_key: row.public_key, backup: row.backup };
}

// someone's public key, for people who share a DM with them (nobody else learns who uses encryption)
function userKeys({ user, params }) {
  const shares = params.id === user.id || get(`SELECT 1 FROM dm_recipients a JOIN dm_recipients b ON b.channel_id = a.channel_id
    WHERE a.user_id = ? AND b.user_id = ?`, user.id, params.id);
  const row = shares && get('SELECT public_key FROM user_e2ee_keys WHERE user_id = ?', params.id);
  if (!row) throw notFound(10070, 'Encryption keys');
  return { public_key: row.public_key };
}

function loadDm({ params, user }) {
  const ch = loadChannel(params.id, user);
  if (ch.type !== 1 && ch.type !== 3) throw new HttpError(400, 50024, 'Only direct messages can be encrypted');
  return ch;
}

const epochField = body => {
  const e = body?.epoch;
  if (!Number.isSafeInteger(e) || e < 1) throw invalid('epoch', 'NUMBER_TYPE_COERCE', 'Must be a positive integer.');
  return e;
};
const wrapsField = (body, ids, by) => {
  const w = body?.wraps;
  if (!w || typeof w !== 'object' || Array.isArray(w)) throw invalid('wraps', 'MODEL_TYPE_CONVERT', 'Must be an object of user id to wrapped key.');
  const keys = Object.keys(w);
  if (keys.length > ids.length || keys.some(k => !ids.includes(k))) throw invalid('wraps', 'E2EE_WRAPS_MEMBERS', 'Wraps are only for members of this conversation.');
  return keys.map(id => [id, wrapField(w[id], `wraps.${id}`, by)]);
};
const keyOwner = id => {
  const u = userById(id);
  if (!u || u.bot || u.system || u.deleted || !get('SELECT 1 FROM user_e2ee_keys WHERE user_id = ?', id)) {
    throw new HttpError(400, 50303, `${u?.username ?? 'A member'} has not set up encrypted messages.`);
  }
};
const announce = (ch, ids) => {
  const fresh = get('SELECT * FROM channels WHERE id = ?', ch.id);
  sendToUsers(ids, 'CHANNEL_UPDATE', uid => channelObj(fresh, uid));
};

// a new channel key: epoch = current + 1 (else 409), wrapped for exactly the current members, who all have a key
function putEpoch(ctx) {
  const ch = loadDm(ctx);
  const epoch = epochField(ctx.body);
  const stale = () => new HttpError(409, 50304, 'Someone renewed the key at the same time. Load it and try again.');
  if (epoch !== ch.e2ee_epoch + 1) throw stale();
  const ids = channelUserIds(ch);
  ids.forEach(keyOwner);
  const wraps = wrapsField(ctx.body, ids, ctx.user.id);
  if (wraps.length !== ids.length) throw invalid('wraps', 'E2EE_WRAPS_MEMBERS', 'Every member needs a wrapped key.');
  tx(() => {
    if (!run('UPDATE channels SET e2ee_epoch = ? WHERE id = ? AND e2ee_epoch = ?', epoch, ch.id, epoch - 1).changes) throw stale();
    for (const [id, w] of wraps) run('INSERT INTO dm_keys (channel_id, epoch, user_id, wrapped) VALUES (?, ?, ?, ?)', ch.id, epoch, id, w);
  });
  announce(ch, ids);
  return { epoch, wrapped_users: ids };
}

// wraps of the current key for members who lack one (a new group member, a member after a key reset); never overwrites
function putWraps(ctx) {
  const ch = loadDm(ctx);
  const epoch = epochField(ctx.body);
  if (epoch !== ch.e2ee_epoch) throw new HttpError(409, 50304, 'The conversation has a newer key. Load it and try again.');
  const ids = channelUserIds(ch);
  const wraps = wrapsField(ctx.body, ids, ctx.user.id);
  wraps.forEach(([id]) => keyOwner(id));
  tx(() => {
    for (const [id, w] of wraps) run('INSERT OR IGNORE INTO dm_keys (channel_id, epoch, user_id, wrapped) VALUES (?, ?, ?, ?)', ch.id, epoch, id, w);
  });
  return { epoch, wrapped_users: wrappedUsers(ch.id, epoch) };
}

// the caller's own wraps for every epoch ('' = tombstone after a key reset), who holds one for the current epoch, and whose is a tombstone
function channelKeys(ctx) {
  const ch = loadDm(ctx);
  const keys = all('SELECT epoch, wrapped FROM dm_keys WHERE channel_id = ? AND user_id = ? ORDER BY epoch DESC LIMIT 1000', ch.id, ctx.user.id);
  const stale = all(`SELECT user_id FROM dm_keys WHERE channel_id = ? AND epoch = ? AND wrapped = ''`, ch.id, ch.e2ee_epoch).map(r => r.user_id);
  return { epoch: ch.e2ee_epoch, keys, wrapped_users: wrappedUsers(ch.id, ch.e2ee_epoch), stale_users: stale };
}

const user = { userOnly: true };
export default [
  ['PUT', '/users/@me/e2ee/keys', putKeys, { ...user, rateLimit: { max: 10, windowMs: 600_000 } }],
  ['GET', '/users/@me/e2ee/keys', ownKeys, user],
  ['GET', '/users/:id/e2ee/keys', userKeys, { ...user, rateLimit: { max: 120, windowMs: 60_000 } }],
  ['PUT', '/channels/:id/e2ee/epoch', putEpoch, { ...user, rateLimit: { max: 10, windowMs: 60_000 } }],
  ['PUT', '/channels/:id/e2ee/wraps', putWraps, { ...user, rateLimit: { max: 20, windowMs: 60_000 } }],
  ['GET', '/channels/:id/e2ee/keys', channelKeys, { ...user, rateLimit: { max: 120, windowMs: 60_000 } }],
];
