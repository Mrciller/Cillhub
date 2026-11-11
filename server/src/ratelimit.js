// In-memory rate limits: per-route buckets with the v9 rate limit headers, and the failed-login guard
import { createHash } from 'node:crypto';
import { isIPv6 } from 'node:net';
import { HttpError } from './errors.js';

// the rate-limit identity of an address: IPv6 by /64 (one client usually holds the whole /64), expanded first so
// `a:b::5` and `a:b:0:0::6` match; IPv4 and IPv4-mapped (::ffff:1.2.3.4) stay the single IPv4 address
export function netOf(ip) {
  ip = String(ip ?? '');
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped) return mapped[1];
  const bare = ip.split('%')[0];
  if (!isIPv6(bare)) return ip;
  const groups = s => (s ? s.split(':') : []).flatMap(g => (g.includes('.') ? ['0', '0'] : [g])); // a dotted tail is 2 groups
  const [head, tail] = bare.split('::');
  const h = groups(head), t = groups(tail);
  const all = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return `${all.slice(0, 4).map(g => parseInt(g, 16).toString(16)).join(':')}::/64`;
}

// [method, route pattern, limit, window ms]; first match wins, the last entry is the default for every other route
const RULES = [
  ['POST', '/channels/:id/messages', 10, 5000],
  ['POST', '/auth/register', 10, 60_000],
  ['POST', '/interactions', 20, 5000],
  ['POST', '/channels/:id/messages/:mid/report', 5, 60_000],
  ['*', '/admin/*', 30, 10_000], // every admin route, each its own bucket
  ['NODE', '*', 300, 60_000], // v7: signed calls per linked node (identity node:<id>), on top of the per-IP limit
  ['GW', 'presence', 5, 20_000], // gateway op 3 per user (it fans out to everyone who shares a guild)
  ['GW', 'voice', 10, 10_000], // gateway op 4 per user (joins fan out to the guild and play entrance sounds)
  ['GW', 'members', 3, 10_000], // gateway op 8 (loads the guild's whole member list), per user and guild
  ['CALL', '*', 10, 60_000], // per user: DM/group call starts (op 4 into an empty call) and rings (each posts a message or a push)
  ['GET', '/external', 60, 60_000], // per IP: media proxy cache misses (each one an outbound fetch and a disk write)
  ['AUTH', 'forgot-ip', 10, 3_600_000], // password reset mails per IP (IPv6: per /64)
  ['AUTH', 'forgot-email', 3, 3_600_000], // and per address (never answered with a 429)
  ['AUTH', 'reset-ip', 10, 15 * 60_000], // new password with a reset link, per IP
  ['GET', '/download', 60, 10 * 60_000], // per IP: /download/* files fetched from the hub (an update check and a download take a few)
  ['*', '*', 50, 1000],
];
const buckets = new Map(); // bucket key -> { count, reset (unix ms) }
// tests only: multiplies every route limit so suites that send in bursts are not throttled; never set it in production
const SCALE = Math.max(1, Number(process.env.CILLCORD_RATE_LIMIT_SCALE) || 1);

const bucketId = (method, pattern) => createHash('sha256').update(`${method} ${pattern}`).digest('hex').slice(0, 16);
// top-level resources (channel, guild, webhook) get their own buckets (docs); never the webhook token, which is unchecked
// here: a new guess must not mean a new bucket
const resourceOf = (pattern, params) => (/^\/(channels|guilds)\/:id/.test(pattern) ? params.id : params.webhook_id ?? '');

// hard cap for the in-memory maps: a live entry is never dropped (that would reset a locked counter). Past max, stale
// entries go (at most one sweep per second, so a full map of live keys costs nothing per call); if the map is still
// full, a new key shares the map's one overflow entry with the same limits, so a flood of new keys throttles itself
const swept = new WeakMap(); // map -> time of its last sweep
export function capKey(map, max, stale, key, onDrop) {
  if (map.has(key) || map.size < max) return key;
  const now = Date.now();
  if (now - (swept.get(map) ?? 0) >= 1000) {
    swept.set(map, now);
    for (const [k, v] of map) if (stale(v)) { map.delete(k); onDrop?.(k); }
  }
  return map.size < max ? key : '\0overflow';
}

function rateLimitError(seconds, headers) {
  const e = new HttpError(429, 0, 'You are being rate limited.');
  e.body = { message: 'You are being rate limited.', retry_after: Math.ceil(seconds * 1000) / 1000, global: false };
  Object.assign(headers, { 'Retry-After': String(Math.ceil(seconds)), 'X-RateLimit-Scope': 'user' });
  return e;
}

// counts one request; sets the X-RateLimit-* headers and throws 429 when the bucket is empty
export function limit(method, pattern, params, identity, headers, policy) {
  const [, , defaultMax, defaultWindow] = RULES.find(([m, p]) => (m === '*' || m === method)
    && (p === '*' || p === pattern || (p.endsWith('/*') && pattern.startsWith(p.slice(0, -1)))));
  const base = policy?.max ?? defaultMax, windowMs = policy?.windowMs ?? defaultWindow;
  const max = base * SCALE;
  const bucket = bucketId(method, pattern);
  const now = Date.now();
  const key = capKey(buckets, 50_000, b => b.reset <= now, `${bucket}:${resourceOf(pattern, params)}:${identity}`);
  let b = buckets.get(key);
  if (!b || b.reset <= now) buckets.set(key, b = { count: 0, reset: now + windowMs });
  const after = (b.reset - now) / 1000;
  Object.assign(headers, {
    'X-RateLimit-Limit': String(max), 'X-RateLimit-Remaining': String(Math.max(0, max - b.count - 1)),
    'X-RateLimit-Reset': (b.reset / 1000).toFixed(3), 'X-RateLimit-Reset-After': after.toFixed(3), 'X-RateLimit-Bucket': bucket,
  });
  if (b.count >= max) {
    headers['X-RateLimit-Remaining'] = '0';
    throw rateLimitError(after, headers);
  }
  b.count++;
}

// failed logins: 10 per account or per IP in 15 minutes, then 429 until the oldest failure ages out
const LOGIN_MAX = 10;
const LOGIN_WINDOW = 15 * 60 * 1000;
const failures = new Map(); // key -> timestamps
const cleared = new Map(); // login: key -> time of its last successful password check
// the overflow entry keeps the kind (ip:, acct:, login:) so it keeps that kind's limit
const slots = keys => [...new Set(keys.map(key => {
  const k = capKey(failures, 50_000, list => !list.length || Date.now() - list.at(-1) >= LOGIN_WINDOW, key, d => cleared.delete(d));
  return k === key ? key : `${key.split(':')[0]}:${k}`;
}))];
const recent = key => (failures.get(key) ?? []).filter(t => Date.now() - t < LOGIN_WINDOW);

// acct: keys count every failure on one account from anywhere; higher so one stranger can't lock it for everyone
const maxOf = key => (key.startsWith('acct:') ? 100 : LOGIN_MAX);
// login: (account+IP) keys also wait from the 3rd failure in a row (since the last success), doubling from 1 s to 60 s,
// so a typo and a quick retry cost nothing but guessing is slow before the lockout
const DELAY_FREE = 2;
const DELAY_BASE = SCALE > 1 ? 0 : 1000;
const delayAfter = key => {
  const run = recent(key).filter(t => t > (cleared.get(key) ?? 0));
  return run.length > DELAY_FREE ? run.at(-1) + Math.min(2 ** (run.length - DELAY_FREE - 1), 60) * DELAY_BASE - Date.now() : 0;
};
export function checkLogin(keys, headers = {}) {
  for (const key of slots(keys)) {
    const list = recent(key);
    if (list.length >= maxOf(key)) throw rateLimitError((list[0] + LOGIN_WINDOW - Date.now()) / 1000, headers);
    const wait = key.startsWith('login:') ? delayAfter(key) : 0;
    if (wait > 0) throw rateLimitError(wait / 1000, headers);
  }
}
export function loginFailed(keys) {
  const now = Date.now();
  for (const key of slots(keys)) failures.set(key, [...recent(key), now]);
  return now;
}
// a correct password takes back the attempt counted before the hash (`stamp` from loginFailed) and ends the run of
// failures for the delay; the 10/100 lockout counts are kept
export function loginSucceeded(keys, stamp) {
  for (const key of slots(keys)) {
    const list = failures.get(key);
    const i = list ? list.lastIndexOf(stamp) : -1;
    if (i >= 0) list.splice(i, 1);
    if (key.startsWith('login:') && list?.length) cleared.set(key, Date.now());
  }
}
