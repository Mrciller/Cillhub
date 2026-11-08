// The call area at the top of a DM or group DM (CONTRACT-v4): the voice grid, the call bar, and "Ring" for people not in the call.
import { useState } from 'react'
import { ringCall } from '../actions'
import { toastError } from '../components/dialogs'
import { Avatar, cls, Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { callStates, displayName, useStore } from '../store'
import type { Channel } from '../types'
import { leaveVoice, setSelfDeaf, setSelfMute, videoTiles } from '../voice/engine'
import { MediaButtons, VoiceError } from '../voice/VoicePanel'
import { Tile } from '../voice/VoiceView'
import { startCall } from './calls'
import './calls.css'

export function CallPanel({ channel, height }: { channel: Channel; height?: number | null }) {
  const s = useStore((x) => x)
  useStore((x) => x.voice.tracks) // re-render when LiveKit tracks change
  const [focus, setFocus] = useState<string | null>(null)
  const states = callStates(s, channel.id)
  const call = s.calls[channel.id]
  const here = s.voice.channelId === channel.id && !s.voice.guildId
  if (!states.length && !here && !call) return null
  const tiles = here ? videoTiles() : []
  const items = [
    ...tiles.filter((x) => x.source === 'screen').flatMap((x) => {
      const v = states.find((y) => y.user_id === x.userId)
      return v ? [{ id: `${x.userId}-screen`, v, track: x.track, screen: true }] : []
    }),
    ...states.map((v) => ({ id: v.user_id, v, track: tiles.find((x) => x.userId === v.user_id && x.source === 'camera')?.track, screen: false })),
  ]
  const focused = items.find((i) => i.id === focus)
  const inCall = new Set(states.map((v) => v.user_id))
  const absent = (channel.recipients ?? []).filter((u) => !inCall.has(u.id))
  return (
    <section
      className={cls('call-panel', focused && 'has-focus')}
      style={height ? { height: `${height}px`, maxHeight: 'none' } : undefined}
      aria-label={t('Call')}
    >
      {here && <VoiceError />}
      {focused && <ul className="tile-focus"><Tile v={focused.v} track={focused.track} screen={focused.screen} focused onFocus={() => setFocus(null)} /></ul>}
      <ul className={cls('tiles call-tiles', focused && 'strip')} aria-label={t('Participants')}>
        {items.filter((i) => i !== focused).map(({ id, ...i }) => <Tile key={id} {...i} onFocus={() => setFocus(id)} />)}
        {absent.map((u) => {
          const ringing = call?.ringing.includes(u.id)
          const user = s.users[u.id] ?? u
          return (
            <li key={u.id} className={cls('tile absent', ringing && 'ringing')}>
              <div className="tile-inner">
                <Avatar user={user} size={80} />
                <span className="tile-name">{displayName(user)}</span>
                {ringing ? <span className="ring-state" role="status">{t('Calling…')}</span>
                  : <button className="secondary small-btn ring-btn" onClick={() => ringCall(channel.id, [u.id]).catch(toastError)}>{t('Ring')}</button>}
              </div>
            </li>
          )
        })}
      </ul>
      <div className="call-bar">
        {here ? (
          <>
            <button className={cls('vp-btn big', s.voice.selfMute && 'danger-on')} aria-pressed={s.voice.selfMute} aria-label={t('Mute')} onClick={() => setSelfMute(!s.voice.selfMute)}>
              <Icon d={s.voice.selfMute ? ICONS.micOff : ICONS.mic} />
            </button>
            <button className={cls('vp-btn big', s.voice.selfDeaf && 'danger-on')} aria-pressed={s.voice.selfDeaf} aria-label={t('Deafen')} onClick={() => setSelfDeaf(!s.voice.selfDeaf)}>
              <Icon d={s.voice.selfDeaf ? ICONS.headsetOff : ICONS.headset} />
            </button>
            <MediaButtons big />
            <button className="vp-btn big hangup" aria-label={t('Leave Call')} title={t('Leave Call')} onClick={leaveVoice}><Icon d={ICONS.hangup} /></button>
          </>
        ) : (
          <button className="primary join-call" onClick={() => startCall(channel.id)}><Icon d={ICONS.phone} size={18} /> {t('Join Call')}</button>
        )}
      </div>
    </section>
  )
}
