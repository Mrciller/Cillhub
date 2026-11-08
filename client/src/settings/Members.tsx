// Server Settings > Members, Bans, Invites, plus the ban dialog.
import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { ban, loadMembers, patchMember } from '../actions'
import { toastError } from '../components/dialogs'
import { confirmKick } from '../moderation/kick'
import { api } from '../api'
import { Avatar, FormError, Icon, ICONS, Modal } from '../components/ui'
import { TimeoutModal } from '../moderation/TimeoutModal'
import { canManageRole, canTimeout, has, outranks, P, sortedRoles, timedOutUntil } from '../permissions'
import { colorOf, memberName, myMember, permsOf } from '../selectors'
import { displayName, useStore } from '../store'
import type { Ban, Guild, Invite, Member } from '../types'

const fail = (e: Error) => toastError(e)

function MemberRow({ guild, m, onBan, onTimeout }: { guild: Guild; m: Member; onBan: () => void; onTimeout: () => void }) {
  const s = useStore((x) => x)
  const me = s.me!
  const mine = myMember(s, guild.id)
  const perms = permsOf(s, guild.id)
  const above = outranks(guild, me.id, mine, m.user.id, m)
  const user = s.users[m.user.id] ?? m.user
  const name = memberName(s, guild.id, m.user.id)
  const assignable = has(perms, P.MANAGE_ROLES) ? sortedRoles(guild).filter((r) => r.id !== guild.id && !r.managed && canManageRole(guild, me.id, mine, r)) : []
  const setRoles = (roles: string[]) => patchMember(guild.id, m.user.id, { roles }).catch(fail)
  return (
    <li className="member-admin">
      <Avatar user={user} size={32} />
      <div className="member-admin-who">
        <span className="name">{name}</span>
        <span className="hint small">{user.username}{timedOutUntil(m) ? ` · ${t('timed out')}` : ''}</span>
      </div>
      <ul className="role-chips" aria-label={t('Roles of {name}', { name })}>
        {sortedRoles(guild).filter((r) => m.roles.includes(r.id)).map((r) => (
          <li key={r.id} className="role-chip">
            <span className="role-dot" style={{ background: colorOf(r.color) ?? '#949ba4' }} aria-hidden="true" />
            {r.name}
            {assignable.includes(r) && (
              <button className="chip-x" aria-label={t('Remove role {role} from {name}', { role: r.name, name })} onClick={() => setRoles(m.roles.filter((x) => x !== r.id))}>
                <Icon d={ICONS.close} size={12} />
              </button>
            )}
          </li>
        ))}
      </ul>
      {assignable.some((r) => !m.roles.includes(r.id)) && (
        <select className="input small-select" aria-label={t('Add a role to {name}', { name })} value="" onChange={(e) => e.target.value && setRoles([...m.roles, e.target.value])}>
          <option value="">{t('Add role…')}</option>
          {assignable.filter((r) => !m.roles.includes(r.id)).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      )}
      <div className="member-admin-actions">
        {canTimeout(guild, me.id, mine, m.user.id, m) && (
          <button className="secondary small-btn" onClick={onTimeout}>{timedOutUntil(m) ? t('Remove Timeout') : t('Timeout')}</button>
        )}
        {has(perms, P.KICK_MEMBERS) && (
          <button className="secondary small-btn" disabled={!above} onClick={() => confirmKick(guild.id, guild.name, m.user.id, name)}>{t('Kick')}</button>
        )}
        {has(perms, P.BAN_MEMBERS) && (
          <button className="danger-btn small-btn" disabled={!above} onClick={onBan}>{t('Ban')}</button>
        )}
      </div>
    </li>
  )
}

export function Members({ guild }: { guild: Guild }) {
  const members = useStore((s) => s.members[guild.id])
  const loaded = useStore((s) => !!s.membersLoaded[guild.id])
  const users = useStore((s) => s.users)
  const [q, setQ] = useState('')
  const [banning, setBanning] = useState<string | null>(null)
  const [timing, setTiming] = useState<string | null>(null)
  useEffect(() => void (!loaded && loadMembers(guild.id).catch(() => {})), [guild.id, loaded])
  const query = q.trim().toLowerCase()
  const list = Object.values(members ?? {})
    .filter((m) => !query || [m.nick, users[m.user.id]?.username, users[m.user.id]?.global_name].some((x) => x?.toLowerCase().includes(query)))
    .sort((a, b) => (a.nick || displayName(users[a.user.id])).localeCompare(b.nick || displayName(users[b.user.id])))
  return (
    <>
      <h1>{t('Server Members')}</h1>
      <input className="input" type="search" aria-label={t('Search members')} placeholder={t('Search members')} value={q} onChange={(e) => setQ(e.target.value)} />
      <p className="hint small count">{t(list.length === 1 ? '{n} member' : '{n} members', { n: list.length })}</p>
      <ul className="member-admin-list">{list.map((m) => <MemberRow key={m.user.id} guild={guild} m={m} onBan={() => setBanning(m.user.id)} onTimeout={() => setTiming(m.user.id)} />)}</ul>
      {banning && <BanModal guildId={guild.id} userId={banning} onClose={() => setBanning(null)} />}
      {timing && <TimeoutModal guildId={guild.id} userId={timing} onClose={() => setTiming(null)} />}
    </>
  )
}

export function Bans({ guild }: { guild: Guild }) {
  const version = useStore((s) => s.bansVersion)
  const [bans, setBans] = useState<Ban[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api<Ban[]>(`/guilds/${guild.id}/bans`).then(setBans, (e: Error) => setError(e.message))
  }, [guild.id, version])
  return (
    <>
      <h1>{t('Server Ban List')}</h1>
      <FormError error={error} />
      {bans?.length === 0 && <p className="hint">{t('No bans. Nobody has been banned from this server.')}</p>}
      <ul className="member-admin-list">
        {bans?.map((b) => (
          <li key={b.user.id} className="member-admin">
            <Avatar user={b.user} size={32} />
            <div className="member-admin-who">
              <span className="name">{displayName(b.user)}</span>
              <span className="hint small">{b.reason ? t('Reason: {reason}', { reason: b.reason }) : t('No reason given')}</span>
            </div>
            <button className="secondary small-btn" onClick={() => api(`/guilds/${guild.id}/bans/${b.user.id}`, { method: 'DELETE' }).then(() => setBans((l) => l?.filter((x) => x !== b) ?? null), fail)}>
              {t('Revoke Ban')}
            </button>
          </li>
        ))}
      </ul>
    </>
  )
}

export function Invites({ guild }: { guild: Guild }) {
  const [invites, setInvites] = useState<Invite[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api<Invite[]>(`/guilds/${guild.id}/invites`).then(setInvites, (e: Error) => setError(e.message))
  }, [guild.id])
  const revoke = (code: string) => api(`/invites/${code}`, { method: 'DELETE' }).then(() => setInvites((l) => l?.filter((i) => i.code !== code) ?? null), fail)
  return (
    <>
      <h1>{t('Invites')}</h1>
      <FormError error={error} />
      {invites?.length === 0 && <p className="hint">{t('No invites yet.')}</p>}
      {!!invites?.length && (
        <table className="invite-table">
          <thead><tr><th>{t('Inviter')}</th><th>{t('Invite Code')}</th><th>{t('Uses')}</th><th>{t('Expires')}</th><th><span className="sr-only">{t('Actions')}</span></th></tr></thead>
          <tbody>
            {invites.map((i) => (
              <tr key={i.code}>
                <td>{i.inviter ? displayName(i.inviter) : '—'}</td>
                <td><code>{i.code}</code></td>
                <td>{i.uses}{i.max_uses ? ` / ${i.max_uses}` : ''}</td>
                <td>{i.expires_at ? new Date(i.expires_at).toLocaleString() : t('Never')}</td>
                <td><button className="danger-btn small-btn" onClick={() => revoke(i.code)} aria-label={t('Revoke invite {code}', { code: i.code })}>{t('Revoke')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

const WINDOWS: [number, string][] = [
  [0, "Don't Delete Any"], [3600, 'Previous Hour'], [21600, 'Previous 6 Hours'], [43200, 'Previous 12 Hours'],
  [86400, 'Previous 24 Hours'], [259200, 'Previous 3 Days'], [604800, 'Previous 7 Days'],
]

export function BanModal({ guildId, userId, onClose }: { guildId: string; userId: string; onClose: () => void }) {
  const name = useStore((s) => memberName(s, guildId, userId))
  const [reason, setReason] = useState('')
  const [seconds, setSeconds] = useState(0)
  const [error, setError] = useState('')
  return (
    <Modal title={t('Ban {name}', { name })} onClose={onClose}>
      <p className="hint">{t("They will be removed from the server and won't be able to rejoin.")}</p>
      <form onSubmit={(e) => (e.preventDefault(), ban(guildId, userId, reason.trim(), seconds).then(onClose, (err: Error) => setError(err.message)))}>
        <div className="field">
          <label htmlFor="ban-delete">{t('Delete Message History')}</label>
          <select id="ban-delete" className="input" value={seconds} onChange={(e) => setSeconds(+e.target.value)}>
            {WINDOWS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ban-reason">{t('Reason for Ban')}</label>
          <textarea id="ban-reason" className="input textarea" maxLength={512} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <FormError error={error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className="danger-btn">{t('Ban')}</button>
        </div>
      </form>
    </Modal>
  )
}
