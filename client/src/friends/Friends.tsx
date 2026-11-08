// Home: the Friends view (Online, All, Pending, Message Requests, Add Friend) + Active Now shelf.
import { useState, type FormEvent } from 'react'
import { acceptFriend, addFriend, openDm, removeRelationship, unblockUser } from '../actions'
import { callUser } from '../calls/calls'
import { t } from '../i18n'
import { InboxButton } from '../inbox/Inbox'
import { StatusLine } from '../profiles/Activity'
import { userActivities } from '../selectors'
import { ask, toastError } from '../components/dialogs'
import { Avatar, cls, Icon, ICONS, STATUS_LABEL } from '../components/ui'
import { useContextMenu } from '../components/menu'
import { UserMenu } from '../components/UserMenu'
import { displayName, setState, useStore } from '../store'
import type { Relationship } from '../types'
import { ActiveNow } from './ActiveNow'
import { MessageRequests } from './MessageRequests'

type Tab = 'online' | 'all' | 'pending' | 'requests' | 'blocked' | 'add'
const fail = (e: Error) => toastError(e)

function Row({ r }: { r: Relationship }) {
  const menu = useContextMenu()
  const user = useStore((s) => s.users[r.id]) ?? r.user
  const status = useStore((s) => s.presences[r.id] ?? 'offline')
  const hasActivity = useStore((s) => userActivities(s, r.id).length > 0)
  const sub = r.type === 2 ? t('Blocked') : r.type === 3 ? t('Incoming Friend Request') : r.type === 4 ? t('Outgoing Friend Request') : t(STATUS_LABEL[status])
  return (
    <li className="friend" {...menu.props}>
      <Avatar user={user} size={48} status={r.type === 1 ? status : undefined} />
      <div className="friend-who">
        <span className="name">{displayName(user)} <span className="hint">{user.username}</span></span>
        {r.type === 1 ? <span className="hint small">{hasActivity ? <StatusLine userId={r.id} /> : sub}</span> : <span className="hint small">{sub}</span>}
      </div>
      <div className="friend-actions">
        {r.type === 1 && (
          <>
            <button className="round-btn" aria-label={t('Message {name}', { name: displayName(user) })} title={t('Message')} onClick={() => openDm(r.id).catch(fail)}><Icon d={ICONS.chat} size={20} /></button>
            <button className="round-btn" aria-label={t('Call {name}', { name: displayName(user) })} title={t('Start Voice Call')} onClick={() => callUser(r.id).catch(fail)}><Icon d={ICONS.phone} size={20} /></button>
            <button className="round-btn danger" aria-label={t('Remove {name}', { name: displayName(user) })} title={t('Remove Friend')} onClick={() => void ask({ title: t("Remove '{name}'", { name: displayName(user) }), body: <p>{t('Are you sure you want to remove {name} from your friends?', { name: displayName(user) })}</p>, confirm: t('Remove Friend'), danger: true }).then((ok) => void (ok && removeRelationship(r.id).catch(fail)))}><Icon d={ICONS.close} size={20} /></button>
          </>
        )}
        {r.type === 3 && (
          <>
            <button className="round-btn ok" aria-label={t('Accept {name}', { name: displayName(user) })} title={t('Accept')} onClick={() => acceptFriend(r.id).catch(fail)}><Icon d={ICONS.check} size={20} /></button>
            <button className="round-btn danger" aria-label={t('Decline {name}', { name: displayName(user) })} title={t('Ignore')} onClick={() => removeRelationship(r.id).catch(fail)}><Icon d={ICONS.close} size={20} /></button>
          </>
        )}
        {r.type === 2 && (
          <button className="round-btn" aria-label={t('Unblock {name}', { name: displayName(user) })} title={t('Unblock')} onClick={() => unblockUser(r.id).catch(fail)}><Icon d={ICONS.block} size={20} /></button>
        )}
        {r.type === 4 && (
          <button className="round-btn danger" aria-label={t('Cancel request to {name}', { name: displayName(user) })} title={t('Cancel')} onClick={() => removeRelationship(r.id).catch(fail)}><Icon d={ICONS.close} size={20} /></button>
        )}
      </div>
      {menu.at && <UserMenu userId={r.id} at={menu.at} onClose={menu.close} />}
    </li>
  )
}

function AddFriend() {
  const [name, setName] = useState('')
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const username = name.trim()
    if (!username) return
    addFriend(username).then(
      () => (setMsg({ ok: true, text: t('Success! Your friend request to {name} was sent.', { name: username }) }), setName('')),
      (err: Error) => setMsg({ ok: false, text: err.message }),
    )
  }
  return (
    <form className="add-friend" onSubmit={submit}>
      <h2>{t('Add Friend')}</h2>
      <p className="hint">{t('You can add friends with their username.')}</p>
      <div className={cls('add-friend-box', msg && (msg.ok ? 'ok' : 'bad'))}>
        <input className="input" aria-label={t('Username')} placeholder={t('You can add friends with their username.')} value={name} onChange={(e) => (setName(e.target.value), setMsg(null))} maxLength={32} />
        <button className="primary" disabled={!name.trim()}>{t('Send Friend Request')}</button>
      </div>
      {msg && <p className={msg.ok ? 'success' : 'form-error'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
    </form>
  )
}

export function Friends() {
  const rels = useStore((s) => s.relationships)
  const presences = useStore((s) => s.presences)
  const [tab, setTab] = useState<Tab>('online')
  const all = Object.values(rels).sort((a, b) => displayName(a.user).localeCompare(displayName(b.user)))
  const friends = all.filter((r) => r.type === 1)
  const pending = all.filter((r) => r.type === 3 || r.type === 4)
  const incoming = pending.filter((r) => r.type === 3).length
  const blocked = all.filter((r) => r.type === 2)
  const list = tab === 'online' ? friends.filter((r) => !['offline', 'invisible', undefined].includes(presences[r.id])) : tab === 'all' ? friends : tab === 'blocked' ? blocked : pending
  const heading = { online: t('Online'), all: t('All Friends'), pending: t('Pending'), requests: t('Message Requests'), blocked: t('Blocked'), add: '' }[tab]
  const tabs: [Tab, string][] = [['online', t('Online')], ['all', t('All')], ['pending', t('Pending')], ['requests', t('Message Requests')], ['blocked', t('Blocked')], ['add', t('Add Friend')]]

  return (
    <main className="chat friends" aria-label={t('Friends')}>
      <header className="chat-header">
        <button className="icon-btn back" aria-label={t('Back to conversations')} onClick={() => setState({ showNav: true })}><Icon d={ICONS.back} /></button>
        <Icon d={ICONS.people} size={24} className="chan-icon" />
        <h1>{t('Friends')}</h1>
        <div className="tabs" role="tablist" aria-label={t('Friends')}>
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={cls('tab', id === 'add' && 'add')} onClick={() => setTab(id)}>
              {label}
              {id === 'pending' && incoming > 0 && <span className="badge" aria-label={t('{n} incoming', { n: incoming })}>{incoming}</span>}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="secondary small-btn" onClick={() => setState({ modal: { kind: 'group-dm' } })}>{t('New Group DM')}</button>
        <InboxButton />
      </header>
      <div className="friends-layout" style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div className="friends-body" role="tabpanel" style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
          {tab === 'add' ? <AddFriend /> : tab === 'requests' ? <MessageRequests /> : (
            <>
              <h2 className="list-heading">{heading} — {list.length}</h2>
              {list.length ? <ul className="friends-list">{list.map((r) => <Row key={r.id} r={r} />)}</ul>
                : <p className="hint empty-state">{tab === 'pending' ? t('There are no pending friend requests.') : tab === 'blocked' ? t('You have not blocked anyone.') : tab === 'online' ? t("No one's around to play with.") : t('You have no friends yet. Add some with their username!')}</p>}
            </>
          )}
        </div>
        <ActiveNow />
      </div>
    </main>
  )
}
