// Channel sidebar: categories (collapsible), text and voice channels, unread state, drag-and-drop reordering.
import { useState, type DragEvent } from 'react'
import { WEB_ORIGIN } from '../api'
import { ackMessage, cloneChannel, patchMember } from '../actions'
import { moveChannel } from '../channelOrder'
import { has, P } from '../permissions'
import { navigate, Link } from '../router'
import { isChannelMuted, isUnread, mentionCount, permsOf, sidebar, sidebarThreads, VOICE_TYPES, watchTitle } from '../selectors'
import { setState, useStore, type State } from '../store'
import type { Channel, Guild } from '../types'
import { joinVoice } from '../voice/engine'
import { draggedVoiceUser, VoiceUsers } from '../voice/VoiceUsers'
import { clearVoiceStatus, editVoiceStatus, useCanSetVoiceStatus } from '../voice/VoiceStatus'
import '../watch/watch.css'
import { toastError } from './dialogs'
import { MenuItem, MenuSep, Popover, useContextMenu } from './menu'
import { ChannelNotifyItems } from '../notifications/NotificationSettings'
import { t } from '../i18n'
import { channelIcon, cls, Icon, ICONS } from './ui'
import { ChannelEmoji } from '../custom/channel'
import '../threads/threads.css'

const KEY = 'collapsed-categories'
function useCollapsed() {
  const [set, setSet] = useState<string[]>(() => JSON.parse(localStorage.getItem(KEY) ?? '[]'))
  const toggle = (id: string) => {
    const next = set.includes(id) ? set.filter((x) => x !== id) : [...set, id]
    localStorage.setItem(KEY, JSON.stringify(next))
    setSet(next)
  }
  return [set, toggle] as const
}

const canEdit = (s: State, c: Channel) => {
  const p = permsOf(s, c.guild_id, c)
  return has(p, P.MANAGE_CHANNELS) || has(p, P.MANAGE_ROLES)
}

export function ChannelList({ guild, channelId }: { guild: Guild; channelId?: string }) {
  const s = useStore((x) => x)
  const [collapsed, toggle] = useCollapsed()
  const [dragging, setDragging] = useState<string | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const manage = has(permsOf(s, guild.id), P.MANAGE_CHANNELS)
  const groups = sidebar(s, guild.id, !!s.guildSettings[guild.id]?.hide_muted_channels)

  const dnd = (c: Channel) =>
    manage
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => {
            e.dataTransfer.setData('text/plain', c.id)
            e.dataTransfer.effectAllowed = 'move'
            setDragging(c.id)
          },
          onDragEnd: () => (setDragging(null), setOver(null)),
          onDragOver: (e: DragEvent) => {
            if (!dragging || dragging === c.id) return
            // A category only lands next to categories; a channel can go before a channel or into a category.
            if (s.channels[dragging]?.type === 4 && c.type !== 4) return
            e.preventDefault()
            setOver(c.id)
          },
          onDragLeave: () => setOver((o) => (o === c.id ? null : o)),
          onDrop: (e: DragEvent) => {
            e.preventDefault()
            const id = e.dataTransfer.getData('text/plain') || dragging
            setDragging(null)
            setOver(null)
            const moved = id && s.channels[id]
            if (!moved || id === c.id) return
            const p =
              moved.type === 4 ? moveChannel(id, null, c.id)
              : c.type === 4 ? moveChannel(id, c.id, null)
              : moveChannel(id, c.parent_id ?? null, c.id)
            p.catch(toastError)
          },
        }
      : {}

  // a voice user dropped on another voice channel moves them there (Move Members in that channel; the server checks too)
  const userDrop = (c: Channel) => {
    const base = dnd(c) as { onDragOver?: (e: DragEvent) => void; onDrop?: (e: DragEvent) => void; onDragLeave?: () => void }
    if (c.type !== 2) return base
    const accepts = () => {
      const d = draggedVoiceUser
      return !!d && d.guildId === guild.id && d.from !== c.id && has(permsOf(s, guild.id, c), P.MOVE_MEMBERS)
    }
    return {
      ...base,
      onDragOver: (e: DragEvent) => {
        if (!accepts()) return base.onDragOver?.(e)
        e.preventDefault()
        e.dataTransfer.dropEffect = 'move'
        setOver(c.id)
      },
      onDragLeave: () => setOver((o) => (o === c.id ? null : o)),
      onDrop: (e: DragEvent) => {
        const d = draggedVoiceUser
        if (!d || !accepts()) return base.onDrop?.(e)
        e.preventDefault()
        setOver(null)
        patchMember(guild.id, d.userId, { channel_id: c.id }).catch(toastError)
      },
    }
  }

  return (
    <nav className="sidebar-list" aria-label={t('{name} channels', { name: guild.name })}>
      {manage && <p className="sr-only">{t('Drag channels to reorder them, or use Edit Channel to move them with the keyboard.')}</p>}
      {groups.map(({ category, channels }) => {
        const closed = !!category && collapsed.includes(category.id)
        const shown = closed ? channels.filter((c) => c.id === channelId || isUnread(s, c) || (VOICE_TYPES.has(c.type) && c.id === s.voice.channelId)) : channels
        return (
          <section key={category?.id ?? 'none'} className="channel-group">
            {category && (
              <CategoryHead category={category} className={cls('category', over === category.id && 'drop-target', isChannelMuted(s, category) && 'muted')} dnd={dnd(category)}>
                <button className="category-toggle" aria-expanded={!closed} onClick={() => toggle(category.id)}>
                  <Icon d={ICONS.expand} size={12} />
                  <h2 className="ellipsis">{category.name}</h2>
                </button>
                {canEdit(s, category) && (
                  <button className="icon-btn tiny" aria-label={t('Edit category {name}', { name: category.name ?? '' })} title={t('Edit Category')} onClick={() => setState({ modal: { kind: 'channel', channelId: category.id } })}>
                    <Icon d={ICONS.gear} size={14} />
                  </button>
                )}
                {manage && (
                  <button className="icon-btn tiny" aria-label={t('New channel in {name}', { name: category.name ?? '' })} title={t('New Channel')} onClick={() => setState({ modal: { kind: 'create-channel', guildId: guild.id, parentId: category.id, type: 0 } })}>
                    <Icon d={ICONS.plus} size={16} />
                  </button>
                )}
              </CategoryHead>
            )}
            <ul>
              {shown.map((c) => (
                <li key={c.id} className={cls(over === c.id && (draggedVoiceUser ? 'voice-drop' : 'drop-target'), dragging === c.id && 'dragging')} {...userDrop(c)}>
                  {VOICE_TYPES.has(c.type) ? <VoiceRow guild={guild} c={c} active={c.id === channelId} /> : <TextRow guild={guild} c={c} active={c.id === channelId} />}
                  <ThreadRows guild={guild} parentId={c.id} channelId={channelId} />
                </li>
              ))}
            </ul>
          </section>
        )
      })}
    </nav>
  )
}

/** Category header with its context menu (mute, notification level, Copy ID). */
function CategoryHead({ category, className, dnd, children }: { category: Channel; className: string; dnd: object; children: React.ReactNode }) {
  const menu = useContextMenu()
  return (
    <div className={className} {...dnd} {...menu.props}>
      {children}
      {menu.at && <ChannelMenu c={category} at={menu.at} onClose={menu.close} />}
    </div>
  )
}

function RowActions({ c }: { c: Channel }) {
  const s = useStore((x) => x)
  if (!canEdit(s, c)) return null
  return (
    <button className="icon-btn tiny row-gear" aria-label={t('Edit channel {name}', { name: c.name ?? '' })} title={t('Edit Channel')} onClick={() => setState({ modal: { kind: 'channel', channelId: c.id } })}>
      <Icon d={ICONS.gear} size={16} />
    </button>
  )
}

function ChannelMenu({ c, at, onClose }: { c: Channel; at: Parameters<typeof Popover>[0]['at']; onClose: () => void }) {
  const s = useStore((x) => x)
  return (
    <Popover at={at} onClose={onClose} role="menu" label={t('Channel {name}', { name: c.name ?? '' })}>
      {c.type !== 4 && <MenuItem disabled={!isUnread(s, c)} onSelect={() => c.last_message_id && ackMessage(c.id, c.last_message_id)}>{t('Mark As Read')}</MenuItem>}
      {canEdit(s, c) && <MenuItem onSelect={() => setState({ modal: { kind: 'channel', channelId: c.id } })}>{c.type === 4 ? t('Edit Category') : t('Edit Channel')}</MenuItem>}
      {c.type !== 4 && canEdit(s, c) && <MenuItem onSelect={() => cloneChannel(c.id).then((newCh) => newCh && navigate(`/channels/${c.guild_id}/${newCh.id}`)).catch(toastError)}>{t('Clone Channel')}</MenuItem>}
      {c.type !== 4 && <MenuItem onSelect={() => navigator.clipboard.writeText(`${WEB_ORIGIN}/channels/${c.guild_id}/${c.id}`)}>{t('Copy Channel Link')}</MenuItem>}
      {VOICE_TYPES.has(c.type) && <VoiceStatusItems c={c} />}
      <ChannelNotifyItems c={c} />
      {s.settings.developer_mode && <><MenuSep /><MenuItem onSelect={() => void navigator.clipboard.writeText(c.id)}>{t('Copy Channel ID')}</MenuItem></>}
    </Popover>
  )
}

function TextRow({ guild, c, active }: { guild: Guild; c: Channel; active: boolean }) {
  const s = useStore((x) => x)
  const menu = useContextMenu()
  const unread = !active && isUnread(s, c)
  const mentions = mentionCount(s, c.id)
  const hasDraft = !active && Boolean(s.drafts[c.id]?.content?.trim())
  const icon = channelIcon(c.type)
  return (
    <div className="row-wrap" {...menu.props}>
      <Link to={`/channels/${guild.id}/${c.id}`} className={cls('row', unread && 'unread', isChannelMuted(s, c) && 'muted')} aria-current={active ? 'page' : undefined} onClick={() => setState({ showNav: false, modulePage: null, guideGuildId: null })}>
        {c.icon_emoji?.name ? <ChannelEmoji c={c} /> : icon ? <Icon d={icon} size={20} className="chan-icon" /> : <span className="hash" aria-hidden="true">#</span>}
        <span className="ellipsis">{c.name}</span>
        {c.nsfw && <span className="nsfw-tag" title={t('Age-restricted')}>{t('NSFW')}</span>}
        {hasDraft && <span className="draft-badge" title={t('Unsent draft')} aria-label={t('Unsent draft')}>✎</span>}
        {mentions > 0 && <span className="badge" aria-label={t(mentions === 1 ? '{n} mention' : '{n} mentions', { n: mentions })}>{mentions}</span>}
        {unread && !mentions && <span className="sr-only">{t('unread')}</span>}
        {isChannelMuted(s, c) && <span className="sr-only">{t('muted')}</span>}
      </Link>
      <RowActions c={c} />
      {menu.at && <ChannelMenu c={c} at={menu.at} onClose={menu.close} />}
    </div>
  )
}

function VoiceRow({ guild, c, active }: { guild: Guild; c: Channel; active: boolean }) {
  const s = useStore((x) => x)
  const menu = useContextMenu()
  const p = permsOf(s, guild.id, c)
  const users = Object.values(s.voiceStates[guild.id] ?? {}).filter((v) => v.channel_id === c.id)
  const watch = s.watch[c.id]
  const full = !!c.user_limit && users.length >= c.user_limit && !has(p, P.MOVE_MEMBERS)
  const open = () => {
    if (has(p, P.CONNECT) && !full && s.voice.channelId !== c.id) joinVoice(guild.id, c.id)
    setState({ showNav: false, modulePage: null, guideGuildId: null })
    navigate(`/channels/${guild.id}/${c.id}`)
  }
  const kind = c.type === 13 ? t('stage channel') : t('voice channel')
  const label = `${c.name} (${kind}${c.user_limit ? ', ' + t('{n} of {max}', { n: users.length, max: c.user_limit }) : users.length ? ', ' + t('{n} connected', { n: users.length }) : ''}${has(p, P.CONNECT) ? '' : ', ' + t('locked')})`
  return (
    <>
      <div className="row-wrap" {...menu.props}>
        <button className={cls('row', s.voice.channelId === c.id && 'connected')} aria-current={active ? 'page' : undefined} aria-label={label} onClick={open}>
          {has(p, P.CONNECT) && c.icon_emoji?.name ? <ChannelEmoji c={c} /> : <Icon d={has(p, P.CONNECT) ? (channelIcon(c.type) ?? ICONS.speaker) : ICONS.lock} size={20} className="chan-icon" />}
          <span className="ellipsis">{c.name}</span>
          {!!c.user_limit && <span className="limit" aria-hidden="true">{String(users.length).padStart(2, '0')}/{String(c.user_limit).padStart(2, '0')}</span>}
        </button>
        <RowActions c={c} />
        {menu.at && <ChannelMenu c={c} at={menu.at} onClose={menu.close} />}
      </div>
      {c.status && <p className="chan-sub" title={c.status}><span className="ellipsis">{c.status}</span></p>}
      {watch?.current && (
        <p className="chan-sub watching"><Icon d={ICONS.tv} size={14} /><span className="ellipsis">{t('Watching: {title}', { title: watchTitle(watch) })}</span></p>
      )}
      <VoiceUsers guildId={guild.id} states={users} />
    </>
  )
}

/** Voice channel status items (CONTRACT-v5 section 6) for the channel menu. */
function VoiceStatusItems({ c }: { c: Channel }) {
  if (!useCanSetVoiceStatus(c)) return null
  return (
    <>
      <MenuItem onSelect={() => editVoiceStatus(c)}>{c.status ? t('Edit Channel Status') : t('Set Channel Status')}</MenuItem>
      {c.status && <MenuItem onSelect={() => clearVoiceStatus(c)}>{t('Clear Channel Status')}</MenuItem>}
    </>
  )
}

/** Joined active threads under their parent, with a spine; a click opens the thread panel. */
function ThreadRows({ guild, parentId, channelId }: { guild: Guild; parentId: string; channelId?: string }) {
  const s = useStore((x) => x)
  const list = sidebarThreads(s, parentId)
  if (!list.length) return null
  const open = s.panel?.kind === 'thread' ? s.panel.channelId : null
  return (
    <ul className="thread-rows" aria-label={t('Threads')}>
      {list.map((th) => {
        const active = th.id === open || th.id === channelId
        const unread = !active && isUnread(s, th)
        const mentions = mentionCount(s, th.id)
        const hasDraft = !active && Boolean(s.drafts[th.id]?.content?.trim())
        return (
          <li key={th.id}>
            <span className="thread-spine" aria-hidden="true" />
            <button
              className={cls('row thread-row', unread && 'unread')}
              aria-current={active ? 'true' : undefined}
              onClick={() => {
                // Opening a thread of another channel shows that channel too.
                if (channelId !== parentId && channelId !== th.id) navigate(`/channels/${guild.id}/${parentId}`)
                setState({ panel: { kind: 'thread', channelId: th.id }, showNav: false })
              }}
            >
              <span className="ellipsis">{th.name}</span>
              {hasDraft && <span className="draft-badge" title={t('Unsent draft')} aria-label={t('Unsent draft')}>✎</span>}
              {mentions > 0 && <span className="badge" aria-label={t(mentions === 1 ? '{n} mention' : '{n} mentions', { n: mentions })}>{mentions}</span>}
              {unread && !mentions && <span className="sr-only">{t('unread')}</span>}
            </button>
          </li>
        )
      })}
    </ul>
  )
}
