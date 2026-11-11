// Settings › Private Nodes: this device's saved node list and the `/add-node#<address>` page (one click to add).
import { useEffect, useState, type FormEvent } from 'react'
import { hubOrigin, savedNodes, saveNodes, testNode } from '../api'
import { ask, toast, toastError } from '../components/dialogs'
import { FormError } from '../components/ui'
import { t } from '../i18n'
import { navigate } from '../router'
import { addLink, addNode, MAX_NODES, parseAddLink, type SavedNode } from '../privateNodes'

const host = (url: string) => new URL(url).host
const REFUSED = { invalid: 'Enter only the server address, with https:// (http only for localhost), e.g. https://chat.example.org.', duplicate: 'This server is already in your list.', full: 'You can save up to {n} nodes.' }

/** Checks the address, then adds it under the name the node gives itself; resolves the error text or null. */
async function add(url: string): Promise<string | null> {
  const first = addNode(savedNodes(), url, '')
  if (!Array.isArray(first)) return t(REFUSED[first], { n: MAX_NODES })
  const origin = first.at(-1)!.origin
  if (origin === hubOrigin()) return t(REFUSED.duplicate)
  const info = await testNode(origin).catch(() => null)
  if (!info) return t('Could not connect to node at this address.')
  const list = addNode(savedNodes(), origin, info.name || host(origin))
  if (!Array.isArray(list)) return t(REFUSED[list], { n: MAX_NODES })
  saveNodes(list)
  return null
}

export function PrivateNodes() {
  const [nodes, setNodes] = useState(savedNodes)
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
    void add(address).then((err) => {
      setBusy(false)
      if (err) return setError(err)
      const list = savedNodes()
      setNodes(list)
      setAddress('')
      check(list.at(-1)!.origin)
    })
  }
  const remove = (n: SavedNode) =>
    void ask({ title: t('Remove {name}?', { name: n.name }), confirm: t('Remove'), danger: true, body: <p>{t('{address} leaves this list. Your account there stays as it is.', { address: n.origin })}</p> })
      .then((ok) => ok && (saveNodes(savedNodes().filter((x) => x.origin !== n.origin)), setNodes(savedNodes())))
  const copy = (n: SavedNode) => void navigator.clipboard.writeText(addLink(hub, n.origin)).then(() => toast(t('Link copied.')), toastError)

  const row = (url: string, name: string, saved?: SavedNode) => {
    const status = live[url]
    return (
      <li key={url} className="session node-row">
        <div className="session-text">
          <strong>{(status && status.name) || name}{!saved && <span className="node-tag">{t('Main Hub')}</span>}</strong>
          <span className="hint small">{url}</span>
          <span className={`hint small node-state ${status === undefined ? '' : status ? 'up' : 'down'}`}>
            {status === undefined ? t('Checking…') : status ? t('Reachable') : t('Not reachable')}
          </span>
        </div>
        {saved && <button className="link" onClick={() => copy(saved)}>{t('Copy add link')}</button>}
        {saved && <button className="link danger-link" onClick={() => remove(saved)}>{t('Remove')}</button>}
      </li>
    )
  }

  return (
    <>
      <h1>{t('Private Nodes')}</h1>
      <p className="hint">{t('Private nodes you use besides the Main Hub. Each node is a separate server with its own accounts and admins. The list stays on this device.')}</p>
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
    void add(url!).then((err) => (setBusy(false), err ? setError(err) : setAdded(true)))
  }
  const leave = () => navigate('/channels/@me', true)
  return (
    <div className="auth-bg">
      <main className="auth-card invite" role="dialog" aria-modal="true" aria-labelledby="add-node-title">
        <p className="sub">{added ? t('Node added') : t('Add a private node?')}</p>
        <h1 id="add-node-title">{info ? info.name || host(url!) : url ? host(url) : t('Invalid link')}</h1>
        {url && <p className="hint add-node-address">{url}</p>}
        {url && !added && <p className="hint">{t('This is a separate server with its own accounts and admins. Adding it only saves it to the list on this device.')}</p>}
        <FormError error={error} />
        {added ? (
          <button className="primary wide" autoFocus onClick={leave}>{t('Done')}</button>
        ) : (
          <>
            {url && !error && <button className="primary wide" autoFocus disabled={busy || !info} onClick={confirm}>{t('Add')}</button>}
            <button className="secondary wide" onClick={leave}>{t('Cancel')}</button>
          </>
        )}
      </main>
    </div>
  )
}
