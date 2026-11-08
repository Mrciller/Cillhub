// Main column for a voice channel: participant grid with video, screen shares and speaking avatars.
import { ChannelPanelButtons } from '../modules/ModulePanel'
import { t } from '../i18n'
import { useEffect, useRef, useState } from 'react'
import type { VideoTrackLike as Track } from './engine'
import { ChatBody } from '../chat/Chat'
import { useContextMenu } from '../components/menu'
import { UserMenu } from '../components/UserMenu'
import { Avatar, cls, Icon, ICONS, memberAvatarUrl } from '../components/ui'
import { canWatch, has, P } from '../permissions'
import { memberName, usePerms, watchTitle } from '../selectors'
import { setState, useStore } from '../store'
import type { Channel, Guild, VoiceState } from '../types'
import { getStreamVolume, joinVoice, leaveVoice, setSelfDeaf, setSelfMute, setStreamVolume, stopScreenShare, switchScreenShare, videoTiles } from './engine'
import { MediaButtons, VoiceError } from './VoicePanel'
import { VoiceIcons } from './VoiceUsers'
import { VoiceStatusHeader } from './VoiceStatus'
import { WatchPanel } from '../watch/WatchTogether'
import { openVoicePopout } from './VoicePopout'
import './voice-v5.css'
import { headerAccent } from '../custom/channel'
import './voice-v3.css'

const CHAT_KEY = 'voice-chat-open'
/** Text chat next to a voice or stage grid (CONTRACT-v3: voice channels take messages), open state remembered. */
export function useVoiceChat() {
  const [open, setOpen] = useState(() => localStorage.getItem(CHAT_KEY) === '1')
  const toggle = () => {
    const next = !open
    localStorage.setItem(CHAT_KEY, next ? '1' : '0')
    setOpen(next)
  }
  const openExplicit = () => {
    localStorage.setItem(CHAT_KEY, '1')
    setOpen(true)
  }
  const closeExplicit = () => {
    localStorage.setItem(CHAT_KEY, '0')
    setOpen(false)
  }
  const button = (
    <button className={cls('icon-btn', open && 'active')} aria-pressed={open} aria-label={open ? t('Hide Chat') : t('Show Chat')} title={open ? t('Hide Chat') : t('Show Chat')} onClick={toggle}>
      <Icon d={ICONS.chat} />
    </button>
  )
  return { open, button, close: closeExplicit, openChat: openExplicit }
}

export function VoiceChatPane({ channel, guild, onClose }: { channel: Channel; guild: Guild; onClose: () => void }) {
  return (
    <aside className="voice-chat" aria-label={t('Chat in {name}', { name: channel.name ?? '' })}>
      <header className="voice-chat-head">
        <Icon d={ICONS.chat} size={20} className="chan-icon" />
        <h2 className="ellipsis">{channel.name}</h2>
        <span className="spacer" />
        <button className="icon-btn" aria-label={t('Close Chat')} onClick={onClose}><Icon d={ICONS.close} size={18} /></button>
      </header>
      <ChatBody channel={channel} guild={guild} />
    </aside>
  )
}

const STREAM_SIZES_KEY = 'cillhub-stream-sizes'
function getStoredStreamSizes(): Record<string, number> {
  try {
    const raw = localStorage.getItem(STREAM_SIZES_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}
function saveStoredStreamSize(key: string, width: number | null) {
  try {
    const sizes = getStoredStreamSizes()
    if (width === null) {
      delete sizes[key]
    } else {
      sizes[key] = width
    }
    localStorage.setItem(STREAM_SIZES_KEY, JSON.stringify(sizes))
  } catch {}
}

function Video({ track, mirror, fit }: { track: Track; mirror: boolean; fit?: 'contain' | 'cover' }) {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current!
    track.attach(el)
    return () => void track.detach(el)
  }, [track])
  return <video ref={ref} className={cls(mirror && 'mirror', fit === 'cover' && 'fit-cover')} autoPlay playsInline muted />
}

type TileProps = { guildId?: string; v: VoiceState; track?: Track; screen?: boolean; focused?: boolean; onFocus?: () => void }
export function Tile({ guildId, v, track, screen, focused, onFocus }: TileProps) {
  const s = useStore((x) => x)
  const menu = useContextMenu()
  const tileRef = useRef<HTMLLIElement>(null)
  const name = memberName(s, guildId, v.user_id)
  const speaking = !screen && !!s.voice.speaking[v.user_id]
  const isStream = !!(screen || track)

  const isLocalScreen = Boolean(screen && v.user_id === s.me?.id)
  const isRemoteScreen = Boolean(screen && v.user_id !== s.me?.id)
  const [previewStream, setPreviewStream] = useState(false)
  const [streamVolume, setStreamVol] = useState(() => (isRemoteScreen ? getStreamVolume(v.user_id) : 1))

  useEffect(() => {
    if (isRemoteScreen) {
      setStreamVol(getStreamVolume(v.user_id))
    }
  }, [isRemoteScreen, v.user_id])

  const streamKey = screen ? `${v.user_id}-screen` : `${v.user_id}-camera`
  const [customWidth, setCustomWidth] = useState<number | null>(() => (isStream ? (getStoredStreamSizes()[streamKey] ?? null) : null))
  const [isResizing, setIsResizing] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [fitMode, setFitMode] = useState<'contain' | 'cover'>('contain')
  const [hudVisible, setHudVisible] = useState(true)
  const hudTimer = useRef<number | null>(null)
  const resizeCleanup = useRef<(() => void) | null>(null)

  useEffect(() => {
    return () => {
      if (hudTimer.current) window.clearTimeout(hudTimer.current)
      if (resizeCleanup.current) resizeCleanup.current()
    }
  }, [])

  // Exit fullscreen if track disappears
  useEffect(() => {
    if (!track && isFullscreen) {
      setIsFullscreen(false)
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
    }
  }, [track, isFullscreen])

  // Sync native fullscreen changes
  useEffect(() => {
    const onFsChange = () => {
      if (!document.fullscreenElement && isFullscreen) {
        setIsFullscreen(false)
      }
    }
    document.addEventListener('fullscreenchange', onFsChange)
    return () => document.removeEventListener('fullscreenchange', onFsChange)
  }, [isFullscreen])

  // Escape key listener for fullscreen
  useEffect(() => {
    if (!isFullscreen) return
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsFullscreen(false)
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [isFullscreen])

  // Fullscreen HUD auto-hide on inactivity
  const onPointerMove = () => {
    if (!isFullscreen) return
    setHudVisible(true)
    if (hudTimer.current) window.clearTimeout(hudTimer.current)
    hudTimer.current = window.setTimeout(() => setHudVisible(false), 3000)
  }

  const enterFullscreen = () => {
    setIsFullscreen(true)
    setHudVisible(true)
    if (tileRef.current && document.fullscreenEnabled && !document.fullscreenElement) {
      tileRef.current.requestFullscreen().catch(() => {})
    }
  }

  const exitFullscreen = () => {
    setIsFullscreen(false)
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {})
    }
  }

  const toggleFullscreen = (e?: React.MouseEvent) => {
    if (e) e.stopPropagation()
    if (isFullscreen) {
      exitFullscreen()
    } else {
      enterFullscreen()
    }
  }

  const onResizePointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsResizing(true)
    const startX = e.clientX
    const startW = tileRef.current?.offsetWidth ?? 360

    const onPointerMove = (ev: PointerEvent) => {
      const delta = ev.clientX - startX
      const minW = 220
      const maxW = Math.max(minW, window.innerWidth - 48)
      const nextW = Math.round(Math.max(minW, Math.min(maxW, startW + delta)))
      setCustomWidth(nextW)
    }

    const cleanup = () => {
      setIsResizing(false)
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
      resizeCleanup.current = null
    }

    const onPointerUp = (ev: PointerEvent) => {
      cleanup()
      const delta = ev.clientX - startX
      const minW = 220
      const maxW = Math.max(minW, window.innerWidth - 48)
      const nextW = Math.round(Math.max(minW, Math.min(maxW, startW + delta)))
      setCustomWidth(nextW)
      saveStoredStreamSize(streamKey, nextW)
    }

    resizeCleanup.current = cleanup
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp)
  }

  const onResizeDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    setCustomWidth(null)
    saveStoredStreamSize(streamKey, null)
  }

  const stepSize = (delta: number, e: React.MouseEvent) => {
    e.stopPropagation()
    const currentW = customWidth ?? tileRef.current?.offsetWidth ?? 360
    const minW = 220
    const maxW = Math.max(minW, window.innerWidth - 48)
    const nextW = Math.round(Math.max(minW, Math.min(maxW, currentW + delta)))
    setCustomWidth(nextW)
    saveStoredStreamSize(streamKey, nextW)
  }

  const resetSize = (e: React.MouseEvent) => {
    e.stopPropagation()
    setCustomWidth(null)
    saveStoredStreamSize(streamKey, null)
  }

  const onTileClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button, .tile-resize-handle, .tile-stream-controls, .local-screen-placeholder, input')) {
      return
    }
    if (isLocalScreen && !previewStream) {
      return
    }
    if (isStream) {
      toggleFullscreen()
    } else if (onFocus) {
      onFocus()
    }
  }

  const label = screen
    ? t(focused ? "{name}'s screen, focused" : "{name}'s screen, click for fullscreen", { name })
    : name

  const tileStyle: React.CSSProperties = {}
  if (customWidth !== null && !focused && !isFullscreen) {
    tileStyle.flex = `0 0 ${customWidth}px`
    tileStyle.width = `${customWidth}px`
    tileStyle.maxWidth = '100%'
  }

  return (
    <li
      ref={tileRef}
      className={cls(
        'tile',
        speaking && 'speaking',
        focused && 'focused',
        isStream && 'is-stream',
        isFullscreen && 'is-fullscreen',
        isResizing && 'is-resizing'
      )}
      style={tileStyle}
      onPointerMove={onPointerMove}
      onClick={onTileClick}
      {...menu.props}
    >
      <div
        className="tile-inner"
        role={isStream ? 'region' : undefined}
        tabIndex={0}
        aria-label={label}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && isStream && (!isLocalScreen || previewStream)) {
            e.preventDefault()
            toggleFullscreen()
          }
        }}
      >
        {isLocalScreen && !previewStream ? (
          <div className="local-screen-placeholder" onClick={(e) => e.stopPropagation()}>
            <div className="local-screen-badge-row">
              <span className="live">{t('LIVE')}</span>
            </div>
            <div className="local-screen-icon">
              <Icon d={ICONS.screen} size={40} />
            </div>
            <h3 className="local-screen-title">{t('You are sharing your screen')}</h3>
            <p className="local-screen-subtext">{t('Preview is paused to prevent mirror loops.')}</p>
            <div className="local-screen-actions">
              <button
                type="button"
                className="primary local-screen-btn"
                onClick={() => setPreviewStream(true)}
              >
                <Icon d={ICONS.screen} size={16} />
                <span>{t('Preview Stream')}</span>
              </button>
              <button
                type="button"
                className="secondary local-screen-btn"
                onClick={() => void switchScreenShare()}
              >
                <Icon d={ICONS.switchScreen} size={16} />
                <span>{t('Change Window/Screen')}</span>
              </button>
              <button
                type="button"
                className="danger local-screen-btn"
                onClick={() => void stopScreenShare()}
              >
                <Icon d={ICONS.close} size={16} />
                <span>{t('Stop Streaming')}</span>
              </button>
            </div>
          </div>
        ) : track ? (
          <>
            <Video track={track} mirror={!screen && v.user_id === s.me?.id} fit={fitMode} />
            {isLocalScreen && previewStream && (
              <div
                className="local-screen-preview-warning"
                role="status"
                onClick={(e) => {
                  e.stopPropagation()
                  setPreviewStream(false)
                }}
                title={t('Click to pause preview')}
              >
                <Icon d={ICONS.screen} size={14} />
                <span>{t('Previewing local screen — click to pause preview to avoid mirror loops')}</span>
              </div>
            )}
          </>
        ) : (
          <Avatar
            user={s.users[v.user_id]}
            src={memberAvatarUrl(guildId, guildId ? s.members[guildId]?.[v.user_id] : undefined)}
            size={80}
            speaking={speaking}
          />
        )}
        <span className="tile-name">
          {screen && <span className="live">{t('LIVE')}</span>} {name} {!screen && <VoiceIcons v={v} />}
        </span>
      </div>

      {/* Stream Controls (visible on hover) */}
      {isStream && !isFullscreen && (
        <div className="tile-stream-controls" onClick={(e) => e.stopPropagation()}>
          {isRemoteScreen && (
            <div className="tile-volume-slider-wrap" title={t('Stream Volume: {pct}%', { pct: Math.round(streamVolume * 100) })} onClick={(e) => e.stopPropagation()}>
              <button
                className="tile-ctrl-btn"
                aria-label={streamVolume === 0 ? t('Unmute Stream') : t('Mute Stream')}
                onClick={(e) => {
                  e.stopPropagation()
                  const next = streamVolume === 0 ? 1 : 0
                  setStreamVolume(v.user_id, next)
                  setStreamVol(next)
                }}
              >
                <Icon d={streamVolume === 0 ? ICONS.speakerOff : ICONS.speaker} size={14} />
              </button>
              <input
                type="range"
                min={0}
                max={200}
                step={5}
                value={Math.round(streamVolume * 100)}
                aria-label={t('Stream Volume')}
                className="tile-volume-range"
                onChange={(e) => {
                  const next = +e.target.value / 100
                  setStreamVolume(v.user_id, next)
                  setStreamVol(next)
                }}
              />
            </div>
          )}
          {isLocalScreen && (
            <button
              className={cls('tile-ctrl-btn', previewStream && 'active')}
              aria-label={previewStream ? t('Pause Stream Preview') : t('Preview Stream')}
              title={previewStream ? t('Pause Stream Preview') : t('Preview Stream')}
              onClick={(e) => {
                e.stopPropagation()
                setPreviewStream(!previewStream)
              }}
            >
              <Icon d={ICONS.screen} size={14} />
            </button>
          )}
          <button
            className="tile-ctrl-btn"
            aria-label={t('Make stream smaller')}
            title={t('Make stream smaller (-)')}
            onClick={(e) => stepSize(-80, e)}
          >
            <Icon d={ICONS.down} size={14} />
          </button>
          {customWidth !== null && (
            <button
              className="tile-ctrl-btn reset-btn"
              aria-label={t('Reset stream size')}
              title={t('Reset stream size (double-click handle)')}
              onClick={resetSize}
            >
              <span className="ctrl-btn-text">1x</span>
            </button>
          )}
          <button
            className="tile-ctrl-btn"
            aria-label={t('Make stream larger')}
            title={t('Make stream larger (+)')}
            onClick={(e) => stepSize(80, e)}
          >
            <Icon d={ICONS.up} size={14} />
          </button>
          <button
            className={cls('tile-ctrl-btn', fitMode === 'cover' && 'active')}
            aria-label={fitMode === 'contain' ? t('Fill Screen (Crop)') : t('Fit Screen (Letterbox)')}
            title={fitMode === 'contain' ? t('Fill Screen (Crop)') : t('Fit Screen (Letterbox)')}
            onClick={(e) => {
              e.stopPropagation()
              setFitMode(fitMode === 'contain' ? 'cover' : 'contain')
            }}
          >
            <Icon d={fitMode === 'contain' ? ICONS.expand : ICONS.openFull} size={14} />
          </button>
          {onFocus && (
            <button
              className={cls('tile-ctrl-btn', focused && 'active')}
              aria-label={focused ? t('Unfocus') : t('Theater focus')}
              title={focused ? t('Unfocus') : t('Theater focus')}
              onClick={(e) => {
                e.stopPropagation()
                onFocus()
              }}
            >
              <Icon d={ICONS.pin} size={14} />
            </button>
          )}
          {screen && v.user_id === s.me?.id && (
            <button
              className="tile-ctrl-btn"
              aria-label={t('Change Stream Window or Screen')}
              title={t('Change Window / Screen')}
              onClick={(e) => {
                e.stopPropagation()
                void switchScreenShare()
              }}
            >
              <Icon d={ICONS.switchScreen} size={14} />
            </button>
          )}
          {(!isLocalScreen || previewStream) && (
            <button
              className="tile-ctrl-btn fs-btn"
              aria-label={t('Fullscreen')}
              title={t('Fullscreen (or click stream)')}
              onClick={toggleFullscreen}
            >
              <Icon d={ICONS.openFull} size={14} />
            </button>
          )}
        </div>
      )}

      {/* Resize Handle (bottom-right corner) */}
      {isStream && !isFullscreen && !focused && (
        <div
          className={cls('tile-resize-handle', isResizing && 'resizing')}
          role="separator"
          aria-label={t('Drag to resize stream')}
          title={t('Drag to resize stream (double-click to reset)')}
          onPointerDown={onResizePointerDown}
          onDoubleClick={onResizeDoubleClick}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor">
            <path d="M8 2L2 8M9 5L5 9M9 8L8 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      )}

      {/* Fullscreen Overlay HUD */}
      {isFullscreen && (
        <div className={cls('fullscreen-stream-hud', !hudVisible && 'hidden')} onClick={(e) => e.stopPropagation()}>
          <div className="fullscreen-stream-info">
            <Avatar user={s.users[v.user_id]} size={32} />
            <span className="fullscreen-stream-name">{name}</span>
            {screen && <span className="live">{t('LIVE')}</span>}
          </div>
          <div className="fullscreen-stream-actions">
            {isRemoteScreen && (
              <div className="fullscreen-volume-wrap" onClick={(e) => e.stopPropagation()}>
                <button
                  className="icon-btn"
                  aria-label={streamVolume === 0 ? t('Unmute Stream') : t('Mute Stream')}
                  onClick={() => {
                    const next = streamVolume === 0 ? 1 : 0
                    setStreamVolume(v.user_id, next)
                    setStreamVol(next)
                  }}
                >
                  <Icon d={streamVolume === 0 ? ICONS.speakerOff : ICONS.speaker} size={18} />
                </button>
                <input
                  type="range"
                  min={0}
                  max={200}
                  step={5}
                  value={Math.round(streamVolume * 100)}
                  aria-label={t('Stream Volume')}
                  className="fullscreen-volume-range"
                  onChange={(e) => {
                    const next = +e.target.value / 100
                    setStreamVolume(v.user_id, next)
                    setStreamVol(next)
                  }}
                />
                <span className="fullscreen-volume-text">{Math.round(streamVolume * 100)}%</span>
              </div>
            )}
            {screen && v.user_id === s.me?.id && (
              <button
                className="icon-btn"
                aria-label={t('Change Stream Window or Screen')}
                title={t('Change Window / Screen')}
                onClick={() => void switchScreenShare()}
              >
                <Icon d={ICONS.switchScreen} size={18} />
              </button>
            )}
            <button
              className={cls('icon-btn', fitMode === 'cover' && 'active')}
              aria-label={fitMode === 'contain' ? t('Fill Screen (Crop)') : t('Fit Screen (Letterbox)')}
              title={fitMode === 'contain' ? t('Fill Screen (Crop)') : t('Fit Screen (Letterbox)')}
              onClick={() => setFitMode(fitMode === 'contain' ? 'cover' : 'contain')}
            >
              <Icon d={fitMode === 'contain' ? ICONS.expand : ICONS.openFull} size={18} />
            </button>
            <button
              className="icon-btn exit-fs-btn"
              aria-label={t('Exit Fullscreen (Esc)')}
              title={t('Exit Fullscreen (Esc)')}
              onClick={exitFullscreen}
            >
              <Icon d={ICONS.close} size={20} />
            </button>
          </div>
        </div>
      )}

      {menu.at && <UserMenu userId={v.user_id} guildId={guildId} at={menu.at} onClose={menu.close} />}
    </li>
  )
}

export function VoiceView({ channel, guild }: { channel: Channel; guild: Guild }) {
  const s = useStore((x) => x)
  useStore((x) => x.voice.tracks) // re-render when LiveKit tracks change
  const perms = usePerms(guild.id, channel.id)
  const [focus, setFocus] = useState<string | null>(null)
  const chat = useVoiceChat()
  const watch = useStore((x) => x.watch[channel.id])
  const [watchOpen, setWatchOpen] = useState(false)
  const showWatch = !!watch || watchOpen
  const states = Object.values(s.voiceStates[guild.id] ?? {}).filter((v) => v.channel_id === channel.id)
  const here = s.voice.channelId === channel.id
  const tiles = here ? videoTiles() : []
  const full = !!channel.user_limit && states.length >= channel.user_limit && !has(perms, P.MOVE_MEMBERS)

  const items = [
    ...tiles.filter((x) => x.source === 'screen').flatMap((x) => {
      const v = states.find((y) => y.user_id === x.userId)
      return v ? [{ id: `${x.userId}-screen`, v, track: x.track, screen: true }] : []
    }),
    ...states.map((v) => ({ id: v.user_id, v, track: tiles.find((x) => x.userId === v.user_id && x.source === 'camera')?.track, screen: false })),
  ]
  const focused = items.find((i) => i.id === focus)

  const [toast, setToast] = useState<any>(null)
  const toastTimer = useRef<number | null>(null)

  useEffect(() => {
    const handler = (e: Event) => {
      const msg = (e as CustomEvent<any>).detail
      if (!msg || msg.channel_id !== channel.id) return
      if (chat.open) return
      if (msg.author?.id === s.me?.id) return

      setToast(msg)
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
      toastTimer.current = window.setTimeout(() => setToast(null), 5000)
    }
    window.addEventListener('cillcord:message_create', handler)
    return () => {
      window.removeEventListener('cillcord:message_create', handler)
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [channel.id, chat.open, s.me?.id])

  return (
    <main className="chat voice-view" aria-label={t('Voice channel {name}', { name: channel.name ?? '' })}>
      <header className="chat-header" {...headerAccent(channel)}>
        <button className="icon-btn back" aria-label={t('Back to channels')} onClick={() => setState({ showNav: true })}>
          <Icon d={ICONS.back} />
        </button>
        <Icon d={ICONS.speaker} size={24} className="chan-icon" />
        <div className="voice-title">
          <h1 className="ellipsis">{channel.name}</h1>
          <VoiceStatusHeader channel={channel} />
        </div>
        <span className="spacer" />
        {canWatch(perms) && (
          <button className={cls('icon-btn', showWatch && 'active')} aria-pressed={showWatch} aria-label={t('Watch Together')} title={t('Watch Together')}
            onClick={() => setWatchOpen(!watchOpen)} disabled={!!watch}>
            <Icon d={ICONS.tv} />
          </button>
        )}
        <ChannelPanelButtons guildId={guild.id} />
        {here && (
          <button className="icon-btn" aria-label={t('Pop Out Call Window')} title={t('Pop Out Call Window')} onClick={openVoicePopout}>
            <Icon d={ICONS.openFull} />
          </button>
        )}
        {chat.button}
      </header>
      <div className="voice-split">
      <div className="voice-col" style={{ position: 'relative' }}>
      <div className="voice-body">
        {here && <VoiceError />}
        {showWatch && (here ? <WatchPanel channel={channel} onClose={() => setWatchOpen(false)} />
          : watch && <p className="notice watch-notice"><Icon d={ICONS.tv} size={16} /> {t('Watching: {title}', { title: watchTitle(watch) })}. {t('Join voice to watch along.')}</p>)}
        {(() => {
          const screenStreams = items.filter((x) => x.screen)
          const nonScreenItems = items.filter((x) => !x.screen)
          const cameraFocused = Boolean(focused && !focused.screen)

          if (!cameraFocused && screenStreams.length === 2 && !focused) {
            return (
              <>
                <ul className="tile-split-2" aria-label={t('Screen shares')}>
                  {screenStreams.map((item) => (
                    <Tile
                      key={item.id}
                      guildId={guild.id}
                      v={item.v}
                      track={item.track}
                      screen={true}
                      focused={false}
                      onFocus={() => setFocus(item.id)}
                    />
                  ))}
                </ul>
                {nonScreenItems.length > 0 && (
                  <ul className="tiles strip" aria-label={t('Participants')}>
                    {nonScreenItems.map(({ id, ...i }) => (
                      <Tile key={id} guildId={guild.id} {...i} onFocus={() => setFocus(id)} />
                    ))}
                  </ul>
                )}
              </>
            )
          }

          if (!cameraFocused && screenStreams.length === 2 && focused?.screen) {
            return (
              <>
                <div className="stream-switcher-bar" role="toolbar" aria-label={t('Stream Switcher')}>
                  {screenStreams.map((st) => {
                    const isAct = st.id === focused.id
                    const isLocal = st.v.user_id === s.me?.id
                    return (
                      <button
                        key={st.id}
                        type="button"
                        className={cls('stream-switcher-card', isAct && 'active')}
                        onClick={() => setFocus(st.id)}
                        aria-label={t("Switch to {name}'s stream", { name: memberName(s, guild.id, st.v.user_id) })}
                      >
                        <div className="stream-switcher-thumb">
                          {isLocal ? (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', color: 'var(--accent)' }}>
                              <Icon d={ICONS.screen} size={24} />
                            </div>
                          ) : st.track ? (
                            <Video track={st.track} mirror={false} fit="cover" />
                          ) : (
                            <Avatar user={s.users[st.v.user_id]} size={36} />
                          )}
                          <span className="live">{t('LIVE')}</span>
                          {isAct && <Icon d={ICONS.pin} size={12} className="stream-pinned-badge" />}
                        </div>
                        <div className="stream-switcher-meta">
                          <Avatar user={s.users[st.v.user_id]} size={18} />
                          <span className="stream-switcher-name ellipsis">{memberName(s, guild.id, st.v.user_id)}</span>
                        </div>
                      </button>
                    )
                  })}
                  <button
                    type="button"
                    className="stream-split-toggle-btn"
                    title={t('Split screen 50% / 50%')}
                    onClick={() => setFocus(null)}
                  >
                    <Icon d={ICONS.openFull} size={14} />
                    <span>{t('Split 50/50')}</span>
                  </button>
                </div>
                <ul className="tile-focus">
                  <Tile guildId={guild.id} v={focused.v} track={focused.track} screen={focused.screen} focused onFocus={() => setFocus(null)} />
                </ul>
                {nonScreenItems.length > 0 && (
                  <ul className="tiles strip" aria-label={t('Participants')}>
                    {nonScreenItems.map(({ id, ...i }) => (
                      <Tile key={id} guildId={guild.id} {...i} onFocus={() => setFocus(id)} />
                    ))}
                  </ul>
                )}
              </>
            )
          }

          if (!cameraFocused && screenStreams.length >= 3) {
            const primaryStream = focused?.screen ? focused : screenStreams[0]
            return (
              <>
                <div className="stream-switcher-bar" role="toolbar" aria-label={t('Stream Switcher')}>
                  {screenStreams.map((st) => {
                    const isAct = st.id === primaryStream.id
                    const isLocal = st.v.user_id === s.me?.id
                    return (
                      <button
                        key={st.id}
                        type="button"
                        className={cls('stream-switcher-card', isAct && 'active')}
                        onClick={() => setFocus(st.id)}
                        aria-label={t("Switch to {name}'s stream", { name: memberName(s, guild.id, st.v.user_id) })}
                      >
                        <div className="stream-switcher-thumb">
                          {isLocal ? (
                            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', height: '100%', color: 'var(--accent)' }}>
                              <Icon d={ICONS.screen} size={24} />
                            </div>
                          ) : st.track ? (
                            <Video track={st.track} mirror={false} fit="cover" />
                          ) : (
                            <Avatar user={s.users[st.v.user_id]} size={36} />
                          )}
                          <span className="live">{t('LIVE')}</span>
                          {focus === st.id && <Icon d={ICONS.pin} size={12} className="stream-pinned-badge" />}
                        </div>
                        <div className="stream-switcher-meta">
                          <Avatar user={s.users[st.v.user_id]} size={18} />
                          <span className="stream-switcher-name ellipsis">{memberName(s, guild.id, st.v.user_id)}</span>
                        </div>
                      </button>
                    )
                  })}
                </div>
                <ul className="tile-focus">
                  <Tile
                    guildId={guild.id}
                    v={primaryStream.v}
                    track={primaryStream.track}
                    screen={true}
                    focused
                    onFocus={() => setFocus(focus === primaryStream.id ? null : primaryStream.id)}
                  />
                </ul>
                {nonScreenItems.length > 0 && (
                  <ul className="tiles strip" aria-label={t('Participants')}>
                    {nonScreenItems.map(({ id, ...i }) => (
                      <Tile key={id} guildId={guild.id} {...i} onFocus={() => setFocus(id)} />
                    ))}
                  </ul>
                )}
              </>
            )
          }

          return (
            <>
              {focused && (
                <ul className="tile-focus">
                  <Tile guildId={guild.id} v={focused.v} track={focused.track} screen={focused.screen} focused onFocus={() => setFocus(null)} />
                </ul>
              )}
              <ul className={cls('tiles', focused && 'strip')} aria-label={t('Participants')}>
                {items.filter((i) => i !== focused).map(({ id, ...i }) => (
                  <Tile key={id} guildId={guild.id} {...i} onFocus={() => setFocus(id)} />
                ))}
              </ul>
            </>
          )
        })()}
        {!here && (
          <div className="voice-join">
            <h2>{channel.name}</h2>
            <p className="hint">{states.length ? t('{n} connected', { n: states.length }) : t('No one is here yet.')}</p>
            {!has(perms, P.CONNECT) ? <p className="hint">{t('You do not have permission to join this channel.')}</p>
              : full ? <p className="hint">{t('This channel is full.')}</p>
              : <button className="primary" onClick={() => joinVoice(guild.id, channel.id)}>{t('Join Voice')}</button>}
          </div>
        )}
      </div>
      {toast && (
        <div
          className="in-stream-toast"
          role="status"
          aria-live="polite"
          onClick={() => {
            chat.openChat()
            setToast(null)
          }}
        >
          <Avatar user={toast.author} size={28} />
          <div className="in-stream-toast-body">
            <div className="in-stream-toast-author">{toast.author?.global_name || toast.author?.username}</div>
            <div className="in-stream-toast-content ellipsis">{toast.content}</div>
          </div>
        </div>
      )}
      {here && (
        <div className="call-bar">
          <button className={cls('vp-btn big', s.voice.selfMute && 'danger-on')} aria-pressed={s.voice.selfMute} aria-label={t('Mute')} onClick={() => setSelfMute(!s.voice.selfMute)}>
            <Icon d={s.voice.selfMute ? ICONS.micOff : ICONS.mic} />
          </button>
          <button className={cls('vp-btn big', s.voice.selfDeaf && 'danger-on')} aria-pressed={s.voice.selfDeaf} aria-label={t('Deafen')} onClick={() => setSelfDeaf(!s.voice.selfDeaf)}>
            <Icon d={s.voice.selfDeaf ? ICONS.headsetOff : ICONS.headset} />
          </button>
          <MediaButtons big />
          <button className="vp-btn big hangup" aria-label={t('Disconnect')} onClick={leaveVoice}>
            <Icon d={ICONS.hangup} />
          </button>
        </div>
      )}
      </div>
      {chat.open && <VoiceChatPane channel={channel} guild={guild} onClose={chat.close} />}
      </div>
    </main>
  )
}
