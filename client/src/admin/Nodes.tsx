// Hub: Nodes page (CONTRACT-v7 §6). Linked instances with status, version and counts; link codes for new nodes; suspend,
// ban and unlink (ban/unlink ask for the admin's 2FA code); each node's admin audit trail; the update report each node sends
// with its heartbeat (automatic updates, latest version, last result) and a signed "update now" request (2FA).
import { useState } from 'react'
import { ask, askText, toast, toastError } from '../components/dialogs'
import { FormError, Modal } from '../components/ui'
import { t } from '../i18n'
import * as A from './api'
import { SearchBox, useSearch } from './Users'
import { askCode, num, useLoad, when } from './util'

const STATE: Record<A.NodeState, [string, string]> = { active: ['Active', ''], suspended: ['Suspended', 'warn'], banned: ['Banned', 'danger'], unlinked: ['Unlinked', ''] }
const AUTO: Record<A.AutoUpdateMode, string> = { off: 'Off', patch: 'Security and patch', all: 'All releases' }
const autoText = (u: A.NodeUpdateReport | null) =>
  !u ? '—' : !u.updater ? t('No updater') : !u.auto_update || u.auto_update === 'off' ? t('Off') : `${t(AUTO[u.auto_update])} · ${String(u.auto_update_hour ?? 0).padStart(2, '0')}:00 UTC`
// a newer release the node has seen in its signed feed but not installed
const behind = (n: A.AdminNode) => !!n.update?.latest_version && !!n.version && n.update.latest_version !== n.version
const RESULT: Record<string, string> = { done: 'Succeeded', failed: 'Failed', updating: 'Running', rolling_back: 'Rolling back', idle: 'Not started' }
const resultText = (r: NonNullable<A.NodeUpdateReport['last_result']>) =>
  `${r.action === 'rollback' ? t('Rollback') : t('Update')} ${r.version ?? ''} · ${t(RESULT[r.state ?? ''] ?? '—')}${r.rolled_back ? ` · ${t('previous version restored')}` : ''}${r.error ? `: ${r.error}` : ''}${r.at ? ` · ${when(r.at)}` : ''}`

export function Nodes() {
  const [text, query, setText] = useSearch()
  const all = useLoad(() => A.listNodes(), [])
  const codes = useLoad(A.listLinkCodes, [])
  const hub = useLoad(A.getHubFederation, [])
  const [open, setOpen] = useState<string | null>(null)
  const [fresh, setFresh] = useState<A.LinkCode | null>(null)
  const create = () => void A.createLinkCode().then((c) => (setFresh(c), void codes.reload()), toastError)
  const q = query.toLowerCase()
  const nodes = { ...all, data: all.data?.filter((n) => !q || n.name.toLowerCase().includes(q) || n.url.toLowerCase().includes(q)) ?? null }
  const node = nodes.data?.find((n) => n.node_id === open)
  // Shown at once; the server's answer (or the old value on failure) replaces it.
  const userCodes = (on: boolean) => {
    const before = hub.data
    if (before) hub.setData({ ...before, user_link_codes: on })
    A.setUserLinkCodes(on).then((r) => (hub.setData(r), toast(t('Saved.'))), (e) => (hub.setData(before), toastError(e)))
  }
  return (
    <>
      <section aria-labelledby="link-h">
        <h2 id="link-h">{t('Link codes')}</h2>
        <p className="hint">{t('A node admin pastes a link code in their setup wizard or Federation page to connect their instance to this hub. Each code works once, for 24 hours.')}</p>
        <button className="primary admin-btn" onClick={create}>{t('Create Link Code')}</button>
        {hub.data && (
          <label className="admin-check">
            <input type="checkbox" checked={hub.data.user_link_codes} onChange={(e) => userCodes(e.target.checked)} />{' '}
            {t('Hub users with two-factor authentication may create link codes (at most 3 unused each)')}
          </label>
        )}
        {fresh?.code && (
          <p className="admin-newcode" role="status">
            {t('New link code:')} <code>{fresh.code}</code> <button className="link" onClick={() => void navigator.clipboard.writeText(fresh.code!).then(() => toast(t('Copied.')))}>{t('Copy')}</button>
            <span className="hint small"> · {t('Expires {when}', { when: when(fresh.expires_at) })}</span>
          </p>
        )}
        <FormError error={codes.error} />
        {!!codes.data?.length && (
          <table className="admin-table">
            <caption className="sr-only">{t('Link codes')}</caption>
            <thead><tr><th scope="col">{t('Code')}</th><th scope="col">{t('Created')}</th><th scope="col">{t('Expires')}</th><th scope="col">{t('Used by')}</th><th scope="col"><span className="sr-only">{t('Actions')}</span></th></tr></thead>
            <tbody>{codes.data.map((c) => (
              <tr key={c.id}>
                <td><code>{c.id}</code>{c.note && <span className="hint small"> · {c.note}</span>} <span className="hint small">· {t(c.status === 'valid' ? 'Valid' : c.status === 'used' ? 'Used' : 'Expired')}</span></td>
                <td>{when(c.created_at)}</td><td>{when(c.expires_at)}</td><td>{c.node_id ? <code>{c.node_id}</code> : c.used_at ? t('Used') : '—'}</td>
                <td>{c.status === 'valid' && <button className="link" onClick={() => void A.deleteLinkCode(c.id).then(() => codes.reload(), toastError)} aria-label={t('Revoke {code}', { code: c.id })}>{t('Revoke')}</button>}</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </section>
      <section aria-labelledby="nodes-h">
        <h2 id="nodes-h">{t('Linked nodes')}</h2>
        <SearchBox label={t('Search by name or address')} value={text} onChange={setText} />
        <FormError error={nodes.error} />
        {nodes.data && (nodes.data.length ? (
          <div className="admin-scroll">
            <table className="admin-table">
              <caption className="sr-only">{t('Linked nodes')}</caption>
              <thead><tr>
                <th scope="col">{t('Name')}</th><th scope="col">{t('Status')}</th><th scope="col">{t('Version')}</th><th scope="col">{t('Automatic updates')}</th><th scope="col" className="num">{t('Users')}</th>
                <th scope="col" className="num">{t('Servers')}</th><th scope="col" className="num">{t('Public')}</th><th scope="col">{t('Last seen')}</th>
              </tr></thead>
              <tbody>{nodes.data.map((n) => (
                <tr key={n.node_id}>
                  <th scope="row"><button className="link" onClick={() => setOpen(n.node_id)}>{n.name}</button><br /><span className="hint small">{n.url}</span></th>
                  <td><span className={`admin-badge ${STATE[n.status][1]}`}>{t(STATE[n.status][0])}</span> {n.status === 'active' && <span className="hint small">{n.online ? t('Online') : t('Offline')}</span>}</td>
                  <td>{n.version ?? '—'}{behind(n) && <span className="hint small"> → {n.update!.latest_version}</span>}{n.update?.last_result?.state === 'failed' && <span className="admin-badge danger"> {t('Update failed')}</span>}</td>
                  <td>{autoText(n.update)}</td><td className="num">{num(n.users_count)}</td><td className="num">{num(n.servers_count)}</td><td className="num">{num(n.public_servers_count)}</td><td>{when(n.last_seen)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        ) : <p className="hint">{t('No nodes are linked yet.')}</p>)}
      </section>
      {node && <NodeDrawer node={node} onClose={() => setOpen(null)} onChanged={() => void all.reload()} />}
    </>
  )
}

function NodeDrawer({ node: n, onClose, onChanged }: { node: A.AdminNode; onClose: () => void; onChanged: () => void }) {
  const audit = useLoad(() => A.auditLog({ target_id: n.node_id }), [n.node_id])
  const done = (msg: string) => () => (toast(msg), onChanged(), void audit.reload())
  const suspend = () => void askText({ title: t('Suspend {name}?', { name: n.name }), label: t('Reason (shown in the audit log)'), confirm: t('Suspend'), danger: true,
    body: <p>{t('Its servers disappear from the directory and hub accounts can no longer sign in there until you lift the suspension.')}</p> })
    .then((reason) => void (reason !== null && A.suspendNode(n.node_id, reason).then(done(t('Node suspended.')), toastError)))
  const lift = () => void ask({ title: t('Lift the suspension of {name}?', { name: n.name }), confirm: t('Lift Suspension') })
    .then((ok) => void (ok && A.unsuspendNode(n.node_id).then(done(t('Suspension lifted.')), toastError)))
  const ban = () => void askText({ title: t('Ban {name}?', { name: n.name }), label: t('Reason (shown in the audit log)'), confirm: t('Continue'), danger: true,
    body: <p>{t('The node is unlinked and can never link again from this address. Hub sign-ins there stop at once.')}</p> })
    .then((reason) => reason !== null && askCode(t('Ban {name}?', { name: n.name }), <p>{t('Confirm with your own two-factor code.')}</p>, t('Ban Node'))
      .then((code) => void (code && A.banNode(n.node_id, reason, code).then(done(t('Node banned.')), toastError))))
  const requestUpdate = () => void askCode(t('Ask {name} to update now?', { name: n.name }),
    <p>{t('The node installs the release its signed feed offers, with a backup first and an automatic rollback if it does not start. Its admin can turn these requests off.')}</p>, t('Request Update'))
    .then((code) => void (code && A.requestNodeUpdate(n.node_id, code).then(({ result: r }) => {
      if (r.accepted) toast(t('The node started the update.'))
      else toastError(new Error(t('The node did not start the update: {reason}', { reason: r.message ?? (r.status ? `HTTP ${r.status}` : t('unreachable')) })))
      onChanged()
      void audit.reload()
    }, toastError)))
  const u = n.update
  const unlink = () => void askCode(t('Unlink {name}?', { name: n.name }), <p>{t('The node goes back to standalone. Its admin can link it again with a new code.')}</p>, t('Unlink'))
    .then((code) => void (code && A.unlinkNode(n.node_id, code).then(() => (toast(t('Node unlinked.')), onChanged(), onClose()), toastError)))
  return (
    <Modal title={t('Node {name}', { name: n.name })} onClose={onClose} className="admin-drawer">
      <dl className="admin-facts">
        <dt>{t('Node ID')}</dt><dd><code>{n.node_id}</code></dd>
        <dt>{t('Address')}</dt><dd>{n.url}</dd>
        <dt>{t('Description')}</dt><dd>{n.description || '—'}</dd>
        <dt>{t('Status')}</dt><dd>{t(STATE[n.status][0])}{n.status_reason && ` · ${n.status_reason}`}</dd>
        <dt>{t('Online')}</dt><dd>{n.online ? t('Yes') : t('No')}</dd>
        <dt>{t('Version')}</dt><dd>{n.version ?? '—'}</dd>
        <dt>{t('Linked')}</dt><dd>{when(n.linked_at)}</dd>
        <dt>{t('Last seen')}</dt><dd>{when(n.last_seen)}</dd>
        <dt>{t('Users')}</dt><dd>{num(n.users_count)} ({t('{n} members in public servers', { n: num(n.member_count) })})</dd>
        <dt>{t('Servers')}</dt><dd>{num(n.servers_count)} ({t('{n} public', { n: num(n.public_servers_count) })})</dd>
        <dt>{t('Mode')}</dt><dd>{n.mode === 'connected' ? t('Connected') : t('Standalone')}</dd>
        <dt>{t('Latest release seen')}</dt><dd>{u?.latest_version ?? '—'}{behind(n) && ` (${t('update available')})`}</dd>
        <dt>{t('Automatic updates')}</dt><dd>{autoText(u)}</dd>
        <dt>{t('Remote update requests')}</dt><dd>{u ? (u.remote_update ? t('Allowed') : t('Turned off by the node')) : '—'}</dd>
        <dt>{t('Last update')}</dt><dd>{u?.last_result ? resultText(u.last_result) : '—'}</dd>
        {u?.last_auto?.decision && <><dt>{t('Last automatic run')}</dt><dd>{when(u.last_auto.at)} · {u.last_auto.decision}</dd></>}
        <dt>{t('Last report')}</dt><dd>{when(u?.reported_at)}</dd>
      </dl>
      <div className="admin-actions" role="group" aria-label={t('Node actions')}>
        {n.status === 'active' && u?.updater && u.remote_update && <button className="secondary admin-btn" onClick={requestUpdate}>{t('Request Update')}</button>}
        {n.status === 'active' && <button className="secondary admin-btn" onClick={suspend}>{t('Suspend')}</button>}
        {n.status === 'suspended' && <button className="secondary admin-btn" onClick={lift}>{t('Lift Suspension')}</button>}
        {(n.status === 'active' || n.status === 'suspended') && <button className="secondary admin-btn" onClick={unlink}>{t('Unlink')}</button>}
        {n.status !== 'banned' && <button className="danger-btn" onClick={ban}>{t('Ban Node')}</button>}
      </div>
      <h3>{t('Audit Log')}</h3>
      <FormError error={audit.error} />
      {audit.data?.length ? (
        <ul className="admin-list">{audit.data.map((e) => <li key={e.id}>{when(e.created_at)} · <code>{e.action}</code> {e.admin_id && <>· <code>{e.admin_id}</code></>}{e.details?.reason ? ` · ${String(e.details.reason)}` : ''}</li>)}</ul>
      ) : audit.data && <p className="hint">{t('No entries.')}</p>}
      <div className="modal-actions"><button className="secondary" onClick={onClose}>{t('Close')}</button></div>
    </Modal>
  )
}
