// Local voice preferences, kept in localStorage.
import { rnnoiseFailure } from '../rnnoise/rnnoise'
export type NoiseGateSettings = { enabled: boolean; openThreshold: number; closeThreshold: number; holdMs: number }

export type VoiceSettings = {
  mode: 'vad' | 'ptt'
  pttKey: string // KeyboardEvent.code
  input: string; output: string; camera: string // device ids, '' = system default
  inputLabel: string // label of the chosen mic, to find it again when its id changes
  virtualMicOverride: string // label of a noise-removing virtual mic the user wants Cillhub's processing on for anyway
  volumes: Record<string, number> // user id -> 0..3 (1 = 100 %)
  selfMute: boolean; selfDeaf: boolean
  noiseSuppression: NoiseMode; echoCancellation: boolean; autoGainControl: boolean
  noiseGate: NoiseGateSettings
  highPassFilter: boolean
  voiceCompressor: boolean
  bitrate: number // Opus max bitrate in bit/s
  inputGain: number; outputVolume: number // 0..3 (1 = 100 %)
  dtx: boolean // Opus discontinuous transmission
  v: number // settings format version
  stream: StreamQuality
  screenCodec: ScreenCodec // screen share encoder preference
  screenAudio: boolean // capture tab / system audio with screen share (CONTRACT-v9 §8)
  screenAudioMode?: 'application' | 'system' | 'none'
  screenVolumes?: Record<string, number> // user id -> 0..3 for screen audio (CONTRACT-v13 §3)
  soundboardVolume: number // 0..1, local playback of soundboard sounds (v3)
  spatialAudio: boolean // Web Audio 3D spatial positioning (CONTRACT-v10 §9)
  virtualBackground: 'none' | 'blur' | 'studio' | 'gradient' // camera background filter
}

/** Off, Browser Native (Standard), SpeexDSP, RNNoise (Enhanced), or GTCRN (Studio). */
export type NoiseMode = 'off' | 'standard' | 'speex' | 'enhanced' | 'studio'
/**
 * Auto prefers AV1 when the graphics card encodes it (av1PowerEfficient), else H.264, the codec graphics cards encode
 * (NVENC, AMF, Quick Sync, VideoToolbox, VA-API); VP8 is almost always software. AV1 chosen by hand also runs in software (libaom).
 */
export type ScreenCodec = 'auto' | 'av1' | 'h264' | 'vp8' | 'vp9'
export type StreamQuality = { resolution: '720' | '1080' | '1440' | 'source'; fps: 15 | 30 | 60; mode: 'motion' | 'detail' }
/** Capture size per choice; 'source' caps at 4K, which is native for nearly every screen. */
export const RESOLUTIONS = { '720': { width: 1280, height: 720 }, '1080': { width: 1920, height: 1080 }, '1440': { width: 2560, height: 1440 }, source: { width: 3840, height: 2160 } } as const
/**
 * Screen share video bitrate in bit/s for a quality choice (the full layer; the encoder uses less on calm content).
 * Raised from 2/4/6.5/10 Mbit/s: scrolling text at 1080p30 left H.264 at QP 34-35 with 4 Mbit/s (stream-quality.cjs).
 */
export const streamBitrate = (q: StreamQuality) =>
  Math.round({ '720': 2_500_000, '1080': 6_000_000, '1440': 10_000_000, source: 16_000_000 }[q.resolution] * (q.fps === 60 ? 1.5 : q.fps === 15 ? 0.6 : 1))
/**
 * Screen shares keep the chosen resolution in both modes and drop frames when bandwidth or CPU run short. With
 * 'maintain-framerate' Chrome's quality scaler shrank shares to 270p-540p during the bandwidth ramp-up (320x180 without simulcast) and,
 * because text keeps the encoder's QP above its upscale threshold, never scales it back (stream-quality.cjs).
 */
export const SCREEN_DEGRADATION: RTCDegradationPreference = 'maintain-resolution'
const KEY = 'voice-settings'
const defaults: VoiceSettings = { mode: 'vad', pttKey: 'Backquote', input: '', inputLabel: '', virtualMicOverride: '', output: '', camera: '', volumes: {}, screenVolumes: {}, selfMute: false, selfDeaf: false, noiseSuppression: 'standard', noiseGate: { enabled: false, openThreshold: -40, closeThreshold: -48, holdMs: 150 }, highPassFilter: false, voiceCompressor: false, echoCancellation: true, autoGainControl: true, bitrate: 64000, dtx: false, v: 2, inputGain: 1, outputVolume: 1, stream: { resolution: '1080', fps: 30, mode: 'motion' }, screenCodec: 'auto', screenAudio: true, screenAudioMode: 'system', soundboardVolume: 0.5, spatialAudio: false, virtualBackground: 'none' }

let current: VoiceSettings = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}')
    // Version 2 raised voice quality defaults (64 kbps, DTX off); older saves only held the old defaults.
    if (!(saved.v >= 2)) Object.assign(saved, { bitrate: defaults.bitrate, dtx: defaults.dtx, v: 2 })
    if (typeof saved.noiseSuppression === 'boolean') saved.noiseSuppression = saved.noiseSuppression ? 'standard' : 'off'
    saved.noiseGate = { ...defaults.noiseGate, ...(saved.noiseGate ?? {}) }
    saved.highPassFilter = Boolean(saved.highPassFilter)
    saved.voiceCompressor = Boolean(saved.voiceCompressor)
    saved.screenVolumes = { ...defaults.screenVolumes, ...(saved.screenVolumes ?? {}) }
    if (!saved.screenAudioMode) saved.screenAudioMode = saved.screenAudio === false ? 'none' : 'system'
    return { ...defaults, ...saved }
  } catch { return defaults }
})()

export const voiceSettings = () => current
export function saveVoiceSettings(patch: Partial<VoiceSettings>) {
  current = { ...current, ...patch }
  localStorage.setItem(KEY, JSON.stringify(current))
}

/**
 * Virtual mics that remove noise themselves: NVIDIA Broadcast, its predecessor RTX Voice, Krisp. Cillhub's suppression on top
 * fights them and auto gain pumps the removed background back up. Voice changers (Voicemod) are not listed: they don't denoise.
 */
const NC_MICS = /NVIDIA Broadcast|RTX Voice|Krisp/i
/** "NVIDIA Broadcast" for "Microphone (NVIDIA Broadcast)", '' for an ordinary mic. */
export const ncMicName = (label: string) => NC_MICS.exec(label)?.[0] ?? ''

/** A resolved microphone: id '' = the default device; lost = the saved one is gone. */
export type MicChoice = { id: string; label: string; lost: boolean }
let mic: MicChoice = { id: current.input, label: current.inputLabel, lost: false } // set by resolveInput() before each capture

/** The settings in effect for a mic: with a noise-removing virtual mic, suppression and auto gain are off unless the user turned them back on for it. Saved choices stay. */
export const effectiveVoice = (s: VoiceSettings = current, label = mic.label): VoiceSettings =>
  ncMicName(label) && s.virtualMicOverride !== label ? { ...s, noiseSuppression: 'off', autoGainControl: false } : s

/** The mode in effect: Worklet-based suppression falls back to Standard when worklets/WASM cannot run or failed. */
export const noiseMode = (s: VoiceSettings = effectiveVoice()): NoiseMode => {
  if ((s.noiseSuppression === 'enhanced' || s.noiseSuppression === 'speex' || s.noiseSuppression === 'studio') && rnnoiseFailure()) {
    return 'standard'
  }
  return s.noiseSuppression
}

/** getUserMedia audio constraints for the mic and processing in effect. Voice isolation stays off: on Windows it hands audio to driver effects that can distort interface/XLR mics. */
export const captureConstraints = (s: VoiceSettings = current, m: Pick<MicChoice, 'id' | 'label'> = mic, hifi = false) => {
  if (hifi) {
    return {
      deviceId: m.id ? { exact: m.id } : { ideal: 'default' },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      voiceIsolation: false,
    }
  }
  const e = effectiveVoice(s, m.label)
  return {
    // exact: a mere preference silently captures another mic (bypassing a virtual one) when the id went stale
    deviceId: m.id ? { exact: m.id } : { ideal: 'default' },
    echoCancellation: s.echoCancellation,
    noiseSuppression: noiseMode(e) === 'standard', // off for worklet engines (Speex/RNNoise/GTCRN)
    autoGainControl: e.autoGainControl,
    voiceIsolation: false,
  }
}

/** Finds the saved mic in an enumerateDevices() list: by id, else by its saved label (ids change after driver updates or clearing site data). Gone: the default device. */
export function findInput(s: VoiceSettings, devices: MediaDeviceInfo[]): MicChoice {
  const mics = devices.filter((d) => d.kind === 'audioinput')
  const def = { id: '', label: (mics.find((d) => d.deviceId === 'default') ?? mics[0])?.label ?? '', lost: false }
  if (!s.input) return def
  // without mic permission the list hides ids and labels: nothing to check here, `exact` decides
  if (!mics.some((d) => d.deviceId)) return { id: s.input, label: s.inputLabel, lost: false }
  const hit = mics.find((d) => d.deviceId === s.input) ?? mics.find((d) => s.inputLabel && d.label === s.inputLabel)
  return hit ? { id: hit.deviceId, label: hit.label, lost: false } : { ...def, lost: true }
}

/** Set by engine.ts: tells the user that the saved mic is gone and the default one is used. */
export const micHooks = { lost: (_label: string) => {} }

/**
 * Runs a mic capture (it must use captureConstraints()) with the saved mic resolved first; a mic found again by label gets its
 * new id saved. A mic that is gone, or that `exact` refuses (OverconstrainedError), falls back to the default one: joining voice never fails on it.
 */
export async function withMic<T>(capture: () => Promise<T>): Promise<T> {
  mic = findInput(current, (await navigator.mediaDevices?.enumerateDevices().catch(() => [])) ?? [])
  // a new id after a re-find, or the label for choices saved before labels were kept
  if (mic.id && (mic.id !== current.input || mic.label !== current.inputLabel)) saveVoiceSettings({ input: mic.id, inputLabel: mic.label })
  if (mic.lost) micHooks.lost(current.inputLabel)
  try {
    return await capture()
  } catch (e) {
    if (!mic.id || !(e instanceof Error && /Overconstrained|NotFound/.test(e.name))) throw e
    mic = { id: '', label: '', lost: true }
    micHooks.lost(current.inputLabel)
    return capture()
  }
}

/** Whether this browser can encode a video codec ('av1', 'h264', 'vp8', 'vp9'). */
export const canEncode = (codec: string) => !!globalThis.RTCRtpSender?.getCapabilities?.('video')?.codecs.some((c) => c.mimeType.toLowerCase() === `video/${codec}`)
/** The desktop app (1.2.0+) says so when its GPU encoding switches are on. */
export const desktopHwEncode = () => (window as { cillcordDesktop?: { hwEncode?: unknown } }).cillcordDesktop?.hwEncode === true

/**
 * AV1 screen shares are sent as simulcast with one layer per stream and no temporal layers: Chromium's Windows GPU AV1
 * encoders do L1T1 only (temporal layers only on Intel), and SVC (L3T3_KEY) would make Chromium fall back to software.
 */
export const AV1_MODE: 'L1T1' = 'L1T1'
/** Whether this device encodes AV1 in hardware for this share (mediaCapabilities' powerEfficient; software libaom says false). */
export async function av1PowerEfficient(q: StreamQuality): Promise<boolean> {
  const { width, height } = RESOLUTIONS[q.resolution]
  const video = { contentType: 'video/AV1', width, height, bitrate: streamBitrate(q), framerate: q.fps, scalabilityMode: AV1_MODE }
  const info = await navigator.mediaCapabilities?.encodingInfo({ type: 'webrtc', video }).catch(() => null)
  return !!info?.supported && info.powerEfficient
}

export type VideoCodecName = 'av1' | 'h264' | 'vp9' | 'vp8'
/**
 * Screen share codecs, best first, only those this browser can encode. Auto: AV1 when the GPU encodes it for this share,
 * then H.264, VP9, VP8. AV1 chosen: AV1 (software if need be), then H.264 and VP8 for viewers who cannot decode it.
 * Another choice falls back to VP8.
 */
export async function screenCodecs(q: StreamQuality, s: VoiceSettings = current): Promise<VideoCodecName[]> {
  const order: VideoCodecName[] = s.screenCodec === 'auto' ? ['h264', 'vp9', 'vp8'] : s.screenCodec === 'av1' ? ['av1', 'h264', 'vp8'] : [s.screenCodec, 'vp8']
  if (s.screenCodec === 'auto' && (await av1PowerEfficient(q))) order.unshift('av1')
  const ok = [...new Set(order)].filter((c) => canEncode(c))
  return ok.length ? ok : ['vp8']
}

/** "Backquote" -> "`", "KeyV" -> "V", "Space" -> "Space". */
export const keyLabel = (code: string) =>
  code === 'Backquote' ? '`' : code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^(Left|Right)$/, '$1 Arrow')

if (import.meta.env.DEV) {
  const dev = (deviceId: string, label: string) => ({ kind: 'audioinput', deviceId, label, groupId: '' }) as MediaDeviceInfo
  const list = [dev('default', 'Default - Microphone (NVIDIA Broadcast)'), dev('a2', 'Microphone (NVIDIA Broadcast)'), dev('b', 'Headset (USB)')]
  const s = { ...defaults, input: 'a1', inputLabel: 'Microphone (NVIDIA Broadcast)' }
  console.assert(JSON.stringify(findInput(s, list)) === '{"id":"a2","label":"Microphone (NVIDIA Broadcast)","lost":false}', 'findInput by label')
  console.assert(findInput({ ...s, inputLabel: 'Gone' }, list).lost && findInput({ ...s, inputLabel: 'Gone' }, list).id === '', 'findInput lost')
  console.assert(findInput(s, [dev('', '')]).id === 'a1', 'findInput without permission')
  console.assert(ncMicName('Krisp Microphone (Krisp Audio)') === 'Krisp' && !ncMicName('Headset (USB)'), 'ncMicName')
  const e = effectiveVoice(s, 'Microphone (NVIDIA Broadcast)')
  console.assert(e.noiseSuppression === 'off' && !e.autoGainControl && e.echoCancellation, 'effectiveVoice')
  console.assert(effectiveVoice({ ...s, virtualMicOverride: 'Microphone (NVIDIA Broadcast)' }, 'Microphone (NVIDIA Broadcast)').autoGainControl, 'override')
  const c = captureConstraints(s, { id: 'a2', label: 'Microphone (NVIDIA Broadcast)' })
  console.assert(JSON.stringify(c.deviceId) === '{"exact":"a2"}' && !c.noiseSuppression && !c.autoGainControl, 'captureConstraints', c)
}
