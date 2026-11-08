// Buttons under a profile: Message, Call, friend actions, block, Copy User ID (developer mode).
import { useState } from 'react'
import { acceptFriend, addFriend, blockUser, openDm, removeRelationship, unblockUser } from '../actions'
import { callUser } from '../calls/calls'
import { ask, toastError } from '../components/dialogs'
import { MenuItem, MenuSep, Popover, type Anchor } from '../components/menu'
import { Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { displayName, setState, useStore } from '../store'
import type { User } from '../types'

const fail = (e: Error) => toastError(e)

export function confirmBlock(user: User) {
  void ask({
    title: t('Block {name}?', { name: displayName(user) }),
    body: <p>{t("They won't be able to message you, call you or send you friend requests, and their messages in shared servers are hidden. Blocking also removes them as a friend.")}</p>,
    confirm: t('Block'), danger: true,
  }).then((ok) => void (ok && blockUser(user.id).catch(fail)))
}

export function ProfileActions({ user, onDone, full }: { user: User; onDone?: () => void; full?: () => void }) {
  const rel = useStore((s) => s.relationships[user.id])
  const self = useStore((s) => s.me?.id === user.id)
  const dev = useStore((s) => !!s.settings.developer_mode)
  const [more, setMore] = useState<Anchor | null>(null)
  if (self) return full ? <div className="profile-actions"><button className="secondary" onClick={full}>{t('View Full Profile')}</button></div> : null
  const blocked = rel?.type === 2
  return (
    <div className="profile-actions">
      {!blocked && <button className="primary" onClick={() => openDm(user.id).then(onDone, fail)}><Icon d={ICONS.chat} size={16} /> {t('Message')}</button>}
      {!blocked && !user.bot && (
        <button className="secondary icon-only" aria-label={t('Start Voice Call')} title={t('Start Voice Call')} onClick={() => callUser(user.id).then(onDone, fail)}><Icon d={ICONS.phone} size={20} /></button>
      )}
      {rel?.type === 3 && <button className="secondary" onClick={() => acceptFriend(user.id).catch(fail)}>{t('Accept')}</button>}
      {!rel && !user.bot && <button className="secondary" onClick={() => addFriend(user.username).catch(fail)}>{t('Add Friend')}</button>}
      <button className="secondary icon-only" aria-label={t('More')} aria-haspopup="menu" title={t('More')} onClick={(e) => setMore({ rect: e.currentTarget.getBoundingClientRect(), side: 'below' })}><Icon d={ICONS.more} size={20} /></button>
      {more && (
        <Popover at={more} onClose={() => setMore(null)} role="menu" label={t('More')}>
          {full && <MenuItem onSelect={full}>{t('View Full Profile')}</MenuItem>}
          {rel?.type === 1 && <MenuItem danger onSelect={() => removeRelationship(user.id).catch(fail)}>{t('Remove Friend')}</MenuItem>}
          {rel?.type === 4 && <MenuItem onSelect={() => removeRelationship(user.id).catch(fail)}>{t('Cancel Friend Request')}</MenuItem>}
          {blocked ? <MenuItem onSelect={() => unblockUser(user.id).catch(fail)}>{t('Unblock')}</MenuItem> : <MenuItem danger onSelect={() => confirmBlock(user)}>{t('Block')}</MenuItem>}
          {dev && <><MenuSep /><MenuItem onSelect={() => void navigator.clipboard.writeText(user.id)}>{t('Copy User ID')}</MenuItem></>}
        </Popover>
      )}
    </div>
  )
}

export const openFullProfile = (userId: string, guildId?: string, tab?: string) => setState({ popout: null, modal: { kind: 'profile', userId, guildId, tab } })
