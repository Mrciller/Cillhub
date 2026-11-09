import { get, all, memberIds, guildChannels } from './db.js';
import { invalid, missingPermissions, notFound } from './errors.js';

const bit = n => 1n << BigInt(n);
export const P = {
  CREATE_INSTANT_INVITE: bit(0), KICK_MEMBERS: bit(1), BAN_MEMBERS: bit(2), ADMINISTRATOR: bit(3),
  MANAGE_CHANNELS: bit(4), MANAGE_GUILD: bit(5), ADD_REACTIONS: bit(6), VIEW_AUDIT_LOG: bit(7), PRIORITY_SPEAKER: bit(8),
  STREAM: bit(9), VIEW_CHANNEL: bit(10), SEND_MESSAGES: bit(11), MANAGE_MESSAGES: bit(13), EMBED_LINKS: bit(14),
  ATTACH_FILES: bit(15), READ_MESSAGE_HISTORY: bit(16), MENTION_EVERYONE: bit(17), USE_EXTERNAL_EMOJIS: bit(18),
  CONNECT: bit(20), SPEAK: bit(21), MUTE_MEMBERS: bit(22), DEAFEN_MEMBERS: bit(23), MOVE_MEMBERS: bit(24),
  CHANGE_NICKNAME: bit(26), MANAGE_NICKNAMES: bit(27), MANAGE_ROLES: bit(28), MANAGE_WEBHOOKS: bit(29),
  MANAGE_GUILD_EXPRESSIONS: bit(30), USE_APPLICATION_COMMANDS: bit(31), REQUEST_TO_SPEAK: bit(32), MANAGE_EVENTS: bit(33),
  MANAGE_THREADS: bit(34), CREATE_PUBLIC_THREADS: bit(35), CREATE_PRIVATE_THREADS: bit(36), USE_EXTERNAL_STICKERS: bit(37),
  SEND_MESSAGES_IN_THREADS: bit(38), MODERATE_MEMBERS: bit(40), USE_SOUNDBOARD: bit(42), CREATE_GUILD_EXPRESSIONS: bit(43),
  CREATE_EVENTS: bit(44), USE_EXTERNAL_SOUNDS: bit(45), SEND_VOICE_MESSAGES: bit(46), SEND_POLLS: bit(49),
};
export const ALL = Object.values(P).reduce((a, b) => a | b);
export const DEFAULT_PERMISSIONS = String(P.CREATE_INSTANT_INVITE | P.ADD_REACTIONS | P.STREAM | P.VIEW_CHANNEL | P.SEND_MESSAGES
  | P.ATTACH_FILES | P.READ_MESSAGE_HISTORY | P.CONNECT | P.SPEAK | P.CHANGE_NICKNAME
  | P.EMBED_LINKS | P.USE_EXTERNAL_EMOJIS | P.USE_APPLICATION_COMMANDS | P.REQUEST_TO_SPEAK | P.CREATE_PUBLIC_THREADS
  | P.CREATE_PRIVATE_THREADS | P.USE_EXTERNAL_STICKERS | P.SEND_MESSAGES_IN_THREADS | P.USE_SOUNDBOARD | P.USE_EXTERNAL_SOUNDS
  | P.SEND_VOICE_MESSAGES | P.SEND_POLLS);
// what each participant may do in a DM; pins are special-cased in the pin routes
const DM = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.READ_MESSAGE_HISTORY | P.ADD_REACTIONS | P.ATTACH_FILES | P.EMBED_LINKS
  | P.USE_EXTERNAL_EMOJIS | P.USE_EXTERNAL_STICKERS | P.SEND_VOICE_MESSAGES | P.SEND_POLLS;
// timed-out and pending (rules not yet accepted) members keep only these
const READ_ONLY = P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY;
const VOICE_ONLY = P.SPEAK | P.STREAM | P.MUTE_MEMBERS | P.DEAFEN_MEMBERS | P.MOVE_MEMBERS | P.PRIORITY_SPEAKER
  | P.REQUEST_TO_SPEAK | P.USE_SOUNDBOARD | P.USE_EXTERNAL_SOUNDS;

export const THREAD_TYPES = [10, 11, 12];
export const isThread = ch => THREAD_TYPES.includes(ch.type);
export const isVoice = ch => ch.type === 2 || ch.type === 13;
// channels that hold messages: text, DM, voice (text chat), announcement, threads, stage
export const MESSAGEABLE = [0, 1, 2, 3, 5, 10, 11, 12, 13];

export const has = (perms, bits) => (perms & bits) === bits;
export function need(perms, bits) {
  if (!has(perms, bits)) throw missingPermissions();
}

// a role permission or overwrite value from a request: decimal string or integer, unknown bits dropped
export function parseBits(value, field) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value) & ALL;
  if (typeof value === 'string' && /^\d{1,20}$/.test(value)) return BigInt(value) & ALL;
  throw invalid(field, 'NUMBER_TYPE_COERCE', 'Must be a permission bitfield.');
}

export const isTimedOut = m => !!m?.communication_disabled_until && m.communication_disabled_until > new Date().toISOString();

function base(guildId, userId) {
  const g = get(`SELECT g.owner_id, m.pending, m.communication_disabled_until FROM guilds g
                 JOIN members m ON m.guild_id = g.id AND m.user_id = ? WHERE g.id = ?`, userId, guildId);
  if (!g) return null;
  const roles = all('SELECT r.id, r.permissions FROM member_roles mr JOIN roles r ON r.id = mr.role_id AND r.guild_id = mr.guild_id WHERE mr.guild_id = ? AND mr.user_id = ?', guildId, userId);
  if (g.owner_id === userId) return { perms: ALL, admin: true, roles };
  let perms = BigInt(get('SELECT permissions FROM roles WHERE id = ?', guildId).permissions);
  for (const r of roles) perms |= BigInt(r.permissions);
  if (has(perms, P.ADMINISTRATOR)) return { perms: ALL, admin: true, roles };
  return { perms, admin: false, roles, restricted: !!g.pending || isTimedOut(g) };
}

// timed out or pending: may only read (owner and administrators are never restricted)
export const isRestricted = (guildId, userId) => !!base(guildId, userId)?.restricted;

export function guildPerms(guildId, userId) {
  const b = base(guildId, userId);
  if (!b) return 0n;
  return b.restricted ? b.perms & READ_ONLY : b.perms;
}

// base permissions with the channel's overwrites applied (the documented algorithm)
function overwritten(ch, b, userId, overwrites = all('SELECT * FROM overwrites WHERE channel_id = ?', ch.id)) {
  let perms = b.perms;
  const apply = matching => {
    let allow = 0n, deny = 0n;
    for (const o of matching) { allow |= BigInt(o.allow); deny |= BigInt(o.deny); }
    perms = (perms & ~deny) | allow;
  };
  const roleIds = new Set(b.roles.map(r => r.id));
  apply(overwrites.filter(o => o.target_id === ch.guild_id));
  apply(overwrites.filter(o => o.type === 0 && roleIds.has(o.target_id)));
  apply(overwrites.filter(o => o.type === 1 && o.target_id === userId));
  return perms;
}

export const isThreadMember = (threadId, userId) => !!get('SELECT 1 FROM thread_members WHERE channel_id = ? AND user_id = ?', threadId, userId);

export function channelPerms(ch, userId) {
  if (!ch.guild_id) return get('SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?', ch.id, userId) ? DM : 0n;
  // threads inherit the parent's permissions
  const thread = isThread(ch);
  const parent = thread ? get('SELECT * FROM channels WHERE id = ?', ch.parent_id) : ch;
  const b = parent && base(ch.guild_id, userId);
  if (!b) return 0n;
  if (b.admin) return ALL;
  let perms = overwritten(parent, b, userId);
  if (!has(perms, P.VIEW_CHANNEL)) return 0n;
  if (thread) {
    if (ch.type === 12 && !has(perms, P.MANAGE_THREADS) && !isThreadMember(ch.id, userId)) return 0n;
    // inside a thread SEND_MESSAGES means SEND_MESSAGES_IN_THREADS, so every send check reads the same bit
    perms = has(perms, P.SEND_MESSAGES_IN_THREADS) ? perms | P.SEND_MESSAGES : perms & ~P.SEND_MESSAGES;
  }
  if (b.restricted) perms &= READ_ONLY;
  if (!has(perms, P.SEND_MESSAGES)) perms &= ~(P.MENTION_EVERYONE | P.ATTACH_FILES | P.EMBED_LINKS | P.SEND_VOICE_MESSAGES | P.SEND_POLLS);
  if (isVoice(parent) && !has(perms, P.CONNECT)) perms &= ~VOICE_ONLY;
  return perms;
}

// who may VIEW the channel; the same decision as channelPerms (restriction and CONNECT never drop VIEW), but a fixed
// number of queries per event instead of several per member
export function viewersOf(ch) {
  if (!ch.guild_id) return all('SELECT user_id FROM dm_recipients WHERE channel_id = ?', ch.id).map(r => r.user_id);
  const parent = isThread(ch) ? get('SELECT * FROM channels WHERE id = ?', ch.parent_id) : ch;
  const owner = ownerOf(ch.guild_id);
  if (!parent || !owner) return [];
  const everyone = BigInt(get('SELECT permissions FROM roles WHERE id = ?', ch.guild_id)?.permissions ?? 0);
  const rolesOf = Map.groupBy(all(`SELECT mr.user_id, r.id, r.permissions FROM member_roles mr
    JOIN roles r ON r.id = mr.role_id AND r.guild_id = mr.guild_id WHERE mr.guild_id = ?`, ch.guild_id), r => r.user_id);
  const overwrites = all('SELECT * FROM overwrites WHERE channel_id = ?', parent.id);
  const inThread = ch.type === 12 && new Set(all('SELECT user_id FROM thread_members WHERE channel_id = ?', ch.id).map(r => r.user_id));
  return memberIds(ch.guild_id).filter(id => {
    if (id === owner) return true;
    const roles = rolesOf.get(id) ?? [];
    const perms = roles.reduce((p, r) => p | BigInt(r.permissions), everyone);
    if (has(perms, P.ADMINISTRATOR)) return true;
    const eff = overwritten(parent, { perms, roles }, id, overwrites);
    return has(eff, P.VIEW_CHANNEL) && (!inThread || has(eff, P.MANAGE_THREADS) || inThread.has(id));
  });
}

// the guild's channels (no threads) a member may VIEW; one query for all overwrites, for GUILD_CREATE and visibility diffs
export function visibleChannels(guildId, userId) {
  const b = base(guildId, userId);
  if (!b) return [];
  const chans = guildChannels(guildId);
  if (b.admin) return chans;
  const byChannel = Map.groupBy(all('SELECT o.* FROM overwrites o JOIN channels c ON c.id = o.channel_id WHERE c.guild_id = ?', guildId), o => o.channel_id);
  return chans.filter(c => has(overwritten(c, b, userId, byChannel.get(c.id) ?? []), P.VIEW_CHANNEL));
}

// guild members holding a guild-level permission
export const holders = (guildId, perm) => memberIds(guildId).filter(id => has(guildPerms(guildId, id), perm));

export const ownerOf = guildId => get('SELECT owner_id FROM guilds WHERE id = ?', guildId)?.owner_id;

export function rank(guildId, userId) {
  if (ownerOf(guildId) === userId) return Infinity;
  return get('SELECT MAX(r.position) AS p FROM member_roles mr JOIN roles r ON r.id = mr.role_id AND r.guild_id = mr.guild_id WHERE mr.guild_id = ? AND mr.user_id = ?', guildId, userId).p ?? 0;
}

// kick, ban, nickname and voice moderation: only members ranked strictly below; never the owner
export function requireAbove(guildId, actorId, targetId) {
  if (targetId === ownerOf(guildId) || rank(guildId, actorId) <= rank(guildId, targetId)) throw missingPermissions();
}

// roles: only those ranked strictly below the actor
export function requireRoleBelow(guildId, actorId, position) {
  if (position >= rank(guildId, actorId)) throw missingPermissions();
}

// a role the actor may hand out (member roles, onboarding, quarantine): of this guild, not @everyone, not managed, below the actor
export function requireAssignable(guildId, actorId, roleId, field = 'roles') {
  const role = get('SELECT position, managed FROM roles WHERE id = ? AND guild_id = ? AND id != guild_id', String(roleId), guildId);
  if (!role) throw notFound(10011, 'Role');
  if (role.managed) throw invalid(field, 'ROLE_MANAGED', 'Managed roles cannot be assigned or removed.');
  requireRoleBelow(guildId, actorId, role.position);
}
