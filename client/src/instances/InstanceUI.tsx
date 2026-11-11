// UI for linked nodes (CONTRACT-v7 §4): the status line for a node server that is not usable right now, the "Add a server
// from another instance" form, the rail's node marker and the sign-in callback page.
import { useEffect, useState, type FormEvent } from 'react'
import { ask, toastError } from '../components/dialogs'
import { Field, FormError } from '../components/ui'
import { t } from '../i18n'
import { navigate } from '../router'
import { disconnectInstance, joinOnNode, nodeForInvite, signInCallback } from './nodes'
import { nodeOf, useInstances, type InstanceStatus, type Live } from './registry'
import './instances.css'

export const STATUS_TEXT: Record<InstanceStatus, string> = {
  connecting: 'Connecting…', ready: 'Connected', offline: 'Offline', suspended: 'Suspended by the hub', 'signed-out': 'Signed out', 'cut-off': 'Cut off: sent too much data',
}
/** The linked node a guild lives on (undefined for hub servers); re-renders when node status changes. */
export function useNode(guildId: string | undefined): Live | undefined {
  const all = useInstances()
  const id = nodeOf(guildId)
  return id ? all[id] : undefined
}

/** "Disconnect from <node>": asks, then removes the node's servers and its token. */
export const confirmDisconnect = (n: Live) =>
  void ask({ title: t('Disconnect from {name}?', { name: n.name }), confirm: t('Disconnect'), danger: true,
    body: <p>{t('Its servers disappear from your server list and Cillhub forgets your sign-in there. You stay a member and can add them again later.')}</p> })
    .then((ok) => ok && (disconnectInstance(n.id), navigate('/channels/@me')))

/** Shown in the connection bar while a node server is open and its instance is not connected. */
export function NodeStatus({ guildId }: { guildId?: string }) {
  const n = useNode(guildId)
  if (!n || n.status === 'ready') return null
  const text = n.status === 'offline' ? t('{name} is not reachable right now. Messages may be out of date; Cillhub keeps trying.', { name: n.name })
    : n.status === 'suspended' ? t('{name} was suspended or unlinked by the hub admins. Its servers are read-only here.', { name: n.name })
    : n.status === 'signed-out' ? t('{name} signed you out.', { name: n.name })
    : n.status === 'cut-off' ? t('{name} sent more data than Cillhub keeps for one server and was disconnected. It connects again on the next start.', { name: n.name })
    : t('Connecting to {name}…', { name: n.name })
  return (
    <span className="node-status">
      {text}
      {n.status === 'signed-out' && <button className="link" onClick={() => void joinOnNode(n, {}).catch(toastError)}>{t('Sign in again')}</button>}
      {(n.status === 'suspended' || n.status === 'signed-out' || n.status === 'cut-off') && <button className="link" onClick={() => confirmDisconnect(n)}>{t('Disconnect from instance')}</button>}
    </span>
  )
}

/** Small marker on node servers in the rail: the node's first letter, coloured by status. */
export const NodeMarker = ({ node }: { node: Live }) => <span className={`node-marker ${node.status}`} aria-hidden="true">{node.name.slice(0, 1).toUpperCase()}</span>

/** "Add a server from another instance": an invite link of a linked node → sign in there through the hub → join. */
export function AddFromInstance({ onDone }: { onDone: () => void }) {
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const link = String(new FormData(e.currentTarget).get('link')).trim()
    setError('')
    setBusy(true)
    nodeForInvite(link)
      .then((r) => {
        if (!r) throw new Error(t('Paste the full invite link of the other instance, e.g. https://chat.example.org/invite/abc.'))
        return joinOnNode(r.node, { invite: r.code })
      })
      .then(onDone, (err: Error) => (setError(err.message), setBusy(false)))
  }
  return (
    <form onSubmit={submit}>
      <h3>{t('Add a server from another instance')}</h3>
      <p className="hint small">{t('Servers on instances linked to this hub can be used with your account here. You sign in there once with this account; the other instance never sees your password.')}</p>
      <Field label={t('Invite link from another instance')} name="link" type="url" required placeholder="https://chat.example.org/invite/abc" />
      <FormError error={error} />
      <button className="secondary" disabled={busy}>{busy ? t('Waiting for sign-in…') : t('Sign in and join')}</button>
    </form>
  )
}

let fragment: string | null = null // read once (StrictMode runs effects twice in development)
/** "Other instances" in Add a server: every saved node with its status, so even one whose servers are gone can be removed. */
export function InstanceList() {
  const all = Object.values(useInstances())
  if (!all.length) return null
  return (
    <section aria-labelledby="inst-h">
      <h3 id="inst-h">{t('Your other instances')}</h3>
      <ul className="instance-list">
        {all.map((n) => (
          <li key={n.id}>
            <NodeMarker node={n} /> <span><strong>{n.name}</strong> <span className="hint small">{new URL(n.url).host} · {t(STATUS_TEXT[n.status])}</span></span>
            <button type="button" className="link" onClick={() => confirmDisconnect(n)} aria-label={t('Disconnect from {name}', { name: n.name })}>{t('Disconnect')}</button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** /instances/callback#token=…&state=…: the end of the node sign-in, in the popup or after a redirect. */
export function InstanceCallback() {
  const [msg, setMsg] = useState(t('Finishing sign-in…'))
  const [error, setError] = useState('')
  useEffect(() => {
    if (fragment !== null) return
    fragment = location.hash.slice(1)
    history.replaceState(null, '', location.pathname) // the token must not stay in the address bar or history
    const r = signInCallback(fragment)
    if (r === 'handed-over') return void (setMsg(t('Signed in. You can close this window.')), window.close())
    r.then((to) => navigate(to, true), (e: Error) => setError(e.message))
  }, [])
  return (
    <div className="auth-bg">
      <main className="auth-card" aria-labelledby="cb-h1">
        <h1 id="cb-h1">{t('Another instance')}</h1>
        {error ? <><FormError error={error} /><button className="primary" onClick={() => navigate('/channels/@me', true)}>{t('Back to Cillhub')}</button></> : <p role="status">{msg}</p>}
      </main>
    </div>
  )
}
