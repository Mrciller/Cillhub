import { snowflake } from '../snowflake.js';
import { get, all, run, tx, memberIds, roleObj, rolesOf, channelObj } from '../db.js';
import { HttpError, str, int, bool, list, invalid, snowflakeField, notFound } from '../errors.js';
import { dataUri, saveImage, removeImage } from '../files.js';
import { P, need, parseBits, requireRoleBelow } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { recheck } from '../voice.js';
import { audit, A, diff } from '../audit.js';
import { loadGuild } from './guilds.js';
import { threadListSync } from './threads.js';

const AUDITED = ['name', 'color', 'hoist', 'mentionable', 'permissions', 'colors', 'icon', 'unicode_emoji'];
// the holographic style: sending tertiary_color forces these three values (permissions.mdx, Role Colors Object)
const HOLOGRAPHIC = { color: 11127295, secondary_color: 16759788, tertiary_color: 16761760 };
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]\uFE0F?\u20E3)[\p{Emoji}\p{Emoji_Modifier}\p{Emoji_Component}\u200D\uFE0F]*$/u;

function loadRole(guildId, roleId) {
  const r = get('SELECT * FROM roles WHERE id = ? AND guild_id = ?', roleId, guildId);
  if (!r) throw notFound(10011, 'Role');
  return r;
}

const roleEvent = (guildId, t, d) => sendToUsers(memberIds(guildId), t, { guild_id: guildId, ...d });
const positions = guildId => new Map(all('SELECT id, position FROM roles WHERE guild_id = ?', guildId).map(r => [r.id, r.position]));
function announceMoves(guildId, before) {
  for (const r of all('SELECT * FROM roles WHERE guild_id = ?', guildId)) {
    if (before.has(r.id) && before.get(r.id) !== r.position) roleEvent(guildId, 'GUILD_ROLE_UPDATE', { role: roleObj(r) });
  }
}

// the validated fields of a create or update body; permissions only as far as the actor holds them
async function fields(body, g, current, roleId = current?.id) {
  const out = {};
  if (body?.name !== undefined && current?.id !== g.id) out.name = str(body, 'name', 1, 100);
  if (body?.color !== undefined) out.color = int(body, 'color', 0, 0xffffff);
  if (body?.colors != null) {
    const c = body.colors;
    if (typeof c !== 'object' || Array.isArray(c)) throw invalid('colors', 'MODEL_TYPE_CONVERT', 'Must be a role colors object.');
    if (c.tertiary_color != null) Object.assign(out, HOLOGRAPHIC);
    else {
      if (c.primary_color !== undefined) out.color = int(c, 'primary_color', 0, 0xffffff);
      out.secondary_color = c.secondary_color == null ? null : int(c, 'secondary_color', 0, 0xffffff);
      out.tertiary_color = null;
    }
  }
  if (body?.hoist !== undefined) out.hoist = Number(bool(body, 'hoist'));
  if (body?.mentionable !== undefined) out.mentionable = Number(bool(body, 'mentionable'));
  if (body?.permissions !== undefined) {
    const bits = parseBits(body.permissions, 'permissions');
    need(g.perms, bits ^ BigInt(current?.permissions ?? 0));
    out.permissions = String(bits);
  }
  // icon (PNG/JPEG/WebP up to 256 KiB) and unicode_emoji are alternatives: setting one clears the other
  if (body?.icon != null && body?.unicode_emoji != null) throw invalid('unicode_emoji', 'BASE_TYPE_BAD_VALUE', 'A role has an icon or a unicode_emoji, not both.');
  if (body?.unicode_emoji !== undefined) {
    const e = body.unicode_emoji;
    if (e !== null && (typeof e !== 'string' || e.length > 32 || !EMOJI.test(e))) throw invalid('unicode_emoji', 'BASE_TYPE_BAD_VALUE', 'Must be one Unicode emoji.');
    out.unicode_emoji = e || null;
    if (out.unicode_emoji) out.icon = null;
  }
  if (body?.icon !== undefined) {
    if (body.icon !== null) dataUri(body.icon, 'icon', ['image/png', 'image/jpeg', 'image/webp'], 256 * 1024);
    out.icon = await saveImage(body.icon, 'icon', 'role-icons', roleId);
    if (out.icon) out.unicode_emoji = null;
  }
  return out;
}

async function createRole(ctx) {
  const { params, body, user } = ctx;
  const g = loadGuild(params.id, user, P.MANAGE_ROLES);
  const everyone = loadRole(g.id, g.id);
  const id = snowflake();
  const f = { name: 'new role', color: 0, hoist: 0, mentionable: 0, permissions: everyone.permissions, ...await fields(body, g, null, id) };
  const before = positions(g.id);
  tx(() => {
    run('UPDATE roles SET position = position + 1 WHERE guild_id = ? AND position >= 1', g.id);
    run(`INSERT INTO roles (id, guild_id, name, color, hoist, mentionable, permissions, position, secondary_color, tertiary_color, icon, unicode_emoji)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`, id, g.id, f.name, f.color, f.hoist, f.mentionable, f.permissions,
    f.secondary_color ?? null, f.tertiary_color ?? null, f.icon ?? null, f.unicode_emoji ?? null);
  });
  const role = roleObj(loadRole(g.id, id));
  roleEvent(g.id, 'GUILD_ROLE_CREATE', { role });
  announceMoves(g.id, before);
  audit(ctx, g.id, A.ROLE_CREATE, id, { changes: diff({}, role, AUDITED) });
  return role;
}

async function updateRole(ctx) {
  const { params, body, user } = ctx;
  const g = loadGuild(params.id, user, P.MANAGE_ROLES);
  const r = loadRole(g.id, params.role_id);
  requireRoleBelow(g.id, user.id, r.position);
  const f = await fields(body, g, r);
  for (const [k, v] of Object.entries(f)) run(`UPDATE roles SET ${k} = ? WHERE id = ?`, v, r.id); // keys come from fields(), not the client
  if ('icon' in f && f.icon !== r.icon) removeImage('role-icons', r.id, r.icon);
  const role = roleObj(loadRole(g.id, r.id));
  roleEvent(g.id, 'GUILD_ROLE_UPDATE', { role });
  audit(ctx, g.id, A.ROLE_UPDATE, r.id, { changes: diff(roleObj(r), role, AUDITED) });
  if (f.permissions !== undefined) {
    recheck(g.id);
    threadListSync(g.id, memberIds(g.id));
  }
  return role;
}

// moves the listed roles to their new places and renumbers the rest 1..n, keeping their order
function reorder({ params, body, user }) {
  const g = loadGuild(params.id, user, P.MANAGE_ROLES);
  const moves = list(body).map(item => ({ role: loadRole(g.id, snowflakeField(item, 'id')), position: int(item, 'position', 1, 1000) }));
  if (moves.some(m => m.role.id === g.id)) throw new HttpError(400, 50028, 'Invalid Role');
  const order = all('SELECT * FROM roles WHERE guild_id = ? AND id != ? ORDER BY position', g.id, g.id);
  for (const m of moves.sort((a, b) => a.position - b.position)) {
    order.splice(order.findIndex(r => r.id === m.role.id), 1);
    order.splice(Math.min(m.position - 1, order.length), 0, m.role);
  }
  const changed = order.map((r, i) => ({ r, position: i + 1 })).filter(c => c.position !== c.r.position);
  for (const c of changed) {
    requireRoleBelow(g.id, user.id, c.r.position);
    requireRoleBelow(g.id, user.id, c.position);
  }
  const before = positions(g.id);
  tx(() => changed.forEach(c => run('UPDATE roles SET position = ? WHERE id = ?', c.position, c.r.id)));
  announceMoves(g.id, before);
  return rolesOf(g.id);
}

function deleteRole(ctx) {
  const { params, user } = ctx;
  const g = loadGuild(params.id, user, P.MANAGE_ROLES);
  const r = loadRole(g.id, params.role_id);
  if (r.id === g.id || r.managed) throw new HttpError(400, 50028, 'Invalid Role');
  requireRoleBelow(g.id, user.id, r.position);
  const channels = all('SELECT channel_id FROM overwrites WHERE target_id = ?', r.id);
  const before = positions(g.id);
  tx(() => {
    run('DELETE FROM overwrites WHERE target_id = ?', r.id);
    run('DELETE FROM roles WHERE id = ?', r.id);
    run('UPDATE roles SET position = position - 1 WHERE guild_id = ? AND position > ?', g.id, r.position);
  });
  removeImage('role-icons', r.id, r.icon);
  roleEvent(g.id, 'GUILD_ROLE_DELETE', { role_id: r.id });
  audit(ctx, g.id, A.ROLE_DELETE, r.id, { changes: diff(roleObj(r), {}, AUDITED) });
  announceMoves(g.id, before);
  const ids = memberIds(g.id);
  for (const c of channels) sendToUsers(ids, 'CHANNEL_UPDATE', channelObj(get('SELECT * FROM channels WHERE id = ?', c.channel_id)));
  recheck(g.id);
}

export default [
  ['GET', '/guilds/:id/roles', ({ params, user }) => rolesOf(loadGuild(params.id, user).id)],
  ['POST', '/guilds/:id/roles', createRole, { maxBody: 1024 * 1024 }],
  ['PATCH', '/guilds/:id/roles', reorder],
  ['PATCH', '/guilds/:id/roles/:role_id', updateRole],
  ['DELETE', '/guilds/:id/roles/:role_id', deleteRole],
];
