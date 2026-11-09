// My Account → security: username, email and password changes, two-factor authentication, account deletion (CONTRACT-v4 section 5).
import { lazy, Suspense, useEffect, useState, type FormEvent } from 'react'
import { backupCodes, deleteAccount, deletePasskey, disableTotp, enableTotp, exportMyData, listPasskeys, patchMe, patchSettings, type BackupCode } from '../actions'
import { api, apiOrigin } from '../api'
import { Field, FormError, Modal } from '../components/ui'
import { logout } from '../gateway'
import { t } from '../i18n'
import { useStore } from '../store'
import { grouped, newSecret, otpauthUri } from './totp'
import './security.css'

const QrCode = lazy(() => import('./QrCode').then((m) => ({ default: m.QrCode })))
const form = (e: FormEvent<HTMLFormElement>) => (e.preventDefault(), Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>)

/** Edit dialogs for username / email / password; all need the current password, email and password also the 2FA code when it is on. */
function EditAccount({ what, onClose }: { what: 'username' | 'email' | 'password'; onClose: () => void }) {
  const me = useStore((s) => s.me)!
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = (e: FormEvent<HTMLFormElement>) => {
    const f = form(e)
    if (what === 'password' && f.new_password !== f.confirm) return setError(t('Passwords do not match.'))
    setBusy(true)
    const code = f.code ? { code: f.code.replace(/[\s-]/g, '') } : {}
    const body = what === 'password' ? { password: f.password, new_password: f.new_password, ...code } : { [what]: f.value, password: f.password, ...code }
    patchMe(body).then(onClose, (err: Error) => (setError(err.message), setBusy(false)))
  }
  const title = { username: t('Change your username'), email: t('Change your email address'), password: t('Update your password') }[what]
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={submit}>
        {what === 'username' && <Field label={t('Username')} name="value" defaultValue={me.username} required minLength={2} maxLength={32} autoComplete="username" autoFocus />}
        {what === 'email' && <Field label={t('Email')} name="value" type="email" defaultValue={me.email} required autoComplete="email" autoFocus />}
        <Field label={t('Current Password')} name="password" type="password" required autoComplete="current-password" autoFocus={what === 'password'} />
        {what === 'password' && (
          <>
            <Field label={t('New Password')} name="new_password" type="password" required minLength={8} autoComplete="new-password" />
            <Field label={t('Confirm New Password')} name="confirm" type="password" required minLength={8} autoComplete="new-password" />
            <p className="hint small">{t('Changing your password logs you out everywhere else.')}</p>
          </>
        )}
        {what !== 'username' && me.mfa_enabled && <Field label={t('Authentication or backup code')} name="code" required autoComplete="one-time-code" maxLength={11} />}
        <FormError error={error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" disabled={busy}>{t('Done')}</button>
        </div>
      </form>
    </Modal>
  )
}

function Codes({ codes }: { codes: BackupCode[] }) {
  return (
    <>
      <ul className="backup-codes" aria-label={t('Backup codes')}>
        {codes.map((c) => <li key={c.code} className={c.consumed ? 'used' : undefined}><code>{c.code.replace(/^(.{4})(.{4})$/, '$1-$2')}</code>{c.consumed && <span className="sr-only"> {t('(used)')}</span>}</li>)}
      </ul>
      <button type="button" className="link" onClick={() => void navigator.clipboard.writeText(codes.filter((c) => !c.consumed).map((c) => c.code).join('\n'))}>{t('Copy codes')}</button>
    </>
  )
}

/** Enable 2FA: password, then scan the QR code (or type the secret) and confirm with a code; shows the backup codes. */
export function EnableTwoFactor({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me)!
  const [secret] = useState(newSecret)
  const [password, setPassword] = useState<string | null>(null)
  const [codes, setCodes] = useState<BackupCode[] | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const confirm = (e: FormEvent<HTMLFormElement>) => {
    const { code } = form(e)
    setBusy(true)
    enableTotp(password!, secret, code.replace(/\s/g, '')).then((c) => setCodes(c), (err: Error) => (setError(err.message), setBusy(false)))
  }
  return (
    <Modal title={t('Enable Two-Factor Auth')} onClose={onClose} className="twofa-modal">
      {codes ? (
        <>
          <p>{t('Two-factor authentication is on. Save these backup codes somewhere safe: each works once if you lose your device.')}</p>
          <Codes codes={codes} />
          <div className="modal-actions"><button className="primary" onClick={onClose}>{t('Done')}</button></div>
        </>
      ) : password === null ? (
        <form onSubmit={(e) => setPassword(form(e).password)}>
          <p className="hint">{t('Make sure it is really you: enter your password to continue.')}</p>
          <Field label={t('Password')} name="password" type="password" required autoComplete="current-password" autoFocus />
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
            <button className="primary">{t('Continue')}</button>
          </div>
        </form>
      ) : (
        <form onSubmit={confirm}>
          <ol className="twofa-steps">
            <li><strong>{t('Download an authenticator app')}</strong><p className="hint small">{t('Any TOTP app works, for example Aegis, 2FAS, Google Authenticator or 1Password.')}</p></li>
            <li>
              <strong>{t('Scan the QR code')}</strong>
              <div className="twofa-qr">
                <Suspense fallback={<div className="qr" aria-busy="true" />}><QrCode text={otpauthUri(secret, me.username)} label={t('QR code for your authenticator app')} /></Suspense>
                <div>
                  <p className="hint small">{t("Can't scan it? Enter this key instead:")}</p>
                  <code className="twofa-secret" aria-label={t('2FA key')}>{grouped(secret)}</code>
                </div>
              </div>
            </li>
            <li><strong>{t('Log in with your code')}</strong>
              <Field label={t('6-digit code')} name="code" inputMode="numeric" autoComplete="one-time-code" required pattern="[0-9 ]{6,7}" maxLength={7} autoFocus />
            </li>
          </ol>
          <FormError error={error} />
          <div className="modal-actions">
            <button type="button" className="secondary" onClick={() => setPassword(null)}>{t('Back')}</button>
            <button className="primary" disabled={busy}>{t('Activate')}</button>
          </div>
        </form>
      )}
    </Modal>
  )
}

function BackupCodesModal({ onClose }: { onClose: () => void }) {
  const [codes, setCodes] = useState<BackupCode[] | null>(null)
  const [error, setError] = useState('')
  const load = (e: FormEvent<HTMLFormElement>) => {
    const f = form(e)
    backupCodes(f.password, true, f.code.replace(/[\s-]/g, '')).then(setCodes, (err: Error) => setError(err.message))
  }
  return (
    <Modal title={t('Backup Codes')} onClose={onClose}>
      {codes ? <><Codes codes={codes} /><div className="modal-actions"><button className="primary" onClick={onClose}>{t('Done')}</button></div></> : (
        <form onSubmit={load}>
          <Field label={t('Password')} name="password" type="password" required autoComplete="current-password" autoFocus />
          <Field label={t('Authentication or backup code')} name="code" required autoComplete="one-time-code" maxLength={11} />
          {/* The server keeps only hashes of the codes, so they can only be shown when new ones are generated. */}
          <p className="hint small">{t('Backup codes cannot be shown again. This generates 10 new codes; the old ones stop working.')}</p>
          <FormError error={error} />
          <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><button className="primary">{t('Generate New Codes')}</button></div>
        </form>
      )}
    </Modal>
  )
}

function CodePrompt({ title, body, confirm, danger, password, onSubmit, onClose }: { title: string; body: string; confirm: string; danger?: boolean; password?: boolean; onSubmit: (code: string, password: string) => Promise<unknown>; onClose: () => void }) {
  const mfa = useStore((s) => !!s.me?.mfa_enabled)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={(e) => {
        const f = form(e)
        setBusy(true)
        onSubmit((f.code ?? '').replace(/[\s-]/g, ''), f.password ?? '').then(onClose, (err: Error) => (setError(err.message), setBusy(false)))
      }}>
        <p className="dialog-body">{body}</p>
        {password && <Field label={t('Password')} name="password" type="password" required autoComplete="current-password" autoFocus />}
        {(mfa || !password) && <Field label={t('Authentication or backup code')} name="code" required={!password} autoComplete="one-time-code" maxLength={11} autoFocus={!password} />}
        <FormError error={error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className={danger ? 'danger-btn' : 'primary'} disabled={busy}>{confirm}</button>
        </div>
      </form>
    </Modal>
  )
}

function PasskeyManager({ mfa }: { mfa: boolean }) {
  const [asking, setAsking] = useState(false)
  const [keys, setKeys] = useState<{ id: string; nickname: string; created_at: string; last_used_at: string | null }[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const reload = () => listPasskeys().then(setKeys, (err: Error) => setError(err.message))
  useEffect(() => { void reload() }, [])

  async function registerPasskey(password: string, code?: string) {
    if (typeof window === 'undefined' || !window.PublicKeyCredential) {
      setError(t('Passkeys are not supported by this browser.'))
      return
    }
    const isSecureContext = window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname.endsWith('.localhost')
    if (!isSecureContext) {
      const hub = apiOrigin()
      setError(t('Passkeys require a secure HTTPS connection. In the desktop app, please add and manage your passkeys in your browser at {url}.', { url: hub }))
      return
    }
    setBusy(true)
    setError('')
    try {
      const opts = await api<{
        challenge: string
        rp: { name: string; id: string }
        user: { id: string; name: string; displayName: string }
        pubKeyCredParams: { alg: number; type: 'public-key' }[]
        timeout: number
      }>('/auth/webauthn/register/options', { method: 'POST', body: { password, ...(code && { code: code.replace(/\s/g, '') }) } })
      setAsking(false)

      const challengeBytes = Uint8Array.from(atob(opts.challenge.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
      const userBytes = Uint8Array.from(atob(opts.user.id.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

      const cred = (await navigator.credentials.create({
        publicKey: {
          challenge: challengeBytes,
          rp: opts.rp,
          user: { ...opts.user, id: userBytes },
          pubKeyCredParams: opts.pubKeyCredParams,
          timeout: opts.timeout,
          authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        },
      })) as PublicKeyCredential | null

      if (!cred) { setBusy(false); return }
      const res = cred.response as AuthenticatorAttestationResponse
      const clientDataJSON = btoa(String.fromCharCode(...new Uint8Array(res.clientDataJSON))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      const attestationObject = btoa(String.fromCharCode(...new Uint8Array(res.attestationObject))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

      await api('/auth/webauthn/register/verify', {
        method: 'POST',
        body: {
          credential: {
            id: cred.id,
            response: { clientDataJSON, attestationObject },
          },
          nickname: 'Passkey ' + (keys.length + 1),
        },
      })
      await reload()
    } catch (err: any) {
      if (err?.name === 'NotSupportedError' || err?.message?.includes('Public-key credentials are only available')) {
        setError(t('Passkeys require a secure HTTPS connection with valid certificates or localhost. Please manage passkeys in your browser.'))
      } else {
        setError(err?.message || 'Failed to create passkey')
      }
    } finally {
      setBusy(false)
    }
  }

  const remove = (id: string) => {
    deletePasskey(id).then(reload, (err: Error) => setError(err.message))
  }

  return (
    <div style={{ marginTop: '0.75rem' }}>
      <FormError error={error} />
      {keys.length > 0 && (
        <ul className="account-rows" style={{ marginBottom: '0.75rem', listStyle: 'none', padding: 0 }}>
          {keys.map((k) => (
            <li key={k.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.5rem 0', borderBottom: '1px solid var(--border-subtle, #333)' }}>
              <div>
                <strong>🔑 {k.nickname || 'Passkey'}</strong>
                <div className="hint small">{t('Added on {date}', { date: new Date(k.created_at).toLocaleDateString() })}</div>
              </div>
              <button type="button" className="danger-btn small-btn" onClick={() => remove(k.id)}>{t('Delete')}</button>
            </li>
          ))}
        </ul>
      )}
      {asking ? (
        <form onSubmit={(e) => { const f = form(e); void registerPasskey(f.password, f.code) }}>
          <p className="hint">{t('Make sure it is really you: enter your password to continue.')}</p>
          <Field label={t('Password')} name="password" type="password" required autoComplete="current-password" autoFocus />
          {mfa && <Field label={t('Authentication or backup code')} name="code" required autoComplete="one-time-code" />}
          <div className="row-buttons">
            <button type="button" className="secondary" onClick={() => setAsking(false)}>{t('Cancel')}</button>
            <button className="primary" disabled={busy}>{busy ? t('Creating Passkey…') : t('Add Passkey')}</button>
          </div>
        </form>
      ) : (
        <button type="button" className="secondary" disabled={busy} onClick={() => setAsking(true)}>{t('Add Passkey')}</button>
      )}
    </div>
  )
}

export function AccountSecurity() {
  const me = useStore((s) => s.me)!
  const guilds = useStore((s) => s.guilds)
  const settings = useStore((s) => s.settings)
  const owned = Object.values(guilds).filter((g) => g.owner_id === me.id)
  const [open, setOpen] = useState<null | 'username' | 'email' | 'password' | 'enable' | 'codes' | 'disable' | 'delete'>(null)
  const [exporting, setExporting] = useState(false)
  const close = () => setOpen(null)
  return (
    <>
      <section className="settings-section">
        <h2>{t('Account')}</h2>
        <div className="account-rows">
          <div><span className="field-label">{t('Username')}</span><span>{me.username}</span><button className="secondary small-btn" onClick={() => setOpen('username')}>{t('Edit')}</button></div>
          <div><span className="field-label">{t('Email')}</span><span>{me.email ?? '—'}</span><button className="secondary small-btn" onClick={() => setOpen('email')}>{t('Edit')}</button></div>
        </div>
      </section>
      <section className="settings-section">
        <h2>{t('Password and Authentication')}</h2>
        <button className="primary" onClick={() => setOpen('password')}>{t('Change Password')}</button>
        <h3 className="field-label twofa-head">{me.mfa_enabled ? t('Two-Factor Authentication is on') : t('Two-Factor Authentication')}</h3>
        <p className="hint small">{t('Protect your account with a code from an authenticator app on every login.')}</p>
        <div className="row-buttons">
          {me.mfa_enabled ? (
            <>
              <button className="secondary" onClick={() => setOpen('codes')}>{t('View Backup Codes')}</button>
              <button className="danger-btn" onClick={() => setOpen('disable')}>{t('Remove 2FA')}</button>
            </>
          ) : <button className="primary" onClick={() => setOpen('enable')}>{t('Enable Authenticator App')}</button>}
        </div>
      </section>
      <section className="settings-section">
        <h2>{t('Passkeys / WebAuthn')}</h2>
        <p className="hint small">{t('Sign in with biometric sensors, Touch ID, Windows Hello, or security keys without typing a password.')}</p>
        <PasskeyManager mfa={!!me.mfa_enabled} />
      </section>
      <section className="settings-section">
        <h2>{t('Your Data & Privacy')}</h2>
        <p className="hint small">{t('Request a complete JSON export of your account profile, settings, server memberships, friends, notes, bookmarks, and messages.')}</p>
        <button
          type="button"
          className="secondary"
          disabled={exporting}
          onClick={async () => {
            setExporting(true)
            try {
              await exportMyData()
            } catch (err: any) {
              alert(err.message || 'Export failed')
            } finally {
              setExporting(false)
            }
          }}
        >
          {exporting ? t('Preparing Export…') : t('Download My Data')}
        </button>
        <label className="checkbox" style={{ marginTop: '16px', display: 'flex', alignItems: 'center', gap: '8px' }}>
          <input
            type="checkbox"
            checked={settings?.privacy?.dm_read_receipts !== false}
            onChange={(e) => {
              void patchSettings({ privacy: { ...settings?.privacy, dm_read_receipts: e.target.checked } })
            }}
          />
          <span className="check-label">{t('Show Read Receipts in Direct Messages')}</span>
        </label>
        <p className="hint small">{t('When disabled, other participants cannot see when you have read their direct messages, and you will not see their read receipts.')}</p>
      </section>
      <section className="settings-section">
        <h2>{t('Account Removal')}</h2>
        <p className="hint small">{t('Deleting your account cannot be undone. Your messages stay and show as "Deleted User".')}</p>
        {owned.length > 0 && <p className="hint small" role="note">{t('You own {n} servers. Transfer ownership first: right-click a member and choose Transfer Ownership.', { n: owned.length })} ({owned.map((g) => g.name).join(', ')})</p>}
        <button className="danger-btn" disabled={owned.length > 0} onClick={() => setOpen('delete')}>{t('Delete Account')}</button>
      </section>
      {(open === 'username' || open === 'email' || open === 'password') && <EditAccount what={open} onClose={close} />}
      {open === 'enable' && <EnableTwoFactor onClose={close} />}
      {open === 'codes' && <BackupCodesModal onClose={close} />}
      {open === 'disable' && <CodePrompt title={t('Remove 2FA')} body={t('Enter a code from your authenticator app or a backup code to turn two-factor authentication off.')} confirm={t('Remove 2FA')} danger onSubmit={(code) => disableTotp(code)} onClose={close} />}
      {open === 'delete' && <CodePrompt title={t('Delete Account')} body={t('Are you sure? Your account is deleted at once and you are logged out.')} confirm={t('Delete Account')} danger password onSubmit={(code, password) => deleteAccount(password, code || undefined).then(() => logout())} onClose={close} />}
    </>
  )
}
