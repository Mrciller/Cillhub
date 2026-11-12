import { Component, StrictMode, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ORIGIN } from './api'
import { toast } from './components/dialogs'
import { t } from './i18n'
import { cutOffNodes } from './instances/nodes'
import { lastNode } from './instances/registry'
import { startAndroidBridge } from './android/bridge'
import { startAppearance } from './appearance/apply'
import { startDesktopBridge } from './desktop/bridge'
import { startBadge } from './notifications/badge'
import { startIdle } from './notifications/idle'
import { navigate } from './router'
import { startReminders } from './scheduling/reminders'
import { startUpdateChecks } from './update'
import './index.css'

/** A render error must not leave a blank page. Data of a private node (untrusted) may be what broke it: first the node whose
 *  data went in last is cut off, if it throws again every node with state, and the app renders again. Without node state, or
 *  after a few tries, a reload screen. */
class Guard extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  tries = 0 // cut-off nodes stay off, but a late REST answer can bring node state back: no endless retry
  static getDerivedStateFromError = () => ({ failed: true })
  componentDidCatch() { // React logs the error itself
    const names = this.tries < 3 ? cutOffNodes(this.tries++ ? undefined : lastNode()) : []
    if (!names.length) return
    for (const name of names) if (name) toast(t('Display error: {name} was disconnected so Cillhub stays usable. It stays off until you reconnect it.', { name }))
    this.setState({ failed: false })
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <main className="auth-bg">
        <section className="auth-card" aria-labelledby="crash-h1">
          <h1 id="crash-h1">{t('Something went wrong')}</h1>
          <p className="sub">{t('Cillhub could not show this page. Reloading usually fixes it.')}</p>
          <button className="primary" autoFocus onClick={() => location.reload()}>{t('Reload')}</button>
        </section>
      </main>
    )
  }
}

startAppearance() // theme and language before the first paint
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Guard>
      <App />
    </Guard>
  </StrictMode>,
)

// Installable app (PWA), production builds only. A new worker takes over at once (skipWaiting/clients.claim); the page
// is not reloaded behind the user's back (that would drop a call): update.ts shows "A new version is available" instead.
// Not in the desktop app's bundle (ORIGIN set): it is served from the package and updates with the app.
if (import.meta.env.PROD && !ORIGIN && 'serviceWorker' in navigator) addEventListener('load', () => void navigator.serviceWorker.register('/sw.js').catch(() => {}))
// A clicked push notification asks an open window to show its channel (public/sw.js).
navigator.serviceWorker?.addEventListener('message', (e) => e.data?.type === 'navigate' && typeof e.data.url === 'string' && e.data.url.startsWith('/') && navigate(e.data.url))
startUpdateChecks()
startBadge()
startIdle()
startDesktopBridge()
startAndroidBridge()
startReminders()
