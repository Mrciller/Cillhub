// Applies the synced user settings to the page: theme, density, chat font size, zoom, saturation, reduced motion, language.
import { setLocale } from '../i18n'
import { getState, subscribe } from '../store'
import type { UserSettings } from '../types'
import './appearance.css'
import { applyCustom, startCustom } from '../custom/apply'

let last: UserSettings | null = null
// Zoom is per device (a PC's zoom must not shrink the phone). The old synced value is still honoured on wide screens
// until this device picks its own.
const ZOOM_KEY = 'zoom'
type ZoomListener = (zoom: number) => void
const zoomListeners = new Set<ZoomListener>()

export function onZoomChange(fn: ZoomListener) {
  zoomListeners.add(fn)
  return () => { zoomListeners.delete(fn) }
}

export function deviceZoom() {
  const own = Number(localStorage.getItem(ZOOM_KEY))
  if (own >= 50 && own <= 200) return own
  const synced = getState().settings.zoom
  return synced && matchMedia('(min-width: 900px)').matches ? synced : 100
}
export function setDeviceZoom(v: number) {
  const clamped = Math.min(200, Math.max(50, Math.round(v)))
  localStorage.setItem(ZOOM_KEY, String(clamped))
  const root = document.documentElement
  root.style.zoom = clamped !== 100 ? String(clamped / 100) : ''
  root.style.setProperty('--zoom', String(clamped / 100))
  const s = getState().settings
  root.dataset.density = !s.message_display_compact ? 'cozy' : (clamped === 90 ? 'ultra-compact' : 'compact')
  zoomListeners.forEach((fn) => fn(clamped))
}
/** Zoom factor of the page (popovers divide their coordinates by it). */
export const zoomFactor = () => deviceZoom() / 100

function apply(s: UserSettings) {
  const root = document.documentElement
  root.dataset.theme = s.theme ?? 'dark'
  root.toggleAttribute('data-compact', !!s.message_display_compact)
  root.style.setProperty('--chat-font', `${s.font_size ?? 16}px`)
  const z = deviceZoom()
  root.style.zoom = z !== 100 ? String(z / 100) : ''
  root.style.setProperty('--zoom', String(z / 100)) // full-height layouts divide 100dvh by it so the app still fills the screen
  root.dataset.density = !s.message_display_compact ? 'cozy' : (z === 90 ? 'ultra-compact' : 'compact')
  root.style.filter = s.saturation !== undefined && s.saturation < 100 ? `saturate(${s.saturation / 100})` : ''
  root.toggleAttribute('data-reduced-motion', reducedMotion(s))
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', s.theme === 'light' ? 'light' : 'dark')
  if (s.locale) setLocale(s.locale)
  applyCustom(s) // v6: custom theme, custom CSS, chat look
}

/** Reduced motion from the setting ("auto" follows the operating system). */
export function reducedMotion(s: UserSettings = getState().settings) {
  return s.reduced_motion === 'on' || (s.reduced_motion !== 'off' && matchMedia('(prefers-reduced-motion: reduce)').matches)
}

export function startAppearance() {
  try {
    const root = document.documentElement
    const sb = localStorage.getItem('cillhub:sidebar-width')
    if (sb) {
      root.style.setProperty('--sidebar-width', `${sb}px`)
      root.setAttribute('data-sidebar-resized', '1')
    }
    const mb = localStorage.getItem('cillhub:members-width')
    if (mb) root.style.setProperty('--members-width', `${mb}px`)
    const sp = localStorage.getItem('cillhub:side-panel-width')
    if (sp) root.style.setProperty('--side-panel-width', `${sp}px`)
  } catch {}
  startCustom()
  const run = () => {
    const s = getState().settings
    if (s !== last) (last = s), apply(s)
  }
  run()
  subscribe(run)
  window.addEventListener('storage', (e) => {
    if (e.key === ZOOM_KEY && e.newValue) {
      const val = Number(e.newValue)
      if (val >= 50 && val <= 200) {
        setDeviceZoom(val)
      }
    }
  })
}
