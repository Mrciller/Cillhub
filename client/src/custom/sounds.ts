// Sound settings (CONTRACT-v6 section 1): built-in sets generated with Web Audio, own uploads (≤ 5 s, ≤ 256 KB, OGG/MP3),
// per-sound volume, mute all. notifications/sounds.ts plays through `playKind`.
import { api, cdn } from '../api'
import { t } from '../i18n'
import { getState, type State } from '../store'
import type { SoundKind, SoundSettings, UserSound } from '../types'

type Note = [freq: number, start: number, length: number, volume?: number, type?: OscillatorType]
export const KINDS: [SoundKind, string][] = [
  ['message', 'Message'], ['mention', 'Mention'], ['dm', 'Direct message'], ['ring', 'Incoming call'], ['join', 'Voice join'], ['leave', 'Voice leave'], ['mute', 'Mute / unmute'], ['deafen', 'Deafen / undeafen'],
]
/** Built-in sets: the original Cillhub tones, a square-wave arcade set, a soft set and a HUD set with quick sweeps. */
export const SETS: Record<string, { name: string; notes: Record<SoundKind, Note[]> }> = {
  cillcord: { name: 'Cillhub', notes: {
    message: [[880, 0, 0.12], [1318.5, 0.09, 0.18]], mention: [[988, 0, 0.1], [1318.5, 0.08, 0.1], [1760, 0.16, 0.2]], dm: [[740, 0, 0.12], [1108.7, 0.1, 0.2]],
    ring: [[659.3, 0, 0.25, 0.2, 'triangle'], [784, 0.22, 0.25, 0.2, 'triangle'], [987.8, 0.44, 0.45, 0.2, 'triangle']],
    join: [[523.3, 0, 0.12], [784, 0.1, 0.2]], leave: [[784, 0, 0.12], [523.3, 0.1, 0.2]], mute: [[660, 0, 0.08], [440, 0.07, 0.12]], deafen: [[520, 0, 0.1], [330, 0.08, 0.16]],
  } },
  arcade: { name: 'Arcade', notes: {
    message: [[1046.5, 0, 0.06, 0.08, 'square'], [1568, 0.06, 0.1, 0.08, 'square']], mention: [[1568, 0, 0.06, 0.08, 'square'], [2093, 0.06, 0.06, 0.08, 'square'], [2637, 0.12, 0.12, 0.08, 'square']],
    dm: [[880, 0, 0.08, 0.08, 'square'], [1318.5, 0.08, 0.12, 0.08, 'square']], ring: [[784, 0, 0.12, 0.1, 'square'], [988, 0.14, 0.12, 0.1, 'square'], [1175, 0.28, 0.2, 0.1, 'square']],
    join: [[392, 0, 0.06, 0.08, 'square'], [523.3, 0.06, 0.06, 0.08, 'square'], [784, 0.12, 0.12, 0.08, 'square']], leave: [[784, 0, 0.06, 0.08, 'square'], [523.3, 0.06, 0.06, 0.08, 'square'], [392, 0.12, 0.12, 0.08, 'square']],
    mute: [[880, 0, 0.05, 0.07, 'square'], [440, 0.05, 0.08, 0.07, 'square']], deafen: [[440, 0, 0.06, 0.07, 'square'], [220, 0.06, 0.12, 0.07, 'square']],
  } },
  soft: { name: 'Soft', notes: {
    message: [[523.3, 0, 0.3, 0.12]], mention: [[523.3, 0, 0.2, 0.12], [659.3, 0.15, 0.35, 0.12]], dm: [[587.3, 0, 0.3, 0.12], [698.5, 0.18, 0.3, 0.1]],
    ring: [[392, 0, 0.5, 0.14], [493.9, 0.4, 0.6, 0.14]], join: [[392, 0, 0.25, 0.1], [523.3, 0.15, 0.35, 0.1]], leave: [[523.3, 0, 0.25, 0.1], [392, 0.15, 0.35, 0.1]],
    mute: [[440, 0, 0.18, 0.1]], deafen: [[349.2, 0, 0.25, 0.1]],
  } },
  hud: { name: 'HUD', notes: {
    message: [[1200, 0, 0.05, 0.1, 'triangle'], [1800, 0.05, 0.08, 0.1, 'triangle']], mention: [[1800, 0, 0.05, 0.12, 'triangle'], [1800, 0.08, 0.05, 0.12, 'triangle'], [2400, 0.16, 0.1, 0.12, 'triangle']],
    dm: [[1500, 0, 0.06, 0.1, 'triangle'], [2000, 0.07, 0.1, 0.1, 'triangle']], ring: [[1000, 0, 0.1, 0.14, 'sawtooth'], [1500, 0.12, 0.1, 0.14, 'sawtooth'], [1000, 0.24, 0.1, 0.14, 'sawtooth']],
    join: [[600, 0, 0.06, 0.1, 'triangle'], [1200, 0.06, 0.1, 0.1, 'triangle']], leave: [[1200, 0, 0.06, 0.1, 'triangle'], [600, 0.06, 0.1, 0.1, 'triangle']],
    mute: [[900, 0, 0.05, 0.08, 'triangle'], [600, 0.05, 0.06, 0.08, 'triangle']], deafen: [[700, 0, 0.06, 0.08, 'triangle'], [350, 0.06, 0.1, 0.08, 'triangle']],
  } },
}
export const DEFAULT_SOUNDS: SoundSettings = { muted: false, volume: 100, events: {} }
export const conf = (s: State = getState()): SoundSettings => ({ ...DEFAULT_SOUNDS, ...s.settings.sound_settings })
/** An event's sound (server shape): a set id, 'user:<id>' or null = off; no entry = the Cillhub set. */
export const soundOf = (kind: SoundKind, s?: State) => {
  const e = conf(s).events?.[kind]
  return { sound: e ? e.sound : 'cillcord', volume: e?.volume ?? 100 }
}
/** The set most events use (the "Sound set" picker). */
export const currentSet = (s?: State) => KINDS.map(([k]) => soundOf(k, s).sound).find((x): x is string => !!x && !!SETS[x]) ?? 'cillcord'

let ctx: AudioContext | null = null
const audio = () => {
  ctx ??= new AudioContext()
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {})
  return ctx
}
function tone([freq, start, length, volume = 0.18, type = 'sine']: Note, gainScale: number) {
  const a = audio()
  const at = a.currentTime + start
  const osc = a.createOscillator()
  const gain = a.createGain()
  osc.type = type
  osc.frequency.setValueAtTime(freq, at)
  gain.gain.setValueAtTime(0.0001, at)
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, volume * gainScale), at + 0.015)
  gain.gain.exponentialRampToValueAtTime(0.0001, at + length)
  osc.connect(gain).connect(a.destination)
  osc.start(at)
  osc.stop(at + length + 0.05)
}
export const userSoundUrl = (id: string) => cdn(`/user-sounds/${id}`)

/** For tests and the settings page: the last sound played ({kind, source}). */
export const lastPlayed: { kind?: SoundKind; source?: string; at?: number } = {}
/** Plays one kind with the user's choice; `down` flips the notes (mute on, deafen on). False when nothing played. */
export function playKind(kind: SoundKind, down = false): boolean {
  const c = conf()
  const { sound, volume: own } = soundOf(kind)
  const volume = (own * (c.volume ?? 100)) / 100
  if (c.muted || !sound || volume <= 0) return false
  Object.assign(lastPlayed, { kind, source: sound, at: Date.now() })
  try {
    if (sound.startsWith('user:')) {
      const a = new Audio(userSoundUrl(sound.slice(5)))
      a.volume = Math.min(1, volume / 100)
      void a.play().catch(() => {})
      return true
    }
    const notes = (SETS[sound] ?? SETS.cillcord).notes[kind]
    const list = down ? notes.map((n, i) => [notes[notes.length - 1 - i][0], ...n.slice(1)] as Note) : notes
    list.forEach((n) => tone(n, volume / 100))
  } catch { /* no audio output */ }
  return true
}

// ---------- own uploaded sounds (GET/POST /users/@me/sounds, DELETE /users/@me/sounds/:id) ----------
export const MAX_SOUND_BYTES = 256 * 1024
export const MAX_SOUND_SECONDS = 5
let mine: UserSound[] | null = null
export const loadUserSounds = () => api<UserSound[]>('/users/@me/sounds').then((l) => (mine = Array.isArray(l) ? l : []), () => (mine = []))
export const userSounds = () => mine
/** Checks type, size and length in the browser before sending (the server checks again). */
export async function readSound(file: File): Promise<string> {
  if (!/^audio\/(ogg|mpeg|mp3)$/.test(file.type) && !/\.(ogg|mp3)$/i.test(file.name)) throw new Error(t('Use an OGG or MP3 file.'))
  if (file.size > MAX_SOUND_BYTES) throw new Error(t('Sounds must be 256 KB or smaller.'))
  const buf = await file.arrayBuffer()
  const decoded = await audio().decodeAudioData(buf.slice(0)).catch(() => null)
  if (!decoded) throw new Error(t('Could not read the sound.'))
  if (decoded.duration > MAX_SOUND_SECONDS + 0.05) throw new Error(t('Sounds must be 5 seconds or shorter.'))
  const type = file.type || (/\.mp3$/i.test(file.name) ? 'audio/mpeg' : 'audio/ogg')
  let bin = ''
  new Uint8Array(buf).forEach((b) => (bin += String.fromCharCode(b)))
  return `data:${type};base64,${btoa(bin)}`
}
export const uploadUserSound = (name: string, sound: string) =>
  api<UserSound>('/users/@me/sounds', { method: 'POST', body: { name, sound } }).then((x) => ((mine = [...(mine ?? []), x]), x))
export const deleteUserSound = (id: string) => api(`/users/@me/sounds/${id}`, { method: 'DELETE' }).then(() => void (mine = (mine ?? []).filter((x) => x.id !== id)))

/** user id -> when their entrance sound arrived; the server sends it just before their join, so it replaces the chime. */
export const entranceHeard = new Map<string, number>()
const chime = (userId: string) => Date.now() - (entranceHeard.get(userId) ?? 0) > 3000 && playKind('join')

/** Gateway hook (after the store applied the dispatch): voice join/leave sounds for our channel. */
export function soundEvent(type: string, d: any, before: State) {
  if (type !== 'VOICE_STATE_UPDATE') return
  const me = before.me?.id
  const mineNow = getState().voice.channelId
  const prev = before.voiceStates[d.guild_id ?? '@me']?.[d.user_id]?.channel_id ?? null
  if (d.user_id === me) {
    if (d.channel_id && d.channel_id !== prev && d.session_id === before.sessionId) chime(d.user_id)
    else if (!d.channel_id && prev) playKind('leave')
    return
  }
  if (!mineNow) return
  if (d.channel_id === mineNow && prev !== mineNow) chime(d.user_id)
  else if (prev === mineNow && d.channel_id !== mineNow) playKind('leave')
}
