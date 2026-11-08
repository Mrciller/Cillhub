// Derived data: permissions, names, colors, unread. Pure functions over the store state plus small hooks.
import { channelPerms, basePerms, has, isThread, P } from './permissions'
import { cmpId, displayName, isPrivate, useStore, type State } from './store'
import { textColor } from './custom/render'
import type { Activity, Channel, ChannelOverride, Guild, Member, MuteConfig, WatchSession } from './types'

export const myMember = (s: State, guildId?: string) => {
  if (!guildId || !s.me) return undefined
  const real = s.members[guildId]?.[s.me.id]
  const sim = s.simulatedRoles?.[guildId]
  if (sim !== undefined) {
    return {
      user: s.me,
      nick: real?.nick ?? null,
      roles: sim,
      joined_at: real?.joined_at ?? '',
      pending: false,
      communication_disabled_until: null,
    }
  }
  return real
}

// DM calls (v4) allow joining, talking, camera and screen share.
const DM_PERMS = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.ATTACH_FILES | P.ADD_REACTIONS | P.READ_MESSAGE_HISTORY | P.EMBED_LINKS | P.USE_EXTERNAL_EMOJIS | P.USE_EXTERNAL_STICKERS | P.SEND_VOICE_MESSAGES | P.SEND_POLLS
  | P.CONNECT | P.SPEAK | P.STREAM | P.USE_APPLICATION_COMMANDS
function permsFor(guild: Guild | undefined, meId: string | undefined, member: Member | undefined, channel?: Channel, parent?: Channel, isSimulated = false) {
  if (!guild || !meId) return isPrivate(channel) ? DM_PERMS : 0n
  const effectiveUserId = isSimulated ? '__simulated__' : meId
  return channel ? channelPerms(guild, effectiveUserId, member, channel, parent) : basePerms(guild, effectiveUserId, member)
}
const parentOf = (s: State, c?: Channel) => (c && isThread(c) && c.parent_id ? s.channels[c.parent_id] : undefined)

/** Permissions of the current user in a guild, or in one of its channels (threads via their parent). DMs allow what a DM participant can do. */
export const permsOf = (s: State, guildId?: string, channel?: Channel) => {
  const isSim = !!(guildId && s.simulatedRoles?.[guildId] !== undefined)
  return permsFor(guildId ? s.guilds[guildId] : undefined, s.me?.id, myMember(s, guildId), channel, parentOf(s, channel), isSim)
}

/** Re-renders only when the inputs of the permission computation change. */
export function usePerms(guildId?: string, channelId?: string) {
  const guild = useStore((s) => (guildId ? s.guilds[guildId] : undefined))
  const channel = useStore((s) => (channelId ? s.channels[channelId] : undefined))
  const parent = useStore((s) => parentOf(s, channel))
  const member = useStore((s) => myMember(s, guildId))
  const meId = useStore((s) => s.me?.id)
  const isSim = useStore((s) => (guildId ? s.simulatedRoles?.[guildId] !== undefined : false))
  return permsFor(guild, meId, member, channel, parent, isSim)
}

export const can = (perms: bigint, bit: bigint) => has(perms, bit)

export const memberName = (s: State, guildId: string | undefined, userId: string) =>
  (guildId && s.members[guildId]?.[userId]?.nick) || displayName(s.users[userId])

const hex = (n: number) => '#' + n.toString(16).padStart(6, '0')
/** Text colour of the member's highest role that has one, readable on the current theme (v6: every theme, also custom ones). */
export function roleColor(guild: Guild | undefined, member: Member | undefined) {
  if (!guild || !member) return undefined
  const r = guild.roles.filter((x) => x.color && member.roles.includes(x.id)).sort((a, b) => b.position - a.position)[0]
  return r ? textColor(r.color) : undefined
}
export const colorOf = (n: number) => (n ? hex(n) : undefined)
/** A role colour used for text (names, role mentions): pushed to WCAG AA (4.5:1) on the current theme's surfaces. */
export const textColorOf = (n: number) => (n ? textColor(n) : undefined)

/** Channels with a message list: text, DM, voice and stage text chat, announcement, threads. */
export const CHAT_TYPES = new Set([0, 1, 2, 3, 5, 10, 11, 12, 13])
/** Voice-like channels (the sidebar lists them below text-like ones). */
export const VOICE_TYPES = new Set([2, 13])

// ---------- Notification settings (user docs: user_guild_settings) ----------
const activeMute = (muted: boolean | undefined, cfg: MuteConfig | undefined) => !!muted && (!cfg?.end_time || Date.parse(cfg.end_time) > Date.now())
export const guildSettingsKey = (c?: Channel) => c?.guild_id ?? '@me'
export const channelOverride = (s: State, guildId: string, channelId: string): ChannelOverride | undefined =>
  s.guildSettings[guildId]?.channel_overrides?.find((o) => o.channel_id === channelId)
export const isGuildMuted = (s: State, guildId: string) => activeMute(s.guildSettings[guildId]?.muted, s.guildSettings[guildId]?.mute_config)
/** A channel is muted by its own override or its category's (threads follow their parent). */
export function isChannelMuted(s: State, c: Channel): boolean {
  const g = guildSettingsKey(c)
  const o = channelOverride(s, g, c.id)
  if (activeMute(o?.muted, o?.mute_config)) return true
  const parent = c.parent_id ? s.channels[c.parent_id] : undefined
  return !!parent && isChannelMuted(s, parent)
}
/** Effective message_notifications for a channel: 0 all, 1 mentions, 2 nothing (override → category → guild → guild default). */
export function notifyLevel(s: State, c: Channel): number {
  if (isPrivate(c)) return 0
  const g = guildSettingsKey(c)
  for (let x: Channel | undefined = c; x; x = x.parent_id ? s.channels[x.parent_id] : undefined) {
    const o = channelOverride(s, g, x.id)
    if (o && o.message_notifications !== 3) return o.message_notifications
  }
  return s.guildSettings[g]?.message_notifications ?? (s.guilds[g] as { default_message_notifications?: number } | undefined)?.default_message_notifications ?? 0
}

export function isUnread(s: State, c: Channel) {
  if (!CHAT_TYPES.has(c.type) || !c.last_message_id) return false
  if (isChannelMuted(s, c)) return false // muted channels never look unread; mentions still badge
  if (isThread(c) && !c.member) return false // only joined threads count
  const read = s.readStates[c.id]?.last_message_id
  return !read || cmpId(c.last_message_id, read) > 0
}
export const mentionCount = (s: State, channelId: string) => s.readStates[channelId]?.mention_count ?? 0

const byPos = (a: Channel, b: Channel) => (a.position ?? 0) - (b.position ?? 0) || cmpId(a.id, b.id)
/** Text-like channels above voice channels. */
const inGroup = (a: Channel, b: Channel) => Number(VOICE_TYPES.has(a.type)) - Number(VOICE_TYPES.has(b.type)) || byPos(a, b)

export type SidebarGroup = { category: Channel | null; channels: Channel[] }
/** Channels the user can VIEW, in sidebar order: uncategorized first, then categories by position. */
export function sidebar(s: State, guildId: string, hideMuted = false): SidebarGroup[] {
  const all = Object.values(s.channels).filter((c) => c.guild_id === guildId && !isThread(c))
  const view = (c: Channel) => has(permsOf(s, guildId, c), P.VIEW_CHANNEL) && !(hideMuted && isChannelMuted(s, c) && !mentionCount(s, c.id))
  const cats = all.filter((c) => c.type === 4).sort(byPos)
  const catIds = new Set(cats.map((c) => c.id))
  const children = (id: string | null) => all.filter((c) => c.type !== 4 && (id ? c.parent_id === id : !c.parent_id || !catIds.has(c.parent_id)) && view(c)).sort(inGroup)
  const groups: SidebarGroup[] = [{ category: null, channels: children(null) }]
  for (const cat of cats) {
    const channels = children(cat.id)
    if (channels.length || view(cat)) groups.push({ category: cat, channels })
  }
  return groups
}
/** Where a guild opens without a channel in the URL: its system channel if visible, else the first text channel. */
export function firstText(s: State, guildId: string) {
  const list = sidebar(s, guildId).flatMap((g) => g.channels).filter((c) => c.type === 0 || c.type === 5)
  return list.find((c) => c.id === s.guilds[guildId]?.system_channel_id) ?? list[0]
}

export function guildBadge(s: State, guildId: string) {
  let unread = false
  let mentions = 0
  const muted = isGuildMuted(s, guildId) // a muted server shows no unread pill, only mention badges
  for (const g of sidebar(s, guildId))
    for (const c of [...g.channels, ...g.channels.flatMap((p) => sidebarThreads(s, p.id))]) {
      unread ||= !muted && isUnread(s, c)
      mentions += mentionCount(s, c.id)
    }
  return { unread, mentions }
}

/** Active (not archived) threads of a channel, newest first. */
export const activeThreads = (s: State, parentId: string) =>
  Object.values(s.channels).filter((c) => isThread(c) && c.parent_id === parentId && !c.thread_metadata?.archived).sort((a, b) => cmpId(b.id, a.id))

/** Threads listed under their parent in the sidebar: the ones you joined. Forum posts are not listed. */
export const sidebarThreads = (s: State, parentId: string) =>
  s.channels[parentId]?.type === 15 ? [] : activeThreads(s, parentId).filter((t) => t.member)

/** Guild emoji the current user may use in `guildId` (others' guilds need USE_EXTERNAL_EMOJIS), grouped per guild. */
export function usableEmojiGuilds(s: State, guildId: string | undefined, perms: bigint) {
  return Object.values(s.guilds)
    .filter((g) => g.emojis?.length && (g.id === guildId || has(perms, P.USE_EXTERNAL_EMOJIS)))
    .sort((a, b) => Number(b.id === guildId) - Number(a.id === guildId))
}

// ---------- v4 ----------
/** Name of a DM or group DM: its name, or the recipients' names. */
export const privateName = (s: State, c: Channel) =>
  c.type === 3 ? c.name || (c.recipients ?? []).map((u) => displayName(s.users[u.id] ?? u)).join(', ') || 'Unnamed' : displayName(c.recipients?.[0] && (s.users[c.recipients[0].id] ?? c.recipients[0]))

export const isBlocked = (s: State, userId: string) => s.relationships[userId]?.type === 2

/** Unread channels for the inbox and keyboard navigation: visible, not muted, newest first. */
export function unreadChannels(s: State) {
  const out: Channel[] = []
  for (const c of Object.values(s.channels)) {
    if (c.guild_id ? !s.guilds[c.guild_id] || !has(permsOf(s, c.guild_id, c), P.VIEW_CHANNEL) : !isPrivate(c)) continue
    if (isUnread(s, c) || mentionCount(s, c.id) > 0) out.push(c)
  }
  return out.sort((a, b) => cmpId(b.last_message_id ?? b.id, a.last_message_id ?? a.id))
}

/** Total for the tab title and favicon: mentions everywhere plus unread DMs. */
export function badgeCount(s: State) {
  let n = 0
  for (const id of Object.keys(s.readStates)) n += mentionCount(s, id)
  return n
}

const NO_ACTIVITIES: Activity[] = []
let ownKey: unknown
let ownList: Activity[] = NO_ACTIVITIES
let ownGame: unknown
/** Activities of a user; our own custom status comes from the synced settings (READY leaves our presence out). Stable references for useStore. */
export function userActivities(s: State, userId: string): Activity[] {
  if (userId !== s.me?.id) return s.activities[userId] ?? NO_ACTIVITIES
  const cs = s.settings.custom_status
  if (cs === ownKey && s.game === ownGame) return ownList
  ownKey = cs
  ownGame = s.game
  const live = cs && (cs.text || cs.emoji_name || cs.emoji_id) && !(cs.expires_at && Date.parse(cs.expires_at) <= Date.now())
  const custom: Activity[] = live ? [{ type: 4, name: 'Custom Status', state: cs.text, emoji: cs.emoji_id ? { id: cs.emoji_id, name: cs.emoji_name ?? '' } : cs.emoji_name ? { name: cs.emoji_name } : null }] : []
  const game: Activity[] = s.game ? [{ type: 0, name: s.game.name, timestamps: { start: s.game.start } }] : []
  ownList = custom.length || game.length ? [...custom, ...game] : NO_ACTIVITIES
  return ownList
}

/** Title of what a Watch Together session plays: the current video's title, else its queue entry's, else the id. */
export function watchTitle(w: WatchSession | undefined) {
  const cur = w?.current
  if (!cur) return ''
  return cur.title || w.queue.find((q) => q.video_id === cur.video_id)?.title || cur.video_id
}

/** Whether we may join this voice channel now: CONNECT, and room under `user_limit` unless MOVE_MEMBERS (CONTRACT-v2). */
export function canJoinVoice(s: State, guildId: string, c: Channel) {
  const p = permsOf(s, guildId, c)
  const n = Object.values(s.voiceStates[guildId] ?? {}).filter((v) => v.channel_id === c.id).length
  return has(p, P.CONNECT) && (!c.user_limit || n < c.user_limit || has(p, P.MOVE_MEMBERS))
}
