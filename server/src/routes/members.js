import { get, all, run, tx, json, memberIds, memberRow, memberObj, userById } from '../db.js';
import { HttpError, str, bool, list, invalid, notFound, missingPermissions } from '../errors.js';
import { P, need, has, channelPerms, guildPerms, requireAbove, requireAssignable } from '../permissions.js';
import { sendToUsers, visibility, syncVisibility } from '../gateway.js';
import { inVoice, voiceState, disconnect, move, recheck } from '../voice.js';
import { audit, A, diff } from '../audit.js';
import { moderateProfile } from '../automod.js';
import { loadGuild, removeMember } from './guilds.js';
import { threadListSync } from './threads.js';
import { saveImage, removeImage } from '../files.js';
import { nameStyles } from './customization.js';

const MAX_TIMEOUT = 28 * 24 * 3600 * 1000;

// nicknames the member sets themselves pass MEMBER_PROFILE AutoMod rules
function moderatedNick(guildId, userId, nick) {
  const mod = moderateProfile(guildId, userId, nick);
  if (mod?.blocked) throw mod.reject();
  mod?.execute(null);
  return nick;
}

function timeoutField(body) {
  const v = body.communication_disabled_until;
  if (v === null) return null;
  const t = Date.parse(v);
  if (typeof v !== 'string' || Number.isNaN(t) || t - Date.now() > MAX_TIMEOUT) {
    throw invalid('communication_disabled_until', 'BASE_TYPE_BAD_VALUE', 'Must be a timestamp at most 28 days ahead.');
  }
  return t <= Date.now() ? null : new Date(t).toISOString();
}

function loadMember(guildId, userId) {
  const m = memberRow(guildId, userId);
  if (!m) throw notFound(10007, 'Member');
  return m;
}

const nickField = body => body.nick === null ? null : str(body, 'nick', 1, 32);

function update(g, target, changes) {
  tx(() => {
    for (const k of ['nick', 'mute', 'deaf', 'communication_disabled_until', 'bio', 'avatar', 'banner', 'display_name_styles']) if (k in changes) run(`UPDATE members SET ${k} = ? WHERE guild_id = ? AND user_id = ?`, changes[k], g.id, target.id);
    if (changes.roles) {
      run('DELETE FROM member_roles WHERE guild_id = ? AND user_id = ?', g.id, target.id);
      for (const id of changes.roles) run('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)', g.id, target.id, id);
    }
  });
  const out = memberObj(memberRow(g.id, target.id));
  sendToUsers(memberIds(g.id), 'GUILD_MEMBER_UPDATE', { guild_id: g.id, ...out });
  return out;
}

// own server profile: nick (CHANGE_NICKNAME), bio, server avatar and banner
async function patchMe(ctx) {
  const { params, user } = ctx;
  const body = ctx.body ?? {};
  const g = loadGuild(params.id, user);
  const before = memberRow(g.id, user.id);
  const changes = {};
  if (body.nick !== undefined) {
    need(g.perms, P.CHANGE_NICKNAME);
    changes.nick = moderatedNick(g.id, user.id, nickField(body));
  }
  if (body.bio !== undefined) changes.bio = body.bio === null ? null : str(body, 'bio', 0, 190) || null;
  const styles = nameStyles(body, json(before.member_name_styles)); // v6: per-server display name style
  if (styles !== undefined) changes.display_name_styles = styles && JSON.stringify(styles);
  const owner = `${g.id}/${user.id}`;
  if (body.avatar !== undefined) changes.avatar = await saveImage(body.avatar, 'avatar', 'member-avatars', owner);
  if (body.banner !== undefined) changes.banner = await saveImage(body.banner, 'banner', 'member-banners', owner);
  const out = update(g, user, changes);
  if ('avatar' in changes && changes.avatar !== before.member_avatar) removeImage('member-avatars', owner, before.member_avatar);
  if ('banner' in changes && changes.banner !== before.member_banner) removeImage('member-banners', owner, before.member_banner);
  if ('nick' in changes) audit(ctx, g.id, A.MEMBER_UPDATE, user.id, { changes: diff({ nick: before.nick }, { nick: changes.nick }) });
  return out;
}

function patchMember(ctx) {
  const { params, user } = ctx;
  const body = ctx.body ?? {};
  const g = loadGuild(params.id, user);
  const target = loadMember(g.id, params.user_id);
  if (target.id === g.owner_id && user.id !== g.owner_id) throw missingPermissions();
  const vchId = voiceState(g.id, target.id)?.channel_id;
  const vPerms = vchId ? channelPerms(get('SELECT * FROM channels WHERE id = ?', vchId), user.id) : 0n;
  const moderate = (perm, voice = false) => {
    need(voice ? g.perms | vPerms : g.perms, perm);
    requireAbove(g.id, user.id, target.id);
  };
  const changes = {};
  if (body.nick !== undefined) {
    need(g.perms, P.MANAGE_NICKNAMES);
    if (target.id !== user.id) requireAbove(g.id, user.id, target.id);
    changes.nick = target.id === user.id ? moderatedNick(g.id, user.id, nickField(body)) : nickField(body);
  }
  if (body.roles !== undefined) {
    need(g.perms, P.MANAGE_ROLES);
    const wanted = new Set(list(body, 'roles').map(String));
    const current = new Set(all('SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?', g.id, target.id).map(r => r.role_id));
    for (const id of new Set([...wanted, ...current])) {
      if (wanted.has(id) === current.has(id)) continue;
      requireAssignable(g.id, user.id, id);
    }
    changes.roles = [...wanted];
  }
  if (body.mute !== undefined) { moderate(P.MUTE_MEMBERS, true); changes.mute = Number(bool(body, 'mute')); }
  if (body.deaf !== undefined) { moderate(P.DEAFEN_MEMBERS, true); changes.deaf = Number(bool(body, 'deaf')); }
  if (body.communication_disabled_until !== undefined) {
    moderate(P.MODERATE_MEMBERS);
    if (has(guildPerms(g.id, target.id), P.ADMINISTRATOR)) throw missingPermissions(); // administrators cannot be timed out
    changes.communication_disabled_until = timeoutField(body);
  }
  let dest;
  if (body.channel_id !== undefined) {
    moderate(P.MOVE_MEMBERS, true);
    if (!inVoice(g.id, target.id)) throw new HttpError(400, 40032, 'Target user is not connected to voice.');
    if (body.channel_id !== null) {
      dest = get('SELECT * FROM channels WHERE id = ? AND guild_id = ? AND type = 2', String(body.channel_id), g.id);
      if (!dest) throw notFound(10003, 'Channel');
      // docs: the mover must be able to connect to the destination too, and the target must be allowed in it
      if (!has(channelPerms(dest, user.id), P.VIEW_CHANNEL | P.CONNECT)) throw missingPermissions();
      if (!has(channelPerms(dest, target.id), P.VIEW_CHANNEL | P.CONNECT)) throw missingPermissions();
    }
  }
  const oldRoles = changes.roles && all('SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?', g.id, target.id).map(r => r.role_id);
  const from = voiceState(g.id, target.id)?.channel_id;
  const seen = changes.roles && visibility(g.id, [target.id]);
  const out = Object.keys(changes).length ? update(g, target, changes) : memberObj(target);
  if (seen) syncVisibility(g.id, seen);
  if (body.channel_id === null) disconnect(g.id, target.id);
  else if (dest) move(target.id, dest);
  if (changes.roles || 'mute' in changes || 'deaf' in changes || 'communication_disabled_until' in changes) recheck(g.id, target.id);
  if (changes.roles) threadListSync(g.id, [target.id]);
  auditMember(ctx, g, target, changes, oldRoles, { from, dest, disconnected: body.channel_id === null });
  return out;
}

function auditMember(ctx, g, target, changes, oldRoles, voice) {
  const before = { nick: target.nick, mute: !!target.mute, deaf: !!target.deaf, communication_disabled_until: target.communication_disabled_until };
  const after = { ...before, ...changes, ...('mute' in changes && { mute: !!changes.mute }), ...('deaf' in changes && { deaf: !!changes.deaf }) };
  const memberChanges = diff(before, after, Object.keys(before).filter(k => k in changes));
  if (memberChanges.length) audit(ctx, g.id, A.MEMBER_UPDATE, target.id, { changes: memberChanges });
  if (oldRoles) {
    const role = id => ({ id, name: get('SELECT name FROM roles WHERE id = ?', id)?.name });
    const added = changes.roles.filter(id => !oldRoles.includes(id)).map(role);
    const removed = oldRoles.filter(id => !changes.roles.includes(id)).map(role);
    const roleChanges = [...(added.length ? [{ key: '$add', new_value: added }] : []), ...(removed.length ? [{ key: '$remove', new_value: removed }] : [])];
    if (roleChanges.length) audit(ctx, g.id, A.MEMBER_ROLE_UPDATE, target.id, { changes: roleChanges });
  }
  if (voice.dest && voice.from !== voice.dest.id) audit(ctx, g.id, A.MEMBER_MOVE, null, { options: { channel_id: voice.dest.id, count: '1' } });
  if (voice.disconnected) audit(ctx, g.id, A.MEMBER_DISCONNECT, null, { options: { count: '1' } });
}

function kick(ctx) {
  const { params, user } = ctx;
  const g = loadGuild(params.id, user, P.KICK_MEMBERS);
  const target = loadMember(g.id, params.user_id);
  requireAbove(g.id, user.id, target.id);
  removeMember(g.id, target);
  audit(ctx, g.id, A.MEMBER_KICK, target.id);
}

function searchMembers({ params, query, user }) {
  const g = loadGuild(params.id, user);
  need(g.perms, P.MANAGE_GUILD | P.MODERATE_MEMBERS | P.KICK_MEMBERS | P.BAN_MEMBERS);
  const q = (query.get('query') || '').toLowerCase().trim();
  const limit = Math.max(1, Math.min(1000, Number(query.get('limit')) || 50));
  const roleFilter = query.get('role_ids') ? query.get('role_ids').split(',') : null;
  const signal = query.get('safety_signals');

  const members = all(`
    SELECT u.*, m.guild_id, m.joined_at, m.nick, m.mute, m.deaf, m.pending, m.communication_disabled_until,
           m.avatar AS member_avatar, m.banner AS member_banner, m.bio AS member_bio, m.display_name_styles AS member_name_styles
    FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ?`, g.id);
  const results = [];
  const now = Date.now();

  for (const row of members) {
    const nick = row.nick || '';
    if (q && !row.username.toLowerCase().includes(q) && !(row.global_name && row.global_name.toLowerCase().includes(q)) && !nick.toLowerCase().includes(q)) {
      continue;
    }
    const roles = all('SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?', g.id, row.id).map(r => r.role_id);
    if (roleFilter && !roleFilter.some(r => roles.includes(r))) {
      continue;
    }
    const isTimedOut = row.communication_disabled_until && new Date(row.communication_disabled_until).getTime() > now;
    if (signal === 'timeout' && !isTimedOut) continue;
    if (signal === 'suspicious') {
      const accountAgeDays = (now - Number(BigInt(row.id) >> 22n)) / (86400 * 1000);
      if (accountAgeDays > 7 && row.avatar) continue;
    }

    const mObj = memberObj(row);
    results.push({
      ...mObj,
      safety_signals: {
        is_timed_out: Boolean(isTimedOut),
        timed_out_until: isTimedOut ? row.communication_disabled_until : null,
        account_age_days: Math.floor((now - Number(BigInt(row.id) >> 22n)) / (86400 * 1000)),
        has_avatar: Boolean(row.avatar),
      },
    });
    if (results.length >= limit) break;
  }
  return results;
}

function bulkMemberAction(ctx) {
  const { params, body, user } = ctx;
  const g = loadGuild(params.id, user);
  const action = body?.action;
  const userIds = Array.isArray(body?.user_ids) ? body.user_ids : [];
  const reason = body?.reason || '';
  if (!['kick', 'ban', 'timeout'].includes(action)) throw invalid('action', 'INVALID_ACTION', 'Must be kick, ban, or timeout');
  if (!userIds.length || userIds.length > 100) throw invalid('user_ids', 'INVALID_COUNT', 'Must provide 1 to 100 user IDs');

  if (action === 'kick') need(g.perms, P.KICK_MEMBERS);
  if (action === 'ban') need(g.perms, P.BAN_MEMBERS);
  if (action === 'timeout') need(g.perms, P.MODERATE_MEMBERS);

  const durationSecs = Number(body?.duration_seconds) || 3600;
  const timeoutUntil = new Date(Date.now() + durationSecs * 1000).toISOString();
  const successful = [];

  for (const targetId of userIds) {
    if (targetId === user.id) continue;
    const target = memberRow(g.id, targetId);
    if (!target) continue;
    try {
      requireAbove(g.id, user.id, target.id);
      if (action === 'kick') {
        removeMember(g.id, target);
        audit(ctx, g.id, A.MEMBER_KICK, target.id, { reason });
      } else if (action === 'ban') {
        run('INSERT OR REPLACE INTO bans (guild_id, user_id, reason) VALUES (?, ?, ?)', g.id, target.id, reason);
        removeMember(g.id, target);
        audit(ctx, g.id, A.MEMBER_BAN_ADD, target.id, { reason });
      } else if (action === 'timeout') {
        run('UPDATE members SET communication_disabled_until = ? WHERE guild_id = ? AND user_id = ?', timeoutUntil, g.id, target.id);
        const out = memberObj(memberRow(g.id, target.id));
        sendToUsers(memberIds(g.id), 'GUILD_MEMBER_UPDATE', { guild_id: g.id, ...out });
        audit(ctx, g.id, A.MEMBER_UPDATE, target.id, { reason, changes: { communication_disabled_until: timeoutUntil } });
      }
      successful.push(targetId);
    } catch {
      // skip
    }
  }
  return { action, count: successful.length, user_ids: successful };
}

export default [
  ['GET', '/guilds/:id/members/search', searchMembers],
  ['POST', '/guilds/:id/members/bulk-action', bulkMemberAction],
  // Get Guild Member (docs; bot libraries fetch single members this way)
  ['GET', '/guilds/:id/members/:user_id', ({ params, user }) => {
    const m = memberRow(loadGuild(params.id, user).id, params.user_id === '@me' ? user.id : params.user_id);
    if (!m) throw notFound(10007, 'Member');
    return memberObj(m);
  }],
  ['PATCH', '/guilds/:id/members/@me', patchMe, { maxBody: 12 * 1024 * 1024 }],
  ['PATCH', '/guilds/:id/members/:user_id', patchMember],
  // Add / Remove Guild Member Role (docs, 204): the same checks as a roles PATCH
  ...['PUT', 'DELETE'].map(method => [method, '/guilds/:id/members/:user_id/roles/:role_id', ctx => {
    const current = all('SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?', ctx.params.id, ctx.params.user_id).map(r => r.role_id);
    ctx.body = { roles: method === 'PUT' ? [...new Set([...current, ctx.params.role_id])] : current.filter(id => id !== ctx.params.role_id) };
    patchMember(ctx);
    ctx.status = 204;
  }]),
  ['DELETE', '/guilds/:id/members/:user_id', kick],
];
