// /reset?token=…: the page the password reset mail links to. Talks to this page's own origin (the instance that sent
// the mail), never to a server chosen on the login page. No token comes back: the user signs in again, 2FA included.
import { useEffect, useState, type FormEvent } from 'react'
import { t } from '../i18n'
import { Link } from '../router'
import { Field, FormError } from './ui'

export function ResetPage() {
  const [token] = useState(() => new URLSearchParams(location.search).get('token') ?? '')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  useEffect(() => history.replaceState(null, '', '/reset'), []) // the token leaves the address bar (history, screen shares) at once

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
    if (f.password !== f.confirm) return setError(t('Passwords do not match.'))
    setBusy(true)
    setError('')
    try {
      const res = await fetch(`${location.origin}/api/v9/auth/reset`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, password: f.password }) })
      if (!res.ok) {
        const body = await res.json().catch(() => null)
        throw new Error(res.status === 429 ? t('Too many attempts. Try again later.') : body?.message ? t(body.message) : t('Request failed ({status})', { status: res.status }))
      }
      setDone(true)
    } catch (err) {
      setError(err instanceof TypeError ? t("Can't reach the server.") : (err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-bg">
      <main className="auth-card">
        {done ? (
          <>
            <h1>{t('Password changed')}</h1>
            <p className="sub" role="status">{t('Your new password is set. All sessions of your account were signed out.')}</p>
            <p className="switch"><Link to="/login">{t('Log In')}</Link></p>
          </>
        ) : !token ? (
          <>
            <h1>{t('Choose a new password')}</h1>
            <FormError error={t('This link is invalid or has expired.')} />
            <p className="switch"><Link to="/login">{t('Go back to login')}</Link></p>
          </>
        ) : (
          <form onSubmit={submit}>
            <h1>{t('Choose a new password')}</h1>
            <Field label={t('New Password')} name="password" type="password" autoComplete="new-password" required minLength={8} maxLength={72} autoFocus />
            <Field label={t('Confirm New Password')} name="confirm" type="password" autoComplete="new-password" required minLength={8} maxLength={72} />
            <FormError error={error} />
            <button className="primary wide" disabled={busy}>{t('Change Password')}</button>
            <p className="switch"><Link to="/login">{t('Go back to login')}</Link></p>
          </form>
        )}
      </main>
    </div>
  )
}
