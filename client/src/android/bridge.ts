// Android app bridge (android/README.md): the native shell injects window.CillcordAndroid (a WebView message port that
// only exists on the app's own origin, top frame). The page hands over its login token so the app can deliver
// notifications in the background, reports its voice connection so calls run through Android's Telecom, and takes
// commands from notifications: open a channel, join or leave a call, background/foreground (AFK for push).
import { sendPresence } from '../actions'
import { navigate } from '../router'
import { getState, subscribe } from '../store'
import { leaveVoice, joinVoice } from '../voice/engine'

type Port = { postMessage(message: string): void; onmessage: ((e: { data: unknown }) => void) | null }

const SNOWFLAKE = /^\d{1,19}$/

export function startAndroidBridge() {
  const port = (window as { CillcordAndroid?: Port }).CillcordAndroid
  if (!port) return
  const post = (m: object) => port.postMessage(JSON.stringify(m))
  let token: string | null | undefined
  let voice: string | undefined
  let pendingCall: string | null = null

  const sync = () => {
    const s = getState()
    if (s.token !== token) {
      token = s.token
      post(token ? { type: 'token', token } : { type: 'logout' })
    }
    const v = `${s.voice.guildId}/${s.voice.channelId}`
    if (v !== voice) {
      voice = v
      post({ type: 'voice', guild_id: s.voice.guildId, channel_id: s.voice.channelId })
    }
    // a call answered from the notification before the gateway was ready
    if (pendingCall && s.status === 'ready') {
      const id = pendingCall
      pendingCall = null
      joinVoice(null, id)
    }
  }

  port.onmessage = (e) => {
    let m: { type?: unknown; path?: unknown; channel_id?: unknown; afk?: unknown }
    try {
      m = JSON.parse(String(e.data))
    } catch {
      return
    }
    if (m.type === 'open' && typeof m.path === 'string' && /^\/channels\/(@me|\d{1,19})(\/\d{1,19}){0,2}$/.test(m.path)) navigate(m.path)
    else if (m.type === 'join-call' && typeof m.channel_id === 'string' && SNOWFLAKE.test(m.channel_id)) {
      navigate(`/channels/@me/${m.channel_id}`)
      pendingCall = m.channel_id
      sync()
    } else if (m.type === 'leave-call') leaveVoice()
    else if (m.type === 'background' && typeof m.afk === 'boolean' && getState().status === 'ready') sendPresence(m.afk)
  }
  subscribe(sync)
  post({ type: 'ready' })
  sync()
}
