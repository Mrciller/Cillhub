import { snowflake } from '../snowflake.js';
import { get, all, run, isMember, memberIds, memberRow, userById, userObj } from '../db.js';
import { HttpError, str, invalid, snowflakeField, notFound, missingPermissions } from '../errors.js';
import { P, has, need } from '../permissions.js';
import { sendToUsers, guildParts } from '../gateway.js';
import { dataUri, saveAsset, removeAsset } from '../files.js';
import { audioDuration } from '../audio.js';
import { audit, A, diff } from '../audit.js';
import { voiceState, statesIn } from '../voice.js';
import { loadChannel } from './channels.js';
import { loadGuild } from './guilds.js';
import { canSeeCreators, needCreate, needEdit } from './emojis.js';

export const soundObj = (s, withUser = false) => ({
  name: s.name, sound_id: s.sound_id, volume: s.volume, emoji_id: s.emoji_id, emoji_name: s.emoji_name, guild_id: s.guild_id, available: true,
  ...(withUser && s.user_id && { user: userObj(userById(s.user_id)) }),
});

const listOf = guildId => all('SELECT * FROM soundboard_sounds WHERE guild_id = ? ORDER BY rowid', guildId);
guildParts.push(g => ({ soundboard_sounds: listOf(g.id).map(s => soundObj(s)) }));

function loadSound(g, id) {
  const s = get('SELECT * FROM soundboard_sounds WHERE sound_id = ? AND guild_id = ?', id, g.id);
  if (!s) throw notFound(10097, 'Sound');
  return s;
}

function fields(body, current) {
  const out = {};
  if (body.name !== undefined || !current) out.name = str(body, 'name', 2, 32);
  if (body.volume !== undefined) {
    const v = body.volume ?? 1;
    if (typeof v !== 'number' || v < 0 || v > 1) throw invalid('volume', 'NUMBER_TYPE_COERCE', 'Volume is between 0 and 1.');
    out.volume = v;
  }
  if (body.emoji_id !== undefined) out.emoji_id = body.emoji_id === null ? null : snowflakeField(body, 'emoji_id');
  if (body.emoji_name !== undefined) out.emoji_name = body.emoji_name === null ? null : str(body, 'emoji_name', 1, 32);
  return out;
}

const announce = (g, t, d) => sendToUsers(memberIds(g.id), t, d);

async function create(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  needCreate(g.perms);
  const body = ctx.body ?? {};
  const f = { volume: 1, emoji_id: null, emoji_name: null, ...fields(body) };
  const { bytes, type } = dataUri(body.sound, 'sound', ['audio/mpeg', 'audio/ogg'], 512 * 1024);
  const seconds = audioDuration(bytes, type);
  if (seconds == null || seconds > 5.2) throw invalid('sound', 'SOUND_INVALID', 'Sounds are readable MP3 or Ogg files of at most 5.2 seconds.');
  if (get('SELECT COUNT(*) AS n FROM soundboard_sounds WHERE guild_id = ?', g.id).n >= 48) throw new HttpError(400, 30045, 'Maximum number of soundboard sounds reached (48)');
  const id = snowflake();
  await saveAsset('soundboard-sounds', id, bytes);
  run('INSERT INTO soundboard_sounds (sound_id, guild_id, name, volume, emoji_id, emoji_name, user_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, g.id, f.name, f.volume, f.emoji_id, f.emoji_name, ctx.user.id);
  const s = loadSound(g, id);
  audit(ctx, g.id, A.SOUNDBOARD_SOUND_CREATE, id, { changes: diff({}, f) });
  announce(g, 'GUILD_SOUNDBOARD_SOUND_CREATE', soundObj(s, true));
  ctx.status = 201;
  return soundObj(s, true);
}

function update(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const s = loadSound(g, ctx.params.sound_id);
  needEdit(g.perms, s.user_id, ctx.user.id);
  const f = fields(ctx.body ?? {}, s);
  for (const [k, v] of Object.entries(f)) run(`UPDATE soundboard_sounds SET ${k} = ? WHERE sound_id = ?`, v, s.sound_id); // keys come from fields()
  const out = loadSound(g, s.sound_id);
  audit(ctx, g.id, A.SOUNDBOARD_SOUND_UPDATE, s.sound_id, { changes: diff(s, out, Object.keys(f)) });
  announce(g, 'GUILD_SOUNDBOARD_SOUND_UPDATE', soundObj(out, true));
  return soundObj(out, true);
}

function remove(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const s = loadSound(g, ctx.params.sound_id);
  needEdit(g.perms, s.user_id, ctx.user.id);
  run('DELETE FROM soundboard_sounds WHERE sound_id = ?', s.sound_id);
  removeAsset('soundboard-sounds', s.sound_id);
  audit(ctx, g.id, A.SOUNDBOARD_SOUND_DELETE, s.sound_id, { changes: diff({ name: s.name }, {}, ['name']) });
  announce(g, 'GUILD_SOUNDBOARD_SOUND_DELETE', { sound_id: s.sound_id, guild_id: g.id });
}

// plays a sound for everyone in your voice channel; clients play the file themselves on VOICE_CHANNEL_EFFECT_SEND
function play(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  const v = ch.guild_id && voiceState(ch.guild_id, ctx.user.id);
  if (!v || v.channel_id !== ch.id) throw new HttpError(400, 40032, 'Target user is not connected to voice.');
  need(ch.perms, P.SPEAK | P.USE_SOUNDBOARD);
  const m = memberRow(ch.guild_id, ctx.user.id);
  if (v.self_mute || v.self_deaf || v.suppress || m.mute || m.deaf) throw missingPermissions();
  const body = ctx.body ?? {};
  const sourceGuild = body.source_guild_id == null ? ch.guild_id : snowflakeField(body, 'source_guild_id');
  const s = get('SELECT * FROM soundboard_sounds WHERE sound_id = ? AND guild_id = ?', snowflakeField(body, 'sound_id'), sourceGuild);
  if (!s || !isMember(s.guild_id, ctx.user.id)) throw notFound(10097, 'Sound');
  if (s.guild_id !== ch.guild_id && !has(ch.perms, P.USE_EXTERNAL_SOUNDS)) throw missingPermissions();
  sendToUsers(statesIn(ch.id).map(x => x.user_id), 'VOICE_CHANNEL_EFFECT_SEND', {
    channel_id: ch.id, guild_id: ch.guild_id, user_id: ctx.user.id, sound_id: s.sound_id, sound_volume: s.volume,
    emoji: s.emoji_id || s.emoji_name ? { id: s.emoji_id, name: s.emoji_name } : null, animation_type: 1, animation_id: 0,
  });
}

export const packObj = p => ({
  id: p.id,
  guild_id: p.guild_id,
  name: p.name,
  description: p.description ?? '',
  icon_emoji: p.icon_emoji ?? null,
  sound_ids: JSON.parse(p.sound_ids ?? '[]'),
  created_at: p.created_at,
});

function listPacks(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  return all('SELECT * FROM soundboard_packs WHERE guild_id = ? ORDER BY rowid', g.id).map(packObj);
}

function createPack(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  needCreate(g.perms);
  const name = str(ctx.body ?? {}, 'name', 1, 64);
  const description = typeof ctx.body?.description === 'string' ? ctx.body.description.slice(0, 200) : '';
  const iconEmoji = typeof ctx.body?.icon_emoji === 'string' ? ctx.body.icon_emoji.slice(0, 32) : null;
  const soundIds = Array.isArray(ctx.body?.sound_ids) ? ctx.body.sound_ids.map(String) : [];
  const id = snowflake();
  const now = new Date().toISOString();
  run('INSERT INTO soundboard_packs (id, guild_id, name, description, icon_emoji, sound_ids, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, g.id, name, description, iconEmoji, JSON.stringify(soundIds), now);
  const p = get('SELECT * FROM soundboard_packs WHERE id = ?', id);
  announce(g, 'GUILD_SOUNDBOARD_PACK_CREATE', packObj(p));
  ctx.status = 201;
  return packObj(p);
}

function updatePack(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  needCreate(g.perms);
  const p = get('SELECT * FROM soundboard_packs WHERE id = ? AND guild_id = ?', ctx.params.pack_id, g.id);
  if (!p) throw notFound(10097, 'Soundboard Pack');
  const b = ctx.body ?? {};
  const name = b.name !== undefined ? str(b, 'name', 1, 64) : p.name;
  const description = b.description !== undefined ? String(b.description).slice(0, 200) : p.description;
  const iconEmoji = b.icon_emoji !== undefined ? (b.icon_emoji ? String(b.icon_emoji).slice(0, 32) : null) : p.icon_emoji;
  const soundIds = Array.isArray(b.sound_ids) ? b.sound_ids.map(String) : JSON.parse(p.sound_ids);
  run('UPDATE soundboard_packs SET name = ?, description = ?, icon_emoji = ?, sound_ids = ? WHERE id = ?',
    name, description, iconEmoji, JSON.stringify(soundIds), p.id);
  const out = get('SELECT * FROM soundboard_packs WHERE id = ?', p.id);
  announce(g, 'GUILD_SOUNDBOARD_PACK_UPDATE', packObj(out));
  return packObj(out);
}

function removePack(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  needCreate(g.perms);
  const p = get('SELECT * FROM soundboard_packs WHERE id = ? AND guild_id = ?', ctx.params.pack_id, g.id);
  if (!p) throw notFound(10097, 'Soundboard Pack');
  run('DELETE FROM soundboard_packs WHERE id = ?', p.id);
  announce(g, 'GUILD_SOUNDBOARD_PACK_DELETE', { id: p.id, guild_id: g.id });
}

export default [
  ['GET', '/soundboard-default-sounds', () => []],
  ['GET', '/guilds/:id/soundboard-sounds', ({ params, user }) => {
    const g = loadGuild(params.id, user);
    return { items: listOf(g.id).map(s => soundObj(s, canSeeCreators(g.perms))) };
  }],
  ['GET', '/guilds/:id/soundboard-sounds/:sound_id', ({ params, user }) => {
    const g = loadGuild(params.id, user);
    return soundObj(loadSound(g, params.sound_id), canSeeCreators(g.perms));
  }],
  ['POST', '/guilds/:id/soundboard-sounds', create],
  ['PATCH', '/guilds/:id/soundboard-sounds/:sound_id', update],
  ['DELETE', '/guilds/:id/soundboard-sounds/:sound_id', remove],
  ['GET', '/guilds/:id/soundboard-packs', listPacks],
  ['POST', '/guilds/:id/soundboard-packs', createPack],
  ['PUT', '/guilds/:id/soundboard-packs/:pack_id', updatePack],
  ['DELETE', '/guilds/:id/soundboard-packs/:pack_id', removePack],
  ['POST', '/channels/:id/send-soundboard-sound', play],
];
