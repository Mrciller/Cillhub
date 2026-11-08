// Admin dashboard at /admin/<page> (CONTRACT-v6 §0). Only for accounts with instance_admin; the server also requires 2FA,
// so without it the page explains that and links to the security settings instead of calling any admin route.
import { useEffect, useState } from 'react'
import { api } from '../api'
import { DialogHost } from '../components/dialogs'
import { cls, FormError } from '../components/ui'
import { t } from '../i18n'
import { Link, navigate, Redirect } from '../router'
import { setState } from '../store'
import type { User } from '../types'
import { onMfaRequired } from './api'
import { AdminAuditLog } from './AuditLog'
import { Announcements } from './Announcements'
import { Overview } from './Overview'
import { Reports } from './Reports'
import { Servers } from './Servers'
import { InstanceSettingsPage } from './Settings'
import { Users } from './Users'
import { useInstance } from './instance'
import { Nodes } from './Nodes'
import { DirectoryModeration } from './DirectoryModeration'
import { FederationPage } from './Federation'
import { UpdatesPage } from './Updates'
import { ReleasePage } from './Release'
import { ModulesPage } from './Modules'
import './admin.css'

const PAGES: [string, string][] = [
  ['overview', 'Overview'], ['users', 'Users'], ['servers', 'Servers'], ['reports', 'Reports'],
  ['settings', 'Instance Settings'], ['announcements', 'Announcements'], ['modules', 'Modules'], ['audit-log', 'Admin Audit Log'],
]
// v7: the hub manages nodes and its directory; a self-hosted node manages its hub link and its updates.
const HUB_PAGES: [string, string][] = [['nodes', 'Nodes'], ['directory', 'Server Directory'], ['release', 'Release Channel']]
const NODE_PAGES: [string, string][] = [['federation', 'Federation'], ['updates', 'Updates']]

export function AdminPage({ page }: { page?: string }) {
  const [me, setMe] = useState<User | null>(null)
  const [error, setError] = useState('')
  const [mfaRequired, setMfaRequired] = useState(false)
  useEffect(() => void api<User>('/users/@me').then(setMe, (e: Error) => setError(e.message)), [])
  useEffect(() => onMfaRequired(() => setMfaRequired(true)), [])
  useEffect(() => { document.title = `${t('Admin')} · Cillhub` }, [])
  const instance = useInstance()
  const role = instance?.federation?.role
  const pages = [...PAGES, ...(role === 'hub' ? HUB_PAGES : role === 'node' ? NODE_PAGES : [])]

  if (error) return <main className="admin-gate"><FormError error={error} /></main>
  if (!me) return <main className="admin-gate" aria-busy="true"><p className="hint">{t('Loading…')}</p></main>
  if (!me.instance_admin) return <Redirect to="/channels/@me" />
  if (!me.mfa_enabled || mfaRequired) return <MfaRequired />
  const label = pages.find(([id]) => id === page)?.[1]
  if (!label) return instance === null && page !== 'overview' ? null : <Redirect to="/admin/overview" /> // v7 pages exist once the instance info is in
  return (
    <div className="admin">
      <nav className="admin-nav" aria-label={t('Admin dashboard')}>
        <p className="list-heading">{t('Cillhub Admin')}</p>
        <ul>
          {pages.map(([id, name]) => (
            <li key={id}><Link to={`/admin/${id}`} className={cls('settings-tab', id === page && 'active')} aria-current={id === page ? 'page' : undefined}>{t(name)}</Link></li>
          ))}
        </ul>
        <div className="settings-footer"><Link to="/channels/@me" className="settings-tab">{t('Back to Cillhub')}</Link></div>
      </nav>
      <main className="admin-main" aria-labelledby="admin-h1">
        <h1 id="admin-h1">{t(label)}</h1>
        {page === 'overview' && <Overview />}
        {page === 'users' && <Users />}
        {page === 'servers' && <Servers />}
        {page === 'reports' && <Reports />}
        {page === 'settings' && <InstanceSettingsPage />}
        {page === 'announcements' && <Announcements />}
        {page === 'audit-log' && <AdminAuditLog />}
        {page === 'nodes' && <Nodes />}
        {page === 'directory' && <DirectoryModeration />}
        {page === 'federation' && <FederationPage />}
        {page === 'updates' && <UpdatesPage />}
        {page === 'release' && <ReleasePage />}
        {page === 'modules' && <ModulesPage />}
      </main>
      <DialogHost />
    </div>
  )
}

function MfaRequired() {
  const open = () => (navigate('/channels/@me'), setState({ modal: { kind: 'user', tab: 'account' } }))
  return (
    <main className="admin-gate">
      <section className="auth-card" aria-labelledby="mfa-h1">
        <h1 id="mfa-h1">{t('Two-factor authentication required')}</h1>
        <p>{t('The admin dashboard can change every account and server on this instance, so it only opens for admins who protect their account with two-factor authentication.')}</p>
        <p>{t('Turn on 2FA with an authenticator app in User Settings → My Account, then come back here.')}</p>
        <div className="modal-actions">
          <Link to="/channels/@me" className="secondary link-btn admin-btn">{t('Back to Cillhub')}</Link>
          <button className="primary admin-btn" autoFocus onClick={open}>{t('Open Security Settings')}</button>
        </div>
      </section>
    </main>
  )
}
