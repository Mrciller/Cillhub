// Message components (developers/components): action rows, buttons (link buttons ask before leaving), and all select menus.
// Using one sends a MESSAGE_COMPONENT interaction (type 3) through POST /interactions.
import { useState } from 'react'
import { sendInteraction } from '../actions'
import { ask, toastError } from '../components/dialogs'
import { Popover, type Anchor } from '../components/menu'
import { cls, Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { CustomEmoji, safeUrl } from '../markdown/Markdown'
import { sortedRoles } from '../permissions'
import { displayName, getState, useStore } from '../store'
import type { Component, Message, SelectOption } from '../types'
import './components-ui.css'

const STYLE = ['', 'primary', 'secondary', 'success', 'danger', 'link', 'premium']
const SELECTS = new Set([3, 5, 6, 7, 8])

export const CEmoji = ({ e }: { e?: Component['emoji'] }) =>
  e?.id ? <CustomEmoji id={e.id} name={e.name ?? ''} animated={e.animated} /> : e?.name ? <span className="emoji" aria-hidden="true">{e.name}</span> : null

/** Where an interaction for this message goes: its application (bots set application_id; else the bot author). */
const appOf = (m: Message) => m.application_id ?? m.author.id

function useComponentState(m: Message, customId?: string) {
  return useStore((s) => Object.values(s.interactions).find((i) => i.kind === 'component' && i.messageId === m.id && i.customId === customId))
}

function send(m: Message, c: Component, values?: string[]) {
  void sendInteraction(
    { type: 3, application_id: appOf(m), guild_id: m.guild_id, channel_id: m.channel_id, message_id: m.id, message_flags: m.flags ?? 0, data: { component_type: c.type, custom_id: c.custom_id, ...(values && { values }) } },
    { kind: 'component', channelId: m.channel_id, appId: appOf(m), messageId: m.id, customId: c.custom_id },
  ).catch(toastError)
}

function Button({ m, c }: { m: Message; c: Component }) {
  const pending = useComponentState(m, c.custom_id)
  const busy = pending && pending.state !== 'failed'
  if (c.style === 5 && c.url) {
    const url = safeUrl(c.url) // node messages skip the server's link-button check
    const open = () =>
      void ask({
        title: t('Leaving Cillhub'),
        body: <><p>{t('This link is taking you to the following website')}</p><p className="leave-url">{c.url}</p><p className="hint">{t('Are you sure you want to go there?')}</p></>,
        confirm: t('Visit Site'),
      }).then((ok) => ok && url && window.open(url, '_blank', 'noopener,noreferrer'))
    return (
      <button className={cls('cbtn', 'link')} disabled={c.disabled || !url} onClick={open}>
        <CEmoji e={c.emoji} />{c.label}<Icon d={ICONS.external} size={14} />
      </button>
    )
  }
  return (
    <button className={cls('cbtn', STYLE[c.style ?? 2] ?? 'secondary', busy && 'busy')} disabled={c.disabled || busy || c.style === 6} aria-busy={busy || undefined} onClick={() => send(m, c)}>
      {busy ? <span className="dots" aria-label={t('Loading')}><i /><i /><i /></span> : <><CEmoji e={c.emoji} />{c.label}</>}
    </button>
  )
}

/** Options of a select: its own (string select) or users / roles / channels from the server. */
function optionsFor(m: Message, c: Component): SelectOption[] {
  if (c.type === 3) return c.options ?? []
  const s = getState()
  const gid = m.guild_id
  const users = (gid ? Object.keys(s.members[gid] ?? {}) : (s.channels[m.channel_id]?.recipients ?? []).map((u) => u.id)).map((id) => ({ label: displayName(s.users[id]), value: id, description: s.users[id]?.username }))
  const roles = gid && s.guilds[gid] ? sortedRoles(s.guilds[gid]).filter((r) => r.id !== gid).map((r) => ({ label: '@' + r.name, value: r.id })) : []
  const channels = gid ? Object.values(s.channels).filter((x) => x.guild_id === gid && x.type !== 4 && (!c.channel_types?.length || c.channel_types.includes(x.type))).map((x) => ({ label: '#' + x.name, value: x.id })) : []
  return c.type === 5 ? users : c.type === 6 ? roles : c.type === 7 ? [...users, ...roles] : channels
}

function Select({ m, c }: { m: Message; c: Component }) {
  const [at, setAt] = useState<Anchor | null>(null)
  const [picked, setPicked] = useState<string[]>(() => [...(c.options ?? []).filter((o) => o.default).map((o) => o.value), ...(c.default_values ?? []).map((d) => d.id)])
  const pending = useComponentState(m, c.custom_id)
  const busy = pending && pending.state !== 'failed'
  const min = c.min_values ?? 1
  const max = c.max_values ?? 1
  const opts = optionsFor(m, c)
  const label = picked.length ? opts.filter((o) => picked.includes(o.value)).map((o) => o.label).join(', ') : (c.placeholder ?? t('Make a selection'))
  const finish = (values: string[]) => {
    setAt(null)
    if (values.length >= min) send(m, c, values)
  }
  return (
    <>
      <button className="cselect input" aria-haspopup="listbox" aria-expanded={!!at} disabled={c.disabled || busy} onClick={(e) => setAt({ rect: e.currentTarget.getBoundingClientRect(), side: 'below' })}>
        <span className={cls('ellipsis', !picked.length && 'hint')}>{label}</span>
        <Icon d={ICONS.expand} size={18} />
      </button>
      {at && (
        <Popover at={at} onClose={() => (max > 1 && picked.length >= min ? finish(picked) : setAt(null))} label={c.placeholder ?? t('Make a selection')} className="cselect-pop">
          <ul role="listbox" aria-multiselectable={max > 1} aria-label={c.placeholder ?? t('Options')}>
            {opts.map((o) => {
              const on = picked.includes(o.value)
              return (
                <li key={o.value} role="option" aria-selected={on}>
                  <button className={cls('copt', on && 'on')} disabled={!on && max > 1 && picked.length >= max}
                    onClick={() => (max === 1 ? (setPicked([o.value]), finish([o.value])) : setPicked(on ? picked.filter((x) => x !== o.value) : [...picked, o.value]))}>
                    <CEmoji e={o.emoji} />
                    <span className="copt-text"><span className="ellipsis">{o.label}</span>{o.description && <span className="hint small ellipsis">{o.description}</span>}</span>
                    {max > 1 && <span className={cls('check', on && 'on')} aria-hidden="true" />}
                  </button>
                </li>
              )
            })}
          </ul>
          {max > 1 && <div className="modal-actions"><button className="primary small-btn" disabled={picked.length < min} onClick={() => finish(picked)}>{t('Done')}</button></div>}
        </Popover>
      )}
    </>
  )
}

export function MessageComponents({ m }: { m: Message }) {
  const failed = useStore((s) => Object.values(s.interactions).some((i) => i.kind === 'component' && i.messageId === m.id && i.state === 'failed'))
  if (!m.components?.length) return null
  return (
    <div className="components">
      {m.components.map((row, i) => (
        <div key={i} className="crow" role="group">
          {(row.type === 1 ? row.components ?? [] : [row]).map((c, j) =>
            // an edited message brings fresh components: a select starts over from its defaults (stale picks may be gone)
            c.type === 2 ? <Button key={c.custom_id ?? c.url ?? j} m={m} c={c} /> : SELECTS.has(c.type) ? <Select key={`${c.custom_id ?? j}:${m.edited_timestamp ?? ''}`} m={m} c={c} /> : null)}
        </div>
      ))}
      {failed && <p className="interaction-failed" role="alert"><Icon d={ICONS.warning} size={14} /> {t('This interaction failed')}</p>}
    </div>
  )
}
