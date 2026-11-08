// Admin › Modules (CONTRACT-v8 §2, §9): installed modules with status and an enabled switch; Install from a file or a Git
// URL, which stages the package and opens the permission review; a detail view with Overview, Servers, Settings, Logs,
// Update and Remove. Install, update and remove ask for a 2FA code (elevation header, api.ts → elevated()).
import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ask, toast, toastError } from '../components/dialogs'
import { cls, FormError } from '../components/ui'
import { t } from '../i18n'
import * as A from './api'
import { ModuleReview, PermissionList, SourceText } from './ModuleReview'
import { GuildPick, ModuleSettings } from './ModuleSettings'
import { askCode, bytes, num, useLoad, when } from './util'

type View = { kind: 'list' } | { kind: 'install' } | { kind: 'review'; pkg: A.ModulePackage; update?: A.AdminModule } | { kind: 'detail'; id: string }

const STATUS: Record<A.ModuleStatus, string> = { disabled: 'Disabled', starting: 'Starting', running: 'Running', restarting: 'Restarting', crashed: 'Crashed' }
const StatusBadge = ({ m }: { m: A.AdminModule }) => (
  <>
    <span className={cls('admin-badge', m.status === 'crashed' ? 'danger' : m.status === 'running' ? 'ok' : m.status === 'restarting' ? 'warn' : undefined)}>{t(STATUS[m.status] ?? m.status)}</span>
    {m.status_reason && <span className="hint small"> {m.status_reason}</span>}
  </>
)

export function ModulesPage() {
  const [view, setView] = useState<View>({ kind: 'list' })
  const list = () => setView({ kind: 'list' })
  if (view.kind === 'install') return <Install onStaged={(pkg) => setView({ kind: 'review', pkg })} onCancel={list} />
  if (view.kind === 'review') return <ModuleReview pkg={view.pkg} update={view.update} onCancel={() => setView(view.update ? { kind: 'detail', id: view.update.id } : { kind: 'list' })} onDone={(m) => setView({ kind: 'detail', id: m.id })} />
  if (view.kind === 'detail') return <Detail id={view.id} onBack={list} onReview={(pkg, update) => setView({ kind: 'review', pkg, update })} />
  return <ModuleList onOpen={(id) => setView({ kind: 'detail', id })} onInstall={() => setView({ kind: 'install' })} />
}

const setEnabled = (m: A.AdminModule, enabled: boolean) => A.patchModule(m.id, { enabled })

function ModuleList({ onOpen, onInstall }: { onOpen: (id: string) => void; onInstall: () => void }) {
  const { data, error, reload } = useLoad(A.listModules, [])
  return (
    <>
      <p className="hint">{t('Modules add commands, panels and automations to every server of this instance, or to the servers you choose. Each one may only do what you approve when you install it.')}</p>
      <div className="admin-actions"><button className="primary admin-btn" onClick={onInstall}>{t('Install Module')}</button><button className="link" onClick={() => void reload()}>{t('Refresh')}</button></div>
      <FormError error={error} />
      {data && !data.length && <p className="hint">{t('No modules installed yet.')}</p>}
      {data && data.length > 0 && (
        <div className="admin-scroll">
          <table className="admin-table">
            <caption className="sr-only">{t('Modules')}</caption>
            <thead><tr><th scope="col">{t('Name')}</th><th scope="col">{t('Version')}</th><th scope="col">{t('Status')}</th><th scope="col">{t('Enabled')}</th></tr></thead>
            <tbody>
              {data.map((m) => (
                <tr key={m.id}>
                  <th scope="row"><button className="link" onClick={() => onOpen(m.id)}>{m.name}</button> <code className="hint small">{m.id}</code></th>
                  <td>{m.version}</td>
                  <td><StatusBadge m={m} /></td>
                  <td><input type="checkbox" role="switch" checked={m.enabled} aria-label={t('Enable {name}', { name: m.name })}
                    onChange={(e) => void setEnabled(m, e.target.checked).then(() => void reload(), toastError)} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

/** Upload a .zip/.tgz or fetch a Git repository; both stage the package and open the review. `moduleId` makes it an update. */
function PackageForms({ moduleId, onStaged }: { moduleId?: string; onStaged: (pkg: A.ModulePackage) => void }) {
  const id = useId()
  const [file, setFile] = useState<File | null>(null)
  const [url, setUrl] = useState('')
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const run = (label: string, p: () => Promise<A.ModulePackage>) => {
    setBusy(label)
    setError('')
    p().then((pkg) => (setBusy(''), onStaged(pkg)), (e: Error) => (setBusy(''), setError(e.message)))
  }
  const upload = (e: FormEvent) => (e.preventDefault(), file && run(t('Uploading and checking the package…'), () => A.stageFile(file, moduleId)))
  const git = (e: FormEvent) => (e.preventDefault(), url.trim() && run(t('Fetching the repository…'), () => A.stageGit(url.trim(), ref.trim() || undefined)))
  return (
    <>
      <form className="admin-form" onSubmit={upload} aria-labelledby={id + 'f'}>
        <h3 id={id + 'f'}>{t('From a file')}</h3>
        <div className="field">
          <label htmlFor={id + 'file'}>{t('Package (.zip or .tgz, at most 5 MB)')}</label>
          <input id={id + 'file'} type="file" className="input" accept=".zip,.tgz,.tar.gz,application/zip,application/gzip" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <button type="submit" className="primary admin-btn" disabled={!file || !!busy}>{t('Upload and Review')}</button>
      </form>
      {!moduleId && (
        <form className="admin-form" onSubmit={git} aria-labelledby={id + 'g'}>
          <h3 id={id + 'g'}>{t('From a Git repository')}</h3>
          <div className="field">
            <label htmlFor={id + 'url'}>{t('Git URL (https://)')}</label>
            <input id={id + 'url'} type="url" className="input" required maxLength={300} placeholder="https://git.example.com/me/module.git" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={id + 'ref'}>{t('Branch or tag (optional)')}</label>
            <input id={id + 'ref'} className="input" maxLength={100} pattern="[A-Za-z0-9._/\-]{1,100}" value={ref} onChange={(e) => setRef(e.target.value)} />
          </div>
          <button type="submit" className="primary admin-btn" disabled={!url.trim() || !!busy}>{t('Fetch and Review')}</button>
        </form>
      )}
      <p role="status" aria-live="polite" className="hint">{busy}</p>
      <FormError error={error} />
    </>
  )
}

function CatalogSection({ onStaged }: { onStaged: (pkg: A.ModulePackage) => void }) {
  const { data: catalog, error } = useLoad(A.getModuleCatalog, [])
  const [busy, setBusy] = useState<string | null>(null)
  const install = (id: string) => {
    setBusy(id)
    A.installFromCatalog(id).then(
      (pkg) => { setBusy(null); onStaged(pkg) },
      (e: Error) => { setBusy(null); toastError(e) },
    )
  }
  return (
    <div className="admin-form" style={{ marginTop: '1.5rem', marginBottom: '1.5rem' }}>
      <h3>{t('Public Module Catalog')}</h3>
      <p className="hint">{t('Verified modules from the Cillhub Network directory ready to install in one click.')}</p>
      <FormError error={error} />
      {catalog && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '1rem', marginTop: '0.75rem' }}>
          {catalog.map((m) => (
            <div key={m.id} style={{ border: '1px solid var(--border-subtle, #333)', borderRadius: 8, padding: '1rem', background: 'var(--bg-secondary, #222)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <strong>{m.name}</strong>
                <span className="admin-badge ok" style={{ fontSize: '0.75rem' }}>{t('Verified')}</span>
              </div>
              <p className="hint small" style={{ margin: '0.5rem 0' }}>{m.description}</p>
              <div style={{ display: 'flex', gap: '0.25rem', flexWrap: 'wrap', margin: '0.5rem 0' }}>
                {m.permissions.map((p) => (
                  <span key={p} style={{ fontSize: '0.7rem', padding: '2px 6px', background: 'rgba(255,255,255,0.08)', borderRadius: 4 }}>{p}</span>
                ))}
              </div>
              <button
                type="button"
                className="primary admin-btn"
                style={{ width: '100%', marginTop: '0.5rem' }}
                disabled={busy === m.id}
                onClick={() => install(m.id)}
              >
                {busy === m.id ? t('Staging…') : t('Install & Review')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Install({ onStaged, onCancel }: { onStaged: (pkg: A.ModulePackage) => void; onCancel: () => void }) {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  return (
    <section aria-labelledby="install-h">
      <h2 id="install-h" ref={heading} tabIndex={-1}>{t('Install a module')}</h2>
      <p className="hint">{t('Nothing is installed yet: the package is checked first and you review what it may do.')}</p>
      <CatalogSection onStaged={onStaged} />
      <PackageForms onStaged={onStaged} />
      <button className="secondary admin-btn" onClick={onCancel}>{t('Back to Modules')}</button>
    </section>
  )
}

const TABS = [['overview', 'Overview'], ['servers', 'Servers'], ['settings', 'Settings'], ['logs', 'Logs'], ['update', 'Update'], ['remove', 'Remove']] as const
type Tab = (typeof TABS)[number][0]

function Detail({ id, onBack, onReview }: { id: string; onBack: () => void; onReview: (pkg: A.ModulePackage, update: A.AdminModule) => void }) {
  const { data: m, error, setData } = useLoad(() => A.getModule(id), [id])
  const [tab, setTab] = useState<Tab>('overview')
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => heading.current?.focus(), [])
  return (
    <section aria-labelledby="module-h">
      <button className="link" onClick={onBack}>{t('← All modules')}</button>
      <h2 id="module-h" ref={heading} tabIndex={-1}>{m ? `${m.name} ${m.version}` : t('Module')}</h2>
      <FormError error={error} />
      {m && (
        <>
          <p><StatusBadge m={m} /></p>
          <div className="admin-tabs" role="group" aria-label={t('Module sections')}>
            {TABS.map(([k, label]) => <button key={k} className={cls('admin-tab', tab === k && 'on')} aria-pressed={tab === k} onClick={() => setTab(k)}>{t(label)}</button>)}
          </div>
          {tab === 'overview' && <Overview m={m} onChange={setData} />}
          {tab === 'servers' && <Servers m={m} onChange={setData} />}
          {tab === 'settings' && <ModuleSettings m={m} onChange={setData} />}
          {tab === 'logs' && <Logs m={m} />}
          {tab === 'update' && <Update m={m} onReview={(pkg) => onReview(pkg, m)} />}
          {tab === 'remove' && <Remove m={m} onRemoved={onBack} />}
        </>
      )}
    </section>
  )
}

function Overview({ m, onChange }: { m: A.AdminModule; onChange: (m: A.AdminModule) => void }) {
  const s = m.stats
  const restart = () => void A.restartModule(m.id).then((r) => (onChange(r), toast(t('Restarted.'))), toastError)
  return (
    <>
      <label className="admin-check"><input type="checkbox" role="switch" checked={m.enabled} onChange={(e) => void setEnabled(m, e.target.checked).then(onChange, toastError)} /> {t('Enabled')}</label>
      <dl className="admin-facts">
        <dt>{t('Module ID')}</dt><dd><code>{m.id}</code></dd>
        <dt>{t('Version')}</dt><dd>{m.version}</dd>
        {m.description && <><dt>{t('Description')}</dt><dd>{m.description}</dd></>}
        {m.author && <><dt>{t('Author')}</dt><dd>{m.author}</dd></>}
        <dt>{t('Source')}</dt><dd><SourceText source={m.source} /></dd>
        <dt>{t('Application ID')}</dt><dd><code>{m.application_id}</code></dd>
        <dt>{t('Installed')}</dt><dd>{when(m.installed_at)}</dd>
        <dt>{t('Updated')}</dt><dd>{when(m.updated_at)}</dd>
        <dt>{t('Running since')}</dt><dd>{when(s.started_at)}</dd>
        <dt>{t('Events handled')}</dt><dd>{num(s.events)}</dd>
        <dt>{t('Errors')}</dt><dd>{num(s.errors)}</dd>
        <dt>{t('Crashes / restarts')}</dt><dd>{num(s.crashes)} / {num(s.restarts)}</dd>
        <dt>{t('Last error')}</dt><dd>{s.last_error ? <><code>{s.last_error}</code> · {when(s.last_error_at)}</> : '—'}</dd>
        <dt>{t('Storage')}</dt><dd>{t('{used} of {quota}', { used: bytes(m.storage.used_bytes), quota: bytes(m.storage.quota_bytes) })}</dd>
        {m.http_url && <><dt>{t('Web address')}</dt><dd><code>{m.http_url}</code></dd></>}
      </dl>
      <div className="admin-actions"><button className="secondary admin-btn" disabled={!m.enabled} onClick={restart}>{t('Restart')}</button></div>
      <h3>{t('Approved permissions')}</h3>
      <PermissionList permissions={m.permissions} hosts={m.http_hosts} httpUrl={m.http_url} />
    </>
  )
}

function Servers({ m, onChange }: { m: A.AdminModule; onChange: (m: A.AdminModule) => void }) {
  const [scope, setScope] = useState(m.scope)
  const [chosen, setChosen] = useState<{ id: string; name: string }[]>(m.guild_ids.map((id) => ({ id, name: id })))
  // Names for the stored ids come from the server list (shortcut: only its first page of 50, else the id is shown).
  useEffect(() => void A.listGuilds('').then((gs) => setChosen((c) => c.map((x) => ({ ...x, name: gs.find((g) => g.id === x.id)?.name ?? x.name }))), () => {}), [])
  const save = () => void A.patchModule(m.id, { scope, ...(scope === 'guilds' && { guild_ids: chosen.map((g) => g.id) }) }).then((r) => (onChange(r), toast(t('Saved.'))), toastError)
  return (
    <>
      <fieldset className="admin-reasons">
        <legend>{t('Where the module works')}</legend>
        <label className="admin-radio"><input type="radio" name="scope" checked={scope === 'all'} onChange={() => setScope('all')} /> {t('All servers, including new ones')}</label>
        <label className="admin-radio"><input type="radio" name="scope" checked={scope === 'guilds'} onChange={() => setScope('guilds')} /> {t('Only the servers I choose')}</label>
      </fieldset>
      {scope === 'guilds' && (
        <>
          <ul className="admin-list" aria-label={t('Chosen servers')}>
            {chosen.map((g) => <li key={g.id}>{g.name} <button className="link" aria-label={t('Remove {name}', { name: g.name })} onClick={() => setChosen((c) => c.filter((x) => x.id !== g.id))}>{t('Remove')}</button></li>)}
            {!chosen.length && <li className="hint">{t('No servers chosen.')}</li>}
          </ul>
          <GuildPick label={t('Add a server')} value={null} onChange={(g) => g && !chosen.some((x) => x.id === g.id) && setChosen((c) => [...c, g])} />
        </>
      )}
      <p className="hint small">{t('The module’s bot joins these servers. Leaving one makes it leave.')}</p>
      <button className="primary admin-btn" onClick={save}>{t('Save Servers')}</button>
    </>
  )
}

const LEVELS = ['debug', 'info', 'warn', 'error', 'system'] as const

function Logs({ m }: { m: A.AdminModule }) {
  const [level, setLevel] = useState('')
  const [older, setOlder] = useState<A.ModuleLog[]>([])
  const { data, error, reload } = useLoad(() => (setOlder([]), A.moduleLogs(m.id)), [m.id])
  const all = [...(data ?? []), ...older]
  const shown = level ? all.filter((l) => l.level === level) : all
  const more = all.length && (older.length ? older : data ?? []).length === 200 ? () => void A.moduleLogs(m.id, all.at(-1)!.id).then((r) => setOlder((o) => [...o, ...r]), toastError) : null
  return (
    <>
      <div className="admin-inline">
        <div className="field">
          <label htmlFor="log-level">{t('Level')}</label>
          <select id="log-level" className="input" value={level} onChange={(e) => setLevel(e.target.value)}>
            <option value="">{t('All levels')}</option>
            {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
          </select>
        </div>
        <button className="secondary admin-btn" onClick={() => void reload()}>{t('Refresh')}</button>
      </div>
      <FormError error={error} />
      {data && !shown.length && <p className="hint">{t('No log lines.')}</p>}
      <ol className="module-log" aria-label={t('Log, newest first')}>
        {shown.map((l) => <li key={l.id} className={'lvl-' + l.level}><time dateTime={l.at}>{when(l.at)}</time> <span className="admin-badge">{l.level}</span> <span className="msg">{l.message}</span></li>)}
      </ol>
      {more && <button className="secondary admin-btn" onClick={more}>{t('Load older')}</button>}
    </>
  )
}

function Update({ m, onReview }: { m: A.AdminModule; onReview: (pkg: A.ModulePackage) => void }) {
  const [busy, setBusy] = useState(false)
  const fromGit = () => (setBusy(true), void A.stageGitUpdate(m.id).then((p) => (setBusy(false), onReview(p)), (e) => (setBusy(false), toastError(e))))
  return (
    <>
      <p className="hint">{t('You review what changed before anything is replaced. Settings, stored data and logs stay.')}</p>
      {m.source.type === 'git' && (
        <section aria-labelledby="upd-git-h">
          <h3 id="upd-git-h">{t('From the Git source')}</h3>
          <p><SourceText source={m.source} /></p>
          <button className="primary admin-btn" disabled={busy} aria-busy={busy || undefined} onClick={fromGit}>{t('Check for Update')}</button>
        </section>
      )}
      <PackageForms moduleId={m.id} onStaged={onReview} />
    </>
  )
}

function Remove({ m, onRemoved }: { m: A.AdminModule; onRemoved: () => void }) {
  const [keep, setKeep] = useState(true)
  const [typed, setTyped] = useState('')
  const remove = (e: FormEvent) => {
    e.preventDefault()
    if (typed.trim() !== m.id) return
    void ask({ title: t('Remove {name}?', { name: m.name }), body: <p>{keep ? t('Its stored data and settings are kept for a later install of the same module.') : t('Its stored data and settings are deleted too. This cannot be undone.')}</p>, confirm: t('Remove Module'), danger: true })
      .then((ok) => (ok ? A.elevated((mfa) => A.removeModule(m.id, keep, mfa).then(() => true), () => askCode(t('Remove {name}?', { name: m.name }), <p>{t('Confirm with your own two-factor code.')}</p>, t('Remove Module'))) : null))
      .then((done) => done && (toast(t('{name} was removed.', { name: m.name })), onRemoved()), toastError)
  }
  return (
    <form className="admin-form" onSubmit={remove}>
      <p>{t('The module stops, its bot leaves every server and its commands disappear. Messages it sent stay.')}</p>
      <fieldset className="admin-reasons">
        <legend>{t('Stored data and settings')}</legend>
        <label className="admin-radio"><input type="radio" name="keep" checked={keep} onChange={() => setKeep(true)} /> {t('Keep them')}</label>
        <label className="admin-radio"><input type="radio" name="keep" checked={!keep} onChange={() => setKeep(false)} /> {t('Delete them')}</label>
      </fieldset>
      <div className="field">
        <label htmlFor="remove-confirm">{t('Type the module ID ({id}) to confirm', { id: m.id })}</label>
        <input id="remove-confirm" className="input" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
      </div>
      <button type="submit" className="danger-btn" disabled={typed.trim() !== m.id}>{t('Remove Module')}</button>
    </form>
  )
}
