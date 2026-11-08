// Message reminders ("Remind me"): saved messages with a due date (user docs: /users/@me/saved-messages). The list is
// loaded after every READY; when one falls due while Cillhub is open it shows a toast, plays the message sound and a
// desktop notification once (the server pushes it when no client is open).
import { loadReminders } from '../actions'
import { toast } from '../components/dialogs'
import { t } from '../i18n'
import { desktop } from '../notifications/notify'
import { playMessage } from '../notifications/sounds'
import { displayName, getState, subscribe } from '../store'
import type { SavedMessage } from '../types'

const KEY = 'reminders-notified'
const notified = new Set<string>(JSON.parse(localStorage.getItem(KEY) ?? '[]'))
const keyOf = (r: SavedMessage) => `${r.save_data.channel_id}-${r.save_data.message_id}-${r.save_data.due_at}`
export const reminderUrl = (r: SavedMessage) => `/channels/${r.save_data.guild_id ?? r.message?.guild_id ?? '@me'}/${r.save_data.channel_id}/${r.save_data.message_id}`

/** Text for a reminder: the message's author and the start of its text. */
export function reminderText(r: SavedMessage) {
  const m = r.message
  return m ? `${displayName(m.author)}: ${m.content.slice(0, 100) || t('Sent an attachment')}` : t('A message')
}

function fire() {
  const now = Date.now()
  for (const r of Object.values(getState().reminders)) {
    const due = r.save_data.due_at ? Date.parse(r.save_data.due_at) : NaN
    if (!(due <= now) || notified.has(keyOf(r))) continue
    notified.add(keyOf(r))
    localStorage.setItem(KEY, JSON.stringify([...notified].slice(-200)))
    toast(t('Reminder: {text}', { text: reminderText(r) }))
    if ((getState().presences[getState().me?.id ?? ''] ?? getState().settings.status) !== 'dnd') playMessage()
    desktop(t('Reminder'), reminderText(r), `reminder-${r.save_data.message_id}`, reminderUrl(r))
  }
  plan()
}

let timer = 0
/** One timer for the next reminder that has not notified yet (re-planned whenever the list changes). */
function plan() {
  clearTimeout(timer)
  const next = Math.min(...Object.values(getState().reminders).filter((r) => r.save_data.due_at && !notified.has(keyOf(r))).map((r) => Date.parse(r.save_data.due_at!)))
  if (Number.isFinite(next)) timer = setTimeout(fire, Math.min(Math.max(0, next - Date.now()), 86_400_000))
}

export function startReminders() {
  let list = getState().reminders
  let session = getState().sessionId
  subscribe(() => {
    const s = getState()
    if (s.sessionId !== session && s.status === 'ready') (session = s.sessionId), void loadReminders().catch(() => {})
    if (s.reminders !== list) (list = s.reminders), plan()
  })
}
