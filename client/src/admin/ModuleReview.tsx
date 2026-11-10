// Permission review of a staged module package (CONTRACT-v8 §2.1, §3, §9): everything the module may do, in plain language,
// before the admin installs or updates it. Approval is all or nothing: Install sends exactly the package's lists.
import { useEffect, useRef, useState } from 'react'
import { toast, toastError } from '../components/dialogs'
import { FormError } from '../components/ui'
import { t } from '../i18n'
import * as A from './api'
import { askCode, bytes, num, when } from './util'

/** Plain-language title and explanation per permission, written for an instance admin. */
export const PERMISSIONS: Record<string, [string, string]> = {
  commands: ['Commands', 'Adds its own commands and answers when people use them, and their buttons and forms.'],
  'messages.read': ['Read messages', 'Reads messages, edits, deletions and reactions in channels it can see, including older messages.'],
  'messages.send': ['Send messages', 'Sends messages and adds reactions where it may write. It can only edit or delete its own messages.'],
  'members.read': ['See members', 'Sees who joins, changes or leaves a server and can look up members.'],
  'roles.manage': ['Give and remove roles', 'Gives roles to members and takes them away, only roles below its own role.'],
  'channels.manage': ['Create and delete channels', 'Creates channels in the servers it is enabled on and deletes channels there.'],
  'voice.read': ['See voice activity', 'Sees who is in which voice channel.'],
  storage: ['Store data', 'Keeps its own data on this instance (at most 5 MB).'],
  'http.fetch': ['Contact websites', 'Sends requests to these websites, and only to these:'],
  'http.routes': ['Receive web requests', 'Anyone on the internet can send requests to its web address, for example webhooks from other services:'],
  ui: ['Show panels', 'Shows its own panels inside the app. Panels cannot read anyone’s account or the app’s data.'],
  schedule: ['Run on a schedule', 'Runs tasks at set times, even when nobody uses it.'],
}
export const SLOTS: Record<A.PanelSlot, string> = { channel_panel: 'Side panel in channels', guild_sidebar: 'Entry above the channel list', message_accessory: 'Under its own messages' }

/** The permission list with explanations; `added` ones are marked new, `hosts` and `httpUrl` are listed under their permission. */
export function PermissionList({ permissions, hosts, httpUrl, added = [] }: { permissions: string[]; hosts: string[]; httpUrl: string | null; added?: string[] }) {
  if (!permissions.length) return <p className="hint">{t('No permissions: it can only read its own settings and the servers it is enabled in.')}</p>
  return (
    <ul className="module-perms">
      {permissions.map((p) => {
        const [title, text] = PERMISSIONS[p] ?? [p, 'Unknown permission. This version of the app cannot explain it.']
        const isNew = added.includes(p)
        return (
          <li key={p} className={isNew ? 'new' : undefined}>
            <strong>{t(title)}</strong> <code>{p}</code>{isNew && <span className="admin-badge warn">{t('New')}</span>}
            <p>{t(text)}</p>
            {p === 'http.fetch' && <ul className="admin-list">{hosts.map((h) => <li key={h}><code>{h}</code></li>)}</ul>}
            {p === 'http.routes' && httpUrl && <p><code>{httpUrl}</code></p>}
          </li>
        )
      })}
    </ul>
  )
}

/** Review screen of a staged package; installs it, or applies it as an update of `update` (the installed module). */
export function ModuleReview({ pkg, update, onDone, onCancel }: { pkg: A.ModulePackage; update?: A.AdminModule; onDone: (m: A.AdminModule) => void; onCancel: () => void }) {
  const m = pkg.manifest
  const diff = pkg.update_of
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  const src = pkg.source
  const panels = m.ui?.panels ?? []
  const httpUrl = pkg.permissions.includes('http.routes') ? `/modules/${m.id}/http/` : null
  const approve = { permissions: pkg.permissions, http_hosts: pkg.http_hosts }
  const confirm = () => {
    setBusy(true)
    setError('')
    const name = m.name
    void A.elevated(
      (mfa) => (update ? A.updateModulePackage(update.id, pkg.package_id, approve, mfa) : A.installModule(pkg.package_id, approve, mfa)),
      () => askCode(update ? t('Update {name}?', { name }) : t('Install {name}?', { name }), <p>{t('Confirm with your own two-factor code.')}</p>, update ? t('Update') : t('Install')),
    ).then((r) => {
      setBusy(false)
      if (!r) return
      toast(update ? t('{name} was updated to {version}.', { name, version: r.version }) : t('{name} was installed. It starts disabled: enable it when you are ready.', { name }))
      onDone(r)
    }, (e: Error) => (setBusy(false), setError(e.message), toastError(e)))
  }
  return (
    <section aria-labelledby="review-h">
      <h2 id="review-h" ref={heading} tabIndex={-1}>{update ? t('Review the update of {name}', { name: m.name }) : t('Review {name} before installing', { name: m.name })}</h2>
      <dl className="admin-facts">
        <dt>{t('Module ID')}</dt><dd><code>{m.id}</code></dd>
        <dt>{t('Version')}</dt><dd>{diff ? t('{from} → {to}', { from: diff.from_version, to: m.version }) : m.version}</dd>
        {m.author && <><dt>{t('Author')}</dt><dd>{m.author}</dd></>}
        {m.description && <><dt>{t('Description')}</dt><dd>{m.description}</dd></>}
        {m.homepage && <><dt>{t('Homepage')}</dt><dd><code>{m.homepage}</code></dd></>}
        <dt>{t('Source')}</dt><dd><SourceText source={src} /></dd>
        <dt>{t('Package')}</dt><dd>{t('{n} files, {size}', { n: num(pkg.files), size: bytes(pkg.size) })}</dd>
        <dt>{t('Review until')}</dt><dd>{when(pkg.expires_at)}</dd>
      </dl>
      {pkg.warnings.length > 0 && (
        <div className="module-warnings" role="note" aria-label={t('Warnings')}>
          <h3>{t('Warnings')}</h3>
          <ul>{pkg.warnings.map((w) => <li key={w}>{w}</li>)}</ul>
        </div>
      )}
      <h3>{t('What it may do')}</h3>
      <p className="hint">{t('The module can do exactly this and nothing more. Approving is all or nothing.')}</p>
      <PermissionList permissions={pkg.permissions} hosts={pkg.http_hosts} httpUrl={httpUrl} added={diff?.added_permissions} />
      {diff && (diff.removed_permissions.length > 0 || diff.added_http_hosts.length > 0 || diff.removed_http_hosts.length > 0) && (
        <ul className="admin-list">
          {diff.removed_permissions.length > 0 && <li>{t('No longer asks for: {list}', { list: diff.removed_permissions.join(', ') })}</li>}
          {diff.added_http_hosts.length > 0 && <li className="module-added">{t('New websites: {list}', { list: diff.added_http_hosts.join(', ') })}</li>}
          {diff.removed_http_hosts.length > 0 && <li>{t('Websites no longer contacted: {list}', { list: diff.removed_http_hosts.join(', ') })}</li>}
        </ul>
      )}
      <h3>{t('Commands')}</h3>
      {m.commands?.length ? <ul className="admin-list">{m.commands.map((c) => <li key={c.name}><code>/{c.name}</code>{c.description && ` · ${c.description}`}</li>)}</ul> : <p className="hint">{t('None')}</p>}
      <h3>{t('Panels')}</h3>
      {panels.length ? <ul className="admin-list">{panels.map((p) => <li key={p.id}>{p.title} · {t(SLOTS[p.slot] ?? p.slot)}</li>)}</ul> : <p className="hint">{t('None')}</p>}
      <h3>{t('Web address')}</h3>
      <p>{httpUrl ? <code>{httpUrl}</code> : <span className="hint">{t('None')}</span>}</p>
      <FormError error={error} />
      <div className="admin-actions">
        <button className="primary admin-btn" disabled={busy} aria-busy={busy || undefined} onClick={confirm}>{update ? t('Approve and Update') : t('Approve and Install')}</button>
        <button className="secondary admin-btn" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
      </div>
    </section>
  )
}

export function SourceText({ source: s }: { source: A.ModuleSource }) {
  if (s.type === 'file') return <>{t('File {name}', { name: s.filename ?? '—' })}</>
  return <><code>{s.git_url}</code>{s.git_ref && <> · {s.git_ref}</>}{s.commit && <> · <code>{s.commit.slice(0, 12)}</code></>}</>
}
