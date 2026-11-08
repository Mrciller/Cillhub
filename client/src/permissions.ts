// Permission bits and the reference computation algorithm (CONTRACT-v2 section 1, CONTRACT-v3 section 0). The only place permissions are computed.
import type { Channel, Guild, Member, Role, ScheduledEvent } from './types'

const b = (n: number) => 1n << BigInt(n)
export const P = {
  CREATE_INSTANT_INVITE: b(0), KICK_MEMBERS: b(1), BAN_MEMBERS: b(2), ADMINISTRATOR: b(3),
  MANAGE_CHANNELS: b(4), MANAGE_GUILD: b(5), ADD_REACTIONS: b(6), VIEW_AUDIT_LOG: b(7), PRIORITY_SPEAKER: b(8), STREAM: b(9),
  VIEW_CHANNEL: b(10), SEND_MESSAGES: b(11), MANAGE_MESSAGES: b(13), EMBED_LINKS: b(14), ATTACH_FILES: b(15),
  READ_MESSAGE_HISTORY: b(16), MENTION_EVERYONE: b(17), USE_EXTERNAL_EMOJIS: b(18), CONNECT: b(20), SPEAK: b(21),
  MUTE_MEMBERS: b(22), DEAFEN_MEMBERS: b(23), MOVE_MEMBERS: b(24), CHANGE_NICKNAME: b(26),
  MANAGE_NICKNAMES: b(27), MANAGE_ROLES: b(28), MANAGE_WEBHOOKS: b(29), MANAGE_GUILD_EXPRESSIONS: b(30),
  USE_APPLICATION_COMMANDS: b(31), REQUEST_TO_SPEAK: b(32), MANAGE_EVENTS: b(33), MANAGE_THREADS: b(34),
  CREATE_PUBLIC_THREADS: b(35), CREATE_PRIVATE_THREADS: b(36), USE_EXTERNAL_STICKERS: b(37), SEND_MESSAGES_IN_THREADS: b(38),
  MODERATE_MEMBERS: b(40), USE_SOUNDBOARD: b(42), CREATE_GUILD_EXPRESSIONS: b(43), CREATE_EVENTS: b(44),
  USE_EXTERNAL_SOUNDS: b(45), SEND_VOICE_MESSAGES: b(46), SEND_POLLS: b(49),
} as const
export type PermName = keyof typeof P
export const ALL = Object.values(P).reduce((a, x) => a | x, 0n)

const big = (s: string | undefined) => BigInt(s || '0')
export const has = (perms: bigint, bit: bigint) => (perms & bit) === bit

export const THREAD_TYPES = new Set([10, 11, 12])
export const isThread = (c?: Channel) => !!c && THREAD_TYPES.has(c.type)
const VOICE_TYPES = new Set([2, 13])

/** Timed-out members keep only these (permissions.mdx, "Permissions For Timed Out Members"). Pending (rules screening) members too. */
const READ_ONLY = P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY

export const timedOutUntil = (m?: Member) => {
  const t = m?.communication_disabled_until ? Date.parse(m.communication_disabled_until) : 0
  return t > Date.now() ? t : 0
}

/** Guild-level permissions of a member (step 1). `member` may be undefined while members are not loaded yet. */
export function basePerms(guild: Guild, userId: string, member?: Member): bigint {
  if (guild.owner_id === userId) return ALL
  // A guild without an @everyone role (a v1 payload) gets the contract's default permissions.
  let base = big(guild.roles.find((r) => r.id === guild.id)?.permissions ?? '70356545')
  for (const r of guild.roles) if (member?.roles.includes(r.id)) base |= big(r.permissions)
  if (has(base, P.ADMINISTRATOR)) return ALL
  return timedOutUntil(member) || member?.pending ? base & READ_ONLY : base
}

/**
 * Channel permissions of a member (steps 2 and 3). Threads use their parent's overwrites, and inside a thread
 * SEND_MESSAGES is replaced by SEND_MESSAGES_IN_THREADS, so callers can keep checking SEND_MESSAGES.
 */
export function channelPerms(guild: Guild, userId: string, member: Member | undefined, channel: Channel, parent?: Channel): bigint {
  let p = basePerms(guild, userId, member)
  if (p === ALL) return ALL
  const thread = isThread(channel)
  const src = thread && parent ? parent : channel
  const ows = src.permission_overwrites ?? []
  const everyone = ows.find((o) => o.id === guild.id)
  if (everyone) p = (p & ~big(everyone.deny)) | big(everyone.allow)
  let allow = 0n
  let deny = 0n
  for (const o of ows) if (o.type === 0 && o.id !== guild.id && member?.roles.includes(o.id)) (allow |= big(o.allow)), (deny |= big(o.deny))
  p = (p & ~deny) | allow
  const own = ows.find((o) => o.type === 1 && o.id === userId)
  if (own) p = (p & ~big(own.deny)) | big(own.allow)
  if (timedOutUntil(member) || member?.pending) p &= READ_ONLY
  if (!has(p, P.VIEW_CHANNEL)) return 0n
  if (thread) {
    p = has(p, P.SEND_MESSAGES_IN_THREADS) ? p | P.SEND_MESSAGES : p & ~P.SEND_MESSAGES
    // A locked thread only takes messages from members with MANAGE_THREADS.
    if (channel.thread_metadata?.locked && !has(p, P.MANAGE_THREADS)) p &= ~P.SEND_MESSAGES
  }
  if (!has(p, P.SEND_MESSAGES)) p &= ~(P.MENTION_EVERYONE | P.ATTACH_FILES | P.EMBED_LINKS | P.SEND_VOICE_MESSAGES | P.SEND_POLLS)
  if (VOICE_TYPES.has(src.type) && !has(p, P.CONNECT))
    p &= ~(P.SPEAK | P.STREAM | P.MUTE_MEMBERS | P.DEAFEN_MEMBERS | P.MOVE_MEMBERS | P.PRIORITY_SPEAKER | P.REQUEST_TO_SPEAK | P.USE_SOUNDBOARD | P.USE_EXTERNAL_SOUNDS)
  return p
}

/** Highest role position; the owner ranks above everyone. */
export function rank(guild: Guild, userId: string, member?: Member): number {
  if (guild.owner_id === userId) return Infinity
  return Math.max(0, ...guild.roles.filter((r) => member?.roles.includes(r.id)).map((r) => r.position))
}

/** Can `me` act on `target` (kick, ban, nick, voice-moderate)? The owner can never be targeted. */
export const outranks = (guild: Guild, meId: string, me: Member | undefined, targetId: string, target?: Member) =>
  targetId !== guild.owner_id && targetId !== meId && rank(guild, meId, me) > rank(guild, targetId, target)

/** Timeouts also never apply to administrators. */
export const canTimeout = (guild: Guild, meId: string, me: Member | undefined, targetId: string, target?: Member) =>
  has(basePerms(guild, meId, me), P.MODERATE_MEMBERS) && outranks(guild, meId, me, targetId, target) && basePerms(guild, targetId, target ? { ...target, communication_disabled_until: null } : target) !== ALL

/** Roles `me` may edit, assign or remove: strictly below their own rank. */
export const canManageRole = (guild: Guild, meId: string, me: Member | undefined, role: Role) => rank(guild, meId, me) > role.position

/** Owner and administrators skip "only grant what you have". */
export const grantable = (guild: Guild, meId: string, me: Member | undefined) => {
  const p = basePerms(guild, meId, me)
  return has(p, P.ADMINISTRATOR) || p === ALL ? ALL : p
}

export const sortedRoles = (guild: Guild) => [...guild.roles].sort((a, b) => b.position - a.position || (a.id < b.id ? -1 : 1))

/** Slowmode does not apply to members who can manage messages or the channel. */
export const bypassesSlowmode = (p: bigint) => has(p, P.MANAGE_MESSAGES) || has(p, P.MANAGE_CHANNELS)

/** Stage moderators per CONTRACT-v3: MUTE_MEMBERS and MOVE_MEMBERS in the stage. */
export const isStageModerator = (p: bigint) => has(p, P.MUTE_MEMBERS) && has(p, P.MOVE_MEMBERS)

/** MANAGE_EVENTS edits any event; CREATE_EVENTS edits the events you created. */
export const canManageEvent = (p: bigint, e: ScheduledEvent, meId: string) => has(p, P.MANAGE_EVENTS) || (has(p, P.CREATE_EVENTS) && e.creator_id === meId)

/** MANAGE_GUILD_EXPRESSIONS edits any expression; CREATE_GUILD_EXPRESSIONS only your own uploads. */
export const canEditExpression = (p: bigint, uploaderId: string | undefined, meId: string) =>
  has(p, P.MANAGE_GUILD_EXPRESSIONS) || (has(p, P.CREATE_GUILD_EXPRESSIONS) && uploaderId === meId)

/** Role-restricted custom emoji: usable by the guild owner or members with one of its roles. */
export const canUseEmoji = (roles: string[] | undefined, member: Member | undefined, isOwner = false) => !roles?.length || isOwner || !!member?.roles.some((r) => roles.includes(r))

/** Ms left before verification level LOW (account 5 min old) or MEDIUM (5 min in the server) lets a member talk; members with roles skip it. */
export function verificationWait(guild: Guild, userId: string, member: Member | undefined, now = Date.now()) {
  const level = guild.verification_level ?? 0
  if (!level || guild.owner_id === userId || member?.roles.length) return 0
  const created = /^\d+$/.test(userId) ? Number(BigInt(userId) >> 22n) + 1420070400000 : 0
  const five = 5 * 60_000
  const wait = Math.max(0, created + five - now, level >= 2 && member ? Date.parse(member.joined_at) + five - now : 0)
  return Number.isFinite(wait) ? wait : 0
}

// Self-check of the algorithm on load in dev builds.
if (import.meta.env.DEV) {
  const g: Guild = { id: 'g', name: '', icon: null, owner_id: 'o', member_count: 0, roles: [
    { id: 'g', name: '@everyone', color: 0, hoist: false, position: 0, permissions: String(P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ATTACH_FILES | P.SEND_MESSAGES_IN_THREADS), mentionable: false },
    { id: 'r', name: 'Staff', color: 0, hoist: false, position: 1, permissions: String(P.KICK_MEMBERS), mentionable: false },
  ] }
  const m: Member = { user: { id: 'u', username: 'u', discriminator: '0', global_name: null, avatar: null }, nick: null, roles: ['r'], joined_at: '' }
  const ch: Channel = { id: 'c', type: 0, last_message_id: null, permission_overwrites: [
    { id: 'g', type: 0, allow: '0', deny: String(P.VIEW_CHANNEL | P.SEND_MESSAGES) }, { id: 'r', type: 0, allow: String(P.VIEW_CHANNEL), deny: '0' },
  ] }
  console.assert(channelPerms(g, 'u', m, ch) === (P.VIEW_CHANNEL | P.KICK_MEMBERS | P.SEND_MESSAGES_IN_THREADS), 'role overwrite re-allows view; no send drops attach')
  console.assert(channelPerms(g, 'x', undefined, ch) === 0n, 'no VIEW_CHANNEL means nothing')
  console.assert(channelPerms(g, 'o', undefined, ch) === ALL, 'owner has everything')
  console.assert(outranks(g, 'u', m, 'x') && !outranks(g, 'u', m, 'o'), 'hierarchy')
  const thread: Channel = { id: 't', type: 11, parent_id: 'c', last_message_id: null }
  console.assert(has(channelPerms(g, 'u', m, thread, ch), P.SEND_MESSAGES), 'threads use SEND_MESSAGES_IN_THREADS')
  const out = { ...m, communication_disabled_until: new Date(Date.now() + 60_000).toISOString() }
  console.assert(basePerms(g, 'u', out) === P.VIEW_CHANNEL, 'timed out keeps only view and history')
}

// ---------- v5 ----------
/** Watch Together: starting or queueing needs CONNECT + STREAM in the voice channel (CONTRACT-v5 section 1). */
export const canWatch = (p: bigint) => has(p, P.CONNECT) && has(p, P.STREAM)
/** Playback controls: the host, or everyone while `control` is "everyone". */
export const canControlWatch = (w: { host_id: string; control: string }, meId: string | undefined) => !!meId && (w.host_id === meId || w.control === 'everyone')
/** Switching who controls (and stopping): the host or MOVE_MEMBERS. */
export const canManageWatch = (p: bigint, w: { host_id: string }, meId: string | undefined) => (!!meId && w.host_id === meId) || has(p, P.MOVE_MEMBERS)
/** Voice channel status (CONTRACT-v5 section 6): MANAGE_CHANNELS, or connected to the channel with SEND_MESSAGES. */
export const canSetVoiceStatus = (p: bigint, connected: boolean) => has(p, P.MANAGE_CHANNELS) || (connected && has(p, P.SEND_MESSAGES))
