// AFK presence (CONTRACT-v4: op 3 with afk: true after 2 minutes without input, so pushes reach the phone) and custom status expiry.
import { myActivities, sendPresence } from '../actions'
import { apply, getState, mergeSettings } from '../store'

const IDLE_MS = 2 * 60_000
let last = Date.now()
let afk = false

export function startIdle() {
  const active = () => {
    last = Date.now()
    if (afk) (afk = false), sendPresence(false)
  }
  for (const ev of ['keydown', 'pointerdown', 'pointermove', 'wheel', 'focus']) addEventListener(ev, active, { passive: true, capture: true })
  setInterval(() => {
    const s = getState()
    if (s.status !== 'ready') return
    if (!afk && Date.now() - last >= IDLE_MS) (afk = true), sendPresence(true)
    const cs = s.settings.custom_status
    if (cs?.expires_at && Date.parse(cs.expires_at) <= Date.now() && s.me) {
      mergeSettings({ custom_status: null })
      apply('PRESENCE_UPDATE', { user: { id: s.me.id }, status: s.presences[s.me.id] ?? 'online', activities: myActivities() })
      sendPresence()
    }
  }, 15_000)
}
