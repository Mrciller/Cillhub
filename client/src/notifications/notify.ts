// In-app notifications for new messages and friend requests: a Web Audio sound, and a desktop notification while the
// tab is open but not focused. Both respect the user's notification settings, mutes, blocks and Do Not Disturb.
import { toast } from '../components/dialogs'
import { t } from '../i18n'
import { navigate } from '../router'
import { isBlocked, isChannelMuted, isGuildMuted, notifyLevel, privateName } from '../selectors'
import { displayName, getState, isPrivate, mentionsMe, type State } from '../store'
import type { Message } from '../types'
import { playMessage } from './sounds'

export const desktopEnabled = () => localStorage.getItem('notif-desktop') === '1' && 'Notification' in window && Notification.permission === 'granted'

/** Should a message notify (sound / desktop notification)? Pure, so the smoke test and the push rules can agree. */
export function shouldNotify(s: State, m: Message) {
  const me = s.me
  if (!me || m.author.id === me.id || (m.flags ?? 0) & (1 << 6) || isBlocked(s, m.author.id)) return false
  if ((s.presences[me.id] ?? s.settings.status) === 'dnd') return false
  const ch = s.channels[m.channel_id]
  if (!ch) return false
  if (isPrivate(ch)) return !isChannelMuted(s, ch)
  if (!m.guild_id || isGuildMuted(s, m.guild_id) || isChannelMuted(s, ch)) return false
  const level = notifyLevel(s, ch)
  return level === 0 || (level === 1 && mentionsMe(s, m))
}

const plain = (s: State, m: Message) =>
  m.content.replace(/<@!?(\d+(?::\d+)?)>/g, (_, id: string) => '@' + displayName(s.users[id])).replace(/<a?:(\w+):\d+(?::\d+)?>/g, ':$1:') || (m.attachments.length ? t('Sent an attachment') : m.sticker_items?.length ? t('Sent a sticker') : '')

export function desktop(title: string, body: string, tag: string, url: string, icon?: string) {
  if (!desktopEnabled() || document.hasFocus()) return
  try {
    const n = new Notification(title, { body: body.slice(0, 100), tag, icon: icon ?? '/icon-192.png', silent: true })
    n.onclick = () => (window.focus(), navigate(url), n.close())
  } catch { /* some browsers only allow notifications from a service worker */ }
}

function onMessage(m: Message) {
  const s = getState()
  if (!shouldNotify(s, m)) return
  const ch = s.channels[m.channel_id]
  const url = `/channels/${m.guild_id ?? '@me'}/${m.channel_id}`
  // The open channel in a focused window needs no notification.
  if (location.pathname.startsWith(url) && document.hasFocus()) return
  playMessage(isPrivate(ch) ? 'dm' : mentionsMe(s, m) ? 'mention' : 'message')
  const author = (m.guild_id && s.members[m.guild_id]?.[m.author.id]?.nick) || displayName(m.author)
  const title = ch.type === 1 ? author : ch.type === 3 ? `${author} (${privateName(s, ch)})` : `${author} (#${ch.name}, ${s.guilds[m.guild_id!]?.name ?? ''})`
  desktop(title, plain(s, m), ch.id, url)
}

const rung = new Set<string>()
/** A desktop notification when someone starts ringing us (the ringtone itself plays in calls/IncomingCall.tsx). */
function onCall(d: { channel_id: string; ringing?: string[] }) {
  const s = getState()
  const me = s.me?.id ?? ''
  const ringing = !!d.ringing?.includes(me) && s.voice.channelId !== d.channel_id
  if (!ringing) return void rung.delete(d.channel_id)
  if (rung.has(d.channel_id) || (s.presences[me] ?? s.settings.status) === 'dnd') return
  rung.add(d.channel_id)
  const ch = s.channels[d.channel_id]
  if (ch) desktop(t('Incoming Call'), privateName(s, ch), `call-${ch.id}`, `/channels/@me/${ch.id}`)
}

/** Gateway hook, called after the store applied each dispatch. */
export function notifyEvent(type: string, d: any) {
  if (type === 'MESSAGE_CREATE' && !d.pending) onMessage(d)
  else if (type === 'CALL_CREATE' || type === 'CALL_UPDATE') onCall(d)
  else if (type === 'CALL_DELETE') rung.delete(d.channel_id)
  else if (type === 'SCHEDULED_MESSAGE_DELETE' && d.failed) {
    // The server re-checks permissions at send time and drops a scheduled message it may not send.
    const ch = getState().channels[d.channel_id]
    const text = t('A scheduled message to {where} could not be sent.', { where: ch ? (ch.name ? `#${ch.name}` : privateName(getState(), ch)) : t('a channel') })
    toast(text)
    desktop(t('Send Later'), text, `scheduled-${d.id}`, `/channels/${d.guild_id ?? '@me'}/${d.channel_id}`)
  }
  else if (type === 'RELATIONSHIP_ADD' && d.type === 3 && getState().status === 'ready') {
    playMessage()
    desktop(t('Friend Request'), t('{name} sent you a friend request.', { name: displayName(d.user) }), `friend-${d.id}`, '/channels/@me')
  }
}
