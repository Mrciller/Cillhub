// Microphone processing as a LiveKit audio processor:
// mic -> [HighPass 80Hz] -> [NoiseGate] -> [Speex / RNNoise / GTCRN] -> [Compressor] -> gain -> limiter -> published track.
import type { AudioProcessorOptions, Track, TrackProcessor } from 'livekit-client'
import { createGtcrnNode, createNoiseGateNode, createRnnoiseNode, createSpeexNode, RNNOISE_RATE } from '../rnnoise/rnnoise'
import type { NoiseGateSettings } from './settings'

export type DenoiseEngine = 'speex' | 'enhanced' | 'studio' | null

export type ProcessingExtras = {
  noiseGate?: NoiseGateSettings | null
  highPass?: boolean
  compressor?: boolean
}

export class GainProcessor implements TrackProcessor<Track.Kind.Audio, AudioProcessorOptions> {
  name = 'cillcord-gain'
  processedTrack?: MediaStreamTrack
  private nodes: AudioNode[] = []
  private gainNode?: GainNode
  private own?: AudioContext
  private worklets: AudioNode[] = []
  readonly denoiseMode: DenoiseEngine

  constructor(
    private gain: number,
    readonly denoise: boolean | DenoiseEngine = false,
    readonly extras: ProcessingExtras = {}
  ) {
    this.denoiseMode = denoise === true ? 'enhanced' : (denoise || null)
  }

  matchesConfig(
    denoise: boolean | DenoiseEngine,
    extras: ProcessingExtras = {}
  ): boolean {
    const targetMode = denoise === true ? 'enhanced' : (denoise || null)
    if (this.denoiseMode !== targetMode) return false
    const gateEnabled = Boolean(this.extras.noiseGate?.enabled)
    const targetGateEnabled = Boolean(extras.noiseGate?.enabled)
    if (gateEnabled !== targetGateEnabled) return false
    if (gateEnabled && extras.noiseGate && this.extras.noiseGate) {
      if (
        this.extras.noiseGate.openThreshold !== extras.noiseGate.openThreshold ||
        this.extras.noiseGate.closeThreshold !== extras.noiseGate.closeThreshold ||
        this.extras.noiseGate.holdMs !== extras.noiseGate.holdMs
      ) return false
    }
    if (Boolean(this.extras.highPass) !== Boolean(extras.highPass)) return false
    if (Boolean(this.extras.compressor) !== Boolean(extras.compressor)) return false
    return true
  }

  async init({ track, audioContext }: AudioProcessorOptions) {
    // Worklet processors (GTCRN, RNNoise, Speex, NoiseGate) run best in a dedicated 48 kHz context.
    const needs48k = Boolean(this.denoiseMode || this.extras.noiseGate?.enabled)
    const ctx = needs48k ? (this.own = new AudioContext({ sampleRate: RNNOISE_RATE })) : audioContext
    try {
      const src = ctx.createMediaStreamSource(new MediaStream([track]))
      let lastNode: AudioNode = src
      this.nodes = [src]
      this.worklets = []

      // 1. High-Pass Filter: 80 Hz 12 dB/oct rumble cut (Butterworth Q = 0.707)
      if (this.extras.highPass) {
        const hp = ctx.createBiquadFilter()
        hp.type = 'highpass'
        hp.frequency.value = 80
        hp.Q.value = 0.707
        lastNode.connect(hp)
        lastNode = hp
        this.nodes.push(hp)
      }

      // 2. Hysteresis Noise Gate
      if (this.extras.noiseGate?.enabled) {
        const ng = await createNoiseGateNode(ctx as AudioContext, this.extras.noiseGate)
        lastNode.connect(ng)
        lastNode = ng
        this.nodes.push(ng)
        this.worklets.push(ng)
      }

      // 3. Worklet Noise Suppression Engine
      if (this.denoiseMode === 'speex') {
        const speex = await createSpeexNode(ctx as AudioContext)
        lastNode.connect(speex)
        lastNode = speex
        this.nodes.push(speex)
        this.worklets.push(speex)
      } else if (this.denoiseMode === 'enhanced') {
        const rnnoise = await createRnnoiseNode(ctx as AudioContext)
        lastNode.connect(rnnoise)
        lastNode = rnnoise
        this.nodes.push(rnnoise)
        this.worklets.push(rnnoise)
      } else if (this.denoiseMode === 'studio') {
        const gtcrn = await createGtcrnNode(ctx as AudioContext)
        lastNode.connect(gtcrn)
        lastNode = gtcrn
        this.nodes.push(gtcrn)
        this.worklets.push(gtcrn)
      }

      // 4. Dynamics Compressor: gentle broadcast leveling
      if (this.extras.compressor) {
        const comp = ctx.createDynamicsCompressor()
        comp.threshold.value = -24
        comp.knee.value = 12
        comp.ratio.value = 4
        comp.attack.value = 0.005
        comp.release.value = 0.1
        lastNode.connect(comp)
        lastNode = comp
        this.nodes.push(comp)
      }

      // 5. Gain Node
      const gain = ctx.createGain()
      gain.gain.value = this.gain
      lastNode.connect(gain)
      lastNode = gain
      this.gainNode = gain
      this.nodes.push(gain)

      // 6. Limiter Node: prevent distortion/clipping
      const limiter = limiterNode(ctx)
      lastNode.connect(limiter)
      lastNode = limiter
      this.nodes.push(limiter)

      // 7. MediaStreamDestination
      const dest = ctx.createMediaStreamDestination()
      lastNode.connect(dest)
      this.nodes.push(dest)
      this.processedTrack = dest.stream.getAudioTracks()[0]
    } catch (e) {
      await this.destroy()
      throw e
    }
  }

  async restart(opts: AudioProcessorOptions) {
    await this.destroy()
    await this.init(opts)
  }

  async destroy() {
    this.nodes.forEach((n) => {
      try { n.disconnect() } catch {}
    })
    this.nodes = []
    this.worklets.forEach((w) => {
      try {
        if ('destroy' in w && typeof (w as { destroy?: () => void }).destroy === 'function') {
          (w as { destroy: () => void }).destroy()
        }
      } catch {}
    })
    this.worklets = []
    this.gainNode = undefined
    this.processedTrack?.stop()
    this.processedTrack = undefined
    void this.own?.close().catch(() => {})
    this.own = undefined
  }

  setGain(v: number) {
    this.gain = v
    this.gainNode?.gain.setTargetAtTime(v, this.gainNode.context.currentTime, 0.02)
  }
}

/** Brick-wall-ish limiter so boosted peaks are squashed instead of clipping into crackle. */
export function limiterNode(ctx: BaseAudioContext) {
  const l = ctx.createDynamicsCompressor()
  l.threshold.value = -3
  l.knee.value = 0
  l.ratio.value = 20
  l.attack.value = 0.003
  l.release.value = 0.25
  return l
}
