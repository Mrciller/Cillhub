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

// ---------- Node ids live in their own namespace ----------
// Every id a node sends becomes `<instance id>:<snowflake>` on the way in and loses the prefix on the way out. Hub ids are
// bare, so a node can never name a hub object or another node's, whatever event, nested object or REST answer it uses;
// which server a path, CDN file or gateway op belongs to is read from the prefix. Only our own node account maps to the
// bare hub id of `me` (aliasing above).
const SNOW = /^\d{1,20}$/
const SCOPED = /^(\d{1,20}):(\d{1,20})$/
export const scoped = (inst: string, id: string) => `${inst}:${id}`
/** The id without its node prefix (for snowflake time and order). */
export const bareId = (id: string) => id.slice(id.indexOf(':') + 1)

/** The node a (scoped) id belongs to; undefined = the hub. */
export const nodeOf = (id: string | null | undefined) => (id ? SCOPED.exec(id.replace(/\.\w+$/, ''))?.[1] : undefined)

// Root-relative URLs in node payloads point at the node: made absolute on the way in (attachments, embeds, voice endpoint).
const URL_KEYS = new Set(['url', 'proxy_url', 'icon_url', 'proxy_icon_url', 'avatar_url', 'sound_url', 'endpoint'])
// Media the client loads by itself (attachments, entrance sounds, webhook avatars) must come from the node's own origin.
const MEDIA_KEYS = new Set(['avatar_url', 'sound_url'])
const onNode = (n: Live, a: unknown) => {
  const u = (a as { url?: unknown } | null)?.url
  return typeof u !== 'string' || u.startsWith(n.url + '/') || (u.startsWith('/') && !u.startsWith('//'))
}

// Keys whose string values are ids: `id`, `*_id`, and these lists (plus `*_ids`). Maps keyed by id: under `resolved`.
const ID_LISTS = new Set(['ids', 'roles', 'mention_roles', 'applied_tags', 'exempt_roles', 'exempt_channels'])
const FREE_IDS = new Set(['custom_id', 'session_id', 'video_id', 'panel_id', 'module_id', 'sku_id', 'folder_id', 'sync_id', 'party_id'])
// Inside these trees ids are free-form (component numbers, activity ids); only their emoji ids are snowflakes.
const FREE_TREES = new Set(['activities', 'components'])
export const LIMITS = { depth: 32, list: 10_000, nodes: 500_000 }
const isIdKey = (k: string) => (k === 'id' || k.endsWith('_id')) && !FREE_IDS.has(k)
const isIdList = (k: string) => ID_LISTS.has(k) || k.endsWith('_ids')
// Content tokens naming ids: <@1>, <@!1>, <@&1>, <#1>, <:name:1>, <a:name:1>
const TOKENS = /<(@!?|@&|#|a?:\w{1,32}:)(\d{1,20})>/g

/** A node payload in the client's terms, or null when it breaks the rules: bounded size (depth, list length, total
 *  values), every id a canonical numeric snowflake string (numbers only inside component trees), then ids scoped to the
 *  node, our node account aliased to us, root-relative URLs made absolute and foreign media dropped. */
function inbound<T>(n: Live, data: T): T | null {
  const inst = n.id
  const id = (v: string) => (n.meId && v === n.meId ? hub.meId || v : scoped(inst, v))
  let count = 0
  const bad = Symbol()
  const walk = (x: unknown, key: string, depth: number, free: boolean): unknown => {
    if (++count > LIMITS.nodes || depth > LIMITS.depth) throw bad
    if (typeof x === 'string') {
      if (n.sessionId && x === n.sessionId) return hub.sessionId || x
      if (URL_KEYS.has(key) && x.startsWith('/') && !x.startsWith('//')) return n.url + x
      // A node's media proxy is its own: any other host would load (and see our IP) from wherever the node points.
      if ((key.startsWith('proxy_') || MEDIA_KEYS.has(key)) && !x.startsWith(n.url + '/')) return undefined
      if (key === 'content' || key === 'description' || key === 'value' || key === 'title') {
        return x.replace(TOKENS, (_, kind: string, v: string) => `<${kind}${kind === '@' || kind === '@!' ? id(v) : scoped(inst, v)}>`)
      }
      return x
    }
    if (Array.isArray(x)) {
      if (x.length > LIMITS.list) throw bad
      // id lists (member roles, bulk deletes…): every string a snowflake; lists of objects under the same names walk on
      return x.map((v) => (typeof v !== 'string' || !isIdList(key) ? walk(v, key, depth + 1, free) : SNOW.test(v) ? id(v) : (() => { throw bad })()))
    }
    if (!x || typeof x !== 'object') return x
    const out: Record<string, unknown> = {}
    const inFree = free || FREE_TREES.has(key)
    for (const [k, v] of Object.entries(x)) {
      const emojiId = key === 'emoji' && k === 'id'
      if ((!inFree || emojiId) && isIdKey(k) && v != null) {
        if (typeof v === 'string' && SNOW.test(v)) { out[k] = id(v); continue }
        if (!(inFree && typeof v === 'number')) throw bad // non-canonical ids (numbers, paths, anything else)
      }
      if (inFree && isIdKey(k) && typeof v === 'string' && v.length > 100) throw bad
      if (key === 'resolved' && v && typeof v === 'object' && !Array.isArray(v)) {
        const m: Record<string, unknown> = {}
        for (const [rk, rv] of Object.entries(v)) {
          if (!SNOW.test(rk)) throw bad
          m[id(rk)] = walk(rv, k, depth + 2, inFree)
        }
        out[k] = m
        continue
      }
      out[k] = walk(k === 'attachments' && Array.isArray(v) ? v.filter((a) => onNode(n, a)) : v, k, depth + 1, inFree)
    }
    return out
  }
  try { return walk(data, '', 0, false) as T } catch (e) { if (e === bad) return null; throw e }
}

/** What the boundary asks the client about (set by instances/nodes.ts from the store; tests pass their own). */
export type View = {
  user: (id: string) => object | undefined
  /** The interaction we sent with this nonce and not yet answered: channel, application, interaction type. */
  interaction: (nonce: unknown) => { channelId: string; appId: string; type: number } | undefined
  /** Forgets it (a terminal answer arrived). */
  consume: (nonce: string) => void
  voiceGuild: () => string | null | undefined
}
let view: View = { user: () => undefined, interaction: () => undefined, consume: () => {}, voiceGuild: () => null }
export const setView = (v: View) => void (view = v)

// Node events the client applies; anything else (USER_SETTINGS_UPDATE, RELATIONSHIP_*, CALL_*, CHANNEL_RECIPIENT_*,
// SAVED_MESSAGE_*, MESSAGE_REMINDER_DUE, INSTANCE_*, SOUNDBOARD_SOUNDS, …) never comes from a node. Their targets are
// node-scoped ids by construction; only the few that can name our own (bare) id are checked below.
const NODE_EVENTS = new Set(['READY', 'GUILD_CREATE', 'GUILD_UPDATE', 'GUILD_DELETE', 'GUILD_ROLE_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE',
  'GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE', 'GUILD_MEMBER_REMOVE', 'GUILD_BAN_ADD', 'GUILD_BAN_REMOVE', 'GUILD_EMOJIS_UPDATE', 'GUILD_STICKERS_UPDATE',
  'GUILD_SCHEDULED_EVENT_CREATE', 'GUILD_SCHEDULED_EVENT_UPDATE', 'GUILD_SCHEDULED_EVENT_DELETE', 'GUILD_SCHEDULED_EVENT_USER_ADD',
  'GUILD_SCHEDULED_EVENT_USER_REMOVE', 'GUILD_SOUNDBOARD_SOUND_CREATE', 'GUILD_SOUNDBOARD_SOUND_UPDATE', 'GUILD_SOUNDBOARD_SOUND_DELETE',
  'GUILD_SOUNDBOARD_SOUNDS_UPDATE', 'GUILD_APPLICATION_COMMAND_INDEX_UPDATE', 'GUILD_MODULE_PANELS_UPDATE', 'MODULE_UI_EVENT', 'VOICE_STATE_UPDATE',
  'VOICE_SERVER_UPDATE', 'VOICE_CHANNEL_EFFECT_SEND', 'USER_GUILD_SETTINGS_UPDATE', 'CHANNEL_CREATE', 'CHANNEL_UPDATE', 'CHANNEL_DELETE', 'THREAD_CREATE',
  'THREAD_UPDATE', 'THREAD_DELETE', 'THREAD_LIST_SYNC', 'THREAD_MEMBER_UPDATE', 'THREAD_MEMBERS_UPDATE', 'MESSAGE_CREATE', 'MESSAGE_UPDATE',
  'MESSAGE_DELETE', 'MESSAGE_DELETE_BULK', 'MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE', 'MESSAGE_REACTION_REMOVE_ALL', 'MESSAGE_REACTION_REMOVE_EMOJI',
  'MESSAGE_POLL_VOTE_ADD', 'MESSAGE_POLL_VOTE_REMOVE', 'MESSAGE_ACK', 'TYPING_START', 'CHANNEL_PINS_UPDATE', 'CHANNEL_CANVAS_UPDATE',
  'STAGE_INSTANCE_CREATE', 'STAGE_INSTANCE_UPDATE', 'STAGE_INSTANCE_DELETE', 'WATCH_SESSION_UPDATE', 'WATCH_SESSION_DELETE', 'VOICE_CHANNEL_STATUS_UPDATE',
  'USER_UPDATE', 'PRESENCE_UPDATE', 'CILLVOICE_ANSWER', 'CILLVOICE_TRACKS', 'CILLVOICE_SPEAKING', 'CILLVOICE_ERROR',
  'INTERACTION_CREATE', 'INTERACTION_SUCCESS', 'INTERACTION_FAILURE', 'INTERACTION_MODAL_CREATE', 'APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE'])
const TERMINAL = new Set(['INTERACTION_SUCCESS', 'INTERACTION_FAILURE', 'INTERACTION_MODAL_CREATE', 'APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE'])
const mine = (inst: string, id: unknown) => typeof id === 'string' && nodeOf(id) === inst

function allowed(inst: string, t: string, d: any): boolean {
  if (!NODE_EVENTS.has(t)) return false
  // the only bare id a node can produce is ours: it may not rename us or set our presence
  if (t === 'USER_UPDATE') return d.id !== hub.meId
  if (t === 'PRESENCE_UPDATE') return d.user?.id !== hub.meId
  // a voice state of ours only for a voice channel of this node
  if (t === 'VOICE_STATE_UPDATE' && d.user_id === hub.meId) return mine(inst, d.guild_id) && (d.channel_id == null || mine(inst, d.channel_id))
  if (t.startsWith('CILLVOICE_')) return mine(inst, view.voiceGuild()) // only the call on this node
  if (t.startsWith('INTERACTION_') || t === 'APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE') {
    // only an answer to an interaction we sent into this node's channel, of the fitting kind and still open
    const p = view.interaction(d.nonce)
    if (!p || !mine(inst, p.channelId) || (d.channel_id != null && d.channel_id !== p.channelId)) return false
    if (t === 'APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE' ? p.type !== 4 : p.type === 4) return false
    if (t === 'INTERACTION_MODAL_CREATE' && (p.type === 5 || (d.application?.id != null && d.application.id !== p.appId))) return false
    if (TERMINAL.has(t)) view.consume(d.nonce)
    return true
  }
  return true
}

/** Our own node account as the hub record (a node may not rename or re-avatar us). Other node users are scoped already. */
function selfAsHub(d: unknown, depth = 0) {
  if (!d || typeof d !== 'object' || depth > LIMITS.depth) return
  for (const v of Object.values(d)) {
    if (v && typeof v === 'object' && !Array.isArray(v) && (v as { id?: unknown }).id === hub.meId && 'username' in v) {
      const self = view.user(hub.meId)
      if (self) Object.assign(v, self)
    }
    selfAsHub(v, depth + 1)
  }
}

/** A node gateway event (or READY) as the store may apply it, or null to drop it. */
export function admit<T>(inst: string, t: string, raw: T): T | null {
  const n = live[inst]
  const d = n ? (inbound(n, raw) as any) : null
  if (!d || typeof d !== 'object' || !allowed(inst, t, d)) return null
  selfAsHub(d)
  return d as T
}
/** A node REST answer, same rules. */
export function admitRest<T>(inst: string, raw: T): T | null {
  const n = live[inst]
  const d = n ? inbound(n, raw) : null
  if (d === null) return null
  selfAsHub(d)
  return d
}

/** The reverse for a request body or a gateway op going to the node: its ids lose the prefix, our hub id becomes our node
 *  id. Ids of the hub or another node are left as they are (the node does not know them). */
export function outbound<T>(inst: string, data: T): T {
  const n = live[inst]
  const pre = `${inst}:`
  const strip = (x: string) =>
    x.startsWith(pre) && SNOW.test(x.slice(pre.length)) ? x.slice(pre.length)
    : n?.meId && hub.meId && x === hub.meId ? n.meId
    : x.replace(TOKENS_SCOPED, (m, kind: string, i: string, v: string) => (i === inst ? `<${kind}${v}>` : m)).replace(/<(@!?)(\d{1,20})>/g, (m, kind: string, v: string) => (n?.meId && v === hub.meId ? `<${kind}${n.meId}>` : m))
  const walk = (x: unknown): unknown =>
    typeof x === 'string' ? strip(x)
    : Array.isArray(x) ? x.map(walk)
    : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, walk(v)]))
    : x
  return walk(data) as T
}
const TOKENS_SCOPED = /<(@!?|@&|#|a?:\w{1,32}:)(\d{1,20}):(\d{1,20})>/g
/** A path (and query) going to the node: its scoped ids bare (also inside `name:id` emoji segments, URL-encoded too). */
export const outboundPath = (inst: string, path: string) => {
  const n = live[inst]
  const out = path.replace(new RegExp(`(^|[/=&,?:]|%3A)${inst}(?::|%3A)(\\d{1,20})(?=$|[/?&.,#]|%2C)`, 'gi'), '$1$2')
  return n?.meId && hub.meId ? out.split('/').map((seg) => (seg === hub.meId ? n.meId : seg)).join('/') : out
}

/** Which node a REST path or CDN path belongs to: the first node-scoped id in the path, else `guild_id`/`channel_id` in
 *  the query or body; anything bare is the hub's. */
export function route(path: string, body?: unknown): string | undefined {
  const [p, q] = path.split('?')
  for (const seg of p.split('/')) {
    let v = seg
    try { v = decodeURIComponent(seg) } catch { /* keep as is */ }
    const n = nodeOf(v.split(':').slice(-2).join(':'))
    if (n) return n
  }
  const params = new URLSearchParams(q ?? '')
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  for (const k of ['guild_id', 'channel_id']) {
    const v = params.get(k) ?? b[k]
    const n = typeof v === 'string' ? nodeOf(v) : undefined
    if (n) return n
  }
  return undefined
}

/** Test hook: a node with our node identity, no storage. */
export const testNode = (id: string, url: string, meId: string, hubMeId: string) => {
  live = { ...live, [id]: { id, name: id, url, status: 'ready', meId, sessionId: null } }
  hub.meId = hubMeId
}
