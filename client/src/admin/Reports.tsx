// Reports queue: in-app reports (the reported message is the only message content the dashboard shows), public notices
// of illegal content (DSA Art. 16), removals by link (TCO, kept 6 months), appeals (Art. 20) and the yearly numbers.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ask, askText, toast, toastError } from '../components/dialogs'
import { cls, Field, FormError } from '../components/ui'
import { t } from '../i18n'
import { Link } from '../router'
import * as A from './api'
import type { Report, ReportAction } from './api'
import { reasonLabel } from './ReportDialog'
import { askCode, askReasons, useLoad, when } from './util'
import { ACTION_LABEL, categoryLabel, DecisionView, groundLabel, noticeLabel } from '../legal/LegalPages'
import { cdn } from '../api'
import { decryptDownload } from '../e2ee/session'

const RESOLUTION: Record<string, string> = {
  dismiss: 'Dismissed', delete_message: 'Message deleted', timeout: 'Author timed out', kick: 'Author kicked', ban: 'Author banned', disable_account: 'Account disabled',
  action_taken: 'Action taken', remove_message: 'Message removed and preserved', remove_server: 'Server removed and preserved',
}
type Tab = 'user' | 'public' | 'removal' | 'appeals' | 'numbers'
const TABS: [Tab, string][] = [['user', 'In-app reports'], ['public', 'Public notices'], ['removal', 'Remove by link'], ['appeals', 'Appeals'], ['numbers', 'Yearly numbers']]

export function Reports() {
  const [tab, setTab] = useState<Tab>('user')
  return (
    <>
      <div className="admin-tabs" role="group" aria-label={t('Report queues')}>
        {TABS.map(([k, label]) => <button key={k} className={cls('admin-tab', tab === k && 'on')} aria-pressed={tab === k} onClick={() => setTab(k)}>{t(label)}</button>)}
      </div>
      {(tab === 'user' || tab === 'public') && <Queue key={tab} source={tab} />}
      {tab === 'removal' && <Removals />}
      {tab === 'appeals' && <Appeals />}
      {tab === 'numbers' && <Numbers />}
    </>
  )
}

function Queue({ source }: { source: 'user' | 'public' }) {
  const [status, setStatus] = useState<Report['status']>('open')
  const { data, error, reload } = useLoad(() => A.listReports(status, source), [status, source])
  return (
    <>
      <div className="admin-tabs" role="group" aria-label={t('Show reports')}>
        {(['open', 'resolved'] as const).map((s) => (
          <button key={s} className={cls('admin-tab', status === s && 'on')} aria-pressed={status === s} onClick={() => setStatus(s)}>{s === 'open' ? t('Open') : t('Resolved')}</button>
        ))}
      </div>
      <FormError error={error} />
      {data && data.length === 0 && <p className="hint">{status === 'open' ? t('No open reports. Nice.') : t('No resolved reports yet.')}</p>}
      <ul className="admin-reports">{data?.map((r) => (r.source === 'public' ? <NoticeCard key={r.id} r={r} onDone={() => void reload()} /> : <ReportCard key={r.id} r={r} onDone={() => void reload()} />))}</ul>
    </>
  )
}

const History = ({ r }: { r: Report }) => (
  <ul className="admin-list hint small">{r.actions.map((a, i) => <li key={i}>{t(RESOLUTION[a.action] ?? a.action)} · {when(a.at)}{a.note && ` · ${a.note}`}</li>)}</ul>
)

function ReportCard({ r, onDone }: { r: Report; onDone: () => void }) {
  const author = r.author
  const who = author ? author.global_name || author.username : t('the author')
  const where = r.guild ? `${r.guild.name} › #${r.channel.name ?? r.channel.id}` : t('Direct message')
  const m = r.message
  const act = (action: ReportAction, extra: { duration_seconds?: number } = {}) => {
    if (action === 'dismiss') return void A.resolveReport(r.id, action).then(() => (toast(t('Report resolved: {what}.', { what: t(RESOLUTION[action]) })), onDone()), toastError)
    // every action against the author carries a statement of reasons (DSA Art. 17)
    void askReasons(t(RESOLUTION[action]), t('Confirm'), undefined, r.reason).then((why) => why &&
      A.resolveReport(r.id, action, { ...extra, ...why }).then(() => (toast(t('Report resolved: {what}.', { what: t(RESOLUTION[action]) })), onDone()), toastError))
  }
  const confirm = (action: ReportAction, title: string, body: string, label: string) =>
    void ask({ title, body: <p>{body}</p>, confirm: label, danger: true }).then((ok) => void (ok && act(action)))
  const timeout = () => void askText({ title: t('Timeout {name}', { name: who }), label: t('Minutes (1 to 40320)'), initial: '60', confirm: t('Timeout'), danger: true })
    .then((v) => {
      if (v === null) return
      const min = Math.round(Number(v))
      if (!(min >= 1 && min <= 40320)) return toast(t('Enter a number of minutes between 1 and 40320.'))
      act('timeout', { duration_seconds: min * 60 })
    })
  const open = r.status === 'open'
  return (
    <li className="admin-card admin-report">
      <header>
        <strong>{reasonLabel(r.reason)}</strong>
        <span className="hint small">{r.reporter && t('Reported by {name}', { name: r.reporter.username })} · <time dateTime={r.created_at}>{when(r.created_at)}</time></span>
      </header>
      {r.note && <p className="admin-note"><span className="sr-only">{t('Note')}: </span>“{r.note}”</p>}
      {m && (
        <figure className="admin-quote">
          <figcaption>{author?.username ?? t('Unknown')} · {where} · <time dateTime={m.timestamp}>{when(m.timestamp)}</time>{!m.exists && ` · ${t('deleted since')}`}</figcaption>
          {m.encrypted && <p className="hint small">{m.revealed ? t('Encrypted message, decrypted from the report') : t('Encrypted message, not revealed by the reporter')}</p>}
          {m.context?.map((c) => (
            <div key={c.id} className="admin-context">
              <p className="hint small">{c.author_name ?? t('Unknown')} · <time dateTime={c.timestamp}>{when(c.timestamp)}</time> · {t('before the reported message')}</p>
              <blockquote>{c.content || <em>{t('No text')}</em>}</blockquote>
              <Files list={c.attachments} />
            </div>
          ))}
          {/* Plain text on purpose: reported content is untrusted. */}
          <blockquote>{m.content || <em>{t('No text')}</em>}</blockquote>
          {m.revealed ? <Files list={m.attachments ?? []} /> : !!m.attachments?.length && <p className="hint small">{t('Attachments')}: {m.attachments.map((a) => a.filename).join(', ')}</p>}
        </figure>
      )}
      {m?.exists && r.link && <Link className="link" to={r.link}>{t('Open in context')}</Link>}
      {open ? (
        <div className="admin-actions" role="group" aria-label={t('Report actions')}>
          <button className="secondary admin-btn" onClick={() => act('dismiss')}>{t('Dismiss')}</button>
          {m?.exists && <button className="danger-btn" onClick={() => confirm('delete_message', t('Delete this message?'), t('The message is deleted for everyone.'), t('Delete Message'))}>{t('Delete Message')}</button>}
          {r.guild && author && (
            <>
              <button className="danger-btn" onClick={timeout}>{t('Timeout Author')}</button>
              <button className="danger-btn" onClick={() => confirm('kick', t('Kick {name}?', { name: who }), t('{name} is removed from {server} and can rejoin with an invite.', { name: who, server: r.guild?.name ?? '' }), t('Kick'))}>{t('Kick Author')}</button>
              <button className="danger-btn" onClick={() => confirm('ban', t('Ban {name}?', { name: who }), t('{name} is banned from {server}.', { name: who, server: r.guild?.name ?? '' }), t('Ban'))}>{t('Ban Author')}</button>
            </>
          )}
          {author && !author.bot && <button className="danger-btn" onClick={() => confirm('disable_account', t('Disable {name}?', { name: who }), t('{name} can no longer log in anywhere on this instance and all their sessions are closed.', { name: who }), t('Disable Account'))}>{t('Disable Account')}</button>}
        </div>
      ) : <History r={r} />}
    </li>
  )
}

/** Files of a revealed encrypted message: the key came with the report, so they are decrypted here, in the browser. */
function Files({ list }: { list: A.RevealedFile[] }) {
  const [open, setOpen] = useState<Record<number, { url: string; image: boolean } | 'error'>>({})
  const urls = useRef<string[]>([])
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), [])
  if (!list.length) return null
  const decrypt = (i: number, f: A.RevealedFile) =>
    void decryptDownload(cdn(f.url!), { k: f.key!, n: f.iv!, type: f.content_type ?? '' }).then(
      (b) => {
        const url = URL.createObjectURL(b)
        urls.current.push(url)
        setOpen((o) => ({ ...o, [i]: { url, image: b.type.startsWith('image/') } }))
      },
      () => setOpen((o) => ({ ...o, [i]: 'error' })),
    )
  return (
    <ul className="admin-list hint small">
      {list.map((f, i) => {
        const o = open[i]
        return (
          <li key={i}>
            {f.filename} ({f.content_type || t('unknown type')}){' '}
            {!f.url || !f.key ? t('(file gone)') : o === 'error' ? t('Cannot decrypt this file.') : o ? (
              o.image ? <img src={o.url} alt={f.filename} style={{ maxWidth: 240, display: 'block' }} /> : <a href={o.url} download={f.filename}>{t('Download')}</a>
            ) : <button className="link" onClick={() => decrypt(i, f)}>{t('Decrypt and show')}</button>}
          </li>
        )
      })}
    </ul>
  )
}

/** A notice from the public form: what and why, who sent it; the decision text goes back to the notifier. */
function NoticeCard({ r, onDone }: { r: Report; onDone: () => void }) {
  const n = r.notice!
  const [removeUrl, setRemoveUrl] = useState<string | null>(null)
  const decide = (action: 'dismiss' | 'action_taken') => void askText({
    title: action === 'dismiss' ? t('No action') : t('Action taken'), label: t('Decision for the notifier'), multiline: true, maxLength: 2000, confirm: t('Send decision'),
    body: <p>{t('The notifier gets this text by mail (if they left an address) and on their status page.')}</p>,
  }).then((note) => void (note && A.resolveReport(r.id, action, { note }).then(() => (toast(t('Decision sent.')), onDone()), toastError)))
  return (
    <li className="admin-card admin-report">
      <header>
        <strong>{noticeLabel(r.reason)}</strong>
        <span className="hint small">{n.name ? `${n.name} <${n.email ?? '—'}>` : t('Anonymous')} · <time dateTime={r.created_at}>{when(r.created_at)}</time> · {r.id}</span>
      </header>
      {n.url && <p className="admin-note">{t('Link')}: <code>{n.url}</code>{n.link_kind && ` (${n.link_kind})`}</p>}
      {n.description && <p className="admin-note">{n.description}</p>}
      <figure className="admin-quote"><figcaption>{t('Why it is illegal, according to the notifier')}</figcaption><blockquote>{r.note}</blockquote></figure>
      {r.status === 'open' ? (
        <div className="admin-actions" role="group" aria-label={t('Notice actions')}>
          {n.url && <button className="danger-btn" onClick={() => setRemoveUrl(n.url)}>{t('Remove by link…')}</button>}
          <button className="primary admin-btn" onClick={() => decide('action_taken')}>{t('Action taken')}</button>
          <button className="secondary admin-btn" onClick={() => decide('dismiss')}>{t('No action')}</button>
        </div>
      ) : <><History r={r} />{n.decision && <p className="admin-note">{n.decision}</p>}</>}
      {removeUrl && <RemoveForm initial={removeUrl} onDone={() => setRemoveUrl(null)} />}
    </li>
  )
}

/** Paste a link → see the item → remove it and keep a copy for 6 months (TCO Art. 6), audit-logged. */
function RemoveForm({ initial = '', onDone }: { initial?: string; onDone?: () => void }) {
  const [url, setUrl] = useState(initial)
  const [item, setItem] = useState<A.RemovalPreview | null>(null)
  const [error, setError] = useState('')
  const show = (e: FormEvent) => (e.preventDefault(), setError(''), setItem(null), void A.previewRemoval(url.trim()).then(setItem, (err: Error) => setError(err.message)))
  const remove = () => void askReasons(item!.type === 'server' ? t('Remove this server?') : t('Remove this message?'), t('Remove and preserve'),
    <p>{t('It disappears at once. A copy stays for 6 months, readable only by instance administrators, then it is deleted.')}</p>, 'illegal')
    .then((why) => why && A.elevated((mfa) => A.removeByLink(url.trim(), why, mfa), () => askCode(t('Remove and preserve'), <p>{t('Confirm with your own two-factor code.')}</p>, t('Remove')))
      .then((r) => r && (toast(t('Removed. The copy is kept until {date}.', { date: when(r.preserve_until) })), setItem(null), setUrl(''), onDone?.()), toastError))
  return (
    <div className="admin-card">
      <form className="admin-inline legal-remove" onSubmit={show}>
        <Field label={t('Link to a message, attachment or server')} value={url} maxLength={500} placeholder="https://…/channels/…" onChange={(e) => setUrl(e.target.value)} />
        <button className="secondary admin-btn" disabled={!url.trim()}>{t('Show')}</button>
      </form>
      <FormError error={error} />
      {item && (
        <figure className="admin-quote">
          <figcaption>
            {item.type === 'message' ? `${item.author?.username ?? t('Unknown')} · ${item.guild.name} › #${item.channel?.name} · ${when(item.timestamp)}` : `${t('Server')} ${item.guild.name} · ${t('Owner')}: ${item.owner?.username ?? '—'} · ${item.member_count}`}
          </figcaption>
          {item.type === 'message' && <blockquote>{item.content || <em>{t('No text')}</em>}</blockquote>}
          {!!item.attachments?.length && <p className="hint small">{t('Attachments')}: {item.attachments.map((a) => a.filename).join(', ')}</p>}
          <div className="admin-actions"><button className="danger-btn" onClick={remove}>{t('Remove and preserve')}</button></div>
        </figure>
      )}
    </div>
  )
}

function Removals() {
  const { data, error, reload } = useLoad(() => A.listReports('all', 'removal'), [])
  return (
    <>
      <p className="hint">{t('For removal orders (one hour) and other illegal content you were told about. Direct messages can only be acted on through a participant’s report.')}</p>
      <RemoveForm onDone={() => void reload()} />
      <FormError error={error} />
      <h2>{t('Preserved copies')}</h2>
      {data && data.length === 0 && <p className="hint">{t('Nothing removed by link.')}</p>}
      <ul className="admin-reports">{data?.map((r) => (
        <li key={r.id} className="admin-card admin-report">
          <header><strong>{categoryLabel(r.reason)}</strong><span className="hint small">{when(r.created_at)} · {t('kept until {date}', { date: when(r.preserve_until) })}</span></header>
          <p className="admin-note">{r.note}</p>
          {r.message && (
            <figure className="admin-quote">
              <figcaption>{r.server ? `${t('Server')} ${r.server.name}` : `${r.author?.username ?? t('Unknown')} · ${r.guild?.name ?? ''}`}</figcaption>
              {!r.server && <blockquote>{r.message.content || <em>{t('No text')}</em>}</blockquote>}
              {!!r.message.attachments?.length && <p className="hint small">{t('Attachments')}: {r.message.attachments.map((a) => a.filename).join(', ')}</p>}
            </figure>
          )}
        </li>
      ))}</ul>
    </>
  )
}

function Appeals() {
  const [status, setStatus] = useState<'open' | 'decided'>('open')
  const { data, error, reload } = useLoad(() => A.listAppeals(status), [status])
  const decide = (d: A.AdminDecision, outcome: 'upheld' | 'reversed') => void askText({
    title: outcome === 'reversed' ? t('Reverse the decision') : t('Keep the decision'), label: t('Answer to the user'), multiline: true, maxLength: 2000, confirm: t('Send'),
    body: d.action === 'disable_account' && outcome === 'reversed' ? <p>{t('The account is enabled again.')}</p> : undefined,
  }).then((text) => void (text && A.decideAppeal(d.id, outcome, text).then(() => (toast(t('Decision sent.')), void reload()), toastError)))
  return (
    <>
      <div className="admin-tabs" role="group" aria-label={t('Show appeals')}>
        {(['open', 'decided'] as const).map((s) => <button key={s} className={cls('admin-tab', status === s && 'on')} aria-pressed={status === s} onClick={() => setStatus(s)}>{s === 'open' ? t('Open') : t('Decided')}</button>)}
      </div>
      <FormError error={error} />
      {data && data.length === 0 && <p className="hint">{t('No appeals.')}</p>}
      <ul className="admin-reports">{data?.map((d) => (
        <li key={d.id} className="admin-card admin-report">
          <header><strong>{t(ACTION_LABEL[d.action] ?? d.action)}</strong><span className="hint small">{[d.user?.username ?? t('Unknown'), d.target.name, groundLabel(d.ground)].filter(Boolean).join(' · ')}</span></header>
          <DecisionView d={d} />
          <figure className="admin-quote"><figcaption>{t('Appeal of {date}', { date: when(d.appeal?.at) })}</figcaption><blockquote>{d.appeal?.text}</blockquote></figure>
          {d.appeal?.status === 'open' ? (
            <div className="admin-actions">
              <button className="primary admin-btn" onClick={() => decide(d, 'reversed')}>{t('Reverse')}</button>
              <button className="secondary admin-btn" onClick={() => decide(d, 'upheld')}>{t('Keep')}</button>
            </div>
          ) : <p className="admin-note">{d.appeal?.status === 'reversed' ? t('Reversed') : t('Kept')}: {d.appeal?.decision}</p>}
        </li>
      ))}</ul>
    </>
  )
}

function Numbers() {
  const [year, setYear] = useState(new Date().getFullYear())
  const { data, error } = useLoad(() => A.reportStats(year), [year])
  const list = (o: Record<string, number>, label: (k: string) => string) => Object.entries(o).map(([k, n]) => <li key={k}>{label(k)}: <strong>{n}</strong></li>)
  return (
    <>
      <p className="hint">{t('Counts for a yearly transparency report. Nothing here is public.')}</p>
      <Field label={t('Year')} type="number" min={2020} max={2100} value={year} onChange={(e) => setYear(+e.target.value)} />
      <FormError error={error} />
      {data && (
        <div className="admin-stats">
          <section><h3>{t('Notices received')}</h3><ul className="admin-list">{list(data.notices.by_source, (k) => t({ user: 'In-app reports', public: 'Public notices', directory: 'Directory reports' }[k] ?? k))}</ul></section>
          <section><h3>{t('By category')}</h3><ul className="admin-list">{list(data.notices.by_category, (k) => (noticeLabel(k) !== k ? noticeLabel(k) : reasonLabel(k)))}</ul></section>
          <section><h3>{t('Actions taken')}</h3><ul className="admin-list">{list(data.actions, (k) => t(ACTION_LABEL[k] ?? k))}<li>{t('Removed by link')}: <strong>{data.removals_by_link}</strong></li></ul></section>
          <section><h3>{t('Appeals')}</h3><ul className="admin-list">{list(data.appeals, (k) => t({ open: 'Open', upheld: 'Kept', reversed: 'Reversed' }[k] ?? k))}</ul></section>
          <section><h3>{t('Median handling time')}</h3><p><strong>{data.median_handling_hours ?? '—'}</strong> {t('hours')}</p></section>
        </div>
      )}
    </>
  )
}
