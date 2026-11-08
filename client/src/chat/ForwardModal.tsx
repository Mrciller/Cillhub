// Forward a message to any channel or DM you can send in; follow an announcement channel into a channel you manage.
import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { followChannel, forwardMessage } from '../actions'
import { toast } from '../components/dialogs'
import { Avatar, cls, FormError, GuildIcon, Icon, ICONS, Modal } from '../components/ui'
import { has, P } from '../permissions'
import { permsOf, sidebar } from '../selectors'
import { displayName, getState, useStore } from '../store'
import type { Channel, Message } from '../types'

export function ForwardModal({ channelId, messageId, onClose }: { channelId: string; messageId: string; onClose: () => void }) {
  const msg = useStore((s) => s.messages[channelId]?.find((m) => m.id === messageId))
  const [q, setQ] = useState('')
  const [dest, setDest] = useState<string | null>(null)
  const [comment, setComment] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const s = getState()
  const query = q.trim().toLowerCase()
  const targets: { c: Channel; label: string; sub: string; dm: boolean }[] = [
    ...Object.values(s.channels).filter((c) => c.type === 1).map((c) => ({ c, label: displayName(c.recipients?.[0]), sub: t('Direct Message'), dm: true })),
    ...Object.values(s.guilds).flatMap((g) => sidebar(s, g.id).flatMap((grp) => grp.channels)
      .filter((c) => [0, 5, 2, 13].includes(c.type) && has(permsOf(s, c.guild_id, c), P.SEND_MESSAGES))
      .map((c) => ({ c, label: `#${c.name}`, sub: g.name, dm: false }))),
  ].filter((x) => !query || x.label.toLowerCase().includes(query) || x.sub.toLowerCase().includes(query))
  const send = () => {
    const target = dest && getState().channels[dest]
    if (!msg || !target) return
    setBusy(true)
    forwardMessage(msg as Message, target, comment).then(() => (toast(t('Message forwarded.')), onClose()), (e: Error) => (setError(e.message), setBusy(false)))
  }
  return (
    <Modal title={t('Forward To')} onClose={onClose} className="forward-modal">
      <p className="hint">{t('Select where you want to share this message.')}</p>
      <input className="input" type="search" aria-label={t('Search channels and conversations')} placeholder={t('Search')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      <ul className="forward-list" role="radiogroup" aria-label={t('Destinations')}>
        {targets.map(({ c, label, sub, dm }) => (
          <li key={c.id}>
            <label className={cls('forward-row', dest === c.id && 'on')}>
              {dm ? <Avatar user={c.recipients?.[0]} size={24} /> : <span className="hash" aria-hidden="true">#</span>}
              <span className="ellipsis"><span className="name">{dm ? label : label.slice(1)}</span> <span className="hint small">{sub}</span></span>
              <input type="radio" name="forward-dest" checked={dest === c.id} onChange={() => setDest(c.id)} />
            </label>
          </li>
        ))}
        {!targets.length && <li className="hint">{t('Nothing found.')}</li>}
      </ul>
      <div className="field">
        <label htmlFor="fwd-comment">{t('Add an optional message')}</label>
        <input id="fwd-comment" className="input" maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} />
      </div>
      <FormError error={error} />
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>{t('Cancel')}</button>
        <button className="primary" disabled={!dest || busy || !msg} onClick={send}>{t('Send')}</button>
      </div>
    </Modal>
  )
}

/** Channels the user can follow into: text channels with MANAGE_WEBHOOKS, grouped by server. */
export function FollowModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const source = useStore((s) => s.channels[channelId])
  const s = getState()
  const guilds = Object.values(s.guilds).map((g) => ({
    g, list: sidebar(s, g.id).flatMap((x) => x.channels).filter((c) => c.type === 0 && c.id !== channelId && has(permsOf(s, g.id, c), P.MANAGE_WEBHOOKS)),
  })).filter((x) => x.list.length)
  const [guildId, setGuildId] = useState(guilds[0]?.g.id ?? '')
  const [target, setTarget] = useState('')
  const [error, setError] = useState('')
  const list = guilds.find((x) => x.g.id === guildId)?.list ?? []
  const firstId = list[0]?.id ?? ''
  useEffect(() => setTarget(firstId), [firstId])
  const follow = () =>
    followChannel(channelId, target).then(() => (toast(t('Following #{source}. New posts will show up in #{target}.', { source: source?.name ?? '', target: s.channels[target]?.name ?? '' })), onClose()), (e: Error) => setError(e.message))
  return (
    <Modal title={t('Follow #{name}', { name: source?.name ?? '' })} onClose={onClose}>
      <p className="hint"><Icon d={ICONS.announcement} size={16} /> {t('Published messages from this channel will be posted in a channel of your choice.')}</p>
      {!guilds.length ? <p className="notice">{t('You need the Manage Webhooks permission in a text channel to follow announcements.')}</p> : (
        <>
          <div className="field">
            <label htmlFor="follow-guild">{t('Server')}</label>
            <div className="row-buttons">
              <span className="rail-icon small-icon" aria-hidden="true">{guilds.find((x) => x.g.id === guildId) && <GuildIcon guild={guilds.find((x) => x.g.id === guildId)!.g} />}</span>
              <select id="follow-guild" className="input grow" value={guildId} onChange={(e) => setGuildId(e.target.value)}>
                {guilds.map(({ g }) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
          </div>
          <div className="field">
            <label htmlFor="follow-channel">{t('Channel')}</label>
            <select id="follow-channel" className="input" value={target} onChange={(e) => setTarget(e.target.value)}>
              {list.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </select>
          </div>
        </>
      )}
      <FormError error={error} />
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>{t('Cancel')}</button>
        <button className="primary" disabled={!target} onClick={follow}>{t('Follow')}</button>
      </div>
    </Modal>
  )
}
