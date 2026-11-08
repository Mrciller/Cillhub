// /oauth2/authorize?client_id=&scope=&permissions= : add a bot to a server you manage (topics/oauth2.mdx, user docs preview + authorize).
import { useEffect, useState } from 'react'
import { authorizeApp, authorizeNode, previewAuthorize, type AuthorizePreview } from '../actions'
import { ApiError } from '../api'
import { Avatar, FormError, GuildIcon, Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { has, P } from '../permissions'
import { Link } from '../router'
import { PERM_GROUPS } from '../settings/permInfo'
import './developers.css'

export function Authorize() {
  const query = location.search
  const params = new URLSearchParams(query)
  const requested = (() => { try { return BigInt(params.get('permissions') ?? '0') } catch { return 0n } })()
  const scopes = (params.get('scope') ?? '').split(/[\s+]/).filter(Boolean)
  const [preview, setPreview] = useState<AuthorizePreview | null>(null)
  const [error, setError] = useState('')
  const [guild, setGuild] = useState('')
  const [perms, setPerms] = useState(requested)
  const [done, setDone] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => void previewAuthorize(query).then(setPreview, (e: Error) => setError(e instanceof ApiError && e.status === 404 ? t('Unknown application.') : e.message)), [query])
  // Only servers where the user has Manage Server can receive a bot.
  const guilds = (preview?.guilds ?? []).filter((g) => has(BigInt(g.permissions ?? '0'), P.MANAGE_GUILD))
  const asked = PERM_GROUPS.flatMap((g) => g.perms).filter((p) => (requested & P[p.name]) !== 0n)
  const submit = () => {
    setBusy(true)
    setError('')
    authorizeApp(query, { guild_id: guild, permissions: String(perms), authorize: true }).then(() => setDone(guild), (e: Error) => (setError(e.message), setBusy(false)))
  }
  const app = preview?.application
  if (preview?.node) return <NodeConsent query={query} preview={preview as AuthorizePreview & { node: NonNullable<AuthorizePreview['node']> }} />
  return (
    <div className="auth-bg">
      <main className="auth-card oauth-card" aria-labelledby="oauth-title">
        {!preview ? (error ? <FormError error={error} /> : <p className="hint" role="status">{t('Loading…')}</p>) : done ? (
          <div className="oauth-done" role="status">
            <Icon d={ICONS.check} size={48} />
            <h1 id="oauth-title">{t('Authorized')}</h1>
            <p>{t('{app} has been added to {server}.', { app: app?.name ?? '', server: guilds.find((g) => g.id === done)?.name ?? '' })}</p>
            <Link to={`/channels/${done}`} className="primary wide link-btn">{t('Go to {server}', { server: guilds.find((g) => g.id === done)?.name ?? '' })}</Link>
          </div>
        ) : (
          <>
            <div className="oauth-head">
              <Avatar user={preview.bot ?? preview.user} size={64} />
              <p className="hint">{t('An external application')}</p>
              <h1 id="oauth-title">{app?.name} <span className="bot-tag">{t('APP')}</span></h1>
              <p className="hint">{t('wants to access your Cillhub account')} · {t('Signed in as {name}', { name: preview.user.username })}</p>
            </div>
            {scopes.includes('bot') || scopes.includes('applications.commands') ? (
              <div className="field">
                <label htmlFor="oauth-guild">{t('Add to server:')}</label>
                <select id="oauth-guild" className="input" value={guild} onChange={(e) => setGuild(e.target.value)}>
                  <option value="">{t('Select a server')}</option>
                  {guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                {!guilds.length && <p className="hint small">{t('You need the Manage Server permission in a server to add apps to it.')}</p>}
                {guild && <div className="oauth-guild"><span className="mini-guild"><GuildIcon guild={guilds.find((g) => g.id === guild)!} /></span></div>}
              </div>
            ) : null}
            <section>
              <h2 className="list-heading">{t('This will allow the developer of {app} to:', { app: app?.name ?? '' })}</h2>
              <ul className="oauth-scopes">
                {scopes.includes('bot') && <li><Icon d={ICONS.check} size={16} /> {t('Add a bot to a server')}</li>}
                {scopes.includes('applications.commands') && <li><Icon d={ICONS.check} size={16} /> {t('Create commands')}</li>}
              </ul>
              {scopes.includes('bot') && asked.length > 0 && (
                <fieldset className="oauth-perms">
                  <legend className="list-heading">{t('Bot permissions')}</legend>
                  {asked.map((p) => (
                    <label key={p.name} className="check-row">
                      <input type="checkbox" checked={(perms & P[p.name]) !== 0n} onChange={() => setPerms(perms ^ P[p.name])} /> <span>{t(p.label)}</span>
                    </label>
                  ))}
                </fieldset>
              )}
            </section>
            <FormError error={error} />
            <div className="modal-actions">
              <Link to="/channels/@me" className="secondary link-btn">{t('Cancel')}</Link>
              <button className="primary" disabled={busy || ((scopes.includes('bot') || scopes.includes('applications.commands')) && !guild)} onClick={submit}>{t('Authorize')}</button>
            </div>
          </>
        )}
      </main>
    </div>
  )
}

/** v7 §3: "Sign in to <node> with your Cillhub account". The hub only answers with a redirect back to the node. */
function NodeConsent({ query, preview }: { query: string; preview: AuthorizePreview & { node: NonNullable<AuthorizePreview['node']> } }) {
  const { node, user } = preview
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const go = (yes: boolean) => {
    setBusy(true)
    setError('')
    authorizeNode(query, yes).then((r) => {
      // Only ever leave for the node that asked.
      if (new URL(r.location).origin !== new URL(node.url).origin) throw new Error(t('The hub answered with an unexpected address.'))
      location.assign(r.location)
    }).catch((e: Error) => (setError(e.message), setBusy(false)))
  }
  return (
    <div className="auth-bg">
      <main className="auth-card oauth-card" aria-labelledby="oauth-title">
        <div className="oauth-head">
          <Avatar user={user} size={64} />
          <p className="hint">{t('Another Cillhub instance')}</p>
          <h1 id="oauth-title">{t('Sign in to {name} with your Cillhub account', { name: node.name })}</h1>
          <p className="hint">{new URL(node.url).host} · {t('Signed in as {name}', { name: user.username })}</p>
        </div>
        <section>
          <h2 className="list-heading">{t('{name} will get:', { name: node.name })}</h2>
          <ul className="oauth-scopes">
            <li><Icon d={ICONS.check} size={16} /> {t('Your username, display name and avatar')}</li>
          </ul>
          <h2 className="list-heading">{t('{name} will not get:', { name: node.name })}</h2>
          <ul className="oauth-scopes">
            <li><Icon d={ICONS.close} size={16} /> {t('Your password, email, direct messages, friends or other servers')}</li>
          </ul>
        </section>
        <FormError error={error} />
        <div className="modal-actions">
          <button className="secondary" disabled={busy} onClick={() => go(false)}>{t('Cancel')}</button>
          <button className="primary" disabled={busy} onClick={() => go(true)} autoFocus>{t('Authorize')}</button>
        </div>
      </main>
    </div>
  )
}
