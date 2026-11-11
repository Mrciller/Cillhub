// Inbox (top right of the header): Mentions (GET /users/@me/mentions with filters) and Unreads (from read states), jump and mark read.
import { useEffect, useState } from 'react'
import { ackBulk, ackMessage, deleteMention, openMessage, recentMentions } from '../actions'
import { stamp } from '../chat/MessageItem'
import { useMdContext } from '../chat/MessageList'
import { toastError } from '../components/dialogs'
import { Popover, type Anchor } from '../components/menu'
import { Avatar, cls, Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { Markdown } from '../markdown/Markdown'
import { mentionCount, privateName, unreadChannels, isUnread } from '../selectors'
import { cmpId, displayName, getState, isPrivate, useStore } from '../store'
import type { Channel, Message } from '../types'
import { BookmarksTab, RemindersTab, ScheduledTab } from '../scheduling/Scheduling'
import './inbox.css'

const where = (c: Channel | undefined) => {
  const s = getState()
  if (!c) return ''
  if (isPrivate(c)) return privateName(s, c)
  return `#${c.name} · ${s.guilds[c.guild_id!]?.name ?? ''}`
}

function MentionItem({ m, onJump, onRemove }: { m: Message; onJump: () => void; onRemove: () => void }) {
  const guild = useStore((s) => (m.guild_id ? s.guilds[m.guild_id] : undefined))
  const channel = useStore((s) => s.channels[m.channel_id])
  const ctx = useMdContext(guild)
  return (
    <li className="inbox-item">
      <div className="inbox-where hint small">{where(channel)}</div>
      <div className="inbox-msg">
        <Avatar user={m.author} size={32} />
        <div className="inbox-text">
          <p><strong>{displayName(m.author)}</strong> <time className="hint small" dateTime={m.timestamp}>{stamp(m.timestamp)}</time></p>
          <div className="content"><Markdown content={m.content.slice(0, 400)} ctx={ctx} /></div>
        </div>
        <div className="inbox-actions">
          <button className="secondary small-btn" onClick={onJump}>{t('Jump')}</button>
          <button className="icon-btn" aria-label={t('Remove mention')} title={t('Remove')} onClick={onRemove}><Icon d={ICONS.close} size={16} /></button>
        </div>
      </div>
    </li>
  )
}

function Mentions({ guildId, close }: { guildId?: string; close: () => void }) {
  const [list, setList] = useState<Message[] | null>(null)
  const [everyone, setEveryone] = useState(true)
  const [roles, setRoles] = useState(true)
  const [thisServer, setThisServer] = useState(false)
  const [more, setMore] = useState(false)
  const params = { everyone, roles, guild_id: thisServer ? guildId : undefined }
  useEffect(() => {
    setList(null)
    recentMentions(params).then((l) => (setList(l), setMore(l.length >= 25)), (e: Error) => (toastError(e), setList([])))
  }, [everyone, roles, thisServer, guildId]) // eslint-ignore: params derive from these
  const loadMore = () => list && recentMentions({ ...params, before: list.at(-1)?.id }).then((l) => (setList([...list, ...l]), setMore(l.length >= 25)), toastError)
  return (
    <>
      <div className="inbox-filters" role="group" aria-label={t('Filters')}>
        <label><input type="checkbox" checked={everyone} onChange={(e) => setEveryone(e.target.checked)} /> {t('Include @everyone and @here')}</label>
        <label><input type="checkbox" checked={roles} onChange={(e) => setRoles(e.target.checked)} /> {t('Include role mentions')}</label>
        {guildId && <label><input type="checkbox" checked={thisServer} onChange={(e) => setThisServer(e.target.checked)} /> {t('Only this server')}</label>}
      </div>
      {list === null ? <p className="hint inbox-empty" role="status">{t('Loading…')}</p>
        : list.length === 0 ? <p className="hint inbox-empty">{t("You're all caught up! Nobody mentioned you in the last 7 days.")}</p>
        : (
          <ul className="inbox-list" aria-label={t('Mentions')}>
            {list.map((m) => (
              <MentionItem key={m.id} m={m} onJump={() => (close(), void openMessage(m.channel_id, m.id, m.guild_id))}
                onRemove={() => (setList(list.filter((x) => x.id !== m.id)), void deleteMention(m.id).catch(toastError))} />
            ))}
          </ul>
        )}
      {more && <button className="link inbox-more" onClick={() => void loadMore()}>{t('Load more')}</button>}
    </>
  )
}

function Unreads({ close }: { close: () => void }) {
  const s = useStore((x) => x)
  const list = unreadChannels(s)
  return (
    <>
      <div className="inbox-filters">
        <button className="secondary small-btn" disabled={!list.length} onClick={() => void ackBulk(list).catch(toastError)}>{t('Mark All as Read')}</button>
      </div>
      {list.length === 0 ? <p className="hint inbox-empty">{t("You're all caught up!")}</p> : (
        <ul className="inbox-list" aria-label={t('Unread channels')}>
          {list.map((c) => {
            const n = mentionCount(s, c.id)
            return (
              <li key={c.id} className="inbox-item unread-item">
                <button className="row" onClick={() => (close(), void openMessage(c.id, c.last_message_id!, c.guild_id))}>
                  <span className="ellipsis">{where(c)}</span>
                  {n > 0 && <span className="badge" aria-label={t('{n} mentions', { n })}>{n}</span>}
                </button>
                <button className="secondary small-btn" onClick={() => c.last_message_id && ackMessage(c.id, c.last_message_id)}>{t('Mark as Read')}</button>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

function ActiveThreadsTab({ close }: { close: () => void }) {
  const s = useStore((x) => x)
  const myId = s.me?.id
  const joinedThreads = Object.values(s.channels).filter(
    (c) => (c.type === 11 || c.type === 12) && !c.thread_metadata?.archived && (!!c.member || s.members[c.guild_id ?? '']?.[myId ?? ''] != null)
  ).sort((a, b) => cmpId(b.last_message_id ?? b.id, a.last_message_id ?? a.id))

  return (
    <>
      {joinedThreads.length === 0 ? (
        <p className="hint inbox-empty">{t('No active joined threads.')}</p>
      ) : (
        <ul className="inbox-list" aria-label={t('Active threads')}>
          {joinedThreads.map((th) => {
            const guild = s.guilds[th.guild_id ?? '']
            const unread = isUnread(s, th)
            const n = mentionCount(s, th.id)
            return (
              <li key={th.id} className="inbox-item" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <button
                  className="row"
                  style={{ display: 'flex', alignItems: 'center', gap: '8px', flex: 1, minWidth: 0, background: 'none', border: 'none', cursor: 'pointer', textAlign: 'left', color: 'inherit' }}
                  onClick={() => {
                    close()
                    void openMessage(th.id, th.last_message_id ?? th.id, th.guild_id)
                  }}
                >
                  <Icon d={ICONS.thread} size={18} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: unread ? 700 : 500, fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {th.name}
                    </div>
                    <div className="hint small" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {guild ? guild.name : ''}
                      {th.message_count ? ` · ${t('{n} messages', { n: th.message_count })}` : ''}
                    </div>
                  </div>
                  {unread && <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent)', flexShrink: 0 }} />}
                  {n > 0 && <span className="badge" aria-label={t('{n} mentions', { n })}>{n}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

type Tab = 'mentions' | 'unreads' | 'threads' | 'bookmarks' | 'reminders' | 'scheduled'
const TABS: [Tab, string][] = [['mentions', 'Mentions'], ['unreads', 'Unreads'], ['threads', 'Active Threads'], ['bookmarks', 'Bookmarks'], ['reminders', 'Reminders'], ['scheduled', 'Scheduled']]

export function InboxButton({ guildId }: { guildId?: string }) {
  const [at, setAt] = useState<Anchor | null>(null)
  const [tab, setTab] = useState<Tab>('mentions')
  const due = useStore((s) => Object.values(s.reminders).filter((r) => r.save_data.due_at && Date.parse(r.save_data.due_at) <= Date.now()).length)
  const close = () => setAt(null)
  return (
    <>
      <button className="icon-btn" aria-label={t('Inbox')} title={t('Inbox')} aria-haspopup="dialog" aria-expanded={!!at} onClick={(e) => setAt(at ? null : { rect: e.currentTarget.getBoundingClientRect(), side: 'below' })}>
        <Icon d={ICONS.inbox} />
      </button>
      {at && (
        <Popover at={at} onClose={close} label={t('Inbox')} className="inbox">
          <header className="inbox-head">
            <h2><Icon d={ICONS.inbox} size={20} /> {t('Inbox')}</h2>
            <div className="tabs" role="tablist" aria-label={t('Inbox')}>
              {TABS.map(([id, label]) => (
                <button key={id} role="tab" aria-selected={tab === id} className={cls('tab', tab === id && 'on')} onClick={() => setTab(id)}>
                  {t(label)}{id === 'reminders' && due > 0 && <span className="badge" aria-label={t('{n} due', { n: due })}>{due}</span>}
                </button>
              ))}
            </div>
          </header>
          <div role="tabpanel" className="inbox-body">
            {tab === 'mentions' ? <Mentions guildId={guildId} close={close} /> : tab === 'unreads' ? <Unreads close={close} /> : tab === 'threads' ? <ActiveThreadsTab close={close} /> : tab === 'bookmarks' ? <BookmarksTab close={close} /> : tab === 'reminders' ? <RemindersTab close={close} /> : <ScheduledTab />}
          </div>
        </Popover>
      )}
    </>
  )
}
