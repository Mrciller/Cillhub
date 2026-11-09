import { createHmac, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { DATA_DIR } from './db.js';
import { HttpError } from './errors.js';
import { sniff, sendRanged } from './files.js';
import { safeFetch } from './ssrf.js';
import { addJob } from './timers.js';

const IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_AGE = 7 * 24 * 3600 * 1000;
const MAX_CACHE = 512 * 1024 * 1024; // all cached images together; anyone can have URLs signed, so the oldest give way
const CACHE = join(DATA_DIR, 'external');
mkdirSync(CACHE, { recursive: true });

// generated once per installation; 'wx' keeps a concurrent first start from overwriting it
const KEY_FILE = join(DATA_DIR, 'media-proxy.key');
function loadKey() {
  try { return readFileSync(KEY_FILE); } catch { /* first start */ }
  try { writeFileSync(KEY_FILE, randomBytes(32), { flag: 'wx', mode: 0o600 }); } catch { /* lost the race */ }
  return readFileSync(KEY_FILE);
}
const KEY = loadKey();

const sign = url => createHmac('sha256', KEY).update(url).digest('base64url');

// root-relative like attachment URLs; only URLs the server signed can be fetched through it
export const proxyUrl = url => `/external/${Buffer.from(url).toString('base64url')}.${sign(url)}`;

export const isProxyPath = pathname => pathname.startsWith('/external/');

function verify(token) {
  const m = /^([A-Za-z0-9_-]{1,4096})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  const url = Buffer.from(m[1], 'base64url').toString();
  const good = Buffer.from(sign(url)), given = Buffer.from(m[2]);
  return good.length === given.length && timingSafeEqual(good, given) ? url : null;
}

const notFound = () => new HttpError(404, 0, '404: Not Found');

async function cached(file) {
  const s = await stat(file).catch(() => null);
  return s && Date.now() - s.mtimeMs < MAX_AGE ? readFile(file) : null;
}

async function fetchImage(url) {
  const r = await safeFetch(url, { maxBytes: MAX_IMAGE, truncate: false, headers: { Accept: 'image/*' } }).catch(() => null);
  if (!r || r.status !== 200 || !r.type.startsWith('image/') || !IMAGES.includes(sniff(r.body))) return null;
  return r.body;
}

// GET /external/<base64url(url)>.<hmac>: raster images only, typed by their bytes, cached on disk for 7 days
export async function serveExternal(req, res, pathname) {
  const url = verify(pathname.slice('/external/'.length));
  if (!url) throw notFound();
  const file = join(CACHE, createHash('sha256').update(url).digest('hex'));
  let bytes = await cached(file);
  if (!bytes) {
    bytes = await fetchImage(url);
    if (!bytes) throw notFound();
    await writeFile(file, bytes);
    if ((cacheBytes += bytes.length) > MAX_CACHE) pruneProxyCache(Date.now(), MAX_CACHE * 0.9);
  }
  sendRanged(req, res, {
    'Content-Type': sniff(bytes), 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox", 'Cache-Control': 'public, max-age=86400',
  }, bytes);
}

// drops images older than MAX_AGE, then the oldest until the cache fits in maxBytes
let cacheBytes = 0;
export function pruneProxyCache(now = Date.now(), maxBytes = MAX_CACHE) {
  const files = readdirSync(CACHE).map(name => {
    const file = join(CACHE, name), s = statSync(file, { throwIfNoEntry: false });
    return { file, size: s?.size ?? 0, at: s?.mtimeMs ?? 0 };
  }).sort((a, b) => a.at - b.at);
  cacheBytes = files.reduce((n, f) => n + f.size, 0);
  for (const f of files) {
    if (now - f.at < MAX_AGE && cacheBytes <= maxBytes) break;
    rmSync(f.file, { force: true });
    cacheBytes -= f.size;
  }
  return cacheBytes;
}
pruneProxyCache();

addJob({ name: 'media proxy cache', next: () => null, run: pruneProxyCache });
