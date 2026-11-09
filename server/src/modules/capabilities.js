// The module API (CONTRACT-v8 §4.2-§4.8) on the trusted side: every call from a sandbox is checked against the module's
// approved permissions and its servers (NOT_ENABLED first), rate limited, then executed as the module's bot by the same
// REST handlers that serve bots, so validation, channel permissions and the role hierarchy are the normal ones.
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHmac, createHash, randomBytes } from 'node:crypto';
import { get, all, run, json, isMember, memberIds, membersOf, userById } from '../db.js';
import { HttpError, str } from '../errors.js';
import { sendToUsers } from '../gateway.js';
import { voiceStates } from '../voice.js';
import { safeFetch, FetchRefused, ENV_ALLOW } from '../ssrf.js';
import { schedule as rearm } from '../timers.js';
import { richEmbeds } from '../embeds.js';
import { messageComponents } from '../components.js';
import { moderateMessage } from '../automod.js';
import { getMessage, getChannel, messageObj, broadcastMessage, insertHooks } from '../message.js';
import { interactionRecord, respond, followUp, webhookEdit } from '../interactions.js';
import channelRoutes, { loadChannel } from '../routes/channels.js';
import messageRoutes from '../routes/messages.js';
import reactionRoutes from '../routes/reactions.js';
import memberRoutes from '../routes/members.js';
import guildRoutes from '../routes/guilds.js';
import roleRoutes from '../routes/roles.js';
import {
  ModuleError, inScope, has, settingsFor, storageGet, storageSet, storageDelete, storageList, schedules, setSchedule, cancelSchedule, hit, refusalLog,
} from './store.js';

const KIB = 1024;
const YEAR = 365 * 24 * 3600 * 1000;
const SNOW = /^\d{1,19}$/;
const E = (code, message, extra) => new ModuleError(code, message, extra);

// --- the REST handlers, called as the bot -------------------------------------------------------------------------
const ROUTES = [...messageRoutes, ...reactionRoutes, ...memberRoutes, ...guildRoutes, ...roleRoutes, ...channelRoutes];
async function rest(mod, method, pattern, params, { body = {}, query = {} } = {}) {
  const handler = ROUTES.find(r => r[0] === method && r[1] === pattern)[2];
  const ctx = {
    req: { headers: {}, url: pattern, socket: {} }, params, query: new URLSearchParams(query), body, user: userById(mod.app_id), status: 200, ip: 'module', headers: {},
  };
  return (await handler(ctx)) ?? null;
}

function fromHttp(e) {
  const { code: api_code, message, errors, retry_after } = e.body;
  if (e.status === 429) return E('RATE_LIMITED', message, { retry_after });
  if (e.status === 413) return E('TOO_LARGE', message, { status: 413, api_code });
  if (e.status === 404) return E('NOT_FOUND', message, { status: 404, api_code });
  if (e.status === 400) return E('INVALID', message, { status: 400, api_code, ...(errors && { errors }) });
  return E('FORBIDDEN', message, { status: e.status, api_code });
}

// --- scope checks: a server or channel outside the module's servers is NOT_ENABLED before anything else -------------
function guildOf(mod, guildId) {
  if (typeof guildId !== 'string' || !SNOW.test(guildId) || !inScope(mod, guildId) || !isMember(guildId, mod.app_id)) {
    throw E('NOT_ENABLED', `The module is not enabled in server ${String(guildId).slice(0, 20)}.`);
  }
  return guildId;
}
function channelOf(mod, channelId) {
  const ch = typeof channelId === 'string' && SNOW.test(channelId) && getChannel(channelId);
  if (!ch?.guild_id) throw E('NOT_ENABLED', `The module is not enabled in channel ${String(channelId).slice(0, 20)}.`);
  guildOf(mod, ch.guild_id);
  return ch;
}
const id = (args, k) => {
  if (typeof args[k] !== 'string' || !SNOW.test(args[k])) throw E('INVALID', `${k} must be a snowflake.`);
  return args[k];
};

// --- rate limits (§4.3, §4.5, §4.6, §6.4) ------------------------------------------------------------------------
function limited(key, max, ms, what) {
  const wait = hit(key, max, ms);
  if (wait) throw E('RATE_LIMITED', `Rate limited: ${what}.`, { retry_after: Math.ceil(wait * 1000) / 1000 });
}
// chat writes: 5 per 5 s per channel (per server for role changes) and 60 per minute per module
function write(mod, where) {
  limited(`write:${mod.id}:${where}`, 5, 5000, 'at most 5 writes per 5 s here');
  limited(`write:${mod.id}`, 60, 60_000, 'at most 60 writes per minute');
}

// --- messages ------------------------------------------------------------------------------------------------------
// a messages.send with accessory_panel: the panel row is written right after the insert, before the broadcast
const sending = new AsyncLocalStorage();
insertHooks.push(m => {
  const s = sending.getStore();
  if (s?.panel && m.author_id === s.botId) run('INSERT OR REPLACE INTO module_message_panels (message_id, module_id, panel_id) VALUES (?, ?, ?)', m.id, s.moduleId, s.panel);
});

async function send(mod, args) {
  const ch = channelOf(mod, args.channel_id);
  const panel = args.accessory_panel ?? null;
  if (panel !== null && !mod.manifest.ui.panels.some(p => p.id === panel && p.slot === 'message_accessory')) throw E('INVALID', 'accessory_panel must name one of the module\'s message_accessory panels.');
  write(mod, ch.id);
  // a reply or forward answers with the referenced message's content, which only messages.read may see
  const keys = ['content', 'embeds', 'components', 'allowed_mentions', ...(has(mod, 'messages.read') ? ['message_reference'] : [])];
  const body = Object.fromEntries(keys.filter(k => args[k] !== undefined).map(k => [k, args[k]]));
  const out = await sending.run({ botId: mod.app_id, moduleId: mod.id, panel }, () => rest(mod, 'POST', '/channels/:id/messages', { id: ch.id }, { body }));
  delete out.nonce;
  return out;
}

function ownMessage(mod, ch, messageId) {
  const m = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', messageId, ch.id);
  if (!m) throw E('NOT_FOUND', 'Unknown Message', { status: 404, api_code: 10008 });
  if (m.author_id !== mod.app_id || m.webhook_id) throw E('FORBIDDEN', 'Cannot change a message authored by another user', { status: 403, api_code: 50005 });
  return m;
}

// content, embeds and components of its own message (the REST edit only takes content and flags)
function edit(mod, args) {
  const bot = userById(mod.app_id);
  const ch = loadChannel(channelOf(mod, args.channel_id).id, bot);
  const m = ownMessage(mod, ch, id(args, 'message_id'));
  write(mod, ch.id);
  const content = args.content === undefined ? m.content : str(args, 'content', 0, 2000, false);
  const embeds = args.embeds === undefined ? json(m.embeds, []) : richEmbeds(args.embeds, () => null);
  const components = args.components === undefined ? json(m.components, []) : messageComponents(args.components ?? []);
  const files = get('SELECT 1 FROM attachments WHERE message_id = ?', m.id);
  if (!content.trim() && !embeds.length && !components.length && !files) throw new HttpError(400, 50006, 'Cannot send an empty message');
  const automod = content !== m.content ? moderateMessage(ch, bot.id, content) : null;
  if (automod?.blocked) throw automod.reject();
  run('UPDATE messages SET content = ?, embeds = ?, components = ?, edited_timestamp = ? WHERE id = ?',
    content, JSON.stringify(embeds), JSON.stringify(components), new Date().toISOString(), m.id);
  const out = getMessage(m.id);
  broadcastMessage(ch, 'MESSAGE_UPDATE', out);
  automod?.execute(m.id);
  return messageObj(out, ch, bot.id);
}

async function remove(mod, args) {
  const ch = channelOf(mod, args.channel_id);
  ownMessage(mod, ch, id(args, 'message_id'));
  write(mod, ch.id);
  await rest(mod, 'DELETE', '/channels/:id/messages/:mid', { id: ch.id, mid: args.message_id });
  return null;
}

function members(mod, args) {
  const g = guildOf(mod, args.guild_id);
  const limit = args.limit ?? 100;
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw E('INVALID', 'limit must be 1-1000.');
  const after = args.after == null ? 0n : BigInt(id(args, 'after'));
  // shortcut: sorts the whole member list in memory; page in SQL for very large servers
  return membersOf(g).filter(m => BigInt(m.user.id) > after).sort((a, b) => (BigInt(a.user.id) < BigInt(b.user.id) ? -1 : 1)).slice(0, limit);
}

// --- interactions: only the module's own, for 15 minutes ------------------------------------------------------------
function interactionOf(mod, args) {
  const rec = typeof args.interaction_id === 'string' && interactionRecord(args.interaction_id);
  if (!rec || rec.app.id !== mod.app_id || Date.now() - rec.created > 15 * 60 * 1000) throw E('NOT_FOUND', 'Unknown interaction', { status: 404, api_code: 10062 });
  return rec;
}

// --- outgoing HTTP (§4.6) -------------------------------------------------------------------------------------------
const HOP_BY_HOP = new Set(['cookie', 'host', 'connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'content-length', 'user-agent']);
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
export const hostAllowed = (hosts, host) => hosts.some(h => (h.startsWith('*.') ? host.endsWith(h.slice(1)) : host === h));

async function fetchFor(mod, args) {
  limited(`fetch:${mod.id}`, 30, 60_000, 'at most 30 fetches per minute');
  if (typeof args.url !== 'string' || args.url.length > 2048) throw E('INVALID', 'url must be a string of at most 2048 characters.');
  try { new URL(args.url); } catch { throw E('INVALID', 'url is not a URL.'); }
  const method = String(args.method ?? 'GET').toUpperCase();
  if (!METHODS.includes(method)) throw E('INVALID', `method must be one of ${METHODS.join(', ')}.`);
  const given = args.headers ?? {};
  if (typeof given !== 'object' || Array.isArray(given) || Object.keys(given).length > 20) throw E('INVALID', 'headers must be an object with at most 20 entries.');
  const headers = {};
  let size = 0;
  for (const [k, v] of Object.entries(given)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(k) || typeof v !== 'string' || /[\r\n\0]/.test(v)) throw E('INVALID', `header ${k.slice(0, 40)} is not valid.`);
    size += k.length + v.length;
    if (!HOP_BY_HOP.has(k.toLowerCase())) headers[k] = v;
  }
  if (size > 8 * KIB) throw E('INVALID', 'headers are larger than 8 KiB together.');
  if (args.body != null && (typeof args.body !== 'string' || Buffer.byteLength(args.body) > 256 * KIB)) throw E('INVALID', 'body must be a string of at most 256 KiB.');
  if (args.body != null && (method === 'GET' || method === 'HEAD')) throw E('INVALID', `a ${method} request has no body.`);
  // test-only: with CILLCORD_UNFURL_ALLOW set, plain http and other ports may reach the allow-listed local addresses
  const testHatch = ENV_ALLOW.size > 0;
  const onHop = u => {
    if (u.protocol !== 'https:' && !(testHatch && u.protocol === 'http:')) throw new FetchRefused('only https:// URLs');
    if (u.port && u.port !== '443' && !testHatch) throw new FetchRefused('only port 443');
    if (!hostAllowed(mod.manifest.http_hosts, u.hostname)) throw new FetchRefused(`host ${u.hostname} is not an approved host`);
  };
  let res;
  try {
    res = await safeFetch(args.url, { method, headers, body: args.body ?? undefined, maxBytes: 1024 * KIB, truncate: false, timeout: 10_000, maxRedirects: 3, onHop });
  } catch (e) {
    if (e instanceof FetchRefused) throw e.message === 'body too large' ? E('TOO_LARGE', 'The response is larger than 1 MiB.') : E('FETCH_REFUSED', `Fetch refused: ${e.message}.`);
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw E('TIMEOUT', 'The request took longer than 10 s.');
    throw E('UNAVAILABLE', `The request failed (${e?.code ?? 'network error'}).`);
  }
  const out = {};
  for (const [k, v] of Object.entries(res.headers)) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  return { status: res.status, headers: out, body: res.body.toString('utf8') };
}

// --- crypto (§4.8) ---------------------------------------------------------------------------------------------------
const input = (args, k) => {
  if (typeof args[k] !== 'string' || Buffer.byteLength(args[k]) > 1024 * KIB) throw E('INVALID', `${k} must be a string of at most 1 MiB.`);
  return args[k];
};
const encoding = args => {
  const enc = args.encoding ?? 'hex';
  if (enc !== 'hex' && enc !== 'base64') throw E('INVALID', 'encoding must be hex or base64.');
  return enc;
};

// --- the action table ------------------------------------------------------------------------------------------------
const ACTIONS = {
  'guilds.list': [null, mod => all('SELECT g.* FROM guilds g JOIN members m ON m.guild_id = g.id AND m.user_id = ? ORDER BY g.rowid', mod.app_id)
    .filter(g => inScope(mod, g.id)).map(g => ({ id: g.id, name: g.name, icon: g.icon }))],
  'guilds.get': [null, (mod, a) => rest(mod, 'GET', '/guilds/:id', { id: guildOf(mod, a.guild_id) })],
  'channels.list': [null, (mod, a) => rest(mod, 'GET', '/guilds/:id/channels', { id: guildOf(mod, a.guild_id) })],
  'channels.create': [null, (mod, a) => {
    const g = guildOf(mod, a.guild_id);
    write(mod, `guild:${g}`);
    return rest(mod, 'POST', '/guilds/:id/channels', { id: g }, { body: a.data ?? a });
  }],
  'channels.delete': [null, (mod, a) => {
    const ch = channelOf(mod, a.channel_id);
    write(mod, ch.id);
    return rest(mod, 'DELETE', '/channels/:id', { id: ch.id });
  }],
  'roles.list': [null, (mod, a) => rest(mod, 'GET', '/guilds/:id/roles', { id: guildOf(mod, a.guild_id) })],
  'settings.get': [null, (mod, a) => settingsFor(mod, a.guild_id == null ? null : guildOf(mod, a.guild_id))],
  'messages.list': ['messages.read', (mod, a) => {
    const ch = channelOf(mod, a.channel_id);
    const query = {};
    if (a.limit != null) { if (!Number.isInteger(a.limit)) throw E('INVALID', 'limit must be an integer.'); query.limit = String(a.limit); }
    for (const k of ['before', 'after', 'around']) if (a[k] != null) query[k] = id(a, k);
    return rest(mod, 'GET', '/channels/:id/messages', { id: ch.id }, { query });
  }],
  'messages.get': ['messages.read', (mod, a) => rest(mod, 'GET', '/channels/:id/messages/:mid', { id: channelOf(mod, a.channel_id).id, mid: id(a, 'message_id') })],
  'messages.send': ['messages.send', send],
  'messages.edit': ['messages.send', edit],
  'messages.delete': ['messages.send', remove],
  'reactions.add': ['messages.send', async (mod, a) => {
    const ch = channelOf(mod, a.channel_id);
    if (typeof a.emoji !== 'string' || a.emoji.length > 100) throw E('INVALID', 'emoji must be "👍" or "name:id".');
    write(mod, ch.id);
    await rest(mod, 'PUT', '/channels/:id/messages/:mid/reactions/:emoji/@me', { id: ch.id, mid: id(a, 'message_id'), emoji: a.emoji });
    return null;
  }],
  'members.get': ['members.read', (mod, a) => rest(mod, 'GET', '/guilds/:id/members/:user_id', { id: guildOf(mod, a.guild_id), user_id: id(a, 'user_id') })],
  'members.list': ['members.read', members],
  ...Object.fromEntries([['members.add_role', 'PUT'], ['members.remove_role', 'DELETE']].map(([name, method]) => [name, ['roles.manage', async (mod, a) => {
    const g = guildOf(mod, a.guild_id);
    write(mod, `guild:${g}`);
    await rest(mod, method, '/guilds/:id/members/:user_id/roles/:role_id', { id: g, user_id: id(a, 'user_id'), role_id: id(a, 'role_id') });
    return null;
  }]])),
  'voice.list': ['voice.read', (mod, a) => voiceStates(guildOf(mod, a.guild_id))],
  'interactions.respond': ['commands', (mod, a) => { respond(interactionOf(mod, a), a.response, false); return null; }],
  'interactions.followup': ['commands', (mod, a) => {
    const rec = interactionOf(mod, a);
    write(mod, rec.ch.id);
    return followUp(rec, a.message ?? {});
  }],
  'interactions.edit': ['commands', (mod, a) => webhookEdit(interactionOf(mod, a), a.message_id == null ? '@original' : String(a.message_id), a.message ?? {})],
  'storage.get': ['storage', (mod, a) => storageGet(mod.id, a.key)],
  'storage.set': ['storage', (mod, a) => { limited(`storage:${mod.id}`, 120, 60_000, 'at most 120 storage writes per minute'); return storageSet(mod.id, a.key, a.value ?? null); }],
  'storage.delete': ['storage', (mod, a) => { limited(`storage:${mod.id}`, 120, 60_000, 'at most 120 storage writes per minute'); return storageDelete(mod.id, a.key); }],
  'storage.list': ['storage', (mod, a) => storageList(mod.id, { prefix: a.prefix ?? '', after: a.after ?? '', limit: a.limit ?? 100 })],
  'http.fetch': ['http.fetch', fetchFor],
  'schedule.every': ['schedule', (mod, a) => {
    if (!Number.isInteger(a.interval_ms) || a.interval_ms < 60_000 || a.interval_ms > YEAR) throw E('INVALID', 'interval_ms must be an integer from 60000 to one year.');
    setSchedule(mod.id, a.name, Date.now() + a.interval_ms, a.interval_ms);
    rearm();
    return null;
  }],
  'schedule.at': ['schedule', (mod, a) => {
    if (!Number.isSafeInteger(a.at) || a.at < 0 || a.at > Date.now() + YEAR) throw E('INVALID', 'at must be a unix time in ms, at most a year ahead.');
    setSchedule(mod.id, a.name, a.at, null);
    rearm();
    return null;
  }],
  'schedule.cancel': ['schedule', (mod, a) => cancelSchedule(mod.id, a.name)],
  'schedule.list': ['schedule', mod => schedules(mod.id)],
  'ui.publish': ['ui', (mod, a) => {
    const g = guildOf(mod, a.guild_id);
    const text = JSON.stringify(a.data ?? null);
    if (Buffer.byteLength(text) > 16 * KIB) throw E('TOO_LARGE', 'data is larger than 16 KiB.');
    limited(`ui:${mod.id}`, 10, 10_000, 'at most 10 UI events per 10 s');
    sendToUsers(memberIds(g), 'MODULE_UI_EVENT', { module_id: mod.id, guild_id: g, data: a.data ?? null });
    return null;
  }],
  'crypto.hmac': [null, (mod, a) => {
    if (a.algorithm !== 'sha256' && a.algorithm !== 'sha1') throw E('INVALID', 'algorithm must be sha256 or sha1.');
    return createHmac(a.algorithm, input(a, 'key')).update(input(a, 'data')).digest(encoding(a));
  }],
  'crypto.sha256': [null, (mod, a) => createHash('sha256').update(input(a, 'data')).digest(encoding(a))],
  'crypto.random': [null, (mod, a) => {
    if (!Number.isInteger(a.bytes) || a.bytes < 1 || a.bytes > 64) throw E('INVALID', 'bytes must be 1-64.');
    return randomBytes(a.bytes).toString('hex');
  }],
};

const LOGGED = new Set(['PERMISSION_DENIED', 'NOT_ENABLED', 'FETCH_REFUSED', 'QUOTA_EXCEEDED', 'TOO_LARGE']);

// one call of a running module: the result, or a ModuleError; refusals go to the module log at level system
export async function execute(mod, action, args) {
  try {
    // shortcut: a general budget so read floods cannot keep the server busy (the contract only limits writes)
    limited(`calls:${mod.id}`, 300, 10_000, 'at most 300 calls per 10 s');
    const spec = Object.hasOwn(ACTIONS, action) && ACTIONS[action];
    if (!spec) throw E('INVALID', `Unknown action ${String(action).slice(0, 64)}.`);
    if (typeof args !== 'object' || args === null || Array.isArray(args)) throw E('INVALID', 'Arguments must be an object.');
    if (spec[0] && !has(mod, spec[0])) throw E('PERMISSION_DENIED', `${action} needs the ${spec[0]} permission.`);
    return (await spec[1](mod, args)) ?? null;
  } catch (e) {
    let err = e;
    if (e instanceof HttpError) err = fromHttp(e);
    else if (!(e instanceof ModuleError)) {
      console.error(`module ${mod.id}: ${action} failed:`, e);
      err = E('UNAVAILABLE', 'The server could not carry out this call.');
    }
    if (LOGGED.has(err.code) || (err.code === 'RATE_LIMITED' && !hit(`rl-log:${mod.id}:${action}`, 1, 10_000))) refusalLog(mod.id, `Refused ${String(action).slice(0, 64)}: ${err.code} (${err.message})`);
    throw err;
  }
}
