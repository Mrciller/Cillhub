// Reports queue: the reported message (the only message content the dashboard shows), a link to it in context, and actions.
import { useState } from 'react'
import { ask, askText, toast, toastError } from '../components/dialogs'
import { cls, FormError } from '../components/ui'
import { t } from '../i18n'
import { Link } from '../router'
import { listReports, resolveReport, type Report, type ReportAction } from './api'
import { reasonLabel } from './ReportDialog'
import { useLoad, when } from './util'

const RESOLUTION: Record<ReportAction, string> = {
  dismiss: 'Dismissed', delete_message: 'Message deleted', timeout: 'Author timed out', kick: 'Author kicked', ban: 'Author banned', disable_account: 'Account disabled',
}

export function Reports() {
  const [status, setStatus] = useState<Report['status']>('open')
  const { data, error, reload } = useLoad(() => listReports(status), [status])
  return (
    <>
      <div className="admin-tabs" role="group" aria-label={t('Show reports')}>
        {(['open', 'resolved'] as const).map((s) => (
          <button key={s} className={cls('admin-tab', status === s && 'on')} aria-pressed={status === s} onClick={() => setStatus(s)}>{s === 'open' ? t('Open') : t('Resolved')}</button>
        ))}
      </div>
      <FormError error={error} />
      {data && data.length === 0 && <p className="hint">{status === 'open' ? t('No open reports. Nice.') : t('No resolved reports yet.')}</p>}
      <ul className="admin-reports">{data?.map((r) => <ReportCard key={r.id} r={r} onDone={() => void reload()} />)}</ul>
    </>
  )
}

function ReportCard({ r, onDone }: { r: Report; onDone: () => void }) {
  const author = r.author
  const who = author ? author.global_name || author.username : t('the author')
  const where = r.guild ? `${r.guild.name} › #${r.channel.name ?? r.channel.id}` : t('Direct message')
  const act = (action: ReportAction, duration?: number) =>
    resolveReport(r.id, action, duration).then(() => (toast(t('Report resolved: {what}.', { what: t(RESOLUTION[action]) })), onDone()), toastError)
  const confirm = (action: ReportAction, title: string, body: string, label: string) =>
    void ask({ title, body: <p>{body}</p>, confirm: label, danger: true }).then((ok) => void (ok && act(action)))
  const timeout = () => void askText({ title: t('Timeout {name}', { name: who }), label: t('Minutes (1 to 40320)'), initial: '60', confirm: t('Timeout'), danger: true })
    .then((v) => {
      if (v === null) return
      const min = Math.round(Number(v))
      if (!(min >= 1 && min <= 40320)) return toast(t('Enter a number of minutes between 1 and 40320.'))
      void act('timeout', min * 60)
    })
  const open = r.status === 'open'
  return (
    <li className="admin-card admin-report">
      <header>
        <strong>{reasonLabel(r.reason)}</strong>
        <span className="hint small">{t('Reported by {name}', { name: r.reporter.username })} · <time dateTime={r.created_at}>{when(r.created_at)}</time></span>
      </header>
      {r.note && <p className="admin-note"><span className="sr-only">{t('Note')}: </span>“{r.note}”</p>}
      <figure className="admin-quote">
        <figcaption>{author?.username ?? t('Unknown')} · {where} · <time dateTime={r.message.timestamp}>{when(r.message.timestamp)}</time>{!r.message.exists && ` · ${t('deleted since')}`}</figcaption>
        {/* Plain text on purpose: reported content is untrusted. */}
        <blockquote>{r.message.content || <em>{t('No text')}</em>}</blockquote>
        {!!r.message.attachments?.length && <p className="hint small">{t('Attachments')}: {r.message.attachments.map((a) => a.filename).join(', ')}</p>}
      </figure>
      {r.message.exists && <Link className="link" to={r.link}>{t('Open in context')}</Link>}
      {open ? (
        <div className="admin-actions" role="group" aria-label={t('Report actions')}>
          <button className="secondary admin-btn" onClick={() => void act('dismiss')}>{t('Dismiss')}</button>
          {r.message.exists && <button className="danger-btn" onClick={() => confirm('delete_message', t('Delete this message?'), t('The message is deleted for everyone.'), t('Delete Message'))}>{t('Delete Message')}</button>}
          {r.guild && author && (
            <>
              <button className="danger-btn" onClick={timeout}>{t('Timeout Author')}</button>
              <button className="danger-btn" onClick={() => confirm('kick', t('Kick {name}?', { name: who }), t('{name} is removed from {server} and can rejoin with an invite.', { name: who, server: r.guild?.name ?? '' }), t('Kick'))}>{t('Kick Author')}</button>
              <button className="danger-btn" onClick={() => confirm('ban', t('Ban {name}?', { name: who }), t('{name} is banned from {server}.', { name: who, server: r.guild?.name ?? '' }), t('Ban'))}>{t('Ban Author')}</button>
            </>
          )}
          {author && !author.bot && <button className="danger-btn" onClick={() => confirm('disable_account', t('Disable {name}?', { name: who }), t('{name} can no longer log in anywhere on this instance and all their sessions are closed.', { name: who }), t('Disable Account'))}>{t('Disable Account')}</button>}
        </div>
      ) : (
        <ul className="admin-list hint small">{r.actions.map((a, i) => <li key={i}>{t(RESOLUTION[a.action] ?? a.action)} · {when(a.at)}</li>)}</ul>
      )}
    </li>
  )
}
