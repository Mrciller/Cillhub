// Multi-instance client (CONTRACT-v7 §4): one gateway connection per linked node next to the hub's, node payloads merged
// into the one store (aliased in registry.ts), sign-in to a node through the hub identity flow, "Disconnect from instance",
// and the hub's view of node status (suspended / banned / unlinked nodes are cut off, offline ones keep retrying).
import { enterGuild } from '../actions'
import { api, ApiError, qs, apiOrigin } from '../api'
import { soundEvent } from '../custom/sounds'
import { createGateway, type Gateway } from '../gateway'
import { t } from '../i18n'
import { notifyEvent } from '../notifications/notify'
import { navigate } from '../router'
import { apply, byId, getState, setState, setToken } from '../store'
import type { GuildPayload, Presence, ReadState, User, UserGuildSettings } from '../types'
import { leaveVoice, voiceEvent } from '../voice/engine'
import { inbound, instanceById, instances, nodeOf, removeInstance, saveInstance, setLive, tokenOf, type InstanceInfo } from './registry'

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
    url: () => api<{ url: string }>('/gateway', { instance: i.id }),
    token: () => tokenOf(i.id),
    ready: () => statusOf(i.id) === 'ready',
    connecting: (failed) => setLive(i.id, { status: failed ? 'offline' : 'connecting' }),
    // The node ends our sessions when the hub suspends, bans or unlinks it: ask the hub which it is.
    rejected: () => (close(i.id), setLive(i.id, { status: 'signed-out' }), void refreshStatus()),
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
  saveInstance(pending.node, token)
  if (getState().status === 'ready') (close(pending.node.id), open(pending.node))
  return finish(pending.node.id, pending.then)
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

/** Hub logout: node tokens were issued for this hub account. */
export function forgetInstances() {
  stopNodes()
  for (const i of instances()) removeInstance(i.id)
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
