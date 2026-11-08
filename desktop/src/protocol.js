// app://cillhub/: the bundled web client (web/, built from client/ by scripts/build-web.js), served from the package
// with MIME types, a strict CSP and the SPA fallback to index.html. No file:// anywhere.
const fs = require('fs');
const path = require('path');
const { protocol } = require('electron');
const { HUB_URL, HUB_ORIGIN, PROD_HUB, TEST_HOOK } = require('./config');

const WEB_DIR = path.join(__dirname, '..', 'web');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.txt': 'text/plain; charset=utf-8',
};
const ws = HUB_ORIGIN.replace(/^http/, 'ws');
// Scripts only from the package (plus the YouTube IFrame API for Watch Together). REST, gateway, CDN, media proxy and LiveKit
// are on the hub; https:/wss: stay open for connect/img/media because linked nodes (v7) are other origins added at runtime.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com https://s.ytimg.com",
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${HUB_ORIGIN} https:`,
  `media-src 'self' data: blob: ${HUB_ORIGIN} https:`,
  "font-src 'self' data:",
  `connect-src 'self' ${HUB_ORIGIN} ${ws} https: wss: data: blob:`,
  'frame-src https://www.youtube-nocookie.com https://www.youtube.com',
  "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');

// Before app ready: standard + secure makes app://cillhub a real, secure origin (localStorage, fetch, media, notifications).
function registerScheme() {
  protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true } }]);
}

/** Resolves a request path to a file in WEB_DIR; client routes (no extension) fall back to index.html, missing assets are 404. */
function resolve(pathname, dir = WEB_DIR) {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  const file = path.join(dir, rel);
  if (file !== dir && !file.startsWith(dir + path.sep)) return null; // ../ escapes
  try { if (fs.statSync(file).isFile()) return file; } catch { /* missing */ }
  return path.extname(rel) ? null : path.join(dir, 'index.html');
}

async function serve(request, dir = WEB_DIR) {
  const u = new URL(request.url);
  // empty page on the app origin for the one-time login migration (migrate.js): the client must not start there
  if (u.host === 'cillhub' && u.pathname === '/__blank') return new Response('<!doctype html><title></title>', { headers: { 'Content-Type': TYPES['.html'], 'Content-Security-Policy': "default-src 'none'" } });
  const file = u.host === 'cillhub' && resolve(u.pathname, dir);
  if (!file) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
  const ext = path.extname(file);
  let body = await fs.promises.readFile(file);
  // When HUB_URL is pointed to a custom hub (e.g. Betacord or a test/selfhost hub), rewrite baked-in PROD_HUB:
  if (HUB_URL !== PROD_HUB && (ext === '.js' || ext === '.html')) body = body.toString('utf8').split(PROD_HUB).join(HUB_URL);
  const headers = { 'Content-Type': TYPES[ext] ?? 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' };
  if (ext === '.html') Object.assign(headers, { 'Content-Security-Policy': CSP, 'Cache-Control': 'no-cache' });
  return new Response(body, { status: 200, headers });
}

const handle = (ses) => ses.protocol.handle('app', (req) => serve(req));

module.exports = { registerScheme, handle, resolve, serve, CSP, WEB_DIR };
