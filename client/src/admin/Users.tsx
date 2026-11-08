// Users: search, table, detail drawer (servers, sessions, admin audit trail) and account actions with confirmations.
import { useEffect, useState } from 'react'
import { ask, askText, toast, toastError } from '../components/dialogs'
import { FormError, Modal } from '../components/ui'
import { t } from '../i18n'
import * as A from './api'
import type { AdminUser } from './api'
import { askCode, num, useLoad, when } from './util'

/** Debounced search text. */
export function useSearch(): [string, string, (v: string) => void] {
  const [text, setText] = useState('')
  const [query, setQuery] = useState('')
  useEffect(() => {
    const id = setTimeout(() => setQuery(text.trim()), 250)
    return () => clearTimeout(id)
  }, [text])
  return [text, query, setText]
}

export function SearchBox({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div className="admin-search" role="search">
      <label htmlFor="admin-q" className="sr-only">{label}</label>
      <input id="admin-q" type="search" className="input" placeholder={label} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  )
}

/** A list paged with `before` (newest first, 50 per page). */
export function usePaged<T extends { id: string }>(fetch: (query: string, before?: string) => Promise<T[]>, query: string) {
  const [extra, setExtra] = useState<T[]>([])
  const first = useLoad(() => (setExtra([]), fetch(query)), [query])
  const list = [...(first.data ?? []), ...extra]
  const last = extra.length ? extra : first.data ?? []
  const more = last.length === 50 ? () => void fetch(query, list.at(-1)!.id).then((r) => setExtra((x) => [...x, ...r]), toastError) : null
  return { list, loaded: !!first.data, error: first.error, reload: first.reload, more }
}

const yes = (b: boolean) => (b ? t('Yes') : t('No'))
const status = (u: AdminUser) => (u.deleted ? t('Deleted') : u.disabled ? t('Disabled') : t('Active'))

export function Users() {
  const [text, query, setText] = useSearch()
  const { list, loaded, error, reload, more } = usePaged(A.listUsers, query)
  const [open, setOpen] = useState<string | null>(null)
  return (
    <>
      <SearchBox label={t('Search by username, display name or email')} value={text} onChange={setText} />
      <FormError error={error} />
      {loaded && <p className="hint small" role="status">{t('{n} users shown', { n: num(list.length) })}</p>}
      <div className="admin-scroll">
        <table className="admin-table">
          <caption className="sr-only">{t('Users')}</caption>
          <thead><tr>
            <th scope="col">{t('Username')}</th><th scope="col">{t('Display name')}</th><th scope="col">{t('Email')}</th><th scope="col">{t('Created')}</th>
            <th scope="col">{t('Last seen')}</th><th scope="col" className="num">{t('Servers')}</th><th scope="col">2FA</th><th scope="col">{t('Bot / app owner')}</th><th scope="col">{t('Status')}</th>
          </tr></thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id}>
                <th scope="row"><button className="link" onClick={() => setOpen(u.id)}>{u.username}</button></th>
                <td>{u.global_name ?? '—'}</td><td>{u.email ?? '—'}</td><td>{when(u.created_at)}</td><td>{u.online ? t('Online now') : when(u.last_seen)}</td>
                <td className="num">{num(u.guild_count)}</td><td>{yes(u.mfa_enabled)}</td>
                <td>{u.bot ? t('Bot') : u.application_count ? t('App owner ({n})', { n: u.application_count }) : '—'}</td>
                <td>{u.disabled || u.deleted ? <span className="admin-badge danger">{status(u)}</span> : status(u)}{u.instance_admin && <span className="admin-badge">{t('Admin')}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more && <button className="secondary admin-btn" onClick={more}>{t('Load more')}</button>}
      {open && <UserDrawer id={open} onClose={() => setOpen(null)} onChanged={() => void reload()} />}
    </>
  )
}

function UserDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data: u, error, reload } = useLoad(() => A.getUser(id), [id])
  const run = (p: Promise<unknown>, done: string) => p.then(() => (toast(done), reload(), onChanged()), toastError)
  const name = u?.username ?? ''
  const confirm = (title: string, body: string, label: string, fn: () => Promise<unknown>, done: string) =>
    void ask({ title, body: <p>{body}</p>, confirm: label, danger: true }).then((ok) => void (ok && run(fn(), done)))
  const resetMfa = () => void askCode(t('Reset 2FA?'), <p>{t('Two-factor authentication and backup codes are removed from {name}’s account. Only do this after verifying who is asking.', { name })}</p>, t('Reset 2FA'))
    .then((code) => void (code && run(A.resetUserMfa(id, code), t('2FA reset.'))))
  const remove = () => void askText({ title: t('Delete {name}?', { name }), label: t('Type the username to confirm'), confirm: t('Continue'), danger: true,
    body: <p>{t('The account is deleted like a self-deletion: messages stay as "Deleted User", owned servers must be transferred first. This cannot be undone.')}</p> })
    .then((typed) => {
      if (typed === null) return null
      if (typed.trim() !== name) return void toast(t('The username did not match. Nothing was deleted.'))
      return askCode(t('Delete {name}?', { name }), <p>{t('Confirm with your own two-factor code.')}</p>, t('Delete Account')).then((code) =>
        void (code && A.deleteUser(id, typed.trim(), code).then(() => (toast(t('Account deleted.')), onChanged(), onClose()), toastError)))
    })

  return (
    <Modal title={u ? t('User {name}', { name }) : t('User')} onClose={onClose} className="admin-drawer">
      <FormError error={error} />
      {u && (
        <>
          <dl className="admin-facts">
            <dt>{t('User ID')}</dt><dd><code>{u.id}</code></dd>
            <dt>{t('Display name')}</dt><dd>{u.global_name ?? '—'}</dd>
            <dt>{t('Email')}</dt><dd>{u.email ?? '—'}</dd>
            <dt>{t('Created')}</dt><dd>{when(u.created_at)}</dd>
            <dt>{t('Last seen')}</dt><dd>{u.online ? t('Online now') : when(u.last_seen)}</dd>
            <dt>2FA</dt><dd>{yes(u.mfa_enabled)}</dd>
            <dt>{t('Status')}</dt><dd>{status(u)}{u.require_password_change && ` · ${t('must change password')}`}</dd>
            {u.applications.length > 0 && <><dt>{t('Apps')}</dt><dd>{u.applications.map((a) => a.name).join(', ')}</dd></>}
          </dl>
          {u.instance_admin ? <p className="hint">{t('Admin actions are not available for instance administrators. Revoke admin rights with the admin CLI first.')}</p> : !u.deleted && (
            <div className="admin-actions" role="group" aria-label={t('Account actions')}>
              {u.disabled ? <button className="primary admin-btn" onClick={() => void run(A.enableUser(id), t('Account enabled.'))}>{t('Enable Account')}</button>
                : <button className="danger-btn" onClick={() => confirm(t('Disable {name}?', { name }), t('{name} can no longer log in and all their sessions are closed. You can enable the account again later.', { name }), t('Disable Account'), () => A.disableUser(id), t('Account disabled.'))}>{t('Disable Account')}</button>}
              <button className="secondary admin-btn" onClick={() => confirm(t('Log out everywhere?'), t('All of {name}’s sessions and devices are logged out.', { name }), t('Log Out Everywhere'), () => A.logoutUser(id), t('Sessions closed.'))}>{t('Force Logout')}</button>
              {u.mfa_enabled && <button className="secondary admin-btn" onClick={resetMfa}>{t('Reset 2FA')}</button>}
              {!u.require_password_change && <button className="secondary admin-btn" onClick={() => confirm(t('Require a new password?'), t('{name} must choose a new password at the next login.', { name }), t('Require Password Change'), () => A.requirePasswordChange(id), t('Password change required.'))}>{t('Require Password Change')}</button>}
              <button className="danger-btn" onClick={remove}>{t('Delete Account')}</button>
            </div>
          )}
          <h3>{t('Servers')}</h3>
          {u.guilds.length ? <ul className="admin-list">{u.guilds.map((g) => <li key={g.id}>{g.name}{g.owner && <span className="admin-badge">{t('Owner')}</span>}</li>)}</ul> : <p className="hint">{t('None')}</p>}
          <h3>{t('Sessions and devices')}</h3>
          {u.sessions.length ? (
            <table className="admin-table"><caption className="sr-only">{t('Sessions and devices')}</caption>
              <thead><tr><th scope="col">{t('Device')}</th><th scope="col">{t('Logged in')}</th><th scope="col">{t('Last used')}</th></tr></thead>
              <tbody>{u.sessions.map((x) => <tr key={x.id_hash}><td>{[x.client_info.os, x.client_info.platform].filter(Boolean).join(' · ') || t('Unknown device')}</td><td>{when(x.created_at)}</td><td>{when(x.approx_last_used_time)}</td></tr>)}</tbody>
            </table>
          ) : <p className="hint">{t('None')}</p>}
          <h3>{t('Admin audit trail')}</h3>
          <AuditList entries={u.audit_log} />
        </>
      )}
      <div className="modal-actions"><button className="secondary" onClick={onClose}>{t('Close')}</button></div>
    </Modal>
  )
}

export function AuditList({ entries }: { entries: A.AuditEntry[] }) {
  if (!entries.length) return <p className="hint">{t('No entries.')}</p>
  return <ul className="admin-list">{entries.map((e) => <li key={e.id}><time dateTime={e.created_at}>{when(e.created_at)}</time> · <code>{e.action}</code>{e.admin_id && <> · {t('by {id}', { id: e.admin_id })}</>}</li>)}</ul>
}
