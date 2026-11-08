// v7 hub network: instance role, this instance's Ed25519 key, URL rules, signed hub<->node calls, the node's link state,
// heartbeats and the node -> hub push relay. Routes live in routes/hub.js (hub role) and routes/node.js (node role).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { DATA_DIR, get, all, run, userById } from './db.js';
import { HttpError, invalid } from './errors.js';
import { safeFetch, isPublicAddress } from './ssrf.js';
import { setting, setSetting } from './instance.js';
import { limit } from './ratelimit.js';
import { closeTokenSessions, refreshPresence } from './gateway.js';
import { updateReport } from './updates.js';
import {
  newKeyPair, publicKeyText, publicKeyFrom, signRequest, verifyRequest, ReplayCache, randomCode, signResponse, verifyResponse, CHALLENGE,
} from './fedcrypto.js';

export const VERSION = process.env.CILLCORD_VERSION ?? 'dev';
// tests only: lets instance URLs be http://127.0.0.1:<port> (two local processes); never set it in production
export const DEV_HTTP = process.env.CILLCORD_FEDERATION_DEV_HTTP === '1';

// --- this instance's Ed25519 key: DATA_DIR/federation.key (PKCS#8 PEM, 0600); 'wx' keeps a concurrent first start out --
const KEY_FILE = join(DATA_DIR, 'federation.key');
function loadKey() {
  try { return createPrivateKey(readFileSync(KEY_FILE)); } catch { /* first start */ }
  try { writeFileSync(KEY_FILE, newKeyPair().privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 }); } catch { /* lost the race */ }
  return createPrivateKey(readFileSync(KEY_FILE));
}
export const KEY = loadKey();
export const PUBLIC_KEY = publicKeyText(KEY);

// The network's key (public half, base64url of the raw Ed25519 key). Nodes trust only answers, events and ID tokens signed
// with it, whatever URL they talk to.
export const NETWORK_KEY = 'JAYJ_2dva0628IX7JwGX8EKeJpvbaybIXDHbpxcd0OM';
// tests only: a source checkout (server/test present; release images are built without it) run with NODE_ENV=test may
// pin a test key instead, so two local instances can play both sides
const TEST_KEY = process.env.NODE_ENV === 'test' && existsSync(new URL('../test/helpers.js', import.meta.url)) ? process.env.CILLCORD_TEST_HUB_KEY : undefined;
export const TRUSTED_KEY = publicKeyFrom(TEST_KEY) ? TEST_KEY : NETWORK_KEY;
export const TRUSTED = publicKeyFrom(TRUSTED_KEY);
const wantsHub = process.env.CILLCORD_ROLE === 'hub';
if (wantsHub && PUBLIC_KEY !== TRUSTED_KEY) {
  console.error(`CILLCORD_ROLE=hub refused: the key in ${KEY_FILE} (public ${PUBLIC_KEY}) is not the network key; starting as a node`);
}
export const ROLE = wantsHub && PUBLIC_KEY === TRUSTED_KEY ? 'hub' : 'node';
export const isHub = ROLE === 'hub';

export function originOf(req) {
  const secure = req.socket.encrypted || (req.headers['x-forwarded-proto'] ?? '').startsWith('https');
  return { http: `${secure ? 'https' : 'http'}://${req.headers.host}`, ws: `${secure ? 'wss' : 'ws'}://${req.headers.host}` };
}

// an instance URL is an origin: https, default port, no credentials, path, query or fragment, not a private address
export function instanceUrl(raw, field = 'url') {
  const bad = () => invalid(field, 'URL_TYPE_INVALID_URL', 'Must be an https:// origin of a public host (no path, port or credentials).');
  let u;
  try { u = new URL(String(raw ?? '')); } catch { throw bad(); }
  const dev = DEV_HTTP && u.protocol === 'http:' && u.hostname === '127.0.0.1';
  if (!dev && (u.protocol !== 'https:' || u.port)) throw bad();
  if (u.username || u.password || u.search || u.hash || u.pathname !== '/' || String(raw).length > 200) throw bad();
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!dev && (isIP(host) ? !isPublicAddress(host) : !host.includes('.'))) throw bad();
  return u.origin;
}
const envUrl = name => {
  if (!process.env[name]) return null;
  try { return instanceUrl(process.env[name]); } catch { console.error(`${name} is not a valid https origin; ignored`); return null; }
};
export const HUB_URL = isHub ? null : envUrl('CILLCORD_HUB_URL');
// own public origin: CILLCORD_PUBLIC_URL, else the request's (behind a proxy: Host + X-Forwarded-Proto)
const PUBLIC_URL = envUrl('CILLCORD_PUBLIC_URL');
export const publicUrl = req => PUBLIC_URL ?? originOf(req).http;
// where a node may send a browser after hub sign-in. The live Host header is not one of these: an attacker who can
// set it would otherwise choose the page that receives the node token. Pinned at link time, plus the configured public URL.
export function returnOrigins() {
  const f = fedState();
  return [f?.hub_url, f?.node_url, PUBLIC_URL].filter(Boolean);
}

// --- outgoing calls ----------------------------------------------------------------------------------------------------
const allowFor = base => (DEV_HTTP && base.startsWith('http://127.0.0.1:') ? new Set([`127.0.0.1:${new URL(base).port}`]) : undefined);
const parse = buf => { try { return buf.length ? JSON.parse(buf) : null; } catch { return null; } };

// every call goes through the SSRF guard (no redirects for POST, 10 s, 1 MiB answer)
export async function fetchJson(url, opts = {}) {
  const r = await safeFetch(url, { truncate: false, timeout: 10_000, allow: allowFor(new URL(url).origin), ...opts });
  return { status: r.status, body: parse(r.body), bytes: r.body, type: r.type, headers: r.headers ?? {} };
}

// a signed POST/PUT/DELETE to another instance's /api/v9<path>; keyId: our node id (node -> hub) or 'hub'
export function signedFetch(base, path, body, { keyId, method = 'POST' }) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  const full = `/api/v9${path}`;
  return fetchJson(base + full, {
    method, body: payload || undefined,
    headers: { ...signRequest(KEY, keyId, method, full, payload), ...(payload && { 'Content-Type': 'application/json' }) },
  });
}

// node -> hub: a POST to the hub's /api/v9<path> (signed with our node key when keyId is given) whose answer must be signed
// with the network key over our random challenge; anything else is treated as an unreachable hub
export async function hubFetch(base, path, body, { keyId } = {}) {
  const payload = JSON.stringify(body ?? {});
  const full = `/api/v9${path}`;
  const challenge = randomCode(12);
  const r = await fetchJson(base + full, {
    method: 'POST', body: payload,
    headers: { 'Content-Type': 'application/json', 'Cillhub-Challenge': challenge, ...(keyId && signRequest(KEY, keyId, 'POST', full, payload)) },
  });
  const err = verifyResponse({ header: r.headers['cillhub-response-signature'], path: full, challenge, body: r.bytes, publicKey: TRUSTED });
  if (err) throw new Error(`not the network hub (${err})`);
  return r;
}
// hub: the signature header for an answer to a federation call that brought a challenge (index.js adds it to the reply)
export function answerSignature(req, data) {
  const challenge = req.headers['cillhub-challenge'];
  if (!isHub || !CHALLENGE.test(challenge ?? '') || !/^\/api(\/v\d+)?\/federation\//.test(req.url)) return {};
  return { 'Cillhub-Response-Signature': signResponse(KEY, req.url, challenge, data) };
}

// --- incoming signed calls ---------------------------------------------------------------------------------------------
const replay = new ReplayCache();
const refused = reason => new HttpError(401, 0, `Federation signature refused: ${reason}`);
const verifyWith = (ctx, keyFor) => verifyRequest({
  header: ctx.req.headers['cillhub-signature'] ?? ctx.req.headers['cillcord-signature'], // old name accepted for one release
  method: ctx.req.method, path: ctx.req.url, body: ctx.rawBody ?? Buffer.alloc(0), keyFor, replay,
});

// hub: the calling node (any status; callers decide), rate limited per node
export function nodeFromSignature(ctx) {
  if (!isHub) throw new HttpError(404, 0, '404: Not Found');
  let node;
  const err = verifyWith(ctx, id => (node = get('SELECT * FROM fed_nodes WHERE id = ?', id)) && publicKeyFrom(node.public_key));
  if (err) throw refused(err);
  limit('NODE', '*', {}, `node:${node.id}`, ctx.headers);
  return node;
}
export function requireActive(node) {
  if (node.status !== 'active') {
    const e = new HttpError(403, 0, `This node is ${node.status}.`);
    e.body.status = node.status;
    throw e;
  }
}

// node: a call signed with the network key (never a key some URL served us), while we are linked
export function fromHub(ctx) {
  if (isHub || !fedState()) throw new HttpError(404, 0, '404: Not Found');
  const err = verifyWith(ctx, id => id === 'hub' && TRUSTED);
  if (err) throw refused(err);
}

// --- the node's link state (instance setting 'federation') -------------------------------------------------------------
// {hub_url, hub_public_key, hub_name, node_id, node_url, linked_at, status, last_heartbeat_at, last_error}
export const fedState = () => (isHub ? null : setting('federation'));
// leaving 'active' (unlinked here or by the hub, suspended, banned) ends every session of the hub-linked accounts
export function setFedState(v) {
  const wasActive = fedState()?.status === 'active';
  setSetting('federation', v);
  if (wasActive && v?.status !== 'active') endHubSessions();
}
export function endHubSessions() {
  for (const { id } of all(`SELECT id FROM users WHERE home = 'hub'`)) {
    const hashes = all('SELECT token_hash FROM tokens WHERE user_id = ?', id).map(t => t.token_hash);
    run('DELETE FROM tokens WHERE user_id = ?', id);
    hashes.forEach(closeTokenSessions);
    refreshPresence(id);
  }
}
// CORS: a linked node lets only its hub's web client call it cross-origin (REST and CDN): on the hub's site, or bundled in
// the desktop app (1.2.0+), which runs it from app://cillhub. Everything else keeps '*' (token auth, no cookies), so local
// development against an API on another port still works.
export const DESKTOP_ORIGIN = 'app://cillhub';
export const corsOrigin = origin => {
  const hub = fedState()?.hub_url;
  return !hub ? '*' : origin === DESKTOP_ORIGIN ? DESKTOP_ORIGIN : hub;
};
export const mode = () => (isHub ? 'hub' : fedState() ? 'connected' : 'standalone');
export const signInPolicy = () => setting('sign_in') ?? 'both'; // local | hub | both (only matters while connected)
export const hubLoginOpen = () => { const f = fedState(); return !!f && f.status === 'active' && signInPolicy() !== 'local'; };
export const localLoginOpen = () => !(fedState() && signInPolicy() === 'hub');

export const humanCount = () => get("SELECT COUNT(*) AS n FROM users WHERE bot = 0 AND system = 0 AND deleted = 0").n;

// directory listings of this instance with live guild data (node: sent to the hub with every heartbeat)
export function localListings(base) {
  return all(`SELECT d.*, g.name AS gname, g.icon, g.banner, g.description AS gdesc FROM directory_entries d JOIN guilds g ON g.id = d.guild_id
              WHERE d.node_id = '' ORDER BY d.created_at LIMIT 100`).map(d => ({
    guild_id: d.guild_id, name: d.gname, description: (d.gdesc ?? '').slice(0, 300), tags: JSON.parse(d.tags), category: d.category, language: d.language,
    invite_code: d.invite_code, member_count: get('SELECT COUNT(*) AS n FROM members WHERE guild_id = ?', d.guild_id).n,
    icon_url: d.icon ? `${base}/icons/${d.guild_id}/${d.icon}.png` : null, banner_url: d.banner ? `${base}/banners/${d.guild_id}/${d.banner}.png` : null,
  }));
}

// POST /federation/heartbeat to the hub: our record and our listed servers; the answer carries our status there
export async function heartbeat() {
  const f = fedState();
  if (!f) return null;
  const servers = localListings(f.node_url);
  const body = {
    name: setting('instance_name'), description: setting('motd'), version: VERSION, mode: 'connected', sign_in: signInPolicy(),
    member_count: humanCount(), public_servers_count: servers.length, servers, update: await updateReport(),
  };
  let next = { last_heartbeat_at: new Date().toISOString(), last_error: null };
  try {
    const r = await hubFetch(f.hub_url, '/federation/heartbeat', body, { keyId: f.node_id });
    if (r.status === 200) {
      const hidden = Array.isArray(r.body?.hidden) ? r.body.hidden.filter(h => /^\d{1,19}$/.test(h?.guild_id ?? '')).slice(0, 100).map(h => ({ guild_id: h.guild_id, reason: typeof h.reason === 'string' ? h.reason.slice(0, 200) : null })) : [];
      next = { ...next, status: r.body?.status ?? 'active', hub_name: r.body?.hub_name ?? f.hub_name, hidden };
    }
    else if (r.status === 403 && ['suspended', 'banned', 'unlinked'].includes(r.body?.status)) next.status = r.body.status;
    else next.last_error = `hub answered HTTP ${r.status}`;
  } catch (e) {
    next.last_error = `hub unreachable: ${e.message}`;
  }
  const now = fedState();
  if (!now || now.node_id !== f.node_id) return null; // unlinked meanwhile
  if (next.status === 'unlinked') return setFedState(null), { status: 'unlinked' };
  setFedState({ ...now, ...next });
  return fedState();
}
const HEARTBEAT_MS = 5 * 60_000;
export function startHeartbeat() {
  if (isHub) return;
  setTimeout(() => heartbeat(), 2000).unref();
  setInterval(() => heartbeat(), HEARTBEAT_MS).unref();
}

// node: a push for a linked hub account goes to the hub too (signed NOTIFY), which delivers it over the user's own
// Web Push / FCM registrations there. Fire and forget.
export function relayPush(userId, payload, data) {
  const f = fedState();
  if (!f || f.status !== 'active') return;
  const u = userById(userId);
  if (!u?.hub_user_id) return;
  hubFetch(f.hub_url, '/federation/notify', {
    user_id: u.hub_user_id, title: payload.title, body: payload.body, url: payload.url, tag: payload.tag,
    data: { type: data?.type ?? 'notice', channel_id: data?.channel_id ?? null, message_id: data?.message_id ?? null },
  }, { keyId: f.node_id }).catch(e => console.error(`hub notify failed: ${e.message}`));
}

// hub: a signed event to a node (user_update, status, update_request). node_id is inside the signed body so a node
// that sees the request cannot replay it at another node inside the clock window (the signature does not name the host).
export function hubEvent(node, event) {
  return signedFetch(node.url, '/federation/hub/events', { ...event, node_id: node.id }, { keyId: 'hub' })
    .catch(e => console.error(`node event failed (${node.id}): ${e.message}`));
}

// hub: profile changes go to the nodes where the user has an account
export function pushUserUpdate(u, base) {
  if (!isHub) return;
  const nodes = all(`SELECT n.* FROM fed_node_accounts a JOIN fed_nodes n ON n.id = a.node_id WHERE a.user_id = ? AND n.status = 'active'`, u.id);
  const user = hubUserClaims(u, base);
  for (const n of nodes) hubEvent(n, { type: 'user_update', user });
}
export const hubUserClaims = (u, base) => ({
  id: u.id, username: u.username, global_name: u.global_name ?? null, avatar_url: u.avatar ? `${base}/avatars/${u.id}/${u.avatar}.png` : null,
});

// GET /.well-known/cillhub (and the old /.well-known/cillcord)
export const wellKnownCillcord = req => {
  const f = fedState();
  return {
    name: setting('instance_name'), version: VERSION, role: ROLE, mode: mode(), public_key: PUBLIC_KEY, api: `${originOf(req).http}/api/v9`,
    node_id: f?.node_id ?? null, hub_url: isHub ? null : f?.hub_url ?? HUB_URL,
  };
};
