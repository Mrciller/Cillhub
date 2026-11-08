// Global keyboard shortcuts (CONTRACT-v4 section 4, rebindable since v6 via custom/keybinds.ts), installed by the shell.
import { useEffect, useRef } from 'react'
import { ackBulk, ackMessage } from '../actions'
import { ACTIONS, actionFor, bindings, comboLabel } from '../custom/keybinds'
import { railLayout } from '../components/railOrder'
import { navigate } from '../router'
import { firstText, isUnread, mentionCount, sidebar, unreadChannels } from '../selectors'
import { cmpId, getState, setState } from '../store'
import type { Channel } from '../types'
import { setSelfDeaf, setSelfMute, toggleCamera, toggleScreen } from '../voice/engine'
import { deviceZoom, setDeviceZoom } from '../appearance/apply'

/** Shortcut list for the Ctrl+/ sheet: [keys, description], from the keybinds in effect (v6: rebindable). */
export function shortcutList(): [string, string][] {
  const b = bindings()
  return [
    ...ACTIONS.filter(([id]) => b[id]).map(([id, label]): [string, string] => [comboLabel(b[id]), label]),
    ['Ctrl+B / Ctrl+I / Ctrl+U', 'Bold, italic or underline selected text'],
    ['Ctrl+- / Ctrl++ / Ctrl+0', 'Zoom in, out or reset display scale'],
    ['Shift+Enter', 'New line in the message box'],
    ['↑ (empty message box)', 'Edit your last message'],
  ]
}

const channelPath = (c: Channel) => `/channels/${c.guild_id ?? '@me'}/${c.id}`
/** Channels in sidebar order for the current guild (or DMs at home). */
function navList(guildId: string): Channel[] {
  const s = getState()
  if (guildId === '@me') return Object.values(s.channels).filter((c) => c.type === 1 || c.type === 3).sort((a, b) => cmpId(b.last_message_id ?? b.id, a.last_message_id ?? a.id))
  return sidebar(s, guildId).flatMap((g) => g.channels).filter((c) => c.type !== 4)
}

export function useShortcuts(guildId: string, channelId?: string) {
  const where = useRef({ guildId, channelId })
  where.current = { guildId, channelId }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { guildId: g, channelId: c } = where.current
      const s = getState()
      const typing = e.target instanceof HTMLElement && e.target.closest('input, textarea, select, [contenteditable="true"]')
      const go = (to: string) => (e.preventDefault(), setState({ showNav: false }), navigate(to))
      if (e.defaultPrevented) return
      // Zoom shortcuts: Ctrl+- / Cmd+-, Ctrl+= / Cmd+=, Ctrl+0 / Cmd+0
      if (e.ctrlKey || e.metaKey) {
        if (e.key === '-' || e.key === '_' || e.key === 'Subtract' || e.code === 'NumpadSubtract') {
          e.preventDefault()
          const cur = deviceZoom()
          setDeviceZoom(Math.max(50, cur - 10))
          return
        }
        if (e.key === '=' || e.key === '+' || e.key === 'Add' || e.code === 'NumpadAdd') {
          e.preventDefault()
          const cur = deviceZoom()
          setDeviceZoom(Math.min(200, cur + 10))
          return
        }
        if (e.key === '0' || e.code === 'Numpad0') {
          e.preventDefault()
          setDeviceZoom(100)
          return
        }
      }
      const action = actionFor(e)
      if (!action || (e.target instanceof HTMLElement && e.target.closest('[data-keybind-recorder]'))) return
      if (action === 'quick-switcher') return e.preventDefault(), setState({ modal: { kind: 'quick-switcher' }, popout: null })
      if (action === 'shortcuts') return e.preventDefault(), setState({ modal: { kind: 'shortcuts' } })
      if (document.querySelector('dialog[open]')) return // dialogs keep their own keys
      const step = action.startsWith('prev-') ? -1 : action.startsWith('next-') ? 1 : 0
      switch (action) {
        case 'toggle-mute': return e.preventDefault(), setSelfMute(!s.voice.selfMute)
        case 'toggle-deafen': return e.preventDefault(), setSelfDeaf(!s.voice.selfDeaf)
        case 'toggle-camera': return s.voice.channelId ? (e.preventDefault(), void toggleCamera()) : undefined
        case 'toggle-screen': return s.voice.channelId ? (e.preventDefault(), void toggleScreen()) : undefined
        case 'emoji': return e.preventDefault(), dispatchEvent(new Event('cillcord:emoji'))
        case 'upload': return e.preventDefault(), dispatchEvent(new Event('cillcord:upload'))
        case 'prev-server': case 'next-server': {
          const ids = ['@me', ...railLayout(s).flatMap((f) => f.guild_ids)]
          const i = ids.indexOf(g)
          const next = ids[(i + step + ids.length) % ids.length]
          const first = next === '@me' ? undefined : firstText(s, next)
          return go(next === '@me' ? '/channels/@me' : `/channels/${next}${first ? `/${first.id}` : ''}`)
        }
        case 'prev-unread': case 'next-unread': {
          const list = unreadChannels(s).filter((x) => x.id !== c)
          const target = step > 0 ? list[0] : list.at(-1)
          return target ? go(channelPath(target)) : undefined
        }
        case 'prev-channel': case 'next-channel': {
          if (typing && !e.altKey && !e.ctrlKey && !e.metaKey) return // a bare key rebinding must not steal typing
          const list = navList(g)
          const i = list.findIndex((x) => x.id === c)
          const next = list[(i + step + list.length) % list.length]
          return next ? go(channelPath(next)) : undefined
        }
        case 'mark-server-read': {
          if (g === '@me') return
          const list = sidebar(s, g).flatMap((x) => x.channels).filter((x) => x.last_message_id && (isUnread(s, x) || mentionCount(s, x.id)))
          return e.preventDefault(), void ackBulk(list).catch(() => {})
        }
        case 'mark-read':
          // Marks the open channel read, unless something else (menus, replies, edits) used the key.
          if (e.defaultPrevented || !c || (typing && (e.target as HTMLElement).closest('.edit'))) return
          {
            const ch = s.channels[c]
            if (ch?.last_message_id && (isUnread(s, ch) || mentionCount(s, ch.id))) ackMessage(ch.id, ch.last_message_id)
          }
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [])
}

/** Fuzzy score: every query character in order; earlier, consecutive and word-start matches score higher. -1 = no match. */
export function fuzzy(query: string, text: string) {
  const q = query.toLowerCase()
  const s = text.toLowerCase()
  if (!q) return 0
  let score = 0
  let j = 0
  let streak = 0
  for (let i = 0; i < s.length && j < q.length; i++) {
    if (s[i] !== q[j]) { streak = 0; continue }
    streak++
    score += 1 + streak * 2 + (i === 0 || /[\s\-_#@]/.test(s[i - 1]) ? 5 : 0) - i * 0.01
    j++
  }
  return j === q.length ? score + (s.startsWith(q) ? 20 : 0) : -1
}

if (import.meta.env.DEV) {
  console.assert(fuzzy('gen', 'general') > fuzzy('gen', 'big-energy'), 'prefix wins')
  console.assert(fuzzy('gnrl', 'general') > 0 && fuzzy('xyz', 'general') === -1, 'subsequence')
}
