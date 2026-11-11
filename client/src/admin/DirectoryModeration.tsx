// Hub: directory moderation (CONTRACT-v7 §5/§6). Listed servers (hub and node), user reports about them, hide/unhide, dismiss reports.
import { useState } from 'react'
import { cdn } from '../api'
import { toast, toastError } from '../components/dialogs'
import { cls, FormError, initials } from '../components/ui'
import { t } from '../i18n'
import * as A from './api'
import { SearchBox, useSearch } from './Users'
import { askReasons, num, useLoad, when } from './util'

const FILTERS = [['all', 'All listings'], ['reported', 'Reported'], ['hidden', 'Hidden']] as const

export function DirectoryModeration() {
  const [text, query, setText] = useSearch()
  const [filter, setFilter] = useState<(typeof FILTERS)[number][0]>('reported')
  const { data, error, reload } = useLoad(() => A.listDirectory(query, filter), [query, filter])
  const hide = (e: A.DirectoryEntry) => void askReasons(t('Hide {name} from the directory?', { name: e.guild.name }), t('Hide'))
    .then((why) => void (why && A.setListingHidden(e.guild.id, true, why).then(() => (toast(t('Hidden from the directory.')), void reload()), toastError)))
  const show = (e: A.DirectoryEntry) => void A.setListingHidden(e.guild.id, false).then(() => (toast(t('Listed again.')), void reload()), toastError)
  const dismiss = (e: A.DirectoryEntry) => void A.dismissListingReports(e.guild.id).then(() => (toast(t('Reports dismissed.')), void reload()), toastError)
  return (
    <>
      <div className="admin-tabs" role="group" aria-label={t('Filter')}>
        {FILTERS.map(([id, label]) => <button key={id} className={cls('admin-tab', filter === id && 'on')} aria-pressed={filter === id} onClick={() => setFilter(id)}>{t(label)}</button>)}
      </div>
      <SearchBox label={t('Search by server name')} value={text} onChange={setText} />
      <FormError error={error} />
      {data && !data.length && <p className="hint">{t('Nothing here.')}</p>}
      <ul className="admin-cards">
        {data?.map((e) => (
          <li key={e.guild.id} className="admin-card">
            <div className="admin-card-head">
              <span className="mini-guild" aria-hidden="true">{e.guild.icon_url ? <img src={cdn(e.guild.icon_url)} alt="" /> : initials(e.guild.name, 2)}</span>
              <div>
                <h3>{e.guild.name} {e.hidden && <span className="admin-badge danger">{t('Hidden')}</span>}</h3>
                <p className="hint small">{e.guild.node ? t('on {instance}', { instance: e.guild.node.name }) : t('on this hub')} · {t('{n} Members', { n: num(e.guild.approximate_member_count) })} · <code>{e.guild.id}</code></p>
              </div>
            </div>
            {e.guild.description && <p>{e.guild.description}</p>}
            {e.hidden_reason && <p className="hint small">{t('Hidden because: {reason}', { reason: e.hidden_reason })}</p>}
            {e.reports.length > 0 && (
              <details open>
                <summary>{t(e.reports.length === 1 ? '{n} report' : '{n} reports', { n: e.reports.length })}</summary>
                <ul className="admin-list">{e.reports.map((r) => <li key={r.id}>{when(r.created_at)} · <code>{r.reporter_id}</code> · {r.reason}{r.note && ` · ${r.note}`}</li>)}</ul>
              </details>
            )}
            <div className="admin-actions" role="group" aria-label={t('Actions for {name}', { name: e.guild.name })}>
              {e.hidden ? <button className="secondary admin-btn" onClick={() => show(e)}>{t('List Again')}</button> : <button className="danger-btn" onClick={() => hide(e)}>{t('Hide')}</button>}
              {e.reports.length > 0 && <button className="secondary admin-btn" onClick={() => dismiss(e)}>{t('Dismiss Reports')}</button>}
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
