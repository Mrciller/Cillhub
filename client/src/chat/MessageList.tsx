import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ackMessage, jumpToPresent, loadMessages, loadNewer } from '../actions'
import { toastError } from '../components/dialogs'
import { Avatar, Icon, ICONS } from '../components/ui'
import type { MdContext } from '../markdown/Markdown'
import { isUnread, mentionCount, textColorOf } from '../selectors'
import { cmpId, displayName, getState, setState, useStore } from '../store'
import type { Channel, Guild, User } from '../types'
import { MessageItem } from './MessageItem'
import { MediaGalleryGrid } from './MediaGalleryGrid'
import { InteractionStatus } from '../components-ui/InteractionStatus'
import { t, useLocale } from '../i18n'

const GROUP_MS = 7 * 60_000
/** System messages (joins, thread created, poll results…) never start a group with the next message. */
const SYSTEM = new Set([3, 7, 18, 21, 46])

/** Resolves mentions for the Markdown renderer from the store. */
export function useMdContext(guild?: Guild): MdContext {
  const users = useStore((s) => s.users)
  const members = useStore((s) => (guild ? s.members[guild.id] : undefined))
  const channels = useStore((s) => s.channels)
  return useMemo(() => ({
    user: (id) => members?.[id]?.nick || (users[id] ? displayName(users[id]) : undefined),
    role: (id) => {
      const r = guild?.roles.find((x) => x.id === id)
      return r && { name: r.name, color: textColorOf(r.color) }
    },
    channel: (id) => {
      const c = channels[id]
      return c?.guild_id ? { name: c.name ?? '', href: `/channels/${c.guild_id}/${c.id}` } : undefined
    },
  }), [users, members, channels, guild])
}

/** Scrolls a loaded message into view and flashes it; false when it is not loaded. */
export function jumpTo(messageId: string) {
  const el = document.getElementById(`msg-${messageId}`)
  if (!el) return false
  el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  el.classList.remove('flash')
  void el.offsetWidth // restart the animation
  el.classList.add('flash')
  el.focus({ preventScroll: true })
  return true
}

export function MessageList({ channel, guild, label, perms }: { channel: Channel; guild?: Guild; label: string; perms: bigint }) {
  const locale = useLocale()
  const msgs = useStore((s) => s.messages[channel.id])
  const hasMore = useStore((s) => s.hasMore[channel.id])
  const hasNewer = useStore((s) => !!s.hasNewer[channel.id])
  const jump = useStore((s) => (s.jump?.channelId === channel.id ? s.jump.messageId : null))
  const loadingNewer = useRef(false)
  const unreadState = useStore((s) => isUnread(s, channel) || mentionCount(s, channel.id) > 0)
  const [unreadSince] = useState(() => {
    const s = getState()
    const readId = s.readStates[channel.id]?.last_message_id
    return readId && channel.last_message_id && cmpId(channel.last_message_id, readId) > 0 ? readId : null
  })
  const ctx = useMdContext(guild)
  const ref = useRef<HTMLDivElement>(null)
  const priv = channel.type === 1 || channel.type === 3
  const channelReads = useStore((s) => s.dmRecipientReads[channel.id])
  const users = useStore((s) => s.users)
  const myId = useStore((s) => s.me?.id)

  const seenUsersByMsg = useMemo(() => {
    if (!priv || !channelReads) return {}
    const map: Record<string, User[]> = {}
    for (const [userId, lastId] of Object.entries(channelReads)) {
      if (userId === myId) continue
      const u = users[userId]
      if (u) {
        if (!map[lastId]) map[lastId] = []
        map[lastId].push(u)
      }
    }
    return map
  }, [priv, channelReads, users, myId])
  const atBottom = useRef(true)
  const snap = useRef({ first: '', last: '', height: 0 })
  const loadingOlder = useRef(false)
  const [failed, setFailed] = useState(false)
  const isMediaChannel = channel.type === 16 || channel.layout_type === 2 || ((channel as any).default_forum_layout === 2 && channel.type !== 15)
  const [layoutView, setLayoutView] = useState<'gallery' | 'list'>('gallery')

  useEffect(() => {
    if (jump) setLayoutView('list')
  }, [jump])

  const loaded = msgs !== undefined
  const load = useCallback(() => {
    setFailed(false)
    loadMessages(channel.id).catch(() => setFailed(true))
  }, [channel.id])
  useEffect(() => void (!loaded && load()), [loaded, load])

  // Section 9: ack while the channel is open, the window has focus and the list is at the bottom.
  const tryAck = useCallback(() => {
    const c = getState().channels[channel.id]
    if (!c?.last_message_id || !atBottom.current || !document.hasFocus() || document.visibilityState !== 'visible') return
    const s = getState()
    if (isUnread(s, c) || mentionCount(s, c.id) > 0) ackMessage(c.id, c.last_message_id)
  }, [channel.id])
  useEffect(() => {
    if (unreadState && loaded) tryAck()
  }, [unreadState, loaded, msgs, tryAck])
  useEffect(() => {
    addEventListener('focus', tryAck)
    document.addEventListener('visibilitychange', tryAck)
    return () => (removeEventListener('focus', tryAck), document.removeEventListener('visibilitychange', tryAck))
  }, [tryAck])

  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !msgs) return
    const prev = snap.current
    const first = msgs[0]?.id ?? ''
    const last = msgs.at(-1)
    if (prev.first && first !== prev.first && msgs.some((m) => m.id === prev.first)) el.scrollTop += el.scrollHeight - prev.height // older page prepended: hold the view still
    else if (atBottom.current || (last?.pending && last.id !== prev.last)) el.scrollTop = el.scrollHeight
    snap.current = { first, last: last?.id ?? '', height: el.scrollHeight }
  })

  // A requested jump (search result, reply, pin) scrolls once the message is rendered.
  useEffect(() => {
    if (!jump || !msgs?.some((m) => m.id === jump)) return
    atBottom.current = false
    requestAnimationFrame(() => jumpTo(jump))
    setState({ jump: null })
  }, [jump, msgs])

  const onScroll = () => {
    const el = ref.current!
    atBottom.current = !hasNewer && el.scrollHeight - el.scrollTop - el.clientHeight < 40
    if (hasNewer && el.scrollHeight - el.scrollTop - el.clientHeight < 200 && !loadingNewer.current) {
      loadingNewer.current = true
      loadNewer(channel.id).catch(() => {}).finally(() => (loadingNewer.current = false))
    }
    if (atBottom.current) tryAck()
    if (el.scrollTop < 200 && hasMore && !loadingOlder.current && msgs?.[0]) {
      loadingOlder.current = true
      loadMessages(channel.id, msgs[0].id)
        .catch(() => {}) // scrolling up again retries
        .finally(() => (loadingOlder.current = false))
    }
  }

  if (isMediaChannel && layoutView === 'gallery') {
    return (
      <MediaGalleryGrid
        channel={channel}
        msgs={msgs}
        ctx={ctx}
        label={label}
        hasMore={hasMore}
        onToggleView={() => setLayoutView('list')}
      />
    )
  }

  return (
    <div className="scroller" ref={ref} onScroll={onScroll} role="log" aria-label={t('Messages in {label}', { label })} tabIndex={0}>
      {isMediaChannel && (
        <div className="media-gallery-header" style={{ padding: '8px 16px', margin: 0 }}>
          <div className="media-gallery-title-row">
            <Icon d={ICONS.list} size={18} />
            <span style={{ fontSize: '14px', fontWeight: 600 }}>{t('Message View')}</span>
          </div>
          <div className="media-gallery-views">
            <button type="button" className="media-view-btn" onClick={() => setLayoutView('gallery')}>
              <Icon d={ICONS.grid} size={15} /> {t('Gallery')}
            </button>
            <button type="button" className="media-view-btn active">
              <Icon d={ICONS.list} size={15} /> {t('Messages')}
            </button>
          </div>
        </div>
      )}
      {hasMore === false && (
        <div className="channel-start">
          <h2>{t('Welcome to {label}!', { label })}</h2>
          <p className="hint">{t('This is the start of {label}.', { label })}</p>
        </div>
      )}
      {failed && (
        <p className="form-error" role="alert">
          {t("Couldn't load messages.")} <button className="link" onClick={load}>{t('Retry')}</button>
        </p>
      )}
      <ol className="messages">
        {msgs?.map((m, i) => {
          const prev = msgs[i - 1]
          const prevDay = prev ? new Date(prev.timestamp).toDateString() : ''
          const curDay = new Date(m.timestamp).toDateString()
          const newDay = !prev || prevDay !== curDay
          const isFirstUnread = !!unreadSince && !m.pending && cmpId(m.id, unreadSince) > 0 && (!prev || cmpId(prev.id, unreadSince) <= 0)
          const head = newDay || isFirstUnread || prev.author.id !== m.author.id || SYSTEM.has(prev.type) || m.type === 19 || !!m.webhook_id || !!m.message_snapshots?.length || !!m.interaction_metadata || !!m.interaction
            || Date.parse(m.timestamp) - Date.parse(prev.timestamp) > GROUP_MS
          return (
            <Fragment key={m.id}>
              {newDay && (
                <li className="date-divider" role="separator" aria-label={new Date(m.timestamp).toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric' })}>
                  <span>{new Date(m.timestamp).toLocaleDateString(locale, { month: 'long', day: 'numeric', year: 'numeric' })}</span>
                </li>
              )}
              {isFirstUnread && (
                <li className="unread-divider" role="separator" aria-label={t('New messages')}>
                  <span>{t('NEW')}</span>
                </li>
              )}
              <MessageItem m={m} head={head} perms={perms} ctx={ctx} />
              {seenUsersByMsg[m.id]?.length > 0 && (
                <li className="seen-by-row" aria-label={t('Seen by {names}', { names: seenUsersByMsg[m.id].map(displayName).join(', ') })}>
                  {seenUsersByMsg[m.id].map((u) => (
                    <span key={u.id} className="seen-avatar" title={t('Seen by {name}', { name: displayName(u) })}>
                      <Avatar user={u} size={16} />
                    </span>
                  ))}
                </li>
              )}
            </Fragment>
          )
        })}
      </ol>
      <InteractionStatus channelId={channel.id} />
      {hasNewer && (
        <div className="jump-bar" role="status">
          <span>{t("You're viewing older messages")}</span>
          <button className="link" onClick={() => jumpToPresent(channel.id).then(() => (atBottom.current = true)).catch(toastError)}>{t('Jump to Present')}</button>
        </div>
      )}
    </div>
  )
}
