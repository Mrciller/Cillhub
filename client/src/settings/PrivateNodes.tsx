// Settings › Private Nodes: the account's saved node list with each node's connection, and the `/add-node#<address>` page
// (one click to add). Connecting happens in instances/nodes.ts.
import { useEffect, useState, type FormEvent } from 'react'
import { hubOrigin, savedNodes, testNode } from '../api'
import { ask, toast, toastError } from '../components/dialogs'
import { FormError } from '../components/ui'
import { t } from '../i18n'
import { navigate } from '../router'
import { addLink, addNode, MAX_NODES, normalizeServerUrl, parseAddLink, type SavedNode } from '../privateNodes'
import { addPrivateNode, hubSession, removePrivateNode, signInWindow } from '../instances/nodes'
import { STATUS_TEXT } from '../instances/InstanceUI'
import { useInstances, useNodeIssues } from '../instances/registry'
import { useStore } from '../store'

const host = (url: string) => new URL(url).host
const REFUSED = { invalid: 'Enter only the server address, with https:// (http only for localhost), e.g. https://chat.example.org.', duplicate: 'This server is already in your list.', full: 'You can save up to {n} nodes.' }

const CONSENT = 'Cillhub signs you in there with your account here: the node gets your user name and avatar, never your password. Its servers then show up in your server list.'

/** Checks the address, asks (`confirm`, unless the add-node page already did), then adds it under the name the node gives
 *  itself; resolves the error text, '' when cancelled, or null. */
async function add(url: string, confirm = true): Promise<string | null> {
  const started = hubSession()
  const first = addNode(savedNodes(), url, '')
  if (!Array.isArray(first)) return t(REFUSED[first], { n: MAX_NODES })
  const origin = first.at(-1)!.origin
  if (origin === hubOrigin()) return t(REFUSED.duplicate)
  const info = await testNode(origin).catch(() => null)
  if (!info) return t('Could not connect to node at this address.')
  const name = info.name || host(origin)
  if (confirm && !(await ask({ title: t('Add {name}?', { name }), confirm: t('Add and sign in'),
    body: <><p className="add-node-address">{origin}</p><p>{t('This is a separate server with its own accounts and admins.')} {t(CONSENT)}</p></> }))) return ''
  try {
    const refused = await addPrivateNode(origin, name, started)
    return refused === 'cancelled' ? '' : refused && t(REFUSED[refused], { n: MAX_NODES })
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
}

export function PrivateNodes() {
  const [nodes, setNodes] = useState(savedNodes)
  const instances = Object.values(useInstances())
  const issues = useNodeIssues()
  const [live, setLive] = useState<Record<string, { name: string } | false>>({}) // checked once when the tab opens
  const [address, setAddress] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const hub = hubOrigin()

  const check = (url: string) => void testNode(url).then((i) => setLive((l) => ({ ...l, [url]: i })), () => setLive((l) => ({ ...l, [url]: false })))
  useEffect(() => [hub, ...savedNodes().map((n) => n.origin)].forEach(check), [hub])

  const submit = (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    const origin = normalizeServerUrl(address, true)
    void add(address).then((err) => {
      setBusy(false)
      if (err !== null) return setError(err)
      setNodes(savedNodes()) // the new node itself arrives with the gateway's list update
      setAddress('')
      if (origin) check(origin)
    })
  }
  const fromHub = useStore((s) => s.settings.private_nodes)
  useEffect(() => setNodes(savedNodes()), [instances.length, issues, fromHub]) // the gateway brings every list change
  const remove = (n: SavedNode, started = hubSession()) =>
    void ask({ title: t('Remove {name}?', { name: n.name }), confirm: t('Remove'), danger: true,
      body: <p>{t('{address} leaves the list on all your devices. Cillhub signs you out there and its servers leave your server list. Your account there stays as it is.', { address: n.origin })}</p> })
      .then((ok) => void (ok && removePrivateNode(n.origin, started).then(() => setNodes(savedNodes()), toastError)))
  const copy = (n: SavedNode) => void navigator.clipboard.writeText(addLink(hub, n.origin)).then(() => toast(t('Link copied.')), toastError)

  const row = (url: string, name: string, saved?: SavedNode) => {
    const status = live[url]
    const inst = saved && instances.find((i) => i.url === url)
    const issue = saved && issues[url]
    const state = inst && !issue ? t(STATUS_TEXT[inst.status])
      : issue?.why === 'own-login' ? t('Needs its own login · not connected')
      : issue?.why === 'sign-in' ? t('Not connected')
      : issue ? t('Not connected: {reason} Retrying…', { reason: issue.why })
      : saved && status !== false ? t('Connecting…') : null
    return (
      <li key={url} className="session node-row">
        <div className="session-text">
          <strong>{(status && status.name) || name}{!saved && <span className="node-tag">{t('Main Hub')}</span>}</strong>
          <span className="hint small">{url}</span>
          {state ? <span className={`hint small node-state ${inst?.status === 'ready' && !issue ? 'up' : issue ? 'down' : ''}`}>{state}</span> : (
            <span className={`hint small node-state ${status === undefined ? '' : status ? 'up' : 'down'}`}>
              {status === undefined ? t('Checking…') : status ? t('Reachable') : t('Not reachable')}
            </span>
          )}
        </div>
        {issue?.why === 'sign-in' && issue.node && <button className="link" onClick={() => void signInWindow(issue.node!).catch(toastError)}>{t('Sign in')}</button>}
        {saved && <button className="link" onClick={() => copy(saved)}>{t('Copy add link')}</button>}
        {saved && <button className="link danger-link" onClick={() => remove(saved)}>{t('Remove')}</button>}
      </li>
    )
  }

  return (
    <>
      <h1>{t('Private Nodes')}</h1>
      <p className="hint">{t('Private nodes you use besides the Main Hub, all connected at once. Each node is a separate server with its own accounts and admins. The list is saved with your account.')}</p>
      <ul className="sessions">
        {row(hub, host(hub))}
        {nodes.map((n) => row(n.origin, n.name, n))}
      </ul>
      {nodes.length === 0 && <p className="hint">{t('No private nodes saved yet.')}</p>}
      <form className="private-node-row" onSubmit={submit}>
        <input className="private-node-input" type="text" inputMode="url" aria-label={t('Node address')} placeholder="https://chat.example.org" value={address}
          onChange={(e) => (setAddress(e.target.value), setError(''))} />
        <button className="secondary private-node-btn" disabled={busy || !address.trim()}>{busy ? t('Checking…') : t('Add node')}</button>
      </form>
      <FormError error={error} />
    </>
  )
}

/** `<origin>/add-node#<node address>`: asks once and adds only on the click. */
export function AddNodePage() {
  const [url] = useState(() => parseAddLink(location.hash))
  const [info, setInfo] = useState<{ name: string } | null>(null)
  const [error, setError] = useState(url ? '' : t('This link does not contain a usable node address.'))
  const [added, setAdded] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => void (url && testNode(url).then(setInfo, () => setError(t('Could not connect to node at this address.')))), [url])

  const confirm = () => {
    setBusy(true)
    void add(url!, false).then((err) => (setBusy(false), err ? setError(err) : setAdded(true)))
  }
  const leave = () => navigate('/channels/@me', true)
  return (
    <div className="auth-bg">
      <main className="auth-card invite" role="dialog" aria-modal="true" aria-labelledby="add-node-title">
        <p className="sub">{added ? t('Node added') : t('Add a private node?')}</p>
        <h1 id="add-node-title">{info ? info.name || host(url!) : url ? host(url) : t('Invalid link')}</h1>
        {url && <p className="hint add-node-address">{url}</p>}
        {url && !added && <p className="hint">{t('This is a separate server with its own accounts and admins.')} {t(CONSENT)}</p>}
        <FormError error={error} />
        {added ? (
          <button className="primary wide" autoFocus onClick={leave}>{t('Done')}</button>
        ) : (
          <>
            {url && !error && <button className="primary wide" autoFocus disabled={busy || !info} onClick={confirm}>{t('Add and sign in')}</button>}
            <button className="secondary wide" onClick={leave}>{t('Cancel')}</button>
          </>
        )}
      </main>
    </div>
  )
}
