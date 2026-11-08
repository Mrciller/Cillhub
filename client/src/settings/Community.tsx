// Server Settings > Welcome Screen and Vanity URL.
import { t } from '../i18n'
import { WEB_ORIGIN } from '../api'
import { useEffect, useState } from 'react'
import { getVanity, getWelcomeScreen, saveVanity, saveWelcomeScreen } from '../actions'
import { Icon, ICONS, FormError } from '../components/ui'
import type { Guild, WelcomeScreen } from '../types'
import { Switch } from './Layout'
import { useGuildChannels } from './ServerSettings'

const MAX_CHANNELS = 5
type Row = WelcomeScreen['welcome_channels'][number]

export function WelcomeScreenPage({ guild }: { guild: Guild }) {
  const channels = useGuildChannels(guild.id, [0, 5, 15, 2, 13])
  const [ws, setWs] = useState<WelcomeScreen | null>(null)
  const [enabled, setEnabled] = useState(!!guild.features?.includes('WELCOME_SCREEN_ENABLED'))
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    getWelcomeScreen(guild.id).then((w) => (setWs(w), w.enabled !== undefined && setEnabled(w.enabled)), () => setWs({ description: '', welcome_channels: [] }))
  }, [guild.id])
  if (!ws) return <><h1>{t('Welcome Screen')}</h1><p className="hint">{t('Loading…')}</p></>
  const set = (patch: Partial<WelcomeScreen>) => (setWs({ ...ws, ...patch }), setSaved(false))
  const setRow = (i: number, patch: Partial<Row>) => set({ welcome_channels: ws.welcome_channels.map((r, j) => (j === i ? { ...r, ...patch } : r)) })
  const unused = channels.filter((c) => !ws.welcome_channels.some((r) => r.channel_id === c.id))
  const save = () => {
    setError('')
    saveWelcomeScreen(guild.id, { enabled, description: ws.description?.trim() || null, welcome_channels: ws.welcome_channels.filter((r) => r.channel_id) })
      .then((w) => (setWs(w), setSaved(true)), (e: Error) => setError(e.message))
  }
  return (
    <>
      <h1>{t('Welcome Screen')}</h1>
      <p className="hint">{t('New members see this when they join: a short welcome and up to five channels to start in.')}</p>
      <Switch label={t('Show the welcome screen to new members')} checked={enabled} onChange={(v) => (setEnabled(v), setSaved(false))} />
      <div className="field top-gap">
        <label htmlFor="welcome-desc">{t('Welcome Message')} <span className="hint">{(ws.description ?? '').length}/140</span></label>
        <textarea id="welcome-desc" className="input textarea" maxLength={140} value={ws.description ?? ''} onChange={(e) => set({ description: e.target.value })} placeholder={t('Tell new members what this server is about.')} />
      </div>
      <h2 className="sub-title">{t('Recommended Channels')}</h2>
      <ul className="welcome-rows">
        {ws.welcome_channels.map((r, i) => (
          <li key={i} className="welcome-row">
            <input className="input emoji-input" aria-label={t('Emoji for channel {n}', { n: i + 1 })} maxLength={8} value={r.emoji_name ?? ''} placeholder="👋" onChange={(e) => setRow(i, { emoji_name: e.target.value || null, emoji_id: null })} />
            <select className="input" aria-label={t('Channel {n}', { n: i + 1 })} value={r.channel_id} onChange={(e) => setRow(i, { channel_id: e.target.value })}>
              {[...channels.filter((c) => c.id === r.channel_id), ...unused].map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
            </select>
            <input className="input grow" aria-label={t('Description for channel {n}', { n: i + 1 })} maxLength={42} value={r.description} placeholder={t('Say hello')} onChange={(e) => setRow(i, { description: e.target.value })} />
            <button className="icon-btn" aria-label={t('Remove channel {n}', { n: i + 1 })} onClick={() => set({ welcome_channels: ws.welcome_channels.filter((_, j) => j !== i) })}><Icon d={ICONS.trash} size={16} /></button>
          </li>
        ))}
      </ul>
      {ws.welcome_channels.length < MAX_CHANNELS && unused.length > 0 && (
        <button className="secondary small-btn" onClick={() => set({ welcome_channels: [...ws.welcome_channels, { channel_id: unused[0].id, description: '', emoji_id: null, emoji_name: null }] })}>{t('Add a Channel')}</button>
      )}
      <FormError error={error} />
      <div className="save-bar">
        {saved && <span className="success" role="status">{t('Saved.')}</span>}
        <button className="primary" onClick={save}>{t('Save Changes')}</button>
      </div>
    </>
  )
}

const CODE = /^[a-z0-9-]{3,32}$/

export function VanityPage({ guild }: { guild: Guild }) {
  const [code, setCode] = useState(guild.vanity_url_code ?? '')
  const [current, setCurrent] = useState<{ code: string | null; uses: number } | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    getVanity(guild.id).then((v) => (setCurrent(v), setCode((typed) => typed || (v.code ?? ''))), (e: Error) => setError(e.message)) // keep what was typed meanwhile
  }, [guild.id])
  const value = code.trim().toLowerCase()
  const valid = !value || CODE.test(value)
  const link = current?.code ? `${WEB_ORIGIN}/invite/${current.code}` : ''
  const save = () => {
    setError('')
    saveVanity(guild.id, value || null).then(setCurrent, (e: Error) => setError(e.message))
  }
  return (
    <>
      <h1>{t('Vanity URL')}</h1>
      <p className="hint">{t('A custom invite link that never expires. It works like any other invite.')}</p>
      <div className="field">
        <label htmlFor="vanity-code">{t('Invite Code')}{!valid && <span className="field-error"> - {t('3 to 32 lowercase letters, numbers or dashes')}</span>}</label>
        <div className="vanity-row">
          <span className="hint">{WEB_ORIGIN}/invite/</span>
          <input id="vanity-code" className="input" maxLength={32} value={code} aria-invalid={!valid || undefined} onChange={(e) => setCode(e.target.value)} placeholder="nightfall" />
        </div>
      </div>
      {current && <p className="hint">{current.code ? t(current.uses === 1 ? '{n} use so far.' : '{n} uses so far.', { n: current.uses }) : t('No vanity URL set.')}</p>}
      {link && (
        <div className="row-buttons top-gap">
          <code className="vanity-link">{link}</code>
          <button className="secondary small-btn" onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true))}>{copied ? t('Copied') : t('Copy Link')}</button>
        </div>
      )}
      <FormError error={error} />
      <div className="save-bar">
        <button className="primary" disabled={!valid || value === (current?.code ?? '')} onClick={save}>{value ? t('Save Changes') : t('Remove Vanity URL')}</button>
      </div>
    </>
  )
}
