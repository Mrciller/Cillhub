import { useEffect, useState, type FormEvent } from 'react'
import { api, ApiError, ORIGIN } from '../api'
import { t } from '../i18n'
import { Link, navigate, nextPath } from '../router'
import { setToken } from '../store'
import { Field, FormError } from './ui'
import { useInstance } from '../admin/instance'
import { signInHere } from '../instances/nodes'

type Mfa = { ticket: string; totp?: boolean; backup?: boolean }
type LoginAnswer = { token: string; required_actions?: string[] }

/** 429 answers carry `retry_after` (seconds): show it counting down. */
function useRetry(error: ApiError | null) {
  const [until, setUntil] = useState(0)
  const [, tick] = useState(0)
  useEffect(() => void (error?.status === 429 && setUntil(Date.now() + Math.ceil(error.retryAfter || 1) * 1000)), [error])
  useEffect(() => {
    if (until <= Date.now()) return
    const id = setInterval(() => (tick((n) => n + 1), Date.now() >= until && clearInterval(id)), 1000)
    return () => clearInterval(id)
  }, [until])
  return Math.max(0, Math.ceil((until - Date.now()) / 1000))
}

export function Auth({ mode }: { mode: 'login' | 'register' }) {
  const [error, setError] = useState<ApiError | null>(null)
  const [busy, setBusy] = useState(false)
  const [mfa, setMfa] = useState<Mfa | null>(null)
  const [renew, setRenew] = useState<string | null>(null) // token of a login that must set a new password first (v6 admin)
  const [backup, setBackup] = useState(false)
  const wait = useRetry(error)
  const login = mode === 'login'
  const instance = useInstance()
  const closed = !login && instance?.registration_mode === 'closed'
  // v7: a node connected to a hub may offer "Sign in with <hub>" (GET /auth/methods)
  const [hub, setHub] = useState<{ url: string; name: string | null; node_id: string } | null>(null)
  useEffect(() => {
    if (instance?.federation?.mode !== 'connected') return
    api<{ hub: boolean; hub_info: { url: string; name: string | null; node_id: string } | null }>('/auth/methods').then((m) => setHub(m.hub ? m.hub_info : null), () => {})
  }, [instance?.federation?.mode])
  const fieldError = (name: string) => error?.errors[name]?._errors?.[0]?.message
  const done = (token: string) => (navigate(nextPath('/channels/@me'), true), setToken(token))
  const finish = (r: LoginAnswer) => (r.required_actions?.includes('update_password') ? (setRenew(r.token), setBusy(false)) : done(r.token))
  const fail = (err: unknown) => (setError(err instanceof ApiError ? err : new ApiError(0, null)), setBusy(false))
  const message = wait ? t('Too many attempts. Try again in {n} seconds.', { n: wait }) : error && Object.keys(error.errors).length === 0 ? error.message : ''

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await api<Partial<LoginAnswer> & { mfa?: boolean; ticket?: string; totp?: boolean; backup?: boolean }>(`/auth/${mode}`, { method: 'POST', body: Object.fromEntries(new FormData(e.currentTarget)) })
      // User docs: with 2FA the login answers { mfa: true, ticket } and the code goes to /auth/mfa/totp.
      if (r.mfa && r.ticket) return setMfa({ ticket: r.ticket, totp: r.totp, backup: r.backup }), setBusy(false)
      if (r.token) finish(r as LoginAnswer)
    } catch (err) {
      fail(err)
    }
  }

  async function passkeySignIn() {
    if (typeof window === 'undefined' || !window.PublicKeyCredential) {
      setError(new ApiError(0, { message: t('Passkeys are not supported by this browser.') }))
      return
    }
    const isSecureContext = window.location.protocol === 'https:' || window.location.hostname === 'localhost' || window.location.hostname.endsWith('.localhost')
    if (!isSecureContext) {
      const hub = (ORIGIN || window.location.origin || 'https://cillhub.cillerian.org').replace(/\/+$/, '')
      const isDesktop = window.location.protocol === 'app:' || !!(window as any).cillcordDesktop
      if (isDesktop) {
        window.open(`${hub}/login`, '_blank')
        setError(new ApiError(0, {
          message: t('Passkeys require a secure HTTPS origin with valid certificates or localhost. We opened the sign-in page in your browser. In the desktop app, please sign in with your email or username and password.')
        }))
      } else {
        setError(new ApiError(0, {
          message: t('Passkeys are only supported over secure HTTPS origins or localhost.')
        }))
      }
      return
    }
    setBusy(true)
    setError(null)
    try {
      const opts = await api<{ challenge: string; timeout: number; rpId: string; allowCredentials: { id: string }[] }>('/auth/webauthn/authenticate/options', { method: 'POST', body: {} })
      const challengeBytes = Uint8Array.from(atob(opts.challenge.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))
      const cred = (await navigator.credentials.get({
        publicKey: {
          challenge: challengeBytes,
          rpId: opts.rpId || window.location.hostname,
          userVerification: 'preferred',
        },
      })) as PublicKeyCredential | null
      if (!cred) { setBusy(false); return }
      const res = cred.response as AuthenticatorAssertionResponse
      const clientDataJSON = btoa(String.fromCharCode(...new Uint8Array(res.clientDataJSON))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      const authenticatorData = btoa(String.fromCharCode(...new Uint8Array(res.authenticatorData))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      const signature = btoa(String.fromCharCode(...new Uint8Array(res.signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
      const ans = await api<LoginAnswer>('/auth/webauthn/authenticate/verify', {
        method: 'POST',
        body: {
          credential: {
            id: cred.id,
            response: { clientDataJSON, authenticatorData, signature },
          },
        },
      })
      finish(ans)
    } catch (err: any) {
      if (err?.name === 'NotSupportedError' || err?.message?.includes('Public-key credentials are only available')) {
        fail(new ApiError(0, {
          message: t('Passkeys require a secure HTTPS origin with valid certificates or localhost. Please sign in with your password, or open Cillhub in your browser.')
        }))
      } else {
        fail(err)
      }
    }
  }

  async function verify(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!mfa) return
    setBusy(true)
    setError(null)
    try {
      const code = String(new FormData(e.currentTarget).get('code')).replace(/[\s-]/g, '')
      // The totp authenticator also accepts backup codes (user docs, authenticator types).
      const r = await api<LoginAnswer>('/auth/mfa/totp', { method: 'POST', body: { code, ticket: mfa.ticket } })
      finish(r)
    } catch (err) {
      // An expired ticket (5 min, 5 attempts) means logging in again.
      if (err instanceof ApiError && (err.status === 401 || err.code === 60008) && /ticket/i.test(err.message)) setMfa(null)
      fail(err)
    }
  }

  // An admin required a new password: only PATCH /users/@me works with this token until it is changed.
  async function changePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!renew) return
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
    if (f.new_password !== f.confirm) return setError(new ApiError(0, { message: t('Passwords do not match.') }))
    setBusy(true)
    setError(null)
    localStorage.setItem('token', renew) // api() sends the stored token; the store only learns it in done()
    try {
      const r = await api<{ token?: string }>('/users/@me', { method: 'PATCH', body: { password: f.password, new_password: f.new_password } })
      done(r.token ?? renew)
    } catch (err) {
      localStorage.removeItem('token')
      fail(err)
    }
  }

  if (renew)
    return (
      <div className="auth-bg">
        <main className="auth-card">
          <form onSubmit={changePassword}>
            <h1>{t('Choose a new password')}</h1>
            <p className="sub">{t('An administrator asked you to change your password before you continue.')}</p>
            <Field label={t('Current Password')} name="password" type="password" autoComplete="current-password" required error={fieldError('password')} autoFocus />
            <Field label={t('New Password')} name="new_password" type="password" autoComplete="new-password" required minLength={8} maxLength={72} error={fieldError('new_password')} />
            <Field label={t('Confirm New Password')} name="confirm" type="password" autoComplete="new-password" required minLength={8} maxLength={72} />
            <FormError error={message} />
            <button className="primary wide" disabled={busy}>{t('Change Password')}</button>
          </form>
        </main>
      </div>
    )

  if (mfa)
    return (
      <div className="auth-bg">
        <main className="auth-card">
          <form onSubmit={verify}>
            <h1>{t('Multi-Factor Authentication')}</h1>
            <p className="sub">{backup ? t('Enter one of your 8-character backup codes.') : t('Enter the 6-digit code from your authenticator app.')}</p>
            <Field key={String(backup)} label={backup ? t('Backup code') : t('Authentication code')} name="code" autoComplete="one-time-code" inputMode={backup ? 'text' : 'numeric'}
              required minLength={6} maxLength={backup ? 11 : 6} pattern={backup ? undefined : '[0-9]{6}'} autoFocus error={fieldError('code')} />
            <FormError error={message} />
            <button className="primary wide" disabled={busy || wait > 0}>{t('Log In')}</button>
            <p className="switch">
              {mfa.backup !== false && <button type="button" className="link" onClick={() => setBackup(!backup)}>{backup ? t('Use your authenticator app instead') : t('Use a backup code')}</button>}
              {' · '}<button type="button" className="link" onClick={() => (setMfa(null), setError(null))}>{t('Go back to login')}</button>
            </p>
          </form>
        </main>
      </div>
    )

  return (
    <div className="auth-bg">
      <main className="auth-card">
        <form onSubmit={submit}>
          <p className="auth-brand" aria-hidden="true">{instance?.name || 'Cillhub'}</p>
          <h1>{login ? t('Ready up') : t('Join the roster')}</h1>
          <p className="sub">{login ? t('Log in to get back to your team.') : t('Create your account to join your team.')}</p>
          {login && instance?.motd && <p className="auth-motd" role="note" aria-label={t('Message of the day')}>{instance.motd}</p>}
          {closed && <p className="auth-motd" role="note">{t('Registration is closed on this instance. Ask its admin for an account.')}</p>}
          {!login && <Field label={t('Email')} name="email" type="email" autoComplete="email" required error={fieldError('email')} />}
          <Field
            label={login ? t('Email or username') : t('Username')}
            name={login ? 'login' : 'username'}
            autoComplete="username"
            required
            {...(!login && { minLength: 2, maxLength: 32 })}
            error={fieldError(login ? 'login' : 'username')}
          />
          <Field
            label={t('Password')}
            name="password"
            type="password"
            autoComplete={login ? 'current-password' : 'new-password'}
            required
            {...(!login && { minLength: 8 })}
            error={fieldError('password')}
          />
          {!login && instance?.registration_mode === 'invite' && (
            <Field label={t('Registration code')} name="registration_code" autoComplete="off" required maxLength={64} error={fieldError('registration_code')} />
          )}
          <FormError error={message} />
          <button className="primary wide" disabled={busy || wait > 0 || closed}>{login ? t('Log In') : t('Continue')}</button>
          {login && (
            <button type="button" className="secondary wide" style={{ marginTop: '0.5rem' }} disabled={busy || wait > 0} onClick={() => void passkeySignIn()}>
              🔑 {t('Sign in with Passkey')}
            </button>
          )}
          {hub && (
            <button type="button" className="secondary wide auth-hub" onClick={() => signInHere({ id: hub.node_id, name: hub.name ?? new URL(hub.url).host, url: hub.url })}>
              {t('Sign in with {hub}', { hub: hub.name ?? new URL(hub.url).host })}
            </button>
          )}
          <p className="switch">
            {login ? t('Need an account?') + ' ' : t('Already have an account?') + ' '}
            <Link to={(login ? '/register' : '/login') + location.search}>{login ? t('Register') : t('Log In')}</Link>
          </p>
        </form>
      </main>
    </div>
  )
}
