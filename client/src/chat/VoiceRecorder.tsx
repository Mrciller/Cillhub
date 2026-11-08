// Hold-to-record voice messages (MediaRecorder), sent as an IS_VOICE_MESSAGE attachment with duration and waveform.
import { t } from '../i18n'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { sendVoiceMessage } from '../actions'
import { toast, toastError } from '../components/dialogs'
import { cls, Icon, ICONS } from '../components/ui'
import type { Channel } from '../types'
import { analyse, recordingType } from './voiceMessage'

const MAX_MS = 20 * 60_000
type Rec = { recorder: MediaRecorder; stream: MediaStream; chunks: Blob[]; started: number; cancelled: boolean }

export function VoiceRecorder({ channel }: { channel: Channel }) {
  const rec = useRef<Rec | null>(null)
  const held = useRef(false)
  const [elapsed, setElapsed] = useState<number | null>(null)
  const recording = elapsed !== null
  const type = recordingType()

  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => {
      const r = rec.current
      if (!r) return
      const ms = Date.now() - r.started
      setElapsed(ms)
      if (ms >= MAX_MS) stop(false)
    }, 200)
    return () => clearInterval(t)
  }, [recording])

  useEffect(() => () => rec.current?.stream.getTracks().forEach((x) => x.stop()), [])

  async function start() {
    if (rec.current || !type) return
    held.current = true
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    } catch (e) {
      held.current = false
      return toast(e instanceof Error ? t("Couldn't use your microphone: {error}", { error: e.message }) : t("Couldn't use your microphone."))
    }
    if (!held.current) return stream.getTracks().forEach((x) => x.stop()) // released before permission came back
    const recorder = new MediaRecorder(stream, { mimeType: type })
    const r: Rec = { recorder, stream, chunks: [], started: Date.now(), cancelled: false }
    rec.current = r
    recorder.ondataavailable = (e) => e.data.size && r.chunks.push(e.data)
    recorder.onstop = () => {
      stream.getTracks().forEach((x) => x.stop())
      const secs = (Date.now() - r.started) / 1000
      if (r.cancelled) return
      if (secs < 0.5) return toast(t('Hold the microphone button to record a voice message.'))
      const blob = new Blob(r.chunks, { type: type!.split(';')[0] })
      void analyse(blob, secs).then(({ duration, waveform }) => sendVoiceMessage(channel, blob, Math.round(duration * 100) / 100, waveform)).catch(toastError)
    }
    recorder.start(250)
    setElapsed(0)
  }

  function stop(cancel: boolean) {
    held.current = false
    const r = rec.current
    if (!r) return
    r.cancelled = cancel
    rec.current = null
    setElapsed(null)
    if (r.recorder.state !== 'inactive') r.recorder.stop()
  }

  if (!type) return null
  const keyDown = (e: KeyboardEvent) => {
    if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) (e.preventDefault(), void start())
    else if (e.key === 'Escape' && rec.current) (e.preventDefault(), e.stopPropagation(), stop(true))
  }
  const keyUp = (e: KeyboardEvent) => (e.key === ' ' || e.key === 'Enter') && (e.preventDefault(), stop(false))
  const secs = Math.floor((elapsed ?? 0) / 1000)
  return (
    <>
      <button
        className={cls('icon-btn', elapsed !== null && 'recording')}
        aria-label={t('Record a voice message (hold)')}
        aria-pressed={elapsed !== null}
        title={t('Hold to record a voice message')}
        onPointerDown={(e) => e.button === 0 && (e.currentTarget.setPointerCapture(e.pointerId), void start())}
        onPointerUp={() => stop(false)}
        onPointerCancel={() => stop(true)}
        onKeyDown={keyDown}
        onKeyUp={keyUp}
        onContextMenu={(e) => e.preventDefault()}
      >
        <Icon d={ICONS.mic} size={22} />
      </button>
      <div className="recording-bar" role="status" aria-live="polite" hidden={elapsed === null}>
        {elapsed !== null && (
          <>
            <span className="rec-dot" aria-hidden="true" />
            <span>{t('Recording {time}', { time: `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` })}</span>
            <span className="hint small">{t('Release to send · Esc to cancel')}</span>
          </>
        )}
      </div>
    </>
  )
}
