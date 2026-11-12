import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_DIR = process.env.DATA_DIR ?? './data';
mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(join(DATA_DIR, 'cillcord.sqlite'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

// prepared statements by SQL text; SQLite re-prepares them itself after a schema change. Oldest goes past the cap
// (dynamic `IN (?,?,…)` lists make one entry per length)
const stmts = new Map();
function stmt(sql) {
  let s = stmts.get(sql);
  if (!s) {
    if (stmts.size >= 500) stmts.delete(stmts.keys().next().value);
    stmts.set(sql, s = db.prepare(sql));
  }
  return s;
}
export const get = (sql, ...args) => stmt(sql).get(...args);
export const all = (sql, ...args) => stmt(sql).all(...args);
export const run = (sql, ...args) => stmt(sql).run(...args);
let afterCommit = [];
// runs fn once the open tx() commits (dropped on rollback), or right away outside a transaction
export const onCommit = fn => db.isTransaction ? afterCommit.push(fn) : fn();
export function tx(fn) {
  db.exec('BEGIN');
  let result;
  try {
    result = fn();
    db.exec('COMMIT');
  } catch (e) {
    afterCommit = [];
    db.exec('ROLLBACK');
    throw e;
  }
  const later = afterCommit;
  afterCommit = [];
  later.forEach(f => f());
  return result;
}

// step i brings the database to user_version i + 1. v1 never set user_version, so a v1 database
// reads 0 and replays 001, which only creates what is missing.
const MIGRATIONS = ['001-v1.sql', '002-v2.sql', '003-v3.sql', '004-v4.sql', '005-v5.sql', '006-v6.sql', '007-v7.sql', '008-brand.sql', '009-guild-voice.sql', '010-modules.sql', '011-v9.sql', '012-v9-phase4.sql', '013-v10.sql', '014-v11.sql', '015-v12.sql', '016-v13.sql', '017-role-scope.sql', '018-attachment-sig.sql', '019-password-reset.sql', '020-account-security.sql', '021-legal.sql', '022-spam-guard.sql', '023-message-order.sql', '024-e2ee-dm.sql'];
for (let v = get('PRAGMA user_version').user_version; v < MIGRATIONS.length; v++) {
  const sql = readFileSync(new URL(`./migrations/${MIGRATIONS[v]}`, import.meta.url), 'utf8');
  tx(() => db.exec(`${sql}; PRAGMA user_version = ${v + 1};`));
}

export const userById = id => get('SELECT * FROM users WHERE id = ?', id);
export const isMember = (guildId, userId) => !!get('SELECT 1 FROM members WHERE guild_id = ? AND user_id = ?', guildId, userId);
export const memberIds = guildId => all('SELECT user_id FROM members WHERE guild_id = ?', guildId).map(r => r.user_id);
export const channelUserIds = ch => ch.guild_id
  ? memberIds(ch.guild_id)
  : all('SELECT user_id FROM dm_recipients WHERE channel_id = ?', ch.id).map(r => r.user_id);
export const isFriend = (a, b) => !!get('SELECT 1 FROM relationships WHERE user_id = ? AND other_id = ? AND type = 1', a, b);
// everyone sharing a guild, a DM or a friendship with the user, the user included
export const audienceOf = userId => all(`
  SELECT ? AS user_id
  UNION SELECT b.user_id FROM members a JOIN members b ON b.guild_id = a.guild_id WHERE a.user_id = ?
  UNION SELECT b.user_id FROM dm_recipients a JOIN dm_recipients b ON b.channel_id = a.channel_id WHERE a.user_id = ?
  UNION SELECT other_id FROM relationships WHERE user_id = ? AND type = 1`,
  userId, userId, userId, userId).map(r => r.user_id);
export const guildsOf = userId => all('SELECT g.* FROM guilds g JOIN members m ON m.guild_id = g.id WHERE m.user_id = ? ORDER BY m.joined_at', userId);
export const dmsOf = userId => all(`
  SELECT c.* FROM channels c JOIN dm_recipients d ON d.channel_id = c.id WHERE d.user_id = ?
  ORDER BY CAST(COALESCE(c.last_message_id, c.id) AS INTEGER) DESC`, userId);

// a user's v6 customization (v9 API shapes: display_name_styles, avatar_decoration_data, collectibles, primary_guild)
export function userObj(u, withEmail = false) {
  const c = json(u.customization, {});
  return {
    id: u.id, username: u.username, discriminator: '0', global_name: u.global_name, avatar: u.avatar, bot: !!u.bot,
    banner: u.banner ?? null, accent_color: u.accent_color ?? null, public_flags: 0,
    avatar_decoration_data: c.avatar_decoration_data ?? null, collectibles: c.collectibles ?? null,
    display_name_styles: c.display_name_styles ?? null, primary_guild: primaryGuild(u.id, c.primary_guild_id),
    ...(u.system && { system: true }), ...(u.module && { module: true }),
    ...(withEmail && {
      email: u.bot ? null : u.email, mfa_enabled: !!u.mfa_secret, verified: true, bio: u.bio ?? '', pronouns: u.pronouns ?? '',
      theme_colors: c.theme_colors ?? null, profile_effect: c.profile_effect ?? null, widgets: c.widgets ?? [], instance_admin: !!u.instance_admin,
    }),
  };
}

// the server tag a user shows: only while they are still a member and the server still has a tag
// shortcut: one indexed lookup per rendered user that chose a tag; cache it if user objects get hot
function primaryGuild(userId, guildId) {
  if (!guildId) return null;
  const g = get('SELECT g.profile FROM guilds g JOIN members m ON m.guild_id = g.id AND m.user_id = ? WHERE g.id = ?', userId, guildId);
  const p = json(g?.profile, {});
  if (!p.tag) return null;
  return {
    identity_enabled: true, identity_guild_id: guildId, tag: p.tag, badge: p.badge_hash ?? null,
    badge_type: p.badge ?? 0, badge_color_primary: p.badge_color_primary ?? null, badge_color_secondary: p.badge_color_secondary ?? null,
  };
}
export const json = (text, fallback = null) => text == null ? fallback : JSON.parse(text);
// snowflake -> unix ms
export const idTime = id => Number((BigInt(id) >> 22n) + 1420070400000n);

export const roleObj = r => ({
  id: r.id, name: r.name, color: r.color, hoist: !!r.hoist, position: r.position,
  permissions: r.permissions, mentionable: !!r.mentionable, managed: !!r.managed,
  colors: { primary_color: r.color, secondary_color: r.secondary_color ?? null, tertiary_color: r.tertiary_color ?? null },
  icon: r.icon ?? null, unicode_emoji: r.unicode_emoji ?? null,
  ...(r.bot_id && { tags: { bot_id: r.bot_id } }),
});
export const rolesOf = guildId => all('SELECT * FROM roles WHERE guild_id = ? ORDER BY position', guildId).map(roleObj);

export const emojiObj = (e, withUser = false) => ({
  id: e.id, name: e.name, roles: json(e.roles, []), require_colons: true, managed: false, animated: !!e.animated, available: true,
  ...(withUser && e.user_id && { user: userObj(userById(e.user_id)) }),
});
export const stickerObj = (s, withUser = false) => ({
  id: s.id, name: s.name, description: s.description, tags: s.tags, type: 2, format_type: s.format_type, available: true, guild_id: s.guild_id,
  ...(withUser && s.user_id && { user: userObj(userById(s.user_id)) }),
});

// mutable features are stored; the others follow from the guild's settings (self-hosted: every guild has every perk)
export function featuresOf(g) {
  const out = new Set([...json(g.features, []), 'NEWS', 'VANITY_URL', 'ANIMATED_ICON', 'BANNER', 'INVITE_SPLASH', 'ROLE_ICONS',
    'ENHANCED_ROLE_COLORS', 'GUILD_TAGS']);
  if (g.invites_disabled) out.add('INVITES_DISABLED');
  if (json(g.welcome_screen)?.enabled) out.add('WELCOME_SCREEN_ENABLED');
  if (json(g.member_verification)?.enabled) out.add('MEMBER_VERIFICATION_GATE_ENABLED');
  if (get('SELECT 1 FROM automod_rules WHERE guild_id = ?', g.id)) out.add('AUTO_MODERATION');
  return [...out];
}

// the guild identity {tag, badge} (docs); Cillhub adds the badge type and colours
export function guildIdentity(g) {
  const p = json(g.profile, {});
  return p.tag ? {
    tag: p.tag, badge: p.badge_hash ?? null, badge_type: p.badge ?? 0,
    badge_color_primary: p.badge_color_primary ?? null, badge_color_secondary: p.badge_color_secondary ?? null,
  } : null;
}

export const guildChannels = guildId => all('SELECT * FROM channels WHERE guild_id = ? AND type NOT IN (10, 11, 12) ORDER BY position', guildId);

// channels: the rows to list (visibleChannels for a member), or none
export function guildObj(g, channels) {
  const member_count = get('SELECT COUNT(*) AS n FROM members WHERE guild_id = ?', g.id).n;
  const guild = {
    id: g.id, name: g.name, icon: g.icon, owner_id: g.owner_id, member_count, system_channel_id: g.system_channel_id, roles: rolesOf(g.id),
    description: g.description, afk_channel_id: g.afk_channel_id, afk_timeout: g.afk_timeout, verification_level: g.verification_level,
    rules_channel_id: g.rules_channel_id, vanity_url_code: g.vanity_url_code, features: featuresOf(g), premium_tier: 0, nsfw_level: 0,
    banner: g.banner ?? null, splash: g.splash ?? null, profile: guildIdentity(g), brand_color_primary: json(g.profile, {}).brand_color_primary ?? null,
    entrance_sounds_enabled: g.entrance_sounds == null ? true : !!g.entrance_sounds, auto_spam_slowmode_enabled: g.spam_slowmode == null ? true : !!g.spam_slowmode, greeting_templates: json(g.greeting_templates, []),
    voice_backend: g.voice_backend ?? null, // Cillhub: per-server voice server, null = instance default
    emojis: all('SELECT * FROM emojis WHERE guild_id = ? ORDER BY rowid', g.id).map(e => emojiObj(e)),
    stickers: all('SELECT * FROM stickers WHERE guild_id = ? ORDER BY rowid', g.id).map(s => stickerObj(s)),
  };
  if (channels) guild.channels = channels.map(c => channelObj(c));
  return guild;
}

export const threadMemberObj = (tm, full = true) => ({
  ...(full && { id: tm.channel_id, user_id: tm.user_id }), join_timestamp: tm.join_timestamp, flags: tm.flags ?? 0,
});
const threadMember = (threadId, userId) => userId && get('SELECT * FROM thread_members WHERE channel_id = ? AND user_id = ?', threadId, userId);

export function threadObj(t, viewerId) {
  const count = get('SELECT COUNT(*) AS n FROM thread_members WHERE channel_id = ?', t.id).n;
  const me = threadMember(t.id, viewerId);
  return {
    id: t.id, type: t.type, guild_id: t.guild_id, parent_id: t.parent_id, owner_id: t.owner_id, name: t.name, flags: t.flags,
    last_message_id: t.last_message_id, rate_limit_per_user: t.rate_limit_per_user, message_count: t.message_count,
    total_message_sent: t.total_message_sent, member_count: Math.min(count, 50), applied_tags: json(t.applied_tags, []),
    solved_message_id: t.solved_message_id ?? null,
    thread_metadata: {
      archived: !!t.archived, auto_archive_duration: t.auto_archive_duration, archive_timestamp: t.archive_timestamp,
      locked: !!t.locked, create_timestamp: t.create_timestamp, ...(t.type === 12 && { invitable: !!t.invitable }),
    },
    ...(me && { member: threadMemberObj(me) }),
  };
}

// voice channel statuses are ephemeral (kept out of the database); cleared when the channel empties
export const voiceStatuses = new Map(); // channel id -> status

export function channelObj(c, viewerId) {
  if (c.type === 1) {
    const others = all('SELECT u.* FROM dm_recipients d JOIN users u ON u.id = d.user_id WHERE d.channel_id = ? AND d.user_id != ?', c.id, viewerId);
    return { id: c.id, type: 1, recipients: others.map(u => userObj(u)), last_message_id: c.last_message_id, message_ttl: c.message_ttl ?? 0, e2ee_epoch: c.e2ee_epoch ?? 0 };
  }
  if (c.type === 3) {
    const others = all('SELECT u.* FROM dm_recipients d JOIN users u ON u.id = d.user_id WHERE d.channel_id = ? AND d.user_id != ? ORDER BY d.rowid', c.id, viewerId ?? '');
    return {
      id: c.id, type: 3, name: c.name, icon: c.icon, owner_id: c.owner_id, recipients: others.map(u => userObj(u)),
      last_message_id: c.last_message_id, flags: 0, message_ttl: c.message_ttl ?? 0, e2ee_epoch: c.e2ee_epoch ?? 0,
    };
  }
  if (c.type >= 10 && c.type <= 12) return threadObj(c, viewerId);
  const permission_overwrites = all('SELECT target_id AS id, type, allow, deny FROM overwrites WHERE channel_id = ?', c.id);
  const out = {
    id: c.id, type: c.type, guild_id: c.guild_id, name: c.name, position: c.position, parent_id: c.parent_id, permission_overwrites,
    nsfw: !!c.nsfw, flags: c.flags, message_ttl: c.message_ttl ?? 0,
  };
  if ([0, 2, 5, 13, 15, 16].includes(c.type)) Object.assign(out, { last_message_id: c.last_message_id, rate_limit_per_user: c.rate_limit_per_user });
  if ([0, 5, 15, 16].includes(c.type)) Object.assign(out, { topic: c.topic, default_auto_archive_duration: c.default_auto_archive_duration });
  if ([0, 2, 5, 13, 15, 16].includes(c.type)) Object.assign(out, { icon_emoji: json(c.icon_emoji), theme_color: c.theme_color ?? null });
  if (c.type === 2 || c.type === 13) {
    out.user_limit = c.user_limit;
    out.quality_mode = c.quality_mode ?? 'speech';
  }
  if (c.type === 2) out.status = voiceStatuses.get(c.id) ?? null;
  if (c.type === 15 || c.type === 16) {
    Object.assign(out, {
      available_tags: json(c.available_tags, []), default_reaction_emoji: json(c.default_reaction_emoji),
      default_sort_order: c.default_sort_order, default_forum_layout: c.default_forum_layout ?? (c.type === 16 ? 2 : 0),
      layout_type: c.default_forum_layout ?? (c.type === 16 ? 2 : 0),
      default_thread_rate_limit_per_user: c.default_thread_rate_limit_per_user,
    });
  }
  return out;
}

const MEMBER = `SELECT u.*, m.guild_id, m.joined_at, m.nick, m.mute, m.deaf, m.pending, m.communication_disabled_until,
                  m.avatar AS member_avatar, m.banner AS member_banner, m.bio AS member_bio, m.display_name_styles AS member_name_styles
                FROM members m JOIN users u ON u.id = m.user_id`;
export const memberRow = (guildId, userId) => get(`${MEMBER} WHERE m.guild_id = ? AND m.user_id = ?`, guildId, userId);
export const memberObj = row => ({
  user: userObj(row), nick: row.nick, avatar: row.member_avatar ?? null, banner: row.member_banner ?? null,
  joined_at: row.joined_at, mute: !!row.mute, deaf: !!row.deaf, flags: 0,
  pending: !!row.pending, communication_disabled_until: row.communication_disabled_until,
  display_name_styles: json(row.member_name_styles),
  roles: all('SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?', row.guild_id, row.id).map(r => r.role_id),
});
export const membersOf = (guildId, limit = -1) =>
  all(`${MEMBER} WHERE m.guild_id = ? ORDER BY m.joined_at LIMIT ?`, guildId, limit).map(memberObj);
