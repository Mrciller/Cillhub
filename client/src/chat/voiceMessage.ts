// Voice message helpers: recording format and the client-side waveform (attachment.waveform, base64 of ≤256 bytes).

/** Opus in Ogg where supported (Firefox), else Opus in WebM (Chrome); CONTRACT-v3 accepts both. */
export const recordingType = () =>
  typeof MediaRecorder === 'undefined' ? null
  : ['audio/ogg;codecs=opus', 'audio/webm;codecs=opus'].find((t) => MediaRecorder.isTypeSupported(t)) ?? null

/** Peak amplitude per bucket (one per 100 ms, at most 256) scaled to 0..255, plus the decoded duration. */
export async function analyse(blob: Blob, fallbackSecs: number): Promise<{ duration: number; waveform: string }> {
  try {
    const ctx = new OfflineAudioContext(1, 1, 48000)
    const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
    const data = buf.getChannelData(0)
    return { duration: buf.duration, waveform: encodeWaveform(peaks(data, Math.max(1, Math.min(256, Math.round(buf.duration * 10))))) }
  } catch {
    return { duration: fallbackSecs, waveform: encodeWaveform(new Array(Math.max(1, Math.min(256, Math.round(fallbackSecs * 10)))).fill(64)) }
  }
}

export function peaks(data: Float32Array, buckets: number) {
  const size = Math.max(1, Math.floor(data.length / buckets))
  const out: number[] = []
  for (let b = 0; b < buckets; b++) {
    let peak = 0
    for (let i = b * size; i < Math.min(data.length, (b + 1) * size); i++) peak = Math.max(peak, Math.abs(data[i]))
    out.push(Math.min(255, Math.round(peak * 255)))
  }
  return out
}

export const encodeWaveform = (bytes: number[]) => btoa(String.fromCharCode(...bytes))
export function decodeWaveform(b64?: string): number[] {
  try {
    return b64 ? [...atob(b64)].map((c) => c.charCodeAt(0)) : []
  } catch {
    return []
  }
}

/** Resamples a waveform to `n` bars (max of each span), for drawing. */
export function bars(bytes: number[], n: number) {
  if (!bytes.length) return new Array(n).fill(0.15)
  return Array.from({ length: n }, (_, i) => {
    const from = Math.floor((i * bytes.length) / n)
    const to = Math.max(from + 1, Math.floor(((i + 1) * bytes.length) / n))
    return Math.max(0.08, Math.max(...bytes.slice(from, to)) / 255)
  })
}

if (import.meta.env.DEV) {
  console.assert(decodeWaveform(encodeWaveform([0, 128, 255])).join() === '0,128,255', 'waveform round trip')
  console.assert(peaks(new Float32Array([0, 1, -0.5, 0.25]), 2).join() === '255,128', 'peaks per bucket')
}
