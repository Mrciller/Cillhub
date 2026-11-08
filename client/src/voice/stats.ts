// Voice connection details from WebRTC getStats(): RTT, loss, jitter, bitrate, codec and the selected candidate pair.
import { useEffect, useState } from 'react'
import { screenStats, statsReport } from './engine'

export type VoiceStats = {
  rtt: number | null // ms
  loss: number | null // outbound audio packet loss, %
  jitter: number | null // ms
  bitrate: number | null // outbound audio, kbps
  codec: string | null
  route: string | null // "UDP host", "UDP srflx", "TCP host", "Relay (UDP)"…
}
export type Quality = 'good' | 'ok' | 'poor'
type StatsLike = { forEach: (fn: (s: Record<string, any>) => void) => void }
type Prev = { bytes: number; ts: number } | null

/** Pure parser over a getStats() report; `prev` is the previous outbound sample for the bitrate. */
export function parseStats(report: StatsLike, prev: Prev): { stats: VoiceStats; sample: Prev } {
  const all: Record<string, any>[] = []
  report.forEach((s) => void all.push(s))
  const byId = (id?: string) => all.find((s) => s.id === id)
  const out = all.find((s) => s.type === 'outbound-rtp' && (s.kind ?? s.mediaType) === 'audio')
  const remote = all.find((s) => s.type === 'remote-inbound-rtp' && (s.kind ?? s.mediaType) === 'audio')
  const inbound = all.find((s) => s.type === 'inbound-rtp' && (s.kind ?? s.mediaType) === 'audio')
  const transport = all.find((s) => s.type === 'transport')
  const pair = byId(transport?.selectedCandidatePairId) ?? all.find((s) => s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded')))
  const local = byId(pair?.localCandidateId)
  const codec = byId((out ?? inbound)?.codecId)
  const rttSec = pair?.currentRoundTripTime ?? remote?.roundTripTime
  const sample = out?.bytesSent != null ? { bytes: out.bytesSent, ts: out.timestamp } : null
  const bitrate = sample && prev && sample.ts > prev.ts ? ((sample.bytes - prev.bytes) * 8) / (sample.ts - prev.ts) : null // bytes/ms*8 = kbps
  const kind = local?.candidateType
  const proto = String(local?.relayProtocol ?? local?.protocol ?? '').toUpperCase()
  return {
    sample,
    stats: {
      rtt: rttSec != null ? Math.round(rttSec * 1000) : null,
      loss: remote?.fractionLost != null ? Math.round(remote.fractionLost * 1000) / 10 : null,
      jitter: (remote?.jitter ?? inbound?.jitter) != null ? Math.round((remote?.jitter ?? inbound?.jitter) * 1000) : null,
      bitrate: bitrate != null ? Math.round(bitrate) : null,
      codec: codec?.mimeType ? String(codec.mimeType).replace(/^audio\//i, '').toLowerCase() : null,
      route: !kind ? null : kind === 'relay' ? `Relay (${proto || 'UDP'})` : `${proto || 'UDP'} ${kind}`,
    },
  }
}

/** A screen share's video codec as sent (encoder) or received (decoder); `hw` is powerEfficientEncoder/Decoder. */
export type VideoCoding = { codec: string | null; impl: string | null; hw: boolean | null; width: number | null; height: number | null; fps: number | null }
const CODEC_NAMES: Record<string, string> = { h264: 'H.264', h265: 'H.265', vp8: 'VP8', vp9: 'VP9', av1: 'AV1' }

/** "libaom" for Chromium's "SimulcastEncoderAdapter (libaom, libaom)" (one encoder per simulcast layer). */
const implName = (v: unknown) => (v ? [...new Set(String(v).replace(/^SimulcastEncoderAdapter \((.*)\)$/, '$1').split(', '))].join(', ') : null)

/** Encoder (outbound-rtp) or decoder (inbound-rtp) details from a sender's or receiver's getStats(); with simulcast, the largest layer. */
export function parseVideo(report: StatsLike | undefined, dir: 'send' | 'recv'): VideoCoding | null {
  if (!report) return null
  const all: Record<string, any>[] = []
  report.forEach((s) => void all.push(s))
  const rtp = all.filter((s) => s.type === (dir === 'send' ? 'outbound-rtp' : 'inbound-rtp') && (s.kind ?? s.mediaType) === 'video')
    .sort((a, b) => (b.frameWidth ?? 0) - (a.frameWidth ?? 0))[0]
  if (!rtp) return null
  const mime = all.find((s) => s.id === rtp.codecId)?.mimeType
  const name = mime ? String(mime).replace(/^video\//i, '') : null
  return {
    codec: name && (CODEC_NAMES[name.toLowerCase()] ?? name),
    impl: implName(rtp[dir === 'send' ? 'encoderImplementation' : 'decoderImplementation']),
    hw: rtp[dir === 'send' ? 'powerEfficientEncoder' : 'powerEfficientDecoder'] ?? null,
    width: rtp.frameWidth ?? null,
    height: rtp.frameHeight ?? null,
    fps: rtp.framesPerSecond != null ? Math.round(rtp.framesPerSecond) : null,
  }
}

/** Screen share encoder and decoder every second while `on`. */
export function useScreenStats(on: boolean) {
  const [v, setV] = useState<{ send: VideoCoding | null; recv: VideoCoding | null }>({ send: null, recv: null })
  useEffect(() => {
    if (!on) return
    let alive = true
    const tick = async () => {
      const r = await screenStats().catch(() => ({}) as Awaited<ReturnType<typeof screenStats>>)
      if (alive) setV({ send: parseVideo(r.send, 'send'), recv: parseVideo(r.recv, 'recv') })
    }
    void tick()
    const t = setInterval(tick, 1000)
    return () => ((alive = false), clearInterval(t))
  }, [on])
  return v
}

/** Signal colour from RTT and loss. */
export function quality(s: VoiceStats | null): Quality | null {
  if (!s || s.rtt == null) return null
  const loss = s.loss ?? 0
  return s.rtt < 100 && loss < 2 ? 'good' : s.rtt < 250 && loss < 8 ? 'ok' : 'poor'
}

/** Polls the stats every second while mounted; keeps the last 60 RTT samples for the graph. */
export function useVoiceStats() {
  const [stats, setStats] = useState<VoiceStats | null>(null)
  const [history, setHistory] = useState<number[]>([])
  useEffect(() => {
    let prev: Prev = null
    let alive = true
    const tick = async () => {
      const report = await statsReport().catch(() => undefined)
      if (!alive) return
      if (!report) return setStats(null)
      const r = parseStats(report, prev)
      prev = r.sample
      setStats(r.stats)
      if (r.stats.rtt != null) setHistory((h) => [...h.slice(-59), r.stats.rtt!])
    }
    void tick()
    const t = setInterval(tick, 1000)
    return () => ((alive = false), clearInterval(t))
  }, [])
  return { stats, history }
}

if (import.meta.env.DEV) {
  const report = new Map<string, Record<string, unknown>>([
    ['o', { id: 'o', type: 'outbound-rtp', kind: 'audio', bytesSent: 12000, timestamp: 2000, codecId: 'c' }],
    ['c', { id: 'c', type: 'codec', mimeType: 'audio/opus' }],
    ['r', { id: 'r', type: 'remote-inbound-rtp', kind: 'audio', fractionLost: 0.025, jitter: 0.004, roundTripTime: 0.05 }],
    ['t', { id: 't', type: 'transport', selectedCandidatePairId: 'p' }],
    ['p', { id: 'p', type: 'candidate-pair', currentRoundTripTime: 0.042, localCandidateId: 'l' }],
    ['l', { id: 'l', type: 'local-candidate', candidateType: 'srflx', protocol: 'udp' }],
  ])
  const { stats } = parseStats(report, { bytes: 6000, ts: 1000 })
  console.assert(stats.rtt === 42 && stats.loss === 2.5 && stats.jitter === 4 && stats.bitrate === 48 && stats.codec === 'opus' && stats.route === 'UDP srflx', 'parseStats', stats)
  console.assert(quality(stats) === 'ok' && quality({ ...stats, loss: 0 }) === 'good', 'quality')
  const v = parseVideo(new Map<string, Record<string, unknown>>([
    ['q', { id: 'q', type: 'outbound-rtp', kind: 'video', frameWidth: 960, codecId: 'h', encoderImplementation: 'x', powerEfficientEncoder: false }],
    ['f', { id: 'f', type: 'outbound-rtp', kind: 'video', frameWidth: 1920, frameHeight: 1080, framesPerSecond: 29.6, codecId: 'h', encoderImplementation: 'MediaFoundationVideoEncodeAccelerator', powerEfficientEncoder: true }],
    ['h', { id: 'h', type: 'codec', mimeType: 'video/H264' }],
  ]), 'send')
  console.assert(implName('SimulcastEncoderAdapter (libaom, libaom)') === 'libaom' && implName('libaom') === 'libaom' && implName(undefined) === null, 'implName')
  console.assert(v?.codec === 'H.264' && v.hw === true && v.impl === 'MediaFoundationVideoEncodeAccelerator' && v.width === 1920 && v.fps === 30, 'parseVideo', v)
}
