// "Go Live" quality dialog: resolution, frame rate and what to optimize for.
import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { cls, Modal } from '../components/ui'
import { saveVoiceSettings, streamBitrate, voiceSettings, type StreamQuality } from './settings'
import { useScreenStats, type VideoCoding } from './stats'
import { switchScreenShare } from './engine'

/** "H.264 · GPU (MediaFoundationVideoEncodeAccelerator)", "VP8 · software (libvpx)". */
export const codingText = (v: VideoCoding) => [v.codec ?? t('n/a'), v.hw == null ? null : v.hw ? t('GPU') : t('software')].filter(Boolean).join(' · ') + (v.impl ? ` (${v.impl})` : '')
/** "1920×1080 · 30 fps". */
export const sizeText = (v: VideoCoding) => (v.width && v.height ? `${v.width}×${v.height}${v.fps != null ? ` · ${v.fps} fps` : ''}` : t('n/a'))

const RES: [StreamQuality['resolution'], string][] = [['720', '720p'], ['1080', '1080p'], ['1440', '1440p'], ['source', 'Source']]
const FPS: StreamQuality['fps'][] = [15, 30, 60]
const MODES: [StreamQuality['mode'], string, string][] = [
  ['motion', 'Motion', 'Smooth movement for games and video.'],
  ['detail', 'Clarity', 'Sharp text for code, documents and slides.'],
]

export function StreamQualityModal({ live, onApply, onClose }: { live: boolean; onApply: (q: StreamQuality, captureCardDeviceId?: string) => void; onClose: () => void }) {
  const [q, setQ] = useState<StreamQuality>(voiceSettings().stream)
  const [sourceType, setSourceType] = useState<'screen' | 'capture_card'>('screen')
  const [captureCards, setCaptureCards] = useState<MediaDeviceInfo[]>([])
  const [selectedCaptureCard, setSelectedCaptureCard] = useState<string>('')
  const [audioMode, setAudioMode] = useState<'application' | 'system' | 'none'>(
    voiceSettings().screenAudioMode ?? (voiceSettings().screenAudio !== false ? 'system' : 'none')
  )
  const { send } = useScreenStats(live)

  useEffect(() => {
    if (!navigator.mediaDevices?.enumerateDevices) return
    navigator.mediaDevices.enumerateDevices().then((devs) => {
      const vInputs = devs.filter((d) => d.kind === 'videoinput')
      setCaptureCards(vInputs)
      if (vInputs.length && !selectedCaptureCard) {
        setSelectedCaptureCard(vInputs[0].deviceId)
      }
    }).catch(() => {})
  }, [])
  const group = <K extends keyof StreamQuality>(key: K, legend: string, options: [StreamQuality[K], string, string?][]) => (
    <fieldset className="choice block">
      <legend className="field-label">{legend}</legend>
      <div className="choice-row">
        {options.map(([value, label, hint]) => (
          <label key={String(value)} className={cls('radio-card', q[key] === value && 'on')} title={hint && t(hint)}>
            <input type="radio" name={key} checked={q[key] === value} onChange={() => setQ({ ...q, [key]: value })} /> {t(label)}
          </label>
        ))}
      </div>
    </fieldset>
  )
  return (
    <Modal title={live ? t('Stream Quality') : t('Screen Share')} onClose={onClose} className="stream-quality">
      <fieldset className="choice block">
        <legend className="field-label">{t('Source')}</legend>
        <div className="choice-row">
          <label className={cls('radio-card', sourceType === 'screen' && 'on')}>
            <input type="radio" name="sourceType" checked={sourceType === 'screen'} onChange={() => setSourceType('screen')} /> {t('Screen / Window')}
          </label>
          <label className={cls('radio-card', sourceType === 'capture_card' && 'on')}>
            <input type="radio" name="sourceType" checked={sourceType === 'capture_card'} onChange={() => setSourceType('capture_card')} /> {t('Capture Card / Video Device')}
          </label>
        </div>
      </fieldset>
      {sourceType === 'capture_card' && (
        <div className="field" style={{ marginTop: '10px' }}>
          <label htmlFor="capture-card-select">{t('Video Device')}</label>
          {captureCards.length > 0 ? (
            <select
              id="capture-card-select"
              className="input"
              value={selectedCaptureCard}
              onChange={(e) => setSelectedCaptureCard(e.target.value)}
            >
              {captureCards.map((d, i) => (
                <option key={d.deviceId || i} value={d.deviceId}>
                  {d.label || t('Capture Card {n}', { n: i + 1 })}
                </option>
              ))}
            </select>
          ) : (
            <p className="hint small">{t('No capture cards or video input devices detected.')}</p>
          )}
        </div>
      )}
      {group('resolution', t('Resolution'), RES)}
      {group('fps', t('Frame Rate'), FPS.map((f) => [f, `${f} FPS`]))}
      {group('mode', t('Optimize For'), MODES)}
      <p className="hint small">{t(MODES.find(([m]) => m === q.mode)?.[2] ?? '')} {t('Uses up to about {n} Mbit/s of your upload. Higher settings need a faster connection and more CPU.', { n: (streamBitrate(q) / 1e6).toFixed(1) })}</p>
      {send && <p className="hint small" aria-live="polite">{t('Encoder: {name}', { name: codingText(send) })} · {sizeText(send)}</p>}
      <fieldset className="choice block" style={{ marginTop: '10px' }}>
        <legend className="field-label">{t('Audio Capture')}</legend>
        <div className="choice-row">
          <label className={cls('radio-card', audioMode === 'system' && 'on')} title={t('Capture entire system audio (games, music, desktop)')}>
            <input
              type="radio"
              name="audioMode"
              checked={audioMode === 'system'}
              onChange={() => {
                setAudioMode('system')
                saveVoiceSettings({ screenAudio: true, screenAudioMode: 'system' })
              }}
            />
            {t('System Audio')}
          </label>
          <label className={cls('radio-card', audioMode === 'application' && 'on')} title={t('Capture only the shared application or tab sound')}>
            <input
              type="radio"
              name="audioMode"
              checked={audioMode === 'application'}
              onChange={() => {
                setAudioMode('application')
                saveVoiceSettings({ screenAudio: true, screenAudioMode: 'application' })
              }}
            />
            {t('Application Audio')}
          </label>
          <label className={cls('radio-card', audioMode === 'none' && 'on')} title={t('Do not share audio')}>
            <input
              type="radio"
              name="audioMode"
              checked={audioMode === 'none'}
              onChange={() => {
                setAudioMode('none')
                saveVoiceSettings({ screenAudio: false, screenAudioMode: 'none' })
              }}
            />
            {t('No Audio')}
          </label>
        </div>
      </fieldset>
      <div className="modal-actions">
        {live && (
          <button
            type="button"
            className="secondary"
            style={{ marginRight: 'auto' }}
            onClick={() => {
              onClose()
              void switchScreenShare(q, sourceType === 'capture_card' ? selectedCaptureCard : undefined)
            }}
          >
            {t('Change Screen / Window')}
          </button>
        )}
        <button className="link" onClick={onClose}>{t('Cancel')}</button>
        <button
          className="primary"
          onClick={() => {
            onApply(q, sourceType === 'capture_card' ? selectedCaptureCard : undefined)
            onClose()
          }}
        >
          {live ? t('Apply') : t('Go Live')}
        </button>
      </div>
    </Modal>
  )
}
