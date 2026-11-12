// Soundboard popover in the voice panel: play guild sounds to the channel, preview them locally, local volume.
import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { loadSounds, sendSound } from '../actions'
import { toastError } from '../components/dialogs'
import { Popover, type Anchor } from '../components/menu'
import { cls, Icon, ICONS } from '../components/ui'
import { emojiUrl } from '../markdown/Markdown'
import { has, P } from '../permissions'
import { usePerms } from '../selectors'
import { useStore } from '../store'
import type { Sound } from '../types'
import { myState, playSound } from '../voice/engine'
import { saveVoiceSettings, voiceSettings } from '../voice/settings'
import { NodeGuard } from '../instances/NodeGuard'
import './soundboard.css'

const SoundEmoji = ({ s }: { s: Sound }) =>
  s.emoji_id ? <img className="emoji custom" src={emojiUrl(s.emoji_id)} alt="" /> : <span aria-hidden="true">{s.emoji_name ?? '🔊'}</span>

function SoundboardPopover({ at, onClose }: { at: Anchor; onClose: () => void }) {
  const v = useStore((s) => s.voice)
  const guilds = useStore((s) => s.guilds)
  const sounds = useStore((s) => s.sounds)
  const perms = usePerms(v.guildId ?? undefined, v.channelId ?? undefined)
  const [volume, setVolume] = useState(Math.round(voiceSettings().soundboardVolume * 100))
  const shown = Object.values(guilds)
    .filter((g) => g.id === v.guildId || has(perms, P.USE_EXTERNAL_SOUNDS))
    .sort((a, b) => Number(b.id === v.guildId) - Number(a.id === v.guildId))
  useEffect(() => {
    for (const g of shown) if (!sounds[g.id]) loadSounds(g.id).catch(() => {})
  }, [shown.map((g) => g.id).join()])
  const groups = shown.map((g) => ({ g, list: (sounds[g.id] ?? []).filter((x) => x?.available !== false) })).filter((x) => x.list.length)
  return (
    <Popover at={at} onClose={onClose} label={t('Soundboard')} className="soundboard">
      <h2 className="sb-title">{t('Soundboard')}</h2>
      <label className="menu-range sb-volume">
        <span>{t('Soundboard Volume')} <span className="hint">{volume}%</span></span>
        <input type="range" min={0} max={200} step={5} value={volume} onChange={(e) => (setVolume(+e.target.value), saveVoiceSettings({ soundboardVolume: +e.target.value / 100 }))} />
      </label>
      <div className="sb-scroll">
        {groups.map(({ g, list }) => (
          <section key={g.id} aria-label={g.name}>
            <h3 className="list-heading">{g.name}</h3>
            <ul className="sb-grid">
              {list.map((s) => (
                <li key={s.sound_id} className="sb-item">
                  <button className="sb-play" aria-label={t('Play {name}', { name: s.name })} onClick={() => v.channelId && v.guildId && sendSound(v.channelId, { ...s, guild_id: s.guild_id ?? g.id }, v.guildId).catch(toastError)}>
                    <SoundEmoji s={s} /> <span className="ellipsis">{s.name}</span>
                  </button>
                  <button className="icon-btn tiny sb-preview" aria-label={t('Preview {name}', { name: s.name })} title={t('Preview')} onClick={() => playSound(s.sound_id, s.volume)}>
                    <Icon d={ICONS.speaker} size={14} />
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ))}
        {!groups.length && <p className="hint sb-empty">{t('No sounds yet. Server managers can add some in Server Settings › Soundboard.')}</p>}
      </div>
    </Popover>
  )
}

/** Shown while the server has us in a voice channel (sounds go through the gateway, not LiveKit). */
export function SoundboardButton() {
  const v = useStore((s) => s.voice)
  useStore((s) => (v.guildId && s.me ? s.voiceStates[v.guildId]?.[s.me.id] : undefined)) // re-render on our voice state
  const perms = usePerms(v.guildId ?? undefined, v.channelId ?? undefined)
  const [at, setAt] = useState<Anchor | null>(null)
  const st = myState()
  if (!st || st.channel_id !== v.channelId || !has(perms, P.USE_SOUNDBOARD)) return null
  const muted = v.selfMute || v.selfDeaf || st.mute || st.deaf || !!st.suppress
  return (
    <>
      <button className={cls('vp-btn', at && 'on')} aria-label={t('Soundboard')} aria-expanded={!!at} disabled={muted}
        title={muted ? t('Unmute to use the soundboard') : t('Soundboard')} onClick={(e) => setAt({ rect: e.currentTarget.getBoundingClientRect(), side: 'above' })}>
        <Icon d={ICONS.soundboard} />
      </button>
      {at && <NodeGuard id={null}><SoundboardPopover at={at} onClose={() => setAt(null)} /></NodeGuard>}{/* every server's sounds */}
    </>
  )
}
