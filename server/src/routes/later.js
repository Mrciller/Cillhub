// v5: scheduled messages ("Send later", Cillhub routes) and saved messages with reminders (user docs: /users/@me/saved-messages)
import { snowflake } from '../snowflake.js';
import { get, all, run, userById, channelUserIds, json } from '../db.js';
import { HttpError, invalid, notFound, missingAccess, str } from '../errors.js';
import { P, has, need, channelPerms, isThread, MESSAGEABLE } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { prepare, send, checkVerification, checkThreadOpen } from '../compose.js';
import { moderateMessage } from '../automod.js';
import { messageObj, getChannel } from '../message.js';
import { pushTo } from '../push.js';
import { addJob, schedule } from '../timers.js';
import { blockedEither } from './relationships.js';
import { loadChannel } from './channels.js';
import { reopened } from './threads.js';

const MAX_SCHEDULED = 25;
const MAX_SAVED = 200; // docs
const YEAR = 365 * 24 * 3600 * 1000;
const KEPT = ['content', 'flags', 'message_reference', 'allowed_mentions', 'sticker_ids'];

function futureTime(body, field, required) {
  const v = body?.[field];
  if (v == null && !required) return null;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  if (Number.isNaN(t)) throw invalid(field, 'DATE_TYPE_PARSE', 'Must be an ISO8601 timestamp.');
  if (t <= Date.now() || t > Date.now() + YEAR) throw invalid(field, 'BASE_TYPE_BAD_VALUE', 'Must be in the future, at most a year ahead.');
  return t;
}

// everything a send needs except slowmode, which applies to the moment of sending, not to scheduling
async function checked(ch, user, body) {
  if (!MESSAGEABLE.includes(ch.type)) throw new HttpError(400, 50008, 'Cannot send messages in a non-text channel');
  need(ch.perms, P.SEND_MESSAGES);
  if (ch.guild_id) checkVerification(ch.guild_id, user.id);
  checkThreadOpen(ch, ch.perms);
  if (ch.type === 1 && channelUserIds(ch).some(id => id !== user.id && blockedEither(user.id, id))) throw new HttpError(403, 50007, 'Cannot send messages to this user');
  const d = await prepare({ ch, perms: ch.perms, userId: user.id }, body, []);
  const mod = moderateMessage(ch, user.id, d.content);
  if (mod?.blocked) throw mod.reject();
  return { d, mod };
}

// --- scheduled messages ---------------------------------------------------------------------------------------------
const scheduledObj = r => {
  const ch = getChannel(r.channel_id);
  return {
    id: r.id, channel_id: r.channel_id, guild_id: ch?.guild_id ?? null, send_at: new Date(r.send_at).toISOString(),
    created_at: new Date(r.created_at).toISOString(), ...JSON.parse(r.body),
  };
};
const keep = body => Object.fromEntries(KEPT.filter(k => body[k] !== undefined).map(k => [k, body[k]]));

async function createScheduled(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  const body = keep(ctx.body ?? {});
  const sendAt = futureTime(ctx.body, 'send_at', true);
  if (get('SELECT COUNT(*) AS n FROM scheduled_messages WHERE user_id = ?', ctx.user.id).n >= MAX_SCHEDULED) {
    throw new HttpError(400, 0, `Maximum number of scheduled messages reached (${MAX_SCHEDULED})`);
  }
  await checked(ch, ctx.user, body);
  const id = snowflake();
  run('INSERT INTO scheduled_messages (id, user_id, channel_id, body, send_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    id, ctx.user.id, ch.id, JSON.stringify(body), sendAt, Date.now());
  schedule();
  const out = scheduledObj(get('SELECT * FROM scheduled_messages WHERE id = ?', id));
  sendToUsers([ctx.user.id], 'SCHEDULED_MESSAGE_CREATE', out);
  ctx.status = 201;
  return out;
}

const ownScheduled = ({ params, user }) => {
  const r = get('SELECT * FROM scheduled_messages WHERE id = ? AND user_id = ?', params.id, user.id);
  if (!r) throw notFound(10008, 'Scheduled Message');
  return r;
};

async function editScheduled(ctx) {
  const r = ownScheduled(ctx);
  const b = ctx.body ?? {};
  const body = { ...JSON.parse(r.body), ...keep(b) };
  const sendAt = futureTime(b, 'send_at', false) ?? r.send_at;
  const ch = getChannel(r.channel_id);
  ch.perms = channelPerms(ch, ctx.user.id);
  if (!has(ch.perms, P.VIEW_CHANNEL)) throw missingAccess();
  await checked(ch, ctx.user, body);
  run('UPDATE scheduled_messages SET body = ?, send_at = ? WHERE id = ?', JSON.stringify(body), sendAt, r.id);
  schedule();
  const out = scheduledObj(get('SELECT * FROM scheduled_messages WHERE id = ?', r.id));
  sendToUsers([ctx.user.id], 'SCHEDULED_MESSAGE_UPDATE', out);
  return out;
}

function deleteScheduled(ctx) {
  const r = ownScheduled(ctx);
  run('DELETE FROM scheduled_messages WHERE id = ?', r.id);
  sendToUsers([r.user_id], 'SCHEDULED_MESSAGE_DELETE', { id: r.id, channel_id: r.channel_id, guild_id: getChannel(r.channel_id)?.guild_id ?? null });
}

// at send time the author's current permissions decide; a refused message is dropped and the author told why
async function deliverScheduled(r) {
  const gone = { id: r.id, channel_id: r.channel_id, guild_id: null };
  try {
    const user = userById(r.user_id);
    const ch = getChannel(r.channel_id);
    if (!user || user.deleted || !ch) throw missingAccess();
    gone.guild_id = ch.guild_id ?? null;
    ch.perms = channelPerms(ch, user.id);
    if (!has(ch.perms, P.VIEW_CHANNEL)) throw missingAccess();
    const { d, mod } = await checked(ch, user, JSON.parse(r.body));
    const m = await send(d, user.id);
    if (isThread(ch)) reopened(ch);
    mod?.execute(m.id);
    sendToUsers([r.user_id], 'SCHEDULED_MESSAGE_DELETE', { ...gone, message_id: m.id });
  } catch (e) {
    if (!(e instanceof HttpError)) console.error('scheduled message failed:', e);
    sendToUsers([r.user_id], 'SCHEDULED_MESSAGE_DELETE', { ...gone, failed: true, code: e.body?.code ?? 0 });
  }
}

addJob({
  name: 'scheduled messages',
  next: () => get('SELECT MIN(send_at) AS t FROM scheduled_messages').t,
  run: now => {
    for (const r of all('SELECT * FROM scheduled_messages WHERE send_at <= ? ORDER BY send_at', now)) {
      run('DELETE FROM scheduled_messages WHERE id = ?', r.id); // removed first: a crash mid-send never sends twice
      deliverScheduled(r);
    }
  },
});

// --- saved messages and reminders -----------------------------------------------------------------------------------
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export function savedObj(r) {
  const ch = getChannel(r.channel_id);
  const row = get('SELECT * FROM messages WHERE id = ?', r.message_id);
  const readable = ch && row && has(channelPerms(ch, r.user_id), P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY);
  const author = row && userById(row.author_id);
  const tags = r.tags ? (typeof r.tags === 'string' ? json(r.tags, []) : r.tags) : [];
  return {
    message: readable ? messageObj(row, ch, r.user_id) : null,
    save_data: {
      channel_id: r.channel_id, message_id: r.message_id, ...(ch?.guild_id && { guild_id: ch.guild_id }), saved_at: r.saved_at,
      author_summary: readable ? author?.global_name ?? author?.username ?? '' : '', channel_summary: readable ? ch.name ?? '' : '',
      message_summary: readable ? cut(row.content, 100) : '', notes: '', due_at: r.due_at == null ? null : new Date(r.due_at).toISOString(),
      folder_id: r.folder_id ?? null,
      tags,
    },
    folder_id: r.folder_id ?? null,
    tags,
  };
}

function save(ctx) {
  const ch = loadChannel(ctx.params.channel_id, ctx.user);
  need(ch.perms, P.READ_MESSAGE_HISTORY);
  if (!get('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?', ctx.params.message_id, ch.id)) throw notFound(10008, 'Message');
  const due = futureTime(ctx.body, 'due_at', false);
  const folderId = ctx.body?.folder_id ?? null;
  const tags = Array.isArray(ctx.body?.tags) ? JSON.stringify(ctx.body.tags) : '[]';
  const exists = get('SELECT 1 FROM saved_messages WHERE user_id = ? AND message_id = ?', ctx.user.id, ctx.params.message_id);
  if (!exists && get('SELECT COUNT(*) AS n FROM saved_messages WHERE user_id = ?', ctx.user.id).n >= MAX_SAVED) {
    throw new HttpError(400, 0, `Maximum number of saved messages reached (${MAX_SAVED})`);
  }
  run(`INSERT INTO saved_messages (user_id, channel_id, message_id, saved_at, due_at, folder_id, tags) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT DO UPDATE SET due_at = excluded.due_at, notified = 0, folder_id = COALESCE(excluded.folder_id, saved_messages.folder_id), tags = COALESCE(excluded.tags, saved_messages.tags)`,
       ctx.user.id, ch.id, ctx.params.message_id, new Date().toISOString(), due, folderId, tags);
  schedule();
  const out = savedObj(get('SELECT * FROM saved_messages WHERE user_id = ? AND message_id = ?', ctx.user.id, ctx.params.message_id));
  sendToUsers([ctx.user.id], 'SAVED_MESSAGE_CREATE', out);
  return out;
}

function unsave({ params, user }) {
  if (run('DELETE FROM saved_messages WHERE user_id = ? AND message_id = ?', user.id, params.message_id).changes) {
    sendToUsers([user.id], 'SAVED_MESSAGE_DELETE', { channel_id: params.channel_id, message_id: params.message_id });
  }
}

// a due reminder: the client's inbox shows it, the user's sessions hear it, and an idle user gets a push
addJob({
  name: 'message reminders',
  next: () => get('SELECT MIN(due_at) AS t FROM saved_messages WHERE due_at IS NOT NULL AND notified = 0').t,
  run: now => {
    for (const r of all('SELECT * FROM saved_messages WHERE due_at IS NOT NULL AND notified = 0 AND due_at <= ?', now)) {
      run('UPDATE saved_messages SET notified = 1 WHERE user_id = ? AND message_id = ?', r.user_id, r.message_id);
      const out = savedObj(r);
      sendToUsers([r.user_id], 'MESSAGE_REMINDER_DUE', out);
      if (!out.message) continue;
      const guild = out.save_data.guild_id ?? '@me';
      pushTo([r.user_id], null, 'reminder', {
        title: `Reminder: ${out.save_data.author_summary}`, body: out.save_data.message_summary || 'a message',
        url: `/channels/${guild}/${r.channel_id}/${r.message_id}`, tag: `reminder-${r.message_id}`,
      });
    }
  },
});

const recurringObj = r => ({
  id: r.id,
  channel_id: r.channel_id,
  author_id: r.author_id,
  content: r.content,
  interval_type: r.interval_type,
  time_of_day: r.time_of_day,
  next_run: new Date(r.next_run).toISOString(),
  created_at: new Date(r.created_at).toISOString(),
});

function computeNextRun(intervalType, timeOfDay) {
  const [hh, mm] = (timeOfDay || '12:00').split(':').map(Number);
  const next = new Date();
  next.setHours(hh || 12, mm || 0, 0, 0);
  if (next.getTime() <= Date.now()) {
    if (intervalType === 'weekly') next.setDate(next.getDate() + 7);
    else if (intervalType === 'monthly') next.setMonth(next.getMonth() + 1);
    else next.setDate(next.getDate() + 1);
  }
  return next.getTime();
}

function listRecurring(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  need(ch.perms, P.SEND_MESSAGES);
  return all('SELECT * FROM recurring_messages WHERE channel_id = ? ORDER BY next_run', ch.id).map(recurringObj);
}

async function createRecurring(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  need(ch.perms, P.SEND_MESSAGES);
  if (ch.guild_id) need(ch.perms, P.MANAGE_MESSAGES);
  const content = str(ctx.body ?? {}, 'content', 1, 2000);
  const intervalType = ['daily', 'weekly', 'monthly'].includes(ctx.body?.interval_type) ? ctx.body.interval_type : 'daily';
  const timeOfDay = typeof ctx.body?.time_of_day === 'string' && /^\d{2}:\d{2}$/.test(ctx.body.time_of_day) ? ctx.body.time_of_day : '12:00';
  const nextRun = computeNextRun(intervalType, timeOfDay);
  const id = snowflake();
  run('INSERT INTO recurring_messages (id, channel_id, author_id, content, interval_type, time_of_day, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, ch.id, ctx.user.id, content, intervalType, timeOfDay, nextRun, Date.now());
  schedule();
  ctx.status = 201;
  return recurringObj(get('SELECT * FROM recurring_messages WHERE id = ?', id));
}

function deleteRecurring(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  if (ch.guild_id) need(ch.perms, P.MANAGE_MESSAGES);
  const row = get('SELECT * FROM recurring_messages WHERE id = ? AND channel_id = ?', ctx.params.mid, ch.id);
  if (!row) throw notFound(10008, 'Recurring Message');
  run('DELETE FROM recurring_messages WHERE id = ?', row.id);
  return { ok: true };
}

addJob({
  name: 'recurring messages',
  next: () => get('SELECT MIN(next_run) AS t FROM recurring_messages').t,
  run: async now => {
    for (const r of all('SELECT * FROM recurring_messages WHERE next_run <= ?', now)) {
      const ch = getChannel(r.channel_id);
      if (ch) {
        try {
          const d = await prepare({ ch, perms: 0n, userId: r.author_id }, { content: r.content }, []);
          await send(d, r.author_id);
        } catch (e) {
          console.error('Failed to deliver recurring message:', e);
        }
      }
      const nextRun = computeNextRun(r.interval_type, r.time_of_day);
      run('UPDATE recurring_messages SET next_run = ? WHERE id = ?', nextRun, r.id);
    }
  },
});

const user = { userOnly: true };
export default [
  ['POST', '/channels/:id/scheduled-messages', createScheduled, user],
  ['GET', '/users/@me/scheduled-messages', ({ user: u }) => all('SELECT * FROM scheduled_messages WHERE user_id = ? ORDER BY send_at', u.id).map(scheduledObj), user],
  ['PATCH', '/users/@me/scheduled-messages/:id', editScheduled, user],
  ['DELETE', '/users/@me/scheduled-messages/:id', deleteScheduled, user],
  ['GET', '/channels/:id/recurring-messages', listRecurring, user],
  ['POST', '/channels/:id/recurring-messages', createRecurring, user],
  ['DELETE', '/channels/:id/recurring-messages/:mid', deleteRecurring, user],
  ['GET', '/users/@me/saved-messages', ({ user: u }) => ({
    results: all('SELECT * FROM saved_messages WHERE user_id = ? ORDER BY saved_at DESC', u.id).map(savedObj),
  }), user],
  ['PUT', '/users/@me/saved-messages/:channel_id/:message_id', save, user],
  ['DELETE', '/users/@me/saved-messages/:channel_id/:message_id', unsave, user],
];
