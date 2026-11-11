// Watch Together panel in the voice view (CONTRACT-v5 section 1): link entry, synced YouTube player, queue, host controls.
import { useEffect, useRef, useState, type ReactNode, type FormEvent } from 'react'
import { fetchWatch, patchWatch, startWatch, stopWatch, type WatchAction } from '../actions'
import { ask, toastError } from '../components/dialogs'
import { cls, FormError, Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { canControlWatch, canManageWatch, canWatch } from '../permissions'
import { memberName, usePerms, watchTitle } from '../selectors'
import { getState, useStore } from '../store'
import type { Channel, WatchSession } from '../types'
import { effectiveVolume, loadYouTube, saveWatchAudio, targetPosition, watchAudio, youtubeId, YT_STATE, type WatchAudio, type YTPlayer } from './watch'
import './watch.css'

const fmt = (sec: number) => {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0')
  return `${h ? h + ':' : ''}${mm}:${String(s % 60).padStart(2, '0')}`
}

/** The synced player: follows the session (load, play/pause, rate) and seeks when it drifts more than 1 s. */
function Player({ session, host, audio, onPosition }: { session: WatchSession; host: boolean; audio: WatchAudio; onPosition: (sec: number, duration: number) => void }) {
  const box = useRef<HTMLDivElement>(null)
  const player = useRef<YTPlayer | null>(null)
  const loaded = useRef('')
  const latest = useRef(session)
  latest.current = session
  const ended = useRef('')
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [drift, setDrift] = useState(0)
  const [blocked, setBlocked] = useState(false)
  // someone else in the call is talking (our own voice does not duck the video)
  const talking = useStore((s) => Object.keys(s.voice.speaking).some((id) => id !== s.me?.id))
  const volume = effectiveVolume(audio, talking)
  const applied = useRef(-1)
  const applyVolume = () => {
    const p = player.current
    if (!p || applied.current === volume) return
    applied.current = volume
    p.setVolume(volume)
    if (volume === 0) p.mute()
    else p.unMute()
  }
  useEffect(() => { if (ready) applyVolume() }, [ready, volume])

  const sync = () => {
    const p = player.current
    const cur = latest.current.current
    if (!p || !cur) return
    const target = targetPosition(cur)
    if (loaded.current !== cur.video_id) {
      loaded.current = cur.video_id
      p.loadVideoById({ videoId: cur.video_id, startSeconds: target })
      if (!cur.playing) p.pauseVideo()
      return
    }
    if ((p.getPlaybackRate?.() ?? 1) !== (cur.rate || 1)) p.setPlaybackRate(cur.rate || 1)
    const state = p.getPlayerState()
    if (cur.playing && state !== YT_STATE.PLAYING && state !== YT_STATE.BUFFERING && state !== YT_STATE.ENDED) p.playVideo()
    if (!cur.playing && state === YT_STATE.PLAYING) p.pauseVideo()
    const d = p.getCurrentTime() - target
    const seek = Math.abs(d) > 1 && state !== YT_STATE.ENDED
    if (seek) p.seekTo(target, true)
    setDrift(seek ? p.getCurrentTime() - target : d)
    onPosition(p.getCurrentTime(), p.getDuration())
  }

  useEffect(() => {
    let alive = true
    loadYouTube().then((YT) => {
      if (!alive || !box.current) return
      const cur = latest.current.current
      const el = box.current.appendChild(document.createElement('div'))
      loaded.current = cur?.video_id ?? ''
      player.current = new YT.Player(el, {
        host: 'https://www.youtube-nocookie.com',
        videoId: cur?.video_id,
        width: '100%', height: '100%',
        playerVars: { autoplay: 1, controls: 0, disablekb: 1, rel: 0, playsinline: 1, start: cur ? Math.floor(targetPosition(cur)) : 0, origin: location.origin },
        events: {
          onReady: () => alive && (setReady(true), (applied.current = -1), sync()),
          onStateChange: (e: { data: number }) => {
            const cur = latest.current.current
            // The host's player advances the queue when a video ends (the server cannot see playback).
            if (e.data === YT_STATE.ENDED && host && cur && ended.current !== cur.video_id) (ended.current = cur.video_id), void patchWatch(session.channel_id, { action: 'next' }).catch(() => {})
            if (e.data === YT_STATE.PLAYING) setBlocked(false)
          },
          onError: () => alive && setError(t('This video cannot be played here.')),
        },
      })
    }, (e: Error) => alive && setError(e.message))
    return () => {
      alive = false
      player.current?.destroy()
      player.current = null
    }
  }, []) // one player per panel; session changes go through sync()

  useEffect(() => {
    if (!ready) return
    sync()
    const id = setInterval(() => {
      sync()
      // Browsers block autoplay with sound until the page had a click; offer one.
      const p = player.current
      const cur = latest.current.current
      if (p && cur?.playing) setBlocked([YT_STATE.UNSTARTED, YT_STATE.CUED, YT_STATE.PAUSED].includes(p.getPlayerState() as never))
    }, 1000)
    return () => clearInterval(id)
  }, [ready, session])

  const synced = Math.abs(drift) <= 1
  return (
    <div className="watch-player">
      <div ref={box} className="watch-frame" />
      {error && <p className="watch-overlay form-error" role="alert">{error}</p>}
      {blocked && !error && (
        <button className="watch-overlay primary" onClick={() => (player.current?.playVideo(), setBlocked(false))}>
          <Icon d={ICONS.play} /> {t('Click to watch along')}
        </button>
      )}
      {ready && session.current && (
        <span className={cls('watch-sync', synced ? 'ok' : 'off')} role="status" aria-live="polite">
          {synced ? t('In sync') : t('Syncing… ({n} s off)', { n: Math.abs(drift).toFixed(1) })}
        </span>
      )}
    </div>
  )
}

// 7.10.3: the YouTube player is third-party content; it loads only after a click, remembered on this device
const CONSENT_KEY = 'watch-youtube-ok'
const consented = () => { try { return localStorage.getItem(CONSENT_KEY) === '1' } catch { return false } }
function YouTubeConsent({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState(consented)
  const [later, setLater] = useState(false)
  if (ok) return <>{children}</>
  const load = () => { try { localStorage.setItem(CONSENT_KEY, '1') } catch { /* private mode: ask again next time */ } setOk(true) }
  return (
    <div className="watch-player watch-consent" role="group" aria-label={t('YouTube player')}>
      <p>{later ? t('The YouTube player is not loaded.') : t('This loads the video player from YouTube. Your IP address and browser data go to Google.')}</p>
      <div className="modal-actions">
        {!later && <button className="secondary" onClick={() => setLater(true)}>{t('Cancel')}</button>}
        <button className="primary" onClick={load}>{t('Load player')}</button>
      </div>
    </div>
  )
}

/** Loudness for this device: mute, volume, and lowering the video while people talk. */
function AudioControls({ audio, onChange }: { audio: WatchAudio; onChange: (a: WatchAudio) => void }) {
  const set = (patch: Partial<WatchAudio>) => onChange({ ...audio, ...patch })
  return (
    <div className="watch-audio" role="group" aria-label={t('Watch Together volume')}>
      <button className="icon-btn" aria-pressed={audio.muted} aria-label={audio.muted ? t('Unmute video') : t('Mute video')} onClick={() => set({ muted: !audio.muted })}>
        <Icon d={audio.muted || audio.volume === 0 ? ICONS.speakerOff : ICONS.speaker} />
      </button>
      <input type="range" className="watch-volume" min={0} max={100} step={1} value={audio.muted ? 0 : audio.volume} aria-label={t('Video volume')} aria-valuetext={`${audio.muted ? 0 : audio.volume} %`}
        onChange={(e) => set({ volume: +e.target.value, muted: false })} />
      <span className="watch-time">{audio.muted ? 0 : audio.volume} %</span>
      <label className="watch-control-switch">
        <input type="checkbox" role="switch" checked={audio.duck} onChange={(e) => set({ duck: e.target.checked })} />
        {t('Lower while people talk')}
      </label>
      {audio.duck && (
        <label className="watch-duck">
          <span className="sr-only">{t('Lowered volume')}</span>
          <select className="input small" value={audio.duckTo} onChange={(e) => set({ duckTo: +e.target.value })} aria-label={t('Lowered volume')}>
            {[10, 20, 30, 50, 70].map((v) => <option key={v} value={v}>{t('to {n} %', { n: v })}</option>)}
          </select>
        </label>
      )}
    </div>
  )
}

function AddForm({ channelId, starting }: { channelId: string; starting: boolean }) {
  const [url, setUrl] = useState('')
  const [error, setError] = useState('')
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!youtubeId(url)) return setError(t('Paste a YouTube link (youtube.com/watch, youtu.be or shorts).'))
    setError('')
    startWatch(channelId, url.trim()).then(() => setUrl(''), (err: Error) => setError(err.message))
  }
  return (
    <form className="watch-add" onSubmit={submit}>
      <label htmlFor={`watch-url-${channelId}`} className="sr-only">{t('YouTube link')}</label>
      <input id={`watch-url-${channelId}`} className="input" type="url" value={url} placeholder="https://www.youtube.com/watch?v=…" onChange={(e) => (setUrl(e.target.value), setError(''))} />
      <button className="primary">{starting ? t('Start Watching') : t('Add to Queue')}</button>
      <FormError error={error} />
    </form>
  )
}

/** Watch Together in a voice channel. Without a session it offers the link entry (when allowed). */
export function WatchPanel({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const session = useStore((s) => s.watch[channel.id])
  const meId = useStore((s) => s.me?.id)
  const perms = usePerms(channel.guild_id, channel.id)
  const [pos, setPos] = useState({ at: 0, duration: 0 })
  const [scrub, setScrub] = useState<number | null>(null)
  const [audio, setAudio] = useState(watchAudio)
  useEffect(() => void fetchWatch(channel.id), [channel.id])
  const allowed = canWatch(perms)
  const control = !!session && canControlWatch(session, meId)
  const manage = !!session && canManageWatch(perms, session, meId)
  const act = (body: WatchAction) => void patchWatch(channel.id, body).catch(toastError)
  const cur = session?.current
  const name = (id: string) => memberName(getState(), channel.guild_id, id)
  const stop = () => void ask({ title: t('Stop Watch Together?'), body: <p>{t('The video stops for everyone in {name}.', { name: channel.name ?? '' })}</p>, confirm: t('Stop'), danger: true })
    .then((ok) => void (ok && stopWatch(channel.id).catch(toastError)))
  const commit = () => scrub !== null && (act({ action: 'seek', position: scrub }), setScrub(null))
  const currentIndex = cur ? session.queue.findIndex((q) => q.video_id === cur.video_id) : -1

  return (
    <section className="watch" aria-label={t('Watch Together')}>
      <header className="watch-head">
        <Icon d={ICONS.tv} size={20} />
        <h2 className="ellipsis">{session && cur ? watchTitle(session) : t('Watch Together')}</h2>
        {session && <span className="hint small">{t('Host: {name}', { name: name(session.host_id) })}</span>}
        <span className="spacer" />
        {manage && (
          <label className="watch-control-switch">
            <input type="checkbox" role="switch" checked={session.control === 'everyone'} onChange={(e) => act({ control: e.target.checked ? 'everyone' : 'host' })} />
            {t('Control: everyone')}
          </label>
        )}
        {manage && <button className="danger-btn small-btn" onClick={stop}>{t('Stop')}</button>}
        {!session && <button className="icon-btn" aria-label={t('Close Watch Together')} onClick={onClose}><Icon d={ICONS.close} size={18} /></button>}
      </header>
      {session && cur && <YouTubeConsent><Player key={session.channel_id} session={session} host={session.host_id === meId} audio={audio} onPosition={(at, duration) => setPos({ at, duration })} /></YouTubeConsent>}
      {session && !cur && <p className="hint watch-empty">{t('The queue is empty. Add a video to keep watching.')}</p>}
      {session && cur && (
        <div className="watch-controls" role="group" aria-label={t('Playback controls')}>
          <button className="icon-btn" disabled={!control} aria-label={cur.playing ? t('Pause') : t('Play')} title={control ? undefined : t('Only the host controls playback')}
            onClick={() => act({ action: cur.playing ? 'pause' : 'play', position: pos.at })}>
            <Icon d={cur.playing ? ICONS.pause : ICONS.play} />
          </button>
          <button className="icon-btn" disabled={!control} aria-label={t('Next video')} onClick={() => act({ action: 'next' })}><Icon d={ICONS.skip} /></button>
          <span className="watch-time">{fmt(scrub ?? pos.at)}</span>
          <input type="range" className="watch-seek" min={0} max={Math.max(1, Math.floor(pos.duration))} step={1} value={Math.floor(scrub ?? pos.at)} disabled={!control}
            aria-label={t('Seek')} aria-valuetext={fmt(scrub ?? pos.at)}
            onChange={(e) => setScrub(+e.target.value)} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
          <span className="watch-time">{fmt(pos.duration)}</span>
        </div>
      )}
      {session && cur && <AudioControls audio={audio} onChange={(a) => (setAudio(a), saveWatchAudio(a))} />}
      {session && session.queue.length > 0 && (
        <div className="watch-queue">
          <h3 className="list-heading">{t('Queue')}</h3>
          <ol aria-label={t('Queue')}>
            {session.queue.map((q, i) => (
              <li key={`${q.video_id}-${i}`} className={cls('watch-item', i === currentIndex && 'now')}>
                <span className="ellipsis">{q.title || q.video_id}</span>
                <span className="hint small">{i === currentIndex ? t('Now playing') : t('added by {name}', { name: name(q.added_by) })}</span>
                {control && i !== currentIndex && (
                  <button className="icon-btn tiny" aria-label={t('Remove {title} from the queue', { title: q.title || q.video_id })} onClick={() => act({ action: 'remove', index: i })}>
                    <Icon d={ICONS.close} size={14} />
                  </button>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
      {allowed ? <AddForm channelId={channel.id} starting={!session} /> : !session && <p className="hint">{t('You need Connect and Video permission here to start Watch Together.')}</p>}
    </section>
  )
}
