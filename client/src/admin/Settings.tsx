// Instance settings (registration mode, name, message of the day, upload limit, GIFs, default voice backend) and the
// registration codes used while registration is invite-only.
import { useEffect, useState, type FormEvent } from 'react'
import { ask, toast, toastError } from '../components/dialogs'
import { Field, FormError } from '../components/ui'
import { t } from '../i18n'
import * as A from './api'
import type { InstanceSettings, Registration } from './api'
import { useLoad, when } from './util'

const MB = 1024 * 1024
const MODES: [Registration, string, string][] = [
  ['open', 'Open', 'Anyone can create an account.'],
  ['invite', 'Invite-only', 'New accounts need a registration code issued here.'],
  ['closed', 'Closed', 'Nobody can create an account.'],
]

export function InstanceSettingsPage() {
  const { data, error } = useLoad(A.getSettings, [])
  const [form, setForm] = useState<InstanceSettings | null>(null)
  const [saveError, setSaveError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => void (data && setForm(data)), [data])
  if (error) return <FormError error={error} />
  if (!form) return <p className="hint" aria-busy="true">{t('Loading…')}</p>
  const backends = form.voice.configured
  const set = (patch: Partial<InstanceSettings>) => (setForm({ ...form, ...patch }), setSaved(false))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setSaveError('')
    const { instance_name, motd, registration_mode, max_upload_bytes, gifs_enabled, voice_backend } = form
    A.saveSettings({ instance_name: instance_name.trim(), motd: motd?.trim() || null, registration_mode, max_upload_bytes, gifs_enabled, voice_backend })
      .then((s) => (setForm(s), setSaved(true)), (err: Error) => setSaveError(err.message))
  }
  return (
    <>
      <form className="admin-form" onSubmit={submit}>
        <fieldset className="admin-reasons">
          <legend>{t('Registration')}</legend>
          {MODES.map(([k, label, hint]) => (
            <div key={k} className="admin-radio">
              <input id={`reg-${k}`} type="radio" name="registration" checked={form.registration_mode === k} onChange={() => set({ registration_mode: k })} aria-describedby={`reg-${k}-hint`} />
              <label htmlFor={`reg-${k}`}><strong>{t(label)}</strong></label> <span id={`reg-${k}-hint`} className="hint small">{t(hint)}</span>
            </div>
          ))}
        </fieldset>
        <Field label={t('Instance name')} value={form.instance_name} required maxLength={64} onChange={(e) => set({ instance_name: e.target.value })} />
        <div className="field">
          <label htmlFor="admin-motd">{t('Message of the day')}</label>
          <textarea id="admin-motd" className="input textarea" maxLength={500} value={form.motd ?? ''} onChange={(e) => set({ motd: e.target.value })} aria-describedby="admin-motd-hint" />
          <p id="admin-motd-hint" className="hint small">{t('Shown on the login page and as a banner in the app. Leave empty for none.')}</p>
        </div>
        <Field label={t('Maximum upload size (MB)')} type="number" min={1} max={100} required value={Math.round(form.max_upload_bytes / MB)} onChange={(e) => set({ max_upload_bytes: Math.min(100, Math.max(1, +e.target.value)) * MB })} />
        <label className="admin-check"><input type="checkbox" checked={form.gifs_enabled} onChange={(e) => set({ gifs_enabled: e.target.checked })} /> {t('Enable the GIF picker')}</label>
        <div className="field">
          <label htmlFor="admin-voice">{t('Voice backend for new calls')}</label>
          <select id="admin-voice" className="input" value={form.voice_backend ?? ''} onChange={(e) => set({ voice_backend: (e.target.value || null) as InstanceSettings['voice_backend'] })}>
            <option value="">{t('Server default ({name})', { name: form.voice.default ?? t('none') })}</option>
            {backends.includes('livekit') && <option value="livekit">LiveKit</option>}
            {backends.includes('cillvoice') && <option value="cillvoice">cillvoice</option>}
          </select>
        </div>
        <FormError error={saveError} />
        <div className="save-bar">
          {saved && <span className="success" role="status">{t('Saved.')}</span>}
          <button className="primary admin-btn">{t('Save Changes')}</button>
        </div>
      </form>
      {(form.registration_mode === 'invite' || data?.registration_mode === 'invite') && <Codes />}
    </>
  )
}

function Codes() {
  const { data, error, reload } = useLoad(A.listCodes, [])
  const [uses, setUses] = useState(1)
  const [days, setDays] = useState(7)
  const create = (e: FormEvent) => {
    e.preventDefault()
    A.createCode(uses, days * 86400).then((c) => (toast(t('Code {code} created.', { code: c.code })), reload()), toastError)
  }
  const revoke = (code: string) => void ask({ title: t('Revoke code?'), body: <p>{t('{code} can no longer be used to register.', { code })}</p>, confirm: t('Revoke'), danger: true })
    .then((ok) => void (ok && A.deleteCode(code).then(() => void reload(), toastError)))
  return (
    <section className="admin-card" aria-labelledby="codes-h">
      <h2 id="codes-h">{t('Registration codes')}</h2>
      <form className="admin-inline" onSubmit={create}>
        <Field label={t('Uses (0 = unlimited)')} type="number" min={0} max={1000} value={uses} onChange={(e) => setUses(Math.min(1000, Math.max(0, +e.target.value)))} />
        <Field label={t('Valid for (days, 0 = forever)')} type="number" min={0} max={90} value={days} onChange={(e) => setDays(Math.min(90, Math.max(0, +e.target.value)))} />
        <button className="primary admin-btn">{t('Create Code')}</button>
      </form>
      <FormError error={error} />
      {data && (data.length ? (
        <table className="admin-table"><caption className="sr-only">{t('Registration codes')}</caption>
          <thead><tr><th scope="col">{t('Code')}</th><th scope="col" className="num">{t('Uses')}</th><th scope="col">{t('Expires')}</th><th scope="col">{t('Created')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
          <tbody>{data.map((c) => (
            <tr key={c.code}>
              <td><code>{c.code}</code> <button className="link" onClick={() => void navigator.clipboard.writeText(c.code)} aria-label={t('Copy {code}', { code: c.code })}>{t('Copy')}</button></td>
              <td className="num">{c.uses} / {c.max_uses || '∞'}</td><td>{c.expires_at ? when(c.expires_at) : t('Never')}</td><td>{when(c.created_at)}</td>
              <td><button className="link danger-link" onClick={() => revoke(c.code)} aria-label={t('Revoke {code}', { code: c.code })}>{t('Revoke')}</button></td>
            </tr>
          ))}</tbody>
        </table>
      ) : <p className="hint">{t('No codes yet.')}</p>)}
    </section>
  )
}
