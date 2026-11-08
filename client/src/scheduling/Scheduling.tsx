// "Send later", the scheduled messages list, "Remind me" and the reminders list (CONTRACT-v5 section 5).
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { cancelScheduled, editScheduled, openMessage, remindMe, removeReminder, scheduledMessages, scheduleMessage } from '../actions'
import { dateTime } from '../appearance/format'
import { toast, toastError } from '../components/dialogs'
import { MenuItem, Popover, type Anchor } from '../components/menu'
import { Avatar, cls, FormError, Icon, ICONS, Modal } from '../components/ui'
import { t } from '../i18n'
import { privateName } from '../selectors'
import { getState, isPrivate, useStore } from '../store'
import type { Channel, Message, SavedMessage, ScheduledMessage } from '../types'
import { SavedMessages } from '../chat/SavedMessages'
import { reminderText } from './reminders'
import './scheduling.css'

const pad = (n: number) => String(n).padStart(2, '0')
/** Local `YYYY-MM-DDTHH:mm` for <input type="datetime-local">. */
const toInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
const inAnHour = () => new Date(Math.ceil((Date.now() + 3600e3) / 300e3) * 300e3) // next full 5 minutes after an hour
const where = (c: Channel | undefined) => {
  const s = getState()
  if (!c) return ''
  return isPrivate(c) ? privateName(s, c) : `#${c.name} · ${s.guilds[c.guild_id!]?.name ?? ''}`
}

/** Date/time dialog shared by Send later and the custom reminder. */
function WhenModal({ title, confirm, initial, onSubmit, onClose, children }: {
  title: string; confirm: string; initial: Date; onSubmit: (when: Date) => Promise<unknown>; onClose: () => void; children?: ReactNode
}) {
  const [value, setValue] = useState(toInput(initial))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const when = new Date(value)
  const valid = !Number.isNaN(when.getTime()) && when.getTime() > Date.now() + 30e3
  const submit = () => {
    if (!valid) return setError(t('Pick a time in the future.'))
    setBusy(true)
    onSubmit(when).then(onClose, (e: Error) => (setError(e.message), setBusy(false)))
  }
  return (
    <Modal title={title} onClose={onClose}>
      <form onSubmit={(e) => (e.preventDefault(), submit())}>
        {children}
        <div className="field">
          <label htmlFor="when-at">{t('Date and time')}</label>
          <input id="when-at" type="datetime-local" className="input" value={value} min={toInput(new Date())} onChange={(e) => (setValue(e.target.value), setError(''))} required />
          {valid && <p className="hint small" aria-live="polite">{dateTime(when.getTime())}</p>}
        </div>
        <FormError error={error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" disabled={busy}>{confirm}</button>
        </div>
      </form>
    </Modal>
  )
}

/** Composer "Send later": schedules the composed text for a chosen time (the server re-checks permissions when sending). */
export function SendLaterModal({ channel, content, onDone, onClose }: { channel: Channel; content: string; onDone: () => void; onClose: () => void }) {
  return (
    <WhenModal title={t('Send Later')} confirm={t('Schedule Message')} initial={inAnHour()} onClose={onClose}
      onSubmit={(when) => scheduleMessage(channel.id, content, when).then(() => (onDone(), toast(t('Message scheduled for {time}.', { time: dateTime(when.getTime()) }))))}>
      <p className="hint">{t('Sends to {where}', { where: where(channel) })}</p>
      <blockquote className="dialog-quote schedule-preview">{content.slice(0, 300)}</blockquote>
    </WhenModal>
  )
}

/** Inbox tab: our scheduled messages with edit and cancel. Both work inline: a dialog would close the inbox popover. */
export function ScheduledTab() {
  const [list, setList] = useState<ScheduledMessage[] | null>(null)
  const channels = useStore((s) => s.channels)
  useEffect(() => void scheduledMessages().then((l) => setList([...(l ?? [])].sort((a, b) => Date.parse(a.send_at) - Date.parse(b.send_at))), (e: Error) => (toastError(e), setList([]))), [])
  const update = (id: string, next: ScheduledMessage | null) => setList((l) => (next ? l?.map((x) => (x.id === id ? next : x)) : l?.filter((x) => x.id !== id)) ?? null)
  return (
    <>
      <p className="inbox-filters">{t('Messages you scheduled with Send later. They are sent at the chosen time.')}</p>
      {list === null ? <p className="hint inbox-empty" role="status">{t('Loading…')}</p>
        : !list.length ? <p className="hint inbox-empty">{t('No scheduled messages.')}</p>
        : (
          <ul className="inbox-list" aria-label={t('Scheduled messages')}>
            {list.map((m) => <ScheduledItem key={m.id} m={m} where={where(channels[m.channel_id])} onChange={(next) => update(m.id, next)} />)}
          </ul>
        )}
    </>
  )
}

function ScheduledItem({ m, where, onChange }: { m: ScheduledMessage; where: string; onChange: (next: ScheduledMessage | null) => void }) {
  const [mode, setMode] = useState<'view' | 'edit' | 'cancel'>('view')
  const [text, setText] = useState(m.content)
  const [at, setAt] = useState(toInput(new Date(m.send_at)))
  const [error, setError] = useState('')
  const save = (e: FormEvent) => {
    e.preventDefault()
    const when = new Date(at)
    if (!(when.getTime() > Date.now() + 30e3)) return setError(t('Pick a time in the future.'))
    editScheduled(m.id, { content: text.trim(), send_at: when.toISOString() })
      .then((r) => (onChange({ ...m, ...r, content: r?.content ?? text.trim(), send_at: r?.send_at ?? when.toISOString() }), setMode('view')), (err: Error) => setError(err.message))
  }
  return (
    <li className="inbox-item">
      <div className="inbox-where hint small">{where}</div>
      {mode === 'edit' ? (
        <form className="schedule-edit" onSubmit={save} aria-label={t('Edit Scheduled Message')}>
          <label className="sr-only" htmlFor={`sched-text-${m.id}`}>{t('Message')}</label>
          <textarea id={`sched-text-${m.id}`} className="input textarea" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
          <label className="sr-only" htmlFor={`sched-at-${m.id}`}>{t('Date and time')}</label>
          <input id={`sched-at-${m.id}`} type="datetime-local" className="input" value={at} min={toInput(new Date())} onChange={(e) => (setAt(e.target.value), setError(''))} required />
          <FormError error={error} />
          <div className="row-buttons">
            <button type="button" className="secondary small-btn" onClick={() => (setMode('view'), setText(m.content), setError(''))}>{t('Cancel')}</button>
            <button className="primary small-btn" disabled={!text.trim()}>{t('Save')}</button>
          </div>
        </form>
      ) : (
        <div className="inbox-msg">
          <Icon d={ICONS.clock} size={20} className="schedule-icon" />
          <div className="inbox-text">
            <p className="small"><strong>{dateTime(m.send_at)}</strong></p>
            <p className="schedule-text">{m.content}</p>
          </div>
          <div className="inbox-actions">
            {mode === 'cancel' ? (
              <>
                <span className="small" role="status">{t('Cancel scheduled message?')}</span>
                <button className="danger-btn small-btn" onClick={() => void cancelScheduled(m.id).then(() => onChange(null), toastError)}>{t('Cancel Message')}</button>
                <button className="secondary small-btn" onClick={() => setMode('view')}>{t('Keep')}</button>
              </>
            ) : (
              <>
                <button className="secondary small-btn" onClick={() => setMode('edit')}>{t('Edit')}</button>
                <button className="icon-btn" aria-label={t('Cancel scheduled message')} title={t('Cancel')} onClick={() => setMode('cancel')}><Icon d={ICONS.close} size={16} /></button>
              </>
            )}
          </div>
        </div>
      )}
    </li>
  )
}

/** Inbox tab: reminders set with "Remind me", due ones first. */
export function RemindersTab({ close }: { close: () => void }) {
  const reminders = useStore((s) => s.reminders)
  const list = Object.values(reminders).sort((a, b) => Date.parse(a.save_data.due_at ?? '') - Date.parse(b.save_data.due_at ?? ''))
  const now = Date.now()
  return !list.length ? <p className="hint inbox-empty">{t('No reminders. Right-click a message and pick Remind Me.')}</p> : (
    <ul className="inbox-list" aria-label={t('Reminders')}>
      {list.map((r) => <ReminderItem key={`${r.save_data.channel_id}-${r.save_data.message_id}`} r={r} due={Date.parse(r.save_data.due_at ?? '') <= now} close={close} />)}
    </ul>
  )
}

/** Inbox tab: bookmarked messages saved for later without a due date, newest first. */
export function BookmarksTab({ close }: { close: () => void }) {
  const bookmarks = useStore((s) => s.bookmarks)
  const list = Object.values(bookmarks).sort((a, b) => Date.parse(b.save_data.saved_at) - Date.parse(a.save_data.saved_at))
  return !list.length ? (
    <p className="hint inbox-empty">{t('No bookmarks yet. Click the bookmark icon on any message to save it here.')}</p>
  ) : (
    <SavedMessages close={close} />
  )
}

export function BookmarkItem({ r, close }: { r: SavedMessage; close: () => void }) {
  const channel = useStore((s) => s.channels[r.save_data.channel_id])
  const { channel_id, message_id, guild_id } = r.save_data
  return (
    <li className="inbox-item">
      <div className="inbox-where hint small">{where(channel)}</div>
      <div className="inbox-msg">
        {r.message ? <Avatar user={r.message.author} size={32} /> : <Icon d={ICONS.bookmark} size={20} />}
        <div className="inbox-text">
          <p className="small"><strong>{dateTime(r.save_data.saved_at)}</strong></p>
          <p className="schedule-text">{reminderText(r)}</p>
        </div>
        <div className="inbox-actions">
          <button className="secondary small-btn" onClick={() => (close(), void openMessage(channel_id, message_id, guild_id ?? r.message?.guild_id))}>{t('Jump')}</button>
          <button className="icon-btn" aria-label={t('Remove Bookmark')} title={t('Remove Bookmark')} onClick={() => void removeReminder(channel_id, message_id).catch(toastError)}>
            <Icon d={ICONS.close} size={16} />
          </button>
        </div>
      </div>
    </li>
  )
}

function ReminderItem({ r, due, close }: { r: SavedMessage; due: boolean; close: () => void }) {
  const channel = useStore((s) => s.channels[r.save_data.channel_id])
  const { channel_id, message_id, guild_id } = r.save_data
  return (
    <li className={cls('inbox-item', due && 'reminder-due')}>
      <div className="inbox-where hint small">{where(channel)}</div>
      <div className="inbox-msg">
        {r.message ? <Avatar user={r.message.author} size={32} /> : <Icon d={ICONS.clock} size={20} />}
        <div className="inbox-text">
          <p className="small">{due ? <span className="reminder-badge">{t('Due')}</span> : null} <strong>{dateTime(r.save_data.due_at!)}</strong></p>
          <p className="schedule-text">{reminderText(r)}</p>
        </div>
        <div className="inbox-actions">
          <button className="secondary small-btn" onClick={() => (close(), void openMessage(channel_id, message_id, guild_id ?? r.message?.guild_id))}>{t('Jump')}</button>
          <button className="icon-btn" aria-label={due ? t('Mark reminder done') : t('Remove reminder')} title={due ? t('Done') : t('Remove')} onClick={() => void removeReminder(channel_id, message_id).catch(toastError)}>
            <Icon d={due ? ICONS.check : ICONS.close} size={16} />
          </button>
        </div>
      </div>
    </li>
  )
}

const tomorrowNine = () => {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(9, 0, 0, 0)
  return d
}

/** Message context menu → Remind Me: 20 min, 1 h, 3 h, tomorrow (9:00) or a custom time. */
export function RemindMenu({ m, at, onClose }: { m: Message; at: Anchor; onClose: () => void }) {
  const [custom, setCustom] = useState(false)
  const picking = useRef(false) // the menu closes (toggle event) after "Custom…" was picked; keep the dialog then
  const set = (when: Date) => remindMe(m, when).then(() => toast(t("Got it. We'll remind you {time}.", { time: dateTime(when.getTime()) })))
  const options: [string, () => Date][] = [
    [t('In 20 minutes'), () => new Date(Date.now() + 20 * 60e3)],
    [t('In 1 hour'), () => new Date(Date.now() + 3600e3)],
    [t('In 3 hours'), () => new Date(Date.now() + 3 * 3600e3)],
    [t('Tomorrow'), tomorrowNine],
  ]
  if (custom) return <WhenModal title={t('Remind Me')} confirm={t('Set Reminder')} initial={inAnHour()} onSubmit={set} onClose={onClose} />
  return (
    <Popover at={at} onClose={() => !picking.current && onClose()} role="menu" label={t('Remind Me')}>
      {options.map(([label, when]) => <MenuItem key={label} onSelect={() => void set(when()).catch(toastError).finally(onClose)}>{label}</MenuItem>)}
      <MenuItem onSelect={() => ((picking.current = true), setCustom(true))}>{t('Custom…')}</MenuItem>
    </Popover>
  )
}
