import { randomBytes } from 'node:crypto';
import { snowflake } from '../snowflake.js';
import { get, all, run, json, memberIds, memberRow, memberObj, userById, userObj } from '../db.js';
import { HttpError, str, int, invalid, intParam, idParam, snowflakeField, notFound, missingPermissions } from '../errors.js';
import { P, has, channelPerms, viewersOf } from '../permissions.js';
import { sendToUsers, guildParts } from '../gateway.js';
import { saveImage, removeImage } from '../files.js';
import { addJob, schedule } from '../timers.js';
import { audit, A, diff } from '../audit.js';
import { getChannel } from '../message.js';
import { loadGuild } from './guilds.js';
import { publicUrl } from '../federation.js';

const STAGE = 1, VOICE = 2, EXTERNAL = 3;
const SCHEDULED = 1, ACTIVE = 2, COMPLETED = 3, CANCELED = 4;
const NEXT = { [SCHEDULED]: [ACTIVE, CANCELED], [ACTIVE]: [COMPLETED] };

export function eventObj(e, withCount = true) {
  return {
    id: e.id, guild_id: e.guild_id, channel_id: e.channel_id, creator_id: e.creator_id, name: e.name, description: e.description,
    scheduled_start_time: e.scheduled_start_time, scheduled_end_time: e.scheduled_end_time, privacy_level: e.privacy_level,
    status: e.status, entity_type: e.entity_type, entity_id: null, entity_metadata: json(e.entity_metadata), image: e.image,
    recurrence_rule: null, ...(e.creator_id && { creator: userObj(userById(e.creator_id)) }),
    ...(withCount && { user_count: get('SELECT COUNT(*) AS n FROM scheduled_event_users WHERE event_id = ?', e.id).n }),
  };
}

// channel events are only for those who can see the channel
const audienceOf = e => (e.channel_id && getChannel(e.channel_id) ? viewersOf(getChannel(e.channel_id)) : memberIds(e.guild_id));
const canSee = (e, userId) => audienceOf(e).includes(userId);
const announce = (e, t) => sendToUsers(audienceOf(e), t, eventObj(e));
const visible = (guildId, userId) => all('SELECT * FROM scheduled_events WHERE guild_id = ? AND status IN (1, 2) ORDER BY scheduled_start_time', guildId)
  .filter(e => canSee(e, userId));

guildParts.push((g, userId) => ({ guild_scheduled_events: userId ? visible(g.id, userId).map(e => eventObj(e)) : [] }));

const getEvent = id => get('SELECT * FROM scheduled_events WHERE id = ?', id);
function loadEvent(g, id, userId) {
  const e = get('SELECT * FROM scheduled_events WHERE id = ? AND guild_id = ?', id, g.id);
  if (!e || !canSee(e, userId)) throw notFound(10070, 'Guild Scheduled Event');
  return e;
}

// stage instances drive their event's status; returns true if it changed
export function setEventStatus(id, from, to) {
  if (!run('UPDATE scheduled_events SET status = ? WHERE id = ? AND status = ?', to, id, from).changes) return false;
  announce(getEvent(id), 'GUILD_SCHEDULED_EVENT_UPDATE');
  return true;
}

function time(body, field) {
  const t = Date.parse(body[field]);
  if (typeof body[field] !== 'string' || Number.isNaN(t)) throw invalid(field, 'DATE_TYPE_PARSE', 'Must be an ISO8601 timestamp.');
  return new Date(t).toISOString();
}

// the validated row fields of a create or PATCH body, merged over the current event
function fields(body, g, userId, cur) {
  const f = { ...cur };
  if (body.name !== undefined || !cur) f.name = str(body, 'name', 1, 100);
  if (body.description !== undefined) f.description = body.description === null ? null : str(body, 'description', 0, 1000) || null;
  if (body.privacy_level !== undefined) f.privacy_level = int(body, 'privacy_level', 2, 2);
  if (body.entity_type !== undefined || !cur) f.entity_type = int(body, 'entity_type', 1, 3);
  if (body.scheduled_start_time !== undefined || !cur) f.scheduled_start_time = time(body, 'scheduled_start_time');
  if (body.scheduled_end_time !== undefined) f.scheduled_end_time = body.scheduled_end_time === null ? null : time(body, 'scheduled_end_time');
  if (body.channel_id !== undefined) f.channel_id = body.channel_id === null ? null : snowflakeField(body, 'channel_id');
  if (body.entity_metadata !== undefined) f.entity_metadata = body.entity_metadata === null ? null : JSON.stringify({ location: str(body.entity_metadata, 'location', 1, 100) });
  if (f.entity_type === EXTERNAL) {
    f.channel_id = null;
    if (!f.entity_metadata || !f.scheduled_end_time) throw invalid('entity_metadata', 'BASE_TYPE_REQUIRED', 'External events need a location and an end time.');
  } else {
    f.entity_metadata = null;
    const ch = f.channel_id && getChannel(f.channel_id);
    if (!ch || ch.guild_id !== g.id || ch.type !== (f.entity_type === STAGE ? 13 : 2)) throw invalid('channel_id', 'CHANNEL_INVALID', 'Needs a stage or voice channel of this guild, matching the entity type.');
    if (!has(channelPerms(ch, userId), P.VIEW_CHANNEL | P.CONNECT)) throw missingPermissions();
  }
  if (f.scheduled_end_time && f.scheduled_end_time <= f.scheduled_start_time) throw invalid('scheduled_end_time', 'BASE_TYPE_BAD_VALUE', 'Ends before it starts.');
  return f;
}

const KEYS = ['name', 'description', 'scheduled_start_time', 'scheduled_end_time', 'privacy_level', 'status', 'entity_type', 'channel_id', 'image'];

async function create(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  if (!has(g.perms, P.CREATE_EVENTS) && !has(g.perms, P.MANAGE_EVENTS)) throw missingPermissions();
  const body = ctx.body ?? {};
  const f = fields(body, g, ctx.user.id);
  if (f.scheduled_start_time <= new Date().toISOString()) throw invalid('scheduled_start_time', 'BASE_TYPE_BAD_VALUE', 'Must be in the future.');
  if (get('SELECT COUNT(*) AS n FROM scheduled_events WHERE guild_id = ? AND status IN (1, 2)', g.id).n >= 100) throw new HttpError(400, 30038, 'Maximum number of guild scheduled events reached (100)');
  const id = snowflake();
  const image = body.image == null ? null : await saveImage(body.image, 'image', 'guild-events', id);
  run(`INSERT INTO scheduled_events (id, guild_id, channel_id, creator_id, name, description, scheduled_start_time, scheduled_end_time,
       privacy_level, status, entity_type, entity_metadata, image) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 2, 1, ?, ?, ?)`,
  id, g.id, f.channel_id ?? null, ctx.user.id, f.name, f.description ?? null, f.scheduled_start_time, f.scheduled_end_time ?? null,
  f.entity_type, f.entity_metadata ?? null, image);
  const e = getEvent(id);
  audit(ctx, g.id, A.GUILD_SCHEDULED_EVENT_CREATE, id, { changes: diff({}, e, KEYS) });
  announce(e, 'GUILD_SCHEDULED_EVENT_CREATE');
  schedule();
  return eventObj(e);
}

function canManage(g, e, userId) {
  if (!has(g.perms, P.MANAGE_EVENTS) && !(e.creator_id === userId && has(g.perms, P.CREATE_EVENTS))) throw missingPermissions();
}

async function update(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const e = loadEvent(g, ctx.params.event_id, ctx.user.id);
  canManage(g, e, ctx.user.id);
  if (e.status === COMPLETED || e.status === CANCELED) throw new HttpError(400, 180000, 'Cannot update a finished event');
  const body = ctx.body ?? {};
  const f = fields(body, g, ctx.user.id, e);
  if (body.status !== undefined) {
    f.status = int(body, 'status', 1, 4);
    if (f.status !== e.status && !NEXT[e.status]?.includes(f.status)) throw invalid('status', 'BASE_TYPE_BAD_VALUE', 'Not a valid status transition.');
  }
  if (body.image !== undefined) f.image = await saveImage(body.image, 'image', 'guild-events', e.id);
  run(`UPDATE scheduled_events SET name = ?, description = ?, privacy_level = ?, entity_type = ?, scheduled_start_time = ?, scheduled_end_time = ?,
       channel_id = ?, entity_metadata = ?, status = ?, image = ? WHERE id = ?`, f.name, f.description, f.privacy_level, f.entity_type,
  f.scheduled_start_time, f.scheduled_end_time, f.channel_id, f.entity_metadata, f.status, f.image, e.id);
  if (f.image !== e.image) removeImage('guild-events', e.id, e.image);
  const out = getEvent(e.id);
  audit(ctx, g.id, A.GUILD_SCHEDULED_EVENT_UPDATE, e.id, { changes: diff(e, out, KEYS) });
  announce(out, 'GUILD_SCHEDULED_EVENT_UPDATE');
  schedule();
  return eventObj(out);
}

function remove(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const e = loadEvent(g, ctx.params.event_id, ctx.user.id);
  canManage(g, e, ctx.user.id);
  const audience = audienceOf(e);
  run('DELETE FROM scheduled_events WHERE id = ?', e.id);
  removeImage('guild-events', e.id, e.image);
  audit(ctx, g.id, A.GUILD_SCHEDULED_EVENT_DELETE, e.id, { changes: diff(e, {}, ['name']) });
  sendToUsers(audience, 'GUILD_SCHEDULED_EVENT_DELETE', eventObj(e, false));
}

function users(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const e = loadEvent(g, ctx.params.event_id, ctx.user.id);
  const limit = intParam(ctx.query, 'limit', 100, 1, 100);
  const before = idParam(ctx.query, 'before'), after = idParam(ctx.query, 'after');
  const withMember = ctx.query.get('with_member') === 'true';
  const rows = all(`SELECT user_id FROM scheduled_event_users WHERE event_id = ?
                    AND (? IS NULL OR CAST(user_id AS INTEGER) < CAST(? AS INTEGER)) AND (? IS NULL OR CAST(user_id AS INTEGER) > CAST(? AS INTEGER))
                    ORDER BY CAST(user_id AS INTEGER) LIMIT ?`, e.id, before, before, after, after, limit);
  return rows.map(r => {
    const m = withMember && memberRow(g.id, r.user_id);
    return { guild_scheduled_event_id: e.id, user: userObj(userById(r.user_id)), ...(m && { member: memberObj(m) }) };
  });
}

function subscribe(ctx, on) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const e = loadEvent(g, ctx.params.event_id, ctx.user.id);
  const changed = on
    ? run('INSERT OR IGNORE INTO scheduled_event_users (event_id, user_id) VALUES (?, ?)', e.id, ctx.user.id).changes
    : run('DELETE FROM scheduled_event_users WHERE event_id = ? AND user_id = ?', e.id, ctx.user.id).changes;
  if (changed) {
    sendToUsers(audienceOf(e), on ? 'GUILD_SCHEDULED_EVENT_USER_ADD' : 'GUILD_SCHEDULED_EVENT_USER_REMOVE',
      { guild_scheduled_event_id: e.id, user_id: ctx.user.id, guild_id: g.id });
  }
  if (on) return { guild_scheduled_event_id: e.id, user_id: ctx.user.id, user: userObj(ctx.user), member: memberObj(memberRow(g.id, ctx.user.id)) };
}

// external events start and end on their own schedule (docs); stage and voice events are started and ended by hand
const DUE = `entity_type = ${EXTERNAL} AND ((status = ${SCHEDULED} AND scheduled_start_time <= ?) OR (status = ${ACTIVE} AND scheduled_end_time <= ?))`;
addJob({
  name: 'external event status',
  next() {
    const r = get(`SELECT MIN(CASE WHEN status = ${SCHEDULED} THEN scheduled_start_time ELSE scheduled_end_time END) AS t
                   FROM scheduled_events WHERE entity_type = ${EXTERNAL} AND status IN (1, 2)`);
    return r.t ? Date.parse(r.t) : null;
  },
  run(now) {
    const iso = new Date(now).toISOString();
    for (const e of all(`SELECT * FROM scheduled_events WHERE ${DUE}`, iso, iso)) {
      setEventStatus(e.id, e.status, e.status === SCHEDULED ? ACTIVE : COMPLETED);
    }
  },
});

function ensureCalendarToken(userId) {
  let u = userById(userId);
  if (!u.calendar_token) {
    const token = randomBytes(24).toString('hex');
    run('UPDATE users SET calendar_token = ? WHERE id = ?', token, userId);
    u = userById(userId);
  }
  return u.calendar_token;
}

// links from the instance's configured address (the request's Host only when none is set), never X-Forwarded-Proto
function feedInfo(ctx, token) {
  const base = publicUrl(ctx.req);
  const url = `${base}/api/v9/calendar/feed/${token}.ics`;
  return { token, url, webcal_url: url.replace(/^https?:/, 'webcal:') };
}

function getCalendarFeedInfo(ctx) {
  return feedInfo(ctx, ensureCalendarToken(ctx.user.id));
}

function resetCalendarFeed(ctx) {
  const token = randomBytes(24).toString('hex');
  run('UPDATE users SET calendar_token = ? WHERE id = ?', token, ctx.user.id);
  return feedInfo(ctx, token);
}

function toIcsDate(iso) {
  if (!iso) return '';
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function renderIcsFeed(ctx) {
  const token = ctx.params.token;
  const user = get('SELECT * FROM users WHERE calendar_token = ? AND disabled = 0 AND deleted = 0', token);
  if (!user) throw notFound(10013, 'Calendar feed not found.');

  const guilds = all('SELECT guild_id FROM members WHERE user_id = ?', user.id).map(r => r.guild_id);
  const events = guilds.length
    ? all(`SELECT * FROM scheduled_events WHERE guild_id IN (${guilds.map(() => '?').join(',')}) AND status IN (1, 2) ORDER BY scheduled_start_time`, ...guilds)
      .filter(e => canSee(e, user.id)) // like the event list: channel events only for those who can see the channel
    : [];

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Cillhub//Event Calendar Feed//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:Cillhub Events (${user.username})`,
  ];

  for (const e of events) {
    lines.push(
      'BEGIN:VEVENT',
      `UID:${e.id}@cillhub`,
      `DTSTAMP:${toIcsDate(new Date().toISOString())}`,
      `DTSTART:${toIcsDate(e.scheduled_start_time)}`,
      ...(e.scheduled_end_time ? [`DTEND:${toIcsDate(e.scheduled_end_time)}`] : []),
      `SUMMARY:${(e.name || 'Event').replace(/[\r\n]+/g, ' ')}`,
      ...(e.description ? [`DESCRIPTION:${e.description.replace(/[\r\n]+/g, '\\n')}`] : []),
      'STATUS:CONFIRMED',
      'END:VEVENT'
    );
  }

  lines.push('END:VCALENDAR', '');
  ctx.type = 'text/calendar; charset=utf-8';
  return lines.join('\r\n');
}

const base = '/guilds/:id/scheduled-events';
export default [
  ['GET', '/users/@me/calendar-feed', getCalendarFeedInfo, { userOnly: true }],
  ['POST', '/users/@me/calendar-feed/reset', resetCalendarFeed, { userOnly: true }],
  ['GET', '/calendar/feed/:token.ics', renderIcsFeed, { open: true }],
  ['GET', base, ({ params, query, user }) => {
    const g = loadGuild(params.id, user);
    return visible(g.id, user.id).map(e => eventObj(e, query.get('with_user_count') === 'true'));
  }],
  ['POST', base, create, { maxBody: 12 * 1024 * 1024 }],
  ['GET', `${base}/:event_id`, ({ params, query, user }) => eventObj(loadEvent(loadGuild(params.id, user), params.event_id, user.id), query.get('with_user_count') === 'true')],
  ['PATCH', `${base}/:event_id`, update, { maxBody: 12 * 1024 * 1024 }],
  ['DELETE', `${base}/:event_id`, remove],
  ['GET', `${base}/:event_id/users`, users],
  ['PUT', `${base}/:event_id/users/@me`, ctx => subscribe(ctx, true)],
  ['DELETE', `${base}/:event_id/users/@me`, ctx => subscribe(ctx, false)],
];
