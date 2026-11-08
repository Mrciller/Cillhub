import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR } from './db.js';
import { HttpError, unauthorized } from './errors.js';
import { authenticate } from './auth.js';
import { limit } from './ratelimit.js';
import { attachGateway } from './gateway.js';
import { isCdnPath, serveCdn } from './files.js';
import { isProxyPath, serveExternal } from './proxy.js';
import { isEphemeralPath, serveEphemeral } from './interactions.js';
import { startTimers } from './timers.js';
import { parseMultipart } from './multipart.js';
import { publicInstance, maxUpload, setting } from './instance.js';
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
import { originOf, wellKnownCillcord, fedState, startHeartbeat, corsOrigin, publicUrl, ROLE, isHub, mode, HUB_URL, answerSignature } from './federation.js';

const PORT = Number(process.env.PORT ?? 3000);
const STATIC_DIR = process.env.STATIC_DIR && path.resolve(process.env.STATIC_DIR);
const MAX_BODY = 1024 * 1024;
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

// behind the local nginx the peer is loopback; then X-Real-IP is the client
export const clientIp = req => {
  const peer = req.socket.remoteAddress ?? '';
  const loopback = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1';
  return (loopback && typeof req.headers['x-real-ip'] === 'string' && req.headers['x-real-ip']) || peer;
};

// route entries: [method, path with :params, handler, {open?, maxBody?, multipart?, userOnly?, botOnly?, admin?, when?(params)}]
const routes = [
  ['GET', '/gateway', gatewayUrl, { open: true }], ['GET', '/gateway/bot', gatewayBot, { botOnly: true }],
  ['GET', '/instance', instanceInfo, { open: true }],
  ['GET', '/policies/instance', spacebarPolicies, { open: true }], ['GET', '/policies/instance/domains', spacebarDomains, { open: true }],
  ...setup, ...hub, ...node, ...directory, ...admin, ...modules, ...canvas, ...onboarding, ...guide, ...analytics, ...webauthn, ...customization, ...templates, ...watch, ...later, ...savedFolders, ...connections, ...cillbot,
  ...auth, ...account, ...relationships, ...profiles, ...settings, ...inbox, ...push, ...users, ...guilds, ...roles, ...community,
  ...members, ...bans, ...groups, ...channels, ...reads, ...search, ...messages, ...threads, ...reactions, ...pins, ...polls, ...invites,
  ...emojis, ...stickers, ...soundboard, ...interactions, ...webhooks, ...stage, ...events, ...automod, ...auditlog, ...gifs, ...snippets,
  ...applications, ...commands,
].map(([method, pattern, handler, opts = {}]) => ({
  method, pattern, handler, ...opts, re: new RegExp(`^${pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)')}$`),
}));
const API_PREFIX = /^\/api(\/v\d+)?(?=\/)/; // /api/v9 (the client), /api/v10 (bot libraries) and unversioned

// while an admin requires a new password, only these work (plus the gateway): change it, read yourself, log out
const PASSWORD_CHANGE_ROUTES = new Set(['GET /users/@me', 'PATCH /users/@me', 'POST /auth/logout', 'GET /instance']);

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
      if (!ctx.user) throw unauthorized();
      if (route.userOnly && ctx.user.bot) throw new HttpError(403, 20001, 'Bots cannot use this endpoint');
      if (route.botOnly && !ctx.user.bot) throw new HttpError(403, 20002, 'Only bots can use this endpoint');
      if (ctx.user.require_password_change && !PASSWORD_CHANGE_ROUTES.has(`${route.method} ${route.pattern}`)) {
        const e = new HttpError(403, 0, 'You must change your password before continuing.');
        e.body.required_actions = ['update_password'];
        throw e;
      }
    }
    limit(route.method, route.pattern, ctx.params, ctx.user?.id ?? ctx.ip, headers);
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
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
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
    const { Readable } = await import('node:stream');
    Readable.fromWeb(upstreamRes.body).pipe(res);
  } else {
    res.end();
  }
}

// answers to federation calls that bring a challenge are signed on the hub (federation.js answerSignature)
function reply(res, status, body, headers = {}) {
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
    if (isModulePath(url.pathname)) return await serveModulePath(req, res, url); // v8: panel files and module HTTP endpoints, no auth
    if (req.method === 'OPTIONS') return reply(res, 204, undefined, headers);
    if (API_PREFIX.test(url.pathname)) return reply(res, ...await api(req, url, headers), headers);
    const known = req.method === 'GET' && url.pathname.startsWith('/.well-known/') && wellKnown(req, url.pathname.replace(/\/$/, ''));
    if (known) return reply(res, 200, known);
    if ((req.method === 'GET' || req.method === 'HEAD') && isCdnPath(url.pathname)) return await serveCdn(req, res, url.pathname);
    if ((req.method === 'GET' || req.method === 'HEAD') && isProxyPath(url.pathname)) return await serveExternal(req, res, url.pathname);
    if ((req.method === 'GET' || req.method === 'HEAD') && isEphemeralPath(url.pathname)) return serveEphemeral(req, res, url.pathname);
    if ((req.method === 'GET' || req.method === 'HEAD') && (url.pathname.startsWith('/download/desktop/') || url.pathname.startsWith('/download/android/') || url.pathname.startsWith('/download/server/'))) {
      const local = [
        STATIC_DIR && path.join(STATIC_DIR, decodeURIComponent(url.pathname)),
        DATA_DIR && path.join(DATA_DIR, decodeURIComponent(url.pathname)),
      ].find(p => p && existsSync(p));
      if (local) return await serveStatic(res, url.pathname);
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
server.listen(PORT, () => console.log(`Cillhub listening on http://localhost:${server.address().port}`));
