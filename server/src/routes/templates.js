// Server templates (user docs guild-template.mdx) and the export/import of the same snapshot as a JSON file (v5)
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snowflake } from '../snowflake.js';
import { DATA_DIR, get, all, run, tx, json, userById, userObj, guildObj, guildChannels } from '../db.js';
import { HttpError, str, int, invalid, notFound } from '../errors.js';
import { P, parseBits, DEFAULT_PERMISSIONS } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { sniff, dataUri, saveAsset, saveImage } from '../files.js';
import { forumFields } from './forums.js';
import { safeFetch } from '../ssrf.js';
import { durationField } from './threads.js';
import { loadGuild, guildCreate, guildCreatedHooks } from './guilds.js';

const CREATABLE = [0, 2, 4, 5, 13, 15];
const AFK_TIMEOUTS = [60, 300, 900, 1800, 3600];
const EMOJI_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

// --- snapshot ------------------------------------------------------------------------------------------------------
// the docs' serialized_source_guild: ids are small integers (@everyone is 0), no member overwrites, no managed roles.
// Cillhub adds forum `flags` per channel and `emojis` ({name, animated, roles, image: data URI}).
export function serialize(g) {
  const roles = all('SELECT * FROM roles WHERE guild_id = ? AND managed = 0 ORDER BY position', g.id);
  const rid = new Map(roles.map((r, i) => [r.id, i]));
  const chans = guildChannels(g.id);
  const cid = new Map(chans.map((c, i) => [c.id, i + 1]));
  const emojiImage = e => {
    const bytes = readFileSync(join(DATA_DIR, 'emojis', e.id));
    return `data:${sniff(bytes)};base64,${bytes.toString('base64')}`;
  };
  return {
    name: g.name, description: g.description, region: null, verification_level: g.verification_level, default_message_notifications: 0,
    explicit_content_filter: 0, preferred_locale: 'en-US', afk_channel_id: cid.get(g.afk_channel_id) ?? null, afk_timeout: g.afk_timeout,
    system_channel_id: cid.get(g.system_channel_id) ?? null, system_channel_flags: 0,
    roles: roles.map(r => ({
      id: rid.get(r.id), name: r.name, permissions: r.permissions, color: r.color, hoist: !!r.hoist, mentionable: !!r.mentionable, icon: null, unicode_emoji: null,
    })),
    channels: chans.map(c => ({
      id: cid.get(c.id), type: c.type, name: c.name, position: c.position, topic: c.topic ?? null, bitrate: 64000, user_limit: c.user_limit,
      nsfw: !!c.nsfw, rate_limit_per_user: c.rate_limit_per_user, parent_id: cid.get(c.parent_id) ?? null,
      default_auto_archive_duration: c.default_auto_archive_duration ?? null,
      permission_overwrites: all('SELECT * FROM overwrites WHERE channel_id = ? AND type = 0', c.id)
        .filter(o => rid.has(o.target_id)).map(o => ({ id: rid.get(o.target_id), type: 0, allow: o.allow, deny: o.deny })),
      available_tags: c.type === 15 ? json(c.available_tags, []).map(t => ({ name: t.name, moderated: t.moderated, emoji_id: null, emoji_name: t.emoji_name })) : null,
      template: '', default_reaction_emoji: c.type === 15 && json(c.default_reaction_emoji)?.emoji_name ? { emoji_id: null, emoji_name: json(c.default_reaction_emoji).emoji_name } : null,
      default_thread_rate_limit_per_user: c.type === 15 ? c.default_thread_rate_limit_per_user : null,
      default_sort_order: c.type === 15 ? c.default_sort_order : null, default_forum_layout: c.type === 15 ? c.default_forum_layout : null,
      icon_emoji: null, theme_color: null, flags: c.type === 15 ? c.flags : 0,
    })),
    emojis: all('SELECT * FROM emojis WHERE guild_id = ? ORDER BY rowid', g.id).map(e => ({
      name: e.name, animated: !!e.animated, roles: json(e.roles, []).filter(id => rid.has(id)).map(id => rid.get(id)), image: emojiImage(e),
    })),
  };
}

// --- a new guild from a snapshot (templates and imported files alike, so everything is validated) -------------------
const list = (v, field, max) => {
  if (!Array.isArray(v) || v.length > max) throw invalid(field, 'BASE_TYPE_MAX_LENGTH', `Must be a list of at most ${max}.`);
  return v;
};
const ref = (map, v, field) => {
  if (v == null) return null;
  if (!map.has(v)) throw invalid(field, 'BASE_TYPE_INVALID', 'Unknown id in the snapshot.');
  return map.get(v);
};

export async function createFromSnapshot(s, name, owner, icon) {
  if (typeof s !== 'object' || s === null) throw invalid('serialized_source_guild', 'MODEL_TYPE_CONVERT', 'Must be a guild snapshot.');
  const id = snowflake();
  const roles = list(s.roles ?? [], 'roles', 250).map((r, i) => ({
    key: r?.id, id: i === 0 ? id : snowflake(), name: i === 0 ? '@everyone' : str(r, 'name', 1, 100),
    permissions: String(parseBits(r?.permissions ?? (i === 0 ? DEFAULT_PERMISSIONS : '0'), `roles.${i}.permissions`)),
    color: r?.color == null ? 0 : int(r, 'color', 0, 0xffffff), hoist: Number(!!r?.hoist), mentionable: Number(!!r?.mentionable),
  }));
  if (!roles.length) roles.push({ key: 0, id, name: '@everyone', permissions: DEFAULT_PERMISSIONS, color: 0, hoist: 0, mentionable: 0 });
  const rid = new Map(roles.map(r => [r.key, r.id]));
  const chans = list(s.channels ?? [], 'channels', 500).map((c, i) => {
    if (!CREATABLE.includes(c?.type)) throw invalid(`channels.${i}.type`, 'BASE_TYPE_CHOICES', 'Unsupported channel type.');
    return { key: c.id, id: snowflake(), c };
  });
  const cid = new Map(chans.map(x => [x.key, x.id]));
  const rows = chans.map(({ id: chId, c }, i) => {
    const p = `channels.${i}`;
    const text = [0, 5, 15].includes(c.type);
    const parent = ref(cid, c.parent_id, `${p}.parent_id`);
    if (parent && (c.type === 4 || chans.find(x => x.id === parent).c.type !== 4)) throw invalid(`${p}.parent_id`, 'CHANNEL_PARENT_INVALID', 'Parent must be a category.');
    const row = {
      id: chId, type: c.type, name: text ? str(c, 'name', 1, 100).toLowerCase().replace(/\s+/g, '-') : str(c, 'name', 1, 100),
      position: c.position == null ? 0 : int(c, 'position', 0, 10000), parent_id: parent, nsfw: Number(!!c.nsfw),
      topic: text && c.topic != null ? str(c, 'topic', 0, c.type === 15 ? 4096 : 1024) || null : null,
      user_limit: (c.type === 2 || c.type === 13) && c.user_limit != null ? int(c, 'user_limit', 0, c.type === 13 ? 10000 : 99) : 0,
      rate_limit_per_user: c.type !== 4 && c.rate_limit_per_user != null ? int(c, 'rate_limit_per_user', 0, 21600) : 0,
      default_auto_archive_duration: text && c.default_auto_archive_duration != null ? durationField(c, 'default_auto_archive_duration') : null,
    };
    if (c.type === 15) {
      const pick = Object.fromEntries(['available_tags', 'default_reaction_emoji', 'default_sort_order', 'default_forum_layout', 'default_thread_rate_limit_per_user', 'flags']
        .filter(k => c[k] != null).map(k => [k, c[k]]));
      Object.assign(row, forumFields(pick));
    }
    row.overwrites = list(c.permission_overwrites ?? [], `${p}.permission_overwrites`, 100).map((o, j) => {
      const q = `${p}.permission_overwrites.${j}`;
      if (o?.id == null) throw invalid(`${q}.id`, 'BASE_TYPE_REQUIRED', 'Role overwrites only.');
      return { target: ref(rid, o.id, `${q}.id`), allow: String(parseBits(o.allow ?? '0', `${q}.allow`)), deny: String(parseBits(o.deny ?? '0', `${q}.deny`)) };
    });
    return row;
  });
  const emojis = list(s.emojis ?? [], 'emojis', 200).map((e, i) => {
    if (typeof e?.name !== 'string' || !/^[A-Za-z0-9_]{2,32}$/.test(e.name)) throw invalid(`emojis.${i}.name`, 'BASE_TYPE_BAD_LENGTH', 'Emoji names are 2-32 of A-Z, a-z, 0-9 and _.');
    const { bytes, type } = dataUri(e.image, `emojis.${i}.image`, EMOJI_TYPES, 256 * 1024);
    return { id: snowflake(), name: e.name, animated: Number(type === 'image/gif'), bytes, roles: JSON.stringify(list(e.roles ?? [], `emojis.${i}.roles`, 250).map(r => ref(rid, r, `emojis.${i}.roles`))) };
  });
  const afk = ref(cid, s.afk_channel_id, 'afk_channel_id');
  const system = ref(cid, s.system_channel_id, 'system_channel_id');
  const verification = s.verification_level == null ? 0 : int(s, 'verification_level', 0, 2);
  const afkTimeout = AFK_TIMEOUTS.includes(s.afk_timeout) ? s.afk_timeout : 300;
  const description = s.description == null ? null : str(s, 'description', 0, 300) || null;
  const iconHash = icon == null ? null : await saveImage(icon, 'icon', 'icons', id);
  for (const e of emojis) await saveAsset('emojis', e.id, e.bytes);
  const typeOf = chId => rows.find(r => r.id === chId)?.type;
  tx(() => {
    run(`INSERT INTO guilds (id, name, owner_id, icon, system_channel_id, afk_channel_id, afk_timeout, verification_level, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, name, owner.id, iconHash, typeOf(system) === 0 ? system : null, typeOf(afk) === 2 ? afk : null,
    afkTimeout, verification, description);
    roles.forEach((r, i) => run('INSERT INTO roles (id, guild_id, name, position, permissions, color, hoist, mentionable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      r.id, id, r.name, i, r.permissions, r.color, r.hoist, r.mentionable));
    run('INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', id, owner.id, new Date().toISOString());
    for (const r of rows) {
      const cols = Object.keys(r).filter(k => k !== 'overwrites'); // keys are fixed above
      run(`INSERT INTO channels (guild_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`, id, ...cols.map(k => r[k]));
      for (const o of r.overwrites) run('INSERT OR REPLACE INTO overwrites (channel_id, target_id, type, allow, deny) VALUES (?, ?, 0, ?, ?)', r.id, o.target, o.allow, o.deny);
    }
    for (const e of emojis) run('INSERT INTO emojis (id, guild_id, name, animated, roles, user_id) VALUES (?, ?, ?, ?, ?, ?)', e.id, id, e.name, e.animated, e.roles, owner.id);
  });
  const g = get('SELECT * FROM guilds WHERE id = ?', id);
  sendToUsers([owner.id], 'GUILD_CREATE', guildCreate(g, owner.id));
  guildCreatedHooks.forEach(f => f(g));
  return guildObj(g, true);
}

// --- templates -----------------------------------------------------------------------------------------------------
function templateObj(t, withDirty = false) {
  const g = withDirty && get('SELECT * FROM guilds WHERE id = ?', t.guild_id);
  return {
    code: t.code, name: t.name, description: t.description, usage_count: t.usage_count, creator_id: t.creator_id,
    creator: userObj(userById(t.creator_id)), created_at: t.created_at, updated_at: t.updated_at, source_guild_id: t.guild_id,
    serialized_source_guild: JSON.parse(t.snapshot), is_dirty: g ? JSON.stringify(serialize(g)) !== t.snapshot : null,
  };
}
const byCode = code => {
  const t = get('SELECT * FROM guild_templates WHERE code = ?', code);
  if (!t) throw notFound(10057, 'Guild Template');
  return t;
};
const guildTemplate = (g, code) => {
  const t = get('SELECT * FROM guild_templates WHERE code = ? AND guild_id = ?', code, g.id);
  if (!t) throw notFound(10057, 'Guild Template');
  return t;
};
const meta = (body, cur = {}) => ({
  name: body.name === undefined && cur.name ? cur.name : str(body, 'name', 1, 100),
  description: body.description === undefined ? cur.description ?? null : body.description === null ? null : str(body, 'description', 0, 120) || null,
});
const CODE = () => randomBytes(9).toString('base64url'); // 12 characters

function createTemplate(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const m = meta(ctx.body ?? {});
  if (get('SELECT 1 FROM guild_templates WHERE guild_id = ?', g.id)) throw new HttpError(400, 30031, 'A server template already exists for this guild');
  const now = new Date().toISOString();
  const code = CODE();
  run('INSERT INTO guild_templates (code, guild_id, name, description, creator_id, created_at, updated_at, snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    code, g.id, m.name, m.description, ctx.user.id, now, now, JSON.stringify(serialize(g)));
  ctx.status = 201;
  return templateObj(byCode(code), true);
}

function syncTemplate(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const t = guildTemplate(g, ctx.params.code);
  run('UPDATE guild_templates SET snapshot = ?, updated_at = ? WHERE code = ?', JSON.stringify(serialize(g)), new Date().toISOString(), t.code);
  return templateObj(byCode(t.code), true);
}

function patchTemplate(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const t = guildTemplate(g, ctx.params.code);
  const m = meta(ctx.body ?? {}, t);
  run('UPDATE guild_templates SET name = ?, description = ? WHERE code = ?', m.name, m.description, t.code);
  return templateObj(byCode(t.code), true);
}

function deleteTemplate(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const out = templateObj(guildTemplate(g, ctx.params.code));
  run('DELETE FROM guild_templates WHERE code = ?', out.code);
  return out;
}

async function useTemplate(ctx) {
  const t = byCode(ctx.params.code);
  const body = ctx.body ?? {};
  const out = await createFromSnapshot(JSON.parse(t.snapshot), str(body, 'name', 2, 100), ctx.user, body.icon);
  run('UPDATE guild_templates SET usage_count = usage_count + 1 WHERE code = ?', t.code);
  ctx.status = 201;
  return out;
}

// export: {format, version, exported_at, serialized_source_guild}; it is imported through POST /guilds (routes/guilds.js)
function exportGuild(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  return { format: 'cillcord-guild', version: 1, exported_at: new Date().toISOString(), serialized_source_guild: serialize(g) };
}

// --- templates from the other chat app (owner's request): its public template API has the same snapshot shape ---------
// ids, permission bits and fields match; only the differences below are adapted, everything else goes through createFromSnapshot.
const EXTERNAL_API = 'https://discord.com/api/v9/guilds/templates/';
const CHANNEL_TYPE = t => (CREATABLE.includes(t) ? t : t === 16 ? 15 : 0); // media channel -> forum, unknown -> text
async function externalTemplate(ctx) {
  const { code } = ctx.params;
  if (!/^[A-Za-z0-9_-]{2,64}$/.test(code)) throw notFound(10057, 'Guild Template');
  const res = await safeFetch(EXTERNAL_API + code, { maxBytes: 2 * 1024 * 1024, truncate: false, timeout: 8000, maxRedirects: 0 }).catch(() => null);
  if (!res || res.status === 404) throw notFound(10057, 'Guild Template');
  let t;
  try { t = JSON.parse(res.body.toString('utf8')); } catch { t = null; }
  const s = t?.serialized_source_guild;
  if (res.status !== 200 || !s || !Array.isArray(s.roles) || !Array.isArray(s.channels)) throw new HttpError(502, 0, 'The template could not be loaded.');
  return fromExternal(t, code);
}

/** The external template object -> our template object with an adapted snapshot (exported for tests). */
export function fromExternal(t, code) {
  const s = t.serialized_source_guild;
  const noCustomEmoji = e => (e?.emoji_name && !e.emoji_id ? { emoji_id: null, emoji_name: e.emoji_name } : null);
  const snapshot = {
    name: String(s.name ?? t.name ?? '').slice(0, 100), description: typeof s.description === 'string' ? s.description.slice(0, 300) : null,
    verification_level: Math.min(Math.max(Number(s.verification_level) || 0, 0), 2), default_message_notifications: s.default_message_notifications ? 1 : 0,
    explicit_content_filter: 0, preferred_locale: s.preferred_locale ?? 'en-US', afk_timeout: s.afk_timeout, afk_channel_id: s.afk_channel_id ?? null,
    system_channel_id: s.system_channel_id ?? null, system_channel_flags: Number(s.system_channel_flags) || 0,
    roles: s.roles.map(r => ({ id: r.id, name: r.name, permissions: String(r.permissions ?? '0'), color: r.color ?? 0, hoist: !!r.hoist, mentionable: !!r.mentionable })),
    channels: s.channels.map(c => ({
      ...c, type: CHANNEL_TYPE(c.type), permission_overwrites: (c.permission_overwrites ?? []).filter(o => o?.type !== 1),
      available_tags: (c.available_tags ?? []).map(x => ({ name: x.name, moderated: !!x.moderated, emoji_id: null, emoji_name: x.emoji_id ? null : x.emoji_name ?? null })),
      default_reaction_emoji: noCustomEmoji(c.default_reaction_emoji),
    })),
  };
  return {
    code, name: String(t.name ?? snapshot.name).slice(0, 100), description: typeof t.description === 'string' ? t.description.slice(0, 120) : null,
    usage_count: Number(t.usage_count) || 0, external: true, serialized_source_guild: snapshot,
  };
}

export default [
  ['GET', '/guilds/templates/external/:code', externalTemplate, { userOnly: true }],
  ['GET', '/guilds/templates/:code', ({ params }) => templateObj(byCode(params.code)), { open: true }],
  ['POST', '/guilds/templates/:code', useTemplate, { maxBody: 12 * 1024 * 1024, userOnly: true }],
  ['GET', '/guilds/:id/templates', ctx => all('SELECT * FROM guild_templates WHERE guild_id = ?', loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD).id).map(t => templateObj(t, true))],
  ['POST', '/guilds/:id/templates', createTemplate],
  ['PUT', '/guilds/:id/templates/:code', syncTemplate],
  ['PATCH', '/guilds/:id/templates/:code', patchTemplate],
  ['DELETE', '/guilds/:id/templates/:code', deleteTemplate],
  ['GET', '/guilds/:id/export', exportGuild],
];
