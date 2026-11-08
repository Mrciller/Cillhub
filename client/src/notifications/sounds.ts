// Notification and call sounds generated with the Web Audio API (no sound files). One shared AudioContext, resumed on demand.
import { playKind } from '../custom/sounds'
let ctx: AudioContext | null = null
const audio = () => {
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  return ctx
}

/** A soft sine "blip" with a quick attack and exponential release. */
function tone(freq: number, start: number, length: number, volume = 0.18, type: OscillatorType = 'sine') {
  const a = audio()
  const t = a.currentTime + start
  const osc = a.createOscillator()
  const gain = a.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, t)
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + length)
  osc.connect(gain).connect(a.destination)
  osc.start(t)
  osc.stop(t + length + 0.05)
}

export const soundsEnabled = () => localStorage.getItem('notif-sounds') !== '0'

/** New message (v6: the sound chosen for messages, mentions or DMs in User Settings → Sounds). */
export function playMessage(kind: 'message' | 'mention' | 'dm' = 'message') {
  if (soundsEnabled()) playKind(kind)
}

let ringTimer = 0
/** Incoming call: a repeating three-note chime until stopped. Outgoing ("calling"): a slower two-note pulse. */
export function startRing(kind: 'incoming' | 'outgoing') {
  stopRing()
  const play = () => {
    try {
      if (kind === 'incoming') void (soundsEnabled() && playKind('ring'))
      else (tone(440, 0, 0.6, 0.08), tone(554.4, 0, 0.6, 0.06))
    } catch { /* no audio output */ }
  }
  play()
  ringTimer = window.setInterval(play, kind === 'incoming' ? 2000 : 3000)
}
export function stopRing() {
  clearInterval(ringTimer)
  ringTimer = 0
}
