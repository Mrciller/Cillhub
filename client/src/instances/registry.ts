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
const origins = new Map<string, string>() // snowflake -> instance id (node-owned ids only; hub ids are never recorded)
const hub = { meId: '', sessionId: '' }
// Ids the hub already showed us (store.ts registers it: its guilds, channels and users). A node never takes those over.
let hubHas: (id: string) => boolean = () => false
export const setHubHas = (f: (id: string) => boolean) => void (hubHas = f)
/** A guild or channel the hub sent us (its GUILD_CREATE): the hub wins over a node that named the id first. */
export const hubTakes = (id: string) => void origins.delete(id)
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
  live = rest // its ids stay in `origins`: they still are not the hub's, and a new sign-in to the same node owns them again
  persist()
  emit()
}
export function setLive(id: string, patch: Partial<Live>) {
  if (!live[id]) return
  live = { ...live, [id]: { ...live[id], ...patch } }
  emit()
}
/** Our hub user and gateway session (from the hub's READY); node payloads are aliased to these. */
export const setHubIdentity = (meId: string, sessionId: string) => ((hub.meId = meId), (hub.sessionId = sessionId))

/** The node a snowflake (guild, channel, user, message, emoji…) belongs to; undefined = the hub. */
export const nodeOf = (id: string | null | undefined) => (id ? origins.get(id) : undefined)

const SNOWFLAKE = /^\d+$/
// Root-relative URLs in node payloads point at the node: made absolute on the way in (attachments, embeds, voice endpoint).
const URL_KEYS = new Set(['url', 'proxy_url', 'icon_url', 'proxy_icon_url', 'avatar_url', 'sound_url', 'endpoint'])
// Media the client loads by itself (attachments, entrance sounds, webhook avatars) must come from the node's own origin.
const MEDIA_KEYS = new Set(['avatar_url', 'sound_url'])
const onNode = (n: Live, a: unknown) => {
  const u = (a as { url?: unknown } | null)?.url
  return typeof u !== 'string' || u.startsWith(n.url + '/') || (u.startsWith('/') && !u.startsWith('//'))
}
const swapMentions = (s: string, from: string, to: string) => (from && s.includes(from) ? s.replaceAll(`<@${from}>`, `<@${to}>`).replaceAll(`<@!${from}>`, `<@${to}>`) : s)

/** A node payload as the hub-centred store expects it: our node ids aliased, its ids recorded, its root-relative URLs made absolute. */
export function inbound<T>(id: string, data: T): T {
  const n = live[id]
  if (!n) return data
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
    for (const [k, v] of Object.entries(x)) {
      // `hub_user_id` and friends name hub accounts, not node objects.
      // First writer wins, and never our hub user or an id the hub already showed us (else a node could take over hub DMs and servers).
      if ((k === 'id' || k.endsWith('_id')) && !k.startsWith('hub_') && typeof v === 'string' && SNOWFLAKE.test(v) && v !== n.meId
        && v !== hub.meId && !origins.has(v) && !hubHas(v)) origins.set(v, id)
      out[k] = walk(k === 'attachments' && Array.isArray(v) ? v.filter((a) => onNode(n, a)) : v, k)
    }
    return out
  }
  return walk(data) as T
}

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

/** Which node a REST path or CDN path belongs to: the first node-owned snowflake in the path, else `guild_id`/`channel_id` in the query or body. */
export function route(path: string, body?: unknown): string | undefined {
  const [p, q] = path.split('?')
  // A node may name any user id (also hub users we have not seen yet), so /users/... goes to a node only through the
  // node guild or channel given as context below, never by the user id in the path.
  if (!p.startsWith('/users/')) for (const seg of p.split('/')) {
    const s = seg.replace(/\.\w+$/, '')
    const n = origins.get(s)
    if (n) return n
    if (s !== hub.meId && hubHas(s)) return undefined // a hub channel decides for the messages under it
  }
  const params = new URLSearchParams(q ?? '')
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {}
  for (const k of ['guild_id', 'channel_id']) {
    const n = origins.get(params.get(k) ?? '') ?? (typeof b[k] === 'string' ? origins.get(b[k] as string) : undefined)
    if (n) return n
  }
  return undefined
}

if (import.meta.env.DEV) {
  // self-check: aliasing round-trips and routing picks the node for its ids only
  live.__t = { id: '__t', name: 't', url: 'https://n.example', status: 'ready', meId: '9', sessionId: 'ns' }
  hub.meId = '1'
  const d = inbound('__t', { id: '77', author: { id: '9' }, content: 'hi <@9>', session_id: 'ns', attachments: [{ url: '/attachments/77/1/a.png' }] })
  console.assert(d.author.id === '1' && d.content === 'hi <@1>' && d.attachments[0].url === 'https://n.example/attachments/77/1/a.png', 'inbound aliasing')
  console.assert(route('/channels/77/messages') === '__t' && route('/channels/78/messages') === undefined && route('/users/1/profile?guild_id=77') === '__t', 'routing')
  console.assert(route('/users/9/profile') === undefined && route('/users/@me/relationships/77') === undefined, 'user routes stay on the hub')
  const m = inbound('__t', { attachments: [{ url: 'https://evil.example/a.png' }, { url: 'https://n.example/attachments/1/2/b.png' }], sound_url: 'https://evil.example/s.ogg' })
  console.assert(m.attachments.length === 1 && m.attachments[0].url.startsWith('https://n.example/') && m.sound_url === undefined, 'node media from the node only')
  console.assert(outbound('__t', { content: '<@1>', user_id: '1' }).user_id === '9' && outboundPath('__t', '/guilds/77/members/1') === '/guilds/77/members/9', 'outbound aliasing')
  origins.delete('77')
  delete live.__t
  hub.meId = ''
}
