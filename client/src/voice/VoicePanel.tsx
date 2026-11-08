// "Voice Connected" panel above the user panel, with the connection details popover and the soundboard.
import { useEffect, useState } from 'react'
import { cls, Icon, ICONS } from '../components/ui'
import { MenuItem, MenuLabel, Popover, type Anchor } from '../components/menu'
import { SoundboardButton } from '../expressions/Soundboard'
import { has, P } from '../permissions'
import { navigate } from '../router'
import { privateName, usePerms } from '../selectors'
import { t } from '../i18n'
import { getState, useStore, type VoiceStatus } from '../store'
import { leaveVoice, retryVoice, setDevice, setStreamQuality, startScreenShare, switchScreenShare, toggleCamera, toggleScreen, voiceBackend } from './engine'
import { quality, useScreenStats, useVoiceStats, type Quality } from './stats'
import { codingText, sizeText, StreamQualityModal } from './StreamQuality'
import { openVoicePopout, VoicePopout } from './VoicePopout'
import { voiceSettings } from './settings'
import './voice-v3.css'

/** Three signal bars coloured by connection quality. */
export function SignalBars({ q }: { q: Quality | null }) {
  return (
    <svg className={cls('signal', q ?? 'unknown')} width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1" y="10" width="3" height="5" rx="1" /><rect x="6.5" y="6" width="3" height="9" rx="1" /><rect x="12" y="2" width="3" height="13" rx="1" />
    </svg>
  )
}

const na = (v: number | null, unit: string) => (v == null ? t('n/a') : `${v} ${unit}`)

function RttGraph({ values }: { values: number[] }) {
  if (values.length < 2) return null
  const max = Math.max(100, ...values)
  const pts = values.map((v, i) => `${(i / 59) * 240},${40 - (v / max) * 36}`).join(' ')
  return (
    <svg className="rtt-graph" viewBox="0 0 240 40" preserveAspectRatio="none" role="img" aria-label={t('Ping over the last {n} seconds, up to {max} ms', { n: values.length, max: Math.max(...values) })}>
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

/** Live ping as signal bars; click for packet loss, jitter, bitrate, codec, the network path and a 60 s ping graph. */
function Ping() {
  const { stats, history } = useVoiceStats()
  const [open, setOpen] = useState(false)
  const screen = useScreenStats(open)
  const level = quality(stats)
  if (!stats || stats.rtt == null || !level) return null
  return (
    <div className="vp-ping-wrap">
      <button className={cls('vp-ping', level)} aria-expanded={open} aria-label={t('Ping {n} ms. Show connection details', { n: stats.rtt })} onClick={() => setOpen(!open)}>
        <SignalBars q={level} />
        {stats.rtt} ms
      </button>
      {open && (
        <>
          <RttGraph values={history} />
          <dl className="vp-stats">
            <dt>{t('Ping')}</dt><dd>{stats.rtt} ms</dd>
            <dt>{t('Packet loss (upload)')}</dt><dd>{stats.loss == null ? t('n/a') : `${stats.loss} %`}</dd>
            <dt>{t('Jitter')}</dt><dd>{na(stats.jitter, 'ms')}</dd>
            <dt>{t('Voice upload (incl. loss protection)')}</dt><dd>{na(stats.bitrate, 'kbps')}</dd>
            <dt>{t('Codec')}</dt><dd>{stats.codec ?? t('n/a')}</dd>
            <dt>{t('Connection')}</dt><dd>{stats.route ?? t('n/a')}</dd>
            <dt>{t('Voice server')}</dt><dd>{voiceBackend() ?? t('n/a')}</dd>
            {screen.send && <><dt>{t('Screen share encoder')}</dt><dd>{codingText(screen.send)}</dd><dt>{t('Screen share sent')}</dt><dd>{sizeText(screen.send)}</dd></>}
            {screen.recv && <><dt>{t('Screen share decoder')}</dt><dd>{codingText(screen.recv)}</dd><dt>{t('Screen share received')}</dt><dd>{sizeText(screen.recv)}</dd></>}
          </dl>
        </>
      )}
    </div>
  )
}

const STATUS_TEXT: Record<VoiceStatus, string> = {
  idle: '', waiting: 'Voice connecting', connecting: 'Voice connecting', connected: 'Voice Connected', unconfigured: 'Voice Unavailable', error: 'Voice Disconnected',
}

export function VoiceError() {
  const v = useStore((s) => s.voice)
  if (!v.error) return null
  return (
    <p className="voice-error" role="alert">
      {v.error}
      {v.status === 'error' && <> <button className="link" onClick={retryVoice}>{t('Retry')}</button></>}
    </p>
  )
}

export function MediaButtons({ big }: { big?: boolean }) {
  const v = useStore((s) => s.voice)
  const perms = usePerms(v.guildId ?? undefined, v.channelId ?? undefined)
  const [quality, setQuality] = useState(false)
  const [camMenu, setCamMenu] = useState<Anchor | null>(null)
  const [cameras, setCameras] = useState<MediaDeviceInfo[]>([])

  const openCamMenu = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    const rect = e.currentTarget.getBoundingClientRect()
    navigator.mediaDevices?.enumerateDevices().then((devs) => {
      setCameras(devs.filter((d) => d.kind === 'videoinput'))
    }).catch(() => {})
    setCamMenu({ rect, side: 'above' })
  }

  if (v.status !== 'connected' || !has(perms, P.STREAM)) return null
  const currentCamera = voiceSettings().camera
  return (
    <>
      <div className={cls('vp-split', big && 'big')}>
        <button className={cls('vp-btn', big && 'big', v.video && 'on')} aria-pressed={v.video} aria-label={t('Camera')} title={v.video ? t('Turn Off Camera') : t('Turn On Camera')} onClick={() => void toggleCamera()}>
          <Icon d={ICONS.camera} />
        </button>
        <button
          type="button"
          className="vp-btn-arrow"
          aria-label={t('Select Camera')}
          aria-haspopup="menu"
          title={t('Select Camera')}
          onClick={openCamMenu}
        >
          <Icon d={ICONS.chevron} size={12} />
        </button>
      </div>
      {camMenu && (
        <Popover at={camMenu} onClose={() => setCamMenu(null)} role="menu" label={t('Select Camera')}>
          <MenuLabel>{t('Camera')}</MenuLabel>
          {cameras.length === 0 ? (
            <MenuItem disabled onSelect={() => {}}>{t('No cameras found')}</MenuItem>
          ) : (
            cameras.map((d, i) => {
              const isChecked = currentCamera ? d.deviceId === currentCamera : i === 0
              return (
                <MenuItem
                  key={d.deviceId || i}
                  checked={isChecked}
                  onSelect={() => {
                    void setDevice('videoinput', d.deviceId, d.label)
                  }}
                >
                  {d.label || t('Camera {n}', { n: i + 1 })}
                </MenuItem>
              )
            })
          )}
        </Popover>
      )}
      <button className={cls('vp-btn', big && 'big', v.stream && 'on')} aria-pressed={v.stream} aria-label={t('Share Your Screen')} title={v.stream ? t('Stop Streaming') : t('Share Your Screen')} onClick={() => (v.stream ? void toggleScreen() : setQuality(true))}>
        <Icon d={ICONS.screen} />
      </button>
      {v.stream && (
        <button
          className={cls('vp-btn', big && 'big')}
          aria-label={t('Change Stream Window or Screen')}
          title={t('Change Window / Screen')}
          onClick={() => void switchScreenShare()}
        >
          <Icon d={ICONS.switchScreen} />
        </button>
      )}
      {v.stream && (
        <button className={cls('vp-btn', big && 'big')} aria-label={t('Stream Quality')} title={t('Stream Quality')} onClick={() => setQuality(true)}>
          <Icon d={ICONS.gear} />
        </button>
      )}
      {quality && (
        <StreamQualityModal
          live={v.stream}
          onApply={(q, captureCardDeviceId) => void (v.stream ? setStreamQuality(q) : startScreenShare(q, captureCardDeviceId))}
          onClose={() => setQuality(false)}
        />
      )}
    </>
  )
}

export function VoicePanel() {
  const v = useStore((s) => s.voice)
  const channel = useStore((s) => (s.voice.channelId ? s.channels[s.voice.channelId] : undefined))
  const guild = useStore((s) => (s.voice.guildId ? s.guilds[s.voice.guildId] : undefined))
  const [voiceTts, setVoiceTts] = useState(() => localStorage.getItem('cillcord:voiceTts') === 'true')

  const toggleTts = () => {
    const next = !voiceTts
    localStorage.setItem('cillcord:voiceTts', String(next))
    setVoiceTts(next)
  }

  // Client-side TTS for voice channel messages
  useEffect(() => {
    const handler = (e: Event) => {
      const msg = (e as CustomEvent<any>).detail
      if (!msg || msg.channel_id !== v.channelId) return
      const s = getState()
      if (msg.author?.id === s.me?.id) return

      if (localStorage.getItem('cillcord:voiceTts') === 'true' && !msg.author?.bot && msg.content && msg.content.length <= 200) {
        if ('speechSynthesis' in window) {
          const authorName = msg.author?.global_name || msg.author?.username || 'Someone'
          const clean = msg.content.replace(/<[^>]+>/g, '').trim()
          if (clean) {
            const u = new SpeechSynthesisUtterance(`${authorName} says: ${clean}`)
            u.volume = Math.min(1, Math.max(0, voiceSettings().outputVolume))
            window.speechSynthesis.speak(u)
          }
        }
      }
    }
    window.addEventListener('cillcord:message_create', handler)
    return () => window.removeEventListener('cillcord:message_create', handler)
  }, [v.channelId])

  if (!v.channelId) return null
  return (
    <section className="voice-panel" aria-label={t('Voice connection')}>
      <div className="vp-top">
        <div className="vp-info">
          <div className={cls('vp-state', v.status)} role="status" aria-live="polite">
            {STATUS_TEXT[v.status] && t(STATUS_TEXT[v.status])}
            {channel?.quality_mode === 'hifi' && <span className="vp-hifi-badge" title={t('Hi-Fi / Music Mode (Stereo, processing disabled)')}>🎵 {t('Hi-Fi')}</span>}
          </div>
          <button className="vp-where ellipsis" onClick={() => channel && navigate(`/channels/${guild?.id ?? '@me'}/${channel.id}`)}>
            {guild ? `${channel?.name ?? t('Voice')} / ${guild.name}` : channel ? privateName(getState(), channel) : t('Call')}
          </button>
        </div>
        <button className="icon-btn" aria-label={t('Pop Out Call Window')} title={t('Pop Out Call Window')} onClick={openVoicePopout}>
          <Icon d={ICONS.openFull} size={16} />
        </button>
        <button className="icon-btn" aria-label={t('Disconnect')} title={t('Disconnect')} onClick={leaveVoice}>
          <Icon d={ICONS.hangup} />
        </button>
      </div>
      <Ping />
      <VoiceError />
      <div className="vp-actions">
        <MediaButtons />
        <SoundboardButton />
        <button
          className={cls('vp-btn', voiceTts && 'on')}
          aria-pressed={voiceTts}
          aria-label={voiceTts ? t('Disable Voice Chat TTS') : t('Read Voice Chat Aloud (TTS)')}
          title={voiceTts ? t('Disable Voice Chat TTS') : t('Read Voice Chat Aloud (TTS)')}
          onClick={toggleTts}
        >
          <Icon d={ICONS.speaker} />
        </button>
      </div>
      <VoicePopout channel={channel} guild={guild} />
    </section>
  )
}
