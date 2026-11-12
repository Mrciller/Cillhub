import { useState, useEffect, useRef, type DragEvent, type ReactNode } from 'react'
import { E2eeBar, E2eeLock } from '../e2ee/E2ee'
import { bulkDeleteMessages, loadAround, updateThreadMemberFlags } from '../actions'
import { CallPanel } from '../calls/CallPanel'
import { startCall } from '../calls/calls'
import { ask, toastError } from '../components/dialogs'
import { MenuItem, Popover } from '../components/menu'
import { cls, Icon, ICONS, channelIcon } from '../components/ui'
import { GroupTitle } from '../friends/GroupDm'
import { t } from '../i18n'
import { InboxButton } from '../inbox/Inbox'
import { has, isThread, P } from '../permissions'
import { StatusLine } from '../profiles/Activity'
import { SearchBox } from '../search/SearchBox'
import { privateName, usePerms } from '../selectors'
import { callStates, displayName, exitPurgeMode, getState, selectLastPurgeMessages, setState, toggleMembers, useStore } from '../store'
import { ThreadsButton } from '../threads/ThreadsPopover'
import type { Channel, Draft, Guild } from '../types'
import { Composer, MAX_FILES } from './Composer'
import { jumpTo, MessageList } from './MessageList'
import { NsfwGate } from './NsfwGate'
import { ChannelEmoji, headerAccent } from '../custom/channel'
import { PinsButton } from './Pins'
import { CanvasButton } from '../canvas/CanvasPanel'
import { ChannelPanelButtons } from '../modules/ModulePanel'
import { MediaGalleryPanel } from './MediaGalleryPanel'

/** "#name" / "@user" label of a chat, used for the log and composer labels. */
export function chatLabel(channel: Channel) {
  return channel.type === 1 ? '@' + privateName(getState(), channel) : channel.type === 3 ? privateName(getState(), channel) : '#' + (channel.name ?? '')
}

/**
 * Messages, composer and typing line of one channel; used by the channel view, the thread panel and the chat next to a voice grid.
 * Handles file drops, the NSFW gate and per-file drafts.
 */
export function ChatBody({ channel, guild }: { channel: Channel; guild?: Guild }) {
  const label = chatLabel(channel)
  const perms = usePerms(guild?.id, channel.id)
  const canAttach = has(perms, P.ATTACH_FILES) && has(perms, P.SEND_MESSAGES)
  const [files, setFiles] = useState<Draft[]>([])
  const [dropping, setDropping] = useState(false)
  const addFiles = (list: File[]) => setFiles((f) => [...f, ...list.map((file) => ({ file, spoiler: false, description: '' }))].slice(0, MAX_FILES))
  const hasFiles = (e: DragEvent) => canAttach && e.dataTransfer.types.includes('Files')
  return (
    <NsfwGate channel={channel}>
      <div
        className="chat-body"
        onDragOver={(e) => hasFiles(e) && (e.preventDefault(), setDropping(true))}
        onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
        onDrop={(e) => {
          if (!hasFiles(e)) return
          e.preventDefault()
          setDropping(false)
          addFiles([...e.dataTransfer.files])
        }}
      >
        <MessageList channel={channel} guild={guild} label={label} perms={perms} />
        <Composer channel={channel} label={label} perms={perms} files={files} setFiles={setFiles} addFiles={addFiles} />
        <TypingLine channelId={channel.id} guildId={guild?.id} />
        {dropping && (
          <div className="drop-overlay" aria-hidden="true">
            <div><strong>{t('Upload to {label}', { label })}</strong><p>{t('Drop files to attach them.')}</p></div>
          </div>
        )}
      </div>
    </NsfwGate>
  )
}

/** The left part of a channel header: back button (narrow screens), icon and name. */
export function HeaderTitle({ channel, children }: { channel: Channel; children?: ReactNode }) {
  const parent = useStore((s) => (isThread(channel) && channel.parent_id ? s.channels[channel.parent_id] : undefined))
  const name = useStore((s) => (channel.type === 1 ? privateName(s, channel) : ''))
  const dm = channel.type === 1
  const icon = channelIcon(channel.type)
  return (
    <>
      <button className="icon-btn back" aria-label={t('Back to channels')} onClick={() => setState({ showNav: true })}>
        <Icon d={ICONS.back} />
      </button>
      {parent && <span className="crumb ellipsis">{parent.name}</span>}
      {parent && <span className="crumb-sep" aria-hidden="true">›</span>}
      {channel.type === 3 ? <GroupTitle channel={channel} /> : (
        <>
          {channel.icon_emoji?.name ? <ChannelEmoji c={channel} /> : icon ? <Icon d={icon} size={22} className="chan-icon" /> : <span className="hash" aria-hidden="true">{dm ? '@' : '#'}</span>}
          <h1 className="ellipsis">{dm ? name : channel.name}</h1>
          {dm && channel.recipients?.[0] && <span className="header-status"><StatusLine userId={channel.recipients[0].id} /></span>}
        </>
      )}
      {children}
    </>
  )
}

/** Call, add-friends and member-list buttons of a DM / group DM header. */
function PrivateButtons({ channel }: { channel: Channel }) {
  const inCall = useStore((s) => s.voice.channelId === channel.id || callStates(s, channel.id).length > 0)
  const showMembers = useStore((s) => s.showMembers)
  const bot = useStore((s) => channel.type === 1 && !!s.users[channel.recipients?.[0]?.id ?? '']?.bot)
  return (
    <>
      {!inCall && !bot && (
        <button className="icon-btn" aria-label={t('Start Voice Call')} title={t('Start Voice Call')} onClick={() => startCall(channel.id)}><Icon d={ICONS.phone} /></button>
      )}
      {!bot && (
        <button className="icon-btn" aria-label={t('Add Friends to DM')} title={t('Add Friends to DM')} onClick={() => setState({ modal: { kind: 'group-dm', channelId: channel.id } })}><Icon d={ICONS.personAdd} /></button>
      )}
      {channel.type === 3 && (
        <button className={cls('icon-btn', showMembers && 'active')} aria-pressed={showMembers} aria-label={t('Show Member List')} title={t('Show Member List')} onClick={toggleMembers}><Icon d={ICONS.people} /></button>
      )}
    </>
  )
}

const CALL_HEIGHT_KEY = 'cillhub-dm-call-height'

function ThreadNotificationBell({ channel }: { channel: Channel }) {
  const flags = channel.member?.flags ?? 0
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLButtonElement>(null)

  const pick = (newFlags: number) => {
    updateThreadMemberFlags(channel.id, newFlags).catch(toastError)
    setOpen(false)
  }

  const icon = flags === 2 ? ICONS.bellOff : ICONS.bell
  const title = flags === 2 ? t('Thread Notifications: Muted') : flags === 1 ? t('Thread Notifications: Only Mentions') : t('Thread Notifications: All Messages')

  return (
    <>
      <button
        ref={ref}
        className={cls('icon-btn', open && 'active', flags === 2 && 'muted')}
        aria-label={title}
        title={title}
        onClick={() => setOpen(!open)}
      >
        <Icon d={icon} />
      </button>
      {open && ref.current && (
        <Popover at={{ rect: ref.current.getBoundingClientRect(), side: 'below' }} onClose={() => setOpen(false)} role="menu" label={t('Notification Settings')}>
          <MenuItem onSelect={() => pick(0)}>{flags === 0 ? '✓ ' : ''}{t('All Messages')}</MenuItem>
          <MenuItem onSelect={() => pick(1)}>{flags === 1 ? '✓ ' : ''}{t('Only @mentions')}</MenuItem>
          <MenuItem onSelect={() => pick(2)}>{flags === 2 ? '✓ ' : ''}{t('Muted')}</MenuItem>
        </Popover>
      )}
    </>
  )
}

function PurgeToolbar({ channelId }: { channelId: string }) {
  const purgeSelected = useStore((s) => s.purgeSelected)
  const selectedIds = Object.keys(purgeSelected)

  const handleDelete = () => {
    if (selectedIds.length === 0) return
    void ask({
      title: t('Delete {n} Messages?', { n: selectedIds.length }),
      body: <p>{t('Are you sure you want to delete these {n} messages? This cannot be undone.', { n: selectedIds.length })}</p>,
      confirm: t('Delete Messages'),
      danger: true,
    }).then((ok) => {
      if (ok) {
        bulkDeleteMessages(channelId, selectedIds)
          .then(exitPurgeMode)
          .catch(toastError)
      }
    })
  }

  return (
    <div className="purge-toolbar" style={{ position: 'sticky', bottom: '12px', margin: '0 16px', padding: '10px 16px', background: 'var(--menu)', border: '1px solid var(--border)', borderRadius: '8px', boxShadow: '0 8px 24px rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', zIndex: 50 }}>
      <div style={{ fontWeight: 600, fontSize: '13px' }}>
        {t('{n} messages selected (max 100)', { n: selectedIds.length })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
        <button type="button" className="secondary small-btn" onClick={() => selectLastPurgeMessages(channelId, 10)}>{t('Last 10')}</button>
        <button type="button" className="secondary small-btn" onClick={() => selectLastPurgeMessages(channelId, 50)}>{t('Last 50')}</button>
        <button type="button" className="secondary small-btn" onClick={exitPurgeMode}>{t('Cancel')}</button>
        <button type="button" className="danger-btn small-btn" disabled={selectedIds.length === 0} onClick={handleDelete}>
          {t('Delete Selected ({n})', { n: selectedIds.length })}
        </button>
      </div>
    </div>
  )
}

export function Chat({ channel, guild }: { channel: Channel; guild?: Guild }) {
  const label = chatLabel(channel)
  const perms = usePerms(guild?.id, channel.id)
  const showMembers = useStore((s) => s.showMembers)
  const purgeMode = useStore((s) => s.purgeMode)
  const [mediaOpen, setMediaOpen] = useState(false)
  const parent = useStore((s) => (isThread(channel) && channel.parent_id ? s.channels[channel.parent_id] : undefined))
  const isForumThread = isThread(channel) && parent?.type === 15
  const priv = channel.type === 1 || channel.type === 3
  const inCall = useStore((s) => priv && ((s.voice.channelId === channel.id && !s.voice.guildId) || callStates(s, channel.id).length > 0 || !!s.calls[channel.id]))

  const [callHeight, setCallHeight] = useState<number | null>(() => {
    try {
      const v = localStorage.getItem(CALL_HEIGHT_KEY)
      return v ? Math.max(120, Number(v)) : null
    } catch {
      return null
    }
  })
  const [dragging, setDragging] = useState(false)
  const splitterCleanup = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      if (splitterCleanup.current) splitterCleanup.current()
    }
  }, [])

  const onSplitterPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    setDragging(true)
    const startY = e.clientY
    const startH = callHeight ?? (document.querySelector('.call-panel')?.getBoundingClientRect().height || 300)

    const onPointerMove = (ev: PointerEvent) => {
      const delta = ev.clientY - startY
      const minH = 120
      const maxH = Math.max(minH, window.innerHeight - 200)
      const nextH = Math.round(Math.max(minH, Math.min(maxH, startH + delta)))
      setCallHeight(nextH)
    }

    const cleanup = () => {
      setDragging(false)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      splitterCleanup.current = null
    }

    const onPointerUp = (ev: PointerEvent) => {
      cleanup()
      const delta = ev.clientY - startY
      const minH = 120
      const maxH = Math.max(minH, window.innerHeight - 200)
      const nextH = Math.round(Math.max(minH, Math.min(maxH, startH + delta)))
      setCallHeight(nextH)
      try { localStorage.setItem(CALL_HEIGHT_KEY, String(nextH)) } catch {}
    }

    splitterCleanup.current = cleanup
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  const resetCallHeight = () => {
    setCallHeight(null)
    try { localStorage.removeItem(CALL_HEIGHT_KEY) } catch {}
  }

  return (
    <main className="chat" aria-label={label}>
      <header className="chat-header" {...headerAccent(channel)}>
        <HeaderTitle channel={channel}>{channel.topic && <p className="topic ellipsis">{channel.topic}</p>}</HeaderTitle>
        <span className="spacer" />
        {priv && <E2eeLock channel={channel} />}
        {priv && <PrivateButtons channel={channel} />}
        {(channel.type === 0 || channel.type === 5) && <ThreadsButton channel={channel} />}
        {channel.type === 5 && guild && (
          <button className="secondary small-btn" onClick={() => setState({ modal: { kind: 'follow', channelId: channel.id } })}>{t('Follow')}</button>
        )}
        {isThread(channel) && <ThreadNotificationBell channel={channel} />}
        <PinsButton channel={channel} perms={perms} />
        <CanvasButton channel={channel} perms={perms} />
        <button
          className={cls('icon-btn', mediaOpen && 'active')}
          aria-pressed={mediaOpen}
          aria-label={t('Media, Files & Links')}
          title={t('Media, Files & Links')}
          onClick={() => setMediaOpen(!mediaOpen)}
        >
          <Icon d={ICONS.grid} />
        </button>
        {(channel.type === 0 || channel.type === 5) && <ChannelPanelButtons guildId={guild?.id} />}
        {guild && (
          <button className={cls('icon-btn', showMembers && 'active')} aria-pressed={showMembers} aria-label={t('Show Member List')} title={t('Show Member List')} onClick={toggleMembers}><Icon d={ICONS.people} /></button>
        )}
        <SearchBox guildId={guild?.id} channel={channel} />
        <InboxButton guildId={guild?.id} />
      </header>
      {priv && <E2eeBar channel={channel} />}
      {priv && <CallPanel channel={channel} height={callHeight} />}
      {inCall && (
        <div
          className={cls('chat-call-splitter', dragging && 'dragging')}
          role="separator"
          aria-orientation="horizontal"
          aria-label={t('Drag to resize call and chat')}
          title={t('Drag to resize chat higher or lower (double-click to reset)')}
          onPointerDown={onSplitterPointerDown}
          onDoubleClick={resetCallHeight}
        >
          <div className="splitter-handle" />
        </div>
      )}
      {isForumThread && channel.solved_message_id && (
        <div className="solved-banner" style={{ background: 'color-mix(in srgb, var(--online) 15%, transparent)', borderBottom: '1px solid color-mix(in srgb, var(--online) 30%, transparent)', padding: '8px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: '13px', color: 'var(--online)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
            <span>✓</span>
            <span>{t('This question has an accepted solution.')}</span>
          </div>
          <button
            type="button"
            className="secondary small-btn"
            style={{ borderColor: 'var(--online)', color: 'var(--online)' }}
            onClick={() => {
              if (!jumpTo(channel.solved_message_id!)) {
                void loadAround(channel.id, channel.solved_message_id!)
              }
            }}
          >
            {t('Jump to Solution')}
          </button>
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <ChatBody channel={channel} guild={guild} />
          {purgeMode && <PurgeToolbar channelId={channel.id} />}
        </div>
        {mediaOpen && <MediaGalleryPanel channel={channel} onClose={() => setMediaOpen(false)} />}
      </div>
    </main>
  )
}

function TypingLine({ channelId, guildId }: { channelId: string; guildId?: string }) {
  const typing = useStore((s) => s.typing[channelId])
  const users = useStore((s) => s.users)
  const members = useStore((s) => (guildId ? s.members[guildId] : undefined))
  const names = Object.keys(typing ?? {}).map((id) => members?.[id]?.nick || displayName(users[id]))
  const text =
    names.length === 0 ? ''
    : names.length === 1 ? t('{name} is typing…', { name: names[0] })
    : names.length <= 3 ? t('{names} and {last} are typing…', { names: names.slice(0, -1).join(', '), last: names.at(-1) ?? '' })
    : t('Several people are typing…')
  return <div className="typing" aria-live="polite">{text}</div>
}
