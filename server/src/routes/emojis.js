import { snowflake } from '../snowflake.js';
import { get, all, run, isMember, memberIds, emojiObj } from '../db.js';
import { HttpError, invalid, notFound, missingPermissions, snowflakes } from '../errors.js';
import { P, has, ownerOf } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { dataUri, saveAsset, removeAsset } from '../files.js';
import { audit, A, diff } from '../audit.js';
import { loadGuild } from './guilds.js';

const IMAGES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const NAME = /^[A-Za-z0-9_]{2,32}$/;

const hasRole = (guildId, userId, rolesJson) => ownerOf(guildId) === userId || !!get(
  'SELECT 1 FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id IN (SELECT value FROM json_each(?))', guildId, userId, rolesJson);

// the emoji row if this user may use it in ch: a guild they are in, USE_EXTERNAL_EMOJIS outside its guild, its role lock
export function usableEmoji(id, ch, userId, perms) {
  const e = get('SELECT * FROM emojis WHERE id = ?', id);
  if (!e || !isMember(e.guild_id, userId)) return null;
  if (e.guild_id !== ch.guild_id && !has(perms, P.USE_EXTERNAL_EMOJIS)) return null;
  if (e.roles !== '[]' && !hasRole(e.guild_id, userId, e.roles)) return null;
  return e;
}

// expressions: CREATE_GUILD_EXPRESSIONS adds and edits your own, MANAGE_GUILD_EXPRESSIONS everything
export const canSeeCreators = perms => has(perms, P.CREATE_GUILD_EXPRESSIONS) || has(perms, P.MANAGE_GUILD_EXPRESSIONS);
export function needCreate(perms) {
  if (!canSeeCreators(perms)) throw missingPermissions();
}
export function needEdit(perms, creatorId, userId) {
  if (has(perms, P.MANAGE_GUILD_EXPRESSIONS) || (creatorId === userId && has(perms, P.CREATE_GUILD_EXPRESSIONS))) return;
  throw missingPermissions();
}

function nameField(body) {
  if (typeof body?.name !== 'string' || !NAME.test(body.name)) throw invalid('name', 'BASE_TYPE_BAD_LENGTH', 'Name must be 2-32 characters of A-Z, a-z, 0-9 and _.');
  return body.name;
}

function rolesField(body, guildId) {
  if (body.roles == null) return '[]';
  const ids = snowflakes(body, 'roles', 250);
  if (ids.some(id => !get('SELECT 1 FROM roles WHERE id = ? AND guild_id = ?', id, guildId))) throw notFound(10011, 'Role');
  return JSON.stringify(ids);
}

const listOf = guildId => all('SELECT * FROM emojis WHERE guild_id = ? ORDER BY rowid', guildId);
const announce = guildId => sendToUsers(memberIds(guildId), 'GUILD_EMOJIS_UPDATE', { guild_id: guildId, emojis: listOf(guildId).map(e => emojiObj(e)) });

function loadEmoji(g, id) {
  const e = get('SELECT * FROM emojis WHERE id = ? AND guild_id = ?', id, g.id);
  if (!e) throw notFound(10014, 'Emoji');
  return e;
}

async function create(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  needCreate(g.perms);
  const body = ctx.body ?? {};
  const name = nameField(body);
  const roles = rolesField(body, g.id);
  const { bytes, type } = dataUri(body.image, 'image', IMAGES, 256 * 1024);
  const animated = type === 'image/gif'; // a GIF upload is an animated emoji (reference behaviour)
  if (get('SELECT COUNT(*) AS n FROM emojis WHERE guild_id = ? AND animated = ?', g.id, Number(animated)).n >= 100) {
    throw animated ? new HttpError(400, 30018, 'Maximum number of animated emojis reached (100)') : new HttpError(400, 30008, 'Maximum number of emojis reached (100)');
  }
  const id = snowflake();
  await saveAsset('emojis', id, bytes);
  run('INSERT INTO emojis (id, guild_id, name, animated, roles, user_id) VALUES (?, ?, ?, ?, ?, ?)', id, g.id, name, Number(animated), roles, ctx.user.id);
  const out = emojiObj(loadEmoji(g, id), true);
  audit(ctx, g.id, A.EMOJI_CREATE, id, { changes: diff({}, { name }) });
  announce(g.id);
  ctx.status = 201;
  return out;
}

function update(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const e = loadEmoji(g, ctx.params.emoji_id);
  needEdit(g.perms, e.user_id, ctx.user.id);
  const body = ctx.body ?? {};
  const name = body.name === undefined ? e.name : nameField(body);
  const roles = body.roles === undefined ? e.roles : rolesField(body, g.id);
  run('UPDATE emojis SET name = ?, roles = ? WHERE id = ?', name, roles, e.id);
  audit(ctx, g.id, A.EMOJI_UPDATE, e.id, { changes: diff({ name: e.name }, { name }) });
  announce(g.id);
  return emojiObj(loadEmoji(g, e.id), true);
}

function remove(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const e = loadEmoji(g, ctx.params.emoji_id);
  needEdit(g.perms, e.user_id, ctx.user.id);
  run('DELETE FROM emojis WHERE id = ?', e.id);
  removeAsset('emojis', e.id);
  audit(ctx, g.id, A.EMOJI_DELETE, e.id, { changes: diff({ name: e.name }, {}, ['name']) });
  announce(g.id);
}

export default [
  ['GET', '/guilds/:id/emojis', ({ params, user }) => {
    const g = loadGuild(params.id, user);
    return listOf(g.id).map(e => emojiObj(e, canSeeCreators(g.perms)));
  }],
  ['GET', '/guilds/:id/emojis/:emoji_id', ({ params, user }) => {
    const g = loadGuild(params.id, user);
    return emojiObj(loadEmoji(g, params.emoji_id), canSeeCreators(g.perms));
  }],
  ['POST', '/guilds/:id/emojis', create],
  ['PATCH', '/guilds/:id/emojis/:emoji_id', update],
  ['DELETE', '/guilds/:id/emojis/:emoji_id', remove],
];
