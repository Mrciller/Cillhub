// Servers: search, table, detail drawer (settings, roles, channel names, invites, bans, audit log; no message content) and
// actions: transfer ownership, disable/enable invites, delete (confirmed by typing the server name, then a 2FA code).
import { useState } from 'react'
import { ask, askText, toast, toastError } from '../components/dialogs'
import { FormError, Modal } from '../components/ui'
import { t } from '../i18n'
import { ACTIONS } from '../settings/AuditLog'
import * as A from './api'
import { SearchBox, usePaged, useSearch } from './Users'
import { askCode, askReasons, bytes, num, useLoad, when } from './util'

const TYPES: Record<number, string> = { 0: 'Text', 2: 'Voice', 4: 'Category', 5: 'Announcement', 13: 'Stage', 15: 'Forum' }

export function Servers() {
  const [text, query, setText] = useSearch()
  const { list, loaded, error, reload, more } = usePaged(A.listGuilds, query)
  const [open, setOpen] = useState<string | null>(null)
  return (
    <>
      <SearchBox label={t('Search by server name')} value={text} onChange={setText} />
      <FormError error={error} />
      {loaded && <p className="hint small" role="status">{t('{n} servers shown', { n: num(list.length) })}</p>}
      <div className="admin-scroll">
        <table className="admin-table">
          <caption className="sr-only">{t('Servers')}</caption>
          <thead><tr>
            <th scope="col">{t('Name')}</th><th scope="col">{t('Owner')}</th><th scope="col" className="num">{t('Members')}</th><th scope="col" className="num">{t('Channels')}</th>
            <th scope="col">{t('Created')}</th><th scope="col" className="num">{t('Messages')}</th><th scope="col" className="num">{t('Storage')}</th><th scope="col">{t('Invites')}</th>
          </tr></thead>
          <tbody>
            {list.map((g) => (
              <tr key={g.id}>
                <th scope="row"><button className="link" onClick={() => setOpen(g.id)}>{g.name}</button></th>
                <td>{g.owner?.username ?? '—'}</td><td className="num">{num(g.member_count)}</td><td className="num">{num(g.channel_count)}</td><td>{when(g.created_at)}</td>
                <td className="num">{num(g.message_count)}</td><td className="num">{bytes(g.storage_bytes)}</td><td>{g.invites_disabled ? <span className="admin-badge danger">{t('Disabled')}</span> : t('On')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {more && <button className="secondary admin-btn" onClick={more}>{t('Load more')}</button>}
      {open && <ServerDrawer id={open} onClose={() => setOpen(null)} onChanged={() => void reload()} />}
    </>
  )
}

function ServerDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const { data: g, error, reload } = useLoad(() => A.getGuild(id), [id])
  const run = (p: Promise<unknown>, done: string) => p.then(() => (toast(done), reload(), onChanged()), toastError)
  const transfer = () => void askText({ title: t('Transfer Ownership'), label: t('User ID of the new owner'), confirm: t('Continue'), danger: true,
    body: <p>{t('The new owner must already be a member of {name}.', { name: g!.name })}</p> })
    .then((to) => to && askCode(t('Transfer Ownership'), <p>{t('Confirm with your own two-factor code.')}</p>, t('Transfer Ownership'))
      .then((code) => void (code && run(A.transferGuild(id, to.trim(), code), t('Ownership transferred.')))))
  const invites = () => {
    const off = g!.invites_disabled
    void ask({ title: off ? t('Enable invites?') : t('Disable invites?'), body: <p>{off ? t('Members with permission can create and use invites again.') : t('Nobody can join {name} through an invite until you enable them again. Existing members stay.', { name: g!.name })}</p>, confirm: off ? t('Enable Invites') : t('Disable Invites'), danger: !off })
      .then((ok) => void (ok && run(A.setInvitesDisabled(id, !off), off ? t('Invites enabled.') : t('Invites disabled.'))))
  }
  const remove = () => void askText({ title: t('Delete {name}?', { name: g!.name }), label: t('Type the server name to confirm'), confirm: t('Continue'), danger: true,
    body: <p>{t('All channels, messages and uploads of this server are deleted for everyone. This cannot be undone.')}</p> })
    .then((typed) => {
      if (typed === null) return
      if (typed.trim() !== g!.name) return void toast(t('The name did not match. Nothing was deleted.'))
      return askReasons(t('Delete {name}?', { name: g!.name }), t('Continue')).then((why) => why && askCode(t('Delete {name}?', { name: g!.name }), <p>{t('Confirm with your own two-factor code.')}</p>, t('Delete Server')).then((code) =>
        void (code && A.deleteGuild(id, typed.trim(), code, why).then(() => (toast(t('Server deleted.')), onChanged(), onClose()), toastError))))
    })

  return (
    <Modal title={g ? t('Server {name}', { name: g.name }) : t('Server')} onClose={onClose} className="admin-drawer">
      <FormError error={error} />
      {g && (
        <>
          <dl className="admin-facts">
            <dt>{t('Server ID')}</dt><dd><code>{g.id}</code></dd>
            <dt>{t('Owner')}</dt><dd>{g.owner ? <>{g.owner.username} (<code>{g.owner.id}</code>)</> : '—'}</dd>
            <dt>{t('Description')}</dt><dd>{g.description || '—'}</dd>
            <dt>{t('Created')}</dt><dd>{when(g.created_at)}</dd>
            <dt>{t('Members')}</dt><dd>{num(g.member_count)}</dd>
            <dt>{t('Messages')}</dt><dd>{num(g.message_count)}</dd>
            <dt>{t('Storage')}</dt><dd>{bytes(g.storage_bytes)}</dd>
            <dt>{t('Emoji and stickers')}</dt><dd>{g.emoji_count} / {g.sticker_count}</dd>
            <dt>{t('Verification level')}</dt><dd>{g.settings.verification_level ?? 0}</dd>
            <dt>{t('Features')}</dt><dd>{g.settings.features?.join(', ') || '—'}</dd>
          </dl>
          <div className="admin-actions" role="group" aria-label={t('Server actions')}>
            <button className="secondary admin-btn" onClick={transfer}>{t('Transfer Ownership')}</button>
            <button className="secondary admin-btn" onClick={invites}>{g.invites_disabled ? t('Enable Invites') : t('Disable Invites')}</button>
            <button className="danger-btn" onClick={remove}>{t('Delete Server')}</button>
          </div>
          <h3>{t('Roles')}</h3>
          <ul className="admin-list">{[...g.roles].sort((a, b) => b.position - a.position).map((r) => <li key={r.id}>{r.name}</li>)}</ul>
          <h3>{t('Channels')}</h3>
          <table className="admin-table"><caption className="sr-only">{t('Channels')}</caption>
            <thead><tr><th scope="col">{t('Name')}</th><th scope="col">{t('Type')}</th></tr></thead>
            <tbody>{g.channels.map((c) => <tr key={c.id}><td>{c.name}</td><td>{t(TYPES[c.type] ?? 'Other')}</td></tr>)}</tbody>
          </table>
          <h3>{t('Invites')}</h3>
          {g.invites.length ? (
            <table className="admin-table"><caption className="sr-only">{t('Invites')}</caption>
              <thead><tr><th scope="col">{t('Code')}</th><th scope="col">{t('Created by')}</th><th scope="col" className="num">{t('Uses')}</th><th scope="col">{t('Expires')}</th></tr></thead>
              <tbody>{g.invites.map((i) => <tr key={i.code}><td><code>{i.code}</code></td><td>{i.inviter_id ? <code>{i.inviter_id}</code> : '—'}</td><td className="num">{i.uses}{i.max_uses ? ` / ${i.max_uses}` : ''}</td><td>{i.expires_at ? when(i.expires_at) : t('Never')}</td></tr>)}</tbody>
            </table>
          ) : <p className="hint">{t('None')}</p>}
          <h3>{t('Bans')}</h3>
          {g.bans.length ? <ul className="admin-list">{g.bans.map((b) => <li key={b.user.id}>{b.user.username}{b.reason && ` · ${b.reason}`}</li>)}</ul> : <p className="hint">{t('None')}</p>}
          <h3>{t('Audit Log')}</h3>
          {g.audit_log.length ? (
            <ul className="admin-list">{g.audit_log.map((e) => (
              <li key={e.id}><code>{e.user_id ?? '—'}</code> {t(ACTIONS[e.action_type]?.[0] ?? 'did something')} {e.target_id && <code>{e.target_id}</code>}{e.reason && ` · ${e.reason}`}</li>
            ))}</ul>
          ) : <p className="hint">{t('No entries.')}</p>}
        </>
      )}
      <div className="modal-actions"><button className="secondary" onClick={onClose}>{t('Close')}</button></div>
    </Modal>
  )
}
