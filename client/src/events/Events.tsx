// Scheduled events (guild-scheduled-event.mdx): sidebar entry with live/start banners, list, details and the create/edit wizard.
import { intlLocale, t } from '../i18n'
import { useEffect, useState } from 'react'
import { createEvent, deleteEvent, eventUsers, loadEvents, loadMyEventSubs, setInterested, updateEvent, type EventBody } from '../actions'
import { cdn, dataUri } from '../api'
import { ask, toastError } from '../components/dialogs'
import { Avatar, cls, FormError, Icon, ICONS, Modal } from '../components/ui'
import { canManageEvent, has, P } from '../permissions'
import { navigate } from '../router'
import { usePerms } from '../selectors'
import { cmpId, displayName, setState, useStore } from '../store'
import type { Guild, Member, ScheduledEvent, User } from '../types'
import { joinVoice } from '../voice/engine'
import './events.css'

const SCHEDULED = 1
const ACTIVE = 2
const COMPLETED = 3
const STAGE = 1
const VOICE = 2
const EXTERNAL = 3

const when = () => new Intl.DateTimeFormat(intlLocale(), { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
const upcoming = (e: ScheduledEvent) => e.status === SCHEDULED || e.status === ACTIVE
const byStart = (a: ScheduledEvent, b: ScheduledEvent) => a.scheduled_start_time.localeCompare(b.scheduled_start_time) || cmpId(a.id, b.id)

function useGuildEvents(guildId: string) {
  const events = useStore((s) => s.events)
  return Object.values(events).filter((e) => e.guild_id === guildId && upcoming(e)).sort(byStart)
}

/** Re-renders every 30 s so "is scheduled to start" banners appear on time. */
function useNow() {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(id)
  }, [])
  return now
}

/** Joins the event's voice or stage channel, or opens its details for external events. */
function goTo(e: ScheduledEvent) {
  if (e.channel_id && e.entity_type !== EXTERNAL) {
    joinVoice(e.guild_id, e.channel_id)
    navigate(`/channels/${e.guild_id}/${e.channel_id}`)
    setState({ showNav: false })
  } else setState({ modal: { kind: 'events', guildId: e.guild_id, eventId: e.id } })
}

export function EventsEntry({ guild }: { guild: Guild }) {
  const list = useGuildEvents(guild.id)
  const perms = usePerms(guild.id)
  const meId = useStore((s) => s.me?.id ?? '')
  const now = useNow()
  const live = list.filter((e) => e.status === ACTIVE)
  const due = list.filter((e) => e.status === SCHEDULED && Date.parse(e.scheduled_start_time) <= now && canManageEvent(perms, e, meId))
  return (
    <div className="events-entry">
      <button className="row events-row" onClick={() => setState({ modal: { kind: 'events', guildId: guild.id } })}>
        <Icon d={ICONS.calendar} size={20} />
        <span className="ellipsis">{list.length ? t(list.length === 1 ? '{n} Event' : '{n} Events', { n: list.length }) : t('Events')}</span>
      </button>
      {live.map((e) => (
        <div key={e.id} className="event-banner live" role="status">
          <span className="live">{t('LIVE')}</span>
          <span className="ellipsis"><span className="sr-only">{t('Live now:')} </span>{e.name}</span>
          <button className="primary small-btn" onClick={() => goTo(e)}>{e.entity_type === EXTERNAL ? t('Details') : t('Join')}</button>
        </div>
      ))}
      {due.map((e) => (
        <div key={e.id} className="event-banner due" role="status">
          <span className="ellipsis">{t('{name} is scheduled to start', { name: e.name })}</span>
          <button className="primary small-btn" onClick={() => updateEvent(e, { status: ACTIVE }).catch(toastError)}>{t('Start Event')}</button>
        </div>
      ))}
    </div>
  )
}

function Location({ e }: { e: ScheduledEvent }) {
  const channel = useStore((s) => (e.channel_id ? s.channels[e.channel_id] : undefined))
  if (e.entity_type === EXTERNAL) return <span className="event-loc"><Icon d={ICONS.place} size={16} /> {e.entity_metadata?.location ?? t('Somewhere else')}</span>
  return <span className="event-loc"><Icon d={e.entity_type === STAGE ? ICONS.stage : ICONS.speaker} size={16} /> {channel?.name ?? t('Unknown channel')}</span>
}

function EventCard({ e, onDetails, onEdit }: { e: ScheduledEvent; onDetails?: () => void; onEdit: () => void }) {
  const perms = usePerms(e.guild_id)
  const meId = useStore((s) => s.me?.id ?? '')
  const interested = useStore((s) => !!s.eventSubs[e.id])
  const manage = canManageEvent(perms, e, meId)
  const cancel = () =>
    void ask({ title: t('Cancel Event'), body: <p>{t('Are you sure you want to cancel {name}? This cannot be undone.', { name: e.name })}</p>, confirm: t('Cancel Event'), danger: true })
      .then((ok) => void (ok && deleteEvent(e).catch(toastError)))
  return (
    <article className={cls('event-card', e.status === ACTIVE && 'live')} aria-label={e.name}>
      {e.image && <img className="event-cover" src={cdn(`/guild-events/${e.id}/${e.image}`)} alt="" />}
      <p className={cls('event-when', e.status === ACTIVE && 'live')}>
        <Icon d={ICONS.calendar} size={16} /> {e.status === ACTIVE ? t('Live Now') : when().format(Date.parse(e.scheduled_start_time))}
      </p>
      <h3 className="event-name">{onDetails ? <button className="link-plain" onClick={onDetails}>{e.name}</button> : e.name}</h3>
      {e.description && <p className="event-desc">{e.description}</p>}
      <Location e={e} />
      <div className="event-actions">
        <span className="hint small"><Icon d={ICONS.people} size={14} /> {e.user_count ?? 0} interested</span>
        <span className="spacer" />
        {manage && e.status === SCHEDULED && <button className="secondary small-btn" onClick={() => updateEvent(e, { status: ACTIVE }).catch(toastError)}>{t('Start')}</button>}
        {manage && e.status === ACTIVE && <button className="secondary small-btn" onClick={() => updateEvent(e, { status: COMPLETED }).catch(toastError)}>{t('End Event')}</button>}
        {manage && e.status === SCHEDULED && <button className="secondary small-btn" onClick={onEdit}>{t('Edit')}</button>}
        {manage && e.status === SCHEDULED && <button className="danger-btn small-btn" onClick={cancel}>{t('Cancel Event')}</button>}
        {e.status === ACTIVE && e.entity_type !== EXTERNAL && <button className="primary small-btn" onClick={() => goTo(e)}>{t('Join')}</button>}
        <button className={cls('secondary small-btn interested', interested && 'on')} aria-pressed={interested} onClick={() => setInterested(e, !interested).catch(toastError)}>
          <Icon d={ICONS.bell} size={14} /> {t('Interested')}
        </button>
      </div>
    </article>
  )
}

function Details({ e, onBack, onEdit }: { e: ScheduledEvent; onBack: () => void; onEdit: () => void }) {
  const [users, setUsers] = useState<{ user: User; member?: Member }[] | null>(null)
  const count = e.user_count
  useEffect(() => void eventUsers(e).then(setUsers, () => setUsers([])), [e, count])
  return (
    <>
      <button className="link back-link" onClick={onBack}>← {t('All events')}</button>
      <EventCard e={e} onEdit={onEdit} />
      {e.creator && <p className="hint small">{t('Created by {name}', { name: displayName(e.creator) })}</p>}
      <h3 className="list-heading">{t('Interested — {n}', { n: users?.length ?? '…' })}</h3>
      <ul className="event-users" aria-label={t('Interested members')}>
        {users?.map(({ user, member }) => (
          <li key={user.id} className="row"><Avatar user={user} size={24} /> <span className="ellipsis">{member?.nick || displayName(user)}</span></li>
        ))}
      </ul>
    </>
  )
}

const pad = (n: number) => String(n).padStart(2, '0')
const localDate = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const localTime = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`
const toIso = (date: string, time: string) => (date && time ? new Date(`${date}T${time}`).toISOString() : null)

function Wizard({ guild, event, onDone, onCancel }: { guild: Guild; event?: ScheduledEvent; onDone: (e: ScheduledEvent) => void; onCancel: () => void }) {
  const channels = useStore((s) => s.channels)
  const nextHour = new Date(Math.ceil(Date.now() / 3600e3) * 3600e3 + 86400e3)
  const start = event ? new Date(event.scheduled_start_time) : nextHour
  const end = event?.scheduled_end_time ? new Date(event.scheduled_end_time) : null
  const [step, setStep] = useState(0)
  const [type, setType] = useState(event?.entity_type ?? VOICE)
  const [channelId, setChannelId] = useState(event?.channel_id ?? '')
  const [location, setLocation] = useState(event?.entity_metadata?.location ?? '')
  const [name, setName] = useState(event?.name ?? '')
  const [date, setDate] = useState(localDate(start))
  const [time, setTime] = useState(localTime(start))
  const [endDate, setEndDate] = useState(end ? localDate(end) : '')
  const [endTime, setEndTime] = useState(end ? localTime(end) : '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [image, setImage] = useState<string | null | undefined>(undefined)
  const [error, setError] = useState('')
  const options = Object.values(channels).filter((c) => c.guild_id === guild.id && c.type === (type === STAGE ? 13 : 2))
  const startIso = toIso(date, time)
  const endIso = toIso(endDate, endTime)
  const valid = [
    type === EXTERNAL ? !!location.trim() : !!options.find((c) => c.id === channelId),
    !!name.trim() && !!startIso && (!event ? Date.parse(startIso) > Date.now() : true) && (type !== EXTERNAL || !!endIso) && (!endIso || !startIso || endIso > startIso),
    true,
  ]
  const steps = [t('Location'), t('Event Info'), t('Review')]
  const submit = () => {
    setError('')
    const body: EventBody = {
      name: name.trim(), description: description.trim() || null, entity_type: type, scheduled_start_time: startIso!, scheduled_end_time: endIso,
      channel_id: type === EXTERNAL ? null : channelId, entity_metadata: type === EXTERNAL ? { location: location.trim() } : null,
      ...(image !== undefined && { image }),
    }
    ;(event ? updateEvent(event, body) : createEvent(guild.id, body)).then(onDone, (e: Error) => setError(e.message))
  }
  return (
    <form className="event-wizard" onSubmit={(e) => (e.preventDefault(), step < 2 ? valid[step] && setStep(step + 1) : submit())}>
      <ol className="wizard-steps" aria-label={t('Steps')}>
        {steps.map((s, i) => <li key={s} className={cls(i === step && 'on', i < step && 'done')} aria-current={i === step ? 'step' : undefined}>{s}</li>)}
      </ol>
      {step === 0 && (
        <>
          <h3>{t('Where is your event?')}</h3>
          <p className="hint">{t('So no one gets lost on where to go.')}</p>
          <fieldset className="choice block">
            <legend className="sr-only">{t('Location type')}</legend>
            {([[STAGE, 'Stage Channel', ICONS.stage, 'Great for hosting a talk with an audience'], [VOICE, 'Voice Channel', ICONS.speaker, 'Hang out with voice, video, and screen share'], [EXTERNAL, 'Somewhere Else', ICONS.place, 'Text channel, external link, or in-person location']] as const).map(([ty, label, icon, note]) => (
              <label key={ty} className={cls('radio-card', type === ty && 'on')}>
                <input type="radio" name="event-type" checked={type === ty} onChange={() => (setType(ty), setChannelId(''))} />
                <Icon d={icon} size={20} /> <span><strong>{t(label)}</strong><span className="hint small type-note">{t(note)}</span></span>
              </label>
            ))}
          </fieldset>
          {type === EXTERNAL ? (
            <div className="field">
              <label htmlFor="ev-location">{t('Enter a location')}</label>
              <input id="ev-location" className="input" maxLength={100} value={location} onChange={(e) => setLocation(e.target.value)} placeholder={t('Add a location, link, or something.')} required />
            </div>
          ) : (
            <div className="field">
              <label htmlFor="ev-channel">{t('Select a channel')}</label>
              <select id="ev-channel" className="input" value={channelId} onChange={(e) => setChannelId(e.target.value)} required>
                <option value="">{t('Select a channel…')}</option>
                {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              {!options.length && <p className="hint small">{type === STAGE ? t('This server has no stage channels.') : t('This server has no voice channels.')}</p>}
            </div>
          )}
        </>
      )}
      {step === 1 && (
        <>
          <h3>{t("What's your event about?")}</h3>
          <div className="field">
            <label htmlFor="ev-name">{t('Event Topic')}</label>
            <input id="ev-name" className="input" maxLength={100} required value={name} onChange={(e) => setName(e.target.value)} placeholder={t("What's your event?")} autoFocus />
          </div>
          <div className="row-fields">
            <div className="field grow"><label htmlFor="ev-date">{t('Start Date')}</label><input id="ev-date" type="date" className="input" required value={date} onChange={(e) => setDate(e.target.value)} /></div>
            <div className="field grow"><label htmlFor="ev-time">{t('Start Time')}</label><input id="ev-time" type="time" className="input" required value={time} onChange={(e) => setTime(e.target.value)} /></div>
          </div>
          <div className="row-fields">
            <div className="field grow"><label htmlFor="ev-end-date">{t('End Date')}{type !== EXTERNAL && ' ' + t('(optional)')}</label><input id="ev-end-date" type="date" className="input" required={type === EXTERNAL} value={endDate} onChange={(e) => setEndDate(e.target.value)} /></div>
            <div className="field grow"><label htmlFor="ev-end-time">{t('End Time')}{type !== EXTERNAL && ' ' + t('(optional)')}</label><input id="ev-end-time" type="time" className="input" required={type === EXTERNAL || !!endDate} value={endTime} onChange={(e) => setEndTime(e.target.value)} /></div>
          </div>
          <div className="field">
            <label htmlFor="ev-desc">{t('Description')}</label>
            <textarea id="ev-desc" className="input textarea" maxLength={1000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={t('Tell people a little more about your event.')} />
          </div>
          <div className="field">
            <span className="field-label">{t('Cover Image')}</span>
            <div className="row-buttons">
              <label className="secondary file-btn">
                {t('Upload Cover Image')}
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) dataUri(f).then(setImage, (err: Error) => setError(err.message)); e.target.value = '' }} />
              </label>
              {(image || (image === undefined && event?.image)) && <button type="button" className="link" onClick={() => setImage(null)}>{t('Remove')}</button>}
            </div>
          </div>
          {!valid[1] && startIso && !event && Date.parse(startIso) <= Date.now() && <p className="form-error">{t('The start time must be in the future.')}</p>}
        </>
      )}
      {step === 2 && (
        <>
          <h3>{t("Here's a preview of your event.")}</h3>
          <div className="event-card preview">
            {image && <img className="event-cover" src={image} alt="" />}
            <p className="event-when"><Icon d={ICONS.calendar} size={16} /> {startIso && when().format(Date.parse(startIso))}{endIso && ` – ${when().format(Date.parse(endIso))}`}</p>
            <h3 className="event-name">{name}</h3>
            {description && <p className="event-desc">{description}</p>}
            <span className="event-loc"><Icon d={type === EXTERNAL ? ICONS.place : type === STAGE ? ICONS.stage : ICONS.speaker} size={16} /> {type === EXTERNAL ? location : channels[channelId]?.name}</span>
          </div>
        </>
      )}
      <FormError error={error} />
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={step ? () => setStep(step - 1) : onCancel}>{step ? t('Back') : t('Cancel')}</button>
        <button className="primary" disabled={!valid[step]}>{step < 2 ? t('Next') : event ? t('Save Event') : t('Create Event')}</button>
      </div>
    </form>
  )
}

type View = { kind: 'list' } | { kind: 'details'; id: string } | { kind: 'wizard'; id?: string }

export function EventsModal({ guildId, eventId, edit, create, onClose }: { guildId: string; eventId?: string; edit?: boolean; create?: boolean; onClose: () => void }) {
  const guild = useStore((s) => s.guilds[guildId])
  const events = useStore((s) => s.events)
  const perms = usePerms(guildId)
  const list = useGuildEvents(guildId)
  const [view, setView] = useState<View>(create ? { kind: 'wizard' } : eventId ? (edit ? { kind: 'wizard', id: eventId } : { kind: 'details', id: eventId }) : { kind: 'list' })
  useEffect(() => {
    loadEvents(guildId).catch(() => {})
    loadMyEventSubs(guildId).catch(() => {})
  }, [guildId])
  if (!guild) return null
  const canCreate = has(perms, P.CREATE_EVENTS) || has(perms, P.MANAGE_EVENTS)
  const current = view.kind !== 'list' && view.id ? events[view.id] : undefined
  const title = view.kind === 'wizard' ? (view.id ? t('Edit Event') : t('Create Event')) : view.kind === 'details' ? current?.name ?? t('Event') : t('Events')
  return (
    <Modal title={title} onClose={onClose} className="events-modal">
      {view.kind === 'list' && (
        <>
          <div className="events-head">
            <p className="hint">{list.length} upcoming event{list.length === 1 ? '' : 's'}</p>
            {canCreate && <button className="primary small-btn" onClick={() => setView({ kind: 'wizard' })}>{t('Create Event')}</button>}
          </div>
          {list.length ? (
            <ul className="events-list" aria-label={t('Upcoming events')}>
              {list.map((e) => (
                <li key={e.id}>
                  <EventCard e={e} onDetails={() => setView({ kind: 'details', id: e.id })} onEdit={() => setView({ kind: 'wizard', id: e.id })} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="hint events-empty">{t('There are no upcoming events.')}{canCreate && ' ' + t('Schedule one so everyone can join in.')}</p>
          )}
        </>
      )}
      {view.kind === 'details' && current && <Details e={current} onBack={() => setView({ kind: 'list' })} onEdit={() => setView({ kind: 'wizard', id: current.id })} />}
      {view.kind === 'details' && !current && <p className="hint">{t('This event no longer exists.')}</p>}
      {view.kind === 'wizard' && (
        <Wizard key={view.id ?? 'new'} guild={guild} event={current}
          onDone={(e) => setView({ kind: 'details', id: e.id })} onCancel={() => (create || edit ? onClose() : setView({ kind: 'list' }))} />
      )}
    </Modal>
  )
}
