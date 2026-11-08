// Watch Together helpers (CONTRACT-v5 section 1): YouTube links, the synced target position and the IFrame API loader.
import { serverOffset } from '../api'
import { t } from '../i18n'
import type { WatchSession } from '../types'

/** The 11-character id of a youtube.com/watch?v=, youtu.be/ or youtube.com/shorts/ link (the only ones the server accepts), else null. */
export function youtubeId(input: string): string | null {
  let u: URL
  try { u = new URL(input.trim()) } catch { return null }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  const host = u.hostname.replace(/^(www|m|music)\./, '')
  const id = host === 'youtu.be' ? u.pathname.split('/')[1]
    : host === 'youtube.com' && u.pathname === '/watch' ? u.searchParams.get('v')
    : host === 'youtube.com' && u.pathname.startsWith('/shorts/') ? u.pathname.split('/')[2]
    : null
  return id && /^[\w-]{11}$/.test(id) ? id : null
}

const ms = (v: string | number) => (typeof v === 'number' ? (v < 1e12 ? v * 1000 : v) : Date.parse(v))
/** Where playback should be now, in seconds: `position` plus the server time since `started_at` while playing. */
export function targetPosition(cur: NonNullable<WatchSession['current']>, now = Date.now() + serverOffset()) {
  if (!cur.playing) return cur.position
  const since = Math.max(0, now - ms(cur.started_at)) / 1000
  return cur.position + (Number.isFinite(since) ? since : 0) * (cur.rate || 1)
}

// Minimal typing of the YouTube IFrame Player API (https://developers.google.com/youtube/iframe_api_reference).
export type YTPlayer = {
  loadVideoById(o: { videoId: string; startSeconds?: number }): void; playVideo(): void; pauseVideo(): void; seekTo(s: number, allowSeekAhead: boolean): void
  getCurrentTime(): number; getDuration(): number; setVolume(v: number): void; mute(): void; unMute(): void; getPlayerState(): number; getPlaybackRate(): number; setPlaybackRate(r: number): void; destroy(): void
}
export type YT = { Player: new (el: HTMLElement, opts: object) => YTPlayer }
export const YT_STATE = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 } as const

let loading: Promise<YT> | null = null
/** Loads the IFrame API on demand (only when a Watch Together player is shown). Videos play from youtube-nocookie.com. */
export function loadYouTube(): Promise<YT> {
  return (loading ??= new Promise<YT>((resolve, reject) => {
    const w = window as unknown as { YT?: YT; onYouTubeIframeAPIReady?: () => void }
    if (w.YT?.Player) return resolve(w.YT)
    const prev = w.onYouTubeIframeAPIReady
    w.onYouTubeIframeAPIReady = () => (prev?.(), resolve(w.YT!))
    const s = Object.assign(document.createElement('script'), { src: 'https://www.youtube.com/iframe_api', async: true })
    s.onerror = () => ((loading = null), s.remove(), reject(new Error(t('Could not load the YouTube player.'))))
    document.head.appendChild(s)
  }))
}

/** Per-device Watch Together loudness: volume 0-100, mute, and lowering the video while someone in the call speaks. */
export type WatchAudio = { volume: number; muted: boolean; duck: boolean; duckTo: number }
const AUDIO_KEY = 'watch-audio'
const AUDIO_DEFAULT: WatchAudio = { volume: 60, muted: false, duck: true, duckTo: 30 }
const pct = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : d)
export function watchAudio(): WatchAudio {
  let saved: Partial<WatchAudio> = {}
  try { saved = JSON.parse(localStorage.getItem(AUDIO_KEY) ?? '{}') ?? {} } catch { /* broken value: defaults */ }
  return { volume: pct(saved.volume, AUDIO_DEFAULT.volume), muted: saved.muted === true, duck: saved.duck !== false, duckTo: pct(saved.duckTo, AUDIO_DEFAULT.duckTo) }
}
export const saveWatchAudio = (a: WatchAudio) => localStorage.setItem(AUDIO_KEY, JSON.stringify(a))
/** The player volume to apply now: ducked to duckTo % of the volume while someone talks. */
export const effectiveVolume = (a: WatchAudio, talking: boolean) => (a.muted ? 0 : a.duck && talking ? Math.round((a.volume * a.duckTo) / 100) : a.volume)
