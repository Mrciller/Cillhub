// Applies the v6 personal settings to the page: custom/preset theme, custom CSS (unless Safe mode), chat font, line
// height, spacing, background image, avatar and timestamp toggles. Called by appearance/apply.ts on every settings change.
import { cdn } from '../api'
import { toast } from '../components/dialogs'
import { t } from '../i18n'
import { getState } from '../store'
import type { CustomTheme, UserSettings } from '../types'
import { applyCustomCss, onSafeMode, safeMode, watchSafeKey } from './css'
import { isLight, PRESETS, themeVars } from './themes'
import './custom.css'

export const FONT_STACKS: Record<string, string> = {
  system: 'inherit', inter: '"Inter", system-ui, sans-serif', 'jetbrains-mono': '"JetBrains Mono", ui-monospace, monospace', opendyslexic: '"OpenDyslexic", system-ui, sans-serif',
}
/** The theme in effect: a preset or one of the user's own (null = the built-in dark/light/ash/onyx). */
export const activeTheme = (s: UserSettings): CustomTheme | null =>
  s.active_theme ? PRESETS.find((p) => p.id === s.active_theme) ?? s.custom_themes?.find((c) => c.id === s.active_theme) ?? null : null

let themed: string[] = []
/** Live preview from the theme editor wins over the saved theme until it is closed. */
let preview: CustomTheme | null = null
export function previewTheme(t: CustomTheme | null) {
  preview = t
  applyCustom(getState().settings)
}

/** Chat background: a data URI right after upload, else the hash the server stored (CDN /chat-backgrounds/<user_id>/<hash>). */
export const chatBackgroundUrl = (v: string | null | undefined) =>
  !v ? null : v.startsWith('data:') ? v : cdn(`/chat-backgrounds/${getState().me?.id ?? '@me'}/${v}`)

export function applyCustom(s: UserSettings) {
  const root = document.documentElement
  const theme = preview ?? activeTheme(s)
  for (const k of themed) root.style.removeProperty(k)
  themed = []
  root.toggleAttribute('data-custom-theme', !!theme)
  if (theme) {
    root.dataset.theme = isLight(theme) ? 'light' : 'dark'
    for (const [k, v] of Object.entries(themeVars(theme))) (root.style.setProperty(k, v), themed.push(k))
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', isLight(theme) ? 'light' : 'dark')
  } else {
    root.dataset.theme = s.theme ?? 'dark'
    document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', s.theme === 'light' ? 'light' : 'dark')
  }
  applyCustomCss(s.custom_css, s.custom_css_enabled)
  root.style.setProperty('--chat-family', FONT_STACKS[s.chat_font ?? 'system'] ?? 'inherit')
  root.style.setProperty('--chat-lh', String(s.chat_line_height ?? 1.375))
  if (s.message_spacing !== undefined) root.style.setProperty('--msg-spacing', `${s.message_spacing}px`)
  root.toggleAttribute('data-msg-spacing', s.message_spacing !== undefined)
  root.toggleAttribute('data-hide-avatars', s.show_avatars === false)
  root.toggleAttribute('data-hide-timestamps', s.show_timestamps === false)
  const bg = chatBackgroundUrl(s.chat_background)
  root.toggleAttribute('data-chat-bg', !!bg)
  if (bg) (root.style.setProperty('--chat-bg-image', `url("${bg.replace(/"/g, '%22')}")`), root.style.setProperty('--chat-bg-opacity', String((s.chat_background_opacity ?? 30) / 100)))
}

const safeNote = () => getState().settings.custom_css_enabled && toast(t('Safe mode: your custom CSS is off until you reload.'))
export function startCustom() {
  watchSafeKey()
  onSafeMode(() => (applyCustom(getState().settings), safeNote()))
  if (safeMode()) setTimeout(safeNote, 1500)
}
