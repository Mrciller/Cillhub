// cillvoice: the voice engine for Cillhub's own media server (server/README.md "cillvoice"), used when
// VOICE_SERVER_UPDATE says endpoint "cillvoice". One RTCPeerConnection; this side always offers (its send
// transceivers plus one receive transceiver per remote track) over gateway op 50 and gets CILLVOICE_ANSWER back.
// Remote audio plays through Web Audio (a gain node per track, like livekit-client's webAudioMix) so per-user volume
// and deafen work above 100 %. engine.ts calls in here for every action while a cillvoice session is active.
import { sendOp } from '../gateway'
import { getState, setVoice } from '../store'
import { t } from '../i18n'
import { markRnnoiseFailed, rnnoiseFailure } from '../rnnoise/rnnoise'
import { GainProcessor } from './gain'
import { withMic } from './settings'
import { applyVirtualBackground } from './videoBackground'
import { AV1_MODE, SCREEN_DEGRADATION, captureConstraints, noiseMode, RESOLUTIONS, screenCodecs, streamBitrate, voiceSettings, type StreamQuality, type VoiceSettings } from './settings'

type Source = 'microphone' | 'camera' | 'screen_share' | 'screen_share_audio'
const SOURCES_VIDEO = new Set<Source>(['camera', 'screen_share'])
type Remote = { id: string; user_id: string; kind: 'audio' | 'video'; source: Source }
type Answer = { sdp: string; subscribed: { mid: string; track_id: string }[]; tracks: Remote[] }
type Output = { el: HTMLAudioElement; src: MediaStreamAudioSourceNode; gain: GainNode; panner?: StereoPannerNode; remote: Remote }
/** What the participant grid needs from a video track (livekit-client's Track has the same two methods). */
export type VideoTrackLike = { attach(el: HTMLMediaElement): unknown; detach(el: HTMLMediaElement): unknown }
export type CvTile = { userId: string; source: 'camera' | 'screen'; track: VideoTrackLike }

/** Hooks into engine.ts, set once by it (avoids an import cycle). */
export const hooks = { onConnected: () => {}, onReconnecting: () => {}, onLost: () => {}, onScreenEnded: () => {}, bump: () => {}, audioBox: (): HTMLElement => document.body }

// Every layer names its scale: without scaleResolutionDownBy Chrome applies its own simulcast table, which caps the full
// layer's target at 4 Mbit/s for 1080p and up whatever maxBitrate says (stream-quality.cjs)
const CAMERA_LAYERS: RTCRtpEncodingParameters[] = [
  { rid: 'q', scaleResolutionDownBy: 4, maxBitrate: 150_000 },
  { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: 450_000 },
  { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: 1_700_000 },
]
// two screen layers: the full one as chosen in the Stream Quality dialog and a half-size one at a quarter of the rate.
// AV1 names its scalability mode on every layer: without it Chromium reads several AV1 encodings as SVC, not simulcast.
const screenLayers = (q: StreamQuality, av1 = false): RTCRtpEncodingParameters[] => [
  { rid: 'h', scaleResolutionDownBy: 2, maxBitrate: Math.round(streamBitrate(q) / 4), maxFramerate: Math.min(q.fps, 15) },
  { rid: 'f', scaleResolutionDownBy: 1, maxBitrate: streamBitrate(q), maxFramerate: q.fps },
].map((e) => (av1 ? { ...e, scalabilityMode: AV1_MODE } : e))

/**
 * Puts these codecs first in the transceiver's offer. The server answers in the offer's order (AV1, H.264 and VP8 only,
 * without the ones someone in the room cannot decode), and the browser sends the first codec of the answer.
 */
function preferCodecs(tr: RTCRtpTransceiver, codecs: string[]) {
  const all = RTCRtpReceiver.getCapabilities?.('video')?.codecs
  if (!all || !tr.setCodecPreferences) return
  const rank = (c: { mimeType: string }) => { const i = codecs.indexOf(c.mimeType.slice(6).toLowerCase()); return i < 0 ? codecs.length : i }
  tr.setCodecPreferences([...all].sort((a, b) => rank(a) - rank(b)))
}

const RID_URI = 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id'

/**
 * Chromium's ValidateRtpHeaderExtensionsForSpecSimulcast throws if an m= section negotiates simulcast
 * but lacks the RID extension. If createOffer() omitted it (e.g. after prior renegotiations with multiple streams),
 * inject it before setLocalDescription so screen sharing never fails.
 */
export function ensureRidExtension(sdp: string): string {
  if (!sdp.includes('a=simulcast') && !sdp.includes('a=rid:')) return sdp
  const existing = sdp.match(new RegExp(`a=extmap:(\\d+)(?:/\\w+)?\\s+${RID_URI}`))
  let ridId = existing ? existing[1] : null
  if (!ridId) {
    const used = new Set<number>()
    for (const m of sdp.matchAll(/a=extmap:(\d+)/g)) used.add(Number(m[1]))
    for (let i = 1; i <= 14; i++) {
      if (!used.has(i)) { ridId = String(i); break }
    }
    if (!ridId) ridId = '10'
  }

  const sections = sdp.split('\r\nm=')
  const patched = sections.map((sec, i) => {
    if (i === 0) return sec
    const isVideo = sec.startsWith('video ')
    const hasSimulcast = sec.includes('a=simulcast') || sec.includes('a=rid:')
    const hasRidExt = sec.includes(RID_URI)
    if (isVideo && hasSimulcast && !hasRidExt) {
      const lines = sec.split('\r\n')
      let insertAt = -1
      for (let j = lines.length - 1; j >= 0; j--) {
        if (lines[j].startsWith('a=extmap:') || lines[j].startsWith('a=mid:')) {
          insertAt = j + 1
          break
        }
      }
      if (insertAt < 0) insertAt = 1
      lines.splice(insertAt, 0, `a=extmap:${ridId} ${RID_URI}`)
      return lines.join('\r\n')
    }
    return sec
  })
  return patched.join('\r\nm=')
}

const wrapped = new WeakMap<MediaStreamTrack, VideoTrackLike>()
function videoLike(track: MediaStreamTrack): VideoTrackLike {
  let w = wrapped.get(track)
  if (!w) {
    const stream = new MediaStream([track])
    w = { attach: (el) => { if (el.srcObject !== stream) el.srcObject = stream }, detach: (el) => { if (el.srcObject === stream) el.srcObject = null } }
    wrapped.set(track, w)
  }
  return w
}

class Session {
  pc = new RTCPeerConnection({ bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' })
  // plays every remote voice; 'playback' buffers enough that a busy PC (a game running) does not crackle, as engine.ts does for LiveKit
  ctx = new AudioContext({ latencyHint: 'playback' })
  remote: Remote[] = []
  mapped = new Map<string, Remote>() // receive transceiver mid -> remote track
  outputs = new Map<string, Output>()
  pub: Partial<Record<Source, RTCRtpTransceiver>> = {}
  local: Partial<Record<Source, MediaStreamTrack>> = {} // captured tracks (the raw mic, before processing)
  proc: GainProcessor | null = null
  micOn = false
  busy = false
  again = false
  waiting: { resolve: (a: Answer) => void; reject: (e: Error) => void } | null = null
  closed = false

  constructor(readonly token: string) {
    // the microphone transceiver always exists, so there is something to connect even while muted or listening only
    this.pub.microphone = this.pc.addTransceiver('audio', { direction: 'sendonly' })
    this.pc.onconnectionstatechange = () => {
      if (this.closed) return
      const st = this.pc.connectionState
      if (st === 'connected') hooks.onConnected()
      else if (st === 'disconnected') hooks.onReconnecting() // ICE may recover by itself within seconds
      else if (st === 'failed') hooks.onLost()
    }
    void this.ctx.resume().catch(() => {})
    const sink = voiceSettings().output
    if (sink) void (this.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(sink).catch(() => {})
  }

  close() {
    this.closed = true
    this.waiting?.reject(new Error('closed'))
    for (const mid of [...this.outputs.keys()]) this.dropOutput(mid)
    for (const tr of Object.values(this.local)) tr?.stop()
    void this.proc?.destroy()
    this.pc.close()
    void this.ctx.close().catch(() => {})
  }

  isPub(tr: RTCRtpTransceiver) { return Object.values(this.pub).includes(tr) }

  /** One offer/answer round at a time; changes during a round trigger another. */
  async negotiate() {
    if (this.busy) return void (this.again = true)
    this.busy = true
    try {
      do {
        this.again = false
        const want = new Map(this.remote.map((r) => [r.id, r]))
        for (const [mid, r] of this.mapped) if (!want.has(r.id)) this.unmap(mid)
        const have = new Set([...this.mapped.values()].map((r) => r.id))
        const pending: [RTCRtpTransceiver, Remote][] = []
        for (const r of want.values()) {
          if (have.has(r.id)) continue
          const free = this.pc.getTransceivers().find((x) => x.mid && !this.mapped.has(x.mid) && !this.isPub(x) && x.direction === 'inactive' && x.receiver.track.kind === r.kind)
          const tr = free ?? this.pc.addTransceiver(r.kind, { direction: 'recvonly' })
          tr.direction = 'recvonly'
          pending.push([tr, r])
        }
        const rawOffer = await this.pc.createOffer()
        const offer = { type: rawOffer.type, sdp: ensureRidExtension(rawOffer.sdp ?? '') }
        await this.pc.setLocalDescription(offer)
        if (this.closed) return
        for (const [tr, r] of pending) this.mapped.set(tr.mid!, r)
        const publish = (Object.entries(this.pub) as [Source, RTCRtpTransceiver][])
          .filter(([, tr]) => tr.mid && tr.direction !== 'inactive').map(([source, tr]) => ({ mid: tr.mid, source }))
        const answered = new Promise<Answer>((resolve, reject) => (this.waiting = { resolve, reject }))
        const timer = setTimeout(() => this.waiting?.reject(new Error('the voice server did not answer')), 10000)
        sendOp(50, { token: this.token, sdp: offer.sdp, publish, subscribe: [...this.mapped].map(([mid, r]) => ({ mid, track_id: r.id })) })
        const a = await answered.finally(() => clearTimeout(timer))
        if (this.closed) return
        await this.pc.setRemoteDescription({ type: 'answer', sdp: this.munge(a.sdp) })
        const ok = new Set(a.subscribed.map((s) => s.mid))
        for (const mid of [...this.mapped.keys()]) if (!ok.has(mid)) this.unmap(mid)
        for (const [mid, r] of this.mapped) if (r.kind === 'audio') this.ensureOutput(mid, r)
        if (JSON.stringify(a.tracks) !== JSON.stringify(this.remote)) (this.remote = a.tracks), (this.again = true)
        hooks.bump()
      } while (this.again && !this.closed)
    } finally {
      this.busy = false
    }
  }

  unmap(mid: string) {
    this.mapped.delete(mid)
    this.dropOutput(mid)
    const tr = this.pc.getTransceivers().find((x) => x.mid === mid)
    if (tr && !this.isPub(tr)) tr.direction = 'inactive'
  }

  /** Opus DTX is the receiver's wish in SDP: add usedtx=1 to our microphone's section when the setting asks for it. */
  munge(sdp: string) {
    const mid = this.pub.microphone?.mid
    if (!voiceSettings().dtx || !mid) return sdp
    return sdp.split('\r\nm=').map((sec) => (sec.includes(`\r\na=mid:${mid}\r\n`) ? sec.replace(/(a=fmtp:\d+ minptime=10;useinbandfec=1)/, '$1;usedtx=1') : sec)).join('\r\nm=')
  }

  ensureOutput(mid: string, r: Remote) {
    if (this.outputs.has(mid)) return
    if (r.user_id === getState().me?.id) return
    const track = this.pc.getTransceivers().find((x) => x.mid === mid)?.receiver.track
    if (!track) return
    const stream = new MediaStream([track])
    // Chrome only feeds remote WebRTC audio into Web Audio while a media element plays it; that element stays muted
    const el = Object.assign(document.createElement('audio'), { autoplay: true, muted: true, srcObject: stream })
    hooks.audioBox().appendChild(el)
    const src = this.ctx.createMediaStreamSource(stream)
    const gain = this.ctx.createGain()
    gain.gain.value = 0
    let panner: StereoPannerNode | undefined
    if (typeof this.ctx.createStereoPanner === 'function') {
      panner = this.ctx.createStereoPanner()
      const hash = Array.from(r.user_id).reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0)
      const pan = Math.max(-0.85, Math.min(0.85, (hash % 100) / 100))
      panner.pan.value = voiceSettings().spatialAudio ? pan : 0
      src.connect(gain).connect(panner).connect(this.ctx.destination)
    } else {
      src.connect(gain).connect(this.ctx.destination)
    }
    this.outputs.set(mid, { el, src, gain, panner, remote: r })
    this.applyVolume(this.outputs.get(mid)!)
  }

  dropOutput(mid: string) {
    const o = this.outputs.get(mid)
    if (!o) return
    o.src.disconnect()
    o.gain.disconnect()
    o.panner?.disconnect()
    o.el.srcObject = null
    o.el.remove()
    this.outputs.delete(mid)
  }

  applyVolume(o: Output, deaf = isDeaf()) {
    const s = voiceSettings()
    let userVol = 1
    if (o.remote.source === 'screen_share_audio') {
      userVol = s.screenVolumes?.[o.remote.user_id] ?? s.volumes[`${o.remote.user_id}-screen`] ?? 1
    } else {
      userVol = s.volumes[o.remote.user_id] ?? 1
    }
    const vol = deaf ? 0 : Math.min(3, userVol * s.outputVolume)
    o.gain.gain.setTargetAtTime(vol, this.ctx.currentTime, 0.01)
    if (o.panner) {
      const hash = Array.from(o.remote.user_id).reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) | 0, 0)
      const pan = Math.max(-0.85, Math.min(0.85, (hash % 100) / 100))
      o.panner.pan.setTargetAtTime(s.spatialAudio ? pan : 0, this.ctx.currentTime, 0.02)
    }
  }

  // ---- microphone ----
  async micTrack() {
    if (!this.local.microphone || this.local.microphone.readyState === 'ended') {
      const chId = getState().voice.channelId
      const hifi = Boolean(chId && getState().channels[chId]?.quality_mode === 'hifi')
      const m = await withMic(() => navigator.mediaDevices.getUserMedia({ audio: captureConstraints(voiceSettings(), undefined, hifi) }))
      this.local.microphone = m.getAudioTracks()[0]
      await this.process()
    }
    return this.proc?.processedTrack ?? this.local.microphone!
  }

  /** Puts the gain/DSP chain between the raw mic and the sender when settings need it (as engine.ts does for LiveKit). */
  async process() {
    const raw = this.local.microphone
    if (!raw) return
    const s = voiceSettings()
    const chId = getState().voice.channelId
    const hifi = Boolean(chId && getState().channels[chId]?.quality_mode === 'hifi')
    const g = s.inputGain
    const mode = hifi ? 'off' : noiseMode(s)
    const denoise = mode === 'speex' || mode === 'enhanced' || mode === 'studio' ? mode : null
    const extras = hifi ? {} : { noiseGate: s.noiseGate, highPass: s.highPassFilter, compressor: s.voiceCompressor }
    const needsProcessing = g !== 1 || !!denoise || !!extras.noiseGate?.enabled || !!extras.highPass || !!extras.compressor

    try {
      if (!needsProcessing) {
        await this.proc?.destroy()
        this.proc = null
      } else if (this.proc && this.proc.matchesConfig(denoise, extras) && this.proc.processedTrack) {
        this.proc.setGain(g)
      } else {
        await this.proc?.destroy()
        const proc = new GainProcessor(g, denoise, extras)
        await proc.init({ kind: 'audio', track: raw, audioContext: this.ctx } as unknown as Parameters<GainProcessor['init']>[0])
        this.proc = proc
      }
    } catch (e) {
      this.proc = null
      if (!denoise) throw e
      markRnnoiseFailed(e)
      setVoice({ error: t('Noise suppression engine is unavailable ({reason}). Using Standard.', { reason: rnnoiseFailure() }) })
      await this.recapture()
      return
    }
    if (this.micOn) await this.pub.microphone!.sender.replaceTrack(this.proc?.processedTrack ?? raw)
  }

  async recapture() {
    this.local.microphone?.stop()
    this.local.microphone = undefined
    const track = await this.micTrack()
    if (this.micOn) await this.pub.microphone!.sender.replaceTrack(track)
  }

  async syncMic(on: boolean) {
    this.micOn = on
    const sender = this.pub.microphone!.sender
    if (!on) return void (await sender.replaceTrack(null))
    await sender.replaceTrack(await this.micTrack())
    await this.setAudioBitrate()
  }

  async setAudioBitrate() {
    const sender = this.pub.microphone!.sender
    const p = sender.getParameters()
    if (!p.encodings?.length) return
    p.encodings = p.encodings.map((e) => ({ ...e, maxBitrate: voiceSettings().bitrate }))
    await sender.setParameters(p)
  }

  // ---- camera and screen ----
  async publishVideo(source: 'camera' | 'screen_share', track: MediaStreamTrack, encodings: RTCRtpEncodingParameters[], codecs?: string[]) {
    let tr = this.pub[source]
    if (this.local[source] !== track) this.local[source]?.stop()
    if (tr) {
      await tr.sender.replaceTrack(track)
      tr.direction = 'sendonly'
    } else tr = this.pub[source] = this.pc.addTransceiver(track, { direction: 'sendonly', sendEncodings: encodings })
    if (codecs) preferCodecs(tr, codecs)
    this.local[source] = track
    await this.negotiate()
  }

  async unpublish(source: Source) {
    const tr = this.pub[source]
    this.local[source]?.stop()
    this.local[source] = undefined
    if (!tr) return
    if (SOURCES_VIDEO.has(source)) {
      // a video transceiver that went inactive comes back with only its first layer in getParameters(), so setParameters
      // (Stream Quality) no longer reaches the others: the next camera or screen share gets a fresh one (stream-quality.cjs)
      tr.stop()
      delete this.pub[source]
    } else {
      await tr.sender.replaceTrack(null)
      tr.direction = 'inactive'
    }
    await this.negotiate()
  }

  async setCamera(on: boolean) {
    if (!on) return this.unpublish('camera')
    const s = voiceSettings()
    const m = await navigator.mediaDevices.getUserMedia({ video: { deviceId: s.camera || undefined, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } } })
    const track = applyVirtualBackground(m.getVideoTracks()[0], s.virtualBackground)
    await this.publishVideo('camera', track, CAMERA_LAYERS)
  }

  async startScreen(q: StreamQuality, captureCardDeviceId?: string) {
    const { width, height } = RESOLUTIONS[q.resolution]
    const s = voiceSettings()
    const captureAudio = s.screenAudio !== false && s.screenAudioMode !== 'none'
    let m: MediaStream
    if (captureCardDeviceId) {
      m = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: captureCardDeviceId }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: q.fps } },
        audio: captureAudio ? { deviceId: captureCardDeviceId } : false,
      })
    } else {
      m = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: width }, height: { max: height }, frameRate: { max: q.fps } },
        audio: captureAudio ? { suppressLocalAudioPlayback: true } : false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: s.screenAudioMode === 'application' ? 'exclude' : 'include',
        preferCurrentTab: false,
      } as DisplayMediaStreamOptions & { selfBrowserSurface?: string; surfaceSwitching?: string; systemAudio?: string; preferCurrentTab?: boolean })
    }
    const video = m.getVideoTracks()[0]
    video.contentHint = q.mode
    video.addEventListener('ended', () => {
      if (this.local.screen_share === video) hooks.onScreenEnded()
    })
    const codecs = await screenCodecs(q)
    await this.publishVideo('screen_share', video, screenLayers(q, codecs[0] === 'av1'), codecs)
    await this.setStreamParams(q)
    const audio = m.getAudioTracks()[0]
    if (audio) {
      this.local.screen_share_audio = audio
      const tr = this.pub.screen_share_audio
      if (tr) (await tr.sender.replaceTrack(audio), (tr.direction = 'sendonly'))
      else this.pub.screen_share_audio = this.pc.addTransceiver(audio, { direction: 'sendonly' })
      await this.negotiate()
    }
  }

  async stopScreen() {
    if (this.local.screen_share_audio) await this.unpublish('screen_share_audio')
    await this.unpublish('screen_share')
  }

  async switchScreen(q: StreamQuality, captureCardDeviceId?: string) {
    const { width, height } = RESOLUTIONS[q.resolution]
    const s = voiceSettings()
    const captureAudio = s.screenAudio !== false && s.screenAudioMode !== 'none'
    let m: MediaStream
    if (captureCardDeviceId) {
      m = await navigator.mediaDevices.getUserMedia({
        video: { deviceId: { exact: captureCardDeviceId }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: q.fps } },
        audio: captureAudio ? { deviceId: captureCardDeviceId } : false,
      })
    } else {
      m = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { max: width }, height: { max: height }, frameRate: { max: q.fps } },
        audio: captureAudio ? { suppressLocalAudioPlayback: true } : false,
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: s.screenAudioMode === 'application' ? 'exclude' : 'include',
        preferCurrentTab: false,
      } as DisplayMediaStreamOptions & { selfBrowserSurface?: string; surfaceSwitching?: string; systemAudio?: string; preferCurrentTab?: boolean })
    }
    const video = m.getVideoTracks()[0]
    if (!video) return
    video.contentHint = q.mode
    video.addEventListener('ended', () => {
      if (this.local.screen_share === video) hooks.onScreenEnded()
    })
    const oldVideo = this.local.screen_share
    this.local.screen_share = video
    if (this.pub.screen_share) {
      await this.pub.screen_share.sender.replaceTrack(video)
      await this.setStreamParams(q)
    } else {
      const codecs = await screenCodecs(q)
      await this.publishVideo('screen_share', video, screenLayers(q, codecs[0] === 'av1'), codecs)
    }
    if (oldVideo) oldVideo.stop()

    const audio = m.getAudioTracks()[0]
    const oldAudio = this.local.screen_share_audio
    if (audio) {
      this.local.screen_share_audio = audio
      const tr = this.pub.screen_share_audio
      if (tr) {
        await tr.sender.replaceTrack(audio)
        tr.direction = 'sendonly'
      } else {
        this.pub.screen_share_audio = this.pc.addTransceiver(audio, { direction: 'sendonly' })
        await this.negotiate()
      }
    } else if (oldAudio) {
      await this.unpublish('screen_share_audio')
    }
    if (oldAudio && oldAudio !== audio) oldAudio.stop()
    hooks.bump()
  }

  /** Stream Quality while live: capture constraints, content hint and the layers' bitrate and frame rate. */
  async setStreamQuality(q: StreamQuality) {
    const track = this.local.screen_share
    if (!track) return
    const { width, height } = RESOLUTIONS[q.resolution]
    track.contentHint = q.mode
    await track.applyConstraints({ width: { max: width }, height: { max: height }, frameRate: { max: q.fps } })
    await this.setStreamParams(q)
  }

  async setStreamParams(q: StreamQuality) {
    const sender = this.pub.screen_share?.sender
    if (!sender) return
    const p = sender.getParameters()
    const want = screenLayers(q)
    p.encodings?.forEach((e, i) => Object.assign(e, { maxBitrate: want[i]?.maxBitrate ?? e.maxBitrate, maxFramerate: want[i]?.maxFramerate ?? q.fps }))
    p.degradationPreference = SCREEN_DEGRADATION
    await sender.setParameters(p)
  }

  tiles(myId: string): CvTile[] {
    const out: CvTile[] = []
    if (this.local.camera) out.push({ userId: myId, source: 'camera', track: videoLike(this.local.camera) })
    if (this.local.screen_share) out.push({ userId: myId, source: 'screen', track: videoLike(this.local.screen_share) })
    for (const [mid, r] of this.mapped) {
      if (r.kind !== 'video') continue
      const tr = this.pc.getTransceivers().find((x) => x.mid === mid)
      if (tr?.currentDirection === 'recvonly') out.push({ userId: r.user_id, source: r.source === 'screen_share' ? 'screen' : 'camera', track: videoLike(tr.receiver.track) })
    }
    return out
  }
}

let s: Session | null = null
const isDeaf = () => {
  const st = getState()
  const me = st.me && st.voiceStates[st.voice.guildId ?? '@me']?.[st.me.id]
  return st.voice.selfDeaf || !!me?.deaf
}
const fail = (e: unknown, what: string) => setVoice({ error: `${what}${e instanceof Error && e.message ? `: ${e.message}` : '.'}` })

export const active = () => !!s

/** Starts a session with the token from VOICE_SERVER_UPDATE. */
export function connect(token: string) {
  close()
  if (typeof RTCPeerConnection !== 'function') return void setVoice({ status: 'error', error: 'This browser cannot do voice (no WebRTC).' })
  const session = (s = new Session(token))
  setVoice({ status: 'connecting', error: '', speaking: {} })
  session.negotiate().catch((e) => s === session && setVoice({ status: 'error', error: `Could not connect to voice: ${e instanceof Error ? e.message : e}` }))
}

export function close() {
  s?.close()
  s = null
}

/** CILLVOICE_* dispatches. */
export function event(type: string, d: any) {
  if (!s) return
  if (type === 'CILLVOICE_ANSWER') { const w = s.waiting; s.waiting = null; w?.resolve(d) }
  else if (type === 'CILLVOICE_ERROR') { const w = s.waiting; s.waiting = null; w?.reject(new Error(d?.message ?? 'voice error')) }
  else if (type === 'CILLVOICE_TRACKS') { s.remote = d.tracks ?? []; void s.negotiate().catch((e) => fail(e, 'Voice negotiation failed')) }
  else if (type === 'CILLVOICE_SPEAKING') setVoice({ speaking: Object.fromEntries((d.speaking ?? []).map((id: string) => [id, true])) })
}

export const syncMic = async (on: boolean) => { await s?.syncMic(on) }
export function applyVolumes() {
  const deaf = isDeaf()
  s?.outputs.forEach((o) => s!.applyVolume(o, deaf))
}
export const setCamera = (on: boolean) => s?.setCamera(on) ?? Promise.resolve()
export const startScreen = (q: StreamQuality, captureCardDeviceId?: string) => s?.startScreen(q, captureCardDeviceId) ?? Promise.resolve()
export const stopScreen = () => s?.stopScreen() ?? Promise.resolve()
export const switchScreen = (q: StreamQuality, captureCardDeviceId?: string) => s?.switchScreen(q, captureCardDeviceId) ?? Promise.resolve()
export const setStreamQuality = (q: StreamQuality) => s?.setStreamQuality(q) ?? Promise.resolve()
export const syncGain = () => s?.process() ?? Promise.resolve()
export const tiles = (myId: string) => s?.tiles(myId) ?? []
/** Label of the captured microphone ('' when none). */
export const micLabel = () => s?.local.microphone?.label ?? ''

export async function setAudioProcessing(patch: Partial<Pick<VoiceSettings, 'noiseSuppression' | 'echoCancellation' | 'autoGainControl' | 'bitrate' | 'virtualMicOverride' | 'noiseGate' | 'highPassFilter' | 'voiceCompressor'>>) {
  if (!s?.local.microphone) return
  if ('noiseSuppression' in patch || 'echoCancellation' in patch || 'autoGainControl' in patch || 'virtualMicOverride' in patch || 'noiseGate' in patch || 'highPassFilter' in patch || 'voiceCompressor' in patch) await s.recapture()
  if ('bitrate' in patch) await s.setAudioBitrate()
}

export async function setDevice(kind: 'audioinput' | 'audiooutput' | 'videoinput') {
  if (!s) return
  if (kind === 'audioinput' && s.local.microphone) await s.recapture()
  if (kind === 'videoinput' && s.local.camera) await s.setCamera(true)
  if (kind === 'audiooutput') await (s.ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(voiceSettings().output)
}

/** Stats for the connection panel: our microphone sender's, or else a receiver's. */
export async function stats(): Promise<RTCStatsReport | undefined> {
  if (!s) return undefined
  const mic = s.pub.microphone?.sender
  if (mic?.track) return s.pc.getStats(mic.track)
  const rx = s.pc.getTransceivers().find((x) => x.mid && s!.mapped.get(x.mid)?.kind === 'audio')?.receiver.track
  return rx ? s.pc.getStats(rx) : s.pc.getStats()
}

/** getStats() of our screen share sender and of the first screen share we receive (encoder and decoder details). */
export async function screenStats(): Promise<{ send?: RTCStatsReport; recv?: RTCStatsReport }> {
  if (!s) return {}
  const tx = s.local.screen_share ? s.pub.screen_share?.sender : undefined
  const mid = [...s.mapped].find(([, r]) => r.source === 'screen_share')?.[0]
  const rx = mid === undefined ? undefined : s.pc.getTransceivers().find((x) => x.mid === mid)?.receiver
  const [send, recv] = await Promise.all([tx?.getStats(), rx?.getStats()])
  return { send, recv }
}
