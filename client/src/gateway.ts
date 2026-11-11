import { api, ApiError } from './api'
import { toast } from './components/dialogs'
import { t } from './i18n'
import { apply, getState, setState, setToken } from './store'
import { notifyEvent } from './notifications/notify'
import { voiceEvent } from './voice/engine'
import { soundEvent } from './custom/sounds'
import { forgetInstances, nodeSend, startNodes, stopNodes, syncPrivateNodes } from './instances/nodes'
import { nodeOf, setHubIdentity } from './instances/registry'

export type Gateway = { connect: () => void; disconnect: () => void; send: (op: number, d: unknown) => boolean }
type Options = {
  url: () => Promise<{ url: string }>
  token: () => string | null
  ready: () => boolean
  /** `failed`: the previous attempt did not get through (the server is unreachable or dropped us). */
  connecting: (failed: boolean) => void
  dispatch: (t: string, d: any) => void
  /** 4004: the token was rejected. */
  rejected: () => void
  /** A frame above this closes the connection (node gateways). */
  maxBytes?: number
}

const send = (sock: WebSocket, op: number, d: unknown) => sock.readyState === WebSocket.OPEN && (sock.send(JSON.stringify({ op, d })), true)
const identify = (sock: WebSocket, token: string | null) => {
  const st = getState().settings
  // The custom status rides along as a type 4 activity (expired ones are dropped).
  const cs = st.custom_status
  const game = getState().game
  const live = cs && (cs.text || cs.emoji_name || cs.emoji_id) && !(cs.expires_at && Date.parse(cs.expires_at) <= Date.now())
  const emoji = live ? (cs.emoji_id ? { id: cs.emoji_id, name: cs.emoji_name ?? '' } : cs.emoji_name ? { name: cs.emoji_name } : null) : null
  send(sock, 2, {
    token,
    properties: { os: navigator.platform, browser: 'Cillhub Web', device: '' },
    presence: {
      status: st.status ?? 'online', since: 0, afk: false,
      activities: [...(live ? [{ type: 4, name: 'Custom Status', state: cs.text, ...(emoji && { emoji }) }] : []), ...(game ? [{ type: 0, name: game.name, timestamps: { start: game.start } }] : [])],
    },
  })
}

/** One gateway connection (v1 protocol: heartbeat, IDENTIFY, reconnect with backoff). The hub has one; every linked node another (v7). */
export function createGateway(o: Options): Gateway {
  let ws: WebSocket | null = null
  let generation = 0 // bumps on every connect/disconnect so stale sockets and timers do nothing
  let attempt = 0
  let heartbeat = 0
  let retry = 0
  let reidentify = 0

  function connect() {
    disconnect()
    const gen = generation
    o.connecting(attempt > 0)
    o.url().then(
      ({ url }) => gen === generation && open(url, gen),
      () => reconnect(gen),
    )
  }

  function disconnect() {
    generation++
    clearInterval(heartbeat)
    clearTimeout(retry)
    clearTimeout(reidentify)
    reidentify = 0
    const sock = ws
    ws = null
    sock?.close(1000)
  }

  function reconnect(gen: number) {
    if (gen !== generation) return
    o.connecting(true)
    retry = setTimeout(connect, Math.min(30_000, 1000 * 2 ** attempt++))
  }

  function open(url: string, gen: number) {
    let sock: WebSocket
    try {
      sock = new WebSocket(url)
    } catch {
      return reconnect(gen)
    }
    ws = sock
    let seq: number | null = null
    let acked = true
    let hello = false
    sock.onmessage = (e) => {
      if (gen !== generation) return
      if (o.maxBytes && (typeof e.data !== 'string' || e.data.length > o.maxBytes)) return sock.close(4008)
      let frame
      try { frame = JSON.parse(e.data) } catch { return sock.close(4002) }
      const { op, d, s, t } = frame ?? {}
      if (typeof s === 'number') seq = s
      if (op === 10) {
        if (hello) return // one HELLO per connection, so one heartbeat timer
        hello = true
        clearInterval(heartbeat)
        heartbeat = setInterval(() => {
          // No ACK since the last beat: the connection is a zombie, drop it and reconnect.
          if (!acked) return sock.close(4000)
          acked = false
          send(sock, 1, seq)
        }, Math.max(1000, Number(d?.heartbeat_interval) || 41_250))
        identify(sock, o.token())
      } else if (op === 11) acked = true
      else if (op === 1) send(sock, 1, seq)
      // v1 cannot resume; the protocol asks for a fresh IDENTIFY after a random 1-5 s wait.
      // One pending re-identify at a time, however many op 9 arrive.
      else if (op === 9 && !reidentify) reidentify = setTimeout(() => ((reidentify = 0), gen === generation && identify(sock, o.token())), 1000 + Math.random() * 4000)
      else if (op === 0) {
        if (t === 'READY') attempt = 0
        o.dispatch(t, d)
      }
    }
    sock.onclose = (e) => {
      if (sock !== ws) return
      clearInterval(heartbeat)
      clearTimeout(reidentify)
      reidentify = 0
      if (e.code === 4004) return o.rejected() // token rejected
      reconnect(gen)
    }
  }

  return { connect, disconnect, send: (op, d) => !!ws && o.ready() && send(ws, op, d) }
}

const hub = createGateway({
  url: () => api<{ url: string }>('/gateway'),
  token: () => getState().token,
  ready: () => getState().status === 'ready',
  connecting: () => setState({ status: 'connecting' }),
  rejected: () => logout(),
  dispatch(t, d) {
    if (t === 'READY') setHubIdentity(d.user.id, d.session_id)
    const before = getState()
    apply(t, d)
    // A hub reconnect says nothing about a call on a node server (that node's own READY does).
    if (!(t === 'READY' && nodeOf(getState().voice.guildId))) voiceEvent(t, d)
    notifyEvent(t, d)
    soundEvent(t, d, before)
    if (t === 'READY') startNodes() // node payloads are aliased to our hub identity, so they wait for it
    else if (t === 'USER_SETTINGS_UPDATE' && d.private_nodes !== undefined) syncPrivateNodes() // the list changed on another device
  },
})

export function connect() {
  hub.connect()
}
export function disconnect() {
  hub.disconnect()
  stopNodes()
}

/**
 * Sends a client op on the connection it belongs to: presence (3) everywhere; voice state (4) and cillvoice signalling (50+)
 * to the instance of the voice server; the rest to the hub. False when that connection is not ready.
 */
export function sendOp(op: number, d: unknown) {
  if (op === 3) nodeSend(null, op, d)
  const guildId = (d as { guild_id?: string | null } | null)?.guild_id ?? (op >= 50 ? getState().voice.guildId : null)
  const node = op === 3 ? undefined : nodeOf(guildId)
  return node ? nodeSend(node, op, d) : hub.send(op, d)
}

export function logout() {
  voiceEvent('LOGOUT', null)
  // the token is read before setToken(null) below; offline, this device still forgets it, but the server keeps it valid
  api('/auth/logout', { method: 'POST' }).catch((e) => {
    if (e instanceof ApiError && e.status === 0) toast(t('Logged out on this device. The server could not be reached, so the session stays active there until it expires; end it under Sessions on another device.'))
  })
  disconnect()
  forgetInstances() // node tokens belong to this hub account
  setToken(null)
}
