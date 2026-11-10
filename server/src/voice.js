import { get, run, isMember, memberIds, memberRow, memberObj, userById, channelUserIds } from './db.js';
import { P, has, channelPerms, viewersOf } from './permissions.js';
import * as livekit from './livekit.js';
import * as cillvoice from './media/index.js';
import { sendToUsers, sendToSession } from './gateway.js';
import { limit } from './ratelimit.js';
import { setting } from './instance.js';
import { settingsOf } from './userdata.js';
import { blockedEither } from './routes/relationships.js';

// both backends export the same four names (endpoint, joinToken, removeParticipant, updateParticipant). New calls start on
// the admin's choice (instance setting voice_backend, if that backend is configured), else on VOICE_BACKEND; a channel
// that already has people in it keeps the backend they are on, so everyone in one call shares one backend.
export const BACKENDS = { livekit, cillvoice };
export const configuredBackends = () => Object.keys(BACKENDS).filter(k => BACKENDS[k].endpoint);
export function defaultBackend() {
  const chosen = setting('voice_backend');
  if (BACKENDS[chosen]?.endpoint) return chosen;
  return process.env.VOICE_BACKEND === 'cillvoice' ? 'cillvoice' : 'livekit';
}
const be = v => BACKENDS[v.backend];
// a running call keeps its backend; otherwise the server's choice (if that backend is configured here), else the instance default
const guildBackend = ch => { const b = ch.guild_id && get('SELECT voice_backend FROM guilds WHERE id = ?', ch.guild_id)?.voice_backend; return BACKENDS[b]?.endpoint ? b : null; };
const backendFor = (ch, userId) => [...states.values()].find(x => x.channel_id === ch.id && x.user_id !== userId)?.backend ?? guildBackend(ch) ?? defaultBackend();

// user id -> { guild_id, channel_id, user_id, session, self_mute, self_deaf, self_video, self_stream, suppress, request_to_speak_timestamp, sources }
const states = new Map();
// called with the old state whenever someone leaves a channel (the stage instance closes with its last listener)
export const leaveHooks = [];
// every leave (own leave and moves too) drops the backend participant: a client that only says it left must not stay in the room
leaveHooks.push(v => be(v).removeParticipant(v.channel_id, v.user_id));
// voice minutes for the admin overview, counted on the day the state ends
leaveHooks.push(v => {
  const seconds = Math.round((Date.now() - (v.joined_at ?? Date.now())) / 1000);
  if (seconds > 0) run('INSERT INTO voice_usage (day, seconds) VALUES (?, ?) ON CONFLICT DO UPDATE SET seconds = seconds + excluded.seconds', new Date().toISOString().slice(0, 10), seconds);
});
export const voiceStateCount = () => states.size;

function stateObj(v, channel_id = v.channel_id) {
  const m = memberRow(v.guild_id, v.user_id);
  return {
    guild_id: v.guild_id, channel_id, user_id: v.user_id, session_id: v.session.id,
    self_mute: v.self_mute, self_deaf: v.self_deaf, self_video: v.self_video, self_stream: v.self_stream,
    mute: !!m?.mute, deaf: !!m?.deaf, suppress: !!v.suppress, request_to_speak_timestamp: v.request_to_speak_timestamp ?? null,
    member: m && memberObj(m),
  };
}

export const voiceStates = guildId => [...states.values()].filter(v => v.guild_id === guildId).map(v => stateObj(v));
export const inVoice = (guildId, userId) => states.get(userId)?.guild_id === guildId;
export const voiceState = (guildId, userId) => (inVoice(guildId, userId) ? states.get(userId) : null);
export const voiceStateObj = v => stateObj(v);
export const statesIn = channelId => [...states.values()].filter(v => v.channel_id === channelId);

const channelOf = v => get('SELECT * FROM channels WHERE id = ?', v.channel_id);

// on a stage only speakers (suppress false) get any publishing grant
const ALL_SOURCES = ['microphone', 'camera', 'screen_share', 'screen_share_audio'];
function sources(v) {
  v.deaf = false;
  if (!v.guild_id) return ALL_SOURCES; // DM and group calls: every participant may talk and share
  const m = memberRow(v.guild_id, v.user_id);
  v.deaf = !!m.deaf; // server deafen: the backend stops delivering audio to them (livekit.js, media/sfu.js)
  if (v.suppress) return [];
  const perms = channelPerms(channelOf(v), v.user_id);
  return [
    ...(has(perms, P.SPEAK) && !m.mute && !m.deaf ? ['microphone'] : []),
    ...(has(perms, P.STREAM) ? ['camera', 'screen_share', 'screen_share_audio'] : []),
  ];
}

function clampStream(v) {
  if (v.sources.includes('camera')) return false;
  const had = v.self_video || v.self_stream;
  v.self_video = false;
  v.self_stream = false;
  return had;
}

// LiveKit behind the bundled Caddy (wss://<CILLCORD_PUBLIC_URL host>/livekit) answers on every name of this instance,
// so it follows a domain the admin set in the settings
const envHost = (() => { try { return new URL(process.env.CILLCORD_PUBLIC_URL).host; } catch { return null; } })();
const followHost = e => {
  const next = setting('public_url');
  try { return next && envHost && new URL(e).host === envHost ? e.replace(`//${envHost}`, `//${new URL(next).host}`) : e; } catch { return e; }
};
function sendServerUpdate(v) {
  const m = v.guild_id ? memberRow(v.guild_id, v.user_id) : userById(v.user_id);
  const token = be(v).joinToken(v.user_id, m.nick ?? m.global_name ?? m.username, v.channel_id, v.sources, v.session, v.deaf);
  sendToSession(v.session, 'VOICE_SERVER_UPDATE', { guild_id: v.guild_id, channel_id: v.channel_id, token, endpoint: v.backend === 'livekit' ? followHost(be(v).endpoint) : be(v).endpoint });
}

const audience = v => (v.guild_id ? memberIds(v.guild_id) : channelUserIds({ id: v.channel_id }));
// members who cannot view the channel only learn that the user is not in a channel they can see
function broadcast(v, channelId = v.channel_id) {
  const out = stateObj(v, channelId);
  const ch = v.guild_id && channelId && channelOf(v);
  if (!ch) return sendToUsers(audience(v), 'VOICE_STATE_UPDATE', out);
  const viewers = new Set(viewersOf(ch));
  sendToUsers([...viewers], 'VOICE_STATE_UPDATE', out);
  sendToUsers(audience(v).filter(id => !viewers.has(id)), 'VOICE_STATE_UPDATE', { ...out, channel_id: null });
}
// called with the new state whenever someone enters a channel (DM calls start and update from here)
export const joinHooks = [];

function leave(userId) {
  const v = states.get(userId);
  if (!v) return;
  states.delete(userId);
  broadcast(v, null);
  leaveHooks.forEach(h => h(v));
}

// gateway op 4
export function voiceStateUpdate(session, d) {
  const userId = session.user.id;
  const cur = states.get(userId);
  if (d?.channel_id == null) return leave(userId);
  if (d.guild_id == null) return privateCall(session, d, cur);
  const ch = get('SELECT * FROM channels WHERE id = ? AND guild_id = ? AND type IN (2, 13)', String(d.channel_id), String(d.guild_id));
  if (!ch) return;
  const perms = channelPerms(ch, userId);
  if (!has(perms, P.VIEW_CHANNEL | P.CONNECT)) return;
  const flags = { self_mute: !!d.self_mute, self_deaf: !!d.self_deaf, self_video: !!d.self_video, self_stream: !!d.self_stream };
  if (cur?.channel_id === ch.id && cur.session === session) {
    Object.assign(cur, flags);
    cur.sources = sources(cur);
    clampStream(cur);
    return broadcast(cur);
  }
  const backend = cur?.channel_id === ch.id ? cur.backend : backendFor(ch, userId);
  if (!BACKENDS[backend].endpoint) {
    return sendToSession(session, 'VOICE_SERVER_UPDATE', { guild_id: ch.guild_id, channel_id: ch.id, token: null, endpoint: null });
  }
  const others = [...states.values()].filter(v => v.channel_id === ch.id && v.user_id !== userId).length;
  if (ch.user_limit && others >= ch.user_limit && !has(perms, P.MOVE_MEMBERS)) return;
  if (cur?.guild_id !== ch.guild_id) leave(userId);
  // everyone enters a stage as audience; switching sessions in the same channel keeps the speaker state
  const same = cur?.channel_id === ch.id;
  const v = {
    guild_id: ch.guild_id, channel_id: ch.id, user_id: userId, session, ...flags, backend,
    joined_at: cur?.guild_id === ch.guild_id ? cur.joined_at : Date.now(),
    suppress: same ? cur.suppress : ch.type === 13, request_to_speak_timestamp: same ? cur.request_to_speak_timestamp : null,
  };
  v.sources = sources(v);
  clampStream(v);
  states.set(userId, v);
  // the entrance sound goes out just before the join itself, so clients can play it instead of their join chime
  if (!same) entranceSound(v, ch);
  broadcast(v);
  sendServerUpdate(v);
  if (cur?.guild_id === ch.guild_id && cur.channel_id !== ch.id) leaveHooks.forEach(h => h({ ...cur, joined_at: Date.now() }));
}

// v6: the joiner's entrance sound (user setting entrance_sound) for everyone in the channel, as a soundboard effect
function entranceSound(v, ch) {
  const pick = settingsOf(v.user_id).entrance_sound;
  if (!pick || ch.type !== 2 || !get('SELECT entrance_sounds FROM guilds WHERE id = ?', ch.guild_id)?.entrance_sounds) return;
  const perms = channelPerms(ch, v.user_id);
  if (!has(perms, P.USE_SOUNDBOARD)) return;
  let sound;
  if (pick.guild_id) {
    const s = get('SELECT * FROM soundboard_sounds WHERE sound_id = ? AND guild_id = ?', pick.sound_id, pick.guild_id);
    if (!s || !isMember(s.guild_id, v.user_id) || (s.guild_id !== ch.guild_id && !has(perms, P.USE_EXTERNAL_SOUNDS))) return;
    sound = { id: s.sound_id, volume: s.volume, url: `/soundboard-sounds/${s.sound_id}`, emoji: s.emoji_id || s.emoji_name ? { id: s.emoji_id, name: s.emoji_name } : null };
  } else {
    const s = get('SELECT * FROM user_sounds WHERE id = ? AND user_id = ?', pick.sound_id, v.user_id);
    if (!s) return;
    sound = { id: s.id, volume: s.volume, url: `/user-sounds/${s.id}`, emoji: null };
  }
  sendToUsers(statesIn(ch.id).map(x => x.user_id), 'VOICE_CHANNEL_EFFECT_SEND', {
    channel_id: ch.id, guild_id: ch.guild_id, user_id: v.user_id, sound_id: sound.id, sound_volume: sound.volume, emoji: sound.emoji,
    animation_type: null, animation_id: 0, entrance: true, sound_url: sound.url,
  });
}

// op 4 with guild_id null: join the call of a DM or group DM the user is in (room = channel id)
function privateCall(session, d, cur) {
  const userId = session.user.id;
  const ch = get(`SELECT c.* FROM channels c JOIN dm_recipients r ON r.channel_id = c.id AND r.user_id = ?
                  WHERE c.id = ? AND c.type IN (1, 3)`, userId, String(d.channel_id));
  if (!ch) return;
  // a call start posts a call message and rings, so a 1:1 call is refused where a DM message would be
  if (ch.type === 1 && channelUserIds(ch).some(id => id !== userId && (blockedEither(userId, id) || userById(id)?.system))) return;
  const flags = { self_mute: !!d.self_mute, self_deaf: !!d.self_deaf, self_video: !!d.self_video, self_stream: !!d.self_stream };
  if (cur?.channel_id === ch.id && cur.session === session) {
    Object.assign(cur, flags);
    return broadcast(cur);
  }
  const backend = backendFor(ch, userId);
  if (!BACKENDS[backend].endpoint) return sendToSession(session, 'VOICE_SERVER_UPDATE', { guild_id: null, channel_id: ch.id, token: null, endpoint: null });
  const same = cur?.channel_id === ch.id;
  // joining an empty private channel starts a call (a call message for everyone): over the budget the join is ignored
  if (!same && !statesIn(ch.id).length) try { limit('CALL', 'start', {}, userId, {}); } catch { return; }
  if (cur && !same) leave(userId);
  const v = {
    guild_id: null, channel_id: ch.id, user_id: userId, session, ...flags, backend, joined_at: same ? cur.joined_at : Date.now(), suppress: false, request_to_speak_timestamp: null,
  };
  v.sources = sources(v);
  states.set(userId, v);
  broadcast(v);
  sendServerUpdate(v);
  if (!same) joinHooks.forEach(h => h(v, ch));
}

// stage speaker changes: new suppress / request_to_speak_timestamp, broadcast, and the LiveKit grant follows suppress
export function setStageState(v, changes) {
  Object.assign(v, changes);
  const next = sources(v);
  const changed = next.join() !== v.sources.join();
  v.sources = next;
  clampStream(v);
  broadcast(v);
  if (changed) be(v).updateParticipant(v.channel_id, v.user_id, next, v.deaf);
}

export function sessionClosed(session) {
  if (session.user && states.get(session.user.id)?.session === session) leave(session.user.id);
}

// kick, ban, leaving the guild, PATCH member channel_id: null
export const disconnect = (guildId, userId) => inVoice(guildId, userId) && leave(userId);
export const disconnectFromChannel = (channelId, userId) => states.get(userId)?.channel_id === channelId && leave(userId);
export const disconnectChannel = channelId => [...states.values()].filter(v => v.channel_id === channelId).forEach(v => leave(v.user_id));

export function move(userId, ch) {
  const v = states.get(userId);
  if (v.channel_id === ch.id) return;
  const old = { ...v, joined_at: Date.now() };
  Object.assign(v, { channel_id: ch.id, backend: backendFor(ch, userId), suppress: ch.type === 13, request_to_speak_timestamp: null });
  v.sources = sources(v);
  clampStream(v);
  broadcast(v);
  sendServerUpdate(v);
  leaveHooks.forEach(h => h(old));
}

// after anything that changes permissions or server mute/deaf: drop who lost CONNECT, re-grant LiveKit sources
export function recheck(guildId, changedUserId) {
  for (const v of [...states.values()].filter(s => s.guild_id === guildId)) {
    if (!has(channelPerms(channelOf(v), v.user_id), P.VIEW_CHANNEL | P.CONNECT)) { leave(v.user_id); continue; }
    const wasDeaf = v.deaf;
    const next = sources(v);
    const changed = next.join() !== v.sources.join() || v.deaf !== wasDeaf;
    v.sources = next;
    const clamped = clampStream(v);
    if (v.user_id === changedUserId || clamped) broadcast(v);
    if (changed) be(v).updateParticipant(v.channel_id, v.user_id, next, v.deaf);
  }
}
