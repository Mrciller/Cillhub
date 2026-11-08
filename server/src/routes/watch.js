// Voice channel extras (v5): Watch Together sessions and voice channel status. Both live in memory, per voice channel,
// and end when the last participant leaves.
import { voiceStatuses } from '../db.js';
import { HttpError, str, invalid, notFound, missingPermissions } from '../errors.js';
import { P, has, need, viewersOf, channelPerms } from '../permissions.js';
import { sendToUsers, guildParts } from '../gateway.js';
import { statesIn, leaveHooks } from '../voice.js';
import { unfurl } from '../embeds.js';
import { getChannel } from '../message.js';
import { loadChannel } from './channels.js';

const MAX_QUEUE = 50;
const sessions = new Map(); // channel id -> {channel_id, guild_id, host_id, queue, current, control}
const inChannel = (chId, userId) => statesIn(chId).some(v => v.user_id === userId);

// youtube.com/watch?v=, youtu.be/<id>, youtube.com/shorts/<id>; the id must be YouTube's 11 characters
export function youtubeId(raw) {
  let u;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  let id = null;
  if (['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) {
    if (u.pathname === '/watch') id = u.searchParams.get('v');
    else id = /^\/shorts\/([^/]+)\/?$/.exec(u.pathname)?.[1];
  } else if (host === 'youtu.be') id = /^\/([^/]+)\/?$/.exec(u.pathname)?.[1];
  return /^[\w-]{11}$/.test(id ?? '') ? id : null;
}

// where playback is now, in seconds
const positionOf = c => (c.playing ? c.position + ((Date.now() - c.started_at) / 1000) * c.rate : c.position);

const announce = s => {
  const ch = getChannel(s.channel_id);
  if (ch) sendToUsers(viewersOf(ch), 'WATCH_SESSION_UPDATE', s);
};
function end(chId) {
  const s = sessions.get(chId);
  if (!s) return;
  sessions.delete(chId);
  const ch = getChannel(chId);
  if (ch) sendToUsers(viewersOf(ch), 'WATCH_SESSION_UPDATE', { channel_id: chId, guild_id: s.guild_id, ended: true });
}

guildParts.push((g, userId) => ({
  watch_sessions: userId ? [...sessions.values()].filter(s => {
    const ch = s.guild_id === g.id && getChannel(s.channel_id);
    return ch && has(channelPerms(ch, userId), P.VIEW_CHANNEL);
  }) : [],
}));

// the last one out ends the session and clears the status; a leaving host hands over to whoever joined first
leaveHooks.push(old => {
  const left = statesIn(old.channel_id);
  if (!left.length) {
    end(old.channel_id);
    const ch = getChannel(old.channel_id);
    if (ch && voiceStatuses.has(ch.id)) setStatus(ch, null);
    return;
  }
  const s = sessions.get(old.channel_id);
  if (s && s.host_id === old.user_id) {
    s.host_id = left[0].user_id;
    announce(s);
  }
});

// title through the YouTube oEmbed unfurl (SSRF-guarded), filled in when it arrives
function fetchTitle(s, item) {
  unfurl(`https://www.youtube.com/watch?v=${item.video_id}`).then(e => {
    if (!e?.title || sessions.get(s.channel_id) !== s) return;
    for (const x of [s.current, ...s.queue]) if (x?.video_id === item.video_id && x.title == null) x.title = e.title;
    announce(s);
  });
}

function voiceChannel(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  if (ch.type !== 2) throw new HttpError(400, 50024, 'Cannot execute action on this channel type');
  return ch;
}
const loadSession = ch => {
  const s = sessions.get(ch.id);
  if (!s) throw notFound(0, 'Watch Session');
  return s;
};

// POST: start (or, when one is running, enqueue); needs CONNECT + STREAM and being in the channel
function start(ctx) {
  const ch = voiceChannel(ctx);
  need(ch.perms, P.CONNECT | P.STREAM);
  if (!inChannel(ch.id, ctx.user.id)) throw new HttpError(403, 50013, 'You must be connected to this voice channel');
  const video_id = youtubeId(str(ctx.body ?? {}, 'video_url', 1, 2048));
  if (!video_id) throw invalid('video_url', 'URL_TYPE_INVALID_URL', 'Only YouTube video links (youtube.com/watch?v=, youtu.be/, youtube.com/shorts/).');
  const item = { video_id, title: null, added_by: ctx.user.id };
  let s = sessions.get(ch.id);
  if (!s) {
    s = { channel_id: ch.id, guild_id: ch.guild_id, host_id: ctx.user.id, queue: [], current: null, control: 'host' };
    sessions.set(ch.id, s);
  }
  if (!s.current) s.current = { ...item, started_at: Date.now(), position: 0, playing: true, rate: 1 };
  else if (s.queue.length >= MAX_QUEUE) throw new HttpError(400, 0, `The queue is full (${MAX_QUEUE})`);
  else s.queue.push(item);
  announce(s);
  fetchTitle(s, item);
  return s;
}

// PATCH {action: play|pause|seek|next|remove, position?, index?} and/or {control: host|everyone}
function control(ctx) {
  const ch = voiceChannel(ctx);
  const s = loadSession(ch);
  const b = ctx.body ?? {};
  const uid = ctx.user.id;
  const isHost = s.host_id === uid;
  if (b.control !== undefined) {
    if (!['host', 'everyone'].includes(b.control)) throw invalid('control', 'BASE_TYPE_CHOICES', 'Must be host or everyone.');
    if (!isHost && !has(ch.perms, P.MOVE_MEMBERS)) throw missingPermissions();
    s.control = b.control;
  }
  if (b.action !== undefined) {
    if (!isHost && !(s.control === 'everyone' && inChannel(ch.id, uid))) throw missingPermissions();
    const position = () => {
      if (b.position === undefined) return null;
      if (typeof b.position !== 'number' || !Number.isFinite(b.position) || b.position < 0 || b.position > 86400) throw invalid('position', 'NUMBER_TYPE_COERCE', 'Seconds between 0 and 86400.');
      return b.position;
    };
    const c = s.current;
    const now = Date.now();
    switch (b.action) {
      case 'play': case 'pause': case 'seek': {
        if (!c) throw new HttpError(400, 0, 'Nothing is playing');
        const p = position();
        if (b.action === 'seek' && p === null) throw invalid('position', 'BASE_TYPE_REQUIRED', 'Seek needs a position.');
        Object.assign(c, { position: p ?? positionOf(c), started_at: now, ...(b.action !== 'seek' && { playing: b.action === 'play' }) });
        break;
      }
      case 'next': {
        const n = s.queue.shift();
        s.current = n ? { ...n, started_at: now, position: 0, playing: true, rate: 1 } : null;
        break;
      }
      case 'remove': {
        if (!Number.isInteger(b.index) || b.index < 0 || b.index >= s.queue.length) throw invalid('index', 'NUMBER_TYPE_COERCE', 'Not a queue position.');
        s.queue.splice(b.index, 1);
        break;
      }
      default: throw invalid('action', 'BASE_TYPE_CHOICES', 'Must be play, pause, seek, next or remove.');
    }
  }
  announce(s);
  return s;
}

function stop(ctx) {
  const ch = voiceChannel(ctx);
  const s = loadSession(ch);
  if (s.host_id !== ctx.user.id && !has(ch.perms, P.MOVE_MEMBERS)) throw missingPermissions();
  end(ch.id);
}

// --- voice channel status (user docs: PUT /channels/:id/voice-status, VOICE_CHANNEL_STATUS_UPDATE) -------------------
function setStatus(ch, status) {
  if (status) voiceStatuses.set(ch.id, status);
  else voiceStatuses.delete(ch.id);
  sendToUsers(viewersOf(ch), 'VOICE_CHANNEL_STATUS_UPDATE', { id: ch.id, guild_id: ch.guild_id, status: status || null });
}

// MANAGE_CHANNELS, or connected to the channel with SEND_MESSAGES there (contract v5)
function putStatus(ctx) {
  const ch = voiceChannel(ctx);
  const b = ctx.body ?? {};
  const status = b.status == null ? null : str(b, 'status', 0, 500);
  if (!has(ch.perms, P.MANAGE_CHANNELS) && !(inChannel(ch.id, ctx.user.id) && has(ch.perms, P.SEND_MESSAGES))) throw missingPermissions();
  setStatus(ch, status);
}

export default [
  ['GET', '/channels/:id/watch', ctx => loadSession(voiceChannel(ctx))],
  ['POST', '/channels/:id/watch', start],
  ['PATCH', '/channels/:id/watch', control],
  ['DELETE', '/channels/:id/watch', stop],
  ['PUT', '/channels/:id/voice-status', putStatus],
];
