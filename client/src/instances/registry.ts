// Other Cillhub instances (CONTRACT-v7 §4): linked nodes the user signed in to from the hub client. Pure bookkeeping, no
// React and no store import (api.ts and store.ts both use it): the saved list and per-instance tokens, the live status of
// each node connection, which snowflakes belong to which node (so REST calls and CDN paths go to the right origin), and
// the id aliasing between our node account and our hub account.
//
// Why aliasing: a node creates its own linked account for us (a different user id) and its own gateway session id. The
// client keeps one store with one `me`, so node payloads have our node user id and session id replaced by the hub ones on
// the way in, and the reverse on the way out. Everything that compares with `me.id` (permissions, own messages, mentions,
// voice) then works on node servers without being instance-aware.
import { useSyncExternalStore } from 'react'

export type InstanceInfo = { id: string; name: string; url: string; icon?: string | null }
/** connecting → ready; offline = the node does not answer (retrying); suspended = suspended, banned or unlinked by the hub; signed-out = the node refused our token. */
export type InstanceStatus = 'connecting' | 'ready' | 'offline' | 'suspended' | 'signed-out'
export type Live = InstanceInfo & { status: InstanceStatus; meId: string | null; sessionId: string | null }

const KEY = 'instances'
const tokenKey = (id: string) => `instance-token:${id}`
const load = (): InstanceInfo[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((i) => i && typeof i.id === 'string' && /^https?:\/\//.test(i.url)) : []
  } catch { return [] }
}

let live: Record<string, Live> = Object.fromEntries(load().map((i) => [i.id, { ...i, status: 'connecting', meId: null, sessionId: null }]))
const hub = { meId: '', sessionId: '' }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const persist = () => localStorage.setItem(KEY, JSON.stringify(Object.values(live).map(({ id, name, url, icon }) => ({ id, name, url, icon }))))

export const subscribeInstances = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))
/** All saved instances with their live status (a new object on every change). */
export const useInstances = () => useSyncExternalStore(subscribeInstances, () => live)
export const instances = () => Object.values(live)
export const instanceById = (id: string | undefined): Live | undefined => (id ? live[id] : undefined)
export const tokenOf = (id: string) => localStorage.getItem(tokenKey(id))

export function saveInstance(info: InstanceInfo, token: string) {
  localStorage.setItem(tokenKey(info.id), token)
  live = { ...live, [info.id]: { ...live[info.id], ...info, status: 'connecting', meId: live[info.id]?.meId ?? null, sessionId: live[info.id]?.sessionId ?? null } }
  persist()
  emit()
}
export function removeInstance(id: string) {
  localStorage.removeItem(tokenKey(id))
  const { [id]: _, ...rest } = live
  live = rest
  for (const [k, o] of owners) if (o.by === id) owners.delete(k)
  claimed.delete(id)
  persist()
  emit()
}
export function setLive(id: string, patch: Partial<Live>) {
  if (!live[id]) return
  live = { ...live, [id]: { ...live[id], ...patch } }
  emit()
}
// Saved private nodes that are not connected, by origin (Settings › Private Nodes): 'own-login' = the node does not take
// this hub's accounts; 'sign-in' = it cannot sign in in the background (older version), a click opens the sign-in window;
// any other text = why the last try failed (retrying).
export type NodeIssue = { why: string; node?: InstanceInfo }
let issues: Record<string, NodeIssue> = {}
export function setIssue(origin: string, issue: NodeIssue | null) {
  const { [origin]: _, ...rest } = issues
  issues = issue ? { ...rest, [origin]: issue } : rest
  emit()
}
export const useNodeIssues = () => useSyncExternalStore(subscribeInstances, () => issues)

/** Our hub user and gateway session (from the hub's READY); node payloads are aliased to these. */
export const setHubIdentity = (meId: string, sessionId: string) => ((hub.meId = meId), (hub.sessionId = sessionId))

// ---------- Who an id belongs to ----------
// Kept apart from the store (a deleted channel stays the hub's). '' = the hub: hub claims win over node claims and are made
// on every hub ingestion path (hubSaw). A node claims only ids of objects it was allowed to introduce, typed, first come;
// it can never take an id the hub or another node holds.
export type Kind = 'guild' | 'channel' | 'emoji' | 'sticker' | 'role' | 'event' | 'sound' | 'user'
const owners = new Map<string, { by: string; kind: Kind }>()
const claimed = new Map<string, number>() // instance -> ids it holds
export const MAX_IDS = 100_000
const ownerOf = (id: unknown) => (typeof id === 'string' ? owners.get(id)?.by : undefined)
export function hubTakes(id: unknown, kind: Kind) {
  if (typeof id !== 'string' || !id) return
  const o = owners.get(id)
  if (o?.by) claimed.set(o.by, (claimed.get(o.by) ?? 1) - 1)
  owners.set(id, { by: '', kind })
}
function claim(inst: string, id: string, kind: Kind) {
  const by = ownerOf(id)
  if (by !== undefined) return by === inst
  const n = claimed.get(inst) ?? 0
  if (n >= MAX_IDS) return false
  owners.set(id, { by: inst, kind })
  claimed.set(inst, n + 1)
  return true
}

/** The node a snowflake (guild, channel, user, emoji…) belongs to; undefined = the hub (or nobody). */
export const nodeOf = (id: string | null | undefined) => ownerOf(id) || undefined

// User objects sit under these keys (alone, in lists, or as an id-keyed map like resolved.users).
const USER_KEYS = new Set(['user', 'author', 'users', 'recipients', 'mentions', 'creator', 'target_user'])
const userObjects = (d: unknown, out: { id?: unknown }[] = [], depth = 0): { id?: unknown }[] => {
  if (!d || typeof d !== 'object' || depth > 40) return out
  for (const [k, v] of Object.entries(d)) {
    if (USER_KEYS.has(k) && v && typeof v === 'object') {
      for (const u of Array.isArray(v) ? v : 'id' in v ? [v] : Object.values(v)) if (u && typeof u === 'object') out.push(u)
    }
    userObjects(v, out, depth + 1)
  }
  return out
}

/** What the hub showed us: its guilds, channels, threads, emojis, stickers, roles, events, sounds and users are the hub's for good. */
export function hubSaw(t: string, d: any) {
  if (!d || typeof d !== 'object') return
  const guild = (g: any) => {
    if (!g?.id) return
    hubTakes(g.id, 'guild')
    for (const c of [...(g.channels ?? []), ...(g.threads ?? [])]) hubTakes(c?.id, 'channel')
    for (const e of g.emojis ?? []) hubTakes(e?.id, 'emoji')
    for (const x of g.stickers ?? []) hubTakes(x?.id, 'sticker')
    for (const r of g.roles ?? []) hubTakes(r?.id, 'role')
    for (const e of g.guild_scheduled_events ?? []) hubTakes(e?.id, 'event')
  }
  if (t === 'READY') (d.guilds ?? []).forEach(guild), (d.private_channels ?? []).forEach((c: any) => hubTakes(c?.id, 'channel')), hubTakes(d.user?.id, 'user')
  else if (t === 'GUILD_CREATE' || t === 'GUILD_UPDATE') guild(d)
  else if (['CHANNEL_CREATE', 'CHANNEL_UPDATE', 'THREAD_CREATE', 'THREAD_UPDATE'].includes(t)) hubTakes(d.id, 'channel')
  else if (t === 'THREAD_LIST_SYNC') (d.threads ?? []).forEach((c: any) => hubTakes(c?.id, 'channel'))
  else if (t === 'GUILD_EMOJIS_UPDATE') (d.emojis ?? []).forEach((e: any) => hubTakes(e?.id, 'emoji'))
  else if (t === 'GUILD_STICKERS_UPDATE') (d.stickers ?? []).forEach((e: any) => hubTakes(e?.id, 'sticker'))
  else if (t === 'GUILD_ROLE_CREATE' || t === 'GUILD_ROLE_UPDATE') hubTakes(d.role?.id, 'role')
  else if (t.startsWith('GUILD_SCHEDULED_EVENT_') && !t.includes('USER')) hubTakes(d.id, 'event')
  for (const u of userObjects(d)) hubTakes(u.id, 'user')
}

// Root-relative URLs in node payloads point at the node: made absolute on the way in (attachments, embeds, voice endpoint).
const URL_KEYS = new Set(['url', 'proxy_url', 'icon_url', 'proxy_icon_url', 'avatar_url', 'sound_url', 'endpoint'])
// Media the client loads by itself (attachments, entrance sounds, webhook avatars) must come from the node's own origin.
const MEDIA_KEYS = new Set(['avatar_url', 'sound_url'])
const onNode = (n: Live, a: unknown) => {
  const u = (a as { url?: unknown } | null)?.url
  return typeof u !== 'string' || u.startsWith(n.url + '/') || (u.startsWith('/') && !u.startsWith('//'))
}
const swapMentions = (s: string, from: string, to: string) => (from && s.includes(from) ? s.replaceAll(`<@${from}>`, `<@${to}>`).replaceAll(`<@!${from}>`, `<@${to}>`) : s)

/** Our node ids aliased to the hub ones, root-relative URLs made absolute, foreign media dropped. */
function inbound<T>(n: Live, data: T): T {
  const walk = (x: unknown, key = ''): unknown => {
    if (typeof x === 'string') {
      if (n.meId && x === n.meId) return hub.meId || x
      if (n.sessionId && x === n.sessionId) return hub.sessionId || x
      if (URL_KEYS.has(key) && x.startsWith('/') && !x.startsWith('//')) return n.url + x
      // A node's media proxy is its own: any other host would load (and see our IP) from wherever the node points.
      if ((key.startsWith('proxy_') || MEDIA_KEYS.has(key)) && !x.startsWith(n.url + '/')) return undefined
      return n.meId && hub.meId ? swapMentions(x, n.meId, hub.meId) : x
    }
    if (Array.isArray(x)) return x.map((v) => walk(v, key))
    if (!x || typeof x !== 'object') return x
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(x)) out[k] = walk(k === 'attachments' && Array.isArray(v) ? v.filter((a) => onNode(n, a)) : v, k)
    return out
  }
  return walk(data) as T
}

// ---------- The boundary: every node gateway event, node READY and node REST answer passes admit() ----------
// A node is untrusted input: bounded size and shape, numeric snowflake ids only (else the whole payload is dropped), and it
// may only touch guilds and channels it owns. Account-wide things (settings, friends, DMs, calls, read state of foreign
// channels, instance notices) are the hub's whatever fields an event carries.
const SNOW = /^\d{1,20}$/
const FREE_IDS = new Set(['custom_id', 'session_id', 'video_id', 'panel_id', 'module_id', 'sku_id', 'folder_id']) // not snowflakes
const FREE_TREES = new Set(['activities', 'components']) // free-form ids inside
export const LIMITS = { depth: 32, list: 10_000, nodes: 500_000 }
/** Bounded nesting, list lengths and size; every `id`, `*_id` and `*_ids` a numeric snowflake (or null). */
export function wellFormed(d: unknown): boolean {
  let count = 0
  const ok = (x: unknown, key: string, depth: number): boolean => {
    if (++count > LIMITS.nodes || depth > LIMITS.depth) return false
    if (Array.isArray(x)) return x.length <= LIMITS.list && x.every((v) => ok(v, key, depth + 1))
    if (!x || typeof x !== 'object') return true
    for (const [k, v] of Object.entries(x)) {
      if (FREE_TREES.has(k)) continue
      const idKey = (k === 'id' || k.endsWith('_id')) && !FREE_IDS.has(k)
      if (idKey && typeof v === 'string' && !SNOW.test(v)) return false
      if (idKey && v !== null && v !== undefined && typeof v !== 'string' && typeof v !== 'number') return false
      if (k.endsWith('_ids') && v != null && (!Array.isArray(v) || !v.every((i) => typeof i === 'string' && SNOW.test(i)))) return false
      if (!ok(v, k, depth + 1)) return false
    }
    return true
  }
  return ok(d, '', 0)
}

/** What the boundary asks the client about (set by instances/nodes.ts from the store; tests pass their own). */
export type View = {
  channel: (id: string) => { guild_id?: string | null; parent_id?: string | null } | undefined
  user: (id: string) => object | undefined
  /** The pending interaction a nonce or interaction id names, with the channel it was sent in. */
  interaction: (nonce?: string, id?: string) => { channelId: string } | undefined
  voiceGuild: () => string | null | undefined
}
let view: View = { channel: () => undefined, user: () => undefined, interaction: () => undefined, voiceGuild: () => null }
export const setView = (v: View) => void (view = v)

// Node events the client applies; anything else (USER_SETTINGS_UPDATE, RELATIONSHIP_*, CALL_*, CHANNEL_RECIPIENT_*,
// SAVED_MESSAGE_*, MESSAGE_REMINDER_DUE, INSTANCE_*, SOUNDBOARD_SOUNDS, …) never comes from a node.
const GUILD_EVENTS = ['GUILD_UPDATE', 'GUILD_DELETE', 'GUILD_ROLE_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE', 'GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE',
  'GUILD_MEMBER_REMOVE', 'GUILD_BAN_ADD', 'GUILD_BAN_REMOVE', 'GUILD_EMOJIS_UPDATE', 'GUILD_STICKERS_UPDATE', 'GUILD_SCHEDULED_EVENT_CREATE',
  'GUILD_SCHEDULED_EVENT_UPDATE', 'GUILD_SCHEDULED_EVENT_DELETE', 'GUILD_SCHEDULED_EVENT_USER_ADD', 'GUILD_SCHEDULED_EVENT_USER_REMOVE',
  'GUILD_SOUNDBOARD_SOUND_CREATE', 'GUILD_SOUNDBOARD_SOUND_UPDATE', 'GUILD_SOUNDBOARD_SOUND_DELETE', 'GUILD_SOUNDBOARD_SOUNDS_UPDATE',
  'GUILD_APPLICATION_COMMAND_INDEX_UPDATE', 'GUILD_MODULE_PANELS_UPDATE', 'MODULE_UI_EVENT', 'VOICE_STATE_UPDATE', 'VOICE_SERVER_UPDATE', 'VOICE_CHANNEL_EFFECT_SEND', 'USER_GUILD_SETTINGS_UPDATE']
const CHANNEL_EVENTS = ['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_DELETE_BULK', 'MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE',
  'MESSAGE_REACTION_REMOVE_ALL', 'MESSAGE_REACTION_REMOVE_EMOJI', 'MESSAGE_POLL_VOTE_ADD', 'MESSAGE_POLL_VOTE_REMOVE', 'MESSAGE_ACK', 'TYPING_START',
  'CHANNEL_PINS_UPDATE', 'CHANNEL_CANVAS_UPDATE', 'STAGE_INSTANCE_CREATE', 'STAGE_INSTANCE_UPDATE', 'STAGE_INSTANCE_DELETE', 'WATCH_SESSION_UPDATE',
  'WATCH_SESSION_DELETE', 'VOICE_CHANNEL_STATUS_UPDATE']
const INTERACTION_EVENTS = ['INTERACTION_CREATE', 'INTERACTION_SUCCESS', 'INTERACTION_FAILURE', 'INTERACTION_MODAL_CREATE', 'APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE']
const NODE_EVENTS = new Set([...GUILD_EVENTS, ...CHANNEL_EVENTS, ...INTERACTION_EVENTS, 'READY', 'GUILD_CREATE', 'CHANNEL_CREATE', 'CHANNEL_UPDATE',
  'CHANNEL_DELETE', 'THREAD_CREATE', 'THREAD_UPDATE', 'THREAD_DELETE', 'THREAD_LIST_SYNC', 'THREAD_MEMBER_UPDATE', 'THREAD_MEMBERS_UPDATE', 'USER_UPDATE',
  'PRESENCE_UPDATE', 'CILLVOICE_ANSWER', 'CILLVOICE_TRACKS', 'CILLVOICE_SPEAKING', 'CILLVOICE_ERROR'])

/** A channel id this node owns, and (when the event names a guild) one that really lies in that node guild. */
function ownChannel(inst: string, channelId: unknown, guildId?: unknown) {
  if (typeof channelId !== 'string' || ownerOf(channelId) !== inst) return false
  const c = view.channel(channelId)
  if (c?.guild_id && ownerOf(c.guild_id) !== inst) return false
  if (c?.parent_id && ownerOf(c.parent_id) !== inst) return false
  return guildId == null || (ownerOf(guildId) === inst && (!c?.guild_id || c.guild_id === guildId))
}
const ownGuild = (inst: string, id: unknown) => typeof id === 'string' && ownerOf(id) === inst
const freeOrOwn = (inst: string, id: unknown) => typeof id === 'string' && (ownerOf(id) === undefined || ownerOf(id) === inst)

/** A guild payload (READY, GUILD_CREATE, a join answer) a node may introduce: its own or new ids only, children inside it. */
function guildOk(inst: string, g: any) {
  if (!g || typeof g !== 'object' || !freeOrOwn(inst, g.id)) return false
  const chans = [...(g.channels ?? []), ...(g.threads ?? [])]
  const ids = new Set(chans.map((c: any) => c?.id))
  const inGuild = (c: unknown) => c == null || ids.has(c) || ownChannel(inst, c)
  return chans.every((c: any) => freeOrOwn(inst, c?.id) && (c.guild_id == null || c.guild_id === g.id) && inGuild(c.parent_id))
    && [...(g.emojis ?? []), ...(g.stickers ?? []), ...(g.roles ?? []), ...(g.guild_scheduled_events ?? [])].every((x: any) => freeOrOwn(inst, x?.id))
    && [...(g.stage_instances ?? []), ...(g.guild_scheduled_events ?? []), ...(g.watch_sessions ?? []), ...(g.voice_states ?? [])]
      .every((x: any) => (x.guild_id == null || x.guild_id === g.id) && inGuild(x.channel_id))
    && (g.soundboard_sounds ?? []).every((x: any) => freeOrOwn(inst, x?.sound_id))
}
function claimGuild(inst: string, g: any) {
  claim(inst, g.id, 'guild')
  for (const c of [...(g.channels ?? []), ...(g.threads ?? [])]) claim(inst, c.id, 'channel')
  for (const e of g.emojis ?? []) e.id && claim(inst, e.id, 'emoji')
  for (const x of g.stickers ?? []) claim(inst, x.id, 'sticker')
  for (const r of g.roles ?? []) claim(inst, r.id, 'role')
  for (const e of g.guild_scheduled_events ?? []) claim(inst, e.id, 'event')
  for (const x of g.soundboard_sounds ?? []) claim(inst, x.sound_id, 'sound')
}

/** May this node apply event `t` with (aliased) `d`? Checks the real target, never only a supplied guild_id. */
function allowed(inst: string, t: string, d: any): boolean {
  if (!NODE_EVENTS.has(t)) return false
  if (t === 'READY') return (d.guilds ?? []).every((g: any) => guildOk(inst, g))
  if (t === 'GUILD_CREATE') return guildOk(inst, d)
  if (t === 'GUILD_UPDATE' || t === 'GUILD_DELETE') return ownGuild(inst, d.id)
  if (t === 'CHANNEL_CREATE' || t === 'THREAD_CREATE') return ownGuild(inst, d.guild_id) && freeOrOwn(inst, d.id) && (d.parent_id == null || ownChannel(inst, d.parent_id, d.guild_id))
  if (['CHANNEL_UPDATE', 'CHANNEL_DELETE', 'THREAD_UPDATE', 'THREAD_DELETE', 'THREAD_MEMBER_UPDATE', 'THREAD_MEMBERS_UPDATE'].includes(t)) return ownChannel(inst, d.id, d.guild_id ?? null)
  if (t === 'THREAD_LIST_SYNC') return ownGuild(inst, d.guild_id) && (d.threads ?? []).every((c: any) => freeOrOwn(inst, c?.id) && ownChannel(inst, c.parent_id, d.guild_id))
  if (t === 'USER_UPDATE') return freeOrOwn(inst, d.id) && d.id !== hub.meId
  if (t === 'PRESENCE_UPDATE') return freeOrOwn(inst, d.user?.id) && d.user?.id !== hub.meId && (d.guild_id == null || ownGuild(inst, d.guild_id))
  if (t.startsWith('CILLVOICE_')) return ownerOf(view.voiceGuild() ?? '') === inst // only the call on this node
  if (INTERACTION_EVENTS.includes(t)) {
    // only answers to an interaction we sent to this node, in that channel
    const p = view.interaction(d.nonce, d.id)
    return !!p && ownChannel(inst, p.channelId) && (d.channel_id == null || d.channel_id === p.channelId)
  }
  if (CHANNEL_EVENTS.includes(t)) return ownChannel(inst, d.channel_id, d.guild_id ?? null)
  if (GUILD_EVENTS.includes(t)) {
    if (!ownGuild(inst, d.guild_id)) return false
    const ch = d.channel_id ?? d.member?.channel_id
    if (ch != null && !ownChannel(inst, ch, d.guild_id)) return false
    if (t.startsWith('GUILD_SCHEDULED_EVENT_') && !t.includes('USER')) return freeOrOwn(inst, d.id)
    if (t === 'GUILD_ROLE_CREATE' || t === 'GUILD_ROLE_UPDATE') return freeOrOwn(inst, d.role?.id)
    if (t === 'GUILD_EMOJIS_UPDATE') return (d.emojis ?? []).every((e: any) => freeOrOwn(inst, e?.id))
    if (t === 'GUILD_STICKERS_UPDATE') return (d.stickers ?? []).every((e: any) => freeOrOwn(inst, e?.id))
    if (t === 'GUILD_SOUNDBOARD_SOUND_CREATE' || t === 'GUILD_SOUNDBOARD_SOUND_UPDATE') return freeOrOwn(inst, d.sound_id)
    return true
  }
  return false
}

/** Node users stay the node's: a user object naming our own account becomes our hub record; one naming any other id the
 *  hub or another node holds (or the store has without an owner) refuses the payload; new ones are claimed. */
function scopeUsers(inst: string, d: unknown): boolean {
  for (const u of userObjects(d)) {
    const id = u.id
    if (typeof id !== 'string') continue
    if (id === hub.meId) {
      const self = view.user(id)
      if (self) Object.assign(u, self) // shortcut: our own entry keeps the hub's fields; node-only extras on it survive
      continue
    }
    const by = ownerOf(id)
    if (by === inst) continue
    if (by !== undefined || view.user(id) || !claim(inst, id, 'user')) return false
  }
  return true
}

/** A node gateway event (or READY) as the store may apply it, or null to drop it. */
export function admit<T>(inst: string, t: string, raw: T): T | null {
  const n = live[inst]
  if (!n || !wellFormed(raw)) return null
  const d = inbound(n, raw) as any
  if (!d || typeof d !== 'object' || !allowed(inst, t, d) || !scopeUsers(inst, d)) return null
  if (t === 'READY') for (const g of d.guilds ?? []) claimGuild(inst, g)
  else if (t === 'GUILD_CREATE') claimGuild(inst, d)
  else if (t === 'CHANNEL_CREATE' || t === 'THREAD_CREATE') claim(inst, d.id, 'channel')
  else if (t === 'THREAD_LIST_SYNC') for (const c of d.threads ?? []) claim(inst, c.id, 'channel')
  else if (t === 'GUILD_EMOJIS_UPDATE') for (const e of d.emojis ?? []) claim(inst, e.id, 'emoji')
  else if (t === 'GUILD_STICKERS_UPDATE') for (const e of d.stickers ?? []) claim(inst, e.id, 'sticker')
  else if (t === 'GUILD_ROLE_CREATE' || t === 'GUILD_ROLE_UPDATE') claim(inst, d.role.id, 'role')
  else if (t.startsWith('GUILD_SCHEDULED_EVENT_') && !t.includes('USER')) claim(inst, d.id, 'event')
  else if (t === 'GUILD_SOUNDBOARD_SOUND_CREATE' || t === 'GUILD_SOUNDBOARD_SOUND_UPDATE') claim(inst, d.sound_id, 'sound')
  return d as T
}

/** A node REST answer: same shape rules and user scoping (a guild it returns is checked again where it is applied). */
export function admitRest<T>(inst: string, raw: T): T | null {
  const n = live[inst]
  if (!n || !wellFormed(raw)) return null
  const d = inbound(n, raw)
  return scopeUsers(inst, d) ? d : null
}
/** A guild answer of a node (join): only its own or new ids; claimed when it may be applied. */
export const admitGuild = (inst: string, g: unknown) => (guildOk(inst, g) ? (claimGuild(inst, g), true) : false)

/** The reverse for a request body or a path going to the node: our hub ids become the node ones. */
export function outbound<T>(id: string, data: T): T {
  const n = live[id]
  if (!n?.meId || !hub.meId) return data
  const walk = (x: unknown): unknown =>
    typeof x === 'string' ? (x === hub.meId ? n.meId : swapMentions(x, hub.meId, n.meId!))
    : Array.isArray(x) ? x.map(walk)
    : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]))
    : x
  return walk(data) as T
}
export const outboundPath = (id: string, path: string) => {
  const n = live[id]
  return n?.meId && hub.meId ? path.split('/').map((seg) => (seg === hub.meId ? n.meId : seg)).join('/') : path
}

/** Which node a REST path or CDN path belongs to: the first owned snowflake in the path decides (a hub one keeps it on the
 *  hub), else `guild_id`/`channel_id` in the query or body. */
export function route(path: string, body?: unknown): string | undefined {
  const [p, q] = path.split('?')
  // A node may name any user id (also hub users we have not seen yet), so /users/... goes to a node only through the
  // node guild or channel given as context below, never by the user id in the path.
  if (!p.startsWith('/users/')) for (const seg of p.split('/')) {
    const by = ownerOf(seg.replace(/\.\w+$/, ''))
    if (by === '') return undefined
    if (by) return by
  }
  const params = new URLSearchParams(q ?? '')
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  for (const k of ['guild_id', 'channel_id']) {
    const v = params.get(k) ?? b[k]
    const by = ownerOf(v)
    if (by === '') return undefined
    if (by) return by
  }
  return undefined
}

/** Test hook: a node with our node identity, no storage. */
export const testNode = (id: string, url: string, meId: string, hubMeId: string) => {
  live = { ...live, [id]: { id, name: id, url, status: 'ready', meId, sessionId: null } }
  hub.meId = hubMeId
}
