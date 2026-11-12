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
/** …; cut-off = it sent more than its budget (registry.ts) or broken data, disconnected until the user reconnects it (kept
 *  across starts when `sticky`: the node itself was shown to be the cause). */
export type InstanceStatus = 'connecting' | 'ready' | 'offline' | 'suspended' | 'signed-out' | 'cut-off'
export type Live = InstanceInfo & { status: InstanceStatus; meId: string | null; sessionId: string | null; sticky?: boolean }
/** As stored: `cut` = cut off for good (until Reconnect), `me` = our node account, pinned by the first READY of the sign-in. */
type Saved = InstanceInfo & { cut?: boolean; me?: string }

const KEY = 'instances'
const tokenKey = (id: string) => `instance-token:${id}`
const load = (): Saved[] => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(v) ? v.filter((i) => i && typeof i.id === 'string' && /^https?:\/\//.test(i.url)) : []
  } catch { return [] }
}

let live: Record<string, Live> = Object.fromEntries(load().map(({ cut, me, ...i }) => [i.id, { ...i, status: cut ? 'cut-off' : 'connecting', sticky: !!cut, meId: typeof me === 'string' && /^\d{1,20}$/.test(me) ? me : null, sessionId: null }]))
const hub = { meId: '', sessionId: '' }
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
// A node cut off for a direct cause stays off on the next start (else it would be back on every start). Another tab's
// cut flag is kept (read-modify-write); only this tab's Reconnect or a new sign-in (`clear`) lifts it.
const persist = (clear?: string) => {
  const cut = new Set(load().filter((i) => i.cut && i.id !== clear).map((i) => i.id))
  localStorage.setItem(KEY, JSON.stringify(Object.values(live).map(({ id, name, url, icon, status, sticky, meId }) =>
    ({ id, name, url, icon, ...(meId && { me: meId }), ...(((status === 'cut-off' && sticky) || cut.has(id)) && { cut: true }) }))))
}

export const subscribeInstances = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))
/** All saved instances with their live status (a new object on every change). */
export const useInstances = () => useSyncExternalStore(subscribeInstances, () => live)
export const instances = () => Object.values(live)
export const instanceById = (id: string | undefined): Live | undefined => (id ? live[id] : undefined)
export const tokenOf = (id: string) => localStorage.getItem(tokenKey(id))

export function saveInstance(info: InstanceInfo, token: string) {
  localStorage.setItem(tokenKey(info.id), token)
  // a new sign-in: its first READY names the node account anew
  live = { ...live, [info.id]: { ...live[info.id], ...info, status: 'connecting', sticky: false, meId: null, sessionId: null } }
  persist(info.id)
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
  const was = live[id].status
  live = { ...live, [id]: { ...live[id], ...patch } }
  if (patch.status) persist(was === 'cut-off' && patch.status !== 'cut-off' ? id : undefined)
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
const USER_ID_KEYS = new Set(['user_id', 'author_id', 'owner_id', 'creator_id', 'host_id', 'target_user_id', 'updated_by', 'created_by', 'added_by'])
const USER_LISTS = new Set(['user_ids', 'removed_member_ids', 'speaking', 'participants'])
const USER_OBJECTS = new Set(['user', 'author', 'users', 'recipients', 'mentions', 'creator', 'target_user', 'inviter', 'owner'])
// Other id lists (strings only): member roles, bulk deletes, automod exemptions…
const ID_LISTS = new Set(['ids', 'roles', 'mention_roles', 'applied_tags', 'exempt_roles', 'exempt_channels', ...USER_LISTS])
const FREE_IDS = new Set(['custom_id', 'session_id', 'video_id', 'panel_id', 'module_id', 'sku_id', 'folder_id', 'sync_id', 'party_id'])
// Inside these trees `id` is a component number or an activity's own string; their emoji and default_values ids are not.
const FREE_TREES = new Set(['activities', 'components', 'serialized_source_guild']) // templates number their roles and channels
// Numbers, not snowflakes: poll answers and quiz answer, display name font and effect, voice effect animation.
const NUMERIC_IDS = new Set(['answer_id', 'correct_answer_id', 'font_id', 'effect_id', 'animation_id'])
// cillvoice tracks are named `<user id>-<mid>`: opaque, scoped as they are (tracks[].id, track_id) and given back the same way.
const TRACK = /^[\w-]{1,80}$/
const PRESET = /^[a-z][a-z0-9_-]{0,39}$/ // built-in collectible names (server routes/customization.js)
// Longest strings an honest server sends (server/src): canvas 50 000, embed description 4096, message 2000; template
// emoji images are data URIs of up to 256 KiB (base64); emoji names are \w{2,32} or one unicode emoji.
export const LIMITS = { depth: 32, list: 10_000, nodes: 500_000, budget: 200_000, text: 65_536, image: 360_000, emoji: 64, key: 200 }
// Fields the UI renders, by type: a wrong-typed one refuses the payload instead of breaking the render.
const strOrNull = (v: unknown) => v === null || typeof v === 'string'
const objects = (v: unknown) => Array.isArray(v) && v.every((x) => x !== null && typeof x === 'object' && !Array.isArray(x))
// server/src/compose.js pollField: 1-10 answers, each with poll_media.text (also when it has an emoji)
const poll = (v: any) => v === null || (typeof v?.question?.text === 'string' && objects(v.answers) && v.answers.every((a: any) => typeof a.poll_media?.text === 'string'))
// Only keys every honest payload sends with that type (`value` is a number in choices, `roles` is checked as an id list;
// under `resolved`, `members` and `channels` are maps, and module data is free-form).
const SHAPES = new Map<string, (v: unknown) => boolean>([
  ...['name', 'content', 'username', 'global_name', 'topic', 'description', 'title', 'label', 'text', 'nick'].map((k) => [k, strOrNull] as const),
  ...['mentions', 'attachments', 'reactions', 'channels', 'members', 'emojis'].map((k) => [k, Array.isArray] as const),
  ...['embeds', 'components', 'answers', 'choices', 'fields'].map((k) => [k, objects] as const), // rendered element by element
  ['poll', poll],
])
const isIdKey = (k: string) => (k === 'id' || k.endsWith('_id')) && !FREE_IDS.has(k)
const isIdList = (k: string) => ID_LISTS.has(k) || k.endsWith('_ids')
// Content tokens naming ids: <@1>, <@!1>, <@&1>, <#1>, <:name:1>, <a:name:1>; one that already carries a prefix is forged.
const TOKENS = /<(@!?|@&|#|a?:\w{1,32}:)(\d{1,20})>/g
const FORGED = /<(@!?|@&|#|a?:\w{1,32}:)[\d~]*~[\d~]*>/g

// Distinct ids each node brought in since its last READY: past the budget it is cut off (instances/nodes.ts).
const seen = new Map<string, Set<string>>()
// READYs on the current connection: an honest server sends one (server/src/gateway.js closes a second IDENTIFY and a
// resume ends in RESUMED), so another one counts as over budget instead of resetting it.
const readies = new Map<string, number>()
// When each node's last READY was admitted: one within a minute of it (across connections) keeps counting on the old budget.
const lastReady = new Map<string, number>()
const QUICK_READY = 60_000
/** A new gateway connection to the node (instances/nodes.ts): it may send one READY. */
export const newConnection = (inst: string) => void readies.delete(inst)
export const overBudget = (inst: string) => (seen.get(inst)?.size ?? 0) > LIMITS.budget || (readies.get(inst) ?? 0) > 1
/** A node gateway session id as we keep it: 32 hex characters, as server/src/gateway.js makes them. */
export const sessionOf = (v: unknown) => (typeof v === 'string' && /^[0-9a-f]{32}$/.test(v) ? v : null)

/** A node payload in the client's terms, or null when it breaks the rules: bounded size (depth, list length, total
 *  values, distinct ids per node), every id a canonical numeric snowflake string, then ids scoped to the node (user
 *  references to our node account → our hub id, and such user objects → our hub record), root-relative URLs made
 *  absolute, foreign media dropped, forged prefixed text tokens neutralised. */
function inbound<T>(n: Live, data: T, moduleData = false): T | null {
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
  const spend = (what: string) => {
    ids.add(what)
    if (ids.size > LIMITS.budget) throw bad
  }
  const userRef = (v: unknown) => (n.meId && v === n.meId ? hub.meId || ref(v) : ref(v))
  const self = () => ({ ...(view.user(hub.meId) ?? { id: hub.meId }) })
  let count = 0
  // loose: inside module data (free-form, third-party), SHAPES do not apply; sizes and id rules do
  const walk = (x: unknown, key: string, depth: number, free: boolean, userObj: boolean, loose = false): unknown => {
    if (++count > LIMITS.nodes || depth > LIMITS.depth) throw bad
    if (typeof x === 'string') {
      if (x.length > (key === 'image' ? LIMITS.image : LIMITS.text)) throw bad // a few huge strings would fill memory
      if (key === 'session_id' && n.sessionId && x === n.sessionId) return hub.sessionId || x
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
      if (isIdList(key) && x.some((v) => typeof v !== 'object' || v === null)) {
        // inside a template, lists number its own roles: numbers or short strings, kept as they are
        if (free) return x.map((v) => (typeof v === 'number' || (typeof v === 'string' && v.length <= 100) ? v : (() => { throw bad })()))
        return x.map((v) => (USER_LISTS.has(key) ? userRef(v) : ref(v)))
      }
      return x.map((v) => walk(v, key, depth + 1, free, userObj, loose))
    }
    if (!x || typeof x !== 'object') return x
    const inFree = free || FREE_TREES.has(key)
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(x)) {
      // free choices a node could use to grow what we keep (property names, emoji names, answer numbers) spend its
      // budget like ids do; an honest server uses a small fixed set of them
      if (!SNOW.test(k)) spend(`.${k}`)
      if (k.length > LIMITS.key || (!loose && key !== 'resolved' && SHAPES.get(k)?.(v) === false)) throw bad
      if (isIdList(k) && v != null && !Array.isArray(v)) throw bad // an id list that is not a list
      // our presence and activities are the hub's: a node's entry for our node account is dropped
      if (k === 'presences' && Array.isArray(v)) {
        out[k] = walk(v.filter((p) => !(n.meId && (p as { user?: { id?: unknown } } | null)?.user?.id === n.meId)), k, depth + 1, inFree, false, loose)
        continue
      }
      if (key === 'emoji' && k === 'name' && typeof v === 'string') { if (v.length > LIMITS.emoji) throw bad; spend(`:${v}`) }
      if (key === 'emojis' && k === 'name' && typeof v !== 'string') throw bad // custom emoji names are searched as text everywhere
      // a profile effect is named after a built-in preset, not a snowflake
      if (key === 'profile_effect' && k === 'id' && typeof v === 'string') { if (!PRESET.test(v)) throw bad; out[k] = v; continue }
      const typed = (key === 'emoji' && k === 'id') || key === 'default_values'
      if (typeof v === 'number' && (NUMERIC_IDS.has(k) || (k === 'id' && key === 'answer_counts'))) { spend(`#${k}${v}`); out[k] = v; continue }
      if (typeof v === 'string' && (k === 'track_id' || (k === 'id' && key === 'tracks'))) {
        if (!TRACK.test(v)) throw bad
        out[k] = scoped(inst, v)
        continue
      }
      if ((isIdKey(k) || USER_ID_KEYS.has(k)) && v != null && (!inFree || typed)) {
        out[k] = USER_ID_KEYS.has(k) || (k === 'id' && (userObj || (key === 'default_values' && (x as { type?: unknown }).type === 'user'))) ? userRef(v) : ref(v)
        continue
      }
      if (inFree && isIdKey(k) && v != null && typeof v !== 'number' && (typeof v !== 'string' || v.length > 100)) throw bad
      if (key === 'resolved' && v && typeof v === 'object' && !Array.isArray(v)) {
        const m: Record<string, unknown> = {}
        const users = k === 'users' || k === 'members'
        for (const [rk, rv] of Object.entries(v)) m[users ? userRef(rk) : ref(rk)] = walk(rv, k, depth + 2, inFree, users, loose)
        out[k] = m
        continue
      }
      out[k] = walk(k === 'attachments' && Array.isArray(v) ? v.filter((a) => onNode(n, a)) : v, k, depth + 1, inFree, USER_OBJECTS.has(k), loose || (moduleData && depth === 0 && k === 'data'))
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
const CHANNEL_BY_ID = ['VOICE_CHANNEL_STATUS_UPDATE', 'CHANNEL_CREATE', 'CHANNEL_UPDATE', 'CHANNEL_DELETE', 'THREAD_CREATE', 'THREAD_UPDATE', 'THREAD_DELETE', 'THREAD_MEMBER_UPDATE', 'THREAD_MEMBERS_UPDATE']
const BY_GUILD = ['GUILD_ROLE_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE', 'GUILD_MEMBER_ADD', 'GUILD_MEMBER_UPDATE', 'GUILD_MEMBER_REMOVE', 'GUILD_BAN_ADD',
  'GUILD_BAN_REMOVE', 'GUILD_EMOJIS_UPDATE', 'GUILD_STICKERS_UPDATE', 'GUILD_SCHEDULED_EVENT_CREATE', 'GUILD_SCHEDULED_EVENT_UPDATE',
  'GUILD_SCHEDULED_EVENT_DELETE', 'GUILD_SCHEDULED_EVENT_USER_ADD', 'GUILD_SCHEDULED_EVENT_USER_REMOVE', 'GUILD_SOUNDBOARD_SOUND_CREATE',
  'GUILD_SOUNDBOARD_SOUND_UPDATE', 'GUILD_SOUNDBOARD_SOUND_DELETE', 'GUILD_SOUNDBOARD_SOUNDS_UPDATE', 'GUILD_APPLICATION_COMMAND_INDEX_UPDATE',
  'GUILD_MODULE_PANELS_UPDATE', 'MODULE_UI_EVENT', 'VOICE_STATE_UPDATE', 'USER_GUILD_SETTINGS_UPDATE', 'THREAD_LIST_SYNC']
const BY_CHANNEL = ['MESSAGE_CREATE', 'MESSAGE_UPDATE', 'MESSAGE_DELETE', 'MESSAGE_DELETE_BULK', 'MESSAGE_REACTION_ADD', 'MESSAGE_REACTION_REMOVE',
  'MESSAGE_REACTION_REMOVE_ALL', 'MESSAGE_REACTION_REMOVE_EMOJI', 'MESSAGE_POLL_VOTE_ADD', 'MESSAGE_POLL_VOTE_REMOVE', 'MESSAGE_ACK', 'TYPING_START',
  'CHANNEL_PINS_UPDATE', 'CHANNEL_CANVAS_UPDATE', 'STAGE_INSTANCE_CREATE', 'STAGE_INSTANCE_UPDATE', 'STAGE_INSTANCE_DELETE', 'WATCH_SESSION_UPDATE',
  'WATCH_SESSION_DELETE', 'VOICE_CHANNEL_EFFECT_SEND']
const VOICE = ['VOICE_SERVER_UPDATE', 'CILLVOICE_ANSWER', 'CILLVOICE_TRACKS', 'CILLVOICE_SPEAKING', 'CILLVOICE_ERROR']
const INTERACTIONS = ['INTERACTION_CREATE', 'INTERACTION_SUCCESS', 'INTERACTION_FAILURE', 'INTERACTION_MODAL_CREATE', 'APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE']
const TERMINAL = new Set(['INTERACTION_SUCCESS', 'INTERACTION_FAILURE', 'INTERACTION_MODAL_CREATE', 'APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE'])
const mine = (inst: string, id: unknown) => typeof id === 'string' && nodeOf(id) === inst

function allowed(inst: string, t: string, d: any): boolean {
  if (t === 'READY' && d.user?.id !== hub.meId) return false // a READY must name our node account
  // a member sent next to user_id (voice states, typing, reactions) must be that user, else it is dropped
  if (d.member?.user && d.member.user.id !== d.user_id) delete d.member
  if (t === 'READY') return true
  if (BY_ID.includes(t)) return mine(inst, d.id)
  if (CHANNEL_BY_ID.includes(t)) return mine(inst, d.id) && mine(inst, d.guild_id ?? view.channel(d.id)?.guild_id)
  if (BY_GUILD.includes(t)) return mine(inst, d.guild_id) && (d.channel_id == null || mine(inst, d.channel_id))
  // read marks of other people (DM recipient reads) are the hub's; a node's ack may only be ours
  if (t === 'MESSAGE_ACK' && d.user_id != null && d.user_id !== hub.meId) return false
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
    if (t === 'INTERACTION_MODAL_CREATE' && (p.type === 5 || !Array.isArray(d.components))) return false
    d.channel_id = p.channelId
    if (t === 'INTERACTION_MODAL_CREATE') d.application = { ...(d.application && typeof d.application === 'object' ? d.application : {}), id: p.appId }
    if (TERMINAL.has(t)) view.consume(d.nonce)
    return true
  }
  return false
}

/** A node gateway event (or READY) as the store may apply it, or null to drop it. READY starts the node's id budget anew. */
export function admit<T>(inst: string, t: string, raw: T): T | null {
  if (t === 'READY' && readies.set(inst, (readies.get(inst) ?? 0) + 1).get(inst)! > 1) return null
  // a READY is read with the node account and session it names; instances/nodes.ts keeps them only once it is admitted
  const r = raw as { user?: { id?: unknown }; session_id?: unknown } | null
  const meId = typeof r?.user?.id === 'string' && SNOW.test(r.user.id) ? r.user.id : null
  if (t === 'READY' && live[inst]?.meId && meId !== live[inst].meId) return null // another account than the sign-in's
  const n = live[inst] && t === 'READY' ? { ...live[inst], meId, sessionId: sessionOf(r?.session_id) } : live[inst]
  // A READY is counted on a fresh budget, which replaces the old one only if it passes; instances/nodes.ts then drops
  // everything the node brought before (dropNodeState) before applying it. A refused READY changes nothing. A READY
  // within a minute of the last one keeps the old budget (a node cycling its connection does not get a fresh one).
  const before = seen.get(inst)
  if (n && t === 'READY' && !(Date.now() - (lastReady.get(inst) ?? -QUICK_READY) < QUICK_READY)) seen.delete(inst)
  const d = n ? (inbound(n, t === 'READY' ? (readyPart(raw) as T) : raw, t === 'MODULE_UI_EVENT') as any) : null
  const ok = !!d && typeof d === 'object' && allowed(inst, t, d)
  if (!ok && t === 'READY') before ? seen.set(inst, before) : seen.delete(inst)
  if (ok && t === 'READY') lastReady.set(inst, Date.now())
  return ok ? (d as T) : null
}

/** The part of a node READY the client uses (instances/nodes.ts ready()): node-local DMs, friends, settings, notes and
 *  instance info are not ours to keep and cannot refuse the connection. */
const READY_FIELDS = ['session_id', 'guilds', 'users', 'presences', 'read_state', 'user_guild_settings'] as const
export function readyPart(raw: unknown) {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const user = r.user as { id?: unknown } | undefined
  return { user: { id: user?.id }, ...Object.fromEntries(READY_FIELDS.filter((k) => k in r).map((k) => [k, r[k]])) }
}

/** Our presence as one node may see it: a custom emoji or text reference of another server is left out. */
export function presenceFor(inst: string, p: any) {
  if (!p || typeof p !== 'object') return p
  const fits = (id: unknown) => typeof id !== 'string' || nodeOf(id) === inst
  const clean = (x: unknown) => (typeof x === 'string' ? x.replace(ANY_TOKEN, (m, _k, a: string, b?: string) => (b !== undefined && a === inst ? m : '')) : x)
  return {
    ...p,
    activities: (Array.isArray(p.activities) ? p.activities : []).map((a: any) => ({
      ...a, state: clean(a?.state), name: clean(a?.name), ...(a?.emoji && { emoji: a.emoji.id && !fits(a.emoji.id) ? null : a.emoji }),
    })),
  }
}

// Every store map a node can write into, keyed by node-scoped ids: dropNodeState prunes all of them (pruneNode), and
// scripts/private-nodes.test.mjs checks that every State key is listed here or in HUB_STATE.
export const NODE_MAPS = ['guilds', 'channels', 'users', 'members', 'membersLoaded', 'presences', 'messages', 'hasMore', 'typing', 'voiceStates',
  'readStates', 'pinsVersion', 'canvas', 'hasNewer', 'stageInstances', 'events', 'eventSubs', 'sounds', 'threadMembersVersion', 'slowmode',
  'guildSettings', 'activities', 'watch', 'drafts', 'purgeSelected', 'simulatedRoles'] as const
// State a node never writes (hub-only events, our own UI state) or that holds one value, not a map per object.
export const HUB_STATE = ['token', 'status', 'sessionId', 'me', 'relationships', 'bansVersion', 'editingId', 'replying', 'voice', 'modal', 'popout',
  'showNav', 'jump', 'panel', 'updateReady', 'settings', 'calls', 'interactions', 'autocomplete', 'showMembers', 'game', 'leagueLobby', 'reminders',
  'bookmarks', 'modulePage', 'guideGuildId', 'dmRecipientReads', 'purgeMode'] as const
/** A node REST answer, same rules (`moduleData`: a module UI answer, whose `data` is free-form). */
export function admitRest<T>(inst: string, raw: T, moduleData = false): T | null {
  const n = live[inst]
  return n && n.status !== 'cut-off' ? inbound(n, raw, moduleData) : null // a cut-off node's late answers are not applied
}

/** The reverse for a request body or a gateway op going to the node: its ids lose the prefix (values and map keys), our
 *  hub id becomes our node id. Ids of the hub or another node are left as they are (the node does not know them). */
export function outbound<T>(inst: string, data: T): T {
  const n = live[inst]
  const pre = inst + SEP
  const me = (x: unknown) => !!n?.meId && !!hub.meId && x === hub.meId
  const bare = (x: string) => (x.startsWith(pre) && SNOW.test(x.slice(pre.length)) ? x.slice(pre.length) : x)
  // our hub id becomes our node id only in typed user positions, never a stripped resource id that happens to equal it
  const strip = (x: string, user: boolean) =>
    user && me(x) ? n!.meId!
    : bare(x).replace(ANY_TOKEN, (m, kind: string, a: string, b?: string) =>
      b !== undefined ? (a === inst ? `<${kind}${b}>` : m) // our node's id, bare
      : (kind === '@' || kind === '@!') && me(a) ? `<${kind}${n!.meId}>` : m) // a user mention of us; one pass, never both
  const walk = (x: unknown, key: string, userObj: boolean): unknown =>
    typeof x === 'string' && key === 'track_id' && x.startsWith(pre) ? x.slice(pre.length)
    : typeof x === 'string' ? strip(x, USER_ID_KEYS.has(key) || USER_LISTS.has(key) || (key === 'id' && userObj))
    : Array.isArray(x) ? x.map((v) => walk(v, key, userObj))
    : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [bare(k), walk(v, k, USER_OBJECTS.has(k) || (k === 'id' && userObj))]))
    : x
  return walk(data, '', false) as T
}
const ANY_TOKEN = /<(@!?|@&|#|a?:\w{1,32}:)(\d{1,20})(?:~(\d{1,20}))?>/g
// Path segments that name a user: our hub id there becomes our node id.
const USER_SEGMENT_PARENTS = new Set(['users', 'members', 'recipients', 'bans', 'thread-members'])
/** A path (and query) going to the node: its scoped ids bare (also inside `name:id` emoji segments, URL-encoded too); our
 *  bare hub id becomes our node id only right after a user collection, checked before stripping. */
export const outboundPath = (inst: string, path: string) => {
  const n = live[inst]
  const strip = (x: string) => x.replace(new RegExp(`(?<!\\d)${inst}${SEP}(?=\\d)`, 'g'), '')
  const [p, q] = path.split(/\?(.*)/s)
  const segs = p.split('/')
  const out = segs.map((seg, i) => (n?.meId && hub.meId && seg === hub.meId && USER_SEGMENT_PARENTS.has(segs[i - 1]) ? n.meId : strip(seg))).join('/')
  return q === undefined ? out : `${out}?${strip(q)}`
}

/** A body may only reference objects of the server it goes to (forwards, replies, stickers, mentions, emoji…): to a
 *  node, every id (fields, id lists, id-keyed map keys, text tokens) is that node's or our own user id; to the hub, none
 *  is a node's, except the hub's own lists of rail servers (guild_folders, guild_positions). */
const RAIL_LISTS = new Set(['guild_ids', 'guild_positions'])
const TEXT_KEYS = new Set(['content', 'value', 'description', 'title', 'text', 'name', 'topic'])
export function bodyFits(body: unknown, to: string | undefined) {
  const fits = (v: string) => (to ? nodeOf(v) === to || v === hub.meId : nodeOf(v) === undefined)
  const idLike = (v: unknown): v is string => typeof v === 'string' && /^\d{1,20}(~\d{1,20})?$/.test(v)
  let ok = true
  const walk = (x: unknown, key: string, depth: number): void => {
    if (!ok || depth > LIMITS.depth) return
    if (typeof x === 'string') {
      if (TEXT_KEYS.has(key))
        for (const m of x.matchAll(ANY_TOKEN)) if (!fits(m[3] !== undefined ? `${m[2]}~${m[3]}` : m[2])) ok = false
      return
    }
    if (Array.isArray(x)) {
      if (isIdList(key) || RAIL_LISTS.has(key)) { if (!(RAIL_LISTS.has(key) && !to) && x.some((v) => idLike(v) && !fits(v))) ok = false; return }
      return x.forEach((v) => walk(v, key, depth + 1))
    }
    if (!x || typeof x !== 'object') return
    for (const [k, v] of Object.entries(x)) {
      if (key === 'attachments' && k === 'id') continue // upload slots ('0', '1', …) and attachment ids of the message itself
      if (idLike(k) && !fits(k)) ok = false
      if (idLike(v) && isIdKey(k)) { if (!fits(v)) ok = false }
      else walk(v, k, depth + 1)
    }
  }
  walk(body, '', 0)
  return ok
}

/** `r` without the entries of node `inst` that are not in `keep` (users, presences… of a node server that left). */
export const pruneNode = <V,>(inst: string, r: Record<string, V>, keep: Set<string>) => Object.fromEntries(Object.entries(r).filter(([k]) => nodeOf(k) !== inst || keep.has(k)))

/** A LiveKit participant of a call on node `inst` as our user id (or null when the identity is not a snowflake). */
export const nodeUserId = (inst: string | undefined, identity: string) => {
  if (!inst) return SNOW.test(identity) ? identity : null
  const n = live[inst]
  if (!SNOW.test(identity)) return null
  return n?.meId && identity === n.meId ? hub.meId : scoped(inst, identity)
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
  lastReady.delete(id)
  hub.meId = hubMeId
}
