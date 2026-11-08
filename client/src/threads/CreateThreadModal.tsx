// Create a thread from a message or standalone from the channel header; opens it in the side panel.
import { t } from '../i18n'
import { useState } from 'react'
import { sendMessage, startThread, startThreadFromMessage } from '../actions'
import { Field, FormError, Modal } from '../components/ui'
import { has, P } from '../permissions'
import { usePerms } from '../selectors'
import { Switch } from '../settings/Layout'
import { setState, useStore } from '../store'
import type { Channel, Message } from '../types'
import { ARCHIVE_DURATIONS } from './util'

/** Modal kind 'create-thread': from a message (`messageId`) or standalone from the channel header. */
export function CreateThreadModal({ channelId, messageId, onClose }: { channelId: string; messageId?: string; onClose: () => void }) {
  const channel = useStore((s) => s.channels[channelId])
  const msg = useStore((s) => (messageId ? s.messages[channelId]?.find((m) => m.id === messageId) : undefined))
  const perms = usePerms(channel?.guild_id, channelId)
  const canPublic = has(perms, P.CREATE_PUBLIC_THREADS)
  const canPrivate = channel?.type === 0 && has(perms, P.CREATE_PRIVATE_THREADS)
  const [name, setName] = useState(() => (msg?.content.replace(/\s+/g, ' ').trim().slice(0, 40) || ''))
  const [priv, setPriv] = useState(!messageId && !canPublic && canPrivate)
  const [invitable, setInvitable] = useState(true)
  const [duration, setDuration] = useState(channel?.default_auto_archive_duration ?? 1440)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  if (!channel) return null
  const submit = async () => {
    setBusy(true)
    setError('')
    try {
      const th: Channel = messageId
        ? await startThreadFromMessage(msg ?? ({ id: messageId, channel_id: channelId } as Message), name.trim(), duration)
        : await startThread(channelId, { name: name.trim(), auto_archive_duration: duration, type: channel.type === 5 ? 10 : priv ? 12 : 11, ...(priv && { invitable }) })
      if (!messageId && text.trim()) void sendMessage(th, text.trim())
      onClose()
      setState({ panel: { kind: 'thread', channelId: th.id } })
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }
  return (
    <Modal title={t('Create Thread')} onClose={onClose}>
      <form onSubmit={(e) => (e.preventDefault(), name.trim() && void submit())}>
        <Field label={t('Thread Name')} value={name} required maxLength={100} autoFocus placeholder={t('New Thread')} onChange={(e) => setName(e.target.value)} />
        {!messageId && canPrivate && (
          <>
            <Switch label={t('Private Thread')} note={t('Only people you invite and moderators can see this thread.')} checked={priv} disabled={!canPublic} onChange={setPriv} />
            {priv && <Switch label={t('Allow anyone to invite')} note={t('Members of the thread can add others.')} checked={invitable} onChange={setInvitable} />}
          </>
        )}
        <div className="field">
          <label htmlFor="thread-archive">{t('Hide After Inactivity')}</label>
          <select id="thread-archive" className="input" value={duration} onChange={(e) => setDuration(+e.target.value)}>
            {ARCHIVE_DURATIONS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
          </select>
        </div>
        {!messageId && (
          <div className="field">
            <label htmlFor="thread-first">{t('Starter Message (optional)')}</label>
            <textarea id="thread-first" className="input textarea" maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />
          </div>
        )}
        <FormError error={error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" disabled={busy || !name.trim()}>{t('Create Thread')}</button>
        </div>
      </form>
    </Modal>
  )
}
