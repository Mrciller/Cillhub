// Ctrl/Cmd+K command palette and quick switcher across servers, channels, DMs, friends, and quick actions (fuzzy).
import { useState, type KeyboardEvent } from 'react'
import { openDm, setStatus } from '../actions'
import { toastError } from '../components/dialogs'
import { Avatar, channelIcon, cls, GuildIcon, Icon, ICONS, Modal } from '../components/ui'
import { t } from '../i18n'
import { navigate } from '../router'
import { firstText, isUnread, mentionCount, privateName, sidebar, VOICE_TYPES } from '../selectors'
import { cmpId, displayName, setState, useStore } from '../store'
import { leaveVoice, setSelfDeaf, setSelfMute } from '../voice/engine'
import { fuzzy } from './shortcuts'

type Item = { key: string; kind: 'guild' | 'channel' | 'voice' | 'dm' | 'user' | 'action'; label: string; sub?: string; go: () => void; icon: React.ReactNode; unread?: boolean; mentions?: number; recent: string }

export function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const s = useStore((x) => x)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const go = (path: string) => () => (onClose(), setState({ showNav: false }), navigate(path))
  const items: Item[] = []
  for (const g of Object.values(s.guilds)) {
    const first = firstText(s, g.id)
    items.push({ key: 'g' + g.id, kind: 'guild', label: g.name, go: go(`/channels/${g.id}${first ? `/${first.id}` : ''}`), icon: <span className="qs-guild"><GuildIcon guild={g} /></span>, recent: g.id })
    for (const grp of sidebar(s, g.id))
      for (const c of grp.channels) {
        const ic = channelIcon(c.type)
        items.push({
          key: 'c' + c.id, kind: VOICE_TYPES.has(c.type) ? 'voice' : 'channel', label: c.name ?? '', sub: g.name, go: go(`/channels/${g.id}/${c.id}`),
          icon: ic ? <Icon d={ic} size={18} /> : <span className="hash" aria-hidden="true">#</span>, unread: isUnread(s, c), mentions: mentionCount(s, c.id), recent: c.last_message_id ?? c.id,
        })
      }
  }
  const dmUsers = new Set<string>()
  for (const c of Object.values(s.channels).filter((x) => x.type === 1 || x.type === 3)) {
    if (c.type === 1 && c.recipients?.[0]) dmUsers.add(c.recipients[0].id)
    items.push({ key: 'd' + c.id, kind: 'dm', label: privateName(s, c), sub: c.type === 3 ? t('Group DM') : c.recipients?.[0]?.username, go: go(`/channels/@me/${c.id}`), icon: <Avatar user={c.recipients?.[0]} size={20} />, unread: isUnread(s, c), mentions: mentionCount(s, c.id), recent: c.last_message_id ?? c.id })
  }
  for (const r of Object.values(s.relationships).filter((x) => x.type === 1 && !dmUsers.has(x.id))) {
    const u = s.users[r.id] ?? r.user
    items.push({ key: 'u' + u.id, kind: 'user', label: displayName(u), sub: u.username, go: () => (onClose(), void openDm(u.id).catch(toastError)), icon: <Avatar user={u} size={20} />, recent: '0' })
  }

  // Quick Action Commands (Command Palette)
  items.push(
    { key: 'a-mute', kind: 'action', label: s.voice.selfMute ? t('Unmute Microphone') : t('Mute Microphone'), sub: '/mute', go: () => (onClose(), setSelfMute(!s.voice.selfMute)), icon: <Icon d={s.voice.selfMute ? ICONS.micOff : ICONS.mic} size={18} />, recent: '0' },
    { key: 'a-deaf', kind: 'action', label: s.voice.selfDeaf ? t('Undeafen Audio') : t('Deafen Audio'), sub: '/deafen', go: () => (onClose(), setSelfDeaf(!s.voice.selfDeaf)), icon: <Icon d={ICONS.headset} size={18} />, recent: '0' },
    { key: 'a-leave', kind: 'action', label: t('Disconnect from Voice'), sub: '/disconnect', go: () => (onClose(), leaveVoice()), icon: <Icon d={ICONS.hangup} size={18} />, recent: '0' },
    { key: 'a-settings', kind: 'action', label: t('User Settings'), sub: '/settings', go: () => (onClose(), setState({ modal: { kind: 'user' } })), icon: <Icon d={ICONS.gear} size={18} />, recent: '0' },
    { key: 'a-online', kind: 'action', label: t('Set Status: Online'), sub: '/status online', go: () => (onClose(), setStatus('online')), icon: <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--online)', display: 'inline-block' }} />, recent: '0' },
    { key: 'a-idle', kind: 'action', label: t('Set Status: Idle'), sub: '/status idle', go: () => (onClose(), setStatus('idle')), icon: <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--idle)', display: 'inline-block' }} />, recent: '0' },
    { key: 'a-dnd', kind: 'action', label: t('Set Status: Do Not Disturb'), sub: '/status dnd', go: () => (onClose(), setStatus('dnd')), icon: <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--danger)', display: 'inline-block' }} />, recent: '0' },
    { key: 'a-invisible', kind: 'action', label: t('Set Status: Invisible'), sub: '/status invisible', go: () => (onClose(), setStatus('invisible')), icon: <span style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--offline)', display: 'inline-block' }} />, recent: '0' },
  )

  const prefix = q[0]
  const kinds = prefix === '@' ? ['dm', 'user']
    : prefix === '#' ? ['channel']
    : prefix === '!' ? ['voice']
    : prefix === '*' ? ['guild']
    : (prefix === '/' || prefix === '>') ? ['action']
    : null
  const query = kinds ? q.slice(1).trim() : q.trim()
  const results = items
    .filter((i) => !kinds || kinds.includes(i.kind))
    .map((i) => ({ i, score: Math.max(fuzzy(query, i.label), i.sub ? fuzzy(query, i.sub) - 10 : -1) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => (query ? b.score - a.score : 0) || Number(!!b.i.mentions) - Number(!!a.i.mentions) || Number(!!b.i.unread) - Number(!!a.i.unread) || cmpId(b.i.recent, a.i.recent))
    .slice(0, 12)
    .map((x) => x.i)
  const active = Math.min(sel, results.length - 1)
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return e.preventDefault(), setSel((active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length)
    if (e.key === 'Enter') return e.preventDefault(), results[active]?.go()
  }
  return (
    <Modal title={t('Quick Switcher')} onClose={onClose} className="quick-switcher" hideTitle>
      <input className="input qs-input" role="combobox" aria-expanded aria-controls="qs-list" aria-activedescendant={results[active] ? `qs-${results[active].key}` : undefined}
        aria-label={t('Where would you like to go?')} placeholder={t('Type a command (/), channel (#), or where to go…')} value={q} autoFocus onChange={(e) => (setQ(e.target.value), setSel(0))} onKeyDown={onKey} />
      <ul id="qs-list" role="listbox" aria-label={t('Results')} className="qs-list">
        {results.map((r, i) => (
          <li key={r.key} id={`qs-${r.key}`} role="option" aria-selected={i === active} className={cls('qs-item', i === active && 'active', r.unread && 'unread')} onMouseEnter={() => setSel(i)} onClick={r.go}>
            {r.icon}<span className="ellipsis">{r.label}</span>{r.sub && <span className="hint small ellipsis">{r.sub}</span>}
            {!!r.mentions && <span className="badge">{r.mentions}</span>}
          </li>
        ))}
      </ul>
      {!results.length && <p className="hint">{t("Can't find what you're looking for?")}</p>}
      <p className="hint small qs-tip">{t('Protip: start with / for quick commands, @ for people, # for text, ! for voice or * for servers.')}</p>
    </Modal>
  )
}
