import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Avatar, cls, Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { memberName } from '../selectors'
import { getState, useStore } from '../store'
import type { Channel, Guild } from '../types'
import { leaveVoice, setSelfDeaf, setSelfMute, videoTiles, type VideoTrackLike } from './engine'

export function openVoicePopout() {
  window.dispatchEvent(new CustomEvent('cillcord:open_voice_popout'))
}

function MiniVideo({ track }: { track: VideoTrackLike }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    track.attach(el)
    return () => void track.detach(el)
  }, [track])
  return <video ref={ref} autoPlay playsInline muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
}

function VoicePopoutContent({
  channel,
  guild,
  onClose,
}: {
  channel?: Channel
  guild?: Guild
  onClose: () => void
}) {
  const s = useStore((x) => x)
  useStore((x) => x.voice.tracks) // re-render when video tracks change
  const tiles = videoTiles()
  const states = Object.values(s.voiceStates[guild?.id ?? ''] ?? {}).filter(
    (v) => v.channel_id === channel?.id
  )

  return (
    <div className="voice-popout-window" style={{ display: 'flex', flexDirection: 'column', height: '100vh', padding: '8px', background: 'var(--bg-primary, #1e1f22)', color: 'var(--text-normal, #dbdee1)', boxSizing: 'border-box', overflow: 'hidden' }}>
      <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '6px', borderBottom: '1px solid var(--border, #35363c)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', overflow: 'hidden' }}>
          <Icon d={ICONS.speaker} size={16} />
          <span style={{ fontWeight: 600, fontSize: '13px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {channel?.name ?? t('Voice Call')}
          </span>
          {guild && (
            <span style={{ fontSize: '11px', opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              • {guild.name}
            </span>
          )}
        </div>
        <button
          className="icon-btn"
          aria-label={t('Close Popout')}
          title={t('Close Popout')}
          onClick={onClose}
          style={{ padding: '2px' }}
        >
          <Icon d={ICONS.close} size={16} />
        </button>
      </header>

      <main style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '8px', padding: '8px 0', overflowY: 'auto' }}>
        {tiles.length > 0 ? (
          <div style={{ display: 'grid', gridTemplateColumns: tiles.length > 1 ? '1fr 1fr' : '1fr', gap: '6px', flex: 1, minHeight: '120px' }}>
            {tiles.map((tile) => {
              const name = memberName(getState(), guild?.id, tile.userId)
              return (
                <div key={`${tile.userId}-${tile.source}`} style={{ position: 'relative', background: '#000', borderRadius: '6px', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <MiniVideo track={tile.track} />
                  <div style={{ position: 'absolute', bottom: '4px', left: '4px', background: 'rgba(0,0,0,0.6)', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <span>{name}</span>
                    {tile.source === 'screen' && <span style={{ background: '#f23f43', color: '#fff', fontSize: '9px', padding: '1px 3px', borderRadius: '2px', fontWeight: 'bold' }}>{t('LIVE')}</span>}
                  </div>
                </div>
              )
            })}
          </div>
        ) : null}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', alignItems: 'center' }}>
          {states.map((v) => {
            const user = s.users[v.user_id]
            const name = memberName(getState(), guild?.id, v.user_id)
            const speaking = !!s.voice.speaking[v.user_id]
            return (
              <div
                key={v.user_id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '6px',
                  background: 'var(--bg-secondary, #2b2d31)',
                  padding: '4px 8px',
                  borderRadius: '16px',
                  fontSize: '12px',
                  border: speaking ? '2px solid #23a55a' : '2px solid transparent',
                  boxSizing: 'border-box',
                }}
              >
                <Avatar user={user} size={20} />
                <span style={{ maxWidth: '100px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{name}</span>
                {v.self_mute && <Icon d={ICONS.micOff} size={14} className="danger" />}
                {v.self_deaf && <Icon d={ICONS.headsetOff} size={14} className="danger" />}
              </div>
            )
          })}
        </div>
      </main>

      <footer style={{ display: 'flex', justifyContent: 'center', gap: '12px', paddingTop: '6px', borderTop: '1px solid var(--border, #35363c)' }}>
        <button
          className={cls('vp-btn', s.voice.selfMute && 'danger-on')}
          aria-pressed={s.voice.selfMute}
          aria-label={t('Mute')}
          title={s.voice.selfMute ? t('Unmute') : t('Mute')}
          onClick={() => setSelfMute(!s.voice.selfMute)}
          style={{ width: '36px', height: '36px', borderRadius: '50%' }}
        >
          <Icon d={s.voice.selfMute ? ICONS.micOff : ICONS.mic} size={18} />
        </button>
        <button
          className={cls('vp-btn', s.voice.selfDeaf && 'danger-on')}
          aria-pressed={s.voice.selfDeaf}
          aria-label={t('Deafen')}
          title={s.voice.selfDeaf ? t('Undeafen') : t('Deafen')}
          onClick={() => setSelfDeaf(!s.voice.selfDeaf)}
          style={{ width: '36px', height: '36px', borderRadius: '50%' }}
        >
          <Icon d={s.voice.selfDeaf ? ICONS.headsetOff : ICONS.headset} size={18} />
        </button>
        <button
          className="vp-btn hangup"
          aria-label={t('Disconnect')}
          title={t('Disconnect')}
          onClick={() => {
            leaveVoice()
            onClose()
          }}
          style={{ width: '36px', height: '36px', borderRadius: '50%', background: '#da373c', color: '#fff' }}
        >
          <Icon d={ICONS.hangup} size={18} />
        </button>
      </footer>
    </div>
  )
}

export function VoicePopout({ channel, guild }: { channel?: Channel; guild?: Guild }) {
  const [pipWin, setPipWin] = useState<Window | null>(null)
  const connected = useStore((s) => !!s.voice.channelId)

  // Automatically close popout when leaving voice
  useEffect(() => {
    if (!connected && pipWin) {
      pipWin.close()
      setPipWin(null)
    }
  }, [connected, pipWin])

  useEffect(() => {
    const handler = async () => {
      if ('documentPictureInPicture' in window) {
        try {
          if (pipWin) {
            pipWin.close()
            setPipWin(null)
            return
          }
          const win = await (window as any).documentPictureInPicture.requestWindow({
            width: 480,
            height: 360,
          })
          document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
            win.document.head.appendChild(node.cloneNode(true))
          })
          win.document.documentElement.dataset.theme = document.documentElement.dataset.theme || 'dark'
          win.document.body.className = (document.body.className || '') + ' pip-body'
          win.document.title = `${channel?.name ?? 'Voice'} - Cillhub`
          win.addEventListener('pagehide', () => {
            setPipWin(null)
          })
          setPipWin(win)
        } catch (err) {
          console.warn('Document PiP failed:', err)
        }
      } else {
        // Fallback to standard video PiP
        const video = document.querySelector<HTMLVideoElement>('.voice-view video, .voice-panel video')
        if (video && 'requestPictureInPicture' in video) {
          video.requestPictureInPicture().catch(() => {})
        }
      }
    }
    window.addEventListener('cillcord:open_voice_popout', handler)
    return () => window.removeEventListener('cillcord:open_voice_popout', handler)
  }, [channel, guild, pipWin])

  if (!pipWin) return null
  return createPortal(
    <VoicePopoutContent channel={channel} guild={guild} onClose={() => pipWin.close()} />,
    pipWin.document.body
  )
}
