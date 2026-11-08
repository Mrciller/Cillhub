import { snowflake } from '../snowflake.js';
import { get, all, run, tx, json, memberRow, memberObj, isMember, threadObj, threadMemberObj } from '../db.js';
import { HttpError, str, int, bool, invalid, intParam, idParam, notFound, missingPermissions } from '../errors.js';
import { P, has, need, channelPerms, viewersOf, isThread } from '../permissions.js';
import { sendToUsers, guildParts } from '../gateway.js';
import { addJob, schedule } from '../timers.js';
import { removeChannelFiles } from '../files.js';
import { audit, A, diff } from '../audit.js';
import { checkVerification, checkSlowmode, markSent } from '../compose.js';
import { getChannel, getMessage, broadcastMessage } from '../message.js';
import { loadChannel } from './channels.js';
import { createPost } from './forums.js';

const DURATIONS = [60, 1440, 4320, 10080];
const PINNED = 2;
const ARCHIVED = 50083;

export const getThread = id => get('SELECT * FROM channels WHERE id = ? AND type IN (10, 11, 12)', id);

export function durationField(body, field = 'auto_archive_duration') {
  if (!DURATIONS.includes(body[field])) throw invalid(field, 'BASE_TYPE_CHOICES', `Must be one of ${DURATIONS.join(', ')}.`);
  return body[field];
}
const rateField = body => (body.rate_limit_per_user == null ? 0 : int(body, 'rate_limit_per_user', 0, 21600));

// active threads in the guild this user can see
export const activeThreads = (guildId, userId) => all(
  'SELECT * FROM channels WHERE guild_id = ? AND type IN (10, 11, 12) AND archived = 0 ORDER BY CAST(id AS INTEGER) DESC', guildId,
).filter(t => has(channelPerms(t, userId), P.VIEW_CHANNEL));

const myMemberships = (threads, userId) => threads.map(t => get('SELECT * FROM thread_members WHERE channel_id = ? AND user_id = ?', t.id, userId))
  .filter(Boolean).map(tm => threadMemberObj(tm));

// GUILD_CREATE / READY carry the active threads; their member objects leave out id and user_id
guildParts.push((g, userId) => ({
  threads: userId ? activeThreads(g.id, userId).map(t => {
    const o = threadObj(t, userId);
    if (o.member) o.member = threadMemberObj({ ...o.member, channel_id: t.id }, false);
    return o;
  }) : [],
}));

export const threadEvent = (t, type, extra) => sendToUsers(viewersOf(t), type, uid => ({ ...threadObj(t, uid), ...extra }));

// THREAD_LIST_SYNC after someone may have gained access (roles, overwrites); channelIds limits it to those parents
export function threadListSync(guildId, userIds, channelIds) {
  sendToUsers(userIds, 'THREAD_LIST_SYNC', uid => {
    const threads = activeThreads(guildId, uid).filter(t => !channelIds || channelIds.includes(t.parent_id));
    return { guild_id: guildId, ...(channelIds && { channel_ids: channelIds }), threads: threads.map(t => threadObj(t, uid)), members: myMemberships(threads, uid) };
  });
}

function membersUpdate(t, { added = [], removed = [] }) {
  const count = Math.min(get('SELECT COUNT(*) AS n FROM thread_members WHERE channel_id = ?', t.id).n, 50);
  const added_members = added.map(id => {
    const tm = get('SELECT * FROM thread_members WHERE channel_id = ? AND user_id = ?', t.id, id);
    const m = memberRow(t.guild_id, id);
    return { ...threadMemberObj(tm), member: m && memberObj(m), presence: null };
  });
  sendToUsers([...viewersOf(t), ...removed], 'THREAD_MEMBERS_UPDATE', {
    id: t.id, guild_id: t.guild_id, member_count: count,
    ...(added.length && { added_members }), ...(removed.length && { removed_member_ids: removed }),
  });
}

function addMember(t, userId) {
  if (!run('INSERT OR IGNORE INTO thread_members (channel_id, user_id, join_timestamp) VALUES (?, ?, ?)', t.id, userId, new Date().toISOString()).changes) return;
  // being added to a thread brings it into the user's client, private or not
  sendToUsers([userId], 'THREAD_CREATE', threadObj(getThread(t.id), userId));
  membersUpdate(t, { added: [userId] });
}

function removeMember(t, userId) {
  if (run('DELETE FROM thread_members WHERE channel_id = ? AND user_id = ?', t.id, userId).changes) membersUpdate(t, { removed: [userId] });
}

// a new thread row with its creator as first member. f: { name, type, auto_archive_duration, rate_limit_per_user, invitable, applied_tags }
export function insertThread(parent, f, ownerId, id = snowflake()) {
  const now = new Date().toISOString();
  tx(() => {
    run(`INSERT INTO channels (id, type, guild_id, name, parent_id, owner_id, rate_limit_per_user, auto_archive_duration, archive_timestamp,
           create_timestamp, last_activity, invitable, applied_tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, f.type, parent.guild_id, f.name, parent.id, ownerId, f.rate_limit_per_user ?? 0,
    f.auto_archive_duration ?? parent.default_auto_archive_duration ?? 1440, now, now, Date.now(), Number(f.invitable ?? true),
    JSON.stringify(f.applied_tags ?? []));
    run('INSERT INTO thread_members (channel_id, user_id, join_timestamp) VALUES (?, ?, ?)', id, ownerId, now);
  });
  schedule();
  return getThread(id);
}

// common rules for starting any thread in parent: send-type checks, slowmode on the parent
export function checkStart(ctx, parent, perm) {
  need(parent.perms, perm);
  checkVerification(parent.guild_id, ctx.user.id);
  checkSlowmode(parent, ctx.user.id, parent.perms);
}

export function announceNew(ctx, parent, t) {
  markSent(parent, ctx.user.id);
  threadEvent(t, 'THREAD_CREATE', { newly_created: true });
  audit(ctx, t.guild_id, A.THREAD_CREATE, t.id, { changes: diff({}, { name: t.name, type: t.type, auto_archive_duration: t.auto_archive_duration }) });
}

function fromMessage(ctx) {
  const parent = loadChannel(ctx.params.id, ctx.user);
  if (parent.type !== 0 && parent.type !== 5) throw new HttpError(400, 50024, 'Cannot execute action on this channel type');
  const m = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', ctx.params.mid, parent.id);
  if (!m) throw notFound(10008, 'Message');
  checkStart(ctx, parent, P.CREATE_PUBLIC_THREADS);
  if (get('SELECT 1 FROM channels WHERE id = ?', m.id)) throw new HttpError(400, 160004, 'A thread has already been created for this message');
  const body = ctx.body ?? {};
  // the thread shares the message's id, which is how the message's `thread` field finds it
  const t = insertThread(parent, {
    name: str(body, 'name', 1, 100), type: parent.type === 5 ? 10 : 11, rate_limit_per_user: rateField(body),
    auto_archive_duration: body.auto_archive_duration == null ? undefined : durationField(body),
  }, ctx.user.id, m.id);
  announceNew(ctx, parent, t);
  broadcastMessage(parent, 'MESSAGE_UPDATE', getMessage(m.id));
  ctx.status = 201;
  return threadObj(t, ctx.user.id);
}

function standalone(ctx) {
  const parent = loadChannel(ctx.params.id, ctx.user);
  if (parent.type === 15) return createPost(ctx, parent);
  if (parent.type !== 0 && parent.type !== 5) throw new HttpError(400, 50024, 'Cannot execute action on this channel type');
  const body = ctx.body ?? {};
  const type = body.type ?? (parent.type === 5 ? 10 : 12);
  const allowed = parent.type === 5 ? [10] : [11, 12];
  if (!allowed.includes(type)) throw invalid('type', 'BASE_TYPE_CHOICES', `Must be one of ${allowed.join(', ')}.`);
  checkStart(ctx, parent, type === 12 ? P.CREATE_PRIVATE_THREADS : P.CREATE_PUBLIC_THREADS);
  const t = insertThread(parent, {
    name: str(body, 'name', 1, 100), type, rate_limit_per_user: rateField(body),
    auto_archive_duration: body.auto_archive_duration == null ? undefined : durationField(body),
    invitable: type === 12 && body.invitable !== undefined ? bool(body, 'invitable') : true,
  }, ctx.user.id);
  announceNew(ctx, parent, t);
  ctx.status = 201;
  return threadObj(t, ctx.user.id);
}

function loadThread({ params, user }) {
  const t = loadChannel(params.id, user);
  if (!isThread(t)) throw new HttpError(400, 50024, 'Cannot execute action on this channel type');
  return t;
}

const isMod = t => has(t.perms, P.MANAGE_THREADS);
function requireActive(t) {
  if (t.archived) throw new HttpError(400, ARCHIVED, 'Thread is archived');
}

function join(ctx) {
  const t = loadThread(ctx);
  requireActive(t);
  addMember(t, ctx.user.id);
}

function add(ctx) {
  const t = loadThread(ctx);
  requireActive(t);
  if (t.locked && !isMod(t)) throw new HttpError(403, 160005, 'Thread is locked');
  need(t.perms, P.SEND_MESSAGES);
  if (t.type === 12 && !t.invitable && !isMod(t)) throw missingPermissions();
  const target = ctx.params.user_id;
  const parent = getChannel(t.parent_id);
  if (!isMember(t.guild_id, target) || !has(channelPerms(parent, target), P.VIEW_CHANNEL)) throw notFound(10007, 'Member');
  addMember(t, target);
}

function leave(ctx) {
  const t = loadThread(ctx);
  requireActive(t);
  removeMember(t, ctx.user.id);
}

function kick(ctx) {
  const t = loadThread(ctx);
  requireActive(t);
  if (!isMod(t) && !(t.type === 12 && t.owner_id === ctx.user.id)) throw missingPermissions();
  removeMember(t, ctx.params.user_id);
}

function memberOut(t, tm, withMember) {
  const m = withMember && memberRow(t.guild_id, tm.user_id);
  return { ...threadMemberObj(tm), ...(m && { member: memberObj(m) }) };
}

function listMembers(ctx) {
  const t = loadThread(ctx);
  const withMember = ctx.query.get('with_member') === 'true';
  const after = idParam(ctx.query, 'after');
  const limit = intParam(ctx.query, 'limit', 100, 1, 100);
  return all(`SELECT * FROM thread_members WHERE channel_id = ? AND (? IS NULL OR CAST(user_id AS INTEGER) > CAST(? AS INTEGER))
              ORDER BY CAST(user_id AS INTEGER) LIMIT ?`, t.id, after, after, limit).map(tm => memberOut(t, tm, withMember));
}

function getMember(ctx) {
  const t = loadThread(ctx);
  const tm = get('SELECT * FROM thread_members WHERE channel_id = ? AND user_id = ?', t.id, ctx.params.user_id);
  if (!tm) throw notFound(10007, 'Member');
  return memberOut(t, tm, ctx.query.get('with_member') === 'true');
}

function active({ params, user }) {
  if (!isMember(params.id, user.id)) throw notFound(10004, 'Guild');
  const threads = activeThreads(params.id, user.id);
  return { threads: threads.map(t => threadObj(t, user.id)), members: myMemberships(threads, user.id) };
}

// archived lists: sorted by archive_timestamp (or id for the joined list), newest first, `before` pages
function archived(ctx, kind) {
  const parent = loadChannel(ctx.params.id, ctx.user);
  need(parent.perms, P.READ_MESSAGE_HISTORY);
  if (kind === 'private') need(parent.perms, P.MANAGE_THREADS);
  const limit = intParam(ctx.query, 'limit', 50, 1, 100);
  const before = ctx.query.get('before');
  const types = kind === 'public' ? '(10, 11)' : '(12)';
  let rows;
  if (kind === 'joined') {
    const id = idParam(ctx.query, 'before');
    rows = all(`SELECT c.* FROM channels c JOIN thread_members tm ON tm.channel_id = c.id AND tm.user_id = ?
                WHERE c.parent_id = ? AND c.type = 12 AND c.archived = 1 AND (? IS NULL OR CAST(c.id AS INTEGER) < CAST(? AS INTEGER))
                ORDER BY CAST(c.id AS INTEGER) DESC LIMIT ?`, ctx.user.id, parent.id, id, id, limit + 1);
  } else {
    const ts = before == null ? null : new Date(Number.isNaN(Date.parse(before)) ? 0 : before).toISOString();
    rows = all(`SELECT * FROM channels WHERE parent_id = ? AND type IN ${types} AND archived = 1 AND (? IS NULL OR archive_timestamp < ?)
                ORDER BY archive_timestamp DESC LIMIT ?`, parent.id, ts, ts, limit + 1);
  }
  const threads = rows.slice(0, limit).filter(t => has(channelPerms(t, ctx.user.id), P.VIEW_CHANNEL));
  return { threads: threads.map(t => threadObj(t, ctx.user.id)), members: myMemberships(threads, ctx.user.id), has_more: rows.length > limit };
}

function tagsField(body, parent, t, perms) {
  const tags = json(parent.available_tags, []);
  if (!Array.isArray(body.applied_tags) || body.applied_tags.length > 5) throw invalid('applied_tags', 'BASE_TYPE_MAX_LENGTH', 'At most 5 tags.');
  const ids = [...new Set(body.applied_tags.map(String))];
  const before = new Set(json(t?.applied_tags, []));
  for (const id of ids) {
    const tag = tags.find(x => x.id === id);
    if (!tag) throw invalid('applied_tags', 'UNKNOWN_TAG', 'Unknown tag.');
    if (tag.moderated && !before.has(id) && !has(perms, P.MANAGE_THREADS)) throw new HttpError(403, 40066, 'There are no tags available that can be set by non-moderators');
  }
  for (const id of before) if (!ids.includes(id) && tags.find(x => x.id === id)?.moderated && !has(perms, P.MANAGE_THREADS)) throw missingPermissions();
  return ids;
}
export { tagsField };

// PATCH /channels/:id on a thread, with the docs' per-field rules
export function patchThread(ctx, t) {
  const body = ctx.body ?? {};
  const mod = isMod(t);
  const creator = t.owner_id === ctx.user.id;
  const next = {};
  if (body.archived === false && t.archived) {
    if (!mod && (t.locked || !has(t.perms, P.SEND_MESSAGES))) throw new HttpError(403, 160005, 'Thread is locked');
    next.archived = 0;
  }
  if (t.archived && next.archived !== 0 && Object.keys(body).some(k => k !== 'archived')) throw new HttpError(400, ARCHIVED, 'Thread is archived');
  const ownOrMod = () => { if (!mod && !creator) throw missingPermissions(); };
  if (body.name !== undefined) { ownOrMod(); next.name = str(body, 'name', 1, 100); }
  if (body.archived === true && !t.archived) { ownOrMod(); next.archived = 1; }
  if (body.auto_archive_duration !== undefined) { ownOrMod(); next.auto_archive_duration = durationField(body); }
  if (body.invitable !== undefined && t.type === 12) { ownOrMod(); next.invitable = Number(bool(body, 'invitable')); }
  if (body.locked !== undefined) { need(t.perms, P.MANAGE_THREADS); next.locked = Number(bool(body, 'locked')); }
  if (body.rate_limit_per_user !== undefined) { need(t.perms, P.MANAGE_THREADS); next.rate_limit_per_user = rateField(body); }
  const parent = getChannel(t.parent_id);
  if (body.flags !== undefined) {
    need(t.perms, P.MANAGE_THREADS);
    const flags = int(body, 'flags', 0, 2 ** 31);
    if (flags & ~PINNED || (flags & PINNED && parent.type !== 15)) throw invalid('flags', 'CHANNEL_FLAGS_INVALID', 'Only PINNED, on forum posts.');
    if (flags & PINNED && !(t.flags & PINNED)) {
      const pinnedCount = get('SELECT COUNT(*) AS n FROM channels WHERE parent_id = ? AND (flags & 2) != 0 AND archived = 0', parent.id)?.n ?? 0;
      if (pinnedCount >= 5) throw new HttpError(400, 50035, 'Maximum of 5 pinned posts reached for this forum');
    }
    next.flags = flags;
  }
  if (body.solved_message_id !== undefined) {
    if (parent.type !== 15) throw invalid('solved_message_id', 'BASE_TYPE_INVALID', 'Only forum posts can have a solved message.');
    if (!mod && !creator) throw missingPermissions();
    if (body.solved_message_id === null) {
      next.solved_message_id = null;
    } else {
      const mid = String(body.solved_message_id);
      const exists = get('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?', mid, t.id);
      if (!exists) throw notFound(10008, 'Message');
      next.solved_message_id = mid;
    }
  }
  if (body.applied_tags !== undefined) {
    if (parent.type !== 15) throw invalid('applied_tags', 'BASE_TYPE_INVALID', 'Only forum posts have tags.');
    if (!mod && !creator) throw missingPermissions();
    next.applied_tags = JSON.stringify(tagsField(body, parent, t, t.perms));
  }
  const now = new Date().toISOString();
  // archiving, unarchiving and a new duration restart the inactivity clock; an archived post loses its pin
  if ('archived' in next || 'auto_archive_duration' in next) Object.assign(next, { archive_timestamp: now, last_activity: Date.now() });
  if (next.archived === 1) next.flags = (next.flags ?? t.flags) & ~PINNED;
  tx(() => {
    for (const [k, v] of Object.entries(next)) run(`UPDATE channels SET ${k} = ? WHERE id = ?`, v, t.id); // keys are fixed above
  });
  schedule();
  const updated = getThread(t.id);
  threadEvent(updated, 'THREAD_UPDATE');
  if (next.archived === 0) {
    const ids = all('SELECT user_id FROM thread_members WHERE channel_id = ?', t.id).map(r => r.user_id);
    for (const id of ids) {
      const tm = get('SELECT * FROM thread_members WHERE channel_id = ? AND user_id = ?', t.id, id);
      sendToUsers([id], 'THREAD_MEMBER_UPDATE', { ...threadMemberObj(tm), guild_id: t.guild_id });
    }
  }
  const keys = ['name', 'archived', 'locked', 'auto_archive_duration', 'rate_limit_per_user', 'invitable', 'flags', 'applied_tags', 'solved_message_id'];
  audit(ctx, t.guild_id, A.THREAD_UPDATE, t.id, { changes: diff(t, updated, keys.filter(k => k in next)) });
  return threadObj(updated, ctx.user.id);
}

export function deleteThread(ctx, t) {
  need(t.perms, P.MANAGE_THREADS);
  const viewers = viewersOf(t);
  run('DELETE FROM channels WHERE id = ?', t.id);
  removeChannelFiles(t.id);
  sendToUsers(viewers, 'THREAD_DELETE', { id: t.id, guild_id: t.guild_id, parent_id: t.parent_id, type: t.type });
  audit(ctx, t.guild_id, A.THREAD_DELETE, t.id, { changes: diff({ name: t.name, type: t.type }, {}, ['name', 'type']) });
  const parentMessage = getMessage(t.id);
  if (parentMessage) broadcastMessage(getChannel(parentMessage.channel_id), 'MESSAGE_UPDATE', parentMessage);
  return threadObj(t);
}

// a send into an archived thread reopened it: tell its viewers and re-arm the archive timer
export function reopened(t) {
  if (!t.archived) return;
  schedule();
  threadEvent(getThread(t.id), 'THREAD_UPDATE');
}

// auto-archive: due when idle for auto_archive_duration minutes; pinned forum posts never archive
const DUE = `type IN (10, 11, 12) AND archived = 0 AND (flags & ${PINNED}) = 0`;
addJob({
  name: 'thread auto-archive',
  next: () => get(`SELECT MIN(last_activity + auto_archive_duration * 60000) AS t FROM channels WHERE ${DUE}`).t,
  run(now) {
    const due = all(`SELECT * FROM channels WHERE ${DUE} AND last_activity + auto_archive_duration * 60000 <= ?`, now);
    for (const t of due) {
      run('UPDATE channels SET archived = 1, archive_timestamp = ? WHERE id = ?', new Date(now).toISOString(), t.id);
      threadEvent(getThread(t.id), 'THREAD_UPDATE');
    }
  },
});

function updateMyThreadMember(ctx) {
  const t = loadThread(ctx);
  const tm = get('SELECT * FROM thread_members WHERE channel_id = ? AND user_id = ?', t.id, ctx.user.id);
  if (!tm) throw notFound(10007, 'Thread Member');
  const body = ctx.body ?? {};
  if (body.flags !== undefined) {
    const flags = int(body, 'flags', 0, 2);
    run('UPDATE thread_members SET flags = ? WHERE channel_id = ? AND user_id = ?', flags, t.id, ctx.user.id);
  }
  const updated = get('SELECT * FROM thread_members WHERE channel_id = ? AND user_id = ?', t.id, ctx.user.id);
  const out = { ...threadMemberObj(updated), guild_id: t.guild_id };
  sendToUsers([ctx.user.id], 'THREAD_MEMBER_UPDATE', out);
  return out;
}

export default [
  ['POST', '/channels/:id/messages/:mid/threads', fromMessage],
  ['POST', '/channels/:id/threads', standalone, { multipart: true }],
  ['GET', '/guilds/:id/threads/active', active],
  ['GET', '/channels/:id/threads/archived/public', ctx => archived(ctx, 'public')],
  ['GET', '/channels/:id/threads/archived/private', ctx => archived(ctx, 'private')],
  ['GET', '/channels/:id/users/@me/threads/archived/private', ctx => archived(ctx, 'joined')],
  ['GET', '/channels/:id/thread-members', listMembers],
  ['PUT', '/channels/:id/thread-members/@me', join],
  ['PATCH', '/channels/:id/thread-members/@me', updateMyThreadMember],
  ['DELETE', '/channels/:id/thread-members/@me', leave],
  ['GET', '/channels/:id/thread-members/:user_id', getMember],
  ['PUT', '/channels/:id/thread-members/:user_id', add],
  ['DELETE', '/channels/:id/thread-members/:user_id', kick],
];

