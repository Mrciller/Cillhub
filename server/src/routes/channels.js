import { snowflake } from '../snowflake.js';
import { get, all, run, tx, isMember, isFriend, memberIds, userById, channelObj, dmsOf, channelUserIds } from '../db.js';
import { HttpError, str, int, bool, list, invalid, snowflakeField, notFound, missingAccess, missingPermissions } from '../errors.js';
import { P, need, has, parseBits, guildPerms, channelPerms, viewersOf, requireAbove, requireRoleBelow, isThread } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { disconnectChannel, recheck } from '../voice.js';
import { removeChannelFiles } from '../files.js';
import { audit, A, diff } from '../audit.js';
import { loadGuild } from './guilds.js';
import { patchThread, deleteThread, durationField, threadListSync } from './threads.js';
import { checkThreadOpen } from '../compose.js';
import { requireUnarchived } from './messages.js';
import { forumFields } from './forums.js';
import { createGroup, patchGroup, leaveGroup } from './groups.js';
import { blockedEither } from './relationships.js';
import { schedule } from '../timers.js';

// a channel the user can VIEW, with their permissions in it as ch.perms
export function loadChannel(id, user) {
  const ch = get('SELECT * FROM channels WHERE id = ?', id);
  if (!ch) throw notFound(10003, 'Channel');
  ch.perms = channelPerms(ch, user.id);
  if (!has(ch.perms, P.VIEW_CHANNEL)) throw missingAccess();
  return ch;
}

function loadGuildChannel({ params, user }, perm) {
  const ch = loadChannel(params.id, user);
  if (!ch.guild_id) throw missingPermissions();
  need(ch.perms, perm);
  return ch;
}

const getChannel = id => get('SELECT * FROM channels WHERE id = ?', id);
const TEXT_NAMES = [0, 5, 15, 16];
const name = (body, type) => TEXT_NAMES.includes(type) ? str(body, 'name', 1, 100).toLowerCase().replace(/\s+/g, '-') : str(body, 'name', 1, 100);
const CREATABLE = [0, 2, 4, 5, 13, 15, 16];

// the v3 settings of a create or PATCH body, as column values, for the fields that apply to the channel type
function settings(raw, type, current = {}, guildId = current.guild_id) {
  const body = raw ?? {};
  const out = {};
  // v6 (user docs' icon_emoji / theme_color): the sidebar emoji instead of # and the header accent colour
  if ([0, 2, 5, 13, 15, 16].includes(type)) {
    if (body.icon_emoji !== undefined) out.icon_emoji = iconEmoji(body.icon_emoji, guildId);
    if (body.theme_color !== undefined) out.theme_color = body.theme_color === null ? null : int(body, 'theme_color', 0, 0xffffff);
  }
  const has_ = k => body[k] !== undefined;
  if (has_('nsfw') && type !== 4) out.nsfw = Number(bool(body, 'nsfw'));
  if (has_('rate_limit_per_user') && [0, 2, 5, 13, 15, 16].includes(type)) out.rate_limit_per_user = body.rate_limit_per_user === null ? 0 : int(body, 'rate_limit_per_user', 0, 21600);
  if (has_('topic') && TEXT_NAMES.includes(type)) out.topic = body.topic === null ? null : str(body, 'topic', 0, (type === 15 || type === 16) ? 4096 : 1024) || null;
  if (has_('user_limit') && (type === 2 || type === 13)) out.user_limit = int(body, 'user_limit', 0, type === 13 ? 10000 : 99);
  if (has_('default_auto_archive_duration') && TEXT_NAMES.includes(type)) {
    out.default_auto_archive_duration = body.default_auto_archive_duration === null ? null : durationField(body, 'default_auto_archive_duration');
  }
  if (has_('message_ttl')) {
    out.message_ttl = body.message_ttl === null ? 0 : int(body, 'message_ttl', 0, 31536000);
  }
  if (has_('quality_mode') && (type === 2 || type === 13)) {
    if (!['speech', 'hifi'].includes(body.quality_mode)) throw invalid('quality_mode', 'BASE_TYPE_CHOICES', 'Must be speech or hifi.');
    out.quality_mode = body.quality_mode;
  }
  if (type === 15 || type === 16) Object.assign(out, forumFields(body, current));
  if (has_('layout_type')) out.default_forum_layout = int(body, 'layout_type', 0, 2);
  return out;
}

const UNICODE_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)[\p{Emoji}\p{Emoji_Modifier}\p{Emoji_Component}\u200D\uFE0F]*$/u;
function iconEmoji(v, guildId) {
  const bad = () => invalid('icon_emoji', 'BASE_TYPE_BAD_VALUE', 'Must be {id} of an emoji of this server, {name} of a Unicode emoji, or null.');
  if (v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v) || (v.id != null && v.name != null)) throw bad();
  if (v.id == null && v.name == null) return null;
  if (v.id != null) {
    if (!get('SELECT 1 FROM emojis WHERE id = ? AND guild_id = ?', String(v.id), guildId)) throw bad();
    return JSON.stringify({ id: String(v.id), name: null });
  }
  if (typeof v.name !== 'string' || v.name.length > 32 || !UNICODE_EMOJI.test(v.name)) throw bad();
  return JSON.stringify({ id: null, name: v.name });
}

const AUDITED = ['icon_emoji', 'theme_color', 'name', 'type', 'topic', 'nsfw', 'rate_limit_per_user', 'user_limit', 'parent_id', 'default_auto_archive_duration',
  'available_tags', 'default_reaction_emoji', 'default_sort_order', 'default_forum_layout', 'default_thread_rate_limit_per_user', 'flags'];

function parentField(body, guildId, type) {
  const v = body?.parent_id;
  if (v == null) return null;
  const parent = get('SELECT * FROM channels WHERE id = ? AND guild_id = ? AND type = 4', String(v), guildId);
  if (!parent || type === 4) throw invalid('parent_id', 'CHANNEL_PARENT_INVALID', 'Parent must be a category of this guild.');
  return parent.id;
}

function parseOverwrite(o, guildId, id = o?.id) {
  const field = 'permission_overwrites';
  if (typeof id !== 'string' || ![0, 1].includes(o?.type)) throw invalid(field, 'BASE_TYPE_INVALID', 'Overwrites need an id and a type of 0 or 1.');
  const known = o.type === 0
    ? get('SELECT 1 FROM roles WHERE id = ? AND guild_id = ?', id, guildId)
    : isMember(guildId, id);
  if (!known) throw invalid(field, 'UNKNOWN_TARGET', 'Overwrite target is not a role or member of this guild.');
  return { id, type: o.type, allow: String(parseBits(o.allow ?? '0', field)), deny: String(parseBits(o.deny ?? '0', field)) };
}

const overwritesOf = channelId => all('SELECT target_id AS id, type, allow, deny FROM overwrites WHERE channel_id = ?', channelId);
const changedBits = (o, n) => (BigInt(o?.allow ?? 0) ^ BigInt(n?.allow ?? 0)) | (BigInt(o?.deny ?? 0) ^ BigInt(n?.deny ?? 0));

function parseOverwrites(body, guildId) {
  const out = list(body, 'permission_overwrites').map(o => parseOverwrite(o, guildId));
  if (new Set(out.map(o => o.id)).size !== out.length) throw invalid('permission_overwrites', 'DUPLICATE_TARGET', 'Duplicate overwrite target id.');
  return out;
}

// each overwrite that changes needs MANAGE_ROLES, a target ranked below the actor, and only changed bits the actor has in the channel or guild
function checkOverwrites(guildId, user, have, prev, next) {
  const grantable = have | guildPerms(guildId, user.id);
  const before = new Map(prev.map(o => [o.id, o]));
  const after = new Map(next.map(o => [o.id, o]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const o = before.get(id), n = after.get(id);
    if (o && n && o.type === n.type && o.allow === n.allow && o.deny === n.deny) continue;
    need(have, P.MANAGE_ROLES);
    need(grantable, changedBits(o, n));
    if ((n ?? o).type === 0) requireRoleBelow(guildId, user.id, get('SELECT position FROM roles WHERE id = ?', id)?.position ?? 0);
    else requireAbove(guildId, user.id, id);
  }
}

function writeOverwrites(channelId, overwrites) {
  run('DELETE FROM overwrites WHERE channel_id = ?', channelId);
  for (const o of overwrites) {
    run('INSERT INTO overwrites (channel_id, target_id, type, allow, deny) VALUES (?, ?, ?, ?, ?)', channelId, o.id, o.type, o.allow, o.deny);
  }
}

function createChannel(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_CHANNELS);
  const { body, user } = ctx;
  const type = body?.type ?? 0;
  if (!CREATABLE.includes(type)) throw invalid('type', 'BASE_TYPE_CHOICES', `Value must be one of {${CREATABLE.join(', ')}}.`);
  const channelName = name(body, type);
  const parentId = parentField(body, g.id, type);
  const extra = settings(body, type, {}, g.id);
  let overwrites;
  if (body.permission_overwrites !== undefined) {
    overwrites = parseOverwrites(body, g.id);
    checkOverwrites(g.id, user, g.perms, [], overwrites);
  } else overwrites = parentId ? overwritesOf(parentId) : [];
  const id = snowflake();
  tx(() => {
    run(`INSERT INTO channels (id, type, guild_id, name, parent_id, position)
         VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), -1) + 1 FROM channels WHERE guild_id = ? AND parent_id IS ? AND type NOT IN (10, 11, 12)))`,
    id, type, g.id, channelName, parentId, g.id, parentId);
    for (const [k, v] of Object.entries(extra)) run(`UPDATE channels SET ${k} = ? WHERE id = ?`, v, id); // keys come from settings()
    writeOverwrites(id, overwrites);
  });
  const row = getChannel(id);
  const out = channelObj(row);
  sendToUsers(memberIds(g.id), 'CHANNEL_CREATE', out);
  audit(ctx, g.id, A.CHANNEL_CREATE, id, { changes: diff({}, out, AUDITED.filter(k => out[k] !== undefined)) });
  ctx.status = 201;
  return out;
}

function cloneChannel(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  if (!ch.guild_id || isThread(ch)) throw new HttpError(400, 50024, 'Cannot clone this channel type');
  need(ch.perms, P.MANAGE_CHANNELS);
  const srcOverwrites = overwritesOf(ch.id);
  if (srcOverwrites.length > 0) {
    checkOverwrites(ch.guild_id, ctx.user, ch.perms, [], srcOverwrites);
  }
  const id = snowflake();
  const channelName = ctx.body?.name?.trim() ? str(ctx.body, 'name', 1, 100) : ch.name;
  tx(() => {
    run(`INSERT INTO channels (id, type, guild_id, name, parent_id, position, topic, nsfw, rate_limit_per_user,
           user_limit, available_tags, default_reaction_emoji, default_sort_order, default_forum_layout,
           default_auto_archive_duration, default_thread_rate_limit_per_user, theme_color, icon_emoji,
           message_ttl, quality_mode, flags)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, ch.type, ch.guild_id, channelName, ch.parent_id, ch.position + 1, ch.topic, ch.nsfw ? 1 : 0, ch.rate_limit_per_user ?? 0,
      ch.user_limit ?? 0, ch.available_tags, ch.default_reaction_emoji, ch.default_sort_order, ch.default_forum_layout,
      ch.default_auto_archive_duration, ch.default_thread_rate_limit_per_user ?? 0, ch.theme_color ?? null, ch.icon_emoji,
      ch.message_ttl ?? 0, ch.quality_mode ?? 'speech', ch.flags ?? 0);
    writeOverwrites(id, srcOverwrites);
  });
  const row = getChannel(id);
  const out = channelObj(row);
  sendToUsers(memberIds(ch.guild_id), 'CHANNEL_CREATE', out);
  audit(ctx, ch.guild_id, A.CHANNEL_CREATE, id, { changes: diff({}, out, AUDITED.filter(k => out[k] !== undefined)) });
  ctx.status = 201;
  return out;
}

function reorder({ params, body, user }) {
  const g = loadGuild(params.id, user, P.MANAGE_CHANNELS);
  const changes = list(body).map(item => {
    const ch = get('SELECT * FROM channels WHERE id = ? AND guild_id = ? AND type NOT IN (10, 11, 12)', snowflakeField(item, 'id'), g.id);
    if (!ch) throw invalid('id', 'CHANNEL_INVALID', 'Unknown channel in this guild.');
    return { ch, position: int(item, 'position', 0, 10000), parentId: item.parent_id === undefined ? ch.parent_id : parentField(item, g.id, ch.type) };
  });
  const changed = changes.filter(c => c.position !== c.ch.position || c.parentId !== c.ch.parent_id);
  tx(() => changed.forEach(c => run('UPDATE channels SET position = ?, parent_id = ? WHERE id = ?', c.position, c.parentId, c.ch.id)));
  const ids = memberIds(g.id);
  for (const c of changed) sendToUsers(ids, 'CHANNEL_UPDATE', channelObj(getChannel(c.ch.id)));
}

function patchChannel(ctx) {
  const t = loadChannel(ctx.params.id, ctx.user);
  if (isThread(t)) return patchThread(ctx, t);
  if (t.type === 3) return patchGroup(ctx, t);
  if (t.type === 1) {
    const body = ctx.body ?? {};
    if (body.message_ttl !== undefined) {
      const ttl = body.message_ttl === null ? 0 : int(body, 'message_ttl', 0, 31536000);
      run('UPDATE channels SET message_ttl = ? WHERE id = ?', ttl, t.id);
      if (ttl > 0) schedule();
      const out = channelObj(getChannel(t.id), ctx.user.id);
      sendToUsers(channelUserIds(t), 'CHANNEL_UPDATE', out);
      return out;
    }
    return channelObj(t, ctx.user.id);
  }
  const ch = loadGuildChannel(ctx, P.MANAGE_CHANNELS);
  const { user } = ctx;
  const body = ctx.body ?? {};
  // text and announcement channels convert into each other
  const type = body.type === undefined || body.type === ch.type ? ch.type : body.type;
  if (type !== ch.type && !([0, 5].includes(type) && [0, 5].includes(ch.type))) throw invalid('type', 'BASE_TYPE_CHOICES', 'Only text and announcement channels convert.');
  const next = { type, ...settings(body, type, ch) };
  if (body.name !== undefined) next.name = name(body, type);
  if (body.parent_id !== undefined) next.parent_id = parentField(body, ch.guild_id, ch.type);
  let overwrites;
  if (body.permission_overwrites !== undefined) {
    overwrites = parseOverwrites(body, ch.guild_id);
    checkOverwrites(ch.guild_id, user, ch.perms, overwritesOf(ch.id), overwrites);
  }
  const prev = overwritesOf(ch.id);
  tx(() => {
    for (const [k, v] of Object.entries(next)) run(`UPDATE channels SET ${k} = ? WHERE id = ?`, v, ch.id); // keys are fixed above
    if (overwrites) writeOverwrites(ch.id, overwrites);
  });
  if (next.message_ttl !== undefined) schedule();
  const out = channelObj(getChannel(ch.id));
  sendToUsers(memberIds(ch.guild_id), 'CHANNEL_UPDATE', out);
  audit(ctx, ch.guild_id, A.CHANNEL_UPDATE, ch.id, { changes: diff(channelObj(ch), out, AUDITED) });
  if (overwrites) {
    auditOverwrites(ctx, ch, prev, overwrites);
    recheck(ch.guild_id);
    threadListSync(ch.guild_id, memberIds(ch.guild_id), [ch.id]);
  }
  return out;
}

// one entry per overwrite added, changed or removed (CHANNEL_OVERWRITE_CREATE/UPDATE/DELETE)
function auditOverwrites(ctx, ch, prev, next) {
  const before = new Map(prev.map(o => [o.id, o]));
  const after = new Map(next.map(o => [o.id, o]));
  for (const id of new Set([...before.keys(), ...after.keys()])) {
    const o = before.get(id), n = after.get(id);
    if (o && n && o.allow === n.allow && o.deny === n.deny) continue;
    const x = n ?? o;
    const role = x.type === 0 && get('SELECT name FROM roles WHERE id = ?', id);
    const action = !o ? A.CHANNEL_OVERWRITE_CREATE : !n ? A.CHANNEL_OVERWRITE_DELETE : A.CHANNEL_OVERWRITE_UPDATE;
    audit(ctx, ch.guild_id, action, ch.id, {
      changes: diff(o ?? {}, n ?? {}, ['id', 'type', 'allow', 'deny']),
      options: { id, type: String(x.type), ...(role && { role_name: role.name }) },
    });
  }
}

function setPermission(ctx, remove) {
  const { params, body, user } = ctx;
  const ch = loadGuildChannel({ params, user }, P.MANAGE_ROLES);
  if (isThread(ch)) throw new HttpError(400, 50024, 'Cannot execute action on this channel type');
  const prev = overwritesOf(ch.id);
  const next = prev.filter(o => o.id !== params.target_id);
  if (!remove) next.push(parseOverwrite(body, ch.guild_id, params.target_id));
  checkOverwrites(ch.guild_id, user, ch.perms, prev, next);
  writeOverwrites(ch.id, next);
  sendToUsers(memberIds(ch.guild_id), 'CHANNEL_UPDATE', channelObj(getChannel(ch.id)));
  auditOverwrites(ctx, ch, prev, next);
  recheck(ch.guild_id);
  threadListSync(ch.guild_id, memberIds(ch.guild_id), [ch.id]);
}

function deleteChannel(ctx) {
  const t = loadChannel(ctx.params.id, ctx.user);
  if (isThread(t)) return deleteThread(ctx, t);
  if (t.type === 3) {
    const out = channelObj(t, ctx.user.id);
    leaveGroup(t.id, ctx.user);
    return out;
  }
  const ch = loadGuildChannel(ctx, P.MANAGE_CHANNELS);
  if (ch.type === 0 && get('SELECT COUNT(*) AS n FROM channels WHERE guild_id = ? AND type = 0', ch.guild_id).n === 1) {
    throw new HttpError(400, 0, 'Cannot delete the last text channel');
  }
  disconnectChannel(ch.id);
  // threads go with their parent; a category's channels stay, without a parent
  const threads = all('SELECT id FROM channels WHERE parent_id = ? AND type IN (10, 11, 12)', ch.id);
  const children = all('SELECT id FROM channels WHERE parent_id = ? AND type NOT IN (10, 11, 12)', ch.id);
  tx(() => {
    run('DELETE FROM channels WHERE parent_id = ? AND type IN (10, 11, 12)', ch.id);
    run('UPDATE channels SET parent_id = NULL WHERE parent_id = ?', ch.id);
    for (const col of ['system_channel_id', 'afk_channel_id', 'rules_channel_id']) run(`UPDATE guilds SET ${col} = NULL WHERE ${col} = ?`, ch.id);
    run('DELETE FROM channels WHERE id = ?', ch.id);
  });
  removeChannelFiles(ch.id);
  threads.forEach(x => removeChannelFiles(x.id));
  audit(ctx, ch.guild_id, A.CHANNEL_DELETE, ch.id, { changes: diff(channelObj(ch), {}, ['name', 'type']) });
  const ids = memberIds(ch.guild_id);
  for (const c of children) sendToUsers(ids, 'CHANNEL_UPDATE', channelObj(getChannel(c.id)));
  const out = channelObj(ch);
  sendToUsers(ids, 'CHANNEL_DELETE', out);
  return out;
}

const sharesGuild = (a, b) => !!get('SELECT 1 FROM members x JOIN members y ON y.guild_id = x.guild_id WHERE x.user_id = ? AND y.user_id = ?', a, b);

// one recipient opens (or returns) a DM; none or several, or yourself among them, make a group DM (docs)
export function openDm({ body, user }) {
  const rec = body?.recipients;
  if (body?.recipient_id === undefined && rec !== undefined) {
    if (!Array.isArray(rec) || rec.length !== 1 || rec[0] === user.id) return createGroup(user, body);
    return openDm({ body: { recipient_id: rec[0] }, user });
  }
  const rid = snowflakeField(body, 'recipient_id');
  if (rid === user.id) throw invalid('recipient_id', 'BASE_TYPE_INVALID', 'Cannot open a DM with yourself.');
  if (!userById(rid)) throw notFound(10013, 'User');
  const existing = get(`
    SELECT c.* FROM channels c
    JOIN dm_recipients a ON a.channel_id = c.id AND a.user_id = ?
    JOIN dm_recipients b ON b.channel_id = c.id AND b.user_id = ?
    WHERE c.type = 1`, user.id, rid);
  if (existing) return channelObj(existing, user.id);
  if ((!isFriend(user.id, rid) && !sharesGuild(user.id, rid)) || blockedEither(user.id, rid) || (user.bot && userById(rid).bot)) {
    throw new HttpError(403, 50007, 'Cannot send messages to this user');
  }
  const id = snowflake();
  tx(() => {
    run('INSERT INTO channels (id, type) VALUES (?, 1)', id);
    run('INSERT INTO dm_recipients (channel_id, user_id) VALUES (?, ?), (?, ?)', id, user.id, id, rid);
    if (!isFriend(user.id, rid)) {
      run('INSERT OR IGNORE INTO dm_requests (channel_id, recipient_id, status, created_at) VALUES (?, ?, ?, ?)', id, rid, 'pending', new Date().toISOString());
    }
  });
  const ch = getChannel(id);
  sendToUsers([user.id, rid], 'CHANNEL_CREATE', uid => channelObj(ch, uid));
  return channelObj(ch, user.id);
}

function listMessageRequests({ user }) {
  const rows = all(`
    SELECT r.channel_id, r.created_at, c.last_message_id
    FROM dm_requests r
    JOIN channels c ON c.id = r.channel_id
    WHERE r.recipient_id = ? AND r.status = 'pending'
    ORDER BY r.created_at DESC`, user.id);
  return rows.map(r => {
    const ch = getChannel(r.channel_id);
    return ch ? channelObj(ch, user.id) : null;
  }).filter(Boolean);
}

function updateMessageRequest({ params, body, user }) {
  const status = body?.status;
  if (status !== 'accepted' && status !== 'declined') throw invalid('status', 'INVALID_STATUS', 'Must be accepted or declined');
  run('UPDATE dm_requests SET status = ? WHERE channel_id = ? AND recipient_id = ?', status, params.channel_id, user.id);
  return { channel_id: params.channel_id, status };
}

function typing({ params, user }) {
  const ch = loadChannel(params.id, user);
  requireUnarchived(ch);
  checkThreadOpen(ch, ch.perms);
  need(ch.perms, P.SEND_MESSAGES);
  sendToUsers(viewersOf(ch), 'TYPING_START', {
    channel_id: ch.id, guild_id: ch.guild_id ?? undefined, user_id: user.id, timestamp: Math.floor(Date.now() / 1000),
  });
}

export default [
  ['GET', '/users/@me/channels', ({ user }) => dmsOf(user.id).map(c => channelObj(c, user.id))],
  ['POST', '/users/@me/channels', openDm],
  ['GET', '/users/@me/message-requests', listMessageRequests],
  ['PUT', '/users/@me/message-requests/:channel_id', updateMessageRequest],
  ['POST', '/guilds/:id/channels', createChannel],
  ['PATCH', '/guilds/:id/channels', reorder],
  ['GET', '/channels/:id', ({ params, user }) => channelObj(loadChannel(params.id, user), user.id)],
  ['PATCH', '/channels/:id', patchChannel],
  ['POST', '/channels/:id/clone', cloneChannel],
  ['DELETE', '/channels/:id', deleteChannel],
  ['PUT', '/channels/:id/permissions/:target_id', ctx => setPermission(ctx, false)],
  ['DELETE', '/channels/:id/permissions/:target_id', ctx => setPermission(ctx, true)],
  ['POST', '/channels/:id/typing', typing],
];
