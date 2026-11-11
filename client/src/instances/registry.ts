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
/** …; cut-off = it sent more than its budget (registry.ts), disconnected until the next start. */
export type InstanceStatus = 'connecting' | 'ready' | 'offline' | 'suspended' | 'signed-out' | 'cut-off'
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
// Every id a node sends becomes `<instance id>~<snowflake>` on the way in and loses the prefix on the way out. Hub ids are
// bare, so a node can never name a hub object or another node's, whatever event, nested object or REST answer it uses;
// which server a path, CDN file or gateway op belongs to is read from its first id. Only references to a user (typed
// positions, listed below) that name our own node account become our bare hub user id; that user's record is the hub's.
// `~` cannot appear in a snowflake, an emoji name (\w) or a file extension, so `name:id` emoji segments stay unambiguous.
const SNOW = /^\d{1,20}$/
const SCOPED = /^(\d{1,20})~(\d{1,20})$/
export const SEP = '~'
export const scoped = (inst: string, id: string) => `${inst}${SEP}${id}`
/** The id without its node prefix (for snowflake time and order). */
export const bareId = (id: string) => id.slice(id.indexOf(SEP) + 1)

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

// Where an id names a user: these keys, these lists, and `id` of objects under the user object keys.
const USER_ID_KEYS = new Set(['user_id', 'author_id', 'owner_id', 'creator_id', 'host_id', 'target_user_id'])
const USER_LISTS = new Set(['user_ids', 'removed_member_ids', 'speaking'])
const USER_OBJECTS = new Set(['user', 'author', 'users', 'recipients', 'mentions', 'creator', 'target_user'])
// Other id lists (strings only): member roles, bulk deletes, automod exemptions…
const ID_LISTS = new Set(['ids', 'roles', 'mention_roles', 'applied_tags', 'exempt_roles', 'exempt_channels', ...USER_LISTS])
const FREE_IDS = new Set(['custom_id', 'session_id', 'video_id', 'panel_id', 'module_id', 'sku_id', 'folder_id', 'sync_id', 'party_id'])
// Inside these trees `id` is a component number or an activity's own string; their emoji and default_values ids are not.
const FREE_TREES = new Set(['activities', 'components'])
export const LIMITS = { depth: 32, list: 10_000, nodes: 500_000, budget: 200_000 }
const isIdKey = (k: string) => (k === 'id' || k.endsWith('_id')) && !FREE_IDS.has(k)
const isIdList = (k: string) => ID_LISTS.has(k) || k.endsWith('_ids')
// Content tokens naming ids: <@1>, <@!1>, <@&1>, <#1>, <:name:1>, <a:name:1>; one that already carries a prefix is forged.
const TOKENS = /<(@!?|@&|#|a?:\w{1,32}:)(\d{1,20})>/g
const FORGED = /<(@!?|@&|#|a?:\w{1,32}:)[\d~]*~[\d~]*>/g

// Distinct ids each node brought in since its last READY: past the budget it is cut off (instances/nodes.ts).
const seen = new Map<string, Set<string>>()
export const overBudget = (inst: string) => (seen.get(inst)?.size ?? 0) > LIMITS.budget

/** A node payload in the client's terms, or null when it breaks the rules: bounded size (depth, list length, total
 *  values, distinct ids per node), every id a canonical numeric snowflake string, then ids scoped to the node (user
 *  references to our node account → our hub id, and such user objects → our hub record), root-relative URLs made
 *  absolute, foreign media dropped, forged prefixed text tokens neutralised. */
function inbound<T>(n: Live, data: T): T | null {
  const inst = n.id
  const ids = seen.get(inst) ?? seen.set(inst, new Set()).get(inst)!
  const bad = Symbol()
  const ref = (v: unknown) => {
    if (typeof v !== 'string' || !SNOW.test(v)) throw bad
    const out = scoped(inst, v)
    ids.add(out)
    if (ids.size > LIMITS.budget) throw bad
    return out
  }
  const userRef = (v: unknown) => (n.meId && v === n.meId ? hub.meId || ref(v) : ref(v))
  const self = () => ({ ...(view.user(hub.meId) ?? { id: hub.meId }) })
  let count = 0
  const walk = (x: unknown, key: string, depth: number, free: boolean, userObj: boolean): unknown => {
    if (++count > LIMITS.nodes || depth > LIMITS.depth) throw bad
    if (typeof x === 'string') {
      if (n.sessionId && x === n.sessionId) return hub.sessionId || x
      if (URL_KEYS.has(key) && x.startsWith('/') && !x.startsWith('//')) return n.url + x
      // A node's media proxy is its own: any other host would load (and see our IP) from wherever the node points.
      if ((key.startsWith('proxy_') || MEDIA_KEYS.has(key)) && !x.startsWith(n.url + '/')) return undefined
      if (!x.includes('<')) return x
      return x.replace(FORGED, (m) => `‹${m.slice(1, -1)}›`)
        .replace(TOKENS, (_, kind: string, v: string) => `<${kind}${kind === '@' || kind === '@!' ? userRef(v) : ref(v)}>`)
    }
    if (Array.isArray(x)) {
      if (x.length > LIMITS.list) throw bad
      // an id list holds snowflake strings only (lists of objects under the same names, like guild roles, walk on)
      if (isIdList(key) && x.some((v) => typeof v !== 'object' || v === null)) return x.map((v) => (USER_LISTS.has(key) ? userRef(v) : ref(v)))
      return x.map((v) => walk(v, key, depth + 1, free, userObj))
    }
    if (!x || typeof x !== 'object') return x
    const inFree = free || FREE_TREES.has(key)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(x)) {
      if (isIdList(k) && v != null && !Array.isArray(v)) throw bad // an id list that is not a list
      const typed = (key === 'emoji' && k === 'id') || key === 'default_values'
      if (isIdKey(k) && v != null && (!inFree || typed)) {
        out[k] = USER_ID_KEYS.has(k) || (k === 'id' && (userObj || (key === 'default_values' && (x as { type?: unknown }).type === 'user'))) ? userRef(v) : ref(v)
        continue
      }
      if (inFree && isIdKey(k) && v != null && typeof v !== 'number' && (typeof v !== 'string' || v.length > 100)) throw bad
      if (key === 'resolved' && v && typeof v === 'object' && !Array.isArray(v)) {
        const m: Record<string, unknown> = {}
        const users = k === 'users' || k === 'members'
        for (const [rk, rv] of Object.entries(v)) m[users ? userRef(rk) : ref(rk)] = walk(rv, k, depth + 2, inFree, users)
        out[k] = m
        continue
      }
      out[k] = walk(k === 'attachments' && Array.isArray(v) ? v.filter((a) => onNode(n, a)) : v, k, depth + 1, inFree, USER_OBJECTS.has(k))
    }
    // a user object naming our own account is our hub record, whole
    return userObj && out.id === hub.meId && hub.meId ? self() : out
  }
  try { return walk(data, '', 0, false, false) as T } catch (e) { if (e === bad) return null; throw e }
}

/** What the boundary asks the client about (set by instances/nodes.ts from the store; tests pass their own). */
export type View = {
  user: (id: string) => object | undefined
  channel: (id: string) => { guild_id?: string | null } | undefined
  /** The interaction we sent with this nonce and not yet answered: channel, application, interaction type. */
  interaction: (nonce: unknown) => { channelId: string; appId: string; type: number } | undefined
  /** Forgets it (a terminal answer arrived). */
  consume: (nonce: string) => void
  voiceGuild: () => string | null | undefined
}
let view: View = { user: () => undefined, channel: () => undefined, interaction: () => undefined, consume: () => {}, voiceGuild: () => null }
export const setView = (v: View) => void (view = v)

// Node events and the target each must carry (a node-scoped id of this node); anything else (settings, friends, DMs,
// calls, saved messages, instance notices, …) never comes from a node. A missing or null target is refused.
const BY_ID = ['GUILD_CREATE', 'GUILD_UPDATE', 'GUILD_DELETE']
const CHANNEL_BY_ID = ['CHANNEL_CREATE', 'CHANNEL_UPDATE', 'CHANNEL_DELETE', 'THREAD_CREATE', 'THREAD_UPDATE', 'THREAD_DELETE', 'THREAD_MEMBER_UPDATE', 'THREAD_MEMBERS_UPDATE']
const BY_GUILD = ['GUILD_ROLE_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE', 'GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE', 'GUILD_MEMBER_REMOVE', 'GUILD_BAN_ADD',
  'GUILD_BAN_REMOVE', 'GUILD_EMOJIS_UPDATE', 'GUILD_STICKERS_UPDATE', 'GUILD_SCHEDULED_EVENT_CREATE', 'GUILD_SCHEDULED_EVENT_UPDATE',
  'GUILD_SCHEDULED_EVENT_DELETE', 'GUILD_SCHEDULED_EVENT_USER_ADD', 'GUILD_SCHEDULED_EVENT_USER_REMOVE', 'GUILD_SOUNDBOARD_SOUND_CREATE',
  'GUILD_SOUNDBOARD_SOUND_UPDATE', 'GUILD_SOUNDBOARD_SOUND_DELETE', 'GUILD_SOUNDBOARD_SOUNDS_UPDATE', 'GUILD_APPLICATION_COMMAND_INDEX_UPDATE',
  'GUILD_MODULE_PANELS_UPDATE', 'MODULE_UI_EVENT', 'VOICE_STATE_UPDATE', 'USER_GUILD_SETTINGS_UPDATE', 'THREAD_LIST_SYNC']
const BY_CHANNEL = ['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_DELETE_BULK', 'MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE',
  'MESSAGE_REACTION_REMOVE_ALL', 'MESSAGE_REACTION_REMOVE_EMOJI', 'MESSAGE_POLL_VOTE_ADD', 'MESSAGE_POLL_VOTE_REMOVE', 'MESSAGE_ACK', 'TYPING_START',
  'CHANNEL_PINS_UPDATE', 'CHANNEL_CANVAS_UPDATE', 'STAGE_INSTANCE_CREATE', 'STAGE_INSTANCE_UPDATE', 'STAGE_INSTANCE_DELETE', 'WATCH_SESSION_UPDATE',
  'WATCH_SESSION_DELETE', 'VOICE_CHANNEL_STATUS_UPDATE', 'VOICE_CHANNEL_EFFECT_SEND']
const VOICE = ['VOICE_SERVER_UPDATE', 'CILLVOICE_ANSWER', 'CILLVOICE_TRACKS', 'CILLVOICE_SPEAKING', 'CILLVOICE_ERROR']
const INTERACTIONS = ['INTERACTION_CREATE', 'INTERACTION_SUCCESS', 'INTERACTION_FAILURE', 'INTERACTION_MODAL_CREATE', 'APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE']
const TERMINAL = new Set(['INTERACTION_SUCCESS', 'INTERACTION_FAILURE', 'INTERACTION_MODAL_CREATE', 'APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE'])
const mine = (inst: string, id: unknown) => typeof id === 'string' && nodeOf(id) === inst

function allowed(inst: string, t: string, d: any): boolean {
  if (t === 'READY') return true
  if (BY_ID.includes(t)) return mine(inst, d.id)
  if (CHANNEL_BY_ID.includes(t)) return mine(inst, d.id) && mine(inst, d.guild_id ?? view.channel(d.id)?.guild_id)
  if (BY_GUILD.includes(t)) return mine(inst, d.guild_id) && (d.channel_id == null || mine(inst, d.channel_id))
  if (BY_CHANNEL.includes(t)) return mine(inst, d.channel_id) && mine(inst, d.guild_id ?? view.channel(d.channel_id)?.guild_id)
  if (t === 'USER_UPDATE') return mine(inst, d.id)
  if (t === 'PRESENCE_UPDATE') return mine(inst, d.user?.id) && (d.guild_id == null || mine(inst, d.guild_id))
  if (VOICE.includes(t)) return mine(inst, view.voiceGuild()) && (d.guild_id == null || d.guild_id === view.voiceGuild()) // only the call on this node
  if (INTERACTIONS.includes(t)) {
    // only an answer to an interaction we sent into this node's channel, of the fitting kind and still open; where it
    // shows and which application it names come from our request, not from the node
    const p = view.interaction(d.nonce)
    if (!p || !mine(inst, p.channelId) || (d.channel_id != null && d.channel_id !== p.channelId)) return false
    if (t === 'APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE' ? p.type !== 4 : p.type === 4) return false
    if (t === 'INTERACTION_MODAL_CREATE' && p.type === 5) return false
    d.channel_id = p.channelId
    if (t === 'INTERACTION_MODAL_CREATE') d.application = { ...(d.application && typeof d.application === 'object' ? d.application : {}), id: p.appId }
    if (TERMINAL.has(t)) view.consume(d.nonce)
    return true
  }
  return false
}

/** A node gateway event (or READY) as the store may apply it, or null to drop it. READY starts the node's id budget anew. */
export function admit<T>(inst: string, t: string, raw: T): T | null {
  const n = live[inst]
  if (n && t === 'READY') seen.delete(inst)
  const d = n ? (inbound(n, raw) as any) : null
  return d && typeof d === 'object' && allowed(inst, t, d) ? (d as T) : null
}
/** A node REST answer, same rules. */
export function admitRest<T>(inst: string, raw: T): T | null {
  const n = live[inst]
  return n ? inbound(n, raw) : null
}

/** The reverse for a request body or a gateway op going to the node: its ids lose the prefix (values and map keys), our
 *  hub id becomes our node id. Ids of the hub or another node are left as they are (the node does not know them). */
export function outbound<T>(inst: string, data: T): T {
  const n = live[inst]
  const pre = inst + SEP
  const strip = (x: string) =>
    x.startsWith(pre) && SNOW.test(x.slice(pre.length)) ? x.slice(pre.length)
    : n?.meId && hub.meId && x === hub.meId ? n.meId
    : x.replace(TOKENS_SCOPED, (m, kind: string, i: string, v: string) => (i === inst ? `<${kind}${v}>` : m)).replace(/<(@!?)(\d{1,20})>/g, (m, kind: string, v: string) => (n?.meId && v === hub.meId ? `<${kind}${n.meId}>` : m))
  const key = (k: string) => (k.startsWith(pre) && SNOW.test(k.slice(pre.length)) ? k.slice(pre.length) : k)
  const walk = (x: unknown): unknown =>
    typeof x === 'string' ? strip(x)
    : Array.isArray(x) ? x.map(walk)
    : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [key(k), walk(v)]))
    : x
  return walk(data) as T
}
const TOKENS_SCOPED = /<(@!?|@&|#|a?:\w{1,32}:)(\d{1,20})~(\d{1,20})>/g
/** A path (and query) going to the node: its scoped ids bare (also inside `name:id` emoji segments, URL-encoded too). */
export const outboundPath = (inst: string, path: string) => {
  const n = live[inst]
  const out = path.replace(new RegExp(`(?<!\\d)${inst}${SEP}(?=\\d)`, 'g'), '')
  return n?.meId && hub.meId ? out.split('/').map((seg) => (seg === hub.meId ? n.meId : seg)).join('/') : out
}

// A path segment that is an id (a file may follow the id: /emojis/<id>.png); `name:id` emoji segments are not.
const ID_SEGMENT = /^(\d{1,20}(?:~\d{1,20})?)(?:\.\w+)?$/
/** Which server a REST or CDN path belongs to: its first id (the endpoint's primary resource), else `guild_id` or
 *  `channel_id` in the query or body. Bare = the hub. */
export function route(path: string, body?: unknown): string | undefined {
  const [p, q] = path.split('?')
  // a bare user id belongs to no server in particular (our own profile in a node server): the query decides there
  const users = p.startsWith('/users/')
  for (const seg of p.split('/')) {
    const m = ID_SEGMENT.exec(seg)
    if (m && !(users && !nodeOf(m[1]))) return nodeOf(m[1])
  }
  const params = new URLSearchParams(q ?? '')
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  for (const k of ['guild_id', 'channel_id']) {
    const v = params.get(k) ?? b[k]
    if (typeof v === 'string') return nodeOf(v)
  }
  return undefined
}
/** A path may only name ids of the server it goes to: no node ids on a hub request, no other node's or hub emoji on a
 *  node request. */
export function pathFits(path: string, to: string | undefined) {
  const scopedIn = [...path.matchAll(/(\d{1,20})~\d{1,20}/g)].map((m) => m[1])
  if (scopedIn.some((i) => i !== to)) return false
  return !to || !/(^|\/)\w{1,32}(:|%3A)\d{1,20}(\/|$|\?)/i.test(path) // a hub custom emoji on a node message
}

/** Test hook: a node with our node identity, no storage. */
export const testNode = (id: string, url: string, meId: string, hubMeId: string) => {
  live = { ...live, [id]: { id, name: id, url, status: 'ready', meId, sessionId: null } }
  hub.meId = hubMeId
}
