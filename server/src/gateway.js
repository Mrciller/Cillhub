import { WebSocketServer, WebSocket } from 'ws';
import { randomBytes } from 'node:crypto';
import { userByToken, tokenHash, sessionIdHash } from './auth.js';
import {
  get, all, run, json, audienceOf, guildsOf, dmsOf, userById, userObj, guildObj, channelObj, isMember, membersOf, memberIds,
} from './db.js';
import { voiceStates, voiceStateUpdate, sessionClosed } from './voice.js';
import { relationshipsOf } from './routes/relationships.js';
import { I, ALL_INTENTS, PRIVILEGED, privilegedAllowed, wants, redact } from './intents.js';
import { settingsOf, customStatusActivity, guildSettingsReady, notesOf } from './userdata.js';
import { callsOf, callConnect } from './calls.js';
import { signal as cillvoiceSignal, endpoint as cillvoiceEndpoint } from './media/index.js';
import { publicInstance } from './instance.js';

const HEARTBEAT = 41250;
const RESUME_WINDOW = 2 * 60 * 1000; // dispatches kept for RESUME, and how long a dropped session waits for it
const STATUSES = ['online', 'idle', 'dnd', 'invisible'];
const sessions = new Map(); // user id -> Set of sessions, live or waiting to be resumed
const byId = new Map(); // session id -> session

const isLive = s => s.ws?.readyState === WebSocket.OPEN;
const liveOf = id => [...(sessions.get(id) ?? [])].filter(isLive);
const raw = (ws, op, d) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ op, d, s: null, t: null }));

// every dispatch is numbered and kept for RESUME_WINDOW, whether or not the socket is up right now
function send(s, op, d, t = null) {
  if (op !== 0) return isLive(s) && s.ws.send(JSON.stringify({ op, d, s: null, t }));
  const frame = JSON.stringify({ op, d, s: ++s.seq, t });
  const now = Date.now();
  s.buffer.push({ seq: s.seq, at: now, frame });
  while (s.buffer.length && now - s.buffer[0].at > RESUME_WINDOW) s.buffer.shift();
  if (isLive(s)) s.ws.send(frame);
}

// bots only get what their intents ask for, and message content only under MESSAGE_CONTENT's rules
function deliver(s, t, d) {
  if (s.bot) {
    if (!wants(s.intents, t, d, s.user.id)) return;
    if ((t === 'MESSAGE_CREATE' || t === 'MESSAGE_UPDATE') && !(s.intents & I.MESSAGE_CONTENT)) d = redact(d, s.user.id);
  }
  send(s, 0, d, t);
}

export const sendToSession = (s, t, d) => send(s, 0, d, t);
// every user session (v6 instance announcements and settings); bots are left out
export function sendToAllUsers(t, d) {
  for (const set of sessions.values()) for (const s of set) if (!s.bot) send(s, 0, d, t);
}
export const sessionById = id => byId.get(id);
export const sessionsOf = id => [...(sessions.get(id) ?? [])];

// v8 modules: bot user id -> sink(t, d) that takes the events a module may receive (src/modules/registry.js)
export const moduleSinks = new Map();

// d may be a function of the recipient's user id, for payloads that differ per user
export function sendToUsers(userIds, t, d) {
  for (const id of new Set(userIds)) {
    const own = sessions.get(id);
    if (own) for (const s of own) deliver(s, t, typeof d === 'function' ? d(id) : d);
    moduleSinks.get(id)?.(t, typeof d === 'function' ? d(id) : d);
  }
}

// --- presence -------------------------------------------------------------------------------------------------
const savedStatus = id => get('SELECT status FROM users WHERE id = ?', id)?.status ?? 'online';
export const isOnline = id => liveOf(id).length > 0;
// a user counts as active (no push) while a user session is up and has not reported afk (op 3 afk: true)
export const isActive = id => liveOf(id).some(s => !s.bot && !s.afk);

export const inProcessBots = new Set(); // bots that run inside the server (v5 Cillhub Bot): online without a gateway session

export function statusOf(id) {
  const live = liveOf(id);
  if (!live.length) return inProcessBots.has(id) ? 'online' : 'offline';
  const st = live[0].bot ? (live.findLast(s => s.status)?.status ?? 'online') : savedStatus(id);
  if (st === 'invisible') return 'offline';
  // online but every session is away (2 min without input, or the phone app in the background): shown as idle
  return st === 'online' && !live[0].bot && live.every(s => s.afk) ? 'idle' : st;
}

// the latest session's activities, with the persisted custom status (if any) as the type 4 activity
function activitiesOf(id) {
  const status = statusOf(id);
  if (status === 'offline') return [];
  const latest = liveOf(id).filter(s => s.activities).sort((a, b) => a.activitiesAt - b.activitiesAt).pop();
  let acts = latest?.activities ?? [];
  const custom = customStatusActivity(id);
  if (custom) acts = [...acts.filter(a => a.type !== 4), custom];
  return acts;
}

export function presenceObj(id, guildId) {
  const status = statusOf(id);
  return {
    user: { id }, status, activities: activitiesOf(id), client_status: status === 'offline' ? {} : { web: status },
    ...(guildId && { guild_id: guildId }),
  };
}
export const presences = ids => ids.filter(id => statusOf(id) !== 'offline').map(id => presenceObj(id));

const lastPresence = new Map();
const sharedGuilds = (a, b) => all('SELECT x.guild_id FROM members x JOIN members y ON y.guild_id = x.guild_id WHERE x.user_id = ? AND y.user_id = ?', a, b).map(r => r.guild_id);

// sends PRESENCE_UPDATE when status or activities changed; bots get one per shared guild (they need guild_id)
export function refreshPresence(id) {
  const p = presenceObj(id);
  const key = JSON.stringify([p.status, p.activities]);
  if (lastPresence.get(id) === key) return;
  lastPresence.set(id, key);
  for (const uid of audienceOf(id)) {
    for (const s of sessions.get(uid) ?? []) {
      if (!s.bot) send(s, 0, p, 'PRESENCE_UPDATE');
      else if (s.intents & I.GUILD_PRESENCES) for (const g of sharedGuilds(id, uid)) send(s, 0, { ...p, guild_id: g }, 'PRESENCE_UPDATE');
    }
  }
}

// --- sessions ---------------------------------------------------------------------------------------------------
function drop(s) {
  clearTimeout(s.expire);
  byId.delete(s.id);
  const set = sessions.get(s.user.id);
  set?.delete(s);
  if (set && !set.size) sessions.delete(s.user.id);
}

// logout, password change, session logout, account deletion: those sessions end and cannot be resumed
export function closeTokenSessions(hash) {
  for (const set of [...sessions.values()]) {
    for (const s of [...set]) {
      if (s.tokenHash !== hash) continue;
      drop(s);
      if (s.ws) s.ws.close(4004, 'Authentication failed');
      refreshPresence(s.user.id);
    }
  }
}

// per-user guild parts registered by the feature modules (threads, stage instances, events, soundboard)
export const guildParts = [];
export const guildFull = (g, userId) => Object.assign({ ...guildObj(g, true), voice_states: voiceStates(g.id) }, ...guildParts.map(f => f(g, userId)));

// a bot's GUILD_CREATE: without GUILD_PRESENCES only itself and members in voice (docs)
export function botGuildCreate(g, s) {
  const full = guildFull(g, s.user.id);
  const inVoice = new Set(full.voice_states.map(v => v.user_id));
  const withPresences = s.intents & I.GUILD_PRESENCES;
  const members = membersOf(g.id).filter(m => withPresences || m.user.id === s.user.id || inVoice.has(m.user.id));
  const joined = get('SELECT joined_at FROM members WHERE guild_id = ? AND user_id = ?', g.id, s.user.id)?.joined_at;
  return {
    ...full, unavailable: false, large: false, joined_at: joined, members,
    presences: withPresences ? memberIds(g.id).filter(id => statusOf(id) !== 'offline').map(id => presenceObj(id)) : [],
  };
}

function recipientReadStates(userId) {
  const rows = all(`
    SELECT d.channel_id, d.user_id, r.last_message_id, u.settings
    FROM dm_recipients my_dm
    JOIN dm_recipients d ON d.channel_id = my_dm.channel_id AND d.user_id != my_dm.user_id
    JOIN users u ON u.id = d.user_id
    JOIN read_states r ON r.channel_id = d.channel_id AND r.user_id = d.user_id
    WHERE my_dm.user_id = ? AND r.last_message_id IS NOT NULL
  `, userId);
  return rows.filter(r => {
    const s = json(r.settings, {});
    return s.privacy?.dm_read_receipts !== false;
  }).map(r => ({
    channel_id: r.channel_id,
    user_id: r.user_id,
    last_message_id: r.last_message_id,
  }));
}

function ready(s) {
  const { user } = s;
  if (s.bot) {
    const app = get('SELECT id, flags FROM applications WHERE id = ?', user.id);
    return {
      v: s.v, user: userObj(user, true), guilds: guildsOf(user.id).map(g => ({ id: g.id, unavailable: true })), session_id: s.id,
      resume_gateway_url: s.url, ...(s.shard && { shard: s.shard }), application: { id: app.id, flags: app.flags }, private_channels: [],
    };
  }
  const ids = audienceOf(user.id);
  return {
    v: s.v, session_id: s.id, resume_gateway_url: s.url, auth_session_id_hash: sessionIdHash(s.tokenHash), user: userObj(user, true),
    guilds: guildsOf(user.id).map(g => guildFull(g, user.id)),
    private_channels: dmsOf(user.id).map(c => channelObj(c, user.id)),
    users: ids.map(id => userObj(userById(id))),
    presences: presences(ids),
    read_state: all('SELECT channel_id AS id, last_message_id, mention_count FROM read_states WHERE user_id = ?', user.id),
    recipient_read_states: recipientReadStates(user.id),
    relationships: relationshipsOf(user.id),
    user_settings: settingsOf(user.id),
    user_guild_settings: guildSettingsReady(user.id),
    notes: notesOf(user.id),
    instance: publicInstance(),
  };
}

const ACTIVITY_TYPES = [0, 1, 2, 3, 4, 5];
const text = (v, max) => (typeof v === 'string' ? v.slice(0, max) : undefined);
// op 3 / IDENTIFY activities, reduced to the fields a client renders
function cleanActivities(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 5).filter(a => ACTIVITY_TYPES.includes(a?.type)).map(a => {
    const out = { type: a.type, name: text(a.name, 128) ?? (a.type === 4 ? 'Custom Status' : 'Game') };
    for (const k of ['state', 'details']) if (text(a[k], 128) !== undefined) out[k] = text(a[k], 128);
    if (a.type === 1 && typeof a.url === 'string' && /^https:\/\/(www\.)?(twitch\.tv|youtube\.com)\//.test(a.url)) out.url = a.url.slice(0, 512);
    if (a.timestamps && typeof a.timestamps === 'object') {
      const t = Object.fromEntries(['start', 'end'].filter(k => Number.isSafeInteger(a.timestamps[k]) && a.timestamps[k] > 0).map(k => [k, a.timestamps[k]]));
      if (Object.keys(t).length) out.timestamps = t;
    }
    if (a.emoji && typeof a.emoji === 'object') out.emoji = { name: text(a.emoji.name, 32) ?? null, ...(a.emoji.id && /^\d{1,19}$/.test(String(a.emoji.id)) && { id: String(a.emoji.id) }) };
    out.created_at = Date.now();
    return out;
  });
}

function applyPresence(s, d) {
  if (Array.isArray(d?.activities)) { s.activities = cleanActivities(d.activities); s.activitiesAt = Date.now(); }
  if (typeof d?.afk === 'boolean') s.afk = d.afk;
  if (!STATUSES.includes(d?.status)) return;
  if (s.bot) s.status = d.status;
  else run('UPDATE users SET status = ? WHERE id = ?', d.status, s.user.id);
}

// IDENTIFY: bots must send valid intents (4013) and may only use privileged ones their application enables (4014)
function identify(conn, d) {
  if (conn.session) return conn.ws.close(4005, 'Already authenticated');
  const user = typeof d?.token === 'string' ? userByToken(d.token.replace(/^Bot\s+/i, '')) : undefined;
  if (!user) return conn.ws.close(4004, 'Authentication failed');
  const s = {
    id: randomBytes(16).toString('hex'), user, bot: !!user.bot, tokenHash: tokenHash(d.token.replace(/^Bot\s+/i, '')), url: conn.url,
    v: conn.v, seq: 0, buffer: [], ws: conn.ws, afk: false, status: null, activities: null, activitiesAt: 0, intents: ALL_INTENTS,
  };
  if (s.bot) {
    if (!Number.isInteger(d.intents) || d.intents < 0 || (d.intents & ~ALL_INTENTS)) return conn.ws.close(4013, 'Invalid intent(s)');
    const flags = get('SELECT flags FROM applications WHERE id = ?', user.id)?.flags ?? 0;
    if (d.intents & PRIVILEGED & ~privilegedAllowed(flags)) return conn.ws.close(4014, 'Disallowed intent(s)');
    if (d.shard !== undefined && !(Array.isArray(d.shard) && d.shard[0] === 0 && d.shard[1] === 1)) return conn.ws.close(4010, 'Invalid shard');
    s.intents = d.intents;
    s.shard = d.shard;
    if (d.presence) applyPresence(s, d.presence);
  } else {
    const p = d.properties ?? {};
    run('UPDATE tokens SET os = ?, platform = ? WHERE token_hash = ?', text(p.os, 64) ?? null, text(p.browser, 64) ?? null, s.tokenHash);
  }
  conn.session = s;
  byId.set(s.id, s);
  if (!sessions.has(user.id)) sessions.set(user.id, new Set());
  sessions.get(user.id).add(s);
  send(s, 0, ready(s), 'READY');
  if (s.bot) for (const g of guildsOf(user.id)) deliver(s, 'GUILD_CREATE', botGuildCreate(g, s));
  else for (const call of callsOf(user.id)) send(s, 0, call, 'CALL_CREATE');
  refreshPresence(user.id);
}

// RESUME: same token and session, replay what the client missed, then RESUMED; anything else is op 9 (not resumable)
function resume(conn, d) {
  if (conn.session) return conn.ws.close(4005, 'Already authenticated');
  const s = typeof d?.session_id === 'string' && byId.get(d.session_id);
  const ok = s && typeof d.token === 'string' && tokenHash(d.token.replace(/^Bot\s+/i, '')) === s.tokenHash && userByToken(d.token.replace(/^Bot\s+/i, ''))
    && Number.isInteger(d.seq) && d.seq <= s.seq && (s.seq === d.seq || s.buffer[0]?.seq <= d.seq + 1);
  if (!ok) return raw(conn.ws, 9, false);
  if (isLive(s) && s.ws !== conn.ws) s.ws.close(4009, 'Session resumed elsewhere');
  clearTimeout(s.expire);
  s.ws = conn.ws;
  conn.session = s;
  for (const b of s.buffer) if (b.seq > d.seq) conn.ws.send(b.frame);
  send(s, 0, {}, 'RESUMED');
  refreshPresence(s.user.id);
}

// op 8: members of one guild by prefix or ids; the whole list needs GUILD_MEMBERS for bots (else 4013, per the docs)
function requestMembers(s, d) {
  const guildId = String(Array.isArray(d?.guild_id) ? d.guild_id[0] : d?.guild_id ?? '');
  if (!isMember(guildId, s.user.id)) return;
  let list = membersOf(guildId);
  let notFound;
  if (d.user_ids != null) {
    const ids = [].concat(d.user_ids).map(String).slice(0, 100);
    list = list.filter(m => ids.includes(m.user.id));
    notFound = ids.filter(id => !list.some(m => m.user.id === id));
  } else {
    const query = String(d.query ?? '').toLowerCase();
    const limit = Number.isInteger(d.limit) && d.limit > 0 ? d.limit : 0;
    if (!query && s.bot && !(s.intents & I.GUILD_MEMBERS)) return s.ws.close(4013, 'Invalid intent(s)');
    if (query) list = list.filter(m => m.user.username.toLowerCase().startsWith(query) || m.nick?.toLowerCase().startsWith(query) || m.user.global_name?.toLowerCase().startsWith(query));
    list = list.slice(0, query ? Math.min(limit || 100, 100) : limit || list.length);
  }
  const withPresences = d.presences === true && (!s.bot || s.intents & I.GUILD_PRESENCES);
  const nonce = typeof d.nonce === 'string' && d.nonce.length <= 32 ? d.nonce : undefined;
  const count = Math.max(1, Math.ceil(list.length / 1000));
  for (let i = 0; i < count; i++) {
    const members = list.slice(i * 1000, (i + 1) * 1000);
    send(s, 0, {
      guild_id: guildId, members, chunk_index: i, chunk_count: count,
      ...(notFound?.length && i === 0 && { not_found: notFound }),
      ...(withPresences && { presences: members.map(m => m.user.id).filter(id => statusOf(id) !== 'offline').map(id => presenceObj(id)) }),
      ...(nonce && { nonce }),
    }, 'GUILD_MEMBERS_CHUNK');
  }
}

const SEND_LIMIT = 120; // gateway commands per connection per minute (docs); more closes with 4008

export function attachGateway(server) {
  // the documented 4096-byte frame limit; cillvoice SDP offers (op 50) are 10-30 KB, so a configured cillvoice allows 64 KiB
  const wss = new WebSocketServer({ server, path: '/gateway', maxPayload: cillvoiceEndpoint ? 65536 : 4096 });
  wss.on('connection', (ws, req) => {
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
    const v = Number(new URL(req.url, 'http://x').searchParams.get('v')) || 9;
    const conn = { ws, session: null, v, url: `${secure ? 'wss' : 'ws'}://${req.headers.host}/gateway`, sent: [] };
    const timeout = () => ws.close(4009, 'Session timed out');
    const identifyTimer = setTimeout(() => conn.session || timeout(), 30_000);
    let beatTimer = setTimeout(timeout, 2 * HEARTBEAT);
    raw(ws, 10, { heartbeat_interval: HEARTBEAT });

    ws.on('error', () => {}); // ws closes the socket itself; without a listener the error would crash the process
    ws.on('message', data => {
      const now = Date.now();
      conn.sent = conn.sent.filter(t => now - t < 60_000);
      if (conn.sent.push(now) > SEND_LIMIT) return ws.close(4008, 'Rate limited');
      let msg;
      try { msg = JSON.parse(data); } catch { return ws.close(4002, 'Decode error'); }
      const s = conn.session;
      switch (msg?.op) {
        case 1: case 40: // 40 = QOS_HEARTBEAT, what the reference client sends
          clearTimeout(beatTimer);
          beatTimer = setTimeout(timeout, 2 * HEARTBEAT);
          return raw(ws, 11, null);
        case 2: return identify(conn, msg.d);
        case 6: return resume(conn, msg.d);
        case 3:
          if (!s) return ws.close(4003, 'Not authenticated');
          applyPresence(s, msg.d);
          return refreshPresence(s.user.id);
        case 4:
          if (!s) return ws.close(4003, 'Not authenticated');
          return voiceStateUpdate(s, msg.d);
        case 8:
          if (!s) return ws.close(4003, 'Not authenticated');
          return requestMembers(s, msg.d ?? {});
        case 13:
          if (!s) return ws.close(4003, 'Not authenticated');
          return callConnect(s, msg.d);
        case 50: // CILLVOICE_SIGNAL (cillvoice SDP offer), see README; unknown unless cillvoice is configured
          if (!cillvoiceEndpoint) return ws.close(4001, 'Unknown opcode');
          if (!s) return ws.close(4003, 'Not authenticated');
          return cillvoiceSignal(s, msg.d);
        default: return ws.close(4001, 'Unknown opcode');
      }
    });
    ws.on('close', () => {
      clearTimeout(identifyTimer);
      clearTimeout(beatTimer);
      const s = conn.session;
      if (!s || s.ws !== ws) return; // never identified, or already resumed on another socket
      s.ws = null;
      sessionClosed(s);
      if (byId.has(s.id)) s.expire = setTimeout(() => drop(s), RESUME_WINDOW);
      refreshPresence(s.user.id);
    });
  });
}
