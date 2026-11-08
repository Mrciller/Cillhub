// Developer Portal at /developers/applications: create apps, bot token (reveal once / reset), privileged intents, OAuth2 URL generator.
import { useEffect, useState, type FormEvent } from 'react'
import { createApp, deleteApp, listApps, resetBotToken, updateApp } from '../actions'
import { cdn, dataUri, WEB_ORIGIN } from '../api'
import { ask, DialogHost, toastError } from '../components/dialogs'
import { cls, Field, FormError, Icon, ICONS, Modal } from '../components/ui'
import { t } from '../i18n'
import { P } from '../permissions'
import { Link, navigate } from '../router'
import { PERM_GROUPS } from '../settings/permInfo'
import type { Application } from '../types'
import './developers.css'

export const INTENTS: [number, string, string][] = [
  [1 << 13, 'Presence Intent', 'Required for your bot to receive presence updates (GUILD_PRESENCES).'],
  [1 << 15, 'Server Members Intent', 'Required for your bot to receive member events and the member list (GUILD_MEMBERS).'],
  [1 << 19, 'Message Content Intent', 'Required for your bot to read the content of most messages (MESSAGE_CONTENT).'],
]
const appIcon = (a: Application) => (a.icon ? cdn(`/app-icons/${a.id}/${a.icon}`) : null)

function NewApp({ onClose, onCreated }: { onClose: () => void; onCreated: (a: Application) => void }) {
  const [error, setError] = useState('')
  return (
    <Modal title={t('Create an Application')} onClose={onClose}>
      <form onSubmit={(e: FormEvent<HTMLFormElement>) => {
        e.preventDefault()
        const name = String(new FormData(e.currentTarget).get('name')).trim()
        if (name) createApp(name).then(onCreated, (err: Error) => setError(err.message))
      }}>
        <Field label={t('Name')} name="name" required maxLength={32} autoFocus />
        <FormError error={error} />
        <div className="modal-actions"><button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button><button className="primary">{t('Create')}</button></div>
      </form>
    </Modal>
  )
}

function General({ app, onChange, onDeleted }: { app: Application; onChange: (a: Application) => void; onDeleted: () => void }) {
  const [name, setName] = useState(app.name)
  const [description, setDescription] = useState(app.description ?? '')
  const [endpoint, setEndpoint] = useState(app.interactions_endpoint_url ?? '')
  const [icon, setIcon] = useState<string | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const save = () => updateApp(app.id, { name, description, interactions_endpoint_url: endpoint.trim() || null, ...(icon !== undefined && { icon }) })
    .then((a) => (onChange(a), setIcon(undefined), setSaved(true), setError('')), (e: Error) => setError(e.message))
  const remove = () => void ask({ title: t('Delete App'), body: <p>{t('Delete {name} and its bot? It leaves every server. This cannot be undone.', { name: app.name })}</p>, confirm: t('Delete App'), danger: true })
    .then((ok) => void (ok && deleteApp(app.id).then(onDeleted, toastError)))
  return (
    <>
      <h1>{t('General Information')}</h1>
      <div className="dev-grid">
        <div>
          <Field label={t('Name')} value={name} maxLength={32} onChange={(e) => (setName(e.target.value), setSaved(false))} />
          <div className="field"><label htmlFor="app-desc">{t('Description')}</label><textarea id="app-desc" className="input textarea" maxLength={400} value={description} onChange={(e) => (setDescription(e.target.value), setSaved(false))} /></div>
          <Field label={t('Interactions Endpoint URL (optional)')} value={endpoint} type="url" placeholder="https://example.com/interactions" onChange={(e) => (setEndpoint(e.target.value), setSaved(false))} />
          <p className="hint small">{t('Leave empty to receive interactions over the gateway as INTERACTION_CREATE.')}</p>
        </div>
        <div className="field">
          <span className="field-label">{t('App Icon')}</span>
          <div className="dev-icon">{(icon ?? (icon === undefined && appIcon(app))) ? <img src={icon ?? appIcon(app)!} alt="" /> : <Icon d={ICONS.code} size={40} />}</div>
          <label className="secondary file-btn">{t('Upload')}<input type="file" className="sr-only" accept="image/png,image/jpeg,image/gif,image/webp" onChange={(e) => { const f = e.target.files?.[0]; if (f) dataUri(f).then((d) => (setIcon(d), setSaved(false)), (err: Error) => setError(err.message)) }} /></label>
        </div>
      </div>
      <dl className="dev-facts">
        <dt>{t('Application ID')}</dt><dd><code>{app.id}</code> <button className="link" onClick={() => void navigator.clipboard.writeText(app.id)}>{t('Copy')}</button></dd>
        {app.verify_key && <><dt>{t('Public Key')}</dt><dd><code className="wrap">{app.verify_key}</code> <button className="link" onClick={() => void navigator.clipboard.writeText(app.verify_key!)}>{t('Copy')}</button></dd></>}
      </dl>
      <FormError error={error} />
      <div className="save-bar">
        {saved && <span className="success" role="status">{t('Saved.')}</span>}
        <button className="danger-btn" onClick={remove}>{t('Delete App')}</button>
        <button className="primary" onClick={() => void save()}>{t('Save Changes')}</button>
      </div>
    </>
  )
}

function Bot({ app, onChange }: { app: Application; onChange: (a: Application) => void }) {
  // A token is only ever shown right after it was created or reset (shown once, per the API reference).
  const [token, setToken] = useState<string | null>(app.bot?.token ?? null)
  const [copied, setCopied] = useState(false)
  const reset = () => void ask({ title: t('Reset Bot Token?'), body: <p>{t('Your bot will stop working until you update the token in its code.')}</p>, confirm: t('Yes, do it!'), danger: true })
    .then((ok) => void (ok && resetBotToken(app.id).then((tk) => (setToken(tk), setCopied(false)), toastError)))
  const flags = app.flags ?? 0
  const toggle = (bit: number) => void updateApp(app.id, { flags: flags ^ bit }).then(onChange, toastError)
  return (
    <>
      <h1>{t('Bot')}</h1>
      <p className="hint">{t('Bring your app to life on Cillhub with a bot user. Point your bot library at this server with the token below.')}</p>
      <dl className="dev-facts"><dt>{t('Username')}</dt><dd>{app.bot?.username ?? '—'} <span className="bot-tag">{t('APP')}</span></dd></dl>
      <section className="settings-section">
        <h2>{t('Token')}</h2>
        {token ? (
          <div className="token-box" role="status">
            <code className="wrap" aria-label={t('Bot token')}>{token}</code>
            <button className="primary small-btn" onClick={() => void navigator.clipboard.writeText(token).then(() => setCopied(true))}>{copied ? t('Copied') : t('Copy')}</button>
            <p className="hint small">{t('For security, the token is only shown once. Copy it now and keep it secret.')}</p>
          </div>
        ) : <p className="hint small">{t('For security, tokens can only be viewed once, when created. If you forgot or lost access to your token, reset it.')}</p>}
        <button className="secondary" onClick={reset}>{t('Reset Token')}</button>
      </section>
      <section className="settings-section">
        <h2>{t('Privileged Gateway Intents')}</h2>
        {INTENTS.map(([bit, label, note]) => (
          <div key={bit} className="switch-row">
            <div className="switch-text"><label htmlFor={`intent-${bit}`}>{t(label)}</label><p className="hint small">{t(note)}</p></div>
            <input id={`intent-${bit}`} type="checkbox" role="switch" className="switch" checked={!!(flags & bit)} onChange={() => toggle(bit)} />
          </div>
        ))}
      </section>
    </>
  )
}

function OAuth2({ app }: { app: Application }) {
  const [scopes, setScopes] = useState<string[]>(['bot', 'applications.commands'])
  const [perms, setPerms] = useState(0n)
  const url = `${WEB_ORIGIN}/oauth2/authorize?client_id=${app.id}&scope=${encodeURIComponent(scopes.join(' '))}${scopes.includes('bot') ? `&permissions=${perms}` : ''}`
  const [copied, setCopied] = useState(false)
  return (
    <>
      <h1>{t('OAuth2 URL Generator')}</h1>
      <fieldset className="choice block">
        <legend>{t('Scopes')}</legend>
        <div className="check-grid">
          {['bot', 'applications.commands'].map((s) => (
            <label key={s} className="check-row"><input type="checkbox" checked={scopes.includes(s)} onChange={() => (setScopes(scopes.includes(s) ? scopes.filter((x) => x !== s) : [...scopes, s]), setCopied(false))} /> <span>{s}</span></label>
          ))}
        </div>
      </fieldset>
      {scopes.includes('bot') && (
        <fieldset className="choice block">
          <legend>{t('Bot Permissions')}</legend>
          <div className="check-grid">
            {PERM_GROUPS.flatMap((g) => g.perms).map((p) => (
              <label key={p.name} className="check-row"><input type="checkbox" checked={(perms & P[p.name]) !== 0n} onChange={() => (setPerms(perms ^ P[p.name]), setCopied(false))} /> <span>{t(p.label)}</span></label>
            ))}
          </div>
        </fieldset>
      )}
      <div className="field">
        <label htmlFor="oauth-url">{t('Generated URL')}</label>
        <div className="row-buttons">
          <input id="oauth-url" className="input" readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          <button className="primary" disabled={!scopes.length} onClick={() => void navigator.clipboard.writeText(url).then(() => setCopied(true))}>{copied ? t('Copied') : t('Copy')}</button>
        </div>
        <p className="hint small"><a href={url}>{t('Open the invite page')}</a></p>
      </div>
    </>
  )
}

export function DeveloperPortal({ appId, tab = 'information' }: { appId?: string; tab?: string }) {
  const [apps, setApps] = useState<Application[] | null>(null)
  const [creating, setCreating] = useState(false)
  useEffect(() => void listApps().then(setApps, (e: Error) => (toastError(e), setApps([]))), [])
  const app = apps?.find((a) => a.id === appId)
  const put = (a: Application) => setApps((l) => (l ?? []).map((x) => (x.id === a.id ? { ...x, ...a } : x)))
  const tabs: [string, string][] = [['information', t('General Information')], ['bot', t('Bot')], ['oauth2', t('OAuth2')]]
  return (
    <div className="dev-portal">
      <nav className="dev-nav" aria-label={t('Developer Portal')}>
        <Link to="/channels/@me" className="row"><Icon d={ICONS.back} size={18} /> {t('Back to Cillhub')}</Link>
        <h2 className="list-heading">{t('Applications')}</h2>
        <ul>
          {apps?.map((a) => (
            <li key={a.id}><Link to={`/developers/applications/${a.id}/information`} className={cls('row', a.id === appId && 'on')} aria-current={a.id === appId ? 'page' : undefined}>{a.name}</Link></li>
          ))}
        </ul>
        {app && (
          <>
            <h2 className="list-heading">{app.name}</h2>
            {tabs.map(([id, label]) => <Link key={id} to={`/developers/applications/${app.id}/${id}`} className={cls('row', tab === id && 'on')} aria-current={tab === id ? 'page' : undefined}>{label}</Link>)}
          </>
        )}
      </nav>
      <main className="dev-main" aria-label={t('Developer Portal')}>
        {!app ? (
          <>
            <div className="dev-head"><h1>{t('Applications')}</h1><button className="primary" onClick={() => setCreating(true)}>{t('New Application')}</button></div>
            {apps === null ? <p className="hint" role="status">{t('Loading…')}</p> : apps.length ? (
              <ul className="dev-cards">
                {apps.map((a) => (
                  <li key={a.id}><Link to={`/developers/applications/${a.id}/information`} className="dev-card">
                    <span className="dev-icon small">{appIcon(a) ? <img src={appIcon(a)!} alt="" /> : <Icon d={ICONS.code} size={32} />}</span>
                    <span className="ellipsis">{a.name}</span>
                  </Link></li>
                ))}
              </ul>
            ) : <p className="hint">{t('You have no applications yet. Create one to get a bot token.')}</p>}
          </>
        ) : tab === 'bot' ? <Bot key={app.id} app={app} onChange={put} /> : tab === 'oauth2' ? <OAuth2 key={app.id} app={app} /> : <General key={app.id} app={app} onChange={put} onDeleted={() => (setApps((l) => (l ?? []).filter((x) => x.id !== app.id)), navigate('/developers/applications'))} />}
      </main>
      {creating && <NewApp onClose={() => setCreating(false)} onCreated={(a) => (setApps((l) => [...(l ?? []), a]), setCreating(false), navigate(`/developers/applications/${a.id}/${a.bot?.token ? 'bot' : 'information'}`))} />}
      <DialogHost />
    </div>
  )
}
