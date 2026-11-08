import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { openMessage, setPinned } from '../actions'
import { api } from '../api'
import { Popover, type Anchor } from '../components/menu'
import { Avatar, Icon, ICONS } from '../components/ui'
import { Markdown } from '../markdown/Markdown'
import { has, P } from '../permissions'
import { displayName, useStore } from '../store'
import type { Channel, Message } from '../types'
import { stamp } from './MessageItem'
import { useMdContext } from './MessageList'

export function PinsButton({ channel, perms }: { channel: Channel; perms: bigint }) {
  const [at, setAt] = useState<Anchor | null>(null)
  return (
    <>
      <button className="icon-btn" aria-label={t('Pinned Messages')} title={t('Pinned Messages')} aria-expanded={!!at} onClick={(e) => setAt({ rect: e.currentTarget.getBoundingClientRect(), side: 'below' })}>
        <Icon d={ICONS.pin} />
      </button>
      {at && <PinsPopover channel={channel} perms={perms} at={at} onClose={() => setAt(null)} />}
    </>
  )
}

function PinsPopover({ channel, perms, at, onClose }: { channel: Channel; perms: bigint; at: Anchor; onClose: () => void }) {
  const version = useStore((s) => s.pinsVersion[channel.id] ?? 0)
  const guild = useStore((s) => (channel.guild_id ? s.guilds[channel.guild_id] : undefined))
  const ctx = useMdContext(guild)
  const [pins, setPins] = useState<Message[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    api<Message[]>(`/channels/${channel.id}/pins`).then(setPins, (e: Error) => setError(e.message))
  }, [channel.id, version])
  const canUnpin = channel.type === 1 || has(perms, P.MANAGE_MESSAGES)
  return (
    <Popover at={at} onClose={onClose} label={t('Pinned Messages')} className="pins">
      <h2 className="pins-title">{t('Pinned Messages')}</h2>
      {error && <p className="form-error" role="alert">{error}</p>}
      {pins === null && !error && <p className="hint">{t('Loading…')}</p>}
      {pins?.length === 0 && <p className="hint pins-empty">{t("This channel doesn't have any pinned messages yet.")}</p>}
      <ul>
        {pins?.map((m) => (
          <li key={m.id} className="pin">
            <Avatar user={m.author} size={32} />
            <div className="pin-body">
              <div className="msg-meta"><span className="author">{displayName(m.author)}</span> <time dateTime={m.timestamp}>{stamp(m.timestamp)}</time></div>
              <div className="content"><Markdown content={m.content} ctx={ctx} /></div>
              {!!m.attachments.length && <p className="hint small">{t(m.attachments.length === 1 ? '{n} attachment' : '{n} attachments', { n: m.attachments.length })}</p>}
            </div>
            <div className="pin-actions">
              <button className="secondary small-btn" onClick={() => (onClose(), void openMessage(m.channel_id, m.id))}>{t('Jump')}</button>
              {canUnpin && (
                <button className="icon-btn" aria-label={t('Unpin message')} title={t('Unpin')} onClick={() => setPinned(m, false).then(() => setPins((p) => p?.filter((x) => x.id !== m.id) ?? null), (e: Error) => setError(e.message))}>
                  <Icon d={ICONS.close} size={16} />
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </Popover>
  )
}
