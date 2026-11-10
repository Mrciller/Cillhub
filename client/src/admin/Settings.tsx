// Instance settings (registration mode, name, message of the day, upload limit, GIFs, default voice backend, address,
// SMTP, captcha) and the registration codes used while registration is invite-only.
import { useEffect, useState, type FormEvent } from 'react'
import { ask, toast, toastError } from '../components/dialogs'
import { Field, FormError } from '../components/ui'
import { t } from '../i18n'
import * as A from './api'
import type { InstanceSettings, Registration, SettingsPatch } from './api'
import { useInstance } from './instance'
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
  // typed secrets; a key left out keeps the stored value, null removes it
  const [secrets, setSecrets] = useState<Pick<SettingsPatch, 'smtp_password' | 'captcha_secret'>>({})
  const [mailTest, setMailTest] = useState<{ busy?: boolean; ok?: boolean; text?: string }>({})
  const isHub = useInstance()?.federation?.role === 'hub'
  const mail = !!form && 'smtp_port' in form // servers before 7.10 have no address, SMTP or captcha settings
  useEffect(() => void (data && setForm(data)), [data])
  if (error) return <FormError error={error} />
  if (!form) return <p className="hint" aria-busy="true">{t('Loading…')}</p>
  const backends = form.voice.configured
  const set = (patch: Partial<InstanceSettings>) => (setForm({ ...form, ...patch }), setSaved(false))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setSaveError('')
    const { instance_name, motd, registration_mode, max_upload_bytes, gifs_enabled, voice_backend, smtp_port, smtp_security } = form
    const text = (v: string | null) => v?.trim() || null
    A.saveSettings({
      instance_name: instance_name.trim(), motd: text(motd), registration_mode, max_upload_bytes, gifs_enabled, voice_backend,
      ...(mail && !isHub && { public_url: text(form.public_url) }),
      ...(mail && {
        smtp_host: text(form.smtp_host), smtp_port, smtp_security, smtp_user: text(form.smtp_user), smtp_from: text(form.smtp_from),
        captcha_site_key: text(form.captcha_site_key), ...secrets,
      }),
    }).then((s) => (setForm(s), setSecrets({}), setSaved(true)), (err: Error) => setSaveError(err.message))
  }
  const sendTest = () => {
    setMailTest({ busy: true })
    A.testMail().then((r) => setMailTest({ ok: r.ok, text: r.ok ? t('Test mail sent to your address.') : r.error ?? '' }), (err: Error) => setMailTest({ ok: false, text: err.message }))
  }
  // a stored secret shows as "saved"; Remove clears it on the next save
  const secret = (key: 'smtp_password' | 'captcha_secret', label: string, isSet: boolean) => (
    <div className="admin-inline">
      <Field label={label} type="password" autoComplete="new-password" maxLength={255} value={secrets[key] ?? ''}
        placeholder={isSet && secrets[key] !== null ? t('Saved') : ''} onChange={(e) => (setSecrets({ ...secrets, [key]: e.target.value || undefined }), setSaved(false))} />
      {isSet && secrets[key] !== null && <button type="button" className="link danger-link" onClick={() => (setSecrets({ ...secrets, [key]: null }), setSaved(false))}>{t('Remove')}</button>}
    </div>
  )
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
        {mail && !isHub && (
          <fieldset className="admin-reasons">
            <legend>{t('Address')}</legend>
            <Field label={t('Public address')} type="url" maxLength={255} value={form.public_url ?? ''} placeholder={form.public_url_effective}
              onChange={(e) => set({ public_url: e.target.value })} aria-describedby="admin-url-hint" />
            <p id="admin-url-hint" className="hint small">
              {t('Point the DNS of the new name to this server first; the old address keeps working. Passkeys made on the old address only work there, and a hub this server is linked to keeps using the old address until you link again. With the bundled Caddy, installs from before 7.10 need install.sh run again to get certificates for the new name.')}
            </p>
          </fieldset>
        )}
        {mail && <>
        <fieldset className="admin-reasons">
          <legend>{t('Email (SMTP)')}</legend>
          <p className="hint small">{t('Needed for password reset by email.')}</p>
          {!form.public_url?.trim() && !form.public_url_env && (
            <p className="hint small">{isHub ? t('Password reset also needs CILLCORD_PUBLIC_URL on the server.') : t('Password reset also needs the address above.')}</p>
          )}
          <div className="admin-inline">
            <Field label={t('Server')} maxLength={255} value={form.smtp_host ?? ''} placeholder="smtp.example.org" onChange={(e) => set({ smtp_host: e.target.value })} />
            <Field label={t('Port')} type="number" min={1} max={65535} required value={form.smtp_port} onChange={(e) => set({ smtp_port: Math.min(65535, Math.max(1, +e.target.value)) })} />
            <div className="field">
              <label htmlFor="admin-smtp-security">{t('Encryption')}</label>
              <select id="admin-smtp-security" className="input" value={form.smtp_security} onChange={(e) => set({ smtp_security: e.target.value as InstanceSettings['smtp_security'] })}>
                <option value="starttls">STARTTLS</option>
                <option value="tls">TLS</option>
                <option value="none">{t('None')}</option>
              </select>
            </div>
          </div>
          <Field label={t('User name')} maxLength={255} autoComplete="off" value={form.smtp_user ?? ''} onChange={(e) => set({ smtp_user: e.target.value })} />
          {secret('smtp_password', t('Password'), form.smtp_password_set)}
          <Field label={t('Sender')} maxLength={255} value={form.smtp_from ?? ''} placeholder="Cillhub <no-reply@example.org>" onChange={(e) => set({ smtp_from: e.target.value })} />
          <div className="admin-inline">
            <button type="button" className="admin-btn" disabled={mailTest.busy} onClick={sendTest}>{t('Send test mail')}</button>
            <span className="hint small">{t('Uses the saved settings.')}</span>
          </div>
          {mailTest.text && <p className={mailTest.ok ? 'success' : 'form-error'} role="status">{mailTest.text}</p>}
        </fieldset>
        <fieldset className="admin-reasons">
          <legend>{t('Captcha')}</legend>
          <p className="hint small">{t('Asked at sign-up and password reset. reCAPTCHA v2 (checkbox) keys from google.com/recaptcha/admin.')}</p>
          <Field label={t('Site key')} maxLength={255} autoComplete="off" value={form.captcha_site_key ?? ''} onChange={(e) => set({ captcha_site_key: e.target.value })} />
          {secret('captcha_secret', t('Secret key'), form.captcha_secret_set)}
        </fieldset>
        </>}
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
