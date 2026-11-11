// Admin → Instance Settings → Legal: the operator's own details, the minimum age, the source URL and the three documents
// (Markdown per language, every save of a changed text is a new version). Nothing here comes from a hub.
import { useEffect, useState, type FormEvent } from 'react'
import { ask, toast, toastError } from '../components/dialogs'
import { Field, FormError } from '../components/ui'
import { t } from '../i18n'
import { Link } from '../router'
import * as A from './api'
import { getAdminLegal, putDoc, type AdminLegal, type LegalDocId, type Operator } from '../legal/api'
import { DOC_PATH, DOC_TITLE } from '../legal/LegalPages'
import { template } from '../legal/templates'
import { useLoad, when } from './util'

const FIELDS: [keyof Operator, string, string?][] = [
  ['name', 'Name (person or organisation)'], ['legal_form', 'Legal form', 'e.g. private person, Verein, GmbH'], ['address', 'Postal address'],
  ['email', 'Contact email (users and authorities)'], ['phone', 'Phone (optional)'], ['register', 'Register number (optional)', 'e.g. ZVR or company register number and court'],
  ['representatives', 'Representatives (optional)'], ['purpose', 'Purpose / editorial line (optional)'], ['authority', 'Supervisory authority (optional)'],
  ['languages', 'Languages for contact', 'e.g. German, English'],
]
const DOCS: LegalDocId[] = ['imprint', 'privacy', 'terms']

export function LegalSettings() {
  const settings = useLoad(A.getSettings, [])
  const legal = useLoad(getAdminLegal, [])
  const [op, setOp] = useState<Operator>({})
  const [minAge, setMinAge] = useState(14)
  const [source, setSource] = useState('')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    const s = settings.data
    if (s) (setOp(s.legal_operator ?? {}), setMinAge(s.min_age ?? 14), setSource(s.source_url ?? ''))
  }, [settings.data])
  if (settings.error || legal.error) return <FormError error={settings.error || legal.error} />
  if (!settings.data || !legal.data) return <p className="hint" aria-busy="true">{t('Loading…')}</p>
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError('')
    A.saveSettings({ legal_operator: op, min_age: minAge, source_url: source.trim() || null })
      .then(() => (setSaved(true), settings.reload()), (err: Error) => setError(err.message))
  }
  return (
    <section className="admin-card" aria-labelledby="legal-h">
      <h2 id="legal-h">{t('Legal')}</h2>
      <p className="hint small">{t('The templates are a starting point built from these fields and the features this server has switched on; check them and fill in the parts in [brackets] before you publish.')}</p>
      <form className="admin-form" onSubmit={submit}>
        <fieldset className="admin-reasons">
          <legend>{t('Operator')}</legend>
          {FIELDS.map(([k, label, hint]) => (k === 'address' || k === 'representatives') ? (
            <div className="field" key={k}>
              <label htmlFor={`op-${k}`}>{t(label)}</label>
              <textarea id={`op-${k}`} className="input textarea" maxLength={500} value={op[k] ?? ''} onChange={(e) => (setOp({ ...op, [k]: e.target.value }), setSaved(false))} />
            </div>
          ) : (
            <Field key={k} label={t(label)} value={op[k] ?? ''} maxLength={k === 'email' ? 254 : 200} type={k === 'email' ? 'email' : 'text'} placeholder={hint && t(hint)}
              onChange={(e) => (setOp({ ...op, [k]: e.target.value }), setSaved(false))} />
          ))}
        </fieldset>
        <div className="admin-inline">
          <Field label={t('Minimum age at sign-up')} type="number" min={13} max={18} required value={minAge} onChange={(e) => (setMinAge(Math.min(18, Math.max(13, +e.target.value))), setSaved(false))} />
          <Field label={t('Source code URL')} type="url" maxLength={300} value={source} onChange={(e) => (setSource(e.target.value), setSaved(false))} />
        </div>
        <p className="hint small">{t('If you run a modified version, the source URL must point to your changed code (AGPL-3.0 §13).')}</p>
        <FormError error={error} />
        <div className="save-bar">
          {saved && <span className="success" role="status">{t('Saved.')}</span>}
          <button className="primary admin-btn">{t('Save operator details')}</button>
        </div>
      </form>
      {DOCS.map((d) => <DocEditor key={d} doc={d} data={legal.data!} op={op} onSaved={() => void legal.reload()} />)}
    </section>
  )
}

function DocEditor({ doc, data, op, onSaved }: { doc: LegalDocId; data: AdminLegal; op: Operator; onSaved: () => void }) {
  const cur = data.documents[doc]
  const [en, setEn] = useState(cur?.en ?? '')
  const [de, setDe] = useState(cur?.de ?? '')
  const [reaccept, setReaccept] = useState(false)
  const [busy, setBusy] = useState(false)
  const versions = data.versions.filter((v) => v.doc === doc)
  const insert = () => {
    const fill = () => (setEn(template(doc, op, data.features, 'en')), setDe(template(doc, op, data.features, 'de')))
    if (!en.trim() && !de.trim()) return fill()
    void ask({ title: t('Replace the text?'), body: <p>{t('The template replaces both languages of this document in the editor. Nothing is saved until you save.')}</p>, confirm: t('Insert template') }).then((ok) => ok && fill())
  }
  const save = () => {
    setBusy(true)
    putDoc(doc, { en, de, reaccept }).then((r) => (toast(r.created ? t('Saved as version {v}.', { v: r.version ?? '' }) : t('No changes.')), setReaccept(false), onSaved()), toastError).finally(() => setBusy(false))
  }
  return (
    <fieldset className="admin-reasons legal-doc-editor">
      <legend>{t(DOC_TITLE[doc])}</legend>
      <div className="admin-inline">
        <button type="button" className="admin-btn secondary" onClick={insert}>{t('Insert template')}</button>
        <Link to={DOC_PATH[doc]} className="link">{t('Open page')}</Link>
        {cur && <span className="hint small">{t('Version {v} of {date}', { v: cur.version ?? '', date: when(cur.updated_at) })}</span>}
      </div>
      <div className="field">
        <label htmlFor={`doc-${doc}-en`}>{t('English (Markdown)')}</label>
        <textarea id={`doc-${doc}-en`} className="input textarea legal-editor" maxLength={100000} value={en} onChange={(e) => setEn(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor={`doc-${doc}-de`}>{t('German (Markdown)')}</label>
        <textarea id={`doc-${doc}-de`} className="input textarea legal-editor" maxLength={100000} value={de} onChange={(e) => setDe(e.target.value)} />
      </div>
      {doc !== 'imprint' && (
        <label className="admin-check"><input type="checkbox" checked={reaccept} onChange={(e) => setReaccept(e.target.checked)} /> {t('Require re-acceptance: existing users must accept this version before they can continue')}</label>
      )}
      <div className="save-bar"><button type="button" className="primary admin-btn" disabled={busy} onClick={save}>{t('Save {doc}', { doc: t(DOC_TITLE[doc]) })}</button></div>
      {versions.length > 0 && (
        <details>
          <summary className="hint small">{t('{n} versions', { n: versions.length })}</summary>
          <ul className="admin-list hint small">{versions.map((v) => <li key={v.id}>v{v.id} · {when(v.created_at)} · <code>{v.hash.slice(0, 12)}</code>{v.reaccept && ` · ${t('re-acceptance required')}`}</li>)}</ul>
        </details>
      )}
    </fieldset>
  )
}
