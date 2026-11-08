import { useState } from 'react'
import { ackMessage, closePrivate, openDm } from '../actions'
import { changeGroupIcon, leaveGroup } from '../friends/GroupDm'
import { t } from '../i18n'
import { ChannelNotifyItems } from '../notifications/NotificationSettings'
import { StatusLine } from '../profiles/Activity'
import { Link } from '../router'
import { isChannelMuted, isUnread, mentionCount, privateName } from '../selectors'
import { cmpId, displayName, setState, useStore } from '../store'
import type { Channel } from '../types'
import { toastError } from './dialogs'
import { MenuItem, MenuSep, Popover, useContextMenu } from './menu'
import { nameplateStyle, StyledName } from '../custom/render'
import { Avatar, channelIconUrl, cls, FormError, Icon, ICONS, Modal } from './ui'

const PINNED_KEY = 'cillhub-dm-pinned'
const ORDER_KEY = 'cillhub-dm-order'

function getSavedList(key: string): string[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '[]')
  } catch {
    return []
  }
}
function saveList(key: string, list: string[]) {
  try {
    localStorage.setItem(key, JSON.stringify(list))
  } catch {}
}

function DmRow({
  c,
  active,
  isPinned,
  canMoveUp,
  canMoveDown,
  onMove,
  onTogglePin,
  onDropReorder,
}: {
  c: Channel
  active: boolean
  isPinned: boolean
  canMoveUp: boolean
  canMoveDown: boolean
  onMove: (delta: number) => void
  onTogglePin: () => void
  onDropReorder: (srcId: string, tgtId: string) => void
}) {
  const s = useStore((x) => x)
  const menu = useContextMenu()
  const [isDragOver, setIsDragOver] = useState(false)
  const u = c.recipients?.[0]
  const user = (u && s.users[u.id]) ?? u
  const mentions = mentionCount(s, c.id)
  const name = privateName(s, c)
  const group = c.type === 3
  return (
    <li
      {...menu.props}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', c.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setIsDragOver(true)
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setIsDragOver(false)
        const srcId = e.dataTransfer.getData('text/plain')
        if (srcId && srcId !== c.id) onDropReorder(srcId, c.id)
      }}
      className={cls(
        !group && user?.collectibles?.nameplate ? 'nameplate' : undefined,
        isDragOver && 'dm-drag-over'
      )}
      style={group ? undefined : nameplateStyle(user)}
    >
      <Link to={`/channels/@me/${c.id}`} className={cls('row dm-row', !active && isUnread(s, c) && 'unread', isChannelMuted(s, c) && 'muted')} aria-current={active ? 'page' : undefined} onClick={() => setState({ showNav: false })}>
        <Avatar user={user} src={group ? channelIconUrl(c) : undefined} size={32} status={!group && u ? s.presences[u.id] ?? 'offline' : undefined} />
        <span className="dm-text">
          <span className="ellipsis">
            {group ? name : <StyledName user={user} name={name} />}
            {isPinned && <Icon d={ICONS.pin} size={13} className="pinned-pin" aria-label={t('Pinned')} />}
          </span>
          {group ? <span className="hint small">{t((c.recipients?.length ?? 0) + 1 === 1 ? '{n} Member' : '{n} Members', { n: (c.recipients?.length ?? 0) + 1 })}</span> : u && <StatusLine userId={u.id} />}
        </span>
        {!active && Boolean(s.drafts[c.id]?.content?.trim()) && (
          <span className="draft-badge" title={t('Unsent draft')} aria-label={t('Unsent draft')}>✎</span>
        )}
        {mentions > 0 && <span className="badge" aria-label={t('{n} unread', { n: mentions })}>{mentions}</span>}
      </Link>
      {menu.at && (
        <Popover at={menu.at} onClose={menu.close} role="menu" label={name}>
          <MenuItem disabled={!isUnread(s, c) && !mentions} onSelect={() => c.last_message_id && ackMessage(c.id, c.last_message_id)}>{t('Mark As Read')}</MenuItem>
          {!group && u && <MenuItem onSelect={() => setState({ modal: { kind: 'profile', userId: u.id } })}>{t('Profile')}</MenuItem>}
          {!group && u && <MenuItem onSelect={() => setState({ modal: { kind: 'invite-user', userId: u.id } })}>{t('Invite to Server')}</MenuItem>}
          <MenuItem onSelect={onTogglePin}>{isPinned ? t('Unpin Conversation') : t('Pin Conversation')}</MenuItem>
          {canMoveUp && <MenuItem onSelect={() => onMove(-1)}>{t('Move Up')}</MenuItem>}
          {canMoveDown && <MenuItem onSelect={() => onMove(1)}>{t('Move Down')}</MenuItem>}
          {group && <MenuItem onSelect={() => changeGroupIcon(c)}>{t('Change Icon')}</MenuItem>}
          <ChannelNotifyItems c={c} />
          <MenuSep />
          {group ? <MenuItem danger onSelect={() => leaveGroup(c, name)}>{t('Leave Group')}</MenuItem>
            : <MenuItem onSelect={() => void closePrivate(c).catch(toastError)}>{t('Close DM')}</MenuItem>}
          {s.settings.developer_mode && <MenuItem onSelect={() => void navigator.clipboard.writeText(c.id)}>{t('Copy Channel ID')}</MenuItem>}
        </Popover>
      )}
    </li>
  )
}

export function DmSidebar({ channelId }: { channelId?: string }) {
  const channels = useStore((s) => s.channels)
  const incoming = useStore((s) => Object.values(s.relationships).filter((r) => r.type === 3).length)
  const [finding, setFinding] = useState(false)
  const [pinned, setPinned] = useState<string[]>(() => getSavedList(PINNED_KEY))
  const [order, setOrder] = useState<string[]>(() => getSavedList(ORDER_KEY))

  const togglePin = (id: string) => {
    const next = pinned.includes(id) ? pinned.filter((x) => x !== id) : [...pinned, id]
    setPinned(next)
    saveList(PINNED_KEY, next)
  }

  const rawDms = Object.values(channels).filter((c) => c.type === 1 || c.type === 3)

  const dms = [...rawDms].sort((a, b) => {
    const aPin = pinned.indexOf(a.id)
    const bPin = pinned.indexOf(b.id)
    if (aPin !== -1 && bPin !== -1) return aPin - bPin
    if (aPin !== -1) return -1
    if (bPin !== -1) return 1
    const aOrd = order.indexOf(a.id)
    const bOrd = order.indexOf(b.id)
    if (aOrd !== -1 && bOrd !== -1) return aOrd - bOrd
    if (aOrd !== -1) return -1
    if (bOrd !== -1) return 1
    return cmpId(b.last_message_id ?? b.id, a.last_message_id ?? a.id)
  })

  const moveDm = (id: string, delta: number) => {
    const ids = dms.map((c) => c.id)
    const idx = ids.indexOf(id)
    if (idx < 0) return
    const targetIdx = idx + delta
    if (targetIdx < 0 || targetIdx >= ids.length) return
    const isP = pinned.includes(id)
    const targetIsP = pinned.includes(ids[targetIdx])
    if (isP && targetIsP) {
      const nextPin = [...pinned]
      const pIdx = nextPin.indexOf(id)
      const pTarget = nextPin.indexOf(ids[targetIdx])
      if (pIdx >= 0 && pTarget >= 0) {
        nextPin.splice(pIdx, 1)
        nextPin.splice(pTarget, 0, id)
        setPinned(nextPin)
        saveList(PINNED_KEY, nextPin)
        return
      }
    }
    const nextOrder = [...ids]
    nextOrder.splice(idx, 1)
    nextOrder.splice(targetIdx, 0, id)
    setOrder(nextOrder)
    saveList(ORDER_KEY, nextOrder)
  }

  const dropReorder = (sourceId: string, targetId: string) => {
    const ids = dms.map((c) => c.id)
    const srcIdx = ids.indexOf(sourceId)
    const tgtIdx = ids.indexOf(targetId)
    if (srcIdx < 0 || tgtIdx < 0 || srcIdx === tgtIdx) return

    const isP = pinned.includes(sourceId)
    const targetIsP = pinned.includes(targetId)
    if (isP && targetIsP) {
      const nextPin = [...pinned]
      const pIdx = nextPin.indexOf(sourceId)
      const pTarget = nextPin.indexOf(targetId)
      if (pIdx >= 0 && pTarget >= 0) {
        nextPin.splice(pIdx, 1)
        nextPin.splice(pTarget, 0, sourceId)
        setPinned(nextPin)
        saveList(PINNED_KEY, nextPin)
        return
      }
    }

    const nextOrder = [...ids]
    nextOrder.splice(srcIdx, 1)
    nextOrder.splice(tgtIdx, 0, sourceId)
    setOrder(nextOrder)
    saveList(ORDER_KEY, nextOrder)
  }

  return (
    <>
      <div className="sidebar-header search-wrap">
        <button className="search" onClick={() => setFinding(true)}>{t('Find or start a conversation')}</button>
      </div>
      <nav className="sidebar-list" aria-label={t('Direct messages')}>
        <Link to="/channels/@me" className="row friends-link" aria-current={!channelId ? 'page' : undefined} onClick={() => setState({ showNav: false })}>
          <Icon d={ICONS.people} size={24} />
          <span className="ellipsis">{t('Friends')}</span>
          {incoming > 0 && <span className="badge" aria-label={t('{n} pending', { n: incoming })}>{incoming}</span>}
        </Link>
        <div className="dm-heading">
          <h2 className="list-heading">{t('Direct Messages')}</h2>
          <button className="icon-btn tiny" aria-label={t('Create DM')} title={t('Create DM')} onClick={() => setState({ modal: { kind: 'group-dm' } })}><Icon d={ICONS.plus} size={16} /></button>
        </div>
        <ul>
          {dms.map((c, i) => (
            <DmRow
              key={c.id}
              c={c}
              active={c.id === channelId}
              isPinned={pinned.includes(c.id)}
              canMoveUp={i > 0}
              canMoveDown={i < dms.length - 1}
              onMove={(delta) => moveDm(c.id, delta)}
              onTogglePin={() => togglePin(c.id)}
              onDropReorder={dropReorder}
            />
          ))}
        </ul>
      </nav>
      {finding && <FindModal onClose={() => setFinding(false)} />}
    </>
  )
}

function FindModal({ onClose }: { onClose: () => void }) {
  const users = useStore((s) => s.users)
  const me = useStore((s) => s.me)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const q = query.toLowerCase()
  const list = Object.values(users).filter((u) => u.id !== me?.id && `${u.username} ${u.global_name ?? ''}`.toLowerCase().includes(q))

  return (
    <Modal title={t('Find or start a conversation')} onClose={onClose}>
      <input className="input" aria-label={t('Search for a user')} placeholder={t('Where would you like to go?')} value={query} onChange={(e) => setQuery(e.target.value)} />
      <ul className="find-list">
        {list.map((u) => (
          <li key={u.id}>
            <button className="row" onClick={() => openDm(u.id).then(onClose, (e: Error) => setError(e.message))}>
              <Avatar user={u} size={32} />
              <span className="ellipsis">{displayName(u)}</span>
              <span className="hint">{u.username}</span>
            </button>
          </li>
        ))}
      </ul>
      {list.length === 0 && <p className="hint">{t('Nobody found. You can message people you share a server with.')}</p>}
      <FormError error={error} />
    </Modal>
  )
}
