import { createServer } from 'node:http';
import { BlockList, isIP } from 'node:net';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './db.js';
import { HttpError, unauthorized } from './errors.js';
import { authenticate } from './auth.js';
import { limit, netOf } from './ratelimit.js';
import { compileRoute } from './route-policy.js';
import { AccountExport } from './account-export.js';
import { attachGateway } from './gateway.js';
import { isCdnPath, serveCdn } from './files.js';
import { isProxyPath, serveExternal } from './proxy.js';
import { isEphemeralPath, serveEphemeral } from './interactions.js';
import { startTimers } from './timers.js';
import { parseMultipart } from './multipart.js';
import { publicInstance, maxUpload, setting, captchaOn, legalGate } from './instance.js';
import { configuredBackends, defaultBackend } from './voice.js';
import { requireAdmin, auditAdminRequest } from './routes/admin.js';
import auth from './routes/auth.js';
import users from './routes/users.js';
import guilds from './routes/guilds.js';
import channels from './routes/channels.js';
import messages from './routes/messages.js';
import invites from './routes/invites.js';
import roles from './routes/roles.js';
import members from './routes/members.js';
import bans from './routes/bans.js';
import reactions from './routes/reactions.js';
import pins from './routes/pins.js';
import reads from './routes/reads.js';
import relationships from './routes/relationships.js';
import threads from './routes/threads.js';
import polls from './routes/polls.js';
import emojis from './routes/emojis.js';
import stickers from './routes/stickers.js';
import soundboard from './routes/soundboard.js';
import webhooks from './routes/webhooks.js';
import stage from './routes/stage.js';
import events from './routes/events.js';
import automod from './routes/automod.js';
import auditlog from './routes/auditlog.js';
import search from './routes/search.js';
import community from './routes/community.js';
import gifs from './routes/gifs.js';
import account from './routes/account.js';
import profiles from './routes/profiles.js';
import settings from './routes/settings.js';
import inbox from './routes/inbox.js';
import push from './routes/push.js';
import groups from './routes/groups.js';
import applications from './routes/applications.js';
import commands from './routes/commands.js';
import interactions from './routes/interactions.js';
import watch from './routes/watch.js';
import later from './routes/later.js';
import templates from './routes/templates.js';
import cillbot from './routes/cillbot.js';
import admin from './routes/admin.js';
import customization from './routes/customization.js';
import hub from './routes/hub.js';
import node from './routes/node.js';
import { startUpdates } from './updates.js';
import directory from './routes/directory.js';
import modules, { isModulePath, serveModulePath } from './routes/modules.js';
import canvas from './routes/canvas.js';
import onboarding from './routes/onboarding.js';
import analytics from './routes/analytics.js';
import webauthn from './routes/webauthn.js';
import snippets from './routes/snippets.js';
import guide from './routes/guide.js';
import savedFolders from './routes/savedFolders.js';
import connections from './routes/connections.js';
import { startModules } from './modules/registry.js';
import setup, { setupOpen } from './routes/setup.js';
import legal from './routes/legal.js';
import { originOf, wellKnownCillcord, fedState, startHeartbeat, corsOrigin, publicUrl, ROLE, isHub, mode, HUB_URL, answerSignature, tlsAllowed } from './federation.js';

const PORT = Number(process.env.PORT ?? 3000);
const STATIC_DIR = process.env.STATIC_DIR && path.resolve(process.env.STATIC_DIR);
const MAX_BODY = 1024 * 1024;
const MAX_VALUES = 100_000; // commas, objects and arrays in a body over MAX_BODY
const maxMultipart = () => 10 * maxUpload() + MAX_BODY; // 10 files at the instance's upload limit plus payload_json
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-Audit-Log-Reason, X-Cillhub-MFA-Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-RateLimit-Reset-After, X-RateLimit-Bucket, X-RateLimit-Scope, X-RateLimit-Global',
};
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
// web client: scripts only from here (plus the YouTube player API for Watch Together and reCAPTCHA when an admin set
// captcha keys); media, API and voice may live on linked nodes and LiveKit hosts, so those stay open. Nobody else may
// frame the app (OAuth consent, admin pages).
const RECAPTCHA_SCRIPTS = 'https://www.google.com/recaptcha/ https://www.gstatic.com/recaptcha/';
// per response, so turning captcha on or off needs no restart
const csp = () => [
  "default-src 'self'", `script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com${captchaOn() ? ` ${RECAPTCHA_SCRIPTS}` : ''}`, "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: http: data: blob:", "media-src 'self' https: http: data: blob:", "font-src 'self' data:",
  "connect-src 'self' https: http: wss: ws: data: blob:", "frame-src 'self' https: http:", "worker-src 'self' blob:",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'self'",
].join('; ');
// captcha.html: the reCAPTCHA checkbox for the Android app's WebView, nothing else may load or frame it
const CAPTCHA_CSP = [
  "default-src 'none'", `script-src 'self' ${RECAPTCHA_SCRIPTS}`, "frame-src https://www.google.com/recaptcha/ https://recaptcha.google.com/recaptcha/",
  "style-src 'self' 'unsafe-inline'", "font-src 'self'", "connect-src 'self' https://www.google.com/recaptcha/", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
].join('; ');
const STATIC_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'SAMEORIGIN' };

// absolute, from CILLCORD_PUBLIC_URL when set (a hub's client opens node gateways cross-origin)
const gatewayUrl = ({ req }) => ({ url: `${publicUrl(req).replace(/^http/, 'ws')}/gateway` });
// v7 adds setup_pending (the first-run wizard is open) and federation {role, mode (null on the hub), hub_url}
const instanceInfo = () => ({
  ...publicInstance(), setup_pending: setupOpen(),
  voice: { configured: configuredBackends(), default: configuredBackends().length ? defaultBackend() : null },
  federation: { role: ROLE, mode: isHub ? null : mode(), hub_url: isHub ? null : fedState()?.hub_url ?? HUB_URL },
});

// Spacebar instance discovery (docs.spacebar.chat), so Harmony clients find the API, gateway and CDN of this host
const spacebarDomains = ({ req }) => {
  const o = originOf(req);
  return { cdn: o.http, gateway: o.ws, defaultApiVersion: '9', apiEndpoint: `${o.http}/api` };
};
const spacebarPolicies = () => ({
  instanceName: setting('instance_name'), instanceDescription: 'A self-hosted Cillhub instance', frontPage: null, tosPage: null,
  correspondenceEmail: null, correspondenceUserID: null, image: null, instanceId: null,
});
function wellKnown(req, pathname) {
  const o = originOf(req);
  if (pathname === '/.well-known/spacebar') return { api: `${o.http}/api/v9` };
  if (pathname === '/.well-known/cillhub' || pathname === '/.well-known/cillcord') return wellKnownCillcord(req); // v7: role, mode and the federation public key
  if (pathname === '/.well-known/spacebar/client') {
    return {
      api: { baseUrl: o.http, apiVersions: { default: '9', active: ['9', '10'] } }, cdn: { baseUrl: o.http },
      gateway: { baseUrl: o.ws, encoding: ['json'], compression: [null] },
    };
  }
  return null;
}
// one shard, no real session start limit (self-hosted)
const gatewayBot = ctx => ({ ...gatewayUrl(ctx), shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 86_400_000, max_concurrency: 1 } });

// reverse proxies whose X-Forwarded-For we believe: TRUST_PROXY (comma list of IPs or CIDRs), default loopback
const trustedProxies = new BlockList();
const ipType = a => (isIP(a) === 6 ? 'ipv6' : 'ipv4');
for (const p of (process.env.TRUST_PROXY ?? '127.0.0.0/8,::1').split(',').map(s => s.trim()).filter(Boolean)) {
  const [addr, bits] = p.split('/');
  if (bits) trustedProxies.addSubnet(addr, Number(bits), ipType(addr)); else trustedProxies.addAddress(addr, ipType(addr));
}
const trusted = a => isIP(a) && trustedProxies.check(a, ipType(a));
// X-Real-IP is never read: proxies that do not overwrite it (Caddy's default) pass the client's own value through.
// Each proxy appends its peer to X-Forwarded-For, so walking from the right past our own proxies gives the client.
export const clientIp = req => {
  const peer = req.socket.remoteAddress ?? '';
  let ip = peer.replace(/^::ffff:(?=\d+\.)/, '');
  if (!trusted(ip)) return peer;
  for (const hop of String(req.headers['x-forwarded-for'] ?? '').split(',').reverse()) {
    const h = hop.trim().replace(/^::ffff:(?=\d+\.)/, '');
    if (!isIP(h)) break;
    ip = h;
    if (!trusted(h)) break;
  }
  return ip;
};

// route entries: [method, path with :params, handler, {open?, maxBody?, multipart?, userOnly?, botOnly?, admin?, when?(params)}]
const routes = [
  ['GET', '/gateway', gatewayUrl, { open: true }], ['GET', '/gateway/bot', gatewayBot, { botOnly: true }],
  ['GET', '/instance', instanceInfo, { open: true }],
  // the bundled Caddy asks here before it gets a certificate on demand (selfhost/Caddyfile); 200 only for our own names
  ['GET', '/instance/tls-allowed', ({ query }) => {
    if (!tlsAllowed(query.get('domain'))) throw new HttpError(403, 0, 'Not a name of this instance.');
    return { ok: true };
  }, { open: true }],
  ['GET', '/policies/instance', spacebarPolicies, { open: true }], ['GET', '/policies/instance/domains', spacebarDomains, { open: true }],
  ...setup, ...legal, ...hub, ...node, ...directory, ...admin, ...modules, ...canvas, ...onboarding, ...guide, ...analytics, ...webauthn, ...customization, ...templates, ...watch, ...later, ...savedFolders, ...connections, ...cillbot,
  ...auth, ...account, ...relationships, ...profiles, ...settings, ...inbox, ...push, ...users, ...guilds, ...roles, ...community,
  ...members, ...bans, ...groups, ...channels, ...reads, ...search, ...messages, ...threads, ...reactions, ...pins, ...polls, ...invites,
  ...emojis, ...stickers, ...soundboard, ...interactions, ...webhooks, ...stage, ...events, ...automod, ...auditlog, ...gifs, ...snippets,
  ...applications, ...commands,
].map(compileRoute);
const API_PREFIX = /^\/api(\/v\d+)?(?=\/)/; // /api/v9 (the client), /api/v10 (bot libraries) and unversioned

// while an admin requires a new password, only these work (plus the gateway): change it, read yourself, log out
const PASSWORD_CHANGE_ROUTES = new Set(['GET /users/@me', 'PATCH /users/@me', 'POST /mfa/finish', 'POST /auth/logout', 'GET /instance']); // mfa/finish: the 2FA step-up of that change

const LEGAL_GATE_ROUTES = new Set(['GET /users/@me', 'POST /auth/logout', 'GET /instance', 'GET /users/@me/settings']);

const tooLarge = () => new HttpError(413, 0, 'Request entity too large');

// ctx.rawBody keeps the exact bytes (signed federation calls are checked over them)
async function readBody(req, max, ctx) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= max) chunks.push(chunk); // keep draining past the limit so the 413 can still be sent
  }
  if (size > max) throw tooLarge();
  if (!size) return {};
  ctx.rawBody = Buffer.concat(chunks);
  // big bodies are big because of data URIs; millions of tiny values would stall JSON.parse on the main thread
  if (size > MAX_BODY) {
    let values = 0;
    for (let i = 0; i < size; i++) {
      const b = ctx.rawBody[i];
      if ((b === 0x2c || b === 0x7b || b === 0x5b) && ++values > MAX_VALUES) throw tooLarge();
    }
  }
  try {
    return JSON.parse(ctx.rawBody);
  } catch {
    throw new HttpError(400, 0, 'The request body contains invalid JSON.');
  }
}

async function api(req, url, headers) {
  const p = url.pathname.replace(API_PREFIX, '');
  for (const route of routes) {
    const m = route.method === req.method && route.re.exec(p);
    // path segments arrive percent-encoded (bot libraries send messages/%40original)
    const params = m && Object.fromEntries(Object.entries(m.groups ?? {}).map(([k, v]) => { try { return [k, decodeURIComponent(v)]; } catch { return [k, v]; } }));
    if (!m || (route.when && !route.when(params))) continue;
    const ctx = { req, params, query: url.searchParams, status: 200, ip: clientIp(req), headers };
    if (!route.open) {
      Object.assign(ctx, authenticate(req.headers.authorization));
      if (!ctx.user) {
        limit('AUTH', 'bad-token', {}, netOf(ctx.ip), headers); // a token-guessing flood gets 429s, not endless 401s
        throw unauthorized();
      }
      if (route.userOnly && ctx.user.bot) throw new HttpError(403, 20001, 'Bots cannot use this endpoint');
      if (route.botOnly && !ctx.user.bot) throw new HttpError(403, 20002, 'Only bots can use this endpoint');
      if (ctx.user.require_password_change && !PASSWORD_CHANGE_ROUTES.has(`${route.method} ${route.pattern}`)) {
        const e = new HttpError(403, 0, 'You must change your password before continuing.');
        e.body.required_actions = ['update_password'];
        throw e;
      }
      // 7.10.3: new terms with re-acceptance, or an account made without the sign-up checks: accept first (or log out)
      if (legalGate(ctx.user) && !route.pattern.startsWith('/legal/') && !LEGAL_GATE_ROUTES.has(`${route.method} ${route.pattern}`)) {
        const e = new HttpError(403, 0, 'Accept the updated terms of use to continue. If this app has no button for that, update it or sign in once on the website.');
        e.body.required_actions = ['accept_terms'];
        throw e;
      }
    }
    limit(route.method, route.pattern, ctx.params, ctx.user?.id ?? netOf(ctx.ip), headers, route.rateLimit); // anonymous: per IPv4 or IPv6 /64
    if (route.admin) requireAdmin(ctx); // flag and 2FA, re-read from the database on every request
    // a multipart route reads its form itself, after its permission checks, so refused uploads are never read;
    // files stream to temp files (at most maxFile bytes each), removed after the handler unless it moved them
    let cleanup;
    if (route.multipart && (req.headers['content-type'] ?? '').startsWith('multipart/form-data')) {
      ctx.form = async ({ maxFile = maxUpload() } = {}) => {
        if (Number(req.headers['content-length']) > maxMultipart()) throw tooLarge();
        const parsed = await parseMultipart(req, { maxTotal: maxMultipart(), maxFile, maxFields: MAX_BODY });
        cleanup = parsed.cleanup;
        return parsed.form;
      };
    } else ctx.body = await readBody(req, route.maxBody ?? MAX_BODY, ctx);
    try {
      const out = await route.handler(ctx);
      if (ctx.type) headers['Content-Type'] = ctx.type;
      if (route.admin) auditAdminRequest(ctx, route);
      return out === undefined ? [204, undefined] : [ctx.status, out];
    } finally {
      await cleanup?.();
    }
  }
  throw new HttpError(404, 0, '404: Not Found');
}

async function serveStatic(res, pathname) {
  let file;
  try { file = path.join(STATIC_DIR, decodeURIComponent(pathname)); } catch { file = STATIC_DIR; }
  let data = null;
  if (file.startsWith(STATIC_DIR + path.sep) || file === STATIC_DIR) {
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = path.join(file, 'index.html');
      data = await readFile(file);
    } catch {
      data = null;
    }
  }
  if (!data) data = await readFile(file = path.join(STATIC_DIR, 'index.html')); // SPA fallback
  const headers = { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', ...STATIC_HEADERS };
  // Vite's hashed bundles never change; everything else (app shell, sw.js, feeds, downloads) is revalidated every time
  const s = await stat(file);
  const etag = `W/"${s.size.toString(16)}-${Math.floor(s.mtimeMs).toString(16)}"`;
  if (file.startsWith(path.join(STATIC_DIR, 'assets') + path.sep)) headers['Cache-Control'] = 'public, max-age=31536000, immutable';
  else Object.assign(headers, { 'Cache-Control': 'no-cache', ETag: etag });
  // the app shell gets the full policy; other pages (offline.html, downloads) may use inline code, so only framing is limited
  if (file === path.join(STATIC_DIR, 'index.html')) headers['Content-Security-Policy'] = csp();
  else if (file === path.join(STATIC_DIR, 'captcha.html')) headers['Content-Security-Policy'] = CAPTCHA_CSP;
  else if (path.extname(file) === '.html') headers['Content-Security-Policy'] = "frame-ancestors 'self'";
  // browsers ignore HSTS over plain http, so a spoofed X-Forwarded-Proto cannot do harm
  if (res.req.socket.encrypted || res.req.headers['x-forwarded-proto'] === 'https') headers['Strict-Transport-Security'] = 'max-age=31536000';
  if (headers.ETag && res.req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    return res.end();
  }
  res.writeHead(200, headers);
  res.end(data);
}

async function proxyHubDownload(req, res, pathname) {
  const upstream = process.env.CILLCORD_DOWNLOAD_UPSTREAM || 'https://cillhub.cillerian.org';
  let targetUrl = `${upstream}${pathname}`;
  let headRes = await fetch(targetUrl, { method: 'HEAD' }).catch(() => null);
  if ((!headRes || headRes.status !== 200) && pathname.includes('2.1.0')) {
    const fallbackPath = pathname.replace(/2\.1\.0/g, '2.0.0');
    const fallbackHead = await fetch(`${upstream}${fallbackPath}`, { method: 'HEAD' }).catch(() => null);
    if (fallbackHead && fallbackHead.status === 200) {
      targetUrl = `${upstream}${fallbackPath}`;
      headRes = fallbackHead;
    }
  }

  const filename = path.basename(pathname);
  if (req.method === 'HEAD') {
    if (!headRes || headRes.status >= 400) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not Found');
    }
    const headers = {
      'Content-Type': headRes.headers.get('content-type') || 'application/octet-stream',
      'Content-Length': headRes.headers.get('content-length') || '0',
      'Accept-Ranges': 'bytes',
      'Content-Disposition': `attachment; filename="${filename}"`,
    };
    res.writeHead(200, headers);
    return res.end();
  }

  const upstreamRes = await fetch(targetUrl, {
    method: 'GET',
    headers: req.headers.range ? { Range: req.headers.range } : undefined,
  }).catch(() => null);

  if (!upstreamRes || upstreamRes.status >= 400) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }

  const headers = {
    'Content-Type': upstreamRes.headers.get('content-type') || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${filename}"`,
    'Accept-Ranges': 'bytes',
  };
  const cl = upstreamRes.headers.get('content-length');
  if (cl) headers['Content-Length'] = cl;
  const cr = upstreamRes.headers.get('content-range');
  if (cr) headers['Content-Range'] = cr;

  res.writeHead(upstreamRes.status, headers);
  if (upstreamRes.body) {
    const { Readable, pipeline } = await import('node:stream');
    pipeline(Readable.fromWeb(upstreamRes.body), res, err => {
      if (!err) return;
      if (err.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(`download relay ${pathname}: ${err.message}`); // a closed tab is not news
      res.destroy();
    });
  } else {
    res.end();
  }
}

// answers to federation calls that bring a challenge are signed on the hub (federation.js answerSignature)
function reply(res, status, body, headers = {}) {
  if (body instanceof AccountExport) return body.send(res, { ...CORS, ...headers });
  const isText = typeof body === 'string' && (headers['Content-Type'] || '').startsWith('text/');
  const data = body === undefined ? undefined : (isText ? body : JSON.stringify(body));
  const signed = answerSignature(res.req, data ?? '');
  const ct = isText ? {} : { 'Content-Type': 'application/json' };
  res.writeHead(status, body === undefined ? { ...CORS, ...headers, ...signed } : { ...CORS, ...headers, ...signed, ...ct });
  res.end(data);
}

const server = createServer(async (req, res) => {
  const headers = {};
  try {
    const url = new URL(req.url, 'http://localhost');
    // v7: a linked node answers cross-origin calls (REST, CDN, media proxy) only for its hub's web client
    const allow = corsOrigin(req.headers.origin);
    if (allow !== '*') Object.assign(headers, { 'Access-Control-Allow-Origin': allow, Vary: 'Origin' });
    res.setHeader('Access-Control-Allow-Origin', allow);
    if (allow !== '*') res.setHeader('Vary', 'Origin'); // CDN and media answers too (they don't go through reply)
    if (isModulePath(url.pathname)) return await serveModulePath(req, res, url, netOf(clientIp(req))); // v8: panel files and module HTTP endpoints, no auth
    if (req.method === 'OPTIONS') return reply(res, 204, undefined, headers);
    if (API_PREFIX.test(url.pathname)) return await reply(res, ...await api(req, url, headers), headers);
    const known = req.method === 'GET' && url.pathname.startsWith('/.well-known/') && wellKnown(req, url.pathname.replace(/\/$/, ''));
    if (known) return reply(res, 200, known);
    if ((req.method === 'GET' || req.method === 'HEAD') && isCdnPath(url.pathname)) return await serveCdn(req, res, url.pathname);
    if ((req.method === 'GET' || req.method === 'HEAD') && isProxyPath(url.pathname)) return await serveExternal(req, res, url.pathname, netOf(clientIp(req)), headers);
    if ((req.method === 'GET' || req.method === 'HEAD') && isEphemeralPath(url.pathname)) return serveEphemeral(req, res, url.pathname);
    if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname.startsWith('/download/desktop/') || url.pathname.startsWith('/download/android/') || url.pathname.startsWith('/download/server/'))) {
      let rel;
      try { rel = decodeURIComponent(url.pathname); } catch { rel = '..'; }
      if (/(^|[/\\])\.\.([/\\]|$)|\0/.test(rel)) throw new HttpError(404, 0, '404: Not Found'); // no existence oracle outside the folders
      const local = [STATIC_DIR && path.join(STATIC_DIR, rel), DATA_DIR && path.join(DATA_DIR, rel)].find(p => p && existsSync(p));
      if (local) return await serveStatic(res, url.pathname);
      // only plain names go to the hub: no second escape layer (%252e) in its request, no quote in the filename header
      if (!/^[\w./ +-]+$/.test(rel)) throw new HttpError(404, 0, '404: Not Found');
      limit('GET', '/download', {}, netOf(clientIp(req)), headers); // every node relays these to the hub
      return await proxyHubDownload(req, res, url.pathname);
    }
    if (STATIC_DIR && (req.method === 'GET' || req.method === 'HEAD')) return await serveStatic(res, url.pathname);
    throw new HttpError(404, 0, '404: Not Found');
  } catch (e) {
    if (!(e instanceof HttpError)) console.error(e);
    const err = e instanceof HttpError ? e : new HttpError(500, 0, '500: Internal Server Error');
    if (!res.headersSent) reply(res, err.status, err.body, headers);
    else res.destroy();
  }
});

attachGateway(server);
startModules();
startTimers();
startHeartbeat();
startUpdates();
server.headersTimeout = 20_000; // slow header senders
server.listen(PORT, () => console.log(`Cillhub listening on http://localhost:${server.address().port}`));
