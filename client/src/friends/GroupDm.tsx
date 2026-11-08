// Group DMs (CONTRACT-v4): "Select Friends" to create one or add people, the member list with owner actions, rename and icon.
import { useState } from 'react'
import { addRecipient, closePrivate, createGroupDm, removeRecipient, updateGroupDm } from '../actions'
import { dataUri } from '../api'
import { ask, toastError } from '../components/dialogs'
import { MenuItem, Popover, useContextMenu } from '../components/menu'
import { Avatar, channelIconUrl, cls, FormError, Modal } from '../components/ui'
import { ResizeHandle } from '../components/ResizeHandle'
import { t } from '../i18n'
import { StatusLine } from '../profiles/Activity'
import { privateName } from '../selectors'
import { displayName, setState, useStore } from '../store'
import type { Channel, User } from '../types'

const MAX = 10 // a group DM holds up to 10 people including you

/** Create a group DM from friends (up to 9 others), or add friends to an existing one. */
export function GroupDmModal({ channelId, onClose }: { channelId?: string; onClose: () => void }) {
  const s = useStore((x) => x)
  const channel = channelId ? s.channels[channelId] : undefined
  const present = new Set((channel?.recipients ?? []).map((u) => u.id))
  const slots = MAX - 1 - present.size
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string[]>([])
  const [error, setError] = useState('')
  const friends = Object.values(s.relationships).filter((r) => r.type === 1 && !present.has(r.id)).map((r) => s.users[r.id] ?? r.user)
    .filter((u) => `${u.username} ${u.global_name ?? ''}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => displayName(a).localeCompare(displayName(b)))
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < slots ? [...p, id] : p))
  const submit = async () => {
    setError('')
    try {
      if (channel?.type === 3) await Promise.all(picked.map((id) => addRecipient(channel.id, id)))
      // From a 1:1 DM, this makes a new group with both of you plus the new people.
      else await createGroupDm([...present, ...picked])
      onClose()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <Modal title={t('Select Friends')} onClose={onClose} className="group-dm-modal">
      <p className="hint">{slots - picked.length > 0 ? t('You can add {n} more friends.', { n: slots - picked.length }) : t('This group has a 10 member limit.')}</p>
      <input className="input" aria-label={t('Type the username of a friend')} placeholder={t('Type the username of a friend')} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
      <ul className="friend-pick" aria-label={t('Friends')}>
        {friends.map((u) => (
          <li key={u.id}>
            <label className={cls('row', picked.includes(u.id) && 'on')}>
              <Avatar user={u} size={32} status={s.presences[u.id] ?? 'offline'} />
              <span className="ellipsis">{displayName(u)} <span className="hint small">{u.username}</span></span>
              <input type="checkbox" checked={picked.includes(u.id)} disabled={!picked.includes(u.id) && picked.length >= slots} onChange={() => toggle(u.id)} />
            </label>
          </li>
        ))}
      </ul>
      {!friends.length && <p className="hint">{t('No friends found that are not already in this DM.')}</p>}
      <FormError error={error} />
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>{t('Cancel')}</button>
        <button className="primary" disabled={!picked.length} onClick={() => void submit()}>{channel?.type === 3 ? t('Add') : t('Create Group DM')}</button>
      </div>
    </Modal>
  )
}

function MemberRow({ channel, u, owner }: { channel: Channel; u: User; owner: boolean }) {
  const s = useStore((x) => x)
  const menu = useContextMenu()
  const me = s.me?.id
  const user = s.users[u.id] ?? u
  return (
    <li {...menu.props}>
      <button className="row member-btn" onClick={(e) => setState({ popout: { userId: u.id, at: { rect: e.currentTarget.getBoundingClientRect(), side: 'left' } } })}>
        <Avatar user={user} size={28} status={s.presences[u.id] ?? 'offline'} />
        <span className="dm-text"><span className="ellipsis">{displayName(user)}</span><StatusLine userId={u.id} /></span>
        {channel.owner_id === u.id && <span className="crown" role="img" aria-label={t('Group Owner')} title={t('Group Owner')}>♛</span>}
      </button>
      {menu.at && (
        <Popover at={menu.at} onClose={menu.close} role="menu" label={displayName(user)}>
          <MenuItem onSelect={() => setState({ modal: { kind: 'profile', userId: u.id } })}>{t('Profile')}</MenuItem>
          {owner && u.id !== me && <MenuItem onSelect={() => void updateGroupDm(channel.id, { owner: u.id }).catch(toastError)}>{t('Make Group Owner')}</MenuItem>}
          {owner && u.id !== me && <MenuItem danger onSelect={() => void removeRecipient(channel.id, u.id).catch(toastError)}>{t('Remove From Group')}</MenuItem>}
        </Popover>
      )}
    </li>
  )
}

/** Right-hand member list of a group DM. */
export function GroupMembers({ channel }: { channel: Channel }) {
  const me = useStore((s) => s.me)
  const all = [...(me ? [me] : []), ...(channel.recipients ?? [])]
  return (
    <aside className="members" aria-label={t('Members')}>
      <ResizeHandle
        id="group-members-resizer"
        side="left"
        defaultValue={216}
        min={160}
        max={420}
        storageKey="cillhub:members-width"
        cssVar="--members-width"
        ariaLabel={t('Resize member list')}
      />
      <h2 className="list-heading">{t('Members — {n}', { n: all.length })}</h2>
      <ul>{all.map((u) => <MemberRow key={u.id} channel={channel} u={u} owner={channel.owner_id === me?.id} />)}</ul>
    </aside>
  )
}

export const leaveGroup = (c: Channel, name: string) =>
  void ask({ title: t("Leave '{name}'", { name }), body: <p>{t('Are you sure you want to leave {name}? You won\'t be able to rejoin this group unless you are re-invited.', { name })}</p>, confirm: t('Leave Group'), danger: true })
    .then((ok) => void (ok && closePrivate(c).catch(toastError)))

export function changeGroupIcon(c: Channel) {
  const input = Object.assign(document.createElement('input'), { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp' })
  input.onchange = () => {
    const f = input.files?.[0]
    if (f) dataUri(f).then((icon) => updateGroupDm(c.id, { icon })).catch(toastError)
  }
  input.click()
}

/** Group DM title in the header: click to rename (anyone in the group can). */
export function GroupTitle({ channel }: { channel: Channel }) {
  const s = useStore((x) => x)
  const [edit, setEdit] = useState<string | null>(null)
  const name = privateName(s, channel)
  if (edit !== null)
    return (
      <form className="group-rename" onSubmit={(e) => (e.preventDefault(), updateGroupDm(channel.id, { name: edit.trim() || null }).then(() => setEdit(null), toastError))}>
        <input className="input" aria-label={t('Group name')} value={edit} maxLength={100} autoFocus onChange={(e) => setEdit(e.target.value)} onBlur={(e) => e.currentTarget.form?.requestSubmit()} onKeyDown={(e) => e.key === 'Escape' && (e.stopPropagation(), setEdit(null))} />
      </form>
    )
  return (
    <>
      <Avatar user={channel.recipients?.[0]} src={channelIconUrl(channel)} size={24} />
      <h1 className="ellipsis"><button className="group-name-btn" title={t('Edit group name')} aria-label={t('{name}, edit group name', { name })} onClick={() => setEdit(channel.name ?? '')}>{name}</button></h1>
    </>
  )
}

