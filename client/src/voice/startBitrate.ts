/**
 * The first screen share after joining a LiveKit call started at Chrome's default estimate of 300 kbit/s and climbed
 * ~8 %/s, reaching full quality only after 30 s (scripts/stream-quality.cjs, cold start). LiveKit answers audio without
 * transport-wide congestion control, so before the first video Chrome never sees a sent packet on the publisher
 * connection: its connect probes time out and it never counts as application-limited, and Chrome (M145) only probes a
 * new stream's bitrate while application-limited. livekit-client hints a start bitrate (`x-google-start-bitrate`) for
 * exactly this, but writes it into our offer, and Chrome takes send codec parameters from the answer only. This copies
 * the hint into LiveKit's answer, once per connection, as livekit-client intends (a later hint would restart a settled
 * estimate). cillvoice offers carry no hint, so its connection is untouched.
 */
const HINT = /x-google-start-bitrate=(\d+)/
/** livekit-client does not cap screen shares: 1440p60 or Source would seed 17-27 Mbit/s, above many home uplinks. */
const MAX_START_KBPS = 10_000

/** The answer with the offer's start bitrate on every video codec of every video section (same value everywhere: payload types are bundled), or null when there is nothing to copy. */
export function answerWithStartBitrate(offer: string, answer: string): string | null {
  const hint = HINT.exec(offer)?.[1]
  if (!hint || HINT.test(answer)) return null
  const kbps = Math.min(Number(hint), MAX_START_KBPS)
  return answer.split(/(?=^m=)/m).map((section) => {
    if (!section.startsWith('m=video')) return section
    return section.split(/\r?\n/)[0].trim().split(' ').slice(3).reduce((s, pt) => {
      const codec = new RegExp(`^a=rtpmap:${pt} ([^/\\r\\n]+)`, 'm').exec(s)?.[1].toLowerCase()
      if (!codec || /^(rtx|red|ulpfec|flexfec)/.test(codec)) return s
      const fmtp = new RegExp(`^a=fmtp:${pt} [^\\r\\n]*`, 'm')
      return fmtp.test(s)
        ? s.replace(fmtp, (line) => `${line};x-google-start-bitrate=${kbps}`)
        : s.replace(new RegExp(`^a=rtpmap:${pt} [^\\r\\n]*`, 'm'), (line) => `${line}\r\na=fmtp:${pt} x-google-start-bitrate=${kbps}`)
    }, section)
  }).join('')
}

const hinted = new WeakSet<RTCPeerConnection>()
let installed = false
/** Routes every peer connection's first hinted answer through answerWithStartBitrate(). Call before connecting. */
export function installStartBitrateHint() {
  const proto = globalThis.RTCPeerConnection?.prototype
  if (installed || !proto) return
  installed = true
  const set = proto.setRemoteDescription as (this: RTCPeerConnection, ...args: unknown[]) => Promise<void>
  proto.setRemoteDescription = function (this: RTCPeerConnection, d?: RTCSessionDescriptionInit, ...rest: unknown[]) {
    const offer = this.pendingLocalDescription?.sdp
    const sdp = d?.type === 'answer' && d.sdp && offer && !hinted.has(this) ? answerWithStartBitrate(offer, d.sdp) : null
    if (!sdp) return set.call(this, d, ...rest)
    hinted.add(this)
    // a browser that refuses the munged answer gets the original: a slow start beats a failed publish
    return set.call(this, { type: 'answer', sdp }, ...rest).catch(() => set.call(this, d, ...rest))
  } as typeof proto.setRemoteDescription
}

if (import.meta.env.DEV) {
  const offer = 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 103 104\r\na=fmtp:103 profile-level-id=42001f;x-google-start-bitrate=6750\r\n'
  const answer = 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\na=rtpmap:111 opus/48000/2\r\na=fmtp:111 minptime=10\r\n'
    + 'm=video 9 UDP/TLS/RTP/SAVPF 96 109 114 45\r\na=rtpmap:96 VP8/90000\r\na=rtpmap:109 H264/90000\r\na=fmtp:109 profile-level-id=42e01f\r\na=rtpmap:114 rtx/90000\r\na=fmtp:114 apt=109\r\n'
    + 'a=rtpmap:45 AV1/90000\r\na=fmtp:45 level-idx=5;profile=0;tier=0\r\n'
  const out = answerWithStartBitrate(offer, answer) ?? ''
  console.assert(out.includes('a=rtpmap:96 VP8/90000\r\na=fmtp:96 x-google-start-bitrate=6750\r\n') && out.includes('a=fmtp:109 profile-level-id=42e01f;x-google-start-bitrate=6750\r\n')
    && out.includes('a=fmtp:114 apt=109\r\n') && out.includes('a=fmtp:111 minptime=10\r\n') && out.includes('a=fmtp:45 level-idx=5;profile=0;tier=0;x-google-start-bitrate=6750\r\n'), 'answerWithStartBitrate', out)
  console.assert(answerWithStartBitrate(offer.replace('6750', '20000'), answer)?.includes('start-bitrate=10000') && answerWithStartBitrate('v=0\r\n', answer) === null && answerWithStartBitrate(offer, out) === null, 'answerWithStartBitrate cap/none/once')
}
