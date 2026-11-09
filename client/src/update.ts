// "A new version is available": compares the deployed index.html's main bundle with the one this page runs, and listens
// for a new service worker. Never reloads by itself during a call; see UpdateBanner for the prompt.
// In the desktop app (1.2.0+) this client is bundled: the banner shows when the app has an update or the hub runs a newer
// server line than this bundle was built for, and installs the app update instead of reloading.
import { apiOrigin } from './api'
import { getState, setState } from './store'

export type AppUpdateStatus = { state: 'idle' | 'checking' | 'downloading' | 'none' | 'ready' | 'error'; version?: string; percent?: number }
type AppUpdates = { onUpdateStatus: (cb: (s: AppUpdateStatus) => void) => () => void; installUpdate: () => Promise<void> }
/** The desktop app's update bridge when this client is bundled in it, else null (website, 1.0/1.1 app). */
export const appUpdates = ((): AppUpdates | null => {
  const d = (window as { cillcordDesktop?: Partial<AppUpdates> & { bundled?: boolean } }).cillcordDesktop
  return d?.bundled && typeof d.installUpdate === 'function' && typeof d.onUpdateStatus === 'function' ? (d as AppUpdates) : null
})()

/** Server version this bundle was built for (desktop build, e.g. "7.2.0"). */
const BUILT_FOR: string = import.meta.env.VITE_SERVER_VERSION ?? ''
const majorMinor = (v: unknown) => (typeof v === 'string' ? /^(\d+)\.(\d+)\./.exec(v)?.slice(1).map(Number) : undefined)
/** A newer major.minor on the server may need client changes; patch releases keep the API. Unknown versions ("dev") never count. */
export function serverAhead(server: unknown, built: string) {
  const s = majorMinor(server)
  const b = majorMinor(built)
  return !!s && !!b && (s[0] > b[0] || (s[0] === b[0] && s[1] > b[1]))
}
if (import.meta.env.DEV) {
  console.assert(serverAhead('7.3.0', '7.2.0') && serverAhead('8.0.1', '7.9.9') && !serverAhead('7.2.5', '7.2.0') && !serverAhead('7.1.0', '7.2.0') && !serverAhead('dev', '7.2.0') && !serverAhead('7.3.0', ''), 'serverAhead')
}

async function checkServer() {
  try {
    const info = await (await fetch(`${apiOrigin()}/.well-known/cillhub`, { cache: 'no-store' })).json()
    if (serverAhead(info?.version, BUILT_FOR)) markReady()
  } catch {
    // Offline: try again later.
  }
}

const BUNDLE = /\/assets\/index-[\w-]+\.js/
/** Main bundle of the running page (production builds only; the dev server has no hashed bundle). */
const running = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/index-"]')?.getAttribute('src')?.match(BUNDLE)?.[0]

const markReady = () => !getState().updateReady && setState({ updateReady: true })

export async function checkForUpdate() {
  if (appUpdates) return checkServer()
  if (!running) return
  try {
    const html = await (await fetch('/', { cache: 'no-store' })).text()
    const deployed = html.match(BUNDLE)?.[0]
    if (deployed && deployed !== running) markReady()
  } catch {
    // Offline or the server is restarting: try again later.
  }
}

const AWAY_MS = 10 * 60_000
let hiddenSince = 0

/** Starts the checks: every 5 minutes, on focus and when the tab becomes visible; plus the service worker takeover. */
export function startUpdateChecks() {
  setInterval(() => void checkForUpdate(), 5 * 60_000)
  const back = async () => {
    const away = hiddenSince ? Date.now() - hiddenSince : 0
    hiddenSince = 0
    await checkForUpdate()
    // Nobody is looking and no call would drop: apply the update when they come back after a long absence.
    if (!appUpdates && getState().updateReady && away > AWAY_MS && !getState().voice.channelId) location.reload()
  }
  addEventListener('focus', () => void back())
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') hiddenSince ||= Date.now()
    else void back()
  })
  if (appUpdates) {
    appUpdates.onUpdateStatus((s) => s?.state === 'ready' && markReady())
    void checkServer()
  } else if ('serviceWorker' in navigator) {
    const hadController = !!navigator.serviceWorker.controller
    // A new worker took over (skipWaiting/clients.claim): the page still runs the old build.
    navigator.serviceWorker.addEventListener('controllerchange', () => hadController && markReady())
  }
}
