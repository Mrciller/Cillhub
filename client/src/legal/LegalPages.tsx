// 7.10.3 legal pages that work without a session: imprint, privacy notice, terms, licences, the public notice form for
// illegal content (DSA Art. 16) with its status page, and the appeal page (Art. 20). Plus the footer links and the
// blocking "accept the new terms" dialog for signed-in accounts.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { ApiError } from '../api'
import { Captcha } from '../components/Captcha'
import { Field, FormError, Modal } from '../components/ui'
import { getLocale, intlLocale, t } from '../i18n'
import { Markdown, type MdContext } from '../markdown/Markdown'
import { Link } from '../router'
import { useStore } from '../store'
import { useInstance } from '../admin/instance'
import { logout } from '../gateway'
import * as L from './api'
import type { LegalDocId, NoticeCategory } from './api'
import './legal.css'

const NO_CTX: MdContext = { user: () => undefined, role: () => undefined, channel: () => undefined }
const lang = () => (getLocale() === 'de' ? 'de' : 'en') as 'de' | 'en'
const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(intlLocale(), { dateStyle: 'long' }) : '')
export const DOC_TITLE: Record<LegalDocId, string> = { imprint: 'Imprint', privacy: 'Privacy notice', terms: 'Terms of use' }
export const DOC_PATH: Record<LegalDocId, string> = { imprint: '/imprint', privacy: '/privacy', terms: '/terms' }

/** "Imprint · Privacy · Terms · Report content · Source code" under every logged-out page and in About. */
export function LegalLinks({ className = 'legal-links' }: { className?: string }) {
  const src = useInstance()?.legal?.source_url
  return (
    <nav className={className} aria-label={t('Legal')}>
      <Link to="/imprint">{t('Imprint')}</Link>
      <Link to="/privacy">{t('Privacy')}</Link>
      <Link to="/terms">{t('Terms')}</Link>
      <Link to="/report-content">{t('Report illegal content')}</Link>
      {src && <a href={src} target="_blank" rel="noopener noreferrer">{t('Source code')}</a>}
    </nav>
  )
}

function Page({ title, children }: { title: string; children: ReactNode }) {
  const token = useStore((s) => s.token)
  const name = useInstance()?.name || 'Cillhub'
  useEffect(() => void (document.title = `${title} · ${name}`), [title, name])
  return (
    <div className="legal-bg">
      <main className="legal-card" aria-labelledby="legal-h1">
        <p className="auth-brand" aria-hidden="true">{name}</p>
        <h1 id="legal-h1">{title}</h1>
        {children}
        <p className="legal-back"><Link to={token ? '/channels/@me' : '/login'}>{token ? t('Back to Cillhub') : t('Go back to login')}</Link></p>
      </main>
      <LegalLinks />
    </div>
  )
}

/** The DSA Art. 11/12 single point of contact, from the operator settings. */
function ContactBlock() {
  const legal = useInstance()?.legal
  if (!legal?.contact_email) return null
  return (
    <section className="legal-contact" aria-labelledby="contact-h">
      <h2 id="contact-h">{t('Contact for users and authorities (DSA Art. 11/12)')}</h2>
      <p><a href={`mailto:${legal.contact_email}`}>{legal.contact_email}</a></p>
      {legal.contact_languages && <p className="hint">{t('Languages: {list}', { list: legal.contact_languages })}</p>}
    </section>
  )
}

export function LegalDocPage({ doc }: { doc: LegalDocId }) {
  const [d, setD] = useState<L.LegalDoc | null>(null)
  const [error, setError] = useState('')
  useEffect(() => void L.getDoc(doc).then(setD, (e: Error) => setError(e.message)), [doc])
  const text = d && L.pick(d, lang())
  return (
    <Page title={t(DOC_TITLE[doc])}>
      <FormError error={error} />
      {d && (text ? (
        <>
          <article className="legal-text"><Markdown content={text} ctx={NO_CTX} /></article>
          <p className="hint small">{t('Version {v} of {date}', { v: d.version ?? '', date: date(d.updated_at) })}</p>
        </>
      ) : <p className="legal-missing" role="note">{t('The operator of this server has not provided this page yet.')}</p>)}
      {doc === 'imprint' && <ContactBlock />}
    </Page>
  )
}

export function LicensesPage() {
  const [d, setD] = useState<Awaited<ReturnType<typeof L.getLicenses>> | null>(null)
  useEffect(() => void L.getLicenses().then(setD, () => setD({ license: null, notice: null, source_url: null })), [])
  return (
    <Page title={t('Licences')}>
      <p>{t('Cillhub is free software under the GNU Affero General Public License, version 3. You can get the source code of this server here:')}{' '}
        {d?.source_url && <a href={d.source_url} target="_blank" rel="noopener noreferrer">{d.source_url}</a>}</p>
      {d?.notice && <><h2>{t('Notices and third-party components')}</h2><pre className="legal-pre">{d.notice}</pre></>}
      {d?.license && <details><summary>{t('Full licence text')}</summary><pre className="legal-pre">{d.license}</pre></details>}
    </Page>
  )
}

// --- public notice form (DSA Art. 16) ------------------------------------------------------------------------------------
export const NOTICE_CATEGORIES: [NoticeCategory, string][] = [
  ['child_abuse', 'Child sexual abuse material'], ['terrorism', 'Terrorist content'], ['hate_speech', 'Illegal hate speech or incitement'],
  ['violence', 'Threats or calls for violence'], ['privacy', 'Privacy violation (e.g. images shared without consent)'],
  ['intellectual_property', 'Copyright or trademark infringement'], ['fraud', 'Fraud or scam'], ['other_illegal', 'Other illegal content'],
]
export const noticeLabel = (c: string) => t(NOTICE_CATEGORIES.find(([k]) => k === c)?.[1] ?? c)
const ANONYMOUS_OK: NoticeCategory[] = ['child_abuse']

export function ReportContentPage() {
  const instance = useInstance()
  const [category, setCategory] = useState<NoticeCategory | ''>('')
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [captchaKey, setCaptchaKey] = useState('')
  const [round, setRound] = useState(0)
  const [done, setDone] = useState<{ id: string; code: string; mailed: boolean } | null>(null)
  const anonymous = !!category && ANONYMOUS_OK.includes(category)
  const sitekey = instance?.captcha?.sitekey
  const field = (n: string) => error?.errors[n]?._errors?.[0]?.message
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
    setBusy(true)
    setError(null)
    L.sendNotice({
      category, url: f.url.trim() || null, description: f.description.trim() || null, explanation: f.explanation, name: f.name.trim() || null,
      email: f.email.trim() || null, good_faith: f.good_faith === 'on', ...(captchaKey && { captcha_key: captchaKey }),
    }).then((r) => setDone({ id: r.id, code: r.code, mailed: r.receipt_mailed }), (err) => {
      setError(err instanceof ApiError ? err : new ApiError(0, null))
      setBusy(false)
      setCaptchaKey('')
      setRound((n) => n + 1)
    })
  }
  if (done)
    return (
      <Page title={t('Notice received')}>
        <p role="status">{t('Thank you. The administrators will review your notice and decide on it.')}</p>
        <p>{t('Your reference code:')} <code className="legal-code">{done.code}</code></p>
        <p className="hint">{done.mailed ? t('A confirmation is on its way to your email address; the decision follows there.') : t('Keep this code: it is the only way to see the decision on your notice.')}</p>
        <p><Link to={`/report-content/status#${done.code}`}>{t('Open the status page')}</Link></p>
      </Page>
    )
  const message = error && Object.keys(error.errors).length === 0 ? error.message : ''
  return (
    <Page title={t('Report illegal content')}>
      <p className="sub">{t('Anyone can tell the operator of this server about content they believe is illegal, also without an account. For rule breaks that are not illegal, use "Report" in the app.')}</p>
      <form className="legal-form" onSubmit={submit}>
        <div className={`field${field('category') ? ' invalid' : ''}`}>
          <label htmlFor="notice-category">{t('Kind of illegal content')}</label>
          <select id="notice-category" className="input" required value={category} onChange={(e) => setCategory(e.target.value as NoticeCategory)}>
            <option value="" disabled>{t('Choose…')}</option>
            {NOTICE_CATEGORIES.map(([k, label]) => <option key={k} value={k}>{t(label)}</option>)}
          </select>
        </div>
        <Field label={t('Link to the message, file or server')} name="url" type="text" maxLength={500} placeholder="https://…/channels/…" error={field('url')} />
        <div className="field">
          <label htmlFor="notice-description">{t('Or describe where it is')}</label>
          <textarea id="notice-description" name="description" className="input textarea" maxLength={2000} />
        </div>
        <div className={`field${field('explanation') ? ' invalid' : ''}`}>
          <label htmlFor="notice-explanation">{t('Why is it illegal?')} {field('explanation') && <span className="field-error">- {field('explanation')}</span>}</label>
          <textarea id="notice-explanation" name="explanation" className="input textarea" required minLength={10} maxLength={5000} />
        </div>
        <Field label={anonymous ? t('Your name (optional)') : t('Your name')} name="name" maxLength={100} required={!anonymous} autoComplete="name" error={field('name')} />
        <Field label={anonymous ? t('Your email (optional)') : t('Your email')} name="email" type="email" maxLength={254} required={!anonymous} autoComplete="email" error={field('email')} />
        {anonymous && <p className="hint small">{t('For child sexual abuse material you may stay anonymous.')}</p>}
        <label className="legal-check"><input type="checkbox" name="good_faith" required /> {t('I confirm in good faith that the information in this notice is accurate and complete.')}</label>
        {sitekey && <Captcha key={round} sitekey={sitekey} onToken={setCaptchaKey} />}
        <FormError error={message} />
        <button className="primary wide" disabled={busy || (!!sitekey && !captchaKey)}>{t('Send notice')}</button>
        <p className="hint small">{t('What you enter here goes to the administrators of this server only. Read the privacy notice for how it is kept.')}</p>
      </form>
    </Page>
  )
}

const code = () => decodeURIComponent(location.hash.slice(1))

export function NoticeStatusPage() {
  const [s, setS] = useState<L.NoticeStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    const c = code()
    if (c) L.noticeStatus(c).then(setS, (e: Error) => setError(e.message))
    else setError(t('This link has no reference code.'))
  }, [])
  return (
    <Page title={t('Status of your notice')}>
      <FormError error={error} />
      {s && (
        <dl className="legal-dl">
          <dt>{t('Reference')}</dt><dd>{s.id}</dd>
          <dt>{t('Kind')}</dt><dd>{noticeLabel(s.category)}</dd>
          <dt>{t('Received')}</dt><dd>{date(s.created_at)}</dd>
          <dt>{t('Status')}</dt><dd><strong>{s.status === 'open' ? t('Under review') : t('Decided')}</strong>{s.resolved_at && ` · ${date(s.resolved_at)}`}</dd>
          {s.decision && <><dt>{t('Decision')}</dt><dd className="legal-decision">{s.decision}</dd></>}
        </dl>
      )}
    </Page>
  )
}

// --- statement of reasons and appeal (Art. 17, 20) -------------------------------------------------------------------------
export const ACTION_LABEL: Record<string, string> = {
  delete_message: 'A message was removed', remove_message: 'A message was removed', timeout: 'Timed out in a server', kick: 'Removed from a server',
  ban: 'Banned from a server', disable_account: 'Account disabled', remove_server: 'Server removed', delete_server: 'Server removed', hide_listing: 'Hidden from the server directory',
}
export const DECISION_CATEGORIES: [string, string][] = [
  ['spam', 'Spam or scam'], ['harassment', 'Harassment or bullying'], ['hate', 'Hateful content'], ['nsfw', 'Sexual or explicit content'],
  ['violence', 'Violence or threats'], ['self_harm', 'Self-harm'], ['illegal', 'Illegal content'], ['impersonation', 'Impersonation'], ['terrorism', 'Terrorist content'], ['other', 'Other'],
]
export const categoryLabel = (c: string) => t(DECISION_CATEGORIES.find(([k]) => k === c)?.[1] ?? c)
export const groundLabel = (g: string) => (g === 'illegal' ? t('Illegal content') : t('Terms of use'))

/** The statement of reasons; on the appeal page and under a disabled account's login error. */
export function DecisionView({ d }: { d: Pick<L.Decision, 'action' | 'category' | 'ground' | 'reason' | 'created_at'> }) {
  return (
    <dl className="legal-dl">
      <dt>{t('Decision')}</dt><dd>{t(ACTION_LABEL[d.action] ?? d.action)}</dd>
      <dt>{t('Reason')}</dt><dd>{categoryLabel(d.category)}</dd>
      <dt>{t('Legal ground')}</dt><dd>{groundLabel(d.ground)}</dd>
      <dt>{t('Explanation')}</dt><dd className="legal-decision">{d.reason}</dd>
      <dt>{t('Date')}</dt><dd>{date(d.created_at)}</dd>
    </dl>
  )
}

export function AppealPage() {
  const [d, setD] = useState<L.Decision | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    const c = code()
    if (c) L.lookupAppeal(c).then(setD, (e: Error) => setError(e.message))
    else setError(t('This link has no reference code.'))
  }, [])
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    L.fileAppeal(code(), String(new FormData(e.currentTarget).get('text'))).then(setD, (err: Error) => setError(err.message)).finally(() => setBusy(false))
  }
  const open = d && !d.appeal && Date.now() < Date.parse(d.appeal_until)
  return (
    <Page title={t('Appeal a moderation decision')}>
      {d && <DecisionView d={d} />}
      {d?.appeal && (
        <section className="legal-contact" aria-labelledby="appeal-h">
          <h2 id="appeal-h">{t('Your appeal')}</h2>
          <p className="legal-decision">{d.appeal.text}</p>
          <p><strong>{d.appeal.status === 'open' ? t('Under review') : d.appeal.status === 'reversed' ? t('The decision was reversed.') : t('The decision stands.')}</strong></p>
          {d.appeal.decision && <p className="legal-decision">{d.appeal.decision}</p>}
        </section>
      )}
      {open && (
        <form className="legal-form" onSubmit={submit}>
          <p className="hint">{t('You can appeal once, until {date}. A person reviews it.', { date: date(d.appeal_until) })}</p>
          <div className="field">
            <label htmlFor="appeal-text">{t('Why should the decision be changed?')}</label>
            <textarea id="appeal-text" name="text" className="input textarea" required minLength={10} maxLength={4000} />
          </div>
          <button className="primary wide" disabled={busy}>{t('Send appeal')}</button>
        </form>
      )}
      {d && !d.appeal && !open && <p className="hint">{t('The time for an appeal has passed.')}</p>}
      <FormError error={error} />
    </Page>
  )
}

// --- the terms gate ------------------------------------------------------------------------------------------------------
/** Signed in and the operator asks to accept new terms (or this server never asked): accept or log out. */
export function LegalGate() {
  const token = useStore((s) => s.token)
  const version = useInstance()?.legal?.accept_version
  const [s, setS] = useState<L.LegalStatus | null>(null)
  const [error, setError] = useState('')
  useEffect(() => void (token ? L.legalStatus().then(setS, () => setS(null)) : setS(null)), [token, version])
  if (!s?.required) return null
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    L.acceptTerms(s.accept_version, s.needs_age ? true : undefined).then(setS, (err: Error) => setError(err.message))
  }
  return (
    <Modal title={s.needs_age ? t('Terms of this server') : t('Updated terms')} onClose={() => {}}>
      <form onSubmit={submit} className="legal-gate">
        {/* needs_age: a hub account on its first visit to a server with its own terms */}
        <p>{s.needs_age
          ? t('This server has its own terms of use and privacy notice. Read them and accept to continue, or log out.')
          : t('The operator of this server changed the terms of use or the privacy notice. Read them and accept to continue, or log out.')}</p>
        <p><a href="/terms" target="_blank" rel="noopener noreferrer">{t('Terms of use')}</a> · <a href="/privacy" target="_blank" rel="noopener noreferrer">{t('Privacy notice')}</a></p>
        {s.accept_version && <label className="legal-check"><input type="checkbox" required /> {t('I accept the terms of use and have read the privacy notice.')}</label>}
        {s.needs_age && <label className="legal-check"><input type="checkbox" required /> {t('I am at least {n} years old.', { n: s.min_age })}</label>}
        <FormError error={error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={() => logout()}>{t('Log Out')}</button>
          <button className="primary">{t('Accept')}</button>
        </div>
      </form>
    </Modal>
  )
}

/** The sign-up checkboxes; the server checks the same (age always, terms once published). */
export function SignUpChecks() {
  const legal = useInstance()?.legal
  return (
    <div className="legal-signup">
      {legal?.accept_version != null && (
        <label className="legal-check">
          <input type="checkbox" name="terms_accepted" required />{' '}
          <span>{t('I accept the')} <a href="/terms" target="_blank" rel="noopener noreferrer">{t('Terms of use')}</a> {t('and have read the')} <a href="/privacy" target="_blank" rel="noopener noreferrer">{t('Privacy notice')}</a>.</span>
        </label>
      )}
      <label className="legal-check"><input type="checkbox" name="age_confirmed" required /> {t('I am at least {n} years old.', { n: legal?.min_age ?? 14 })}</label>
    </div>
  )
}
