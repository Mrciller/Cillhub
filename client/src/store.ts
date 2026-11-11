import { useSyncExternalStore } from 'react'
import { instanceEvent } from './admin/instance'
import { nodeOf } from './instances/registry'
import { moduleUiEvent } from './modules/events'
import type { Anchor } from './components/menu'
import type { Activity, Call, Channel, ChannelCanvas, Component, Guild, GuildPayload, Member, Message, Poll, Presence, ReadState, Relationship, SavedMessage, ScheduledEvent, Sound, StageInstance, Status, User, UserGuildSettings, UserSettings, VoiceState, WatchSession } from './types'

export type VoiceStatus = 'idle' | 'waiting' | 'connecting' | 'connected' | 'unconfigured' | 'error'
export type VoiceLocal = {
  guildId: string | null; channelId: string | null; status: VoiceStatus; error: string
  selfMute: boolean; selfDeaf: boolean; video: boolean; stream: boolean
  speaking: Record<string, true> // user ids currently speaking (LiveKit active speakers)
  tracks: number // bumps when LiveKit tracks change so tiles re-render
  effects: Record<string, string> // user id -> emoji of the soundboard sound they just played (VOICE_CHANNEL_EFFECT_SEND, ~3 s)
}

export type ModalState =
  | { kind: 'server'; guildId: string; tab?: string }
  | { kind: 'channel'; channelId: string }
  | { kind: 'user'; tab?: string }
  | { kind: 'ban'; guildId: string; userId: string }
  | { kind: 'timeout'; guildId: string; userId: string }
  | { kind: 'create-channel'; guildId: string; parentId: string | null; type: 0 | 2 | 4 | 5 | 13 | 15 }
  | { kind: 'create-thread'; channelId: string; messageId?: string }
  | { kind: 'forward'; channelId: string; messageId: string }
  | { kind: 'events'; guildId: string; eventId?: string; edit?: boolean; create?: boolean }
  | { kind: 'welcome'; guildId: string }
  | { kind: 'rules'; guildId: string }
  | { kind: 'start-stage'; channelId: string }
  | { kind: 'follow'; channelId: string }
  // v4
  | { kind: 'profile'; userId: string; guildId?: string; tab?: string }
  | { kind: 'group-dm'; channelId?: string }
  | { kind: 'notifications'; guildId: string }
  | { kind: 'custom-status' }
  | { kind: 'quick-switcher' }
  | { kind: 'shortcuts' }
  | { kind: 'folder'; folderId: number }
  | { kind: 'interaction-modal'; data: InteractionModal }
  | { kind: 'whats-new' }
  | { kind: 'invite-user'; userId: string }
/** INTERACTION_MODAL_CREATE (user docs). */
export type InteractionModal = { id: string; channel_id: string; custom_id: string; title: string; components: Component[]; application?: { id: string; name: string }; nonce?: string | null }
/** A command or component interaction this client sent, by nonce: shows "Sending command…", "is thinking…" or the failure line. */
export type PendingInteraction = {
  nonce: string; id?: string; channelId: string; appId: string; kind: 'command' | 'component' | 'modal'; name?: string; messageId?: string; customId?: string
  state: 'sending' | 'sent' | 'failed'; at: number
}
export type Popout = { userId: string; guildId?: string; at: Anchor }
/** The right-hand panel next to the chat: a thread, or search results. */
export type Panel = { kind: 'thread'; channelId: string } | { kind: 'search'; guildId?: string; channelId?: string; query: string }
  | { kind: 'module'; guildId: string; moduleId: string; panelId: string } // v8: a module's channel_panel
  | { kind: 'canvas'; channelId: string } // v9: channel canvas shared notes
/** v8: a module's guild_sidebar panel shown in the main area instead of the chat. */
export type ModulePage = { guildId: string; moduleId: string; panelId: string }

export type State = {
  token: string | null
  status: 'connecting' | 'ready'
  sessionId: string | null
  me: User | null
  guilds: Record<string, Guild>
  channels: Record<string, Channel>
  users: Record<string, User>
  members: Record<string, Record<string, Member>> // guild id -> user id -> member (partial until loaded)
  membersLoaded: Record<string, boolean>
  presences: Record<string, Status>
  messages: Record<string, Message[]> // channel id -> oldest first; absent = not loaded
  hasMore: Record<string, boolean>
  typing: Record<string, Record<string, number>> // channel id -> user id -> expiry (ms)
  voiceStates: Record<string, Record<string, VoiceState>> // guild id -> user id -> state
  readStates: Record<string, ReadState>
  relationships: Record<string, Relationship>
  pinsVersion: Record<string, number>
  canvas: Record<string, ChannelCanvas>
  bansVersion: number
  editingId: string | null
  replying: { channelId: string; messageId: string } | null
  voice: VoiceLocal
  modal: ModalState | null
  popout: Popout | null
  showNav: boolean // narrow screens: show the server/channel nav instead of the chat
  // v3
  hasNewer: Record<string, boolean> // channel id -> newer messages exist past the loaded window (after a jump)
  jump: { channelId: string; messageId: string } | null // a message to scroll to once it is rendered
  panel: Panel | null
  stageInstances: Record<string, StageInstance> // channel id -> stage instance
  events: Record<string, ScheduledEvent>
  eventSubs: Record<string, true> // events the current user is interested in
  sounds: Record<string, Sound[]> // guild id -> soundboard sounds (absent = not loaded)
  threadMembersVersion: Record<string, number>
  slowmode: Record<string, number> // channel id -> time (ms) until the current user may send again
  updateReady: boolean // a newer build of the client is deployed (update.ts); survives READY and logins
  // v4
  settings: UserSettings // GET/PATCH /users/@me/settings, cached in localStorage so the theme applies before READY
  guildSettings: Record<string, UserGuildSettings> // guild id ('@me' for DMs) -> notification settings
  calls: Record<string, Call> // DM channel id -> active call
  activities: Record<string, Activity[]> // user id -> activities (custom status, bot "Playing …")
  interactions: Record<string, PendingInteraction>
  autocomplete: { nonce: string; choices: { name: string; value: string | number }[] } | null
  showMembers: boolean // member list (guilds) / recipient list (group DMs), remembered locally
  // v5
  watch: Record<string, WatchSession> // voice channel id -> Watch Together session
  game: { name: string; start: number } | null // our game, detected by the desktop app (window.cillcordDesktop); kept across READY
  leagueLobby: { active: boolean; partyId: string; queueId?: number; queueName: string; members: number; maxMembers: number; hostName: string; hostPuuid: string } | null
  reminders: Record<string, SavedMessage> // `${channel_id}-${message_id}` -> saved message with a reminder
  bookmarks: Record<string, SavedMessage> // `${channel_id}-${message_id}` -> saved message without a due date (bookmark)
  // v8
  modulePage: ModulePage | null
  // v13
  guideGuildId: string | null
  // v11
  drafts: Record<string, MessageDraft>
  dmRecipientReads: Record<string, Record<string, string>>
  purgeMode: boolean
  purgeSelected: Record<string, boolean>
  simulatedRoles: Record<string, string[]>
}

export type MessageDraft = { content: string; replyToId?: string; updatedAt: number }

const DRAFTS_KEY = 'cillcord:drafts'
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export function loadDrafts(): Record<string, MessageDraft> {
  try {
    const raw = localStorage.getItem(DRAFTS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as Record<string, MessageDraft>
    const now = Date.now()
    const clean: Record<string, MessageDraft> = {}
    let dirty = false
    for (const [k, v] of Object.entries(parsed)) {
      if (v && typeof v.content === 'string' && (v.content.trim() || v.replyToId) && now - (v.updatedAt || 0) < THIRTY_DAYS_MS) {
        clean[k] = v
      } else {
        dirty = true
      }
    }
    if (dirty) localStorage.setItem(DRAFTS_KEY, JSON.stringify(clean))
    return clean
  } catch {
    return {}
  }
}

let draftSaveTimeout: number | null = null
function persistDraftsDebounced(drafts: Record<string, MessageDraft>) {
  if (draftSaveTimeout) clearTimeout(draftSaveTimeout)
  draftSaveTimeout = window.setTimeout(() => {
    try {
      localStorage.setItem(DRAFTS_KEY, JSON.stringify(drafts))
    } catch {}
  }, 300)
}

export function setDraft(channelId: string, content: string, replyToId?: string) {
  const drafts = { ...state.drafts }
  if (!content.trim() && !replyToId) {
    if (channelId in drafts) {
      delete drafts[channelId]
      setState({ drafts })
      persistDraftsDebounced(drafts)
    }
    return
  }
  drafts[channelId] = { content, replyToId, updatedAt: Date.now() }
  setState({ drafts })
  persistDraftsDebounced(drafts)
}

export function clearDraft(channelId: string) {
  if (!(channelId in state.drafts)) return
  const drafts = { ...state.drafts }
  delete drafts[channelId]
  setState({ drafts })
  persistDraftsDebounced(drafts)
}

// Purge / Bulk Delete selection helpers (Task 6.1)
export const startPurgeMode = (initialMessageId?: string) =>
  setState({
    purgeMode: true,
    purgeSelected: initialMessageId ? { [initialMessageId]: true } : {},
  })

export const exitPurgeMode = () =>
  setState({ purgeMode: false, purgeSelected: {} })

export const togglePurgeSelect = (id: string, select?: boolean) =>
  setState((s) => {
    const cur = !!s.purgeSelected[id]
    const next = select !== undefined ? select : !cur
    const copy = { ...s.purgeSelected }
    if (next) {
      if (Object.keys(copy).length < 100) copy[id] = true
    } else {
      delete copy[id]
    }
    return { purgeSelected: copy }
  })

export const selectLastPurgeMessages = (channelId: string, count: number) =>
  setState((s) => {
    const list = s.messages[channelId] ?? []
    const toSelect = list.slice(-count)
    const copy: Record<string, boolean> = {}
    for (const m of toSelect) {
      copy[m.id] = true
    }
    return { purgeSelected: copy }
  })

export const idleVoice: VoiceLocal = { guildId: null, channelId: null, status: 'idle', error: '', selfMute: false, selfDeaf: false, video: false, stream: false, speaking: {}, tracks: 0, effects: {} }
const cachedSettings = (): UserSettings => {
  try { return JSON.parse(localStorage.getItem('user-settings') ?? '{}') } catch { return {} }
}
const empty = {
  guildSettings: {}, calls: {}, activities: {}, interactions: {}, autocomplete: null, watch: {}, reminders: {}, bookmarks: {}, modulePage: null, guideGuildId: null,
  drafts: loadDrafts(), dmRecipientReads: {}, purgeMode: false, purgeSelected: {}, simulatedRoles: {} as Record<string, string[]>,
  status: 'connecting', sessionId: null, me: null, guilds: {}, channels: {}, users: {}, members: {}, membersLoaded: {}, presences: {}, messages: {},
  hasMore: {}, typing: {}, voiceStates: {}, readStates: {}, relationships: {}, pinsVersion: {}, canvas: {}, bansVersion: 0, editingId: null, replying: null,
  voice: idleVoice, modal: null, popout: null, showNav: false,
  hasNewer: {}, jump: null, panel: null, stageInstances: {}, events: {}, eventSubs: {}, sounds: {}, threadMembersVersion: {}, slowmode: {},
} as const
let state: State = { ...empty, token: localStorage.getItem('token'), updateReady: false, settings: cachedSettings(), showMembers: localStorage.getItem('show-members') !== '0', game: null, leagueLobby: null }
const listeners = new Set<() => void>()

export const getState = () => state
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)) {
  state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) }
  listeners.forEach((l) => l())
}
export const setVoice = (patch: Partial<VoiceLocal>) => setState((s) => ({ voice: { ...s.voice, ...patch } }))
export const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))
/** The selector must return a value already in the state (no fresh arrays/objects). */
export const useStore = <T,>(sel: (s: State) => T) => useSyncExternalStore(subscribe, () => sel(state))

export function setToken(token: string | null) {
  if (token) localStorage.setItem('token', token)
  else localStorage.removeItem('token')
  setState({ ...empty, token, updateReady: state.updateReady, settings: token ? state.settings : {}, showMembers: state.showMembers, game: state.game })
  if (!token) localStorage.removeItem('user-settings')
}
/** A new token for the same session (password change, 2FA on/off): keeps everything else. */
export function replaceToken(token: string) {
  localStorage.setItem('token', token)
  setState({ token })
}
/** Our own settings changed (locally or USER_SETTINGS_UPDATE): merged and cached. */
export const toggleMembers = () => (localStorage.setItem('show-members', state.showMembers ? '0' : '1'), setState({ showMembers: !state.showMembers }))
export function mergeSettings(patch: UserSettings) {
  const settings = { ...state.settings, ...patch }
  localStorage.setItem('user-settings', JSON.stringify(settings))
  setState({ settings })
}

export const byId = <T extends { id: string }>(xs: T[]) => Object.fromEntries(xs.map((x) => [x.id, x]))
const omit = <T,>(r: Record<string, T>, key: string) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== key))
/** Snowflake order (node ids compare by their snowflake part). */
export const cmpId = (a: string, b: string) => {
  const x = a.slice(a.indexOf('~') + 1)
  const y = b.slice(b.indexOf('~') + 1)
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0)
}
export const displayName = (u?: User | null) => (u ? u.global_name || u.username : 'Unknown')
const byUser = (ps: Presence[]) => Object.fromEntries(ps.map((p) => [p.user.id, p.status]))
const activitiesOf = (ps: Presence[]) => Object.fromEntries(ps.filter((p) => p.activities).map((p) => [p.user.id, p.activities!]))
/** Voice states are kept per guild; DM and group DM calls (guild_id null) live under '@me'. */
export const voiceKey = (guildId: string | null | undefined) => guildId ?? '@me'
/** DM and group DM (type 1 and 3). */
export const isPrivate = (c?: { type: number }) => c?.type === 1 || c?.type === 3

/** Oldest-first merge; anything in `b` already in `a` is dropped. */
export function merge(a: Message[], b: Message[]) {
  const ids = new Set(a.map((m) => m.id))
  return [...a, ...b.filter((m) => !ids.has(m.id))]
}

function upsert(list: Message[], m: Message) {
  const i = list.findIndex((x) => x.id === m.id)
  if (i >= 0) return list.with(i, { ...list[i], ...m })
  const p = list.findIndex((x) => x.pending || x.failed) // keep unsent messages at the bottom
  return p < 0 || m.pending ? [...list, m] : list.toSpliced(p, 0, m)
}

function patchList(s: State, channelId: string, fn: (l: Message[]) => Message[]): Partial<State> {
  const list = s.messages[channelId]
  return list ? { messages: { ...s.messages, [channelId]: fn(list) } } : {}
}
const patchMessage = (s: State, channelId: string, id: string, fn: (m: Message) => Message) =>
  patchList(s, channelId, (l) => l.map((m) => (m.id === id ? fn(m) : m)))

const withMembers = (s: State, guildId: string, list: Member[]) => ({ ...s.members, [guildId]: { ...s.members[guildId], ...Object.fromEntries(list.map((m) => [m.user.id, m])) } })
const voiceByUser = (list: VoiceState[] = []) => Object.fromEntries(list.filter((v) => v.channel_id).map((v) => [v.user_id, v]))

function addGuild(s: State, { channels = [], members, presences, voice_states, threads = [], stage_instances, guild_scheduled_events, soundboard_sounds, watch_sessions, ...guild }: GuildPayload): Partial<State> {
  const extra = [...(members ?? []), ...(voice_states ?? []).flatMap((v) => (v.member ? [v.member] : []))]
  return {
    guilds: { ...s.guilds, [guild.id]: { ...guild, roles: guild.roles ?? [] } },
    channels: { ...s.channels, ...byId(channels), ...byId(threads.map((t) => ({ ...t, guild_id: guild.id }))) },
    stageInstances: stage_instances ? { ...Object.fromEntries(Object.entries(s.stageInstances).filter(([, i]) => i.guild_id !== guild.id)), ...Object.fromEntries(stage_instances.map((i) => [i.channel_id, i])) } : s.stageInstances,
    events: guild_scheduled_events ? { ...Object.fromEntries(Object.entries(s.events).filter(([, e]) => e.guild_id !== guild.id)), ...byId(guild_scheduled_events) } : s.events,
    sounds: soundboard_sounds ? { ...s.sounds, [guild.id]: soundboard_sounds } : s.sounds,
    members: withMembers(s, guild.id, extra),
    membersLoaded: members && members.length >= guild.member_count ? { ...s.membersLoaded, [guild.id]: true } : s.membersLoaded,
    // Joining while connected: READY never had these members' presences.
    presences: presences ? { ...s.presences, ...byUser(presences) } : s.presences,
    activities: presences ? { ...s.activities, ...activitiesOf(presences) } : s.activities,
    users: { ...s.users, ...byId(extra.map((m) => m.user)) },
    voiceStates: voice_states ? { ...s.voiceStates, [guild.id]: voiceByUser(voice_states) } : s.voiceStates,
    watch: watch_sessions ? { ...s.watch, ...Object.fromEntries(watch_sessions.map((w) => [w.channel_id, w])) } : s.watch,
  }
}

function removeGuild(s: State, id: string): Partial<State> {
  return {
    guilds: omit(s.guilds, id),
    channels: Object.fromEntries(Object.entries(s.channels).filter(([, c]) => c.guild_id !== id)),
    members: omit(s.members, id),
    membersLoaded: omit(s.membersLoaded, id),
    voiceStates: omit(s.voiceStates, id),
    stageInstances: Object.fromEntries(Object.entries(s.stageInstances).filter(([, i]) => i.guild_id !== id)),
    events: Object.fromEntries(Object.entries(s.events).filter(([, e]) => e.guild_id !== id)),
    panel: s.panel?.kind === 'thread' && s.channels[s.panel.channelId]?.guild_id === id ? null : s.panel,
  }
}

/** Does this message ping the current user (directly, via a role, @everyone/@here, or any DM message)? */
export function mentionsMe(s: State, m: Message) {
  const me = s.me
  if (!me || m.author.id === me.id) return false
  if (!m.guild_id && isPrivate(s.channels[m.channel_id])) return true
  const roles = (m.guild_id && s.members[m.guild_id]?.[me.id]?.roles) || []
  const gs = m.guild_id ? s.guildSettings[m.guild_id] : undefined
  return m.mentions.some((u) => u.id === me.id) || (!!m.mention_everyone && !gs?.suppress_everyone) || (!gs?.suppress_roles && !!m.mention_roles?.some((r) => roles.includes(r)))
}
const EPHEMERAL = 1 << 6

export const MAX_LIVE_MESSAGES = 2000
function addMessage(s: State, m: Message): Partial<State> {
  const ch = s.channels[m.channel_id]
  const typing = s.typing[m.channel_id]
  const mine = m.author.id === s.me?.id
  const rs = s.readStates[m.channel_id]
  let readStates = s.readStates
  if (!m.pending && ch && ch.last_message_id !== m.id && !s.messages[m.channel_id]?.some((x) => x.id === m.id)) {
    // Own messages are read; others that ping us count up like the server's mention_count. Ephemeral ones are only for us.
    if (mine || (m.flags ?? 0) & EPHEMERAL) readStates = { ...readStates, [ch.id]: { id: ch.id, last_message_id: m.id, mention_count: 0 } }
    else if (mentionsMe(s, m) && m.type !== 7) readStates = { ...readStates, [ch.id]: { id: ch.id, last_message_id: rs?.last_message_id ?? null, mention_count: (rs?.mention_count ?? 0) + 1 } }
  }
  const fresh = ch && !m.pending && (!ch.last_message_id || cmpId(m.id, ch.last_message_id) > 0)
  // A thread's counters are not dispatched per message; count new ones locally.
  let trimmed = false
  const counted = fresh && ch.thread_metadata ? { message_count: (ch.message_count ?? 0) + 1, total_message_sent: (ch.total_message_sent ?? 0) + 1 } : {}
  return {
    // While a jumped-to window is shown, new messages are not appended (there is a gap); "Jump to Present" loads them.
    ...(s.hasNewer[m.channel_id] && !m.pending && !mine ? {} : patchList(s, m.channel_id, (list) => {
      // Our own echo replaces the optimistic copy carrying the same nonce.
      const i = !m.pending && m.nonce ? list.findIndex((x) => x.pending !== undefined && x.nonce === m.nonce && x.id !== m.id) : -1
      const next = upsert(i < 0 ? list : list.toSpliced(i, 1), m)
      // A live channel keeps its newest messages only; older ones load again when scrolled to (a flood cannot fill memory).
      if (next.length <= MAX_LIVE_MESSAGES) return next
      trimmed = true
      return next.slice(-MAX_LIVE_MESSAGES)
    })),
    ...(trimmed ? { hasMore: { ...s.hasMore, [m.channel_id]: true } } : {}),
    channels: fresh ? { ...s.channels, [ch.id]: { ...ch, last_message_id: m.id, ...counted } } : s.channels,
    typing: typing?.[m.author.id] ? { ...s.typing, [m.channel_id]: omit(typing, m.author.id) } : s.typing,
    users: s.users[m.author.id] ? s.users : { ...s.users, [m.author.id]: m.author },
    readStates,
  }
}

/** Custom emoji are identified by id, Unicode emoji by name. */
export const emojiKey = (e: { id?: string | null; name?: string | null }) => e.id || e.name || ''

function react(s: State, d: { user_id: string; channel_id: string; message_id: string; emoji: { id?: string | null; name: string; animated?: boolean } }, add: boolean): Partial<State> {
  const me = d.user_id === s.me?.id
  return patchMessage(s, d.channel_id, d.message_id, (m) => {
    const list = m.reactions ?? []
    const r = list.find((x) => emojiKey(x.emoji) === emojiKey(d.emoji))
    if (me && (r?.me ?? false) === add) return m // our own optimistic change already applied
    if (add) return { ...m, reactions: r ? list.map((x) => (x === r ? { ...x, count: x.count + 1, me: x.me || me } : x)) : [...list, { emoji: { id: d.emoji.id ?? null, name: d.emoji.name, ...(d.emoji.animated && { animated: true }) }, count: 1, me }] }
    if (!r) return m
    return { ...m, reactions: r.count <= 1 ? list.filter((x) => x !== r) : list.map((x) => (x === r ? { ...x, count: x.count - 1, me: me ? false : x.me } : x)) }
  })
}

/** Poll vote events (MESSAGE_POLL_VOTE_ADD/REMOVE); our own optimistic votes are not counted twice. */
function vote(s: State, d: { user_id: string; channel_id: string; message_id: string; answer_id: number }, add: boolean): Partial<State> {
  const me = d.user_id === s.me?.id
  return patchMessage(s, d.channel_id, d.message_id, (m) => {
    if (!m.poll) return m
    const counts = m.poll.results?.answer_counts ?? []
    const c = counts.find((x) => x.id === d.answer_id)
    if (me && (c?.me_voted ?? false) === add) return m
    const next = c
      ? counts.map((x) => (x === c ? { ...x, count: Math.max(0, x.count + (add ? 1 : -1)), me_voted: me ? add : x.me_voted } : x))
      : add ? [...counts, { id: d.answer_id, count: 1, me_voted: me }] : counts
    return { ...m, poll: { ...m.poll, results: { is_finalized: m.poll.results?.is_finalized ?? false, answer_counts: next } } }
  })
}

/** Replaces our own votes on a poll locally (optimistic vote / unvote). */
export function setMyVotes(poll: Poll, ids: number[]): Poll {
  const counts = poll.answers.map((a) => {
    const c = poll.results?.answer_counts.find((x) => x.id === a.answer_id) ?? { id: a.answer_id, count: 0, me_voted: false }
    const want = ids.includes(a.answer_id)
    return want === c.me_voted ? c : { ...c, count: c.count + (want ? 1 : -1), me_voted: want }
  })
  return { ...poll, results: { is_finalized: false, answer_counts: counts } }
}

const patchChannel = (s: State, id: string, fn: (c: Channel) => Channel): Partial<State> => (s.channels[id] ? { channels: { ...s.channels, [id]: fn(s.channels[id]) } } : {})

function setVoiceState(s: State, v: VoiceState): Partial<State> {
  const key = voiceKey(v.guild_id)
  const g = s.voiceStates[key] ?? {}
  return {
    voiceStates: { ...s.voiceStates, [key]: v.channel_id ? { ...g, [v.user_id]: v } : omit(g, v.user_id) },
    ...(v.member && v.guild_id && { members: withMembers(s, v.guild_id, [v.member]), users: { ...s.users, [v.user_id]: v.member.user } }),
  }
}
export const savedKey = (d: { channel_id: string; message_id: string }) => `${d.channel_id}-${d.message_id}`
/** Voice states of one DM call. */
export const callStates = (s: State, channelId: string) => Object.values(s.voiceStates['@me'] ?? {}).filter((v) => v.channel_id === channelId)

const TYPING_MS = 10_000
function pruneTyping(channelId: string) {
  const t = state.typing[channelId]
  if (t) setState({ typing: { ...state.typing, [channelId]: Object.fromEntries(Object.entries(t).filter(([, exp]) => exp > Date.now())) } })
}

const updateGuild = (s: State, id: string, fn: (g: Guild) => Guild): Partial<State> => (s.guilds[id] ? { guilds: { ...s.guilds, [id]: fn(s.guilds[id]) } } : {})

/** What the hub's READY must keep: everything that belongs to linked nodes' servers (v7; their own READY replaces it). */
function nodePart(s: State) {
  const node = (id?: string | null) => !!nodeOf(id)
  const pick = <T,>(r: Record<string, T>, keep: (k: string, v: T) => boolean) => Object.fromEntries(Object.entries(r).filter(([k, v]) => keep(k, v)))
  const inNode = (channelId: string) => node(s.channels[channelId]?.guild_id)
  return {
    guilds: pick(s.guilds, node), channels: pick(s.channels, (_, c) => node(c.guild_id)), members: pick(s.members, node), membersLoaded: pick(s.membersLoaded, node),
    voiceStates: pick(s.voiceStates, node), sounds: pick(s.sounds, node), guildSettings: pick(s.guildSettings, node), readStates: pick(s.readStates, inNode),
    messages: pick(s.messages, inNode), hasMore: pick(s.hasMore, inNode), events: pick(s.events, (_, e) => node(e.guild_id)),
    stageInstances: pick(s.stageInstances, (_, i) => node(i.guild_id)), watch: pick(s.watch, inNode),
  }
}

/** Applies a gateway dispatch (REST results are fed through here too). */
export function apply(t: string, d: any) {
  const s = state
  switch (t) {
    case 'READY': {
      const dms: Channel[] = d.private_channels
      const guilds = d.guilds as GuildPayload[]
      const nodes = nodePart(s)
      const kept = Object.keys(nodes.guilds).length > 0
      let next: State = {
        ...s, ...empty, ...nodes, token: s.token, voice: s.voice, showNav: s.showNav, updateReady: s.updateReady, showMembers: s.showMembers, modal: s.modal, game: s.game, // the welcome screen opens before the post-invite READY
        status: 'ready', sessionId: d.session_id, me: d.user,
        channels: { ...nodes.channels, ...byId(dms) },
        users: { ...(kept ? s.users : {}), ...byId([...d.users, ...dms.flatMap((c) => c.recipients ?? []), ...(d.relationships ?? []).map((r: Relationship) => r.user), d.user]) },
        // READY (v9 shape) leaves our own presence out; an open session means we are online (or the persisted status).
        presences: { ...(kept ? s.presences : {}), ...byUser(d.presences), [d.user.id]: d.user_settings?.status ?? 'online' },
        activities: { ...(kept ? s.activities : {}), ...activitiesOf(d.presences ?? []) },
        settings: s.settings,
        guildSettings: { ...nodes.guildSettings, ...Object.fromEntries(((d.user_guild_settings?.entries ?? d.user_guild_settings ?? []) as UserGuildSettings[]).map((g) => [g.guild_id ?? '@me', g])) },
        readStates: { ...nodes.readStates, ...byId((d.read_state ?? []).filter((r: unknown) => r && typeof r === 'object')) },
        relationships: byId(d.relationships ?? []),
        dmRecipientReads: (() => {
          const m: Record<string, Record<string, string>> = {}
          for (const r of (d.recipient_read_states ?? []) as { channel_id: string; user_id: string; last_message_id: string }[]) {
            if (r?.channel_id && r.user_id && r.last_message_id) {
              m[r.channel_id] = m[r.channel_id] || {}
              m[r.channel_id][r.user_id] = r.last_message_id
            }
          }
          return m
        })(),
      }
      // A fresh session may have missed events, so cached history is dropped and refetched on view.
      for (const g of guilds) next = { ...next, ...addGuild(next, g) }
      setState(next)
      if (d.user_settings) mergeSettings(d.user_settings)
      return
    }
    case 'GUILD_CREATE':
      return setState(addGuild(s, d))
    case 'GUILD_UPDATE': {
      const { channels: _c, members: _m, voice_states: _v, presences: _p, ...g } = d as GuildPayload
      return setState(updateGuild(s, g.id, (old) => ({ ...old, ...g, roles: g.roles ?? old.roles })))
    }
    case 'GUILD_DELETE':
      return setState(removeGuild(s, d.id))
    case 'GUILD_ROLE_CREATE':
    case 'GUILD_ROLE_UPDATE':
      return setState(updateGuild(s, d.guild_id, (g) => ({ ...g, roles: [...g.roles.filter((r) => r.id !== d.role.id), d.role] })))
    case 'GUILD_ROLE_DELETE':
      return setState({
        ...updateGuild(s, d.guild_id, (g) => ({ ...g, roles: g.roles.filter((r) => r.id !== d.role_id) })),
        members: { ...s.members, [d.guild_id]: Object.fromEntries(Object.entries(s.members[d.guild_id] ?? {}).map(([k, m]) => [k, { ...m, roles: m.roles.filter((r) => r !== d.role_id) }])) },
      })
    case 'CHANNEL_CREATE':
    case 'CHANNEL_UPDATE':
      return setState({ channels: { ...s.channels, [d.id]: { ...s.channels[d.id], ...d } }, users: { ...s.users, ...byId(d.recipients ?? []) } })
    case 'CHANNEL_DELETE':
    case 'THREAD_DELETE':
      return setState({
        channels: Object.fromEntries(Object.entries(s.channels).filter(([k, c]) => k !== d.id && !(c.thread_metadata && c.parent_id === d.id))),
        panel: s.panel?.kind === 'thread' && (s.panel.channelId === d.id || s.channels[s.panel.channelId]?.parent_id === d.id) ? null : s.panel,
      })
    case 'THREAD_CREATE':
    case 'THREAD_UPDATE':
      return setState({ channels: { ...s.channels, [d.id]: { ...s.channels[d.id], ...d } } })
    case 'THREAD_LIST_SYNC': {
      const mine = Object.fromEntries((d.members ?? []).map((m: { id: string }) => [m.id, m]))
      return setState({ channels: { ...s.channels, ...byId((d.threads as Channel[]).map((t) => ({ ...s.channels[t.id], ...t, guild_id: d.guild_id, ...(mine[t.id] && { member: mine[t.id] }) }))) } })
    }
    case 'THREAD_MEMBER_UPDATE':
      return setState(patchChannel(s, d.id, (c) => ({ ...c, member: d })))
    case 'THREAD_MEMBERS_UPDATE': {
      const meId = s.me?.id
      const added = (d.added_members ?? []).find((m: { user_id: string }) => m.user_id === meId)
      const removed = (d.removed_member_ids ?? []).includes(meId)
      return setState({
        ...patchChannel(s, d.id, (c) => ({ ...c, member_count: d.member_count ?? c.member_count, ...(added && { member: added }), ...(removed && { member: undefined }) })),
        threadMembersVersion: { ...s.threadMembersVersion, [d.id]: (s.threadMembersVersion[d.id] ?? 0) + 1 },
      })
    }
    case 'STAGE_INSTANCE_CREATE':
    case 'STAGE_INSTANCE_UPDATE':
      return setState({ stageInstances: { ...s.stageInstances, [d.channel_id]: d } })
    case 'STAGE_INSTANCE_DELETE':
      return setState({ stageInstances: omit(s.stageInstances, d.channel_id) })
    case 'GUILD_SCHEDULED_EVENT_CREATE':
    case 'GUILD_SCHEDULED_EVENT_UPDATE':
      return setState({ events: { ...s.events, [d.id]: { ...s.events[d.id], ...d } } })
    case 'GUILD_SCHEDULED_EVENT_DELETE':
      return setState({ events: omit(s.events, d.id), eventSubs: omit(s.eventSubs, d.id) })
    case 'GUILD_SCHEDULED_EVENT_USER_ADD':
    case 'GUILD_SCHEDULED_EVENT_USER_REMOVE': {
      const add = t === 'GUILD_SCHEDULED_EVENT_USER_ADD'
      const id = d.guild_scheduled_event_id
      const e = s.events[id]
      const me = d.user_id === s.me?.id
      if (me && !!s.eventSubs[id] === add) return // our own optimistic change already applied
      return setState({
        events: e ? { ...s.events, [id]: { ...e, user_count: Math.max(0, (e.user_count ?? 0) + (add ? 1 : -1)) } } : s.events,
        eventSubs: me ? (add ? { ...s.eventSubs, [id]: true } : omit(s.eventSubs, id)) : s.eventSubs,
      })
    }
    case 'GUILD_EMOJIS_UPDATE':
      return setState(updateGuild(s, d.guild_id, (g) => ({ ...g, emojis: d.emojis })))
    case 'GUILD_STICKERS_UPDATE':
      return setState(updateGuild(s, d.guild_id, (g) => ({ ...g, stickers: d.stickers })))
    case 'GUILD_SOUNDBOARD_SOUND_CREATE':
    case 'GUILD_SOUNDBOARD_SOUND_UPDATE': {
      const list = s.sounds[d.guild_id]
      return list ? setState({ sounds: { ...s.sounds, [d.guild_id]: [...list.filter((x) => x.sound_id !== d.sound_id), d] } }) : undefined
    }
    case 'GUILD_SOUNDBOARD_SOUND_DELETE': {
      const list = s.sounds[d.guild_id]
      return list ? setState({ sounds: { ...s.sounds, [d.guild_id]: list.filter((x) => x.sound_id !== d.sound_id) } }) : undefined
    }
    case 'GUILD_SOUNDBOARD_SOUNDS_UPDATE':
    case 'SOUNDBOARD_SOUNDS':
      return setState({ sounds: { ...s.sounds, [d.guild_id]: d.soundboard_sounds } })
    case 'MESSAGE_POLL_VOTE_ADD':
    case 'MESSAGE_POLL_VOTE_REMOVE':
      return setState(vote(s, d, t === 'MESSAGE_POLL_VOTE_ADD'))
    case 'MESSAGE_REACTION_REMOVE_ALL':
      return setState(patchMessage(s, d.channel_id, d.message_id, (m) => ({ ...m, reactions: [] })))
    case 'MESSAGE_REACTION_REMOVE_EMOJI':
      return setState(patchMessage(s, d.channel_id, d.message_id, (m) => ({ ...m, reactions: (m.reactions ?? []).filter((r) => emojiKey(r.emoji) !== emojiKey(d.emoji)) })))
    case 'CHANNEL_PINS_UPDATE':
      return setState({ pinsVersion: { ...s.pinsVersion, [d.channel_id]: (s.pinsVersion[d.channel_id] ?? 0) + 1 } })
    case 'CHANNEL_CANVAS_UPDATE':
      return setState({ canvas: { ...s.canvas, [d.channel_id]: d } })
    case 'MESSAGE_CREATE': {
      try { window.dispatchEvent(new CustomEvent('cillcord:message_create', { detail: d })) } catch {}
      return setState(addMessage(s, d))
    }
    case 'MESSAGE_UPDATE':
      return setState(patchList(s, d.channel_id, (l) => l.map((m) => (
        m.id === d.id ? { ...m, ...d }
        : m.referenced_message?.id === d.id ? { ...m, referenced_message: { ...m.referenced_message, ...d } }
        : m
      ))))
    case 'MESSAGE_DELETE':
      return setState({
        ...patchList(s, d.channel_id, (l) => l.filter((m) => m.id !== d.id).map((m) => (m.message_reference?.message_id === d.id && m.referenced_message ? { ...m, referenced_message: null } : m))),
        ...(s.editingId === d.id && { editingId: null }),
        ...(s.replying?.messageId === d.id && { replying: null }),
      })
    case 'MESSAGE_DELETE_BULK':
      return setState({
        ...patchList(s, d.channel_id, (l) => l.filter((m) => !d.ids.includes(m.id)).map((m) => (m.message_reference?.message_id && d.ids.includes(m.message_reference.message_id) && m.referenced_message ? { ...m, referenced_message: null } : m))),
        ...(s.editingId && d.ids.includes(s.editingId) && { editingId: null }),
        ...(s.replying && d.ids.includes(s.replying.messageId) && { replying: null }),
      })
    case 'MESSAGE_REACTION_ADD':
    case 'MESSAGE_REACTION_REMOVE':
      return setState(react(s, d, t === 'MESSAGE_REACTION_ADD'))
    case 'CHANNEL_RECIPIENT_ACK': {
      const { channel_id, user_id, message_id } = d as { channel_id: string; user_id: string; message_id: string }
      if (!channel_id || !user_id || !message_id) return
      const cur = s.dmRecipientReads[channel_id] ?? {}
      return setState({ dmRecipientReads: { ...s.dmRecipientReads, [channel_id]: { ...cur, [user_id]: message_id } } })
    }
    case 'MESSAGE_ACK': {
      if (d.user_id && d.user_id !== s.me?.id && d.channel_id && d.message_id) {
        const cur = s.dmRecipientReads[d.channel_id] ?? {}
        setState({ dmRecipientReads: { ...s.dmRecipientReads, [d.channel_id]: { ...cur, [d.user_id]: d.message_id } } })
      }
      return setState({ readStates: { ...s.readStates, [d.channel_id]: { id: d.channel_id, last_message_id: d.message_id, mention_count: 0 } } })
    }
    case 'GUILD_MEMBER_ADD':
    case 'GUILD_MEMBER_UPDATE': {
      const { guild_id, ...m } = d as Member & { guild_id: string }
      const old = s.members[guild_id]?.[m.user.id]
      return setState({ users: { ...s.users, [m.user.id]: m.user }, members: withMembers(s, guild_id, [{ ...old, ...m }]) })
    }
    case 'GUILD_MEMBER_REMOVE': {
      if (d.user.id === s.me?.id) return setState(removeGuild(s, d.guild_id))
      return setState({
        members: { ...s.members, [d.guild_id]: omit(s.members[d.guild_id] ?? {}, d.user.id) },
        voiceStates: { ...s.voiceStates, [d.guild_id]: omit(s.voiceStates[d.guild_id] ?? {}, d.user.id) },
      })
    }
    case 'GUILD_BAN_ADD':
    case 'GUILD_BAN_REMOVE':
      return setState({ bansVersion: s.bansVersion + 1 })
    case 'USER_UPDATE':
      return setState({ users: { ...s.users, [d.id]: { ...s.users[d.id], ...d } }, me: s.me?.id === d.id ? { ...s.me, ...d } : s.me })
    case 'RELATIONSHIP_ADD':
      return setState({ relationships: { ...s.relationships, [d.id]: d }, users: { ...s.users, [d.user.id]: d.user } })
    case 'RELATIONSHIP_REMOVE':
      return setState({ relationships: omit(s.relationships, d.id) })
    case 'VOICE_STATE_UPDATE':
      return setState(setVoiceState(s, d))
    case 'PRESENCE_UPDATE':
      return setState({ presences: { ...s.presences, [d.user.id]: d.status }, ...(d.activities && { activities: { ...s.activities, [d.user.id]: d.activities } }) })
    // ---------- v4 ----------
    case 'USER_SETTINGS_UPDATE':
      return mergeSettings(d)
    case 'USER_GUILD_SETTINGS_UPDATE':
      return setState({ guildSettings: { ...s.guildSettings, [d.guild_id ?? '@me']: d } })
    case 'CALL_CREATE': {
      const { voice_states = [], ...call } = d
      let next: Partial<State> = { calls: { ...s.calls, [d.channel_id]: { ringing: [], ...call } } }
      for (const v of voice_states as VoiceState[]) next = { ...next, ...setVoiceState({ ...s, ...next }, { ...v, guild_id: null }) }
      return setState(next)
    }
    case 'CALL_UPDATE':
      return setState({ calls: { ...s.calls, [d.channel_id]: { ...s.calls[d.channel_id], ...d } } })
    case 'CALL_DELETE': {
      const left = Object.fromEntries(Object.entries(s.voiceStates['@me'] ?? {}).filter(([, v]) => v.channel_id !== d.channel_id))
      return setState({ calls: omit(s.calls, d.channel_id), voiceStates: { ...s.voiceStates, '@me': left } })
    }
    case 'CHANNEL_RECIPIENT_ADD':
    case 'CHANNEL_RECIPIENT_REMOVE': {
      const add = t === 'CHANNEL_RECIPIENT_ADD'
      if (!add && d.user.id === s.me?.id) return setState({ channels: omit(s.channels, d.channel_id) })
      return setState({
        ...patchChannel(s, d.channel_id, (c) => ({ ...c, recipients: [...(c.recipients ?? []).filter((u) => u.id !== d.user.id), ...(add ? [d.user] : [])] })),
        users: add ? { ...s.users, [d.user.id]: { ...s.users[d.user.id], ...d.user } } : s.users,
      })
    }
    case 'RELATIONSHIP_UPDATE':
      return setState({ relationships: { ...s.relationships, [d.id]: { ...s.relationships[d.id], ...d } } })
    case 'INTERACTION_CREATE':
    case 'INTERACTION_SUCCESS':
    case 'INTERACTION_FAILURE': {
      const p = d.nonce ? s.interactions[d.nonce] : Object.values(s.interactions).find((x) => x.id === d.id)
      if (!p) return
      if (t === 'INTERACTION_SUCCESS') return setState({ interactions: omit(s.interactions, p.nonce) })
      return setState({ interactions: { ...s.interactions, [p.nonce]: { ...p, id: d.id, state: t === 'INTERACTION_FAILURE' ? 'failed' : 'sent' } } })
    }
    case 'GUILD_APPLICATION_COMMAND_INDEX_UPDATE':
      // commands of an app changed (a module was disabled, a bot registered some): actions.ts drops its cached index
      return void dispatchEvent(new CustomEvent('cillcord:command-index', { detail: d.guild_id }))
    case 'APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE':
      return setState({ autocomplete: { nonce: d.nonce, choices: d.choices ?? [] } })
    case 'INTERACTION_MODAL_CREATE':
      return setState({ modal: { kind: 'interaction-modal', data: d }, ...(d.nonce && s.interactions[d.nonce] && { interactions: omit(s.interactions, d.nonce) }) })
    // ---------- v5 ----------
    case 'WATCH_SESSION_UPDATE':
      // A session without a host (or flagged ended) is over; the contract only promises full states.
      return setState({ watch: !d.host_id || d.ended ? omit(s.watch, d.channel_id) : { ...s.watch, [d.channel_id]: d } })
    case 'WATCH_SESSION_DELETE':
      return setState({ watch: omit(s.watch, d.channel_id) })
    case 'VOICE_CHANNEL_STATUS_UPDATE':
      return setState(patchChannel(s, d.id, (c) => ({ ...c, status: d.status || null })))
    case 'SAVED_MESSAGE_CREATE':
    case 'SAVED_MESSAGE_UPDATE':
    case 'MESSAGE_REMINDER_DUE': { // the server's due event carries the saved message; reminders.ts notifies once per due_at
      const k = savedKey(d.save_data)
      return d.save_data?.due_at
        ? setState({ reminders: { ...s.reminders, [k]: d }, bookmarks: omit(s.bookmarks, k) })
        : setState({ bookmarks: { ...s.bookmarks, [k]: d }, reminders: omit(s.reminders, k) })
    }
    case 'SAVED_MESSAGE_DELETE': {
      const k = savedKey(d.save_data ?? d)
      return setState({ reminders: omit(s.reminders, k), bookmarks: omit(s.bookmarks, k) })
    }
    case 'INSTANCE_SETTINGS_UPDATE':
    case 'INSTANCE_ANNOUNCEMENT':
      return instanceEvent(t, d)
    // ---------- v8 ----------
    case 'GUILD_MODULE_PANELS_UPDATE':
      return setState(updateGuild(s, d.guild_id, (g) => ({ ...g, module_panels: d.module_panels ?? [] })))
    case 'MODULE_UI_EVENT':
      return moduleUiEvent(d)
    case 'TYPING_START': {
      if (d.user_id === s.me?.id) return
      setState({ typing: { ...s.typing, [d.channel_id]: { ...s.typing[d.channel_id], [d.user_id]: Date.now() + TYPING_MS } } })
      setTimeout(() => pruneTyping(d.channel_id), TYPING_MS)
    }
  }
}
