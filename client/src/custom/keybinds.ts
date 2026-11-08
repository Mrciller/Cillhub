// Keybinds (CONTRACT-v6 section 1): every in-app shortcut is rebindable, stored in the synced settings as
// `keybinds: {action: combo}` (null = unbound). Combos are "Ctrl+Alt+Shift+<KeyboardEvent.code>"; Ctrl also means Cmd.
// Push-to-talk stays in the local voice settings (voice/settings.ts pttKey), as the voice engine reads it there.
import { t } from '../i18n'
import { getState } from '../store'
import { voiceSettings } from '../voice/settings'

export const ACTIONS: [id: string, label: string, combo: string][] = [
  ['quick-switcher', 'Quick Switcher', 'Ctrl+KeyK'],
  ['shortcuts', 'Show keyboard shortcuts', 'Ctrl+Slash'],
  ['prev-channel', 'Previous channel', 'Alt+ArrowUp'],
  ['next-channel', 'Next channel', 'Alt+ArrowDown'],
  ['prev-unread', 'Previous unread channel', 'Alt+Shift+ArrowUp'],
  ['next-unread', 'Next unread channel', 'Alt+Shift+ArrowDown'],
  ['prev-server', 'Previous server', 'Ctrl+Alt+ArrowUp'],
  ['next-server', 'Next server', 'Ctrl+Alt+ArrowDown'],
  ['mark-read', 'Mark channel as read', 'Escape'],
  ['mark-server-read', 'Mark server as read', 'Shift+Escape'],
  ['toggle-mute', 'Toggle mute', 'Ctrl+Shift+KeyM'],
  ['toggle-deafen', 'Toggle deafen', 'Ctrl+Shift+KeyD'],
  ['toggle-camera', 'Toggle camera', ''],
  ['toggle-screen', 'Toggle screen share', ''],
  ['emoji', 'Open emoji picker', 'Ctrl+KeyE'],
  ['upload', 'Upload a file', 'Ctrl+Shift+KeyU'],
  ['push-to-talk', 'Push to talk (while held)', ''],
]
const MODS = ['Control', 'Alt', 'Shift', 'Meta', 'AltGraph', 'OS']
/** The combo of a key event, or null for a bare modifier. */
export function comboOf(e: KeyboardEvent | { ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean; code: string; key: string }) {
  if (MODS.includes(e.key) || !e.code) return null
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.code].filter(Boolean).join('+')
}
/** All bindings in effect: defaults, the user's changes, and the push-to-talk key. */
export function bindings(): Record<string, string> {
  const own = getState().settings.keybinds ?? {}
  return Object.fromEntries(ACTIONS.map(([id, , def]) => [id, id === 'push-to-talk' ? voiceSettings().pttKey : id in own ? own[id] ?? '' : def]))
}
/** The action bound to this key event, if any (Ctrl+/ also matches where "/" needs Shift, e.g. German layouts). */
export function actionFor(e: KeyboardEvent): string | null {
  const c = comboOf(e)
  if (!c) return null
  const b = bindings()
  const hit = ACTIONS.find(([id]) => id !== 'push-to-talk' && b[id] === c)?.[0]
  if (hit) return hit
  if (e.key === '/' && (e.ctrlKey || e.metaKey) && b.shortcuts === 'Ctrl+Slash') return 'shortcuts'
  return null
}
/** Other actions already using `combo`. */
export const conflicts = (combo: string, except: string) => {
  const b = bindings()
  return ACTIONS.filter(([id]) => id !== except && combo && b[id] === combo).map(([id]) => id)
}
const KEY_NAMES: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Backquote: '`', Slash: '/', Escape: 'Esc', Space: 'Space', Minus: '-', Equal: '=' }
/** "Ctrl+Shift+KeyM" → "Ctrl+Shift+M". */
export const comboLabel = (c: string) => (c ? c.split('+').map((p) => KEY_NAMES[p] ?? p.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ')).join('+') : t('Not set'))

if (import.meta.env.DEV) {
  console.assert(comboOf({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: true, code: 'KeyM', key: 'M' }) === 'Ctrl+Shift+KeyM', 'combo from event')
  console.assert(comboLabel('Ctrl+Alt+ArrowUp') === 'Ctrl+Alt+↑', 'combo label')
}
