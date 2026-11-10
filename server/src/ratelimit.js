// In-memory rate limits: per-route buckets with the v9 rate limit headers, and the failed-login guard
import { createHash } from 'node:crypto';
import { HttpError } from './errors.js';

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
  ['*', '*', 50, 1000],
];
const buckets = new Map(); // bucket key -> { count, reset (unix ms) }
// tests only: multiplies every route limit so suites that send in bursts are not throttled; never set it in production
const SCALE = Math.max(1, Number(process.env.CILLCORD_RATE_LIMIT_SCALE) || 1);

const bucketId = (method, pattern) => createHash('sha256').update(`${method} ${pattern}`).digest('hex').slice(0, 16);
// top-level resources (channel, guild, webhook) get their own buckets (docs)
const resourceOf = (pattern, params) => (/^\/(channels|guilds)\/:id/.test(pattern) ? params.id : params.webhook_id ? `${params.webhook_id}/${params.token ?? ''}` : '');

function rateLimitError(seconds, headers) {
  const e = new HttpError(429, 0, 'You are being rate limited.');
  e.body = { message: 'You are being rate limited.', retry_after: Math.ceil(seconds * 1000) / 1000, global: false };
  Object.assign(headers, { 'Retry-After': String(Math.ceil(seconds)), 'X-RateLimit-Scope': 'user' });
  return e;
}

// counts one request; sets the X-RateLimit-* headers and throws 429 when the bucket is empty
export function limit(method, pattern, params, identity, headers) {
  const [, , base, windowMs] = RULES.find(([m, p]) => (m === '*' || m === method)
    && (p === '*' || p === pattern || (p.endsWith('/*') && pattern.startsWith(p.slice(0, -1)))));
  const max = base * SCALE;
  const bucket = bucketId(method, pattern);
  const key = `${bucket}:${resourceOf(pattern, params)}:${identity}`;
  const now = Date.now();
  if (buckets.size > 50_000) for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
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
const recent = key => (failures.get(key) ?? []).filter(t => Date.now() - t < LOGIN_WINDOW);

// acct: keys count every failure on one account from anywhere; higher so one stranger can't lock it for everyone
const maxOf = key => (key.startsWith('acct:') ? 100 : LOGIN_MAX);
// login: (account+IP) keys also wait after each failure, doubling from 1 s to 60 s, so guessing is slow before the lockout
const DELAY_BASE = SCALE > 1 ? 0 : 1000;
const delayAfter = list => (list.length ? list.at(-1) + Math.min(2 ** (list.length - 1), 60) * DELAY_BASE - Date.now() : 0);
export function checkLogin(keys, headers = {}) {
  for (const key of keys) {
    const list = recent(key);
    if (list.length >= maxOf(key)) throw rateLimitError((list[0] + LOGIN_WINDOW - Date.now()) / 1000, headers);
    const wait = key.startsWith('login:') ? delayAfter(list) : 0;
    if (wait > 0) throw rateLimitError(wait / 1000, headers);
  }
}
export function loginFailed(keys) {
  if (failures.size > 50_000) for (const k of failures.keys()) if (!recent(k).length) failures.delete(k);
  for (const key of keys) failures.set(key, [...recent(key), Date.now()]);
}
