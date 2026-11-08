// Admin audit log: every admin action (append-only on the server), filterable by action, actor and target, paged with `before`.
import { useState, type FormEvent } from 'react'
import { toastError } from '../components/dialogs'
import { FormError } from '../components/ui'
import { t } from '../i18n'
import { auditLog, type AuditEntry } from './api'
import { useLoad, when } from './util'

type Filter = { action?: string; admin_id?: string; target_id?: string }

export function AdminAuditLog() {
  const [filter, setFilter] = useState<Filter>({})
  const [older, setOlder] = useState<AuditEntry[]>([])
  const { data, error } = useLoad(() => (setOlder([]), auditLog(filter)), [filter])
  const list = [...(data ?? []), ...older]
  const more = () => auditLog({ ...filter, before: list.at(-1)!.id }).then((r) => setOlder((x) => [...x, ...r]), toastError)
  const apply = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = Object.fromEntries([...new FormData(e.currentTarget)].map(([k, v]) => [k, String(v).trim() || undefined]))
    setFilter(f)
  }
  const last = older.length ? older : data ?? []
  return (
    <>
      <form className="admin-inline" onSubmit={apply} aria-label={t('Filter the audit log')}>
        <div className="field"><label htmlFor="al-action">{t('Action')}</label><input id="al-action" name="action" className="input" placeholder="user." aria-describedby="al-action-hint" /><span id="al-action-hint" className="hint small">{t('Matches the start, e.g. user. or report.')}</span></div>
        <div className="field"><label htmlFor="al-actor">{t('Admin (user ID)')}</label><input id="al-actor" name="admin_id" className="input" inputMode="numeric" /></div>
        <div className="field"><label htmlFor="al-target">{t('Target ID')}</label><input id="al-target" name="target_id" className="input" inputMode="numeric" /></div>
        <button className="primary admin-btn">{t('Filter')}</button>
      </form>
      <FormError error={error} />
      {data && (list.length ? (
        <div className="admin-scroll">
          <table className="admin-table">
            <caption className="sr-only">{t('Admin Audit Log')}</caption>
            <thead><tr><th scope="col">{t('Time')}</th><th scope="col">{t('Admin')}</th><th scope="col">{t('Action')}</th><th scope="col">{t('Target')}</th><th scope="col">{t('Details')}</th></tr></thead>
            <tbody>{list.map((e) => (
              <tr key={e.id}>
                <td><time dateTime={e.created_at}>{when(e.created_at)}</time></td><td>{e.admin_id ? <code>{e.admin_id}</code> : '—'}</td><td><code>{e.action}</code></td>
                <td>{e.target_type ? `${e.target_type} ` : ''}{e.target_id && <code>{e.target_id}</code>}</td>
                <td className="admin-details-cell">{e.details ? <code>{JSON.stringify(e.details)}</code> : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <p className="hint">{t('No entries.')}</p>)}
      {last.length === 100 && <button className="secondary admin-btn" onClick={() => void more()}>{t('Load older')}</button>}
    </>
  )
}
