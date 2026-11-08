// Thread member list popover: who joined, add members (private threads), remove (MANAGE_THREADS).
import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { addThreadMember, listThreadMembers, loadMembers, removeThreadMember } from '../actions'
import { toastError } from '../components/dialogs'
import { Popover, type Anchor } from '../components/menu'
import { Avatar, Icon, ICONS } from '../components/ui'
import { has, P } from '../permissions'
import { memberName, usePerms } from '../selectors'
import { useStore } from '../store'
import type { Channel, Guild } from '../types'

export function ThreadMembersButton({ thread, guild }: { thread: Channel; guild: Guild }) {
  const [at, setAt] = useState<Anchor | null>(null)
  return (
    <>
      <button className="icon-btn" aria-label={t('Thread members')} title={t('Thread Members')} aria-expanded={!!at} onClick={(e) => setAt({ rect: e.currentTarget.getBoundingClientRect(), side: 'below' })}>
        <Icon d={ICONS.people} />
      </button>
      {at && <ThreadMembers thread={thread} guild={guild} at={at} onClose={() => setAt(null)} />}
    </>
  )
}

function ThreadMembers({ thread, guild, at, onClose }: { thread: Channel; guild: Guild; at: Anchor; onClose: () => void }) {
  const version = useStore((s) => s.threadMembersVersion[thread.id] ?? 0)
  const s = useStore((x) => x)
  const perms = usePerms(guild.id, thread.id)
  const [ids, setIds] = useState<string[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    listThreadMembers(thread.id).then((l) => setIds(l.map((m) => m.user_id ?? m.member?.user.id ?? '').filter(Boolean)), (e: Error) => setError(e.message))
  }, [thread.id, version])
  const loaded = !!s.membersLoaded[guild.id]
  useEffect(() => void (!loaded && loadMembers(guild.id).catch(() => {})), [guild.id, loaded])
  const manage = has(perms, P.MANAGE_THREADS)
  const canKick = manage || (thread.type === 12 && thread.owner_id === s.me?.id)
  const joined = !!thread.member
  const canAdd = thread.type === 12 && !thread.thread_metadata?.archived && has(perms, P.SEND_MESSAGES) && (manage || (joined && thread.thread_metadata?.invitable !== false))
  const others = Object.values(s.members[guild.id] ?? {}).filter((m) => !ids?.includes(m.user.id))
  const refresh = (p: Promise<unknown>, change: (l: string[]) => string[]) => p.then(() => setIds((l) => (l ? change(l) : l)), toastError)
  return (
    <Popover at={at} onClose={onClose} label={t('Thread members')} className="thread-members">
      <h2 className="pins-title">{t('Thread Members')}{ids ? ` — ${ids.length}` : ''}</h2>
      {error && <p className="form-error" role="alert">{error}</p>}
      {canAdd && others.length > 0 && (
        <select className="input" aria-label={t('Add a member to this thread')} value=""
          onChange={(e) => { const id = e.target.value; if (id) refresh(addThreadMember(thread.id, id), (l) => [...l, id]) }}>
          <option value="">{t('Add member…')}</option>
          {others.map((m) => <option key={m.user.id} value={m.user.id}>{memberName(s, guild.id, m.user.id)}</option>)}
        </select>
      )}
      {ids === null && !error && <p className="hint">{t('Loading…')}</p>}
      <ul>
        {ids?.map((id) => (
          <li key={id} className="row thread-member">
            <Avatar user={s.users[id]} size={24} status={s.presences[id] ?? 'offline'} />
            <span className="ellipsis">{memberName(s, guild.id, id)}</span>
            {canKick && id !== s.me?.id && (
              <button className="icon-btn tiny" aria-label={t('Remove {name} from thread', { name: memberName(s, guild.id, id) })} onClick={() => refresh(removeThreadMember(thread.id, id), (l) => l.filter((x) => x !== id))}>
                <Icon d={ICONS.close} size={14} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </Popover>
  )
}
