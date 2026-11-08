// Node: Federation page (CONTRACT-v7 §6). Mode, hub connection status, link with a code / unlink (2FA code), and which
// sign-in methods this instance allows (local accounts, hub accounts, both).
import { useState, type FormEvent } from 'react'
import { toast, toastError } from '../components/dialogs'
import { Field, FormError } from '../components/ui'
import { DEFAULT_HUB_URL } from '../hub'
import { t } from '../i18n'
import * as A from './api'
import { askCode, useLoad, when } from './util'

const HUB_STATUS: Record<A.Federation['hub_status'], [string, string]> = {
  linked: ['Linked', ''], unlinked: ['Not linked', ''], suspended: ['Suspended by the hub', 'warn'], banned: ['Banned by the hub', 'danger'], unreachable: ['Hub not reachable', 'warn'],
}
const SIGN_IN: [A.Federation['sign_in'], string, string][] = [
  ['both', 'Local and hub accounts', 'People can register here or sign in with their hub account.'],
  ['local', 'Local accounts only', 'Hub accounts cannot sign in here.'],
  ['hub', 'Hub accounts only', 'New people sign in with their hub account; existing local accounts keep working.'],
]

export function FederationPage() {
  const { data: f, error, setData } = useLoad(A.getFederation, [])
  const [linkError, setLinkError] = useState('')
  const [busy, setBusy] = useState(false)
  if (error) return <FormError error={error} />
  if (!f) return <p className="hint" aria-busy="true">{t('Loading…')}</p>
  const link = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const d = new FormData(e.currentTarget)
    setBusy(true)
    setLinkError('')
    A.linkHub(String(d.get('hub_url')).trim(), String(d.get('link_code')).trim())
      .then((r) => (setData(r), toast(t('Linked to the hub.'))), (err: Error) => setLinkError(err.message)).finally(() => setBusy(false))
  }
  const unlink = () => void askCode(t('Unlink from the hub?'), <p>{t('Hub accounts can no longer sign in here and your public servers leave the hub directory. Linked accounts stay, but can only sign in again after you link again.')}</p>, t('Unlink'))
    .then((code) => void (code && A.unlinkHub(code).then((r) => (setData(r), toast(t('Unlinked. This instance is standalone now.'))), toastError)))
  // Shown at once; the server's answer (or the old value on failure) replaces it.
  const save = (patch: Partial<Pick<A.Federation, 'sign_in' | 'update_check'>>) => (setData({ ...f, ...patch }), void A.patchFederation(patch).then((r) => (setData(r), toast(t('Saved.'))), (e) => (setData(f), toastError(e))))
  const [label, tone] = HUB_STATUS[f.hub_status]
  return (
    <>
      <dl className="admin-facts">
        <dt>{t('Mode')}</dt><dd>{f.mode === 'connected' ? t('Connected') : t('Standalone')}</dd>
        <dt>{t('Hub')}</dt><dd>{f.hub_url ?? '—'}</dd>
        <dt>{t('Hub connection')}</dt><dd><span className={`admin-badge ${tone}`} role="status">{t(label)}</span></dd>
        <dt>{t('Last heartbeat')}</dt><dd>{when(f.last_heartbeat)}{f.last_error && <span className="hint small"> · {f.last_error}</span>}</dd>
        {f.node_id && <><dt>{t('Node ID')}</dt><dd><code>{f.node_id}</code></dd></>}
      </dl>
      {f.mode === 'connected' ? (
        <div className="admin-actions"><button className="danger-btn" onClick={unlink}>{t('Unlink from Hub')}</button></div>
      ) : (
        <form className="admin-form" onSubmit={link} aria-labelledby="fed-link-h">
          <h2 id="fed-link-h">{t('Connect to a hub')}</h2>
          <p className="hint">{t('Ask a hub admin for a link code (hub admin dashboard → Nodes). Connected, hub accounts can sign in here and your public servers can be listed in the hub directory. No other data is shared.')}</p>
          <Field label={t('Hub address')} name="hub_url" type="url" required defaultValue={f.hub_url ?? ''} placeholder={DEFAULT_HUB_URL} />
          <Field label={t('Link code')} name="link_code" required autoComplete="off" spellCheck={false} />
          <FormError error={linkError} />
          <button className="primary admin-btn" disabled={busy}>{t('Link')}</button>
        </form>
      )}
      <fieldset className="admin-reasons" disabled={f.mode !== 'connected'}>
        <legend>{t('Sign-in methods')}</legend>
        {SIGN_IN.map(([k, label, hint]) => (
          <div key={k} className="admin-radio">
            <input id={`signin-${k}`} type="radio" name="sign_in" checked={f.sign_in === k} onChange={() => save({ sign_in: k })} aria-describedby={`signin-${k}-hint`} />
            <label htmlFor={`signin-${k}`}><strong>{t(label)}</strong></label> <span id={`signin-${k}-hint`} className="hint small">{t(hint)}</span>
          </div>
        ))}
        {f.mode !== 'connected' && <p className="hint small">{t('Standalone instances only have local accounts.')}</p>}
      </fieldset>
    </>
  )
}
