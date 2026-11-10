// v7 hub role: link codes, linking nodes, heartbeats, the hub as identity provider for linked nodes (authorization code +
// PKCE, EdDSA ID tokens), node -> hub NOTIFY, the Nodes admin pages and release channel. On a node every route here is 404.
import { createHash } from 'node:crypto';
import { snowflake } from '../snowflake.js';
import { get, all, run, tx, userObj } from '../db.js';
import { HttpError, str, invalid, notFound, missingAccess } from '../errors.js';
import { setting, setSetting, adminAudit, adminAuditObj } from '../instance.js';
import { checkLogin, loginFailed, netOf } from '../ratelimit.js';
import { requireMfa } from '../mfa.js';
import { pushTo } from '../push.js';
import {
  isHub, PUBLIC_KEY, KEY, instanceUrl, publicUrl, fetchJson, signedFetch, nodeFromSignature, requireActive, hubEvent, hubUserClaims,
} from '../federation.js';
import { publicKeyFrom, signJwt, pkceOk, randomCode } from '../fedcrypto.js';

export const hubOnly = () => { if (!isHub) throw new HttpError(404, 0, '404: Not Found'); };
const iso = ms => (ms ? new Date(ms).toISOString() : null);
const hash = s => createHash('sha256').update(String(s)).digest('hex');
const ONLINE_MS = 15 * 60_000; // three missed heartbeats
// node-provided text: control and bidi-override characters become spaces, then trimmed and cut to max
export const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g, ' ').trim().slice(0, max) : '');

// the node directory record of CONTRACT-v7 §2 (users, directory entries, the consent screen)
export const nodePublic = n => n && {
  node_id: n.id, name: n.name, url: n.url, description: n.description, icon: null, version: n.version, mode: n.mode,
  public_servers_count: n.public_servers_count, member_count: n.member_count, online: !!n.last_seen && Date.now() - n.last_seen < ONLINE_MS,
  last_seen: iso(n.last_seen), status: n.status,
};
// admins also see the sign-in policy, the reason of the last status change, how many hub users / listed servers it has and
// its last update report (auto-update settings, latest version it saw, last update result)
export const nodeObj = n => ({
  ...nodePublic(n), sign_in: n.sign_in, status_reason: n.status_reason, linked_at: iso(n.linked_at), update: setting('node_updates')?.[n.id] ?? null,
  users_count: get('SELECT COUNT(*) AS n FROM fed_node_accounts WHERE node_id = ?', n.id).n,
  servers_count: get('SELECT COUNT(*) AS n FROM directory_entries WHERE node_id = ?', n.id).n,
});
const loadNode = id => get('SELECT * FROM fed_nodes WHERE id = ?', id) ?? (() => { throw notFound(0, 'Node'); })();

// --- link codes ---------------------------------------------------------------------------------------------------------
const CODE_TTL = 24 * 3600e3;
const linkCodeObj = r => ({
  id: r.id, created_by: r.created_by, created_at: iso(r.created_at), expires_at: iso(r.expires_at), used_at: iso(r.used_at), node_id: r.node_id,
  note: r.note, status: r.used_at ? 'used' : r.expires_at <= Date.now() ? 'expired' : 'valid',
});
function newLinkCode(userId, note) {
  const code = `CCL-${randomCode(18)}`;
  const id = snowflake();
  const now = Date.now();
  run('INSERT INTO fed_link_codes (id, code_hash, created_by, created_at, expires_at, note) VALUES (?, ?, ?, ?, ?, ?)',
    id, hash(code), userId, now, now + CODE_TTL, clean(note, 200) || null);
  return { ...linkCodeObj(get('SELECT * FROM fed_link_codes WHERE id = ?', id)), code }; // the code is shown once
}
function adminLinkCode(ctx) {
  hubOnly();
  requireMfa(ctx); // a link code lets a new node into the network
  ctx.status = 201;
  const out = newLinkCode(ctx.user.id, ctx.body?.note);
  ctx.audit = { action: 'federation.link_code.create', target_type: 'link_code', target_id: out.id };
  return out;
}
// any hub user with 2FA, when the hub admin allows it (setting federation_user_link_codes); their 2FA code per request
function userLinkCode(ctx) {
  hubOnly();
  if (!setting('federation_user_link_codes')) throw missingAccess();
  if (!ctx.user.mfa_secret) throw new HttpError(403, 60003, 'Enable two-factor authentication to create link codes.');
  requireMfa(ctx);
  if (get('SELECT COUNT(*) AS n FROM fed_link_codes WHERE created_by = ? AND used_at IS NULL AND expires_at > ?', ctx.user.id, Date.now()).n >= 3) {
    throw new HttpError(400, 0, 'You already have 3 unused link codes.');
  }
  ctx.status = 201;
  return newLinkCode(ctx.user.id, ctx.body?.note);
}

// --- linking ------------------------------------------------------------------------------------------------------------
// POST /federation/link {code, node_url, node_public_key, name?}: the node proves it serves that key at its URL
async function link(ctx) {
  hubOnly();
  const b = ctx.body ?? {};
  const code = str(b, 'code', 1, 100);
  const url = instanceUrl(b.node_url, 'node_url');
  if (!publicKeyFrom(b.node_public_key)) throw invalid('node_public_key', 'BASE_TYPE_BAD_VALUE', 'Must be a base64url Ed25519 public key.');
  const guard = [`link:${netOf(ctx.ip)}`];
  checkLogin(guard, ctx.headers);
  const valid = () => get('SELECT * FROM fed_link_codes WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?', hash(code), Date.now());
  const badCode = () => invalid('code', 'FED_LINK_CODE_INVALID', 'Unknown, used or expired link code.');
  if (!valid()) { loginFailed(guard); throw badCode(); }
  const existing = get('SELECT * FROM fed_nodes WHERE url = ?', url);
  if (existing?.status === 'banned') throw new HttpError(403, 0, 'This node is banned from the hub.');
  if (existing && existing.status !== 'unlinked') throw new HttpError(400, 0, 'This node is already linked; unlink it first.');
  let wk;
  // the key must be the body of that exact URL. A redirect, even to another path on the same host, is not proof.
  try { wk = await fetchJson(`${url}/.well-known/cillhub`, { maxBytes: 64 * 1024, maxRedirects: 0 }); }
  catch (e) {
    const redirect = /redirect/i.test(e.message ?? '');
    throw new HttpError(400, 0, redirect
      ? 'The node must serve its public key directly at /.well-known/cillhub (redirects are not accepted).'
      : `Could not reach the node: ${e.message}`);
  }
  if (wk.status !== 200 || wk.body?.public_key !== b.node_public_key) throw new HttpError(400, 0, 'The node does not serve this public key at /.well-known/cillhub.');
  const name = clean(b.name ?? wk.body.name, 100) || new URL(url).host;
  const id = existing?.id ?? snowflake();
  const now = Date.now();
  // a suspension is remembered past unlink, so a fresh link code does not put the node back in the directory
  const held = existing ? suspensionHeld(existing.id) : false;
  const linkStatus = held ? 'suspended' : 'active';
  const linkReason = held ? (suspensions()[id] ?? null) : null;
  const row = tx(() => { // the code is claimed after the awaits, so it cannot be spent twice
    const r = valid();
    if (!r || run('UPDATE fed_link_codes SET used_at = ?, node_id = ? WHERE id = ? AND used_at IS NULL', now, id, r.id).changes !== 1) throw badCode();
    if (existing) {
      run(`UPDATE fed_nodes SET public_key = ?, name = ?, status = ?, status_reason = ?, linked_at = ?, last_seen = ?, created_by = ? WHERE id = ?`,
        b.node_public_key, name, linkStatus, linkReason, now, now, r.created_by, id);
    } else {
      run(`INSERT INTO fed_nodes (id, url, public_key, name, linked_at, last_seen, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        id, url, b.node_public_key, name, now, now, r.created_by);
    }
    return r;
  });
  adminAudit({ action: 'federation.link', targetType: 'node', targetId: id, details: { url, link_code_id: row.id, created_by: row.created_by, status: linkStatus }, ip: ctx.ip });
  return { node_id: id, hub_public_key: PUBLIC_KEY, hub_url: publicUrl(ctx.req), hub_name: setting('instance_name'), status: linkStatus };
}

// --- directory sync (heartbeat) -----------------------------------------------------------------------------------------
export const CATEGORIES = ['esports', 'gaming', 'community', 'music', 'education', 'tech', 'art', 'entertainment', 'other'];
// validated listing fields from a server owner or a node; throws a form error
export function listingInput(b) {
  if (!CATEGORIES.includes(b?.category)) throw invalid('category', 'BASE_TYPE_CHOICES', `Must be one of ${CATEGORIES.join(', ')}.`);
  const tags = b.tags ?? [];
  if (!Array.isArray(tags) || tags.length > 5) throw invalid('tags', 'BASE_TYPE_MAX_LENGTH', 'At most 5 tags.');
  const cleanTags = [...new Set(tags.map(t => clean(t, 30).toLowerCase()).filter(Boolean))];
  const language = b.language ?? null;
  if (language !== null && !/^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(language)) throw invalid('language', 'BASE_TYPE_BAD_VALUE', 'Must be a language tag like en or de-AT.');
  return { description: clean(b.description ?? '', 300), tags: cleanTags, category: b.category, language };
}
const nodeAsset = (node, v) => (typeof v === 'string' && v.length <= 300 && v.startsWith(`${node.url}/`) && /^[\w/.-]+$/.test(v.slice(node.url.length)) ? v : null);

// hides live in an instance setting so deleting the directory row (unlist, or a heartbeat that omits the guild) cannot
// clear them. Seeded once from rows that are already hidden. `{}` is a real map, not "not seeded yet".
function directoryHides() {
  let v = setting('directory_hides');
  if (v == null) {
    v = Object.fromEntries(all(`SELECT node_id, guild_id, hidden_reason FROM directory_entries WHERE hidden = 1`).map(r => [`${r.node_id}:${r.guild_id}`, r.hidden_reason]));
    setSetting('directory_hides', v);
  }
  return v;
}
const hideKey = (nodeId, guildId) => `${nodeId}:${guildId}`;
export function rememberedHide(nodeId, guildId) {
  const reason = directoryHides()[hideKey(nodeId, guildId)];
  return reason === undefined ? null : { reason };
}
export function rememberHide(nodeId, guildId, reason) {
  setSetting('directory_hides', { ...directoryHides(), [hideKey(nodeId, guildId)]: reason ?? null });
}
export function forgetHide(nodeId, guildId) {
  const v = { ...directoryHides() };
  delete v[hideKey(nodeId, guildId)];
  setSetting('directory_hides', v);
}

// the same idea for suspensions: unlink deletes nothing that would let a new link code restore an active node
function suspensions() {
  let v = setting('node_suspensions');
  if (v == null) {
    v = Object.fromEntries(all(`SELECT id, status_reason FROM fed_nodes WHERE status = 'suspended'`).map(n => [n.id, n.status_reason]));
    setSetting('node_suspensions', v);
  }
  return v;
}
const suspensionHeld = id => Object.hasOwn(suspensions(), id);
function rememberSuspension(id, reason) { setSetting('node_suspensions', { ...suspensions(), [id]: reason ?? null }); }
function forgetSuspension(id) { const v = { ...suspensions() }; delete v[id]; setSetting('node_suspensions', v); }

function syncListings(node, servers) {
  const keep = [];
  const now = Date.now();
  for (const s of Array.isArray(servers) ? servers.slice(0, 100) : []) {
    let input;
    try { input = listingInput(s); } catch { continue; } // a bad entry is skipped, the rest still syncs
    const name = clean(s.name, 100);
    if (!/^\d{1,19}$/.test(s.guild_id ?? '') || !name || (s.invite_code && !/^[\w-]{2,32}$/.test(s.invite_code))) continue;
    const members = Number.isInteger(s.member_count) && s.member_count >= 0 ? Math.min(s.member_count, 1e7) : 0;
    const hide = rememberedHide(node.id, s.guild_id);
    keep.push(s.guild_id);
    run(`INSERT INTO directory_entries (id, node_id, guild_id, name, description, icon_url, banner_url, tags, category, language, member_count, invite_code, hidden, hidden_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (node_id, guild_id) DO UPDATE SET name = excluded.name, description = excluded.description, icon_url = excluded.icon_url,
           banner_url = excluded.banner_url, tags = excluded.tags, category = excluded.category, language = excluded.language,
           member_count = excluded.member_count, invite_code = excluded.invite_code, hidden = excluded.hidden, hidden_reason = excluded.hidden_reason, updated_at = excluded.updated_at`,
    snowflake(), node.id, s.guild_id, name, input.description, nodeAsset(node, s.icon_url), nodeAsset(node, s.banner_url), JSON.stringify(input.tags),
    input.category, input.language, members, s.invite_code ?? '', hide ? 1 : 0, hide?.reason ?? null, now, now);
  }
  run(`DELETE FROM directory_entries WHERE node_id = ? AND guild_id NOT IN (SELECT value FROM json_each(?))`, node.id, JSON.stringify(keep));
  return keep.length;
}

// POST /federation/heartbeat (signed): every 5 minutes; refreshes the node record and its listed servers
function heartbeat(ctx) {
  const node = nodeFromSignature(ctx);
  if (node.status === 'banned' || node.status === 'unlinked') requireActive(node);
  const b = ctx.body ?? {};
  if (node.status === 'suspended') { // still alive, but its record and listings stay as the hub admin froze them
    run('UPDATE fed_nodes SET last_seen = ? WHERE id = ?', Date.now(), node.id);
    return { status: node.status, hub_name: setting('instance_name'), listed_servers: 0, hidden: [] };
  }
  const count = n => (Number.isInteger(n) && n >= 0 ? Math.min(n, 1e9) : 0);
  const listed = syncListings(node, b.servers);
  run(`UPDATE fed_nodes SET name = ?, description = ?, version = ?, sign_in = ?, member_count = ?, public_servers_count = ?, last_seen = ? WHERE id = ?`,
    clean(b.name, 100) || node.name, clean(b.description, 300) || null, clean(b.version, 40) || null,
    ['local', 'hub', 'both'].includes(b.sign_in) ? b.sign_in : null, count(b.member_count), listed, Date.now(), node.id);
  storeUpdateReport(node.id, b.update);
  // hidden: the node's servers hub admins took out of the directory, so their owners see it on the node
  const hidden = all('SELECT guild_id, hidden_reason FROM directory_entries WHERE node_id = ? AND hidden = 1', node.id).map(d => ({ guild_id: d.guild_id, reason: d.hidden_reason }));
  return { status: node.status, hub_name: setting('instance_name'), listed_servers: listed, hidden };
}

// the update part of a heartbeat, cleaned; kept per node in the setting node_updates
// shortcut: one JSON setting for all nodes, rewritten on each heartbeat; move to a fed_nodes column past a few hundred nodes
function storeUpdateReport(nodeId, u) {
  if (!u || typeof u !== 'object') return;
  const hour = Number.isInteger(u.auto_update_hour) && u.auto_update_hour >= 0 && u.auto_update_hour <= 23 ? u.auto_update_hour : null;
  const r = u.last_result && typeof u.last_result === 'object' ? u.last_result : null;
  const a = u.last_auto && typeof u.last_auto === 'object' ? u.last_auto : null;
  const report = {
    updater: u.updater === true, auto_update: ['off', 'patch', 'all'].includes(u.auto_update) ? u.auto_update : null, auto_update_hour: hour,
    remote_update: u.remote_update === true, latest_version: clean(u.latest_version, 40) || null,
    last_result: r && {
      action: ['update', 'rollback'].includes(r.action) ? r.action : null, version: clean(r.version, 40) || null,
      state: ['idle', 'updating', 'rolling_back', 'done', 'failed'].includes(r.state) ? r.state : null,
      rolled_back: typeof r.rolled_back === 'boolean' ? r.rolled_back : null, error: clean(r.error, 300) || null, at: clean(r.at, 40) || null,
    },
    last_auto: a && { at: clean(a.at, 40) || null, version: clean(a.version, 40) || null, decision: clean(a.decision, 200) || null },
    reported_at: new Date().toISOString(),
  };
  setSetting('node_updates', { ...setting('node_updates'), [nodeId]: report });
}

// POST /federation/unlink (signed): the node leaves
function nodeUnlink(ctx) {
  const node = nodeFromSignature(ctx);
  if (node.status === 'banned') return; // a ban outlasts the node leaving
  setStatus(node, 'unlinked', 'unlinked by the node');
  adminAudit({ action: 'federation.unlink_by_node', targetType: 'node', targetId: node.id, ip: ctx.ip });
}

function setStatus(node, status, reason = null) {
  run('UPDATE fed_nodes SET status = ?, status_reason = ? WHERE id = ?', status, reason, node.id);
  if (status === 'unlinked' || status === 'banned') run('DELETE FROM directory_entries WHERE node_id = ?', node.id);
}

// --- identity provider for linked nodes ---------------------------------------------------------------------------------
const codes = new Map(); // sha256(code) -> {nodeId, userId, redirect, challenge, expires}
const CODE_MS = 60_000;
// the only redirect the hub will send a browser to: the node's federation callback, with nothing else on the URL
function nodeCallback(node, raw) {
  const bad = () => invalid('redirect_uri', 'BASE_TYPE_BAD_VALUE', "Must be this node's federation callback.");
  if (String(raw ?? '').length > 500) throw bad();
  let u;
  try { u = new URL(String(raw ?? '')); } catch { throw bad(); }
  if (u.origin !== node.url || u.pathname !== '/api/v9/federation/hub-callback' || u.search || u.hash || u.username || u.password) throw bad();
  return `${node.url}/api/v9/federation/hub-callback`;
}
function client(src) {
  const id = String(src.client_id ?? '');
  const node = /^\d{1,19}$/.test(id) && get(`SELECT * FROM fed_nodes WHERE id = ? AND status = 'active'`, id);
  if (!node) throw invalid('client_id', 'FED_NODE_UNKNOWN', 'Unknown or inactive node.');
  const redirect = nodeCallback(node, src.redirect_uri);
  if (src.code_challenge_method !== 'S256' || !/^[A-Za-z0-9_-]{43}$/.test(String(src.code_challenge ?? ''))) {
    throw invalid('code_challenge', 'BASE_TYPE_BAD_VALUE', 'PKCE with code_challenge_method S256 is required.');
  }
  if (src.scope != null && src.scope !== 'identify') throw invalid('scope', 'BASE_TYPE_CHOICES', 'Only identify.');
  if (src.state != null && String(src.state).length > 500) throw invalid('state', 'BASE_TYPE_BAD_LENGTH', 'At most 500 characters.');
  return { node, redirect };
}
// GET/POST /oauth2/authorize with a node as client_id (routes/applications.js hands these over): the user API's consent
// preview and answer (OAuth2 authorization code flow, PKCE S256 required, scope identify)
export const isNodeClient = id => isHub && /^\d{1,19}$/.test(id ?? '') && !!get('SELECT 1 FROM fed_nodes WHERE id = ?', id);
// GET ?client_id&redirect_uri&response_type=code&code_challenge&code_challenge_method=S256&scope=identify&state -> what the consent screen shows
export function nodeConsentInfo(ctx) {
  const { node, redirect } = client(Object.fromEntries(ctx.query));
  return { node: nodePublic(node), user: userObj(ctx.user), authorized: false, scope: ['identify'], redirect_uri: redirect };
}
// POST (same query) {authorize: bool} -> {location}: the redirect URI with a 60 s single-use code bound to the PKCE challenge,
// or error=access_denied when the user declined
export function nodeConsent(ctx) {
  const q = Object.fromEntries(ctx.query);
  const { node, redirect } = client(q);
  const now = Date.now();
  const state = q.state != null ? { state: String(q.state) } : {};
  const to = params => ({ location: `${redirect}${redirect.includes('?') ? '&' : '?'}${new URLSearchParams(params)}` });
  if (ctx.body?.authorize !== true) return to({ error: 'access_denied', ...state });
  for (const [k, c] of codes) if (c.expires <= now) codes.delete(k);
  const code = randomCode();
  codes.set(hash(code), { nodeId: node.id, userId: ctx.user.id, redirect, challenge: q.code_challenge, expires: now + CODE_MS });
  return to({ code, ...state });
}
// POST /federation/token (signed by the node) {code, code_verifier, redirect_uri} -> {id_token, token_type, expires_in}
function token(ctx) {
  const node = nodeFromSignature(ctx);
  requireActive(node);
  const b = ctx.body ?? {};
  const key = hash(b.code);
  const c = codes.get(key);
  codes.delete(key);
  const grant = () => new HttpError(400, 0, 'invalid_grant');
  if (!c || c.nodeId !== node.id || c.expires <= Date.now() || c.redirect !== b.redirect_uri || !pkceOk(b.code_verifier, c.challenge)) throw grant();
  const u = get('SELECT * FROM users WHERE id = ? AND deleted = 0 AND disabled = 0 AND bot = 0 AND system = 0', c.userId);
  if (!u) throw grant();
  const now = Date.now();
  run(`INSERT INTO fed_node_accounts (node_id, user_id, created_at, last_login) VALUES (?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET last_login = excluded.last_login`, node.id, u.id, now, now);
  const base = publicUrl(ctx.req);
  const { id, ...profile } = hubUserClaims(u, base);
  const iat = Math.floor(now / 1000);
  return {
    id_token: signJwt(KEY, { iss: base, aud: node.id, sub: id, iat, exp: iat + 300, jti: randomCode(16), ...profile }),
    token_type: 'id_token', expires_in: 300,
  };
}

// --- NOTIFY: node -> hub -> the user's Web Push / FCM registrations on the hub --------------------------------------------
const PUSH_URL = /^\/channels\/(\d{1,19}|@me)\/\d{1,19}(\/\d{1,19})?$/;
function notify(ctx) {
  const node = nodeFromSignature(ctx);
  requireActive(node);
  const b = ctx.body ?? {};
  const userId = String(b.user_id ?? '');
  if (!get('SELECT 1 FROM fed_node_accounts WHERE node_id = ? AND user_id = ?', node.id, userId)) throw notFound(10013, 'User');
  const d = b.data ?? {};
  const type = ['message', 'call', 'notice'].includes(d.type) ? d.type : 'notice';
  const snow = v => (typeof v === 'string' && /^\d{1,19}$/.test(v) ? v : null);
  const url = typeof b.url === 'string' && PUSH_URL.test(b.url) ? b.url : null;
  const where = { id: node.id, url: node.url, name: node.name };
  pushTo([userId], null, 'message', { title: clean(b.title, 100) || node.name, body: clean(b.body, 200), url, tag: `node:${node.id}:${clean(b.tag, 40)}`, node: where },
    { type: `node_${type}`, node_id: node.id, node_url: node.url, channel_id: snow(d.channel_id), message_id: snow(d.message_id) });
}

// --- admin: nodes, settings, release channel -----------------------------------------------------------------------------
export const hubAdminView = req => ({
  role: 'hub', url: publicUrl(req), public_key: PUBLIC_KEY, user_link_codes: !!setting('federation_user_link_codes'), release: setting('release'),
  nodes: Object.fromEntries(all('SELECT status, COUNT(*) AS n FROM fed_nodes GROUP BY status').map(r => [r.status, r.n])),
});
function listNodes({ query }) {
  hubOnly();
  const status = query.get('status');
  return all(`SELECT * FROM fed_nodes WHERE (? IS NULL OR status = ?) ORDER BY linked_at DESC LIMIT 500`, status, status).map(nodeObj);
}
function nodeDetail({ params }) {
  hubOnly();
  const n = loadNode(params.node_id);
  return {
    ...nodeObj(n), created_by: n.created_by,
    accounts: get('SELECT COUNT(*) AS n FROM fed_node_accounts WHERE node_id = ?', n.id).n,
    servers: all('SELECT * FROM directory_entries WHERE node_id = ? ORDER BY member_count DESC', n.id)
      .map(d => ({ id: d.id, guild_id: d.guild_id, name: d.name, member_count: d.member_count, hidden: !!d.hidden })),
    link_codes: all('SELECT * FROM fed_link_codes WHERE node_id = ? ORDER BY created_at DESC', n.id).map(linkCodeObj),
    audit_log: all(`SELECT * FROM admin_audit_log WHERE target_type = 'node' AND target_id = ? ORDER BY created_at DESC LIMIT 100`, n.id).map(adminAuditObj),
  };
}
const STATUS_ACTIONS = { suspend: 'suspended', unsuspend: 'active', ban: 'banned', unlink: 'unlinked' };
async function nodeAction(ctx) {
  hubOnly();
  const n = loadNode(ctx.params.node_id);
  const status = STATUS_ACTIONS[ctx.params.action];
  if (!status) throw notFound(0, 'Action');
  requireMfa(ctx); // suspend and unsuspend too: each changes what the whole network sees
  if (n.status === 'banned' && status !== 'banned') throw new HttpError(400, 0, 'A banned node stays banned.');
  const reason = clean(ctx.body?.reason, 200) || null;
  if (ctx.params.action === 'unsuspend') {
    const stillUnlinked = n.status === 'unlinked' && suspensionHeld(n.id);
    if (n.status !== 'suspended' && !stillUnlinked) throw new HttpError(400, 0, 'Only a suspended node can be unsuspended.');
    // unlinked stays unlinked: forgetting the suspension is what a later link code is allowed to clear
    if (stillUnlinked) {
      forgetSuspension(n.id);
      ctx.audit = { action: 'node.unsuspend', target_type: 'node', target_id: n.id, details: { reason: ctx.body?.reason ?? null } };
      return nodeObj(n);
    }
  }
  if (ctx.params.action === 'suspend') rememberSuspension(n.id, reason);
  setStatus(n, status, reason);
  if (ctx.params.action === 'unsuspend') forgetSuspension(n.id);
  if (n.status !== 'unlinked') await hubEvent(n, { type: 'status', status }); // tell the node at once; it also learns from its heartbeat
  ctx.audit = { action: `node.${ctx.params.action}`, target_type: 'node', target_id: n.id, details: { reason: ctx.body?.reason ?? null } };
  return nodeObj(loadNode(n.id));
}
// POST /admin/federation/nodes/:node_id/update {code}: a signed update_request to the node; it updates to the release its
// signed feed offers, unless its admin turned remote requests off. Answers {node, result: {status, accepted, message}}.
async function requestUpdate(ctx) {
  hubOnly();
  const n = loadNode(ctx.params.node_id);
  requireMfa(ctx);
  if (n.status !== 'active') throw new HttpError(400, 0, 'Only an active node can be asked to update.');
  let r;
  try { r = await signedFetch(n.url, '/federation/hub/events', { type: 'update_request', node_id: n.id }, { keyId: 'hub' }); } catch (e) { r = { status: 0, body: { message: e.message } }; }
  const result = { status: r.status, accepted: r.status === 202, message: clean(r.body?.message ?? r.body?.step ?? '', 300) || null };
  ctx.audit = { action: 'node.update_request', target_type: 'node', target_id: n.id, details: result };
  return { node: nodeObj(n), result };
}
function listLinkCodes() {
  hubOnly();
  return all('SELECT * FROM fed_link_codes ORDER BY created_at DESC LIMIT 200').map(linkCodeObj);
}
function deleteLinkCode(ctx) {
  hubOnly();
  if (!run('DELETE FROM fed_link_codes WHERE id = ? AND used_at IS NULL', ctx.params.code_id).changes) throw notFound(0, 'Link code');
  ctx.audit = { action: 'federation.link_code.delete', target_type: 'link_code', target_id: ctx.params.code_id };
}
const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,32})?$/;
function putRelease(ctx) {
  hubOnly();
  requireMfa(ctx); // nodes are offered this version
  const version = str(ctx.body, 'version', 5, 48);
  if (!SEMVER.test(version)) throw invalid('version', 'BASE_TYPE_BAD_VALUE', 'Must be a version like 7.0.0.');
  const release = { version, notes: clean(ctx.body.notes ?? '', 4000), published_at: new Date().toISOString() };
  setSetting('release', release);
  ctx.audit = { action: 'federation.release', target_type: 'release', target_id: version };
  return release;
}
// GET /server/releases/latest (public): the version the hub offers nodes; the updater adds the file names
function latestRelease(ctx) {
  hubOnly();
  const r = setting('release');
  if (!r) throw notFound(0, 'Release');
  return { ...r, download_base: `${publicUrl(ctx.req)}/download/server/` };
}
// GET /federation/nodes (users): linked nodes (active or suspended) a hub user can add from; pasted node invite links are
// matched by url, and the client cuts off suspended ones
const activeNodes = () => (hubOnly(), all(`SELECT * FROM fed_nodes WHERE status IN ('active', 'suspended') ORDER BY name`).map(nodePublic));

const admin = { admin: true };
export default [
  ['POST', '/federation/link', link, { open: true }],
  ['POST', '/federation/heartbeat', heartbeat, { open: true }],
  ['POST', '/federation/unlink', nodeUnlink, { open: true }],
  ['POST', '/federation/token', token, { open: true }],
  ['POST', '/federation/notify', notify, { open: true }],
  ['GET', '/federation/nodes', activeNodes, { userOnly: true }],
  ['POST', '/federation/link-codes', userLinkCode, { userOnly: true }],
  ['GET', '/server/releases/latest', latestRelease, { open: true }],
  ['GET', '/admin/federation/nodes', listNodes, admin],
  ['GET', '/admin/federation/nodes/:node_id', nodeDetail, admin],
  ['POST', '/admin/federation/nodes/:node_id/update', requestUpdate, admin],
  ['POST', '/admin/federation/nodes/:node_id/:action', nodeAction, admin],
  ['GET', '/admin/federation/link-codes', listLinkCodes, admin],
  ['POST', '/admin/federation/link-codes', adminLinkCode, admin],
  ['DELETE', '/admin/federation/link-codes/:code_id', deleteLinkCode, admin],
  ['GET', '/admin/federation/release', () => (hubOnly(), setting('release')), admin],
  ['PUT', '/admin/federation/release', putRelease, admin],
];
