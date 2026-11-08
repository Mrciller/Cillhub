// User Settings: My Account and Voice & Video.
import { useEffect, useRef, useState } from 'react'
import { api, dataUri } from '../api'
import { avatarUrl, cls, FormError, initials } from '../components/ui'
import { logout } from '../gateway'
import { apply, displayName, useStore } from '../store'
import type { User } from '../types'
import { micLabel, setAudioProcessing, setDevice, setInputGain, setInputMode, setOutputVolume } from '../voice/engine'
import { GainProcessor } from '../voice/gain'
import { canEncode, captureConstraints, desktopHwEncode, effectiveVoice, findInput, keyLabel, ncMicName, noiseMode, saveVoiceSettings, voiceSettings, type NoiseMode, type ScreenCodec } from '../voice/settings'
import { markRnnoiseFailed, RNNOISE_RATE, rnnoiseFailure } from '../rnnoise/rnnoise'
import { SettingsLayout } from './Layout'
import { Accessibility, Advanced, Appearance, Language } from '../appearance/AppearanceSettings'
import { t } from '../i18n'
import { NotificationPrefs } from '../notifications/NotificationPrefs'
import { ProfileSettings } from '../profiles/ProfileSettings'
import { ConnectionsSettings } from './ConnectionsSettings'
import { AccountSecurity } from '../security/AccountSecurity'
import { Sessions } from '../security/Sessions'
import { KeybindSettings } from '../custom/KeybindSettings'
import { SoundSettings } from '../custom/SoundSettings'
import { WhatsNewPage } from '../whatsnew/WhatsNew'
import { deviceZoom, setDeviceZoom } from '../appearance/apply'

export function UserSettings({ tab: initial, onClose }: { tab?: string; onClose: () => void }) {
  const [tab, setTab] = useState(initial ?? 'account')
  const user = t('User Settings')
  const app = t('App Settings')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || !(e.ctrlKey || e.metaKey)) return
      if (e.key === '-' || e.key === '_' || e.key === 'Subtract' || e.code === 'NumpadSubtract') {
        e.preventDefault()
        setDeviceZoom(Math.max(50, deviceZoom() - 10))
      } else if (e.key === '=' || e.key === '+' || e.key === 'Add' || e.code === 'NumpadAdd') {
        e.preventDefault()
        setDeviceZoom(Math.min(200, deviceZoom() + 10))
      } else if (e.key === '0' || e.code === 'Numpad0') {
        e.preventDefault()
        setDeviceZoom(100)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  return (
    <SettingsLayout
      title={user}
      tabs={[
        { id: 'account', label: t('My Account'), section: user }, { id: 'profiles', label: t('Profiles'), section: user }, { id: 'connections', label: t('Connections'), section: user }, { id: 'devices', label: t('Devices'), section: user },
        { id: 'appearance', label: t('Appearance'), section: app }, { id: 'accessibility', label: t('Accessibility'), section: app }, { id: 'voice', label: t('Voice & Video'), section: app },
        { id: 'notifications', label: t('Notifications'), section: app }, { id: 'sounds', label: t('Sounds'), section: app }, { id: 'keybinds', label: t('Keybinds'), section: app },
        { id: 'language', label: t('Language'), section: app }, { id: 'advanced', label: t('Advanced'), section: app },
        { id: 'whats-new', label: t("What's New"), section: app },
      ]}
      tab={tab}
      setTab={setTab}
      onClose={onClose}
      footer={<button className="settings-tab danger" onClick={logout}>{t('Log Out')}</button>}
    >
      {{
        account: <><Account /><AccountSecurity /></>, profiles: <ProfileSettings />, connections: <ConnectionsSettings />, devices: <Sessions />, appearance: <Appearance />, accessibility: <Accessibility />,
        voice: <VoiceVideo />, notifications: <NotificationPrefs />, sounds: <SoundSettings />, keybinds: <KeybindSettings />, language: <Language />, advanced: <Advanced />, 'whats-new': <WhatsNewPage />,
      }[tab] ?? <Account />}
    </SettingsLayout>
  )
}

function Account() {
  const me = useStore((s) => s.me)!
  const [name, setName] = useState(me.global_name ?? '')
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const preview = avatar === undefined ? avatarUrl(me) : avatar
  const dirty = name.trim() !== (me.global_name ?? '') || avatar !== undefined
  const save = () => {
    setError('')
    api<User>('/users/@me', { method: 'PATCH', body: { global_name: name.trim() || null, ...(avatar !== undefined && { avatar }) } }).then(
      (u) => (apply('USER_UPDATE', u), setAvatar(undefined), setSaved(true)),
      (e: Error) => setError(e.message),
    )
  }
  return (
    <>
      <h1>{t('My Account')}</h1>
      <div className="account-card">
        <div className="account-banner" />
        <div className="account-head">
          <span className="avatar big-avatar">
            {preview ? <img src={preview} alt={t('Your avatar')} /> : <span aria-hidden="true">{initials(displayName(me), 2).toUpperCase()}</span>}
          </span>
          <div>
            <div className="profile-name">{name.trim() || me.username}</div>
            <div className="hint">{me.username}</div>
          </div>
        </div>
        <div className="account-fields">
          <div className="field">
            <label htmlFor="display-name">{t('Display Name')}</label>
            <input id="display-name" className="input" maxLength={32} value={name} placeholder={me.username} onChange={(e) => (setName(e.target.value), setSaved(false))} />
          </div>
          <div className="field">
            <span className="field-label">{t('Avatar')}</span>
            <div className="row-buttons">
              <label className="primary file-btn">
                {t('Change Avatar')}
                <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) dataUri(f).then((d) => (setAvatar(d), setSaved(false)), (err: Error) => setError(err.message)); e.target.value = '' }} />
              </label>
              {preview && <button className="link" onClick={() => (setAvatar(null), setSaved(false))}>{t('Remove Avatar')}</button>}
            </div>
          </div>
          <dl className="account-facts">
            <dt>{t('Username')}</dt><dd>{me.username}</dd>
            {me.email && <><dt>{t('Email')}</dt><dd>{me.email}</dd></>}
          </dl>
        </div>
      </div>
      <FormError error={error} />
      <div className="save-bar">
        {saved && !dirty && <span className="success" role="status">{t('Saved.')}</span>}
        <button className="link" disabled={!dirty} onClick={() => (setName(me.global_name ?? ''), setAvatar(undefined))}>{t('Reset')}</button>
        <button className="primary" disabled={!dirty} onClick={save}>{t('Save Changes')}</button>
      </div>
    </>
  )
}

function useDevices() {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([])
  const refresh = () => navigator.mediaDevices?.enumerateDevices().then(setDevices, () => {})
  useEffect(() => {
    refresh()
    navigator.mediaDevices?.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices?.removeEventListener('devicechange', refresh)
  }, [])
  return [devices, refresh] as const
}

function DeviceSelect({ label, kind, devices, value, onChange }: { label: string; kind: MediaDeviceKind; devices: MediaDeviceInfo[]; value: string; onChange: (id: string) => void }) {
  const list = devices.filter((d) => d.kind === kind && d.deviceId !== 'default')
  return (
    <div className="field grow">
      <label htmlFor={`dev-${kind}`}>{label}</label>
      <select id={`dev-${kind}`} className="input" value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{t('Default')}</option>
        {list.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `${label} ${i + 1}`}</option>)}
      </select>
    </div>
  )
}

/** "Let's Check": live input level from the chosen microphone. */
function MicTest({ deviceId, label, gain, noise, onPermission, onFallback: fallback }: { deviceId: string; label: string; gain: number; noise: string; onPermission: () => void; onFallback: () => void }) {
  const onFallback = useRef(fallback)
  onFallback.current = fallback
  const gainNode = useRef<GainNode | null>(null)
  useEffect(() => void gainNode.current?.gain.setTargetAtTime(gain, gainNode.current.context.currentTime, 0.02), [gain])
  const [on, setOn] = useState(false)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState('')
  const stop = useRef<() => void>(() => {})
  // Kept in a ref: refreshing the device list re-renders the parent with a new callback, which must not restart the test.
  const permitted = useRef(onPermission)
  permitted.current = onPermission
  useEffect(() => {
    if (!on) return
    let raf = 0
    let ctx: AudioContext | null = null
    let stream: MediaStream | null = null
    let proc: GainProcessor | null = null
    let stopped = false
    navigator.mediaDevices.getUserMedia({ audio: captureConstraints(voiceSettings(), { id: deviceId, label }) }).then(
      async (s) => {
        stream = s
        permitted.current()
        const settings = voiceSettings()
        const mode = noise as NoiseMode
        const denoise = mode === 'speex' || mode === 'enhanced' || mode === 'studio' ? mode : null
        const extras = { noiseGate: settings.noiseGate, highPass: settings.highPassFilter, compressor: settings.voiceCompressor }
        const needs48k = Boolean(denoise || extras.noiseGate?.enabled)
        ctx = new AudioContext(needs48k ? { sampleRate: RNNOISE_RATE } : undefined)
        const an = ctx.createAnalyser()
        an.fftSize = 512
        const rawTrack = s.getAudioTracks()[0]
        try {
          proc = new GainProcessor(settings.inputGain, denoise, extras)
          await proc.init({ track: rawTrack, audioContext: ctx } as any)
          if (stopped) return
          const outTrack = proc.processedTrack ?? rawTrack
          const procSrc = ctx.createMediaStreamSource(new MediaStream([outTrack]))
          procSrc.connect(an)
          procSrc.connect(ctx.destination)
          const device = voiceSettings().output
          const sink = (ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId
          if (device && sink) void sink.call(ctx, device).catch(() => {})
          const buf = new Float32Array(an.fftSize)
          const tick = () => {
            an.getFloatTimeDomainData(buf)
            const rms = Math.sqrt(buf.reduce((a, x) => a + x * x, 0) / buf.length)
            setLevel(Math.min(1, rms * 4))
            raf = requestAnimationFrame(tick)
          }
          tick()
        } catch (e) {
          markRnnoiseFailed(e)
          onFallback.current()
        }
      },
      (e: Error) => (setError(t("Couldn't open the microphone: {error}", { error: e.message })), setOn(false)),
    )
    stop.current = () => {
      stopped = true
      void proc?.destroy()
      cancelAnimationFrame(raf)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close().catch(() => {})
      setLevel(0)
    }
    return () => stop.current()
  }, [on, deviceId, noise])
  return (
    <div className="mic-test">
      <h3 className="field-label">{t('Mic Test')}</h3>
      <p className="hint small">{t("Having mic issues? Start a test and say something: the bar should move and you hear yourself (use headphones). Static here comes from the mic, its interface or the processing below; if this sounds clean but others hear static, it's the connection.")}</p>
      <div className="row-buttons">
        <button className="primary" onClick={() => setOn(!on)}>{on ? t('Stop Testing') : t("Let's Check")}</button>
        <div className="meter" role="meter" aria-label={t('Input level')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(level * 100)}>
          <div className="meter-fill" style={{ width: `${level * 100}%` }} />
        </div>
      </div>
      <FormError error={error} />
    </div>
  )
}

/** 5 Noise Suppression modes: Off, Standard (WebRTC), Low-CPU (SpeexDSP), Enhanced (RNNoise), Studio AI (GTCRN). */
function NoiseSuppression({ value, disabled, onChange }: { value: NoiseMode; disabled: boolean; onChange: (v: NoiseMode) => void }) {
  const failed = (value === 'enhanced' || value === 'speex' || value === 'studio') ? rnnoiseFailure() : ''
  return (
    <div className="field noise-field">
      <label htmlFor="noise-suppression">{t('Noise Suppression')}</label>
      <select id="noise-suppression" className="input" value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as NoiseMode)} aria-describedby="noise-hint">
        <option value="off">{t('Off')}</option>
        <option value="standard">{t('Standard')}</option>
        <option value="speex">{t('Low-CPU (SpeexDSP)')}</option>
        <option value="enhanced">{t('Enhanced')}</option>
        <option value="studio">{t('Studio AI (GTCRN)')}</option>
      </select>
      <p id="noise-hint" className="hint small">
        {t('Standard uses native WebRTC noise suppression. Low-CPU uses SpeexDSP for older CPUs. Enhanced runs RNNoise recurrent neural network. Studio AI runs GTCRN deep neural speech enhancement.')}
      </p>
      {failed && <p className="voice-note" role="status">{t('Enhanced noise suppression is unavailable ({reason}). Using Standard.', { reason: failed })}</p>}
    </div>
  )
}

/** 0-300 % slider, 100 % default; double-click resets. */
function VolumeSlider({ id, label, value, onChange }: { id: string; label: string; value: number; onChange: (v: number) => void }) {
  const pct = Math.round(value * 100)
  return (
    <div className="field volume-field">
      <label htmlFor={id}>{label} <span className="hint">{pct}%</span></label>
      <input id={id} type="range" min={0} max={300} step={5} value={pct} aria-valuetext={`${pct}%`} title={t('Double-click to reset to 100%')}
        onChange={(e) => onChange(+e.target.value / 100)} onDoubleClick={() => onChange(1)} />
    </div>
  )
}

function VoiceVideo() {
  const [devices, refresh] = useDevices()
  const [s, setS] = useState(voiceSettings())
  const [recording, setRecording] = useState(false)
  const pick = (kind: 'audioinput' | 'audiooutput' | 'videoinput') => (id: string) => {
    void setDevice(kind, id, devices.find((d) => d.deviceId === id)?.label).finally(() => setS({ ...voiceSettings() }))
    setS(voiceSettings())
  }
  // the saved mic as a capture would resolve it (found again by label, or gone), and the processing in effect for it
  const found = findInput(s, devices)
  const eff = effectiveVoice(s, found.label)
  const nc = ncMicName(found.label)
  const [inUse, setInUse] = useState(micLabel)
  useEffect(() => {
    const id = setInterval(() => setInUse(micLabel()), 1000) // captures start and stop asynchronously, in either voice backend
    return () => clearInterval(id)
  }, [])
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.key !== 'Escape') setInputMode('ptt', e.code)
      setS(voiceSettings())
      setRecording(false)
    }
    addEventListener('keydown', onKey, { capture: true })
    return () => removeEventListener('keydown', onKey, { capture: true })
  }, [recording])
  return (
    <>
      <h1>{t('Voice Settings')}</h1>
      <div className="row-fields">
        <DeviceSelect label={t('Input Device')} kind="audioinput" devices={devices} value={found.lost ? '' : found.id} onChange={pick('audioinput')} />
        <DeviceSelect label={t('Output Device')} kind="audiooutput" devices={devices} value={s.output} onChange={pick('audiooutput')} />
      </div>
      <div className="row-fields">
        <VolumeSlider id="input-volume" label={t('Input Volume')} value={s.inputGain} onChange={(v) => (void setInputGain(v), setS(voiceSettings()))} />
        <VolumeSlider id="output-volume" label={t('Output Volume')} value={s.outputVolume} onChange={(v) => (setOutputVolume(v), setS(voiceSettings()))} />
      </div>
      {found.lost && (
        <p className="voice-note" role="status">
          {s.inputLabel ? t('Microphone “{name}” not found. Using the default microphone.', { name: s.inputLabel }) : t('Your chosen microphone was not found. Using the default microphone.')}
        </p>
      )}
      <p className="hint small" aria-live="polite">{inUse ? t('Microphone in use: {name}', { name: inUse }) : t('No microphone in use right now (not in a call, or muted).')}</p>
      <MicTest deviceId={found.id} label={found.label} gain={s.inputGain} noise={noiseMode(eff)} onPermission={refresh} onFallback={() => setS({ ...voiceSettings() })} />
      <fieldset className="choice block">
        <legend className="field-label">{t('Input Mode')}</legend>
        <label className={cls('radio-card', s.mode === 'vad' && 'on')}>
          <input type="radio" name="mode" checked={s.mode === 'vad'} onChange={() => (setInputMode('vad'), setS(voiceSettings()))} /> {t('Voice Activity')}
        </label>
        <label className={cls('radio-card', s.mode === 'ptt' && 'on')}>
          <input type="radio" name="mode" checked={s.mode === 'ptt'} onChange={() => (setInputMode('ptt'), setS(voiceSettings()))} /> {t('Push to Talk')}
        </label>
      </fieldset>
      {s.mode === 'ptt' && (
        <div className="field">
          <span className="field-label" id="ptt-label">{t('Shortcut')}</span>
          <div className="row-buttons">
            <kbd className="keybind" aria-labelledby="ptt-label">{keyLabel(s.pttKey)}</kbd>
            <button className={recording ? 'danger-btn' : 'secondary'} onClick={() => setRecording(!recording)} aria-live="polite">
              {recording ? t('Press a key… (Escape to cancel)') : t('Edit Keybind')}
            </button>
          </div>
          <p className="hint small">{t('Push to talk works while this tab has focus.')}</p>
        </div>
      )}
      <fieldset className="choice block">
        <legend className="field-label">{t('Voice Processing')}</legend>
        {nc && (
          <div className="voice-note">
            <p role="status">{eff !== s ? t('{name} detected: Cillhub’s noise suppression and auto gain are off so they don’t fight it.', { name: nc }) : t('{name} detected: you turned Cillhub’s noise suppression and auto gain back on.', { name: nc })}</p>
            <label className="check-row">
              <input type="checkbox" checked={eff === s} onChange={(e) => (void setAudioProcessing({ virtualMicOverride: e.target.checked ? found.label : '' }), setS(voiceSettings()))} />
              <span className="check-label">{t('Use Cillhub’s noise suppression and auto gain anyway')}</span>
            </label>
          </div>
        )}
        <NoiseSuppression value={eff.noiseSuppression} disabled={eff !== s} onChange={(v) => (void setAudioProcessing({ noiseSuppression: v }), setS(voiceSettings()))} />
        {([
          ['echoCancellation', 'Echo Cancellation', 'Removes your speakers from your mic. Not needed with headphones.'],
          ['autoGainControl', 'Automatic Gain Control', 'Evens out your volume. Turn off if your interface already sets the gain.'],
        ] as const).map(([key, label, hint]) => (
          <label key={key} className="check-row">
            <input type="checkbox" checked={eff[key]} disabled={key === 'autoGainControl' && eff !== s} onChange={(e) => (void setAudioProcessing({ [key]: e.target.checked }), setS(voiceSettings()))} />
            <span><span className="check-label">{t(label)}</span><span className="hint small">{t(hint)}</span></span>
          </label>
        ))}
        <label className="check-row">
          <input type="checkbox" checked={s.dtx} onChange={(e) => (saveVoiceSettings({ dtx: e.target.checked }), setS(voiceSettings()))} />
          <span><span className="check-label">{t('Save Bandwidth When Silent (DTX)')}</span><span className="hint small">{t('Sends almost nothing between words. Can make your voice sound choppy with a noisy mic. Applies the next time you join voice.')}</span></span>
        </label>
        <label className="check-row">
          <input type="checkbox" checked={s.spatialAudio} onChange={(e) => (saveVoiceSettings({ spatialAudio: e.target.checked }), setS(voiceSettings()))} />
          <span><span className="check-label">{t('Spatial 3D Audio')}</span><span className="hint small">{t('Positions speakers around you in 3D stereo space for natural immersion.')}</span></span>
        </label>
      </fieldset>
      <fieldset className="choice block">
        <legend className="field-label">{t('Noise Gate & Voice Filters')}</legend>
        <label className="check-row">
          <input
            type="checkbox"
            checked={s.noiseGate.enabled}
            onChange={(e) => {
              const next = { ...s.noiseGate, enabled: e.target.checked }
              void setAudioProcessing({ noiseGate: next })
              setS(voiceSettings())
            }}
          />
          <span>
            <span className="check-label">{t('Hysteresis Noise Gate')}</span>
            <span className="hint small">{t('Automatically cuts microphone input when audio falls below threshold to eliminate background chatter and breathing.')}</span>
          </span>
        </label>
        {s.noiseGate.enabled && (
          <div style={{ marginLeft: '1.5rem', marginTop: '0.5rem', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
            <div className="field">
              <label htmlFor="ng-open">{t('Open Threshold')} <span className="hint">{s.noiseGate.openThreshold} dB</span></label>
              <input
                id="ng-open"
                type="range"
                min={-60}
                max={-10}
                step={1}
                value={s.noiseGate.openThreshold}
                onChange={(e) => {
                  const open = +e.target.value
                  const next = { ...s.noiseGate, openThreshold: open, closeThreshold: Math.min(open - 2, s.noiseGate.closeThreshold) }
                  void setAudioProcessing({ noiseGate: next })
                  setS(voiceSettings())
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="ng-close">{t('Close Threshold')} <span className="hint">{s.noiseGate.closeThreshold} dB</span></label>
              <input
                id="ng-close"
                type="range"
                min={-70}
                max={-15}
                step={1}
                value={s.noiseGate.closeThreshold}
                onChange={(e) => {
                  const close = +e.target.value
                  const next = { ...s.noiseGate, closeThreshold: close, openThreshold: Math.max(close + 2, s.noiseGate.openThreshold) }
                  void setAudioProcessing({ noiseGate: next })
                  setS(voiceSettings())
                }}
              />
            </div>
            <div className="field">
              <label htmlFor="ng-hold">{t('Hold Time')} <span className="hint">{s.noiseGate.holdMs} ms</span></label>
              <input
                id="ng-hold"
                type="range"
                min={20}
                max={500}
                step={10}
                value={s.noiseGate.holdMs}
                onChange={(e) => {
                  const next = { ...s.noiseGate, holdMs: +e.target.value }
                  void setAudioProcessing({ noiseGate: next })
                  setS(voiceSettings())
                }}
              />
            </div>
          </div>
        )}
        <label className="check-row">
          <input
            type="checkbox"
            checked={s.highPassFilter}
            onChange={(e) => {
              void setAudioProcessing({ highPassFilter: e.target.checked })
              setS(voiceSettings())
            }}
          />
          <span>
            <span className="check-label">{t('80 Hz High-Pass Rumble Filter')}</span>
            <span className="hint small">{t('Cuts low-frequency desk vibrations, mic bumps, AC rumble, and plosive pops before the denoiser.')}</span>
          </span>
        </label>
        <label className="check-row">
          <input
            type="checkbox"
            checked={s.voiceCompressor}
            onChange={(e) => {
              void setAudioProcessing({ voiceCompressor: e.target.checked })
              setS(voiceSettings())
            }}
          />
          <span>
            <span className="check-label">{t('Broadcast Voice Compressor')}</span>
            <span className="hint small">{t('Gentle automatic leveling so whispers and loud speech remain at a consistent volume.')}</span>
          </span>
        </label>
      </fieldset>
      <div className="field volume-field">
        <label htmlFor="sb-volume">{t('Soundboard Volume')} <span className="hint">{Math.round(s.soundboardVolume * 100)}%</span></label>
        <input
          id="sb-volume"
          type="range"
          min={0}
          max={200}
          step={5}
          value={Math.round(s.soundboardVolume * 100)}
          onChange={(e) => {
            const v = +e.target.value / 100
            saveVoiceSettings({ soundboardVolume: v })
            setS(voiceSettings())
          }}
          onDoubleClick={() => {
            saveVoiceSettings({ soundboardVolume: 1 })
            setS(voiceSettings())
          }}
          title={t('Double-click to reset to 100%')}
        />
      </div>
      <div className="field">
        <label className="check-row">
          <input
            type="checkbox"
            checked={localStorage.getItem('cillcord:voiceTts') === 'true'}
            onChange={(e) => {
              localStorage.setItem('cillcord:voiceTts', String(e.target.checked))
              setS({ ...voiceSettings() })
            }}
          />
          <span>
            <span className="check-label">{t('Read Voice-Channel Text Chat Aloud (TTS)')}</span>
            <span className="hint small">{t('Automatically speaks text messages sent in your current voice channel using speech synthesis.')}</span>
          </span>
        </label>
      </div>
      <div className="field">
        <label htmlFor="voice-bitrate">{t('Voice Quality')}</label>
        <select id="voice-bitrate" className="input" value={s.bitrate} onChange={(e) => (void setAudioProcessing({ bitrate: Number(e.target.value) }), setS(voiceSettings()))}>
          {[32000, 48000, 64000, 96000, 128000].map((b) => <option key={b} value={b}>{b / 1000} kbps{b === 64000 ? ` ${t('(default)')}` : ''}</option>)}
        </select>
      </div>
      <h1 className="sub-title">{t('Video Settings')}</h1>
      <DeviceSelect label={t('Camera')} kind="videoinput" devices={devices} value={s.camera} onChange={pick('videoinput')} />
      <div className="field">
        <label htmlFor="camera-background">{t('Virtual Background & Blur')}</label>
        <select
          id="camera-background"
          className="input"
          value={s.virtualBackground}
          onChange={(e) => {
            saveVoiceSettings({ virtualBackground: e.target.value as any })
            setS(voiceSettings())
          }}
        >
          <option value="none">{t('None')}</option>
          <option value="blur">{t('Background Blur')}</option>
          <option value="studio">{t('Studio Dark')}</option>
          <option value="gradient">{t('Soft Gradient')}</option>
        </select>
        <p className="hint small">{t('Process your camera stream with portrait background blur or virtual backdrops.')}</p>
      </div>
      <div className="field">
        <label htmlFor="screen-codec">{t('Screen Share Encoder')}</label>
        <select id="screen-codec" className="input" aria-describedby="screen-codec-hint screen-codec-av1" value={s.screenCodec} onChange={(e) => (saveVoiceSettings({ screenCodec: e.target.value as ScreenCodec }), setS(voiceSettings()))}>
          <option value="auto">{t('Auto (AV1 on a capable graphics card, else H.264)')}</option>
          {(['av1', 'h264', 'vp8', 'vp9'] as const).map((c) => <option key={c} value={c} disabled={!canEncode(c)}>{{ av1: 'AV1', h264: 'H.264', vp8: 'VP8', vp9: 'VP9' }[c]}{canEncode(c) ? '' : ` (${t('not supported here')})`}</option>)}
        </select>
        <p className="hint small" id="screen-codec-hint">
          {t('H.264 lets your graphics card encode the stream (NVENC, AMF, Quick Sync, VideoToolbox, VA-API), which saves CPU in games. VP8 and VP9 are usually encoded by the CPU. Applies the next time you share your screen.')}
          {desktopHwEncode() && <> {t('GPU encoding is on in the desktop app.')}</>}
        </p>
        <p className="hint small" id="screen-codec-av1">
          {t('With Clarity, AV1 keeps text sharper at the same bitrate. Auto uses it only when your graphics card encodes AV1 (NVIDIA RTX 40/50, AMD RX 7000 and newer, Intel Arc; on Windows in the desktop app). Chosen here, AV1 may be encoded by the CPU, which takes about twice the CPU of H.264. Viewers who cannot play AV1 get H.264 or VP8.')}
        </p>
      </div>
    </>
  )
}
