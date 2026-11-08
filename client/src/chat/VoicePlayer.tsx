// Playback of voice messages and audio attachments with interactive waveform and 0.5x–2x speed.
import { t } from '../i18n'
import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { cdn } from '../api'
import { formatSize, Icon, ICONS } from '../components/ui'
import type { Attachment } from '../types'
import { bars, decodeWaveform } from './voiceMessage'

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const BARS = 48
const RATES = [1, 1.25, 1.5, 2, 0.5, 0.75]
const waveformCache = new Map<string, number[]>()

async function extractWaveform(url: string, numBars = BARS): Promise<number[]> {
  const resp = await fetch(url)
  const arrayBuf = await resp.arrayBuffer()
  const audioCtx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)()
  try {
    const audioBuf = await audioCtx.decodeAudioData(arrayBuf)
    const channelData = audioBuf.getChannelData(0)
    const chunkSize = Math.max(1, Math.floor(channelData.length / numBars))
    const peaks: number[] = []
    for (let i = 0; i < numBars; i++) {
      let max = 0
      const start = i * chunkSize
      const end = Math.min(start + chunkSize, channelData.length)
      for (let j = start; j < end; j++) {
        const val = Math.abs(channelData[j])
        if (val > max) max = val
      }
      peaks.push(max)
    }
    const maxPeak = Math.max(0.01, ...peaks)
    return peaks.map((p) => Math.max(0.12, Math.min(1, p / maxPeak)))
  } finally {
    void audioCtx.close().catch(() => {})
  }
}

export function VoicePlayer({ a }: { a: Attachment }) {
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [rate, setRate] = useState<number>(1)
  const [decodedLevels, setDecodedLevels] = useState<number[] | null>(() => waveformCache.get(a.id) ?? null)

  const duration = a.duration_secs || audio.current?.duration || 0
  const isPureVoice = Boolean(a.waveform)

  // Waveform levels: precomputed -> cached -> decoded -> fallback placeholder
  const fallbackBars = Array.from({ length: BARS }, (_, i) => 0.2 + 0.6 * Math.abs(Math.sin((i / BARS) * Math.PI * 2)))
  const levels = isPureVoice
    ? bars(decodeWaveform(a.waveform), BARS)
    : (decodedLevels ?? (waveformCache.get(a.id) || fallbackBars))

  const progress = duration ? Math.min(1, time / duration) : 0

  // Lazily decode waveform for audio attachments without precomputed waveform
  useEffect(() => {
    if (isPureVoice || decodedLevels || waveformCache.has(a.id)) return
    if (a.size && a.size > 15 * 1024 * 1024) return
    let active = true
    extractWaveform(cdn(a.url), BARS).then((peaks) => {
      waveformCache.set(a.id, peaks)
      if (active) setDecodedLevels(peaks)
    }).catch(() => {})
    return () => { active = false }
  }, [a.id, a.url, a.size, isPureVoice, decodedLevels])

  useEffect(() => {
    const el = audio.current
    if (!el) return
    const tick = () => setTime(el.currentTime)
    const end = () => (setPlaying(false), setTime(0))
    const onPause = () => setPlaying(false)
    const onPlay = () => {
      setPlaying(true)
      el.playbackRate = rate
      el.preservesPitch = true
    }
    el.addEventListener('timeupdate', tick)
    el.addEventListener('ended', end)
    el.addEventListener('pause', onPause)
    el.addEventListener('play', onPlay)
    return () => {
      el.removeEventListener('timeupdate', tick)
      el.removeEventListener('ended', end)
      el.removeEventListener('pause', onPause)
      el.removeEventListener('play', onPlay)
    }
  }, [rate])

  const seek = (t: number) => {
    if (!Number.isFinite(duration) || duration <= 0) return
    const el = audio.current
    if (!el) return
    el.currentTime = Math.max(0, Math.min(duration || el.duration || 0, t))
    setTime(el.currentTime)
  }

  const cycleRate = (e: MouseEvent) => {
    e.stopPropagation()
    const idx = RATES.indexOf(rate)
    const next = RATES[(idx + 1) % RATES.length]
    setRate(next)
    if (audio.current) {
      audio.current.playbackRate = next
      audio.current.preservesPitch = true
    }
  }

  const onPointer = (e: PointerEvent<HTMLDivElement>) => {
    if (e.buttons !== 1 && e.type !== 'pointerdown') return
    const r = e.currentTarget.getBoundingClientRect()
    seek(((e.clientX - r.left) / r.width) * duration)
  }

  const onKey = (e: KeyboardEvent) => {
    const d = { ArrowRight: 5, ArrowUp: 5, ArrowLeft: -5, ArrowDown: -5 }[e.key]
    if (d) (e.preventDefault(), seek(time + d))
    else if (e.key === 'Home') (e.preventDefault(), seek(0))
    else if (e.key === 'End') (e.preventDefault(), seek(duration))
  }

  return (
    <div className="voice-msg">
      {!isPureVoice && (
        <div className="audio-att-head">
          <Icon d={ICONS.speaker} size={16} />
          <span className="ellipsis audio-att-name">{a.filename}</span>
          <span className="hint small">{formatSize(a.size)}</span>
        </div>
      )}
      <div className="voice-msg-row">
        <button
          className="voice-play"
          aria-label={playing ? t('Pause audio') : t('Play audio')}
          onClick={() => (playing ? audio.current?.pause() : void audio.current?.play())}
        >
          <Icon d={playing ? ICONS.pause : ICONS.play} size={20} />
        </button>
        <div
          className="waveform"
          role="slider"
          tabIndex={0}
          aria-label={t('Audio position')}
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          aria-valuetext={t('{time} of {duration}', { time: fmt(time), duration: fmt(duration) })}
          onPointerDown={onPointer}
          onPointerMove={onPointer}
          onKeyDown={onKey}
        >
          {levels.map((l, i) => (
            <span key={i} className={i / BARS < progress ? 'on' : undefined} style={{ height: `${Math.round(l * 100)}%` }} />
          ))}
        </div>
        <span className="voice-time">{fmt(playing || time ? time : duration)}</span>
        <button
          type="button"
          className="vp-rate-btn"
          onClick={cycleRate}
          aria-label={t('Playback speed {rate}x', { rate })}
          title={t('Playback speed')}
        >
          {rate}x
        </button>
      </div>
      <audio ref={audio} src={cdn(a.url)} preload="none" />
    </div>
  )
}
