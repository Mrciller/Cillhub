import { snowflake } from '../snowflake.js';
import { get, all, run, isMember, memberIds, stickerObj } from '../db.js';
import { HttpError, str, invalid, notFound } from '../errors.js';
import { P, has } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { sniff, imageSize, saveAsset, removeAsset } from '../files.js';
import { audit, A, diff } from '../audit.js';
import { loadGuild } from './guilds.js';
import { canSeeCreators, needCreate, needEdit } from './emojis.js';

const MAX = 512 * 1024;
// sticker format types; WebP has none in the docs and is listed as PNG (the CDN serves the stored bytes either way)
const FORMAT = { 'image/png': 1, 'image/webp': 1, 'image/gif': 4 };
const isApng = buf => buf.indexOf('acTL') > 0 && buf.indexOf('acTL') < buf.indexOf('IDAT');

// the sticker row if usable in ch: this guild's, or another guild's the user is in with USE_EXTERNAL_STICKERS
export function usableSticker(id, ch, userId, perms, webhook) {
  const s = get('SELECT * FROM stickers WHERE id = ?', id);
  if (!s || s.guild_id === ch.guild_id) return s;
  return !webhook && isMember(s.guild_id, userId) && has(perms, P.USE_EXTERNAL_STICKERS) ? s : null;
}

const listOf = guildId => all('SELECT * FROM stickers WHERE guild_id = ? ORDER BY rowid', guildId);
const announce = guildId => sendToUsers(memberIds(guildId), 'GUILD_STICKERS_UPDATE', { guild_id: guildId, stickers: listOf(guildId).map(s => stickerObj(s)) });

function loadSticker(g, id) {
  const s = get('SELECT * FROM stickers WHERE id = ? AND guild_id = ?', id, g.id);
  if (!s) throw notFound(10060, 'Sticker');
  return s;
}

function fields(body, current) {
  const out = {};
  if (body.name !== undefined || !current) out.name = str(body, 'name', 2, 30);
  if (body.description !== undefined) {
    const d = body.description === null ? '' : str(body, 'description', 0, 100);
    if (d.length === 1) throw invalid('description', 'BASE_TYPE_BAD_LENGTH', 'Must be empty or 2-100 in length.');
    out.description = d || null;
  }
  if (body.tags !== undefined || !current) out.tags = str(body, 'tags', 1, 200);
  return out;
}

async function create(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  needCreate(g.perms);
  if (!ctx.form) throw invalid('file', 'BASE_TYPE_REQUIRED', 'Send multipart/form-data with a file.');
  const form = await ctx.form({ maxFile: MAX });
  const body = Object.fromEntries([...form].filter(([, v]) => typeof v === 'string'));
  const f = { description: null, ...fields(body) };
  const file = form.get('file');
  if (!file || typeof file === 'string') throw invalid('file', 'BASE_TYPE_REQUIRED', 'A sticker file is required.');
  if (file.size > MAX) throw invalid('file', 'BINARY_TYPE_MAX_SIZE', 'Stickers are at most 512 KiB.');
  const bytes = await file.bytes();
  const type = sniff(bytes);
  if (!(type in FORMAT)) throw invalid('file', 'STICKER_INVALID', 'Stickers are PNG, APNG, GIF or WebP.');
  const size = imageSize(bytes, type);
  if (!size || size.width > 320 || size.height > 320) throw invalid('file', 'STICKER_INVALID', 'Stickers are at most 320x320.');
  if (get('SELECT COUNT(*) AS n FROM stickers WHERE guild_id = ?', g.id).n >= 60) throw new HttpError(400, 30039, 'Maximum number of stickers reached (60)');
  const id = snowflake();
  await saveAsset('stickers', id, bytes);
  const format = type === 'image/png' && isApng(bytes) ? 2 : FORMAT[type];
  run('INSERT INTO stickers (id, guild_id, name, description, tags, format_type, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, g.id, f.name, f.description, f.tags, format, ctx.user.id);
  audit(ctx, g.id, A.STICKER_CREATE, id, { changes: diff({}, f) });
  announce(g.id);
  ctx.status = 201;
  return stickerObj(loadSticker(g, id), true);
}

function update(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const s = loadSticker(g, ctx.params.sticker_id);
  needEdit(g.perms, s.user_id, ctx.user.id);
  const f = fields(ctx.body ?? {}, s);
  for (const [k, v] of Object.entries(f)) run(`UPDATE stickers SET ${k} = ? WHERE id = ?`, v, s.id); // keys come from fields()
  audit(ctx, g.id, A.STICKER_UPDATE, s.id, { changes: diff(s, f) });
  announce(g.id);
  return stickerObj(loadSticker(g, s.id), true);
}

function remove(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const s = loadSticker(g, ctx.params.sticker_id);
  needEdit(g.perms, s.user_id, ctx.user.id);
  run('DELETE FROM stickers WHERE id = ?', s.id);
  removeAsset('stickers', s.id);
  audit(ctx, g.id, A.STICKER_DELETE, s.id, { changes: diff({ name: s.name }, {}, ['name']) });
  announce(g.id);
}

function getSticker({ params }) {
  const s = get('SELECT * FROM stickers WHERE id = ?', params.sticker_id);
  if (!s) throw notFound(10060, 'Sticker');
  return stickerObj(s);
}

export default [
  ['GET', '/sticker-packs', () => ({ sticker_packs: [] })],
  ['GET', '/stickers/:sticker_id', getSticker],
  ['GET', '/guilds/:id/stickers', ({ params, user }) => {
    const g = loadGuild(params.id, user);
    return listOf(g.id).map(s => stickerObj(s, canSeeCreators(g.perms)));
  }],
  ['GET', '/guilds/:id/stickers/:sticker_id', ({ params, user }) => {
    const g = loadGuild(params.id, user);
    return stickerObj(loadSticker(g, params.sticker_id), canSeeCreators(g.perms));
  }],
  ['POST', '/guilds/:id/stickers', create, { multipart: true }],
  ['PATCH', '/guilds/:id/stickers/:sticker_id', update],
  ['DELETE', '/guilds/:id/stickers/:sticker_id', remove],
];
