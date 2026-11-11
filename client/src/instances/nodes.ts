// Multi-instance client (CONTRACT-v7 §4): one gateway connection per linked node next to the hub's, node payloads merged
// into the one store (aliased in registry.ts), sign-in to a node through the hub identity flow, "Disconnect from instance",
// and the hub's view of node status (suspended / banned / unlinked nodes are cut off, offline ones keep retrying).
import { enterGuild } from '../actions'
import { api, ApiError, qs, apiOrigin, savedNodes, saveNodes, NODES_KEY } from '../api'
import { soundEvent } from '../custom/sounds'
import { createGateway, type Gateway } from '../gateway'
import { t } from '../i18n'
import { notifyEvent } from '../notifications/notify'
import { navigate } from '../router'
import { keepSignIn, MAX_NODES, normalizeServerUrl, revoker } from '../privateNodes'
import { apply, byId, getState, setState, setToken } from '../store'
import type { GuildPayload, Presence, ReadState, User, UserGuildSettings } from '../types'
import { leaveVoice, voiceEvent } from '../voice/engine'
import { inbound, instanceById, instances, nodeOf, removeInstance, saveInstance, setIssue, setLive, tokenOf, type InstanceInfo } from './registry'

/** The hub's node directory record (§2), from GET /federation/nodes. */
export type NodeRecord = {
  node_id: string; name: string; url: string; description?: string | null; icon?: string | null; version?: string | null
  mode?: 'connected' | 'standalone'; public_servers_count?: number; member_count?: number; online: boolean; last_seen?: string | null
  status: 'active' | 'suspended' | 'banned' | 'unlinked'
}
export const nodeInfo = (n: Pick<NodeRecord, 'node_id' | 'name' | 'url' | 'icon'>): InstanceInfo => ({ id: n.node_id, name: n.name, url: n.url.replace(/\/+$/, ''), icon: n.icon ?? null })
export const listNodes = () => api<NodeRecord[]>('/federation/nodes')

const conns = new Map<string, Gateway>()
const statusOf = (id: string) => instanceById(id)?.status

/** Opens the gateways of saved instances that have a token and are not cut off (after the hub's READY). */
export function startNodes() {
  for (const i of instances()) if (!conns.has(i.id) && tokenOf(i.id) && i.status !== 'suspended' && i.status !== 'signed-out') open(i)
  void refreshStatus()
  syncPrivateNodes()
}
export function stopNodes() {
  for (const g of conns.values()) g.disconnect()
  conns.clear()
}
/** Sends an op to one node (or to every ready node with `null`, for presence). */
export function nodeSend(id: string | null, op: number, d: unknown) {
  if (id === null) return [...conns.values()].map((g) => g.send(op, d)).some(Boolean)
  return conns.get(id)?.send(op, d) ?? false
}

function open(i: InstanceInfo) {
  const g = createGateway({
    // The node names its gateway; our node token goes only to the node's own host.
    url: () => api<{ url: string }>('/gateway', { instance: i.id }).then((r) => {
      if (new URL(r.url).host !== new URL(i.url).host) throw new Error('gateway on another host')
      return r
    }),
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
function close(id: string) {
  conns.get(id)?.disconnect()
  conns.delete(id)
}

// Events that are about guilds but name them by `id`, and events that carry no guild but are ours to apply.
const PASS = new Set(['USER_UPDATE', 'PRESENCE_UPDATE', 'INTERACTION_CREATE', 'INTERACTION_SUCCESS', 'INTERACTION_FAILURE', 'APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE',
  'INTERACTION_MODAL_CREATE', 'CILLVOICE_ANSWER', 'CILLVOICE_TRACKS', 'CILLVOICE_SPEAKING', 'CILLVOICE_ERROR'])

function dispatch(id: string, t: string, raw: any) {
  if (t === 'READY') setLive(id, { meId: raw.user?.id ?? null, sessionId: raw.session_id ?? null })
  const d = inbound(id, raw)
  if (t === 'READY') return ready(id, d)
  const s = getState()
  const me = s.me?.id
  const mine = (guildId?: string | null) => !!guildId && nodeOf(guildId) === id
  // Only guild-scoped data comes from a node: DMs, friends, calls, settings and instance notices stay on the hub (§3).
  const ok = t === 'GUILD_CREATE' || t === 'GUILD_UPDATE' || t === 'GUILD_DELETE' ? mine(d.id)
    : (t === 'USER_UPDATE' && d.id === me) || (t === 'PRESENCE_UPDATE' && d.user?.id === me) ? false
    : d.guild_id ? mine(d.guild_id)
    : d.channel_id ? mine(s.channels[d.channel_id]?.guild_id)
    : PASS.has(t)
  if (!ok) return
  const hubMe = me ? s.users[me] : undefined
  apply(t, d)
  voiceEvent(t, d)
  notifyEvent(t, d)
  soundEvent(t, d, s)
  // Our node account's user object (its own avatar hash) must not replace the hub one.
  if (me && hubMe && getState().users[me] !== hubMe) setState((x) => ({ users: { ...x.users, [me]: hubMe } }))
}

const list = <T,>(x: unknown): T[] => (Array.isArray(x) ? x : Array.isArray((x as { entries?: unknown })?.entries) ? (x as { entries: T[] }).entries : [])

function ready(id: string, d: { guilds?: GuildPayload[]; users?: User[]; presences?: Presence[]; read_state?: unknown; user_guild_settings?: unknown }) {
  const guilds = d.guilds ?? []
  const me = getState().me?.id
  // Replaced wholesale (like the hub's READY): drops servers we left while away, stale members and voice states, and
  // anything applied from a REST answer before our node identity was known (not yet aliased).
  for (const g of Object.keys(getState().guilds)) if (nodeOf(g) === id) apply('GUILD_DELETE', { id: g })
  for (const g of guilds) apply('GUILD_CREATE', g)
  setState((s) => ({
    users: { ...byId((d.users ?? []).filter((u) => u.id !== me)), ...s.users },
    presences: { ...s.presences, ...Object.fromEntries((d.presences ?? []).filter((p) => p.user.id !== me).map((p) => [p.user.id, p.status])) },
    readStates: { ...s.readStates, ...byId(list<ReadState>(d.read_state).filter((r) => r && nodeOf(s.channels[r.id]?.guild_id) === id)) },
    guildSettings: { ...s.guildSettings, ...Object.fromEntries(list<UserGuildSettings>(d.user_guild_settings).filter((g) => g?.guild_id && nodeOf(g.guild_id) === id).map((g) => [g.guild_id!, g])) },
  }))
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
  const guildId = g?.id ?? then.guild
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
/** Ends a node session we will not keep (retried a few times). Only the node's own origin, no cookies, no redirects. */
const revokeOnNode = revoker((url, token) => fetch(url, { method: 'POST', headers: { Authorization: token }, credentials: 'omit', redirect: 'error' }).then((r) => r.status))
const revoke = (node: InstanceInfo, token: string) =>
  void revokeOnNode(node.url, token).then((ok) => ok || console.warn(`Could not end the unused session on ${node.url}; it expires there on its own.`))

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
export async function addPrivateNode(origin: string, name: string): Promise<'invalid' | 'duplicate' | 'full' | null> {
  const started = session()
  const fresh = getState().settings.private_nodes ?? savedNodes()
  if (fresh.some((n) => n.origin === origin)) return 'duplicate'
  if (fresh.length >= MAX_NODES) return 'full'
  if (getState().settings.private_nodes == null && fresh.length) await changeNodes('/initial', 'PUT', { nodes: fresh }) // first list of this account
  await changeNodes('', 'PUT', { origin, name })
  if (session() === started) tries.delete(origin) // the gateway's list update connects it
  return null
}

/** Removes a node from the account's list (all devices), signs out there and drops its servers and token. */
export async function removePrivateNode(origin: string) {
  const started = session()
  await changeNodes(qs({ origin }), 'DELETE')
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
