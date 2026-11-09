// Server Settings > Integrations > Webhooks (webhook.mdx): incoming webhooks and channel-follower webhooks.
import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { createWebhook, deleteWebhook, guildWebhooks, updateWebhook } from '../actions'
import { cdn, dataUri, apiOrigin } from '../api'
import { ask } from '../components/dialogs'
import { cls, FormError, Icon, ICONS } from '../components/ui'
import type { Guild, Webhook } from '../types'
import { useGuildChannels } from './ServerSettings'

/** The execute URL: the server's `url`, or the API path built from id and token. */
export const webhookUrl = (w: Webhook) => w.url ?? `${apiOrigin()}/api/v9/webhooks/${w.id}/${w.token}`
const avatar = (w: Webhook) => (w.avatar ? cdn(`/avatars/${w.id}/${w.avatar}`) : null)

export function WebhooksPage({ guild }: { guild: Guild }) {
  const text = useGuildChannels(guild.id, [0, 5, 2, 13, 15])
  const [list, setList] = useState<Webhook[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => void guildWebhooks(guild.id).then(setList, (e: Error) => setError(e.message)), [guild.id])
  const incoming = list?.filter((w) => w.type !== 2) ?? []
  const followers = list?.filter((w) => w.type === 2) ?? []
  const create = () => {
    const ch = text.find((c) => c.type === 0 || c.type === 5) ?? text[0]
    if (!ch) return setError(t('Create a text channel first.'))
    createWebhook(ch.id, 'Captain Hook').then((w) => (setList((l) => [...(l ?? []), w]), setOpen(w.id)), (e: Error) => setError(e.message))
  }
  return (
    <>
      <h2 className="sub-title">{t('Webhooks')}</h2>
      <p className="hint">{t('Webhooks post messages from other apps and services into a channel.')}</p>
      <button className="primary" onClick={create}>{t('New Webhook')}</button>
      <FormError error={error} />
      {list && !incoming.length && <p className="hint top-gap">{t('No webhooks yet.')}</p>}
      <ul className="webhook-list" aria-label={t('Webhooks')}>
        {incoming.map((w) => (
          <WebhookRow key={w.id} w={w} guild={guild} open={open === w.id} onToggle={() => setOpen(open === w.id ? null : w.id)}
            onChange={(x) => setList((l) => l?.map((y) => (y.id === x.id ? { ...y, ...x } : y)) ?? null)} onDelete={() => setList((l) => l?.filter((y) => y.id !== w.id) ?? null)} />
        ))}
      </ul>
      {followers.length > 0 && (
        <>
          <h2 className="sub-title">{t('Channels Followed')}</h2>
          <ul className="webhook-list" aria-label={t('Followed channels')}>
            {followers.map((w) => (
              <li key={w.id} className="webhook">
                <div className="webhook-head">
                  <Icon d={ICONS.announcement} size={24} className="hint" />
                  <span className="expr-name">{w.source_guild?.name ?? w.name} {w.source_channel && <span className="hint">#{w.source_channel.name}</span>}</span>
                  <span className="hint small">{t('posts to #{name}', { name: text.find((c) => c.id === w.channel_id)?.name ?? t('unknown') })}</span>
                  <button className="danger-btn small-btn" onClick={() => void ask({ title: t('Unfollow'), body: <p>{t('Stop following this channel?')}</p>, confirm: t('Unfollow'), danger: true })
                    .then((ok) => void (ok && deleteWebhook(w.id).then(() => setList((l) => l?.filter((y) => y.id !== w.id) ?? null), (e: Error) => setError(e.message))))}>{t('Unfollow')}</button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  )
}

function WebhookRow({ w, guild, open, onToggle, onChange, onDelete }: { w: Webhook; guild: Guild; open: boolean; onToggle: () => void; onChange: (w: Webhook) => void; onDelete: () => void }) {
  const channels = useGuildChannels(guild.id, [0, 5, 2, 13, 15])
  const [name, setName] = useState(w.name ?? '')
  const [channel, setChannel] = useState(w.channel_id ?? '')
  const [image, setImage] = useState<string | null | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  const preview = image === undefined ? avatar(w) : image
  const dirty = name.trim() !== (w.name ?? '') || channel !== (w.channel_id ?? '') || image !== undefined
  const save = () => {
    setError('')
    updateWebhook(w.id, { name: name.trim(), channel_id: channel, ...(image !== undefined && { avatar: image }) }).then((x) => (onChange(x), setImage(undefined)), (e: Error) => setError(e.message))
  }
  const remove = () =>
    void ask({ title: t('Delete {name}', { name: w.name ?? '' }), body: <p>{t('Are you sure you want to delete {name}? Anything posting through it will stop working.', { name: w.name ?? '' })}</p>, confirm: t('Delete'), danger: true })
      .then((ok) => void (ok && deleteWebhook(w.id).then(onDelete, (e: Error) => setError(e.message))))
  return (
    <li className={cls('webhook', open && 'open')}>
      <button className="webhook-head" aria-expanded={open} onClick={onToggle}>
        <span className="avatar webhook-avatar" style={{ width: 40, height: 40 }}>{preview ? <img src={preview} alt="" /> : <Icon d={ICONS.link} size={20} />}</span>
        <span className="expr-name">{w.name}</span>
        <span className="hint small">#{channels.find((c) => c.id === w.channel_id)?.name ?? t('unknown')}</span>
        <Icon d={ICONS.expand} size={16} className="audit-chevron" />
      </button>
      {open && (
        <div className="webhook-body">
          <div className="row-fields">
            <div className="icon-edit small">
              <label className="secondary file-btn small-btn">
                {t('Upload Avatar')}
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) dataUri(f).then(setImage, (err: Error) => setError(err.message)); e.target.value = '' }} />
              </label>
              {preview && <button className="link" onClick={() => setImage(null)}>{t('Remove')}</button>}
            </div>
            <div className="field grow"><label htmlFor={`wh-name-${w.id}`}>{t('Name')}</label><input id={`wh-name-${w.id}`} className="input" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} /></div>
            <div className="field grow">
              <label htmlFor={`wh-ch-${w.id}`}>{t('Channel')}</label>
              <select id={`wh-ch-${w.id}`} className="input" value={channel} onChange={(e) => setChannel(e.target.value)}>
                {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </select>
            </div>
          </div>
          <FormError error={error} />
          <div className="row-buttons">
            <button className="secondary" disabled={!w.token && !w.url} onClick={() => navigator.clipboard.writeText(webhookUrl(w)).then(() => setCopied(true), (e: Error) => setError(e.message))}>
              {copied ? t('Copied!') : t('Copy Webhook URL')}
            </button>
            <span className="spacer" />
            <button className="danger-btn" onClick={remove}>{t('Delete Webhook')}</button>
            <button className="primary" disabled={!dirty || !name.trim()} onClick={save}>{t('Save Changes')}</button>
          </div>
        </div>
      )}
    </li>
  )
}
