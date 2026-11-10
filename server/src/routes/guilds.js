import { configuredBackends } from '../voice.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { snowflake } from '../snowflake.js';
import { DATA_DIR, get, all, run, tx, json, isMember, memberIds, membersOf, userById, userObj, guildObj, channelObj } from '../db.js';
import { HttpError, str, int, bool, intParam, invalid, notFound, missingAccess, missingPermissions } from '../errors.js';
import { P, need, guildPerms, requireAssignable, DEFAULT_PERMISSIONS, visibleChannels } from '../permissions.js';
import { audit, A, diff } from '../audit.js';
import { sendToUsers, presences, guildFull, visibility, syncVisibility } from '../gateway.js';
import { disconnect } from '../voice.js';
import { saveImage, removeImage, removeChannelFiles, removeAsset } from '../files.js';
import { requireMfa } from '../mfa.js';
import { createFromSnapshot } from './templates.js';
import { unequipDecorations, announceUser } from './customization.js';
import { recordGuildMetric } from '../analytics.js';

// a guild the user is a member of, with their guild-level permissions as g.perms
export function loadGuild(id, user, perm = 0n) {
  const g = get('SELECT * FROM guilds WHERE id = ?', id);
  if (!g) throw notFound(10004, 'Guild');
  if (!isMember(g.id, user.id)) throw missingAccess();
  g.perms = guildPerms(g.id, user.id);
  need(g.perms, perm);
  return g;
}

// called with every newly created guild (normal create, from a file or a template); v8 modules join it
export const guildCreatedHooks = [];

export const guildCreate = (g, userId) => ({ ...guildFull(g, userId), members: membersOf(g.id), presences: presences(memberIds(g.id)) });

// kick, ban and leave: the member goes, their sessions forget the guild, everyone else is told
export function removeMember(guildId, user) {
  recordGuildMetric(guildId, 'leaves', 1);
  disconnect(guildId, user.id);
  run('DELETE FROM members WHERE guild_id = ? AND user_id = ?', guildId, user.id);
  sendToUsers([user.id], 'GUILD_DELETE', { id: guildId });
  sendToUsers(memberIds(guildId), 'GUILD_MEMBER_REMOVE', { guild_id: guildId, user: userObj(user) });
  if (json(userById(user.id)?.customization, {}).primary_guild_id === guildId) announceUser(user.id); // the tag goes with the membership
  // a bot's managed role goes with it
  for (const r of all('SELECT id FROM roles WHERE guild_id = ? AND bot_id = ?', guildId, user.id)) {
    run('DELETE FROM roles WHERE id = ?', r.id);
    sendToUsers(memberIds(guildId), 'GUILD_ROLE_DELETE', { guild_id: guildId, role_id: r.id });
  }
}

async function createGuild(ctx) {
  const name = str(ctx.body, 'name', 2, 100);
  // Create Guild (docs) with `roles`/`channels` (integer placeholder ids, roles[0] = @everyone): "Create from file" (v5)
  if (Array.isArray(ctx.body.roles) || Array.isArray(ctx.body.channels)) {
    const out = await createFromSnapshot(ctx.body, name, ctx.user, ctx.body.icon);
    ctx.status = 201;
    return out;
  }
  const id = snowflake();
  const general = snowflake();
  const textCategory = snowflake();
  const voiceCategory = snowflake();
  const channel = (cid, type, channelName, position, parentId = null) =>
    run('INSERT INTO channels (id, type, guild_id, name, position, parent_id) VALUES (?, ?, ?, ?, ?, ?)', cid, type, id, channelName, position, parentId);
  tx(() => {
    run('INSERT INTO guilds (id, name, owner_id, system_channel_id) VALUES (?, ?, ?, ?)', id, name, ctx.user.id, general);
    run("INSERT INTO roles (id, guild_id, name, position, permissions) VALUES (?, ?, '@everyone', 0, ?)", id, id, DEFAULT_PERMISSIONS);
    run('INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', id, ctx.user.id, new Date().toISOString());
    channel(textCategory, 4, 'Text Channels', 0);
    channel(general, 0, 'general', 0, textCategory);
    channel(voiceCategory, 4, 'Voice Channels', 1);
    channel(snowflake(), 2, 'General', 0, voiceCategory);
  });
  const g = get('SELECT * FROM guilds WHERE id = ?', id);
  sendToUsers([ctx.user.id], 'GUILD_CREATE', guildCreate(g, ctx.user.id));
  guildCreatedHooks.forEach(f => f(g));
  ctx.status = 201;
  return guildObj(get('SELECT * FROM guilds WHERE id = ?', id), visibleChannels(id, ctx.user.id));
}

const AFK_TIMEOUTS = [60, 300, 900, 1800, 3600];
const MUTABLE_FEATURES = ['COMMUNITY'];

// a channel of this guild of one of the given types, or null
function channelRef(body, field, guildId, types) {
  if (body[field] === null) return null;
  const ch = get('SELECT id, type FROM channels WHERE id = ? AND guild_id = ?', String(body[field]), guildId);
  if (!ch || !types.includes(ch.type)) throw invalid(field, 'CHANNEL_INVALID', 'Not a fitting channel of this guild.');
  return ch.id;
}

// the v3 guild settings in a PATCH body, as column values
function settings(body, g) {
  const out = {};
  if (body.verification_level != null) out.verification_level = int(body, 'verification_level', 0, 2);
  if (body.afk_timeout !== undefined) {
    if (!AFK_TIMEOUTS.includes(body.afk_timeout)) throw invalid('afk_timeout', 'BASE_TYPE_CHOICES', `Must be one of ${AFK_TIMEOUTS.join(', ')}.`);
    out.afk_timeout = body.afk_timeout;
  }
  if (body.afk_channel_id !== undefined) out.afk_channel_id = channelRef(body, 'afk_channel_id', g.id, [2]);
  if (body.system_channel_id !== undefined) out.system_channel_id = channelRef(body, 'system_channel_id', g.id, [0]);
  if (body.rules_channel_id !== undefined) out.rules_channel_id = channelRef(body, 'rules_channel_id', g.id, [0]);
  if (body.description !== undefined) out.description = body.description === null ? null : str(body, 'description', 0, 300) || null;
  if (body.entrance_sounds_enabled !== undefined) out.entrance_sounds = Number(bool(body, 'entrance_sounds_enabled'));
  if (body.voice_backend !== undefined) {
    if (body.voice_backend !== null && !configuredBackends().includes(body.voice_backend)) throw invalid('voice_backend', 'VOICE_BACKEND_UNAVAILABLE', `Must be null or one of: ${configuredBackends().join(', ') || 'none'}.`);
    out.voice_backend = body.voice_backend;
  }
  if (body.greeting_templates !== undefined) {
    const t = body.greeting_templates ?? [];
    if (!Array.isArray(t) || t.length > 10) throw invalid('greeting_templates', 'BASE_TYPE_MAX_LENGTH', 'At most 10 greeting templates.');
    out.greeting_templates = JSON.stringify(t.map((x, i) => str(t, i, 1, 200)));
  }
  if (body.features !== undefined) {
    if (!Array.isArray(body.features)) throw invalid('features', 'BASE_TYPE_ARRAY', 'Must be an array.');
    const features = MUTABLE_FEATURES.filter(f => body.features.includes(f));
    // turning COMMUNITY on or off takes ADMINISTRATOR (reference behaviour)
    if (features.includes('COMMUNITY') !== JSON.parse(g.features).includes('COMMUNITY')) need(g.perms, P.ADMINISTRATOR);
    out.features = JSON.stringify(features);
  }
  return out;
}

const AUDITED = ['owner_id', 'name', 'icon', 'description', 'verification_level', 'afk_channel_id', 'afk_timeout', 'system_channel_id', 'rules_channel_id', 'features',
  'banner', 'splash', 'entrance_sounds_enabled', 'greeting_templates', 'voice_backend'];

async function patchGuild(ctx) {
  const { params, user } = ctx;
  const body = ctx.body ?? {};
  const g = loadGuild(params.id, user, P.MANAGE_GUILD);
  const next = settings(body, g);
  if (body.name !== undefined) next.name = str(body, 'name', 2, 100);
  if (body.icon !== undefined) next.icon = await saveImage(body.icon, 'icon', 'icons', g.id);
  if (body.banner !== undefined) next.banner = await saveImage(body.banner, 'banner', 'banners', g.id);
  if (body.splash !== undefined) next.splash = await saveImage(body.splash, 'splash', 'splashes', g.id);
  // ownership transfer: owner only, to a human member, with MFA when the owner has it on
  if (body.owner_id !== undefined && body.owner_id !== g.owner_id) {
    if (user.id !== g.owner_id) throw missingPermissions();
    const target = get('SELECT u.* FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ? AND m.user_id = ?', g.id, String(body.owner_id));
    if (!target || target.bot) throw invalid('owner_id', 'BASE_TYPE_INVALID', 'The new owner must be a member of this guild and not a bot.');
    requireMfa(ctx);
    next.owner_id = target.id;
  }
  const seen = next.owner_id && visibility(g.id, [g.owner_id, next.owner_id]);
  for (const [k, v] of Object.entries(next)) run(`UPDATE guilds SET ${k} = ? WHERE id = ?`, v, g.id); // keys are fixed above
  if ('icon' in next && next.icon !== g.icon) removeImage('icons', g.id, g.icon);
  if ('banner' in next && next.banner !== g.banner) removeImage('banners', g.id, g.banner);
  if ('splash' in next && next.splash !== g.splash) removeImage('splashes', g.id, g.splash);
  const out = guildObj(get('SELECT * FROM guilds WHERE id = ?', g.id));
  audit(ctx, g.id, A.GUILD_UPDATE, g.id, { changes: diff(guildObj(g), out, AUDITED) });
  sendToUsers(memberIds(g.id), 'GUILD_UPDATE', out);
  if (seen) syncVisibility(g.id, seen);
  return out;
}

function deleteGuild({ params, user }) {
  const g = loadGuild(params.id, user);
  if (g.owner_id !== user.id) throw missingPermissions();
  destroyGuild(g);
}

// the guild, its files and everyone's voice connections in it (owner's delete, or an instance admin's)
export function destroyGuild(g) {
  const ids = memberIds(g.id);
  for (const id of ids) disconnect(g.id, id);
  const channels = all('SELECT id FROM channels WHERE guild_id = ?', g.id);
  const assets = [
    ...all('SELECT id FROM emojis WHERE guild_id = ?', g.id).map(r => ['emojis', r.id]),
    ...all('SELECT id FROM stickers WHERE guild_id = ?', g.id).map(r => ['stickers', r.id]),
    ...all('SELECT sound_id AS id FROM soundboard_sounds WHERE guild_id = ?', g.id).map(r => ['soundboard-sounds', r.id]),
  ];
  const roleIcons = all('SELECT id FROM roles WHERE guild_id = ? AND icon IS NOT NULL', g.id).map(r => r.id);
  const decorations = all('SELECT id, asset FROM guild_decorations WHERE guild_id = ?', g.id);
  const tagged = all("SELECT id FROM users WHERE json_extract(customization, '$.primary_guild_id') = ?", g.id);
  run('DELETE FROM guilds WHERE id = ?', g.id);
  channels.forEach(c => removeChannelFiles(c.id));
  assets.forEach(([kind, id]) => removeAsset(kind, id));
  removeImage('icons', g.id, g.icon);
  removeImage('banners', g.id, g.banner);
  for (const kind of ['splashes', 'welcome-backgrounds', 'guild-tag-badges']) rmSync(join(DATA_DIR, kind, g.id), { recursive: true, force: true });
  roleIcons.forEach(id => rmSync(join(DATA_DIR, 'role-icons', id), { recursive: true, force: true }));
  decorations.forEach(r => removeAsset('avatar-decorations', r.asset));
  sendToUsers(ids, 'GUILD_DELETE', { id: g.id });
  unequipDecorations(decorations.map(r => r.id));
  tagged.forEach(u => announceUser(u.id)); // their server tag disappears
}

function leaveGuild({ params, user }) {
  const g = loadGuild(params.id, user);
  if (g.owner_id === user.id) throw new HttpError(400, 0, 'Guild owner cannot leave the guild');
  removeMember(g.id, user);
}

function getAntiRaid({ params, user }) {
  const g = loadGuild(params.id, user);
  need(g.perms, P.MANAGE_GUILD);
  return { anti_raid: json(g.anti_raid, { enabled: false, join_threshold_per_minute: 10, auto_pause_invites: true }) };
}

function putAntiRaid(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  need(g.perms, P.MANAGE_GUILD);
  const b = ctx.body ?? {};
  const joinThreshold = b.join_threshold_per_minute ?? b.join_threshold;
  const cfg = {
    enabled: !!b.enabled,
    join_threshold_per_minute: typeof joinThreshold === 'number' ? Math.max(2, joinThreshold) : 10,
    quarantine_role_id: b.quarantine_role_id ? String(b.quarantine_role_id) : null,
    auto_pause_invites: b.auto_pause_invites !== undefined ? !!b.auto_pause_invites : true,
    notify_channel_id: b.notify_channel_id ? String(b.notify_channel_id) : null,
  };
  if (cfg.quarantine_role_id) {
    need(g.perms, P.MANAGE_ROLES);
    requireAssignable(g.id, ctx.user.id, cfg.quarantine_role_id, 'quarantine_role_id');
  }
  if (cfg.notify_channel_id && !get('SELECT 1 FROM channels WHERE id = ? AND guild_id = ?', cfg.notify_channel_id, g.id)) throw notFound(10003, 'Channel');
  run('UPDATE guilds SET anti_raid = ? WHERE id = ?', JSON.stringify(cfg), g.id);
  return { anti_raid: cfg };
}

function backupExport({ params, user }) {
  const g = loadGuild(params.id, user);
  need(g.perms, P.MANAGE_GUILD);
  const channels = all('SELECT id, type, name, position, topic, nsfw, rate_limit_per_user, parent_id, message_ttl, quality_mode FROM channels WHERE guild_id = ? ORDER BY position', g.id);
  const roles = all('SELECT id, name, color, hoist, position, permissions, mentionable FROM roles WHERE guild_id = ? ORDER BY position', g.id);
  const emojis = all('SELECT id, name, animated FROM emojis WHERE guild_id = ?', g.id);
  const soundboard = all('SELECT id, name, description, icon_emoji, sound_ids FROM soundboard_packs WHERE guild_id = ?', g.id);
  const onboarding = get('SELECT * FROM guild_onboarding WHERE guild_id = ?', g.id);
  return {
    format: 'cillpack-v1',
    version: 1,
    exported_at: new Date().toISOString(),
    guild: {
      name: g.name,
      description: g.description,
      verification_level: g.verification_level,
      anti_raid: json(g.anti_raid),
      channels,
      roles,
      emojis,
      soundboard_packs: soundboard,
      onboarding: onboarding ? { enabled: !!onboarding.enabled, prompts: json(onboarding.prompts, []) } : null,
    },
  };
}

function backupRestore(ctx) {
  const b = ctx.body?.guild ?? ctx.body;
  if (!b?.name) throw invalid('name', 'BASE_TYPE_REQUIRED', 'Guild name required.');
  return createGuild({ user: ctx.user, body: { name: b.name, channels: b.channels, roles: b.roles } });
}

function getVanityUrl({ params, user }) {
  const g = loadGuild(params.id, user);
  const row = get('SELECT vanity_url_code, vanity_code, vanity_uses FROM guilds WHERE id = ?', g.id);
  return { code: row?.vanity_url_code ?? row?.vanity_code ?? null, uses: row?.vanity_uses ?? 0 };
}

function patchVanityUrl({ params, body, user }) {
  const g = loadGuild(params.id, user);
  need(g.perms, P.MANAGE_GUILD);
  let code = body?.code == null ? null : String(body.code).trim().toLowerCase();
  if (code !== null) {
    if (!/^[a-z0-9_-]{2,32}$/.test(code)) throw invalid('code', 'INVALID_VANITY_CODE', 'Must be 2-32 alphanumeric or dash characters');
    const existing = get('SELECT id FROM guilds WHERE (vanity_url_code = ? OR vanity_code = ?) AND id != ?', code, code, g.id);
    // an old lower-case invite link, even expired, must not start leading to another server
    if (existing || get('SELECT 1 FROM invites WHERE code = ?', code)) throw new HttpError(400, 50020, 'Vanity URL already in use');
  }
  run('UPDATE guilds SET vanity_url_code = ?, vanity_code = ? WHERE id = ?', code, code, g.id);
  return { code, uses: get('SELECT vanity_uses FROM guilds WHERE id = ?', g.id)?.vanity_uses ?? 0 };
}

export default [
  ['POST', '/guilds', createGuild, { maxBody: 32 * 1024 * 1024 }], // imports carry emoji as data URIs (up to 200, typically far below 256 KiB each)
  ['GET', '/guilds/:id', ({ params, user }) => guildObj(loadGuild(params.id, user), visibleChannels(params.id, user.id))],
  ['PATCH', '/guilds/:id', patchGuild, { maxBody: 12 * 1024 * 1024 }],
  ['DELETE', '/guilds/:id', deleteGuild],
  ['GET', '/guilds/:id/channels', ({ params, user }) => visibleChannels(loadGuild(params.id, user).id, user.id).map(c => channelObj(c))],
  ['GET', '/guilds/:id/members', ({ params, query, user }) => membersOf(loadGuild(params.id, user).id, intParam(query, 'limit', 1000, 1, 1000))],
  ['GET', '/guilds/:id/anti-raid', getAntiRaid],
  ['PUT', '/guilds/:id/anti-raid', putAntiRaid],
  ['GET', '/guilds/:id/vanity-url', getVanityUrl],
  ['PATCH', '/guilds/:id/vanity-url', patchVanityUrl],
  ['GET', '/guilds/:id/backup-export', backupExport],
  ['POST', '/guilds/backup-restore', backupRestore], // name, channels and roles only
  ['DELETE', '/users/@me/guilds/:id', leaveGuild],
];
