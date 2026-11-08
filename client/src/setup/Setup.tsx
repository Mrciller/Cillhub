// First-run wizard (CONTRACT-v7 §1) at /setup, shown only while GET /instance says `setup_pending`. Protected by the one-time
// setup code that install.sh printed. Steps: code → instance name → first admin (+ mandatory 2FA) → registration mode →
// standalone / connected (hub URL + link code) → voice self-check → finish (with automatic updates, default off). Routes are
// listed in client/README.md (v7).
import { lazy, Suspense, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { enableTotp, type BackupCode } from '../actions'
import { api, ApiError } from '../api'
import { instanceEvent } from '../admin/instance'
import type { AutoUpdateMode, PublicInstance, Registration } from '../admin/api'
import { AutoUpdateFields } from '../admin/Updates'
import { Field, FormError } from '../components/ui'
import { DEFAULT_HUB_URL } from '../hub'
import { t } from '../i18n'
import { navigate } from '../router'
import { grouped, newSecret, otpauthUri } from '../security/totp'
import { setToken } from '../store'
import '../security/security.css'
import './setup.css'

const QrCode = lazy(() => import('../security/QrCode').then((m) => ({ default: m.QrCode })))

/** GET /setup (server/README.md → v7 → First-run wizard). */
type SetupInfo = {
  required: boolean; role?: 'hub' | 'node'; version?: string; hub_url?: string | null; mode_hint?: 'standalone' | 'connected' | null
  updater?: boolean; auto_update?: AutoUpdateMode; auto_update_hour?: number
}
/** POST /setup/voice-check: configured backends; for cillvoice a STUN probe address that answers for 60 s. */
type VoiceAnswer = { configured: string[]; default: string | null; cillvoice: { public_ip: string; udp_port: number; stun_url: string; listening: boolean } | null }
type VoiceCheck = { backend: string | null; ok: boolean; checks: { id: string; label: string; ok: boolean | null; detail?: string | null }[] }
type Mode = 'standalone' | 'connected'

const STEPS = ['Setup code', 'Instance', 'Admin account', 'Two-factor authentication', 'Registration', 'Hub connection', 'Voice check', 'Finish'] as const
const form = (e: FormEvent<HTMLFormElement>) => (e.preventDefault(), Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>)
const fieldError = (e: unknown, name: string) => (e instanceof ApiError ? e.errors[name]?._errors?.[0]?.message : undefined)

export function Setup() {
  const [info, setInfo] = useState<SetupInfo | null>(null)
  const [step, setStep] = useState(0)
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [admin, setAdmin] = useState<{ username: string; password: string } | null>(null)
  const [registration, setRegistration] = useState<Registration>('invite')
  const [mode, setMode] = useState<Mode>('standalone')
  const [hubUrl, setHubUrl] = useState('')
  const [linkCode, setLinkCode] = useState('')
  const [auto, setAuto] = useState<{ auto_update: AutoUpdateMode; auto_update_hour: number }>({ auto_update: 'off', auto_update_hour: 4 })
  const [error, setError] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    document.title = `${t('Set up Cillhub')} · Cillhub`
    api<SetupInfo>('/setup').then((i) => {
      setInfo(i)
      setName('Cillhub')
      setHubUrl(i.hub_url ?? '')
      if (i.role === 'hub') setMode('standalone') // a hub cannot connect to itself; the server rejects that mode
      else if (i.mode_hint) setMode(i.mode_hint)
      setAuto({ auto_update: i.auto_update ?? 'off', auto_update_hour: i.auto_update_hour ?? 4 }) // install.sh --auto-update
    }, () => setInfo({ required: true }))
  }, [])
  // Each step's heading takes focus so screen readers announce where the wizard is.
  useEffect(() => document.getElementById('setup-step')?.focus(), [step])

  const run = (p: Promise<unknown>, next: number) => {
    setBusy(true)
    setError(null)
    p.then(() => (setBusy(false), setStep(next)), (e) => (setBusy(false), setError(e)))
  }
  const message = error instanceof ApiError && Object.keys(error.errors).length ? '' : error instanceof Error ? error.message : ''
  const back = (to: number) => <button type="button" className="secondary" onClick={() => (setError(null), setStep(to))}>{t('Back')}</button>

  let body: ReactNode
  if (step === 0) body = (
    <form onSubmit={(e) => { const f = form(e); setCode(f.code.trim()); run(api('/setup/verify', { method: 'POST', body: { setup_code: f.code.trim() } }), 1) }}>
      <p>{t('Welcome! This instance is not set up yet. Enter the setup code that the installer printed (also in /opt/cillhub/.env as CILLCORD_SETUP_CODE).')}</p>
      <Field label={t('Setup code')} name="code" required autoComplete="off" spellCheck={false} defaultValue={code} autoFocus error={fieldError(error, 'setup_code')} />
      <Actions busy={busy} />
    </form>
  )
  else if (step === 1) body = (
    <form onSubmit={(e) => { setName(form(e).name.trim()); setStep(2) }}>
      <Field label={t('Instance name')} name="name" required maxLength={64} defaultValue={name} autoFocus />
      <p className="hint small">{t('Shown on the login page, in the browser tab and to people who join from other instances.')}</p>
      <Actions busy={busy} back={back(0)} />
    </form>
  )
  else if (step === 2) body = admin ? (
    <><p role="status">{t('The admin account {name} was created.', { name: admin.username })}</p><Actions busy={busy} next={() => setStep(3)} /></>
  ) : (
    <form onSubmit={(e) => {
      const f = form(e)
      if (f.password !== f.confirm) return setError(new Error(t('The passwords do not match.')))
      run(api<{ token: string }>('/setup/admin', { method: 'POST', body: { setup_code: code, username: f.username.trim(), email: f.email.trim() || undefined, password: f.password } })
        .then((r) => (setToken(r.token), setAdmin({ username: f.username.trim(), password: f.password }))), 3)
    }}>
      <p>{t('The first account becomes the instance admin. It must use two-factor authentication, set up in the next step.')}</p>
      <Field label={t('Username')} name="username" required minLength={2} maxLength={32} autoComplete="username" autoFocus error={fieldError(error, 'username')} />
      <Field label={t('Email')} name="email" type="email" required autoComplete="email" error={fieldError(error, 'email')} />
      <Field label={t('Password')} name="password" type="password" required minLength={8} autoComplete="new-password" error={fieldError(error, 'password')} />
      <Field label={t('Repeat password')} name="confirm" type="password" required minLength={8} autoComplete="new-password" />
      <Actions busy={busy} back={back(1)} />
    </form>
  )
  else if (step === 3 && admin) body = <TwoFactor admin={admin} onDone={() => setStep(4)} />
  else if (step === 4) body = (
    <form onSubmit={(e) => { setRegistration(form(e).registration as Registration); setStep(5) }}>
      <fieldset className="choice block">
        <legend>{t('Who can create an account?')}</legend>
        {([['open', 'Anyone (open registration)'], ['invite', 'Only people with a registration code'], ['closed', 'Nobody (admins create accounts)']] as const).map(([v, label]) => (
          <label key={v}><input type="radio" name="registration" value={v} defaultChecked={registration === v} /> {t(label)}</label>
        ))}
      </fieldset>
      <p className="hint small">{t('You can change this later in the admin dashboard.')}</p>
      <Actions busy={busy} />
    </form>
  )
  else if (step === 5) body = (
    <form onSubmit={(e) => { const f = form(e); setMode((info?.role === 'hub' ? 'standalone' : f.mode) as Mode); setHubUrl((f.hub_url ?? hubUrl).trim()); setLinkCode((f.link_code ?? '').trim()); setError(null); setStep(6) }}>
      <fieldset className="choice block">
        <legend>{t('Mode')}</legend>
        <label><input type="radio" name="mode" value="standalone" checked={mode === 'standalone' || info?.role === 'hub'} onChange={() => setMode('standalone')} />
          <span><strong>{t('Standalone')}</strong><br /><span className="hint small">{t('Fully independent: own accounts, nothing is shared with the hub. Only an optional update check.')}</span></span></label>
        {info?.role !== 'hub' && (
          <label><input type="radio" name="mode" value="connected" checked={mode === 'connected'} onChange={() => setMode('connected')} />
            <span><strong>{t('Connected to the hub')}</strong><br /><span className="hint small">{t('Hub accounts can sign in here, your public servers can appear in the hub\'s server directory and hub users see them next to their other servers.')}</span></span></label>
        )}
      </fieldset>
      {mode === 'connected' && info?.role !== 'hub' && (
        <>
          <Field label={t('Hub address')} name="hub_url" type="url" required defaultValue={hubUrl} placeholder={DEFAULT_HUB_URL} />
          <Field label={t('Link code')} name="link_code" required autoComplete="off" spellCheck={false} defaultValue={linkCode} error={fieldError(error, 'link_code') ?? fieldError(error, 'hub_url')}
            aria-describedby="link-hint" />
          <p className="hint small" id="link-hint">{t('A hub admin creates the code in the hub\'s admin dashboard → Nodes. It works once and for 24 hours.')}</p>
        </>
      )}
      <Actions busy={busy} back={back(4)} />
    </form>
  )
  else if (step === 6) body = <VoiceStep code={code} onBack={() => setStep(5)} onNext={() => setStep(7)} />
  else body = (
    <form onSubmit={(e) => {
      e.preventDefault()
      setBusy(true)
      setError(null)
      api<{ instance?: PublicInstance }>('/setup/complete', { method: 'POST', body: {
        setup_code: code, instance_name: name, registration_mode: registration, mode, ...(mode === 'connected' && { hub_url: hubUrl, link_code: linkCode }),
        ...(info?.updater && auto),
      } })
        .then((r) => {
          instanceEvent('INSTANCE_SETTINGS_UPDATE', { ...r?.instance, name: r?.instance?.name ?? name, registration_mode: registration, setup_pending: false })
          navigate('/channels/@me', true)
        }, (err) => {
          setBusy(false)
          // A link code the hub refused belongs to the hub connection step.
          if (fieldError(err, 'link_code') || fieldError(err, 'hub_url')) (setError(err), setStep(5))
          else setError(err)
        })
    }}>
      <dl className="admin-facts setup-summary">
        <dt>{t('Instance name')}</dt><dd>{name}</dd>
        <dt>{t('Admin account')}</dt><dd>{admin?.username} · {t('2FA on')}</dd>
        <dt>{t('Registration')}</dt><dd>{t(registration === 'open' ? 'Open' : registration === 'invite' ? 'Registration code' : 'Closed')}</dd>
        <dt>{t('Mode')}</dt><dd>{mode === 'connected' ? t('Connected to {hub}', { hub: hubUrl }) : t('Standalone')}</dd>
      </dl>
      {info?.updater && (
        <section aria-labelledby="setup-auto-h" className="setup-auto">
          <h3 id="setup-auto-h">{t('Automatic updates')}</h3>
          <p className="hint small">{t('Updates come only from the signed releases of the Cillhub network hub. We recommend security and patch releases in a quiet hour; you can change this later on the admin Updates page.')}</p>
          <AutoUpdateFields mode={auto.auto_update} hour={auto.auto_update_hour} onChange={(p) => setAuto({ ...auto, ...p })} />
        </section>
      )}
      <Actions busy={busy} back={back(6)} label={t('Finish setup')} />
    </form>
  )

  return (
    <div className="auth-bg setup">
      <main className="auth-card setup-card" aria-labelledby="setup-h1">
        <h1 id="setup-h1">{t('Set up Cillhub')}</h1>
        {info?.version && <p className="sub">{t('Version {v}', { v: info.version })}</p>}
        <ol className="setup-steps" aria-label={t('Setup steps')}>
          {STEPS.map((s, i) => <li key={s} className={i < step ? 'done' : i === step ? 'current' : undefined} aria-current={i === step ? 'step' : undefined}><span>{t(s)}</span></li>)}
        </ol>
        <h2 id="setup-step" tabIndex={-1}>{t(STEPS[step])}</h2>
        {body}
        <FormError error={message} />
      </main>
    </div>
  )
}

function Actions({ busy, back, label, next }: { busy: boolean; back?: ReactNode; label?: string; next?: () => void }) {
  return (
    <div className="modal-actions">
      {back}
      {next ? <button type="button" className="primary" onClick={next}>{t('Continue')}</button> : <button className="primary" disabled={busy}>{busy ? t('Please wait…') : label ?? t('Continue')}</button>}
    </div>
  )
}

/** Mandatory 2FA for the first admin (CONTRACT-v7 §1): same enrolment as User Settings, no way to skip. */
function TwoFactor({ admin, onDone }: { admin: { username: string; password: string }; onDone: () => void }) {
  const [secret] = useState(newSecret)
  const [codes, setCodes] = useState<BackupCode[] | null>(null)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (codes) return (
    <>
      <p>{t('Two-factor authentication is on. Save these backup codes somewhere safe: each works once if you lose your device.')}</p>
      <ul className="backup-codes">{codes.map((c) => <li key={c.code}><code>{c.code}</code></li>)}</ul>
      <label className="check-row"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> <span>{t('I saved my backup codes')}</span></label>
      <div className="modal-actions"><button className="primary" disabled={!saved} onClick={onDone}>{t('Continue')}</button></div>
    </>
  )
  return (
    <form onSubmit={(e) => {
      const f = form(e)
      setBusy(true)
      setError('')
      enableTotp(admin.password, secret, f.code.replace(/\s/g, '')).then(setCodes, (err: Error) => (setError(err.message), setBusy(false)))
    }}>
      <p>{t('Admins of this instance must protect their account with an authenticator app.')}</p>
      <ol className="twofa-steps">
        <li><strong>{t('Download an authenticator app')}</strong><p className="hint small">{t('Any TOTP app works, for example Aegis, 2FAS, Google Authenticator or 1Password.')}</p></li>
        <li>
          <strong>{t('Scan the QR code')}</strong>
          <div className="twofa-qr">
            <Suspense fallback={<div className="qr" aria-busy="true" />}><QrCode text={otpauthUri(secret, admin.username)} label={t('QR code for your authenticator app')} /></Suspense>
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
      <div className="modal-actions"><button className="primary" disabled={busy}>{t('Activate')}</button></div>
    </form>
  )
}

/** Asks the server's STUN probe for our address over UDP: a server-reflexive candidate means the voice port is reachable
 *  from this browser's network. Resolves false after 6 s without one. */
function stunReachable(url: string): Promise<boolean> {
  const pc = new RTCPeerConnection({ iceServers: [{ urls: url }] })
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 6000)
    pc.onicecandidate = (e) => { if (e.candidate?.type === 'srflx' || / typ srflx /.test(e.candidate?.candidate ?? '')) (clearTimeout(timer), resolve(true)) }
    pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') setTimeout(() => (clearTimeout(timer), resolve(false)), 200) }
    pc.createDataChannel('probe')
    void pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => (clearTimeout(timer), resolve(false)))
  }).finally(() => pc.close())
}

async function runVoiceCheck(code: string): Promise<VoiceCheck> {
  const a = await api<VoiceAnswer>('/setup/voice-check', { method: 'POST', body: { setup_code: code } })
  const backend = a.default ?? a.configured[0] ?? null
  const checks: VoiceCheck['checks'] = [{ id: 'configured', label: t('A voice backend is configured'), ok: !!backend, detail: a.configured.join(', ') || null }]
  if (a.cillvoice) {
    const where = `${a.cillvoice.public_ip}:${a.cillvoice.udp_port}`
    checks.push({ id: 'listening', label: t('cillvoice listens on UDP port {port}', { port: a.cillvoice.udp_port }), ok: a.cillvoice.listening })
    checks.push({ id: 'reachable', label: t('This browser reaches {where} over UDP', { where }), ok: a.cillvoice.listening && await stunReachable(a.cillvoice.stun_url) })
  } else if (backend === 'livekit') checks.push({ id: 'livekit', label: t('LiveKit is reached through its own address; test it with a call after setup'), ok: null })
  return { backend, ok: checks.every((c) => c.ok !== false), checks }
}

/** ICE/UDP reachability self-check of the voice backend; informative, setup can go on when it fails. */
function VoiceStep({ code, onBack, onNext }: { code: string; onBack: () => void; onNext: () => void }) {
  const [result, setResult] = useState<VoiceCheck | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const check = () => {
    setBusy(true)
    setError('')
    runVoiceCheck(code).then(setResult, (e: Error) => setError(e.message)).finally(() => setBusy(false))
  }
  useEffect(check, [code]) // eslint-disable-line react-hooks/exhaustive-deps
  const name = result?.backend
  return (
    <>
      <p>{name ? t('Voice backend: {name}. Cillhub checks that browsers can reach it.', { name: name === 'cillvoice' ? 'cillvoice' : name === 'livekit' ? 'LiveKit' : name }) : t('No voice backend is configured. Voice channels will say so until one is set up.')}</p>
      <div aria-live="polite" aria-busy={busy}>
        {busy && <p className="hint">{t('Checking…')}</p>}
        {result && (
          <ul className="setup-checks">
            {result.checks.map((c) => (
              <li key={c.id} className={c.ok ? 'ok' : c.ok === false ? 'fail' : 'skip'}>
                <span className="setup-check-mark" aria-hidden="true">{c.ok ? '✓' : c.ok === false ? '✕' : '–'}</span>
                <span><strong>{c.label}</strong><span className="sr-only">: {c.ok ? t('passed') : c.ok === false ? t('failed') : t('skipped')}</span>{c.detail && <><br /><span className="hint small">{c.detail}</span></>}</span>
              </li>
            ))}
          </ul>
        )}
        {result && !result.ok && <p className="hint small">{t('Voice may not work for everyone until this passes. Usually the UDP port is not open in the firewall or router. You can finish setup and run the check again later from the admin dashboard.')}</p>}
      </div>
      <FormError error={error} />
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={onBack}>{t('Back')}</button>
        <button type="button" className="secondary" onClick={check} disabled={busy}>{t('Check again')}</button>
        <button type="button" className="primary" onClick={onNext}>{t('Continue')}</button>
      </div>
    </>
  )
}
