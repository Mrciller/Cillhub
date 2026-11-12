// Multi-instance client (CONTRACT-v7 §4): one gateway connection per linked node next to the hub's, node payloads merged
// into the one store (aliased in registry.ts), sign-in to a node through the hub identity flow, "Disconnect from instance",
// and the hub's view of node status (suspended / banned / unlinked nodes are cut off, offline ones keep retrying).
import { enterGuild, sentInteractions } from '../actions'
import { api, ApiError, qs, apiOrigin, savedNodes, saveNodes, NODES_KEY } from '../api'
import { soundEvent } from '../custom/sounds'
import { createGateway, type Gateway } from '../gateway'
import { t } from '../i18n'
import { notifyEvent } from '../notifications/notify'
import { navigate } from '../router'
import { gatewayOk, inSession, keepSignIn, MAX_NODES, normalizeServerUrl, revocations } from '../privateNodes'
import { apply, byId, getState, setState, setToken, type State } from '../store'
import type { GuildPayload, Presence, ReadState, User, UserGuildSettings } from '../types'
import { leaveVoice, voiceEvent } from '../voice/engine'
import { admit, NODE_MAPS, outbound, presenceFor, overBudget, pruneNode, scoped, instanceById, instances, nodeOf, removeInstance, saveInstance, setIssue, setLive, setView, tokenOf, type InstanceInfo } from './registry'

/** The hub's node directory record (§2), from GET /federation/nodes. */
export type NodeRecord = {
  node_id: string; name: string; url: string; description?: string | null; icon?: string | null; version?: string | null
  mode?: 'connected' | 'standalone'; public_servers_count?: number; member_count?: number; online: boolean; last_seen?: string | null
  status: 'active' | 'suspended' | 'banned' | 'unlinked'
}
export const nodeInfo = (n: Pick<NodeRecord, 'node_id' | 'name' | 'url' | 'icon'>): InstanceInfo => ({ id: n.node_id, name: n.name, url: n.url.replace(/\/+$/, ''), icon: n.icon ?? null })
export const listNodes = () => api<NodeRecord[]>('/federation/nodes')

const conns = new Map<string, Gateway>()
const NODE_FRAME_BYTES = 4 * 1024 * 1024 // a node gateway frame above this closes the connection

// What the node boundary (registry.ts admit) may ask about the client's state.
setView({
  user: (id) => getState().users[id],
  channel: (id) => getState().channels[id],
  interaction: (nonce) => {
    const p = typeof nonce === 'string' ? sentInteractions.get(nonce) : undefined
    return p && Date.now() - p.at < 15 * 60_000 ? p : undefined
  },
  consume: (nonce) => void sentInteractions.delete(nonce),
  voiceGuild: () => getState().voice.guildId,
})
const statusOf = (id: string) => instanceById(id)?.status

/** Opens the gateways of saved instances that have a token and are not cut off (after the hub's READY). */
export function startNodes() {
  for (const i of instances()) if (!conns.has(i.id) && tokenOf(i.id) && i.status !== 'suspended' && i.status !== 'signed-out' && i.status !== 'cut-off') open(i)
  void refreshStatus()
  syncPrivateNodes()
}
export function stopNodes() {
  for (const g of conns.values()) g.disconnect()
  conns.clear()
}
/** Sends an op to one node (or to every ready node with `null`, for presence). */
export function nodeSend(id: string | null, op: number, d: unknown) {
  // ops go out in the node's own ids (scoped ones bare, our hub id as our node id)
  // our presence (op 3) goes to each node without other servers' custom emoji or references
  const to = (n: string) => outbound(n, op === 3 ? presenceFor(n, d) : d)
  if (id === null) return [...conns].map(([n, g]) => g.send(op, to(n))).some(Boolean)
  return conns.get(id)?.send(op, to(id)) ?? false
}

function open(i: InstanceInfo) {
  const g = createGateway({
    // The node names its gateway; our node token goes only to the node's own host.
    url: () => api<{ url: string }>('/gateway', { instance: i.id }).then((r) => {
      if (!gatewayOk(i.url, r.url)) throw new Error('gateway not on the node')
      return r
    }),
    maxBytes: NODE_FRAME_BYTES,
    presence: (p) => outbound(i.id, presenceFor(i.id, p)), // IDENTIFY too
    token: () => tokenOf(i.id),
    ready: () => statusOf(i.id) === 'ready',
    connecting: (failed) => setLive(i.id, { status: failed ? 'offline' : 'connecting' }),
    // The node ends our sessions when the hub suspends, bans or unlinks it: ask the hub which it is. A saved private node
    // gets a new background sign-in (with backoff).
    rejected: () => (close(i.id), setLive(i.id, { status: 'signed-out' }), void refreshStatus(), savedNodes().some((n) => n.origin === i.url) && retry(i.url, t('Signed out'))),
    dispatch: (t, d) => dispatch(i.id, t, d),
  })
  conns.set(i.id, g)
  g.connect()
}
/** Over its budget (registry.ts) or its data broke the client: disconnected, its servers and all it brought dropped, the
 *  state shown, until the next start. */
function cutOff(id: string) {
  close(id)
  if (nodeOf(getState().voice.guildId) === id) leaveVoice()
  for (const g of Object.keys(getState().guilds)) if (nodeOf(g) === id) apply('GUILD_DELETE', { id: g })
  dropNodeState(id)
  setLive(id, { status: 'cut-off' })
}
/** After a render error (main.tsx): every node with state in the store is cut off. Which one's data broke the render is not
 *  known, so all of them. One name per node cut off, none when no node had state. */
export function cutOffNodes() {
  const s = getState()
  const ids = new Set(NODE_MAPS.flatMap((k) => Object.keys(s[k]).map(nodeOf)).filter((x): x is string => !!x))
  for (const id of ids) cutOff(id)
  return [...ids].map((id) => instanceById(id)?.name ?? '') // '': leftovers of a node removed meanwhile
}
function close(id: string) {
  conns.get(id)?.disconnect()
  conns.delete(id)
}

// A node event the client cannot apply (wrong-typed fields the boundary lets through) cuts the node off, like an over-budget
// one: whatever part of it was applied goes with the node's state.
function dispatch(id: string, t: string, raw: any) {
  try { handle(id, t, raw) } catch (e) { console.warn(`Node ${id}: ${t} could not be applied, cut off`, e); cutOff(id) }
}
function handle(id: string, t: string, raw: any) {
  if (t === 'READY' && /^\d{1,20}$/.test(raw?.user?.id ?? '')) setLive(id, { meId: raw.user.id, sessionId: typeof raw.session_id === 'string' ? raw.session_id : null })
  // The one way in for node events: shape, ids, event type, target ownership and users are checked there.
  const d = admit(id, t, raw)
  if (!d) return void (overBudget(id) && cutOff(id))
  if (t === 'READY') return ready(id, d)
  const s = getState()
  apply(t, d)
  keepHubSelf(s)
  if (t === 'GUILD_DELETE') dropNodeState(id) // its members leave unless another server of the node still has them
  voiceEvent(t, d)
  notifyEvent(t, d)
  soundEvent(t, d, s)
}

/** Our hub user record as it was before a node event: no node write may change it (one place for every node event). */
function keepHubSelf(before: State) {
  const me = before.me?.id
  const mine = me && before.users[me]
  if (mine && getState().users[me] !== mine) setState((x) => ({ users: { ...x.users, [me]: mine } }))
}

/** Everything of node `id` in every node-writable map (registry NODE_MAPS) that none of its remaining servers holds:
 *  their ids, channels, members and events stay, the rest goes. */
function dropNodeState(id: string) {
  const s = getState()
  const keep = new Set<string>()
  for (const g of Object.keys(s.guilds)) if (nodeOf(g) === id) {
    keep.add(g)
    for (const u of Object.keys(s.members[g] ?? {})) keep.add(u)
  }
  for (const [c, ch] of Object.entries(s.channels)) if (keep.has(ch.guild_id ?? '')) keep.add(c)
  for (const [e, ev] of Object.entries(s.events)) if (keep.has(ev.guild_id)) keep.add(e)
  setState(Object.fromEntries(NODE_MAPS.map((k) => [k, pruneNode(id, s[k] as Record<string, unknown>, keep)])) as Partial<State>)
}

const list = <T,>(x: unknown): T[] => (Array.isArray(x) ? x : Array.isArray((x as { entries?: unknown })?.entries) ? (x as { entries: T[] }).entries : [])

function ready(id: string, d: { guilds?: GuildPayload[]; users?: User[]; presences?: Presence[]; read_state?: unknown; user_guild_settings?: unknown }) {
  const guilds = d.guilds ?? []
  const me = getState().me?.id
  // Replaced wholesale (like the hub's READY): drops servers we left while away, stale members and voice states, and
  // anything applied from a REST answer before our node identity was known (not yet aliased).
  for (const g of Object.keys(getState().guilds)) if (nodeOf(g) === id) apply('GUILD_DELETE', { id: g })
  const before = getState()
  dropNodeState(id) // what the node brought before goes too, so its id budget (reset by this READY) matches what is kept
  for (const g of guilds) apply('GUILD_CREATE', g)
  setState((s) => ({
    users: { ...byId((d.users ?? []).filter((u) => u.id !== me)), ...s.users },
    presences: { ...s.presences, ...Object.fromEntries((d.presences ?? []).filter((p) => p.user.id !== me).map((p) => [p.user.id, p.status])) },
    readStates: { ...s.readStates, ...byId(list<ReadState>(d.read_state).filter((r) => r && nodeOf(r.id) === id)) },
    guildSettings: { ...s.guildSettings, ...Object.fromEntries(list<UserGuildSettings>(d.user_guild_settings).filter((g) => g?.guild_id && nodeOf(g.guild_id) === id).map((g) => [g.guild_id!, g])) },
  }))
  keepHubSelf(before)
  setLive(id, { status: 'ready' })
  // A call on this node's server survives a node reconnect the same way a hub call survives a hub reconnect.
  if (nodeOf(getState().voice.guildId) === id) voiceEvent('READY', d)
}

let polling = 0
/** Asks the hub which linked nodes are usable; suspended, banned or unlinked ones are disconnected and their servers removed
 *  (the instance stays in "Your other instances"; a node that is active again needs a new sign-in, its sessions were ended). */
export async function refreshStatus() {
  clearTimeout(polling)
  polling = setTimeout(refreshStatus, 5 * 60_000)
  if (!instances().length) return
  const records = await listNodes().catch(() => null)
  if (!records) return
  for (const i of instances()) {
    const r = records.find((x) => x.node_id === i.id)
    if (!r || r.status !== 'active') {
      close(i.id)
      setLive(i.id, { status: 'suspended' })
      if (nodeOf(getState().voice.guildId) === i.id) leaveVoice()
      for (const g of Object.keys(getState().guilds)) if (nodeOf(g) === i.id) apply('GUILD_DELETE', { id: g })
    }
    else {
      setLive(i.id, { name: r.name, icon: r.icon ?? null, ...(!r.online && i.status !== 'ready' && { status: 'offline' }) })
      if (i.status === 'suspended' && tokenOf(i.id)) (setLive(i.id, { status: 'connecting' }), open(i))
    }
  }
}

// ---------- Sign-in through the hub (§3) ----------
// The node runs the OAuth2 code flow with PKCE against the hub; we only open its start URL. It ends on our
// /instances/callback with `#token=<node token>&state=<ours>&node_id=<id>` (or `#error=…`), see Callback.tsx.
type Then = { invite?: string; guild?: string }
/** `self`: this instance is a node and the user signs in here with their hub account (login page). */
type Pending = { state: string; node: InstanceInfo; then: Then; at: number; popup: boolean; self?: boolean }
const PENDING = 'instance-signin'
const CHANNEL = 'cillcord-instance-signin'

/** Joins a node server (by invite code or directory listing), signing in to the node first if we have no token for it. */
export async function joinOnNode(node: InstanceInfo, then: Then) {
  if (tokenOf(node.id) && instanceById(node.id)?.status !== 'signed-out') {
    // A node that was suspended or unlinked meanwhile has ended our session there: then sign in again.
    try { return await finish(node.id, then) } catch (e) { if (!(e instanceof ApiError && e.status === 401)) throw e }
    setLive(node.id, { status: 'signed-out' })
  }
  const state = crypto.randomUUID()
  // The hub's web address: nodes send tokens back only there (the desktop app opens that callback page in itself).
  const url = `${node.url}/api/v9/federation/hub-login${qs({ return_to: `${apiOrigin()}/instances/callback`, state })}`
  const popup = window.open('', 'cillcord-signin', 'popup,width=520,height=720')
  localStorage.setItem(PENDING, JSON.stringify({ state, node, then, at: Date.now(), popup: !!popup } satisfies Pending))
  if (!popup) return void location.assign(url) // popups blocked (or the desktop app): redirect, the callback page finishes
  popup.opener = null // the node's page must not be able to navigate this window (the answer comes over BroadcastChannel)
  popup.location.href = url
  return new Promise<void>((resolve, reject) => {
    const bc = new BroadcastChannel(CHANNEL)
    let gone = 0
    const watch = setInterval(() => {
      // Closed without an answer (a late answer still gets 2 s to arrive).
      if (popup.closed && ++gone > 4) (clearInterval(watch), bc.close(), localStorage.removeItem(PENDING), reject(new Error(t('The sign-in window was closed.'))))
    }, 500)
    bc.onmessage = (e) => {
      if (typeof e.data?.fragment !== 'string') return
      clearInterval(watch)
      bc.close()
      completeSignIn(e.data.fragment).then((to) => (navigate(to), resolve()), reject)
    }
  })
}

/** Login page of a connected node: "Sign in with <hub>" runs the same flow and ends on our own callback page. */
export function signInHere(hub: InstanceInfo) {
  const state = crypto.randomUUID()
  localStorage.setItem(PENDING, JSON.stringify({ state, node: hub, then: {}, at: Date.now(), popup: false, self: true } satisfies Pending))
  location.assign(`${apiOrigin()}/api/v9/federation/hub-login${qs({ return_to: `${apiOrigin()}/instances/callback`, state })}`)
}

/** Called by the callback page: in a popup it hands the fragment to the window that opened it, else it finishes here. */
export function signInCallback(fragment: string): 'handed-over' | Promise<string> {
  const pending = readPending()
  if (pending?.popup) {
    const bc = new BroadcastChannel(CHANNEL)
    bc.postMessage({ fragment })
    bc.close()
    return 'handed-over'
  }
  return completeSignIn(fragment)
}
const readPending = (): Pending | null => { try { return JSON.parse(localStorage.getItem(PENDING) ?? 'null') } catch { return null } }

/** Checks the answer against the request we made, stores the node token and does what the sign-in was for. Resolves to the path to open. */
export async function completeSignIn(fragment: string): Promise<string> {
  const p = new URLSearchParams(fragment)
  const pending = readPending()
  localStorage.removeItem(PENDING)
  if (!pending || p.get('state') !== pending.state || Date.now() - pending.at > 15 * 60_000) throw new Error(t('This sign-in has expired or was not started here. Try again.'))
  if (p.get('error')) throw new Error(p.get('error') === 'access_denied' ? t('Sign-in was cancelled.') : t('{name} refused the sign-in: {error}', { name: pending.node.name, error: p.get('error_description') || p.get('error')! }))
  const token = p.get('token')
  if (pending.self && token) return setToken(token), '/channels/@me'
  if (!token || (p.get('node_id') && p.get('node_id') !== pending.node.id)) throw new Error(t('{name} sent an invalid answer.', { name: pending.node.name }))
  adopt(pending.node, token)
  return finish(pending.node.id, pending.then)
}

function adopt(node: InstanceInfo, token: string) {
  saveInstance(node, token)
  if (getState().status === 'ready') (close(node.id), open(node))
}

async function finish(id: string, then: Then): Promise<string> {
  const g = then.invite
    ? await api<GuildPayload>(`/invites/${encodeURIComponent(then.invite)}`, { method: 'POST', instance: id })
    : then.guild ? await api<GuildPayload | undefined>(`/guilds/${then.guild}/members/@me`, { method: 'PUT', instance: id }) : undefined
  // 204 (already a member) or a partial answer: the node's GUILD_CREATE brings the server.
  if (g?.channels) enterGuild(g, undefined, true)
  const guildId = g?.id ?? (then.guild && scoped(id, then.guild)) // the directory names node servers by their bare id
  return guildId ? `/channels/${guildId}` : '/channels/@me'
}

/** "Disconnect from instance": closes the connection, removes its servers and forgets the token. */
export function disconnectInstance(id: string) {
  const token = tokenOf(id)
  if (nodeOf(getState().voice.guildId) === id) leaveVoice()
  close(id)
  if (token) api('/auth/logout', { method: 'POST', instance: id }).catch(() => {})
  for (const g of Object.keys(getState().guilds)) if (nodeOf(g) === id) apply('GUILD_DELETE', { id: g })
  removeInstance(id)
}

/** Hub logout: node tokens and the private node list belong to this hub account. */
export function forgetInstances() {
  stopNodes()
  for (const i of instances()) removeInstance(i.id)
  for (const n of savedNodes()) forget(n.origin)
  localStorage.removeItem(NODES_KEY)
}

/** An invite link of another instance → that node's record from the hub, or an error explaining why it can't be added. */
export async function nodeForInvite(link: string): Promise<{ node: InstanceInfo; code: string } | null> {
  let url: URL
  try { url = new URL(link) } catch { return null }
  if (url.origin === apiOrigin()) return null
  const code = url.pathname.split('/').filter(Boolean).pop()
  if (!code || !/^\/invite\//.test(url.pathname)) throw new Error(t('That is not an invite link.'))
  const records = await listNodes().catch((e: ApiError) => { throw e.status === 404 ? new Error(t('This hub does not list other instances.')) : e })
  const r = records.find((x) => nodeInfo(x).url === url.origin)
  if (!r) throw new Error(t('{host} is not linked to this hub. Open the invite on its own site instead.', { host: url.host }))
  if (r.status !== 'active') throw new Error(t('{name} is suspended by the hub admins.', { name: r.name }))
  return { node: nodeInfo(r), code }
}

// ---------- Saved private nodes (Settings › Private Nodes) ----------
// Every saved node the hub lists is one more instance above: signed in with the hub account in the background and kept
// connected, no switching. The list lives in the hub account (settings.private_nodes); localStorage is the cache.
const tries = new Map<string, number>() // origin -> failed tries in a row
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const busy = new Set<string>() // origins with a sign-in under way (READY, the settings echo and an add can all ask at once)
const OWN_LOGIN = 'own-login'

// The hub session as stored (all tabs share it): a logout or login in any tab ends what this tab started before.
const session = () => localStorage.getItem('token') ?? ''
// List changes go to the hub one at a time; their answers are not merged (an older answer could undo a newer change):
// USER_SETTINGS_UPDATE on the gateway brings the list, in order.
const changeNodes = (path: string, method: 'PUT' | 'DELETE', body?: unknown) => api(`/users/@me/settings/private-nodes${path}`, { method, body })
/** Ends a node session we will not keep. Only the node's own origin, no cookies, no redirects; kept in storage until the
 *  node confirmed, so a reload (another tab changed the hub session) resumes it. keepalive: a try under way survives too. */
const revokes = revocations({ get: () => localStorage.getItem(REVOKES_KEY), set: (v) => localStorage.setItem(REVOKES_KEY, v) }, (url, token) =>
  fetch(url, { method: 'POST', headers: { Authorization: token }, credentials: 'omit', redirect: 'error', keepalive: true, signal: AbortSignal.timeout(10_000) }).then((r) => r.status))
const REVOKES_KEY = 'cillhub_pending_revokes'
const revoke = (node: InstanceInfo, token: string) =>
  void revokes.add({ owner: `${apiOrigin()} ${getState().me?.id ?? ''}`, origin: node.url, token })
    .then((ok) => ok || console.warn(`Could not end the unused session on ${node.url}; it expires there on its own.`))
if (typeof window !== 'undefined') queueMicrotask(() => void revokes.resume())

/** On the hub's READY and on USER_SETTINGS_UPDATE: the hub copy wins (removals on another device too); an account that never
 *  saved a list takes this device's. Then every saved node that is not connected gets a try. */
export function syncPrivateNodes() {
  const fromHub = getState().settings.private_nodes
  const before = savedNodes()
  if (fromHub == null) {
    if (before.length) changeNodes('/initial', 'PUT', { nodes: before }).catch(() => {}) // only while the account has none; next READY tries again
  } else {
    saveNodes(fromHub)
    const now = savedNodes()
    for (const n of before) if (!now.some((x) => x.origin === n.origin)) forget(n.origin, true)
  }
  if (savedNodes().length) void connectSaved()
}

async function connectSaved(only?: string) {
  const records = await listNodes().catch(() => null)
  for (const n of savedNodes()) {
    if (only && n.origin !== only) continue
    if (!records) { retry(n.origin, t("Can't reach the server.")); continue }
    void connectOne(n.origin, records)
  }
}

async function connectOne(origin: string, records: NodeRecord[]) {
  clearTimeout(timers.get(origin))
  const r = records.find((x) => normalizeServerUrl(x.url, true) === origin)
  if (!r) return setIssue(origin, { why: OWN_LOGIN }) // standalone, or linked to another hub
  const node = nodeInfo(r)
  if (r.status !== 'active') return setIssue(origin, { why: t('Suspended by the hub') })
  const known = instanceById(node.id)
  if (known && tokenOf(node.id) && known.status !== 'signed-out') return setIssue(origin, null) // the instance machinery keeps it connected
  const started = session()
  const key = `${started}|${origin}` // a sign-in of an earlier session never blocks this one
  if (busy.has(key)) return
  busy.add(key)
  try {
    const token = await signInQuietly(node, () => session() === started)
    if (!keepSignIn(started, session(), savedNodes(), origin)) return revoke(node, token)
    adopt(node, token)
    tries.delete(origin)
    setIssue(origin, null)
  } catch (e) {
    if (!keepSignIn(started, session(), savedNodes(), origin)) return // logged out or removed meanwhile
    if (e === OLD) return setIssue(origin, { why: 'sign-in', node })
    if (e === REFUSED) return setIssue(origin, { why: OWN_LOGIN })
    retry(origin, e instanceof Error ? e.message : String(e))
  } finally {
    busy.delete(key)
    if (reloadWhenIdle && !busy.size) location.reload()
  }
}

/** Tries again later, 5 s doubling up to 5 minutes; nothing waits for it. */
function retry(origin: string, why: string) {
  const n = (tries.get(origin) ?? 0) + 1
  tries.set(origin, n)
  setIssue(origin, { why })
  clearTimeout(timers.get(origin))
  timers.set(origin, setTimeout(() => void connectSaved(origin), Math.min(300_000, 5000 * 2 ** (n - 1))))
}

const OLD = new Error('no background sign-in')
const REFUSED = new Error('no hub sign-in')
/** The hub sign-in of joinOnNode without a window (the node's answer=json): the user agreed when adding the node, so the
 *  consent is given here. Every address the node names is checked: the consent goes only to our hub for this node id, the
 *  code only to the node's own callback. No cookies, no redirects. */
async function signInQuietly(node: InstanceInfo, live: () => boolean): Promise<string> {
  const bad = () => new Error(t('{name} sent an invalid answer.', { name: node.name }))
  const call = async (url: string, start = false) => {
    const res = await fetch(url, { credentials: 'omit', redirect: start ? 'manual' : 'error', signal: AbortSignal.timeout(10_000) }).catch(() => null)
    if (!res) throw new Error(t('{name} is not reachable right now.', { name: node.name }))
    if (res.type === 'opaqueredirect') throw OLD // a version without background sign-in
    const body = await res.json().catch(() => null)
    if (!body || typeof body !== 'object') throw new Error(t('Request failed ({status})', { status: res.status }))
    return body as Record<string, unknown>
  }
  const state = crypto.randomUUID()
  const start = await call(`${node.url}/api/v9/federation/hub-login${qs({ return_to: `${apiOrigin()}/instances/callback`, state, answer: 'json' })}`, true)
  if (start.error === 'unavailable') throw REFUSED
  let consent: URL
  try { consent = new URL(String(start.authorize_url)) } catch { throw bad() }
  const q = consent.searchParams
  if (consent.origin !== apiOrigin() || consent.pathname !== '/oauth2/authorize' || q.get('client_id') !== node.id) throw bad()
  if (!live()) throw new Error('session ended') // no consent for an account that is gone
  const keep = new URLSearchParams([...q].filter(([k]) => ['client_id', 'redirect_uri', 'response_type', 'scope', 'code_challenge', 'code_challenge_method', 'state'].includes(k)))
  const { location } = await api<{ location: string }>(`/oauth2/authorize?${keep}`, { method: 'POST', body: { authorize: true } })
  let back: URL
  try { back = new URL(location) } catch { throw bad() }
  if (back.origin !== node.url || back.pathname !== '/api/v9/federation/hub-callback') throw bad()
  const out = await call(back.href)
  if (out.error === 'unavailable') throw REFUSED
  if (out.error) throw new Error(t('{name} refused the sign-in: {error}', { name: node.name, error: String(out.error_description || out.error).slice(0, 200) }))
  if (out.state !== state || out.node_id !== node.id || typeof out.token !== 'string' || !out.token) throw bad()
  return out.token
}

/** Adds a node to the account's list and connects it; the refusal reason when it cannot be added. */
/** `started`: the session the user began adding in (before the address check and the dialog); 'cancelled' when it ended. */
export async function addPrivateNode(origin: string, name: string, started: string): Promise<'invalid' | 'duplicate' | 'full' | 'cancelled' | null> {
  if (session() !== started) return 'cancelled'
  const fresh = getState().settings.private_nodes ?? savedNodes()
  if (fresh.some((n) => n.origin === origin)) return 'duplicate'
  if (fresh.length >= MAX_NODES) return 'full'
  const first = getState().settings.private_nodes == null && fresh.length ? [() => changeNodes('/initial', 'PUT', { nodes: fresh })] : [] // first list of this account
  if (!(await inSession(started, session, [...first, () => changeNodes('', 'PUT', { origin, name })]))) return 'cancelled'
  tries.delete(origin) // the gateway's list update connects it
  return null
}

/** The hub session (the stored hub token) an add starts in. */
export const hubSession = session

// Another tab logged out or in: this tab's state, node tokens and list belong to the old session, so it reloads, but only
// once no background sign-in is running here (its token is then revoked, not lost with the page).
let reloadWhenIdle = false
if (typeof window !== 'undefined') window.addEventListener('storage', (e) => {
  if (e.key !== 'token' || e.newValue === getState().token) return
  reloadWhenIdle = true
  if (!busy.size) location.reload()
})

/** Removes a node from the account's list (all devices), signs out there and drops its servers and token. */
/** `started`: the session the user opened the confirmation in; nothing happens when it ended meanwhile. */
export async function removePrivateNode(origin: string, started: string) {
  if (!(await inSession(started, session, [() => changeNodes(qs({ origin }), 'DELETE')]))) return
  if (session() === started) forget(origin, true) // after a logout or account change the node may be someone else's now
}

function forget(origin: string, signOut = false) {
  clearTimeout(timers.get(origin))
  timers.delete(origin)
  tries.delete(origin)
  setIssue(origin, null)
  if (signOut) for (const i of instances()) if (i.url === origin) disconnectInstance(i.id)
}

/** "Sign in" on a node row that cannot sign in in the background: the window flow of joinOnNode. */
export const signInWindow = (node: InstanceInfo) => joinOnNode(node, {}).then(() => setIssue(node.url, null))
