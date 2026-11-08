// Enhanced noise suppression (CONTRACT-v5 section 2, CONTRACT-v11): RNNoise, GTCRN, SpeexDSP, and Noise Gate run in AudioWorklets.
// Package: @sapphi-red/web-noise-suppressor (MIT; bundles shiguredo/rnnoise-wasm, Apache-2.0, and xiph/rnnoise, BSD-3-Clause).
// The library is imported lazily: its node class extends AudioWorkletNode, which would throw at load where that is missing.
import wasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import simdUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'
import workletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import gtcrnWasmUrl from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url'
import gtcrnWorkletUrl from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url'
import speexWasmUrl from '@sapphi-red/web-noise-suppressor/speex.wasm?url'
import speexWorkletUrl from '@sapphi-red/web-noise-suppressor/speexWorklet.js?url'
import noiseGateWorkletUrl from '@sapphi-red/web-noise-suppressor/noiseGateWorklet.js?url'
import { t } from '../i18n'

/** RNNoise and GTCRN work on 48 kHz frames; chains that use them run in a context at this rate. */
export const RNNOISE_RATE = 48000

export const rnnoiseSupported = () =>
  typeof AudioWorkletNode === 'function' && typeof WebAssembly === 'object' && typeof AudioContext === 'function' && 'audioWorklet' in AudioContext.prototype

let failure = ''
/** Why Worklet noise suppression is not in use right now ('' when it works or was never tried); the effective mode is then Standard. */
export const rnnoiseFailure = () => failure || (rnnoiseSupported() ? '' : t('This browser has no AudioWorklet or WebAssembly.'))
export const markRnnoiseFailed = (e: unknown) => void (failure = e instanceof Error && e.message ? e.message : String(e))

let wasm: Promise<ArrayBuffer> | null = null
const loaded = new WeakSet<BaseAudioContext>()

/** An RNNoise node for a 48 kHz context; loads the WASM (once) and the worklet module (once per context). */
export async function createRnnoiseNode(ctx: AudioContext): Promise<AudioWorkletNode & { destroy(): void }> {
  if (!rnnoiseSupported()) throw new Error(rnnoiseFailure())
  if (ctx.sampleRate !== RNNOISE_RATE) throw new Error(t('RNNoise needs 48 kHz audio.'))
  const lib = await import('@sapphi-red/web-noise-suppressor')
  wasm ??= lib.loadRnnoise({ url: wasmUrl, simdUrl }).catch((e: unknown) => ((wasm = null), Promise.reject(e)))
  const wasmBinary = await wasm
  if (!loaded.has(ctx)) (await ctx.audioWorklet.addModule(workletUrl), loaded.add(ctx))
  failure = ''
  return new lib.RnnoiseWorkletNode(ctx, { maxChannels: 1, wasmBinary })
}

let gtcrnWasm: Promise<ArrayBuffer> | null = null
const gtcrnLoaded = new WeakSet<BaseAudioContext>()

/** A GTCRN node for deep neural speech enhancement; loads GTCRN WASM (once) and worklet module (once per context). */
export async function createGtcrnNode(ctx: AudioContext): Promise<AudioWorkletNode & { destroy(): void }> {
  if (!rnnoiseSupported()) throw new Error(rnnoiseFailure())
  const lib = await import('@sapphi-red/web-noise-suppressor')
  gtcrnWasm ??= lib.loadGtcrn({ url: gtcrnWasmUrl }).catch((e: unknown) => ((gtcrnWasm = null), Promise.reject(e)))
  const wasmBinary = await gtcrnWasm
  if (!gtcrnLoaded.has(ctx)) {
    await ctx.audioWorklet.addModule(gtcrnWorkletUrl)
    gtcrnLoaded.add(ctx)
  }
  failure = ''
  return new lib.GtcrnWorkletNode(ctx, { maxChannels: 1, wasmBinary })
}

let speexWasm: Promise<ArrayBuffer> | null = null
const speexLoaded = new WeakSet<BaseAudioContext>()

/** A SpeexDSP node for low-CPU spectral noise suppression. */
export async function createSpeexNode(ctx: AudioContext): Promise<AudioWorkletNode & { destroy(): void }> {
  if (!rnnoiseSupported()) throw new Error(rnnoiseFailure())
  const lib = await import('@sapphi-red/web-noise-suppressor')
  speexWasm ??= lib.loadSpeex({ url: speexWasmUrl }).catch((e: unknown) => ((speexWasm = null), Promise.reject(e)))
  const wasmBinary = await speexWasm
  if (!speexLoaded.has(ctx)) {
    await ctx.audioWorklet.addModule(speexWorkletUrl)
    speexLoaded.add(ctx)
  }
  failure = ''
  return new lib.SpeexWorkletNode(ctx, { maxChannels: 1, wasmBinary })
}

const noiseGateLoaded = new WeakSet<BaseAudioContext>()

/** A hysteresis Noise Gate worklet node with open/close thresholds and hold time. */
export async function createNoiseGateNode(
  ctx: AudioContext,
  opts: { openThreshold: number; closeThreshold: number; holdMs: number }
): Promise<AudioWorkletNode> {
  if (!rnnoiseSupported()) throw new Error(rnnoiseFailure())
  const lib = await import('@sapphi-red/web-noise-suppressor')
  if (!noiseGateLoaded.has(ctx)) {
    await ctx.audioWorklet.addModule(noiseGateWorkletUrl)
    noiseGateLoaded.add(ctx)
  }
  return new lib.NoiseGateWorkletNode(ctx, {
    maxChannels: 1,
    openThreshold: opts.openThreshold,
    closeThreshold: opts.closeThreshold,
    holdMs: opts.holdMs,
  })
}
