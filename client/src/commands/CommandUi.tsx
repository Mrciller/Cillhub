// The slash command picker above the composer and the option entry that replaces the message box once a command is chosen.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react'
import { toastError } from '../components/dialogs'
import { cls, Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { sortedRoles } from '../permissions'
import { displayName, getState, setState, useStore } from '../store'
import type { Channel, CommandOption } from '../types'
import { autocomplete, runCommand, type Entry, type Values } from './commands'
import './commands.css'

/** Matching commands for `/query`. */
export function CommandPicker({ entries, sel, listId, onPick, onHover }: { entries: Entry[]; sel: number; listId: string; onPick: (e: Entry) => void; onHover: (i: number) => void }) {
  return (
    <div className="autocomplete command-picker">
      <h3 className="list-heading">{t('Commands')}</h3>
      <ul id={listId} role="listbox" aria-label={t('Commands')}>
        {entries.map((e, i) => (
          <li key={e.path.join(' ') + e.cmd.id} id={`${listId}-${i}`} role="option" aria-selected={i === sel} className={cls('ac-item', i === sel && 'active')}
            onMouseDown={(ev) => (ev.preventDefault(), onPick(e))} onMouseEnter={() => onHover(i)}>
            <span className="ac-label">/{e.path.join(' ')}</span>
            {e.options.map((o) => <span key={o.name} className={cls('opt-pill', o.required && 'req')}>{o.name}</span>)}
            <span className="hint small ellipsis">{e.description}</span>
            <span className="hint small cmd-app">{e.app}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const MAX_UPLOAD = 25 * 1024 * 1024 // the server's attachment_size_limit

const TYPE_HINT: Record<number, string> = { 3: 'text', 4: 'integer', 5: 'True or False', 6: 'user', 7: 'channel', 8: 'role', 9: 'user or role', 10: 'number', 11: 'file' }

/** Choices for user / role / channel / boolean options from the store. */
function staticChoices(o: CommandOption, channel: Channel): { name: string; value: string }[] | null {
  const s = getState()
  const gid = channel.guild_id
  if (o.choices?.length) return o.choices.map((c) => ({ name: c.name, value: String(c.value) }))
  if (o.type === 5) return [{ name: t('True'), value: 'true' }, { name: t('False'), value: 'false' }]
  const users = () => (gid ? Object.keys(s.members[gid] ?? {}) : [...(channel.recipients ?? []).map((u) => u.id), s.me?.id ?? '']).map((id) => ({ name: displayName(s.users[id]), value: id }))
  const roles = () => (gid && s.guilds[gid] ? sortedRoles(s.guilds[gid]).filter((r) => r.id !== gid).map((r) => ({ name: '@' + r.name, value: r.id })) : [])
  if (o.type === 6) return users()
  if (o.type === 8) return roles()
  if (o.type === 9) return [...users(), ...roles()]
  if (o.type === 7) return gid ? Object.values(s.channels).filter((c) => c.guild_id === gid && c.type !== 4 && (!o.channel_types?.length || o.channel_types.includes(c.type))).map((c) => ({ name: '#' + c.name, value: c.id })) : []
  return null
}

function OptionField({ o, channel, entry, values, set, onSubmit, autoFocus }: { o: CommandOption; channel: Channel; entry: Entry; values: Values; set: (v: string | File) => void; onSubmit: () => void; autoFocus: boolean }) {
  const id = useId()
  const fixed = staticChoices(o, channel)
  const [nonce, setNonce] = useState<string | null>(null)
  const ac = useStore((s) => (nonce && s.autocomplete?.nonce === nonce ? s.autocomplete.choices : null))
  const timer = useRef(0)
  const value = values[o.name] === undefined || values[o.name] instanceof File ? '' : String(values[o.name])
  const keys = (e: KeyboardEvent) => e.key === 'Enter' && (e.preventDefault(), onSubmit())
  const label = <label htmlFor={id} className="opt-label">{o.name}{o.required ? '' : <span className="hint"> {t('(optional)')}</span>}</label>
  if (o.type === 11)
    return (
      <div className="cmd-opt">{label}
        <input id={id} type="file" className="input" autoFocus={autoFocus} title={o.description} aria-describedby={`${id}-d`} onKeyDown={keys}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) set(f) }} />
        <span id={`${id}-d`} className="sr-only">{o.description}</span>
      </div>
    )
  if (fixed && !o.autocomplete)
    return (
      <div className="cmd-opt">{label}
        <select id={id} className="input" value={value} autoFocus={autoFocus} onChange={(e) => set(e.target.value)} onKeyDown={keys} aria-describedby={`${id}-d`}>
          <option value="">{t('Choose…')}</option>
          {fixed.map((c) => <option key={c.value} value={c.value}>{c.name}</option>)}
        </select>
        <span id={`${id}-d`} className="sr-only">{o.description}</span>
      </div>
    )
  return (
    <div className="cmd-opt">{label}
      <input id={id} className="input" autoFocus={autoFocus} value={value} title={o.description} aria-describedby={`${id}-d`} placeholder={t(TYPE_HINT[o.type] ?? 'text')}
        type={o.type === 4 || o.type === 10 ? 'number' : 'text'} min={o.min_value} max={o.max_value} step={o.type === 4 ? 1 : 'any'} minLength={o.min_length} maxLength={o.max_length}
        list={ac ? `${id}-ac` : undefined} onKeyDown={keys}
        onChange={(e) => {
          set(e.target.value)
          if (!o.autocomplete) return
          clearTimeout(timer.current)
          const next = { ...values, [o.name]: e.target.value }
          timer.current = window.setTimeout(() => void autocomplete(channel, entry, next, o.name).then(setNonce, () => {}), 250)
        }} />
      {ac && <datalist id={`${id}-ac`}>{ac.map((c) => <option key={String(c.value)} value={String(c.value)}>{c.name}</option>)}</datalist>}
      {ac && ac.length > 0 && (
        <ul className="ac-choices" role="listbox" aria-label={t('Suggestions for {name}', { name: o.name })}>
          {ac.map((c) => <li key={String(c.value)} role="option" aria-selected={value === String(c.value)}><button type="button" onClick={() => set(String(c.value))}>{c.name}</button></li>)}
        </ul>
      )}
      <span id={`${id}-d`} className="sr-only">{o.description}</span>
    </div>
  )
}

/** Option entry for a chosen command: required options first, optional ones added on demand; Enter runs it. */
export function CommandForm({ channel, entry, onClose }: { channel: Channel; entry: Entry; onClose: () => void }) {
  const [values, setValues] = useState<Values>({})
  const [shown, setShown] = useState<string[]>(() => entry.options.filter((o) => o.required).map((o) => o.name))
  const [error, setError] = useState('')
  const optional = entry.options.filter((o) => !o.required && !shown.includes(o.name))
  useEffect(() => setState({ autocomplete: null }), [])
  const submit = () => {
    const missing = entry.options.find((o) => o.required && (values[o.name] === undefined || values[o.name] === ''))
    if (missing) return setError(t('{name} is required.', { name: missing.name }))
    const bad = entry.options.find((o) => (o.type === 4 || o.type === 10) && values[o.name] !== undefined && values[o.name] !== '' && Number.isNaN(Number(values[o.name])))
    if (bad) return setError(t('{name} must be a number.', { name: bad.name }))
    const big = entry.options.find((o) => o.type === 11 && values[o.name] instanceof File && (values[o.name] as File).size > MAX_UPLOAD)
    if (big) return setError(t('Files must be {size} or smaller.', { size: '25 MB' }))
    onClose()
    void runCommand(channel, entry, values).catch(toastError)
  }
  return (
    <div className="command-form" role="group" aria-label={t('Command /{name}', { name: entry.path.join(' ') })} onKeyDown={(e) => e.key === 'Escape' && (e.preventDefault(), e.stopPropagation(), onClose())}>
      <div className="cmd-head">
        <span className="cmd-chip"><Icon d={ICONS.slash} size={14} />{entry.path.join(' ')}</span>
        <span className="hint small ellipsis">{entry.description} · {entry.app}</span>
        <button className="icon-btn" aria-label={t('Cancel command')} onClick={onClose}><Icon d={ICONS.close} size={16} /></button>
      </div>
      <div className="cmd-opts">
        {entry.options.filter((o) => shown.includes(o.name)).map((o, i) => (
          <OptionField key={o.name} o={o} channel={channel} entry={entry} values={values} autoFocus={i === 0} onSubmit={submit} set={(v) => (setValues({ ...values, [o.name]: v }), setError(''))} />
        ))}
        {!entry.options.length && <p className="hint small">{t('Press Enter or Send to run this command.')}</p>}
      </div>
      {optional.length > 0 && (
        <p className="cmd-optional small"><span className="hint">{t('Optional:')}</span> {optional.map((o) => <button key={o.name} className="opt-pill" onClick={() => setShown([...shown, o.name])}>+ {o.name}</button>)}</p>
      )}
      {error && <p className="send-error" role="alert">{error}</p>}
      <div className="cmd-actions">
        <button className="primary small-btn" onClick={submit} autoFocus={!entry.options.some((o) => o.required)}>{t('Send')}</button>
      </div>
    </div>
  )
}
