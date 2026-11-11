// v7 node role: linking to the hub, signing in with a hub account (linked accounts), events signed by the hub, the
// Federation admin page; plus the Updates page, which talks to the host's updater sidecar (both roles).
import { randomBytes } from 'node:crypto';
import { snowflake } from '../snowflake.js';
import { get, run, audienceOf, userById, userObj } from '../db.js';
import { HttpError, str, invalid } from '../errors.js';
import { issueToken } from '../auth.js';
import { sendToUsers } from '../gateway.js';
import { saveImage, removeImage, sniff } from '../files.js';
import { setting, setSetting, adminAudit, acceptVersion } from '../instance.js';
import { requireMfa } from '../mfa.js';
import {
  isHub, ROLE, VERSION, HUB_URL, PUBLIC_KEY, TRUSTED_KEY, TRUSTED, publicUrl, returnOrigins, mode, fedState, setFedState, signInPolicy, hubLoginOpen,
  localLoginOpen, fetchJson, hubFetch, fromHub, heartbeat, instanceUrl,
} from '../federation.js';
import { verifyJwt, ReplayCache, randomCode, pkceChallenge } from '../fedcrypto.js';
import {
  hasUpdater, AUTO_MODES, autoCheck, autoUpdate, remoteUpdate, autoAllowed, callUpdater, checkNow,
} from '../updates.js';
import { hubAdminView, clean } from './hub.js';

const nodeOnly = () => { if (isHub) throw new HttpError(404, 0, '404: Not Found'); };

// hub_status sums up the link for the dashboard: linked | unlinked | suspended | banned | unreachable (last heartbeat failed)
export function fedView() {
  const f = fedState();
  return {
    role: ROLE, mode: mode(), hub_url: f?.hub_url ?? HUB_URL, linked: !!f, node_id: f?.node_id ?? null, node_url: f?.node_url ?? null,
    hub_name: f?.hub_name ?? null, status: f?.status ?? null, linked_at: f?.linked_at ?? null, last_heartbeat_at: f?.last_heartbeat_at ?? null,
    last_error: f?.last_error ?? null, sign_in: signInPolicy(), public_key: PUBLIC_KEY,
    hub_status: !f ? 'unlinked' : f.status !== 'active' ? f.status : f.last_error ? 'unreachable' : 'linked',
    last_heartbeat: f?.last_heartbeat_at ?? null, update_check: autoCheck(),
  };
}

// --- linking -------------------------------------------------------------------------------------------------------------
// the node posts its URL and key with the code; the hub checks /.well-known/cillhub and answers with its key and our node id
// hubUrl: what the admin typed (wizard or Federation page), else CILLCORD_HUB_URL; refusals name the field (hub_url, link_code)
export async function linkToHub(req, code, hubUrl) {
  nodeOnly();
  const hub = hubUrl ? instanceUrl(hubUrl, 'hub_url') : HUB_URL;
  if (!hub) throw invalid('hub_url', 'BASE_TYPE_REQUIRED', 'Enter the address of the hub.');
  if (fedState()) throw new HttpError(400, 0, 'Already linked to the hub; unlink first.');
  const nodeUrl = publicUrl(req);
  let r;
  try {
    r = await hubFetch(hub, '/federation/link', { code, node_url: nodeUrl, node_public_key: PUBLIC_KEY, name: setting('instance_name') });
  } catch (e) {
    throw invalid('hub_url', 'FED_HUB_UNREACHABLE', `The hub is unreachable: ${e.message}`);
  }
  if (r.status !== 200) {
    const msg = `The hub refused the link: ${clean(r.body?.message, 200) || `HTTP ${r.status}`}`;
    const e = new HttpError(400, 0, msg);
    e.body.errors = { link_code: { _errors: [{ code: r.body?.errors?.code?._errors?.[0]?.code ?? 'FED_LINK_REFUSED', message: msg }] } };
    throw e;
  }
  const { node_id: nodeId, hub_public_key: hubKey } = r.body ?? {};
  if (!/^\d{1,19}$/.test(nodeId ?? '') || hubKey !== TRUSTED_KEY) throw new HttpError(502, 0, 'The hub sent an invalid answer.');
  const status = r.body?.status === 'suspended' ? 'suspended' : 'active';
  setFedState({
    hub_url: hub, hub_public_key: hubKey, hub_name: clean(r.body.hub_name, 100) || null, node_id: nodeId, node_url: nodeUrl,
    linked_at: new Date().toISOString(), status, last_heartbeat_at: null, last_error: null,
  });
  await heartbeat();
  return fedView();
}

// {link_code, hub_url?} (the older {code} still works)
async function adminLink(ctx) {
  const b = ctx.body ?? {};
  const out = await linkToHub(ctx.req, str(b, b.link_code !== undefined ? 'link_code' : 'code', 1, 100), b.hub_url || undefined);
  ctx.audit = { action: 'federation.link', target_type: 'node', target_id: out.node_id };
  return out;
}
export async function unlinkFromHub() {
  const f = fedState();
  if (!f) return;
  await hubFetch(f.hub_url, '/federation/unlink', {}, { keyId: f.node_id }).catch(e => console.error(`hub unlink failed: ${e.message}`));
  setFedState(null);
}
async function adminUnlink(ctx) {
  nodeOnly();
  if (!fedState()) throw new HttpError(400, 0, 'Not linked to a hub.');
  requireMfa(ctx);
  ctx.audit = { action: 'federation.unlink', target_type: 'node', target_id: fedState().node_id };
  await unlinkFromHub();
  return fedView();
}
async function adminHeartbeat() {
  nodeOnly();
  if (!fedState()) throw new HttpError(400, 0, 'Not linked to a hub.');
  await heartbeat();
  return fedView();
}

// GET/PATCH /admin/federation: the hub's view on the hub, the node's link state on a node
const adminView = ({ req }) => (isHub ? hubAdminView(req) : fedView());
function patchFederation(ctx) {
  const b = ctx.body ?? {};
  if (isHub) {
    if (b.user_link_codes !== undefined) {
      if (typeof b.user_link_codes !== 'boolean') throw invalid('user_link_codes', 'BASE_TYPE_BOOLEAN', 'Must be a boolean.');
      setSetting('federation_user_link_codes', b.user_link_codes);
    }
  } else if (b.sign_in !== undefined) {
    if (!['local', 'hub', 'both'].includes(b.sign_in)) throw invalid('sign_in', 'BASE_TYPE_CHOICES', 'Must be local, hub or both.');
    setSetting('sign_in', b.sign_in);
  }
  if (!isHub && b.update_check !== undefined) {
    if (typeof b.update_check !== 'boolean') throw invalid('update_check', 'BASE_TYPE_BOOLEAN', 'Must be a boolean.');
    setSetting('update_check', b.update_check);
  }
  ctx.audit = { action: 'federation.settings', details: b };
  return adminView(ctx);
}

// --- sign in with the hub ---------------------------------------------------------------------------------------------------
// GET /auth/methods: what the login screen offers
function methods() {
  const f = fedState();
  return {
    role: ROLE, mode: mode(), local: localLoginOpen(), hub: hubLoginOpen(),
    hub_info: f ? { url: f.hub_url, name: f.hub_name, node_id: f.node_id, authorize_url: `${f.hub_url}/oauth2/authorize` } : null,
  };
}

// copies the hub profile (name, display name, avatar) onto the linked account; the avatar only when its URL changed
async function applyHubProfile(u, p) {
  const f = fedState();
  const next = {};
  const name = clean(p.username, 32).replace(/@/g, '');
  if (name.length >= 2 && name !== u.username && !get('SELECT 1 FROM users WHERE username = ? AND id != ?', name, u.id)) next.username = name;
  next.global_name = clean(p.global_name ?? '', 32) || null;
  const avatarUrl = typeof p.avatar_url === 'string' && f && p.avatar_url.startsWith(`${f.hub_url}/avatars/`) ? p.avatar_url : null;
  if (avatarUrl !== u.hub_avatar) {
    next.hub_avatar = avatarUrl;
    next.avatar = null;
    if (avatarUrl) {
      try {
        const r = await fetchJson(avatarUrl, { maxBytes: 8 * 1024 * 1024 });
        const type = r.status === 200 && sniff(r.bytes);
        if (type) next.avatar = await saveImage(`data:${type};base64,${r.bytes.toString('base64')}`, 'avatar', 'avatars', u.id);
      } catch (e) {
        console.error(`hub avatar copy failed: ${e.message}`);
      }
    }
  }
  for (const [k, v] of Object.entries(next)) run(`UPDATE users SET ${k} = ? WHERE id = ?`, v, u.id); // keys are fixed above
  if ('avatar' in next && next.avatar !== u.avatar) removeImage('avatars', u.id, u.avatar);
  const fresh = userById(u.id);
  sendToUsers(audienceOf(u.id), 'USER_UPDATE', id => userObj(fresh, id === u.id));
  return fresh;
}

function newLinkedAccount(claims) {
  const base = clean(claims.username, 26).replace(/@/g, '') || 'hubuser';
  let name = base.length >= 2 ? base : `${base}_hub`;
  for (let i = 2; get('SELECT 1 FROM users WHERE username = ?', name); i++) name = `${base}_${i}`;
  const id = snowflake();
  // legal_pending: a node with its own terms asks them and its minimum age on first use; without terms it asks nothing
  // (the hub's sign-up confirmed the age, and apps without the accept screen would only see refused calls)
  run(`INSERT INTO users (id, email, username, password_hash, salt, home, hub_user_id, legal_pending) VALUES (?, ?, ?, ?, ?, 'hub', ?, ?)`,
    id, `hub-${claims.sub}@hub.invalid`, name, randomBytes(64).toString('hex'), randomBytes(16).toString('hex'), claims.sub, acceptVersion() ? 1 : 0);
  return userById(id);
}

const usedTokens = new ReplayCache();
// trades an authorization code at the hub (signed) for an ID token, checks it (EdDSA, iss, aud = our node id, exp, single
// use) and returns a token of this node for the linked account (created on first sign-in)
async function hubSignIn({ code, code_verifier, redirect_uri }) {
  const f = fedState();
  let r;
  try { r = await hubFetch(f.hub_url, '/federation/token', { code, code_verifier, redirect_uri }, { keyId: f.node_id }); } catch (e) { throw new HttpError(502, 0, `The hub is unreachable: ${e.message}`); }
  if (r.status === 403 && ['suspended', 'banned', 'unlinked'].includes(r.body?.status)) setFedState({ ...fedState(), status: r.body.status });
  if (r.status !== 200) throw new HttpError(400, 0, 'The hub refused the sign-in.');
  const claims = verifyJwt(r.body?.id_token, TRUSTED, { iss: f.hub_url, aud: f.node_id });
  if (!claims || !/^\d{1,19}$/.test(claims.sub) || !usedTokens.use(String(claims.jti))) throw new HttpError(400, 0, 'The hub sent an invalid ID token.');
  let u = get('SELECT * FROM users WHERE hub_user_id = ?', claims.sub);
  const created = !u;
  if (!u) u = newLinkedAccount(claims);
  if (u.disabled || u.deleted) throw new HttpError(400, 20013, 'This account has been disabled.');
  await applyHubProfile(u, claims);
  return { token: issueToken(u.id), user_id: u.id, created };
}

// The browser side of signing in with the hub. The node is a confidential client and keeps the PKCE verifier:
// GET /federation/hub-login?return_to&state -> 302 to the hub's consent page (<hub>/oauth2/authorize?client_id=<node id>…);
// the hub sends the browser to GET /federation/hub-callback?code|error&state, which trades the code and ends with a 302 to
// return_to#token=<node token>&state=<the caller's state>&node_id=<id> (or #error=…&error_description=…&state=…).
// return_to must be on this node's pinned URL or the linked hub's (the multi-instance client), never the live Host header.
// answer=json (the hub client connecting a saved node in the background): the same steps answer JSON instead of 302s,
// {authorize_url} here and {token, node_id, state} | {error, error_description, state} from the callback.
const logins = new Map(); // our state -> {verifier, returnTo, state, expires}
const LOGIN_MS = 10 * 60_000;
const redirect = (ctx, location) => ((ctx.status = 302), (ctx.headers.Location = location), (ctx.headers['Cache-Control'] = 'no-store'), { location });
function returnTarget(raw) {
  let u;
  try { u = new URL(String(raw ?? '')); } catch { return null; }
  const ok = returnOrigins().includes(u.origin) && !u.hash && !u.username && !u.password && u.href.length <= 500;
  return ok ? u.href : null;
}
function hubLogin(ctx) {
  nodeOnly();
  const returnTo = returnTarget(ctx.query.get('return_to'));
  if (!returnTo) throw invalid('return_to', 'BASE_TYPE_BAD_VALUE', 'Must be a URL on this instance or on its hub.');
  const state = String(ctx.query.get('state') ?? '').slice(0, 200);
  const json = ctx.query.get('answer') === 'json';
  if (!hubLoginOpen()) {
    const refused = { error: 'unavailable', error_description: 'Sign-in with the hub is not available on this instance.', state };
    return json ? refused : redirect(ctx, `${returnTo}#${new URLSearchParams(refused)}`);
  }
  const f = fedState();
  const now = Date.now();
  for (const [k, l] of logins) if (l.expires <= now) logins.delete(k);
  if (logins.size > 10_000) throw new HttpError(429, 0, 'Too many sign-ins in progress; try again in a few minutes.');
  const key = randomCode(18);
  const verifier = randomCode(32);
  logins.set(key, { verifier, returnTo, state, json, expires: now + LOGIN_MS });
  const q = new URLSearchParams({
    client_id: f.node_id, redirect_uri: `${f.node_url}/api/v9/federation/hub-callback`, response_type: 'code', scope: 'identify',
    code_challenge: pkceChallenge(verifier), code_challenge_method: 'S256', state: key,
  });
  return json ? { authorize_url: `${f.hub_url}/oauth2/authorize?${q}` } : redirect(ctx, `${f.hub_url}/oauth2/authorize?${q}`);
}
async function hubCallback(ctx) {
  nodeOnly();
  const key = String(ctx.query.get('state') ?? '');
  const l = logins.get(key);
  logins.delete(key);
  if (!l || l.expires <= Date.now()) throw new HttpError(400, 0, 'This sign-in has expired. Start it again.');
  const back = params => (l.json ? { ...params, state: l.state } : redirect(ctx, `${l.returnTo}#${new URLSearchParams({ ...params, state: l.state })}`));
  if (ctx.query.get('error')) return back({ error: clean(ctx.query.get('error'), 40) || 'access_denied' });
  try {
    if (!hubLoginOpen()) throw new HttpError(403, 0, 'Sign-in with the hub is not available on this instance.');
    const f = fedState();
    const out = await hubSignIn({ code: String(ctx.query.get('code') ?? '').slice(0, 200), code_verifier: l.verifier, redirect_uri: `${f.node_url}/api/v9/federation/hub-callback` });
    return back({ token: out.token, node_id: f.node_id });
  } catch (e) {
    if (!(e instanceof HttpError)) throw e;
    return back({ error: e.status === 403 ? 'unavailable' : 'server_error', error_description: e.body.message });
  }
}

// POST /federation/hub/events (signed by the hub): {type: 'status', status} | {type: 'user_update', user} | {type: 'update_request'}
async function hubEvents(ctx) {
  fromHub(ctx);
  const b = ctx.body ?? {};
  // the signed body names this node. A copy of the same signature posted at another node does not apply there.
  if (b.node_id !== fedState().node_id) throw new HttpError(401, 0, 'Federation signature refused: event is for another node');
  // the hub admin asks for an update now: only to the release the signed feed offers, and only while the admin here allows it
  if (b.type === 'update_request') {
    const { mode } = autoUpdate();
    if (!remoteUpdate() || mode === 'off') throw new HttpError(403, 0, 'Remote update requests are turned off on this node (they need automatic updates on).');
    const c = await checkNow();
    if (!c.update_available || !c.can_update || !autoAllowed(mode, c.current_version, c.latest)) {
      throw new HttpError(409, 0, `Not updating: ${c.latest?.version ?? 'no release'} is not an update this node's automatic update mode (${mode}) allows.`);
    }
    adminAudit({ action: 'update.remote_request', ip: ctx.ip });
    ctx.status = 202;
    // auto: true makes the updater refuse a version that failed or was rolled back here before
    return callUpdater('POST', '/update', { version: c.latest.version, auto: true });
  }
  // a suspension, ban or unlink ends the sessions of hub accounts here (federation.js setFedState)
  if (b.type === 'status' && ['active', 'suspended', 'banned', 'unlinked'].includes(b.status)) {
    setFedState(b.status === 'unlinked' ? null : { ...fedState(), status: b.status });
  } else if (b.type === 'user_update' && /^\d{1,19}$/.test(b.user?.id ?? '')) {
    const u = get('SELECT * FROM users WHERE hub_user_id = ?', b.user.id);
    if (u) await applyHubProfile(u, b.user);
  } else throw new HttpError(400, 0, 'Unknown event.');
}

// --- updates (updates.js talks to selfhost's updater sidecar) ------------------------------------------------------------
async function updateStatus() {
  const { mode: auto, hour } = autoUpdate();
  const base = {
    updater: hasUpdater, current_version: VERSION, auto_check: autoCheck(), last_check: setting('update_last_check'),
    auto_update: auto, auto_update_hour: hour, remote_update: remoteUpdate(), last_auto: setting('update_last_auto'),
  };
  if (!hasUpdater) return base;
  try {
    return { ...base, reachable: true, ...await callUpdater('GET', '/status') };
  } catch (e) {
    return { ...base, reachable: false, error: e.message };
  }
}
async function applyUpdate(ctx) {
  requireMfa(ctx);
  const version = ctx.body?.version == null ? undefined : str(ctx.body, 'version', 1, 48);
  ctx.audit = { action: 'update.apply', target_type: 'release', target_id: version ?? null };
  return callUpdater('POST', '/update', version ? { version } : {});
}
async function rollback(ctx) {
  requireMfa(ctx);
  ctx.audit = { action: 'update.rollback' };
  return callUpdater('POST', '/rollback', {});
}
// {auto_check?, auto_update?, auto_update_hour?, remote_update?}; the hub hears about it with the next heartbeat
export function updateSettings(b) {
  const bool = k => { if (b[k] !== undefined && typeof b[k] !== 'boolean') throw invalid(k, 'BASE_TYPE_BOOLEAN', 'Must be a boolean.'); return b[k]; };
  if (b.auto_update !== undefined && !AUTO_MODES.includes(b.auto_update)) throw invalid('auto_update', 'BASE_TYPE_CHOICES', 'Must be off, patch or all.');
  if (b.auto_update_hour !== undefined && !(Number.isInteger(b.auto_update_hour) && b.auto_update_hour >= 0 && b.auto_update_hour <= 23)) {
    throw invalid('auto_update_hour', 'NUMBER_TYPE_COERCE', 'Must be an hour from 0 to 23.');
  }
  const out = { auto_check: bool('auto_check'), remote_update: bool('remote_update'), auto_update: b.auto_update, auto_update_hour: b.auto_update_hour };
  if (out.auto_check !== undefined) setSetting('update_check', out.auto_check);
  if (out.remote_update !== undefined) setSetting('remote_update', out.remote_update);
  if (out.auto_update !== undefined) setSetting('auto_update', out.auto_update);
  if (out.auto_update_hour !== undefined) setSetting('auto_update_hour', out.auto_update_hour);
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}
function updateConfig(ctx) {
  const details = updateSettings(ctx.body ?? {});
  ctx.audit = { action: 'update.config', details };
  if (fedState()) heartbeat().catch(() => {});
  return updateStatus();
}

const admin = { admin: true };
export default [
  ['GET', '/auth/methods', methods, { open: true }],
  ['GET', '/federation/hub-login', hubLogin, { open: true }],
  ['GET', '/federation/hub-callback', hubCallback, { open: true }],
  ['POST', '/federation/hub/events', hubEvents, { open: true }],
  ['GET', '/admin/federation', adminView, admin],
  ['PATCH', '/admin/federation', patchFederation, admin],
  ['POST', '/admin/federation/link', adminLink, admin],
  ['POST', '/admin/federation/unlink', adminUnlink, admin],
  ['POST', '/admin/federation/heartbeat', adminHeartbeat, admin],
  ['GET', '/admin/updates', updateStatus, admin],
  ['POST', '/admin/updates/check', checkNow, admin],
  ['POST', '/admin/updates/apply', applyUpdate, admin],
  ['POST', '/admin/updates/rollback', rollback, admin],
  ['PATCH', '/admin/updates', updateConfig, admin],
];
