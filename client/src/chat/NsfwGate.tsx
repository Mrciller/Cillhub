// One-time confirmation before an age-restricted (NSFW) channel or a thread in one, remembered per channel.
import { t } from '../i18n'
import { useState, type ReactNode } from 'react'
import { Icon, ICONS } from '../components/ui'
import { navigate } from '../router'
import { useStore } from '../store'
import type { Channel } from '../types'

const KEY = 'nsfw-ok'
const confirmed = (): string[] => {
  try { return JSON.parse(localStorage.getItem(KEY) ?? '[]') } catch { return [] }
}

export function NsfwGate({ channel, children }: { channel: Channel; children: ReactNode }) {
  const parent = useStore((s) => (channel.parent_id ? s.channels[channel.parent_id] : undefined))
  const gated = channel.nsfw || (!!channel.thread_metadata && !!parent?.nsfw)
  const id = channel.thread_metadata && parent ? parent.id : channel.id
  const [ok, setOk] = useState(() => confirmed().includes(id))
  if (!gated || ok) return <>{children}</>
  return (
    <div className="nsfw-gate" role="alertdialog" aria-labelledby="nsfw-title" aria-describedby="nsfw-text">
      <Icon d={ICONS.warning} size={56} className="nsfw-icon" />
      <h2 id="nsfw-title">{t('Age-Restricted Channel')}</h2>
      <p id="nsfw-text" className="hint">{t('This channel contains adult content that may not be suitable for everyone. You must be at least 18 years old to view it.')}</p>
      <div className="row-buttons">
        <button className="secondary" onClick={() => navigate(`/channels/${channel.guild_id ?? '@me'}`)}>{t('Nope')}</button>
        <button className="danger-btn" autoFocus onClick={() => (localStorage.setItem(KEY, JSON.stringify([...confirmed(), id])), setOk(true))}>{t('Continue')}</button>
      </div>
    </div>
  )
}
