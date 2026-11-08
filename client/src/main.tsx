import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ORIGIN } from './api'
import { startAndroidBridge } from './android/bridge'
import { startAppearance } from './appearance/apply'
import { startDesktopBridge } from './desktop/bridge'
import { startBadge } from './notifications/badge'
import { startIdle } from './notifications/idle'
import { navigate } from './router'
import { startReminders } from './scheduling/reminders'
import { startUpdateChecks } from './update'
import './index.css'

startAppearance() // theme and language before the first paint
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
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
