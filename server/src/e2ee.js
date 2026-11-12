// Encrypted DMs: the server only stores and checks shapes. It never sees a key that opens a message, except the message
// keys a reporter hands over (report reveal), which it checks against the stored key commitment before decrypting.
import { createDecipheriv, createHash, createPublicKey, timingSafeEqual } from 'node:crypto';
import { get, all } from './db.js';
import { HttpError, invalid } from './errors.js';

export const PLACEHOLDER = 'Encrypted message. Update the app to read it.';
export const ENVELOPE_MAX = 16384; // characters of the stored envelope JSON
export const MAX_FILES = 10;
export const MAX_REVEAL = 10; // context messages next to the reported one

// canonical base64url without padding, decoded to between min and max bytes; null otherwise
export function bytes(v, min, max = min) {
  if (typeof v !== 'string' || v.length > Math.ceil(max * 4 / 3) || !/^[A-Za-z0-9_-]*$/.test(v)) return null;
  const b = Buffer.from(v, 'base64url');
  return b.length >= min && b.length <= max && b.toString('base64url') === v ? b : null;
}

// a raw uncompressed P-256 point (65 bytes, 0x04 first) that is really on the curve
export function publicKey(v) {
  const b = bytes(v, 65);
  if (!b || b[0] !== 4) return null;
  try {
    createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b.subarray(1, 33).toString('base64url'), y: b.subarray(33).toString('base64url') }, format: 'jwk' });
    return v;
  } catch { return null; }
}

const exactKeys = (o, keys) => !!o && typeof o === 'object' && !Array.isArray(o) && Object.keys(o).length === keys.length && keys.every(k => k in o);
function parsed(v, max) {
  if (typeof v !== 'string' || v.length > max) return null;
  try { return JSON.parse(v); } catch { return null; }
}

// backup of the account private key: {"v":1,"n":iv12,"c":AES-GCM(PKCS8)}, stored as given
export function backupField(v) {
  const o = parsed(v, 1024);
  if (!exactKeys(o, ['v', 'n', 'c']) || o.v !== 1 || !bytes(o.n, 12) || !bytes(o.c, 48, 512)) throw invalid('backup', 'E2EE_BACKUP_INVALID', 'Not a valid key backup.');
  return JSON.stringify({ v: 1, n: o.n, c: o.c });
}

// one member's wrapped channel key (v2): {"by":wrapper's user id,"eph":P-256 public key,"n":iv12,"c":AES-GCM(32-byte key)}.
// The wrap key mixes in ECDH(by's account key, member), so only `by` can make a wrap that opens; `by` must be the caller.
export function wrapField(v, field, by) {
  const o = parsed(v, 600);
  if (!exactKeys(o, ['by', 'eph', 'n', 'c']) || typeof o.by !== 'string' || !/^\d{1,20}$/.test(o.by) || !publicKey(o.eph) || !bytes(o.n, 12) || !bytes(o.c, 48)) {
    throw invalid(field, 'E2EE_WRAP_INVALID', 'Not a valid wrapped key.');
  }
  if (o.by !== by) throw invalid(field, 'E2EE_WRAP_BY', 'A wrap must be made by the caller.');
  return JSON.stringify({ by: o.by, eph: o.eph, n: o.n, c: o.c });
}

// {"v":1,"e":epoch,"n":nonce24,"c":ciphertext,"kc":commitment}; e must be the channel's current epoch
export function envelopeField(v, epoch) {
  const bad = msg => invalid('e2ee_envelope', 'E2EE_ENVELOPE_INVALID', msg);
  if (!exactKeys(v, ['v', 'e', 'n', 'c', 'kc']) || v.v !== 1) throw bad('Not a valid encrypted message.');
  if (v.e !== epoch) throw new HttpError(409, 50300, 'The conversation has a newer key. Reload it and send again.');
  if (!bytes(v.n, 24) || !bytes(v.kc, 32) || !bytes(v.c, 16, ENVELOPE_MAX)) throw bad('Not a valid encrypted message.');
  const out = { v: 1, e: epoch, n: v.n, c: v.c, kc: v.kc };
  if (JSON.stringify(out).length > ENVELOPE_MAX) throw bad(`At most ${ENVELOPE_MAX} characters.`);
  return out;
}

export const isEncrypted = ch => (ch?.e2ee_epoch ?? 0) > 0;
export const refused = what => new HttpError(400, 50301, `${what} are not available in encrypted conversations.`);

// a member left: the current key must not reach new messages, so a sender renews it first (409, the client rotates)
export function checkWrapsCurrent(ch) {
  const stale = get(`SELECT 1 FROM dm_keys k WHERE k.channel_id = ? AND k.epoch = ?
    AND NOT EXISTS (SELECT 1 FROM dm_recipients d WHERE d.channel_id = k.channel_id AND d.user_id = k.user_id)`, ch.id, ch.e2ee_epoch);
  if (stale) throw new HttpError(409, 50302, 'A member left this conversation. Its key must be renewed before sending.');
}

export const wrappedUsers = (channelId, epoch) => all('SELECT user_id FROM dm_keys WHERE channel_id = ? AND epoch = ?', channelId, epoch).map(r => r.user_id);

function payload(text) {
  const p = JSON.parse(text);
  const okStr = (s, max) => typeof s === 'string' && s.length <= max;
  const okInt = n => n === undefined || n === null || (Number.isSafeInteger(n) && n >= 0);
  if (!p || typeof p !== 'object' || Array.isArray(p) || !okStr(p.content ?? '', 2000)) return null;
  const files = p.files ?? [];
  if (!Array.isArray(files) || files.length > MAX_FILES) return null;
  for (const f of files) {
    if (!f || typeof f !== 'object' || !okStr(f.id, 20) || !bytes(f.k, 32) || !bytes(f.n, 12) || !okStr(f.name ?? '', 256)
      || !okStr(f.type ?? '', 128) || !okInt(f.size) || !okInt(f.w) || !okInt(f.h)) return null;
  }
  return {
    content: p.content ?? '',
    files: files.map(f => ({ id: f.id, k: f.k, n: f.n, name: f.name ?? '', type: f.type ?? '', size: f.size ?? null, ...(f.w != null && { w: f.w, h: f.h ?? null }) })),
  };
}

// a reporter's message key for a stored envelope message: SHA-256(mk || nonce24) must equal kc, then AES-GCM with the
// AAD from the stored channel and author. The payload, or null when anything does not hold.
export function openWithKey(m, mkB64) {
  const env = parsed(m.e2ee_envelope, ENVELOPE_MAX);
  const mk = bytes(mkB64, 32);
  const n = env && bytes(env.n, 24), kc = env && bytes(env.kc, 32), c = env && bytes(env.c, 16, ENVELOPE_MAX);
  if (!mk || !n || !kc || !c) return null;
  if (!timingSafeEqual(createHash('sha256').update(mk).update(n).digest(), kc)) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', mk, n.subarray(0, 12));
    d.setAAD(Buffer.from(`${m.channel_id}|${m.author_id}`, 'utf8'));
    d.setAuthTag(c.subarray(c.length - 16));
    return payload(Buffer.concat([d.update(c.subarray(0, c.length - 16)), d.final()]).toString('utf8'));
  } catch { return null; }
}
