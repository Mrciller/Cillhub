// TOTP (RFC 6238 over RFC 4226 HOTP): HMAC-SHA1, 6 digits, 30 s steps, ±1 step; secrets sealed with AES-256-GCM
import { createHmac, createCipheriv, createDecipheriv, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './db.js';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(s) {
  const clean = s.toUpperCase().replace(/[\s=-]/g, '');
  if (!/^[A-Z2-7]+$/.test(clean)) return null;
  let bits = 0, value = 0;
  const out = [];
  for (const c of clean) {
    value = (value << 5) | B32.indexOf(c);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export function hotp(key, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', key).update(msg).digest();
  const o = h[19] & 0xf;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export const STEP = 30_000;
// the time step the code matches within ±1 step, or null; the caller rejects steps it has already accepted (replay)
export function totpStep(key, code, now = Date.now()) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const t = Math.floor(now / STEP);
  for (const step of [t - 1, t, t + 1]) {
    if (timingSafeEqual(Buffer.from(hotp(key, step)), Buffer.from(code))) return step;
  }
  return null;
}

// sealing key for TOTP secrets and backup-code HMACs, generated once like media-proxy.key; keep it with the data
const KEY_FILE = join(DATA_DIR, 'mfa.key');
function loadKey() {
  try { return readFileSync(KEY_FILE); } catch { /* first start */ }
  try { writeFileSync(KEY_FILE, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch { /* lost the race */ }
  return readFileSync(KEY_FILE);
}
const KEY = loadKey();

export function seal(secret) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(secret), c.final()]);
  return [iv, c.getAuthTag(), data].map(b => b.toString('base64url')).join('.');
}
export function unseal(sealed) {
  const [iv, tag, data] = sealed.split('.').map(x => Buffer.from(x, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}

// backup codes: 8 chars [a-z0-9], stored as keyed HMACs
const ALPHA = 'abcdefghijklmnopqrstuvwxyz0123456789';
export const newBackupCode = () => Array.from({ length: 8 }, () => ALPHA[randomInt(ALPHA.length)]).join('');
export const backupHash = (userId, code) => createHmac('sha256', KEY).update(`${userId}:${code.toLowerCase().replace(/[\s-]/g, '')}`).digest('hex');
