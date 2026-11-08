// Header search box with filter suggestions (from:, mentions:, has:, in:, before:/after:/during:, pinned:).
import { t } from '../i18n'
import { useId, useState, type KeyboardEvent } from 'react'
import { cls, Icon, ICONS } from '../components/ui'
import { sidebar } from '../selectors'
import { displayName, getState, setState, useStore } from '../store'
import type { Channel } from '../types'
import { FILTERS, HAS } from './query'
import './search.css'

type Option = { key: string; label: string; hint?: string; insert: string }

function options(guildId: string | undefined, channel: Channel, q: string): Option[] {
  const s = getState()
  const last = q.split(/\s+/).at(-1) ?? ''
  const m = /^(from|mentions|has|in|pinned|before|after|during):(\S*)$/.exec(last)
  if (!m) {
    const part = last.toLowerCase()
    return FILTERS.filter((f) => !part || f.key.startsWith(part)).filter((f) => guildId || f.key !== 'in').map((f) => ({ key: f.key, label: `${f.key}:`, hint: t(f.hint), insert: `${f.key}:` }))
  }
  const [, key, val] = m
  const v = val.toLowerCase()
  if (key === 'from' || key === 'mentions') {
    const ids = guildId ? Object.keys(s.members[guildId] ?? {}) : [...(channel.recipients ?? []).map((u) => u.id), s.me?.id ?? '']
    return ids.map((id) => s.users[id]).filter((u) => u && (u.username.toLowerCase().startsWith(v) || displayName(u).toLowerCase().startsWith(v))).slice(0, 8)
      .map((u) => ({ key: u.id, label: displayName(u), hint: u.username, insert: `${key}:${u.username}` }))
  }
  if (key === 'has') return HAS.filter((h) => h.startsWith(v)).map((h) => ({ key: h, label: h, insert: `has:${h}` }))
  if (key === 'pinned') return ['true', 'false'].map((x) => ({ key: x, label: x, insert: `pinned:${x}` }))
  if (key === 'in' && guildId)
    return sidebar(s, guildId).flatMap((g) => g.channels).filter((c) => c.type !== 2 && c.type !== 13 && c.name?.toLowerCase().startsWith(v)).slice(0, 8)
      .map((c) => ({ key: c.id, label: `#${c.name}`, insert: `in:${c.name}` }))
  const today = new Date().toISOString().slice(0, 10)
  return [{ key: 'date', label: today, hint: 'YYYY-MM-DD', insert: `${key}:${today}` }]
}

export function SearchBox({ guildId, channel }: { guildId?: string; channel: Channel }) {
  const current = useStore((s) => (s.panel?.kind === 'search' && (s.panel.guildId ? s.panel.guildId === guildId : s.panel.channelId === channel.id) ? s.panel.query : ''))
  const [q, setQ] = useState(current)
  const [open, setOpen] = useState(false)
  const [sel, setSel] = useState(0)
  const id = useId()
  const list = open ? options(guildId, channel, q) : []
  const run = (query = q) => {
    if (!query.trim()) return
    setOpen(false)
    setState({ panel: { kind: 'search', ...(guildId ? { guildId } : { channelId: channel.id }), query: query.trim() }, showNav: false })
  }
  const choose = (o: Option) => {
    const next = q.replace(/\S*$/, o.insert) + (o.insert.endsWith(':') ? '' : ' ')
    setQ(next)
    setSel(0)
  }
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!list.length) return
      e.preventDefault()
      setOpen(true)
      setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + list.length) % list.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const lastTok = q.split(/\s+/).at(-1) ?? ''
      // Enter completes a half-typed filter, otherwise searches.
      if (list[sel] && open && /^\w+:\S*$/.test(lastTok) && !list.some((o) => o.insert === lastTok)) choose(list[sel])
      else if (list[sel] && open && lastTok && !lastTok.includes(':') && FILTERS.some((f) => f.key === lastTok)) choose(list[sel])
      else run()
    } else if (e.key === 'Escape') {
      if (open) (e.preventDefault(), e.stopPropagation(), setOpen(false))
      else if (q) setQ('')
    }
  }
  return (
    <div className={cls('search-box', (open || q) && 'wide')}>
      <input
        type="search"
        className="search-input"
        placeholder={t('Search')}
        aria-label={guildId ? t('Search this server') : t('Search this conversation')}
        role="combobox"
        aria-expanded={list.length > 0}
        aria-controls={id}
        aria-activedescendant={list[sel] ? `${id}-${sel}` : undefined}
        aria-autocomplete="list"
        value={q}
        onChange={(e) => (setQ(e.target.value), setOpen(true), setSel(0))}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKey}
      />
      <Icon d={ICONS.search} size={16} className="search-icon" />
      {list.length > 0 && (
        <div className="search-suggest">
          <h3 className="list-heading">{/:\S*$/.test(q.split(/\s+/).at(-1) ?? '') ? t('Suggestions') : t('Search Options')}</h3>
          <ul id={id} role="listbox" aria-label={t('Search options')}>
            {list.map((o, i) => (
              <li key={o.key} id={`${id}-${i}`} role="option" aria-selected={i === sel} className={cls('ac-item', i === sel && 'active')}
                onMouseDown={(e) => (e.preventDefault(), choose(o))} onMouseEnter={() => setSel(i)}>
                <strong>{o.label}</strong>{o.hint && <span className="hint small">{o.hint}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
