import { lazy, Suspense } from 'react'
import { Auth } from './components/Auth'
import { DialogHost } from './components/dialogs'
import { useLocale } from './i18n'
import { InstanceBanner } from './admin/InstanceBanner'
import { InvitePage } from './components/InvitePage'
import { ResetPage } from './components/ResetPage'
import { Shell } from './components/Shell'
import { UpdateBanner } from './components/UpdateBanner'
import { AndroidMovedBanner } from './android/MovedBanner'
import { Redirect, usePath } from './router'
import { useStore } from './store'
import { useInstance } from './admin/instance'
import { InstanceCallback } from './instances/InstanceUI'
import type { LegalDocId } from './legal/api'
import { AppealPage, LegalDocPage, LegalGate, LicensesPage, NoticeStatusPage, ReportContentPage } from './legal/LegalPages'

const DeveloperPortal = lazy(() => import('./developers/DeveloperPortal').then((m) => ({ default: m.DeveloperPortal })))
const AdminPage = lazy(() => import('./admin/AdminPage').then((m) => ({ default: m.AdminPage })))
const Setup = lazy(() => import('./setup/Setup').then((m) => ({ default: m.Setup })))
const Directory = lazy(() => import('./directory/Directory').then((m) => ({ default: m.Directory })))
const Authorize = lazy(() => import('./developers/Authorize').then((m) => ({ default: m.Authorize })))
const DownloadPage = lazy(() => import('./download/DownloadPage').then((m) => ({ default: m.DownloadPage })))

const LEGAL_PATHS: Record<string, LegalDocId | undefined> = { imprint: 'imprint', impressum: 'imprint', privacy: 'privacy', datenschutz: 'privacy', terms: 'terms', nutzungsbedingungen: 'terms' }

/** The update banner sits above every screen (also login and invites); the page fills the rest. Re-renders on language change. */
export function App() {
  useLocale()
  return (
    <div className="frame">
      <UpdateBanner />
      <AndroidMovedBanner />
      <InstanceBanner />
      <Page />
      <LegalGate />
    </div>
  )
}

function Page() {
  const path = usePath()
  const token = useStore((s) => s.token)
  const [, section, a, b, c] = path.split('/')
  const instance = useInstance()
  // v7: a fresh self-hosted instance only offers the first-run wizard until it is finished.
  if (instance?.setup_pending) return section === 'setup' ? <Suspense fallback={null}><Setup /></Suspense> : <Redirect to="/setup" />
  if (section === 'setup') return instance ? <Redirect to="/login" /> : null
  if (section === 'instances' && a === 'callback') return <InstanceCallback />
  if (section === 'invite' && a) return <InvitePage code={decodeURIComponent(a)} />
  // Template links open "Add a server" with the code (templates/Templates.tsx); after login when needed.
  if (section === 'template' && a) return sessionStorage.setItem('template-code', decodeURIComponent(a)), <Redirect to="/channels/@me" />
  if (section === 'reset') return <ResetPage />
  // 7.11: legal pages, the public notice form and appeals work without a session (German aliases for the imprint etc.)
  const doc = LEGAL_PATHS[section]
  if (doc) return <LegalDocPage key={doc} doc={doc} />
  if (section === 'licenses') return <LicensesPage />
  if (section === 'report-content') return a === 'status' ? <NoticeStatusPage /> : <ReportContentPage />
  if (section === 'appeal') return <AppealPage />
  if (section === 'download') return <Suspense fallback={null}><DownloadPage /></Suspense>
  if (!token) return section === 'login' || section === 'register' ? <><Auth key={section} mode={section} /><DialogHost /></> : <Redirect to={`/login${section === 'oauth2' || section === 'developers' || section === 'directory' ? `?next=${encodeURIComponent(location.pathname + location.search)}` : ''}`} />
  if (section === 'developers' && a === 'applications') return <Suspense fallback={null}><DeveloperPortal appId={b} tab={path.split('/')[4]} /></Suspense>
  if (section === 'admin') return <Suspense fallback={null}><AdminPage page={a} /></Suspense>
  if (section === 'directory') return <Suspense fallback={null}><Directory /></Suspense>
  if (section === 'oauth2' && a === 'authorize') return <Suspense fallback={null}><Authorize /></Suspense>
  if (section !== 'channels' || !a) return <Redirect to="/channels/@me" />
  return <Shell guildId={a} channelId={b} messageId={c} />
}
