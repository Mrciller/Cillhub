// Voice connection: gateway op 4 / VOICE_SERVER_UPDATE handling and the LiveKit room (CONTRACT-v2 section 10).
// livekit-client is imported lazily so it only loads once someone joins voice. When VOICE_SERVER_UPDATE names the
// endpoint "cillvoice", Cillhub's own media server is used instead: every action below then goes to ./cillvoice.
import type { LocalAudioTrack, LocalTrack, LocalTrackPublication, LocalVideoTrack, Participant, RemoteParticipant, Room, Track } from 'livekit-client'
import { api, apiOrigin, cdn } from '../api'
import { sendOp } from '../gateway'
import { P, has } from '../permissions'
import { canJoinVoice, permsOf } from '../selectors'
import { getState, idleVoice, setVoice, voiceKey } from '../store'
import { GainProcessor } from './gain'
import { t } from '../i18n'
import { markRnnoiseFailed, rnnoiseFailure } from '../rnnoise/rnnoise'
import { AV1_MODE, SCREEN_DEGRADATION, captureConstraints, noiseMode, RESOLUTIONS, saveVoiceSettings, screenCodecs, streamBitrate, voiceSettings, type StreamQuality, type VideoCodecName, type VoiceSettings } from './settings'
import { entranceHeard, playKind } from '../custom/sounds'
import * as cv from './cillvoice'
import { micHooks, withMic } from './settings'
import { installStartBitrateHint } from './startBitrate'
import { toast } from '../components/dialogs'

let lk: typeof import('livekit-client') | null = null
let room: Room | null = null
let last: { endpoint: string; token: string } | null = null
let pttDown = false
const audioBox = () => document.getElementById('voice-audio') ?? document.body.appendChild(Object.assign(document.createElement('div'), { id: 'voice-audio', hidden: true }))

export const myState = () => {
  const { me, voice, voiceStates } = getState()
  return me && voice.channelId ? voiceStates[voiceKey(voice.guildId)]?.[me.id] : undefined
}
const bump = () => setVoice({ tracks: getState().voice.tracks + 1 })

Object.assign(cv.hooks, {
  bump, audioBox,
  onConnected: () => (setVoice({ status: 'connected' }), void syncMic(), bump()),
  onReconnecting: () => setVoice({ status: 'connecting' }),
  onLost: () => setVoice({ status: 'error', error: 'Lost the voice connection.' }),
  // the browser's own "Stop sharing" button
  onScreenEnded: () => getState().voice.stream && (setVoice({ stream: false }), sendState(), void cv.stopScreen().then(bump)),
})
let lostWarned = ''
micHooks.lost = (name) => {
  if (lostWarned === voiceSettings().input) return // once per missing device, not on every recapture
  lostWarned = voiceSettings().input
  toast(name ? t('Microphone “{name}” not found. Using the default microphone.', { name }) : t('Your chosen microphone was not found. Using the default microphone.'))
}

function sendState() {
  const v = getState().voice
  if (!v.guildId && !v.channelId) return
  sendOp(4, { guild_id: v.guildId, channel_id: v.channelId, self_mute: v.selfMute || v.selfDeaf, self_deaf: v.selfDeaf, self_video: v.video, self_stream: v.stream })
}

let ringOnJoin: string | null = null
/** Joins a guild voice channel, or a DM / group DM call with `guildId` null (CONTRACT-v4); `ring` rings the others once we are in. */
export function joinVoice(guildId: string | null, channelId: string, opts: { ring?: boolean } = {}) {
  ringOnJoin = opts.ring ? channelId : null
  const v = getState().voice
  if (v.channelId === channelId && v.status !== 'error') return
  teardown() // the server moves our single voice state; the new room comes with VOICE_SERVER_UPDATE
  const s = voiceSettings()
  setVoice({ guildId, channelId, status: 'waiting', error: '', selfMute: s.selfMute, selfDeaf: s.selfDeaf, video: false, stream: false })
  sendState()
  waitForServer()
}

// The server ignores joins it does not allow (no CONNECT, channel full) without an error event.
let joinTimer = 0
function waitForServer() {
  clearTimeout(joinTimer)
  joinTimer = setTimeout(() => {
    if (getState().voice.status === 'waiting') setVoice({ status: 'error', error: "Couldn't join the voice channel." })
  }, 5000)
}

export function leaveVoice() {
  const v = getState().voice
  if (v.channelId) sendOp(4, { guild_id: v.guildId, channel_id: null, self_mute: v.selfMute, self_deaf: v.selfDeaf })
  teardown()
  setVoice({ ...idleVoice, selfMute: v.selfMute, selfDeaf: v.selfDeaf })
}

function teardown() {
  clearTimeout(joinTimer)
  const r = room
  room = null
  last = null
  r?.disconnect().catch(() => {})
  cv.close()
  document.getElementById('voice-audio')?.replaceChildren()
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel() } catch {}
  }
}

/** LiveKit endpoint as a ws(s) URL; accepts full URLs, bare hosts and root-relative paths. */
function wsUrl(endpoint: string) {
  if (/^wss?:\/\//.test(endpoint)) return endpoint
  if (/^https?:\/\//.test(endpoint)) return endpoint.replace(/^http/, 'ws')
  const base = new URL(apiOrigin())
  const scheme = base.protocol === 'https:' ? 'wss://' : 'ws://'
  return endpoint.startsWith('/') ? scheme + base.host + endpoint : scheme + endpoint
}

// Remote voices play through Web Audio (needed for volumes above 100 %). livekit-client's own context uses the smallest
// buffer ('interactive'), which runs dry and crackles like static on a busy PC (a game running); 'playback' buffers more
// (some tens of ms). One context for every call, as cillvoice.ts does with its own.
let playCtx: AudioContext | null = null
const playbackContext = () => (playCtx && playCtx.state !== 'closed' ? playCtx : (playCtx = new AudioContext({ latencyHint: 'playback' })))

/** The media server of the current call, for the connection details: "cillvoice" or "LiveKit". */
export const voiceBackend = () => (!last ? null : last.endpoint === 'cillvoice' ? 'cillvoice' : 'LiveKit')

async function connectRoom(endpoint: string, token: string) {
  teardown()
  last = { endpoint, token }
  if (endpoint === 'cillvoice') return cv.connect(token)
  setVoice({ status: 'connecting', error: '', speaking: {} })
  try {
    lk ??= await import('livekit-client')
  } catch {
    return setVoice({ status: 'error', error: 'Could not load the voice module.' })
  }
  const { Room, RoomEvent } = lk
  installStartBitrateHint()
  const s = voiceSettings()
  const chId = getState().voice.channelId
  const hifi = Boolean(chId && getState().channels[chId]?.quality_mode === 'hifi')
  const r = new Room({
    adaptiveStream: true, dynacast: true, webAudioMix: { audioContext: playbackContext() },
    audioCaptureDefaults: captureConstraints(s, undefined, hifi),
    publishDefaults: publishOptions(s),
    videoCaptureDefaults: { deviceId: s.camera || undefined },
    audioOutput: { deviceId: s.output || undefined },
  })
  room = r
  last = { endpoint, token }
  const live = () => room === r
  r.on(RoomEvent.ActiveSpeakersChanged, (speakers: Participant[]) => live() && setVoice({ speaking: Object.fromEntries(speakers.map((p) => [p.identity, true])) }))
    .on(RoomEvent.TrackSubscribed, (track: Track, _pub, p: RemoteParticipant) => {
      if (!live()) return
      if (track.kind === 'audio') audioBox().appendChild(track.attach())
      applyVolume(p)
      bump()
    })
    .on(RoomEvent.TrackUnsubscribed, (track: Track) => (track.detach().forEach((el) => el.remove()), bump()))
    .on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => (applyVolume(p), bump(), void dropAv1(r)))
    .on(RoomEvent.ParticipantAttributesChanged, () => void dropAv1(r))
    .on(RoomEvent.ParticipantDisconnected, bump)
    .on(RoomEvent.TrackMuted, bump)
    .on(RoomEvent.TrackUnmuted, bump)
    .on(RoomEvent.LocalTrackPublished, bump)
    .on(RoomEvent.LocalTrackUnpublished, (pub: LocalTrackPublication) => {
      // The browser's own "Stop sharing" button ends the screen share without going through us.
      const v = getState().voice
      if (pub.source === 'screen_share' && v.stream && !republishing) (setVoice({ stream: false }), sendState())
      bump()
    })
    .on(RoomEvent.Reconnecting, () => live() && setVoice({ status: 'connecting' }))
    .on(RoomEvent.Reconnected, () => live() && setVoice({ status: 'connected' }))
    .on(RoomEvent.Disconnected, () => live() && setVoice({ status: 'error', error: 'Lost the voice connection.' }))
    .on(RoomEvent.MediaDevicesError, (e: Error) => live() && setVoice({ error: `Device error: ${e.message}` }))
    // Stage: the server grants the microphone when we become a speaker; publish once the grant arrives.
    .on(RoomEvent.ParticipantPermissionsChanged, (_prev: unknown, p: Participant) => live() && p === r.localParticipant && void syncMic())
  try {
    await r.connect(wsUrl(endpoint), token)
  } catch (e) {
    if (live()) setVoice({ status: 'error', error: `Could not connect to voice${e instanceof Error && e.message ? `: ${e.message}` : '.'}` })
    return
  }
  if (!live()) return void r.disconnect()
  // Speakers announced while connect() was pending are already in activeSpeakers; resetting to {} would drop them.
  setVoice({ status: 'connected', speaking: Object.fromEntries(r.activeSpeakers.map((p) => [p.identity, true])) })
  r.remoteParticipants.forEach(applyVolume)
  if (!decodesAv1()) void r.localParticipant.setAttributes({ av1: '0' }).catch(() => {}) // needs canUpdateOwnMetadata (server 7.4+)
  await syncMic()
  bump()
}

/**
 * AV1 on LiveKit: LiveKit sends no AV1 to a browser it rules out (every Safari) or that cannot decode it, and the H.264
 * backup copy it should then ask for never reaches such a viewer (LiveKit 1.13.7 with livekit-client 2.23: the backup's
 * subscribed quality stays OFF, scripts/e2e-v5-voice.cjs 6c3). So viewers without AV1 say so in a participant attribute,
 * and a sharer leaves AV1 out while one of them is in the room, republishing a running AV1 share as H.264 when one joins.
 * shortcut: the share stays H.264 after they leave; the next share uses AV1 again.
 */
const decodesAv1 = () => lk?.getBrowser()?.name !== 'Safari' && !!globalThis.RTCRtpReceiver?.getCapabilities?.('video')?.codecs.some((c) => c.mimeType === 'video/AV1')
const av1Blocked = (r: Room) => [...r.remoteParticipants.values()].some((p) => p.attributes.av1 === '0')
let republishing = false
async function dropAv1(r: Room) {
  const track = r.localParticipant.getTrackPublication('screen_share' as Track.Source.ScreenShare)?.videoTrack
  if (!track || track.codec !== 'av1' || !av1Blocked(r) || republishing) return
  republishing = true
  try {
    const q = voiceSettings().stream
    const o = screenOptions(q, (await screenCodecs(q)).filter((c) => c !== 'av1'))
    await r.localParticipant.unpublishTrack(track, false)
    await r.localParticipant.publishTrack(track, { ...o.publish, source: 'screen_share' as Track.Source.ScreenShare })
  } catch (e) {
    setVoice({ error: `Couldn't share your screen${e instanceof Error ? `: ${e.message}` : '.'}` })
  } finally {
    republishing = false
    bump()
  }
}

/** Retries the LiveKit connection with the last token (valid for 6 h), or asks the gateway for a new one. */
export function retryVoice() {
  const v = getState().voice
  if (last) return void connectRoom(last.endpoint, last.token)
  if (v.channelId) (setVoice({ status: 'waiting', error: '' }), sendState(), waitForServer())
}

const deafened = () => getState().voice.selfDeaf || !!myState()?.deaf

function applyVolume(p: RemoteParticipant) {
  const s = voiceSettings()
  // Capped at 300 % overall to protect ears when user and output volume are both raised.
  const vol = deafened() ? 0 : Math.min(3, (s.volumes[p.identity] ?? 1) * s.outputVolume)
  const streamVol = deafened() ? 0 : Math.min(3, (s.screenVolumes?.[p.identity] ?? s.volumes[`${p.identity}-screen`] ?? 1) * s.outputVolume)
  p.setVolume(vol)
  p.setVolume(streamVol, 'screen_share_audio' as Track.Source.ScreenShareAudio)
}

/** Whether the microphone should be sending now. */
function micWanted() {
  const v = getState().voice
  const ch = v.channelId ? getState().channels[v.channelId] : undefined
  const st = myState()
  // Stage audience members (suppress) never publish; the server's grant enforces it too.
  const allowed = has(permsOf(getState(), v.guildId ?? undefined, ch), P.SPEAK) && !st?.mute && !st?.deaf && !st?.suppress
  return allowed && !v.selfMute && !v.selfDeaf && (voiceSettings().mode === 'vad' || pttDown)
}

/** Publishes or mutes the microphone to match self mute/deafen, server mute/deafen, SPEAK and push-to-talk. */
async function syncMic() {
  const r = room
  const v = getState().voice
  if (cv.active() && v.status === 'connected') {
    await cv.syncMic(micWanted()).catch((e) => setVoice({ error: `Couldn't use your microphone${e instanceof Error ? `: ${e.message}` : '.'}` }))
    return cv.applyVolumes()
  }
  if (!r || v.status !== 'connected') return
  const on = micWanted()
  const pub = r.localParticipant.getTrackPublication('microphone' as Track.Source.Microphone)
  try {
    const chId = getState().voice.channelId
    const hifi = Boolean(chId && getState().channels[chId]?.quality_mode === 'hifi')
    const set = () => r.localParticipant.setMicrophoneEnabled(on, captureConstraints(voiceSettings(), undefined, hifi), publishOptions())
    if (on && !pub) await withMic(set) // a new capture: resolve the saved device first
    else if (pub) await set()
    if (on) await syncGain()
  } catch (e) {
    setVoice({ error: `Couldn't use your microphone${e instanceof Error ? `: ${e.message}` : '.'}` })
  }
  r.remoteParticipants.forEach(applyVolume)
}

export function setSelfMute(mute: boolean) {
  const v = getState().voice
  // Unmuting while deafened undeafens too.
  const patch = { selfMute: mute, selfDeaf: mute ? v.selfDeaf : false }
  if (v.channelId) playKind(v.selfDeaf && !mute ? 'deafen' : 'mute', mute)
  saveVoiceSettings(patch)
  setVoice(patch)
  sendState()
  void syncMic()
}

// Deafening also mutes (the mute buttons show it); undeafening restores the mute state from before.
let mutedBeforeDeaf = false
export function setSelfDeaf(deaf: boolean) {
  const v = getState().voice
  if (deaf && !v.selfDeaf) mutedBeforeDeaf = v.selfMute
  const patch = { selfDeaf: deaf, selfMute: deaf || (v.selfDeaf ? mutedBeforeDeaf : v.selfMute) }
  if (v.channelId && deaf !== v.selfDeaf) playKind('deafen', deaf)
  saveVoiceSettings(patch)
  setVoice(patch)
  sendState()
  void syncMic()
}

export async function toggleCamera() {
  const r = room
  const v = getState().voice
  if (!r && !cv.active()) return
  try {
    if (cv.active()) await cv.setCamera(!v.video)
    else await r!.localParticipant.setCameraEnabled(!v.video, { deviceId: voiceSettings().camera || undefined })
    setVoice({ video: !v.video })
    sendState()
  } catch (e) {
    setVoice({ error: `Couldn't start your camera${e instanceof Error ? `: ${e.message}` : '.'}` })
  }
  bump()
}

export async function toggleScreen() {
  const r = room
  const v = getState().voice
  if (!r && !cv.active()) return
  try {
    if (cv.active()) await (v.stream ? cv.stopScreen() : cv.startScreen(voiceSettings().stream))
    else await r!.localParticipant.setScreenShareEnabled(!v.stream, { audio: true, selfBrowserSurface: 'exclude' })
    setVoice({ stream: !v.stream })
    sendState()
  } catch (e) {
    // Cancelling the browser's picker lands here too; that is not worth an error.
    if (!(e instanceof Error && e.name === 'NotAllowedError')) setVoice({ error: `Couldn't share your screen${e instanceof Error ? `: ${e.message}` : '.'}` })
  }
  bump()
}

// DTX off by default: with a constant noise floor (studio/XLR interfaces) its on/off gating sounds choppy and static.
const publishOptions = (s: VoiceSettings = voiceSettings()) => ({ audioPreset: { maxBitrate: s.bitrate }, dtx: s.dtx, red: true })

const micTrack = () => room?.localParticipant.getTrackPublication('microphone' as Track.Source.Microphone)?.track as LocalAudioTrack | undefined

/** Attaches, updates or removes the mic processor to match input volume and DSP chain. */
async function syncGain() {
  if (cv.active()) return cv.syncGain().catch((e) => setVoice({ error: `Couldn't apply the input volume${e instanceof Error ? `: ${e.message}` : '.'}` }))
  const track = micTrack()
  if (!track) return
  const s = voiceSettings()
  const chId = getState().voice.channelId
  const hifi = Boolean(chId && getState().channels[chId]?.quality_mode === 'hifi')
  const g = s.inputGain
  const mode = hifi ? 'off' : noiseMode(s)
  const denoise = mode === 'speex' || mode === 'enhanced' || mode === 'studio' ? mode : null
  const extras = hifi ? {} : { noiseGate: s.noiseGate, highPass: s.highPassFilter, compressor: s.voiceCompressor }
  const needsProcessing = g !== 1 || !!denoise || !!extras.noiseGate?.enabled || !!extras.highPass || !!extras.compressor

  const proc = track.getProcessor()
  try {
    if (!needsProcessing) {
      if (proc) await track.stopProcessor()
    } else if (proc instanceof GainProcessor && proc.matchesConfig(denoise, extras)) {
      proc.setGain(g)
    } else {
      await track.setProcessor(new GainProcessor(g, denoise, extras))
    }
  } catch (e) {
    if (!denoise) return setVoice({ error: `Couldn't apply the input volume${e instanceof Error ? `: ${e.message}` : '.'}` })
    markRnnoiseFailed(e)
    setVoice({ error: t('Noise suppression engine is unavailable ({reason}). Using Standard.', { reason: rnnoiseFailure() }) })
    await (track as unknown as { restartTrack: (c: MediaTrackConstraints) => Promise<void> }).restartTrack(captureConstraints(s, undefined, hifi)).catch(() => {})
    if (track.getProcessor()) await track.stopProcessor().catch(() => {})
    return syncGain()
  }
}

export async function setInputGain(v: number) {
  saveVoiceSettings({ inputGain: v })
  await syncGain()
}

export function setOutputVolume(v: number) {
  saveVoiceSettings({ outputVolume: v })
  room?.remoteParticipants.forEach(applyVolume)
  cv.applyVolumes()
}

const screenOptions = (q: StreamQuality, codecs: VideoCodecName[]) => {
  const s = voiceSettings()
  const captureAudio = s.screenAudio !== false && s.screenAudioMode !== 'none'
  return {
    capture: {
      audio: captureAudio ? ({ suppressLocalAudioPlayback: true } as any) : false,
      selfBrowserSurface: 'exclude' as const,
      surfaceSwitching: 'include' as const,
      systemAudio: s.screenAudioMode === 'application' ? ('exclude' as const) : ('include' as const),
      preferCurrentTab: false,
      resolution: { ...RESOLUTIONS[q.resolution], frameRate: q.fps },
      contentHint: q.mode,
    },
    publish: {
      screenShareEncoding: { maxBitrate: streamBitrate(q), maxFramerate: q.fps },
      degradationPreference: SCREEN_DEGRADATION,
      // AV1, H.264 (or VP9) when chosen and encodable. AV1 goes out as simulcast with one layer per stream (needs LiveKit
      // > 1.13.6), which also keeps our content hint: as SVC, livekit-client forces 'motion' on screen shares.
      videoCodec: codecs[0],
      ...(codecs[0] === 'av1' && { scalabilityMode: AV1_MODE }),
      // LiveKit asks us to add this copy when a viewer cannot decode the first codec (needs dynacast): H.264 behind AV1, else VP8
      backupCodec: { codec: codecs[0] === 'av1' && codecs.includes('h264') ? ('h264' as const) : ('vp8' as const) },
    },
  }
}

/** Starts screen sharing with the chosen quality (remembered for next time). */
export async function startScreenShare(q: StreamQuality, captureCardDeviceId?: string) {
  saveVoiceSettings({ stream: q })
  const r = room
  if ((!r && !cv.active()) || getState().voice.stream) return
  try {
    if (cv.active()) await cv.startScreen(q, captureCardDeviceId)
    else {
      const o = screenOptions(q, (await screenCodecs(q)).filter((c) => c !== 'av1' || !av1Blocked(r!)))
      if (captureCardDeviceId) {
        lk ??= await import('livekit-client')
        const { width, height } = RESOLUTIONS[q.resolution]
        const s = voiceSettings()
        const captureAudio = s.screenAudio !== false && s.screenAudioMode !== 'none'
        const m = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: captureCardDeviceId }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: q.fps } },
          audio: captureAudio ? { deviceId: captureCardDeviceId } : false,
        })
        const vTrack = m.getVideoTracks()[0]
        if (!vTrack) throw new Error('No video track found on capture card')
        vTrack.contentHint = q.mode
        const localVideo = new lk.LocalVideoTrack(vTrack, undefined, false)
        localVideo.source = 'screen_share' as Track.Source.ScreenShare
        await r!.localParticipant.publishTrack(localVideo, { ...o.publish, source: 'screen_share' as Track.Source.ScreenShare })
        const aTrack = m.getAudioTracks()[0]
        if (aTrack) {
          const localAudio = new lk.LocalAudioTrack(aTrack, undefined, false)
          localAudio.source = 'screen_share_audio' as Track.Source.ScreenShareAudio
          await r!.localParticipant.publishTrack(localAudio, { source: 'screen_share_audio' as Track.Source.ScreenShareAudio })
        }
      } else {
        await r!.localParticipant.setScreenShareEnabled(true, o.capture, o.publish)
      }
    }
    setVoice({ stream: true })
    sendState()
  } catch (e) {
    // Cancelling the browser's picker lands here too; that is not worth an error.
    if (!(e instanceof Error && e.name === 'NotAllowedError')) setVoice({ error: `Couldn't share your screen${e instanceof Error ? `: ${e.message}` : '.'}` })
  }
  bump()
}

/** Changes which window/screen is streamed while screen sharing is active. */
export async function switchScreenShare(q: StreamQuality = voiceSettings().stream, captureCardDeviceId?: string) {
  const r = room
  const v = getState().voice
  if ((!r && !cv.active()) || !v.stream) return
  try {
    if (cv.active()) {
      await cv.switchScreen(q, captureCardDeviceId)
    } else {
      const o = screenOptions(q, (await screenCodecs(q)).filter((c) => c !== 'av1' || !av1Blocked(r!)))
      let newTracks: LocalTrack[]
      if (captureCardDeviceId) {
        lk ??= await import('livekit-client')
        const { width, height } = RESOLUTIONS[q.resolution]
        const s = voiceSettings()
        const captureAudio = s.screenAudio !== false && s.screenAudioMode !== 'none'
        const m = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: captureCardDeviceId }, width: { ideal: width }, height: { ideal: height }, frameRate: { ideal: q.fps } },
          audio: captureAudio ? { deviceId: captureCardDeviceId } : false,
        })
        const vTrack = m.getVideoTracks()[0]
        if (!vTrack) throw new Error('No video track found on capture card')
        vTrack.contentHint = q.mode
        const localVideo = new lk.LocalVideoTrack(vTrack, undefined, false)
        localVideo.source = 'screen_share' as Track.Source.ScreenShare
        newTracks = [localVideo]
        const aTrack = m.getAudioTracks()[0]
        if (aTrack) {
          const localAudio = new lk.LocalAudioTrack(aTrack, undefined, false)
          localAudio.source = 'screen_share_audio' as Track.Source.ScreenShareAudio
          newTracks.push(localAudio)
        }
      } else {
        newTracks = await r!.localParticipant.createScreenTracks(o.capture)
      }
      const oldScreen = r!.localParticipant.getTrackPublication('screen_share' as Track.Source.ScreenShare)
      if (oldScreen?.track) await r!.localParticipant.unpublishTrack(oldScreen.track)
      const oldAudio = r!.localParticipant.getTrackPublication('screen_share_audio' as Track.Source.ScreenShareAudio)
      if (oldAudio?.track) await r!.localParticipant.unpublishTrack(oldAudio.track)
      for (const t of newTracks) {
        await r!.localParticipant.publishTrack(t, { ...o.publish, source: t.source })
      }
    }
    bump()
  } catch (e) {
    if (!(e instanceof Error && e.name === 'NotAllowedError')) {
      setVoice({ error: `Couldn't change screen share${e instanceof Error ? `: ${e.message}` : '.'}` })
    }
  }
}

/** Explicitly stops an active screen share. */
export async function stopScreenShare() {
  const r = room
  const v = getState().voice
  if ((!r && !cv.active()) || !v.stream) return
  try {
    if (cv.active()) await cv.stopScreen()
    else await r!.localParticipant.setScreenShareEnabled(false)
    setVoice({ stream: false })
    sendState()
  } catch (e) {
    if (!(e instanceof Error && e.name === 'NotAllowedError')) {
      setVoice({ error: `Couldn't stop screen share${e instanceof Error ? `: ${e.message}` : '.'}` })
    }
  }
  bump()
}

/** Changes the quality of a running screen share without restarting it. */
export async function setStreamQuality(q: StreamQuality) {
  saveVoiceSettings({ stream: q })
  if (cv.active()) return cv.setStreamQuality(q).catch((e) => setVoice({ error: `Couldn't change the stream quality${e instanceof Error ? `: ${e.message}` : '.'}` }))
  const track = room?.localParticipant.getTrackPublication('screen_share' as Track.Source.ScreenShare)?.track as LocalVideoTrack | undefined
  if (!track) return
  const { width, height } = RESOLUTIONS[q.resolution]
  try {
    track.mediaStreamTrack.contentHint = q.mode
    await track.mediaStreamTrack.applyConstraints({ width: { max: width }, height: { max: height }, frameRate: { max: q.fps } })
    if (track.sender) {
      const p = track.sender.getParameters()
      // Scale every simulcast layer by the same factor so the low-quality layer stays small.
      const top = Math.max(...(p.encodings ?? []).map((e) => e.maxBitrate ?? 0))
      const factor = top > 0 ? streamBitrate(q) / top : 1
      p.encodings?.forEach((e) => ((e.maxBitrate = Math.round((e.maxBitrate ?? streamBitrate(q)) * factor)), (e.maxFramerate = q.fps)))
      p.degradationPreference = SCREEN_DEGRADATION
      await track.sender.setParameters(p)
    }
  } catch (e) {
    setVoice({ error: `Couldn't change the stream quality${e instanceof Error ? `: ${e.message}` : '.'}` })
  }
}

type AudioPatch = Partial<Pick<VoiceSettings, 'noiseSuppression' | 'echoCancellation' | 'autoGainControl' | 'bitrate' | 'virtualMicOverride' | 'noiseGate' | 'highPassFilter' | 'voiceCompressor'>>
/**
 * Voice processing / quality settings, applied live to a published mic: capture changes restart the track with new
 * constraints, bitrate goes through the sender's encodings. DTX is negotiated per publication and applies on the next join.
 */
export async function setAudioProcessing(patch: AudioPatch) {
  saveVoiceSettings(patch)
  if (cv.active()) return cv.setAudioProcessing(patch).catch(() => setVoice({ error: "Couldn't apply the audio setting" }))
  const r = room
  const track = r?.localParticipant.getTrackPublication('microphone' as Track.Source.Microphone)?.track
  if (!r || !track) return
  try {
    if (
      'noiseSuppression' in patch ||
      'echoCancellation' in patch ||
      'autoGainControl' in patch ||
      'virtualMicOverride' in patch ||
      'noiseGate' in patch ||
      'highPassFilter' in patch ||
      'voiceCompressor' in patch
    ) await restartMic()
    if ('bitrate' in patch && track.sender) {
      const params = track.sender.getParameters()
      params.encodings = (params.encodings?.length ? params.encodings : [{}]).map((e) => ({ ...e, maxBitrate: voiceSettings().bitrate }))
      await track.sender.setParameters(params)
    }
  } catch {
    setVoice({ error: "Couldn't apply the audio setting" })
  }
}

/** The raw WebRTC stats of our microphone sender (or, when not publishing, of a received audio track). */
export async function statsReport(): Promise<RTCStatsReport | undefined> {
  if (cv.active()) return cv.stats()
  const r = room
  if (!r) return undefined
  const mic = r.localParticipant.getTrackPublication('microphone' as Track.Source.Microphone)?.track
  if (mic) return mic.getRTCStatsReport()
  for (const p of r.remoteParticipants.values())
    for (const pub of p.audioTrackPublications.values()) if (pub.track) return pub.track.getRTCStatsReport()
  return undefined
}

/** getStats() of our screen share sender and of the first screen share we receive, for the encoder/decoder details. */
export async function screenStats(): Promise<{ send?: RTCStatsReport; recv?: RTCStatsReport }> {
  if (cv.active()) return cv.screenStats()
  const r = room
  if (!r) return {}
  const own = r.localParticipant.getTrackPublication('screen_share' as Track.Source.ScreenShare)?.track
  const remote = [...r.remoteParticipants.values()].map((p) => p.getTrackPublication('screen_share' as Track.Source.ScreenShare)?.track).find(Boolean)
  const [send, recv] = await Promise.all([own?.getRTCStatsReport(), remote?.getRTCStatsReport()])
  return { send, recv }
}

const SB_MUTED_KEY = 'cillcord:sbMutedUsers'
const sbMutedUsers = new Set<string>((() => {
  try {
    const raw = localStorage.getItem(SB_MUTED_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
})())

export const isSoundboardMuted = (userId: string) => sbMutedUsers.has(userId)
export function toggleMuteSoundboard(userId: string) {
  if (sbMutedUsers.has(userId)) sbMutedUsers.delete(userId)
  else sbMutedUsers.add(userId)
  try {
    localStorage.setItem(SB_MUTED_KEY, JSON.stringify([...sbMutedUsers]))
  } catch {}
}

/** Plays a soundboard sound locally (VOICE_CHANNEL_EFFECT_SEND or the popover preview). */
export function playSound(soundId: string, volume = 1, url = cdn(`/soundboard-sounds/${soundId}`), userId?: string) {
  if (userId && isSoundboardMuted(userId)) return
  const s = voiceSettings()
  if (s.soundboardVolume <= 0) return
  const effectiveGain = volume * s.soundboardVolume
  const a = new Audio(url)
  a.volume = Math.max(0, Math.min(1, effectiveGain))
  const out = voiceSettings().output
  const sink = (a as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId
  if (out && sink) void sink.call(a, out).catch(() => {})
  void a.play().catch(() => {})
}

// AFK: after the guild's afk_timeout without input or speaking, move ourselves to its AFK channel (CONTRACT-v3 section 1).
let lastActive = Date.now()
const active = () => void (lastActive = Date.now())
for (const ev of ['keydown', 'pointerdown', 'pointermove', 'wheel']) addEventListener(ev, active, { passive: true, capture: true })
setInterval(() => {
  const s = getState()
  const v = s.voice
  if (s.me && v.speaking[s.me.id]) return active()
  const g = v.guildId ? s.guilds[v.guildId] : undefined
  if (!g?.afk_channel_id || !v.channelId || v.channelId === g.afk_channel_id || v.status === 'idle') return
  if (Date.now() - lastActive >= (g.afk_timeout ?? 300) * 1000) {
    active()
    // the server ignores a join it does not allow, and leaving first would drop us from a working call
    const afk = s.channels[g.afk_channel_id]
    if (afk && canJoinVoice(s, g.id, afk)) joinVoice(g.id, g.afk_channel_id)
  }
}, 5000)

export function setUserVolume(userId: string, volume: number) {
  saveVoiceSettings({ volumes: { ...voiceSettings().volumes, [userId]: volume } })
  const p = room?.remoteParticipants.get(userId)
  if (p) applyVolume(p)
  cv.applyVolumes()
}

export function setStreamVolume(userId: string, volume: number) {
  const s = voiceSettings()
  saveVoiceSettings({
    volumes: { ...s.volumes, [`${userId}-screen`]: volume },
    screenVolumes: { ...(s.screenVolumes ?? {}), [userId]: volume },
  })
  const p = room?.remoteParticipants.get(userId)
  if (p) applyVolume(p)
  cv.applyVolumes()
}

export function getStreamVolume(userId: string): number {
  const s = voiceSettings()
  return s.screenVolumes?.[userId] ?? s.volumes[`${userId}-screen`] ?? 1
}

/** Recaptures our LiveKit mic with the resolved device and the processing in effect (a noise-removing virtual mic turns ours off). */
async function restartMic() {
  const track = micTrack()
  if (!track) return
  const chId = getState().voice.channelId
  const hifi = Boolean(chId && getState().channels[chId]?.quality_mode === 'hifi')
  await withMic(() => (track as unknown as { restartTrack: (c: MediaTrackConstraints) => Promise<void> }).restartTrack(captureConstraints(voiceSettings(), undefined, hifi)))
  await syncGain() // Updates the DSP chain (Speex/RNNoise/GTCRN, gate, filters)
}

/** Label of the microphone captured right now ('' when none), for Voice & Video. */
export const micLabel = () => (cv.active() ? cv.micLabel() : (micTrack()?.mediaStreamTrack?.label ?? ''))

/** The one place device choices are saved; a mic keeps its label too, to be found again when its id changes. */
export async function setDevice(kind: 'audioinput' | 'audiooutput' | 'videoinput', id: string, label = '') {
  saveVoiceSettings(kind === 'audioinput' ? { input: id, inputLabel: id ? label : '' } : kind === 'audiooutput' ? { output: id } : { camera: id })
  if (kind === 'audioinput') await restartMic().catch((e) => setVoice({ error: `Device error: ${e instanceof Error ? e.message : e}` }))
  else await room?.switchActiveDevice(kind, id || 'default').catch(() => {})
  await cv.setDevice(kind).catch((e) => setVoice({ error: `Device error: ${e instanceof Error ? e.message : e}` }))
}

export const setInputMode = (mode: 'vad' | 'ptt', pttKey?: string) => {
  saveVoiceSettings({ mode, ...(pttKey && { pttKey }) })
  void syncMic()
}

export type { VideoTrackLike } from './cillvoice'
export type Tile = { userId: string; source: 'camera' | 'screen'; track: cv.VideoTrackLike }
/** Video tracks currently available (own and subscribed), for the participant grid. */
export function videoTiles(): Tile[] {
  if (cv.active()) return cv.tiles(getState().me?.id ?? '')
  const r = room
  if (!r) return []
  const out: Tile[] = []
  for (const p of [r.localParticipant, ...r.remoteParticipants.values()])
    for (const pub of p.videoTrackPublications.values())
      if (pub.track && !pub.isMuted) out.push({ userId: p.identity, source: pub.source === 'screen_share' ? 'screen' : 'camera', track: pub.track })
  return out
}

// Push-to-talk works while the tab has focus.
addEventListener('keydown', (e) => {
  if (e.repeat || pttDown || voiceSettings().mode !== 'ptt' || e.code !== voiceSettings().pttKey) return
  pttDown = true
  void syncMic()
})
addEventListener('keyup', (e) => {
  if (!pttDown || e.code !== voiceSettings().pttKey) return
  pttDown = false
  void syncMic()
})
addEventListener('blur', () => {
  if (pttDown) (pttDown = false), void syncMic()
})

/** Gateway hook: called after the store applied each dispatch. */
export function voiceEvent(t: string, d: any) {
  const s = getState()
  const v = s.voice
  switch (t) {
    case 'READY':
      // A new gateway session lost the old voice state on the server: join again.
      if (v.channelId && (v.guildId ? s.guilds[v.guildId] : s.channels[v.channelId])) (setVoice({ status: last ? v.status : 'waiting' }), sendState(), waitForServer())
      else if (v.channelId) (teardown(), setVoice({ ...idleVoice, selfMute: v.selfMute, selfDeaf: v.selfDeaf }))
      return
    case 'VOICE_SERVER_UPDATE':
      if ((d.guild_id ?? null) !== v.guildId) return
      if (d.channel_id) setVoice({ channelId: d.channel_id })
      if (!d.endpoint) return void (teardown(), setVoice({ status: 'unconfigured', error: 'Voice is not configured on this server' }))
      return void connectRoom(d.endpoint, d.token)
    case 'VOICE_STATE_UPDATE': {
      if (d.user_id !== s.me?.id || !v.channelId) return
      if (d.channel_id && d.session_id !== s.sessionId) return void (teardown(), setVoice({ ...idleVoice, selfMute: v.selfMute, selfDeaf: v.selfDeaf })) // joined elsewhere
      if ((d.guild_id ?? null) !== v.guildId) return
      if (ringOnJoin && d.channel_id === ringOnJoin) (api(`/channels/${ringOnJoin}/call/ring`, { method: 'POST', body: { recipients: null } }).catch(() => {}), (ringOnJoin = null))
      if (!d.channel_id) return void (teardown(), setVoice({ ...idleVoice, selfMute: v.selfMute, selfDeaf: v.selfDeaf })) // disconnected by someone or something
      if (d.channel_id !== v.channelId) setVoice({ channelId: d.channel_id }) // moved; a fresh VOICE_SERVER_UPDATE follows
      return void syncMic() // server mute/deafen may have changed
    }
    case 'VOICE_CHANNEL_EFFECT_SEND':
      if (d.channel_id !== v.channelId) return
      // v6: `entrance: true` is someone's entrance sound (a soundboard sound or their own upload at `sound_url`); it replaces the join chime
      if (d.entrance) entranceHeard.set(d.user_id, Date.now())
      if (d.sound_id && !deafened() && !(d.entrance && s.settings.sound_settings?.muted))
        playSound(String(d.sound_id), d.sound_volume ?? 1, d.sound_url ? cdn(d.sound_url) : undefined, d.user_id)
      setVoice({ effects: { ...v.effects, [d.user_id]: d.emoji?.name ?? '🔊' } })
      setTimeout(() => {
        const { [d.user_id]: _, ...rest } = getState().voice.effects
        setVoice({ effects: rest })
      }, 3000)
      return
    case 'CILLVOICE_ANSWER': case 'CILLVOICE_TRACKS': case 'CILLVOICE_SPEAKING': case 'CILLVOICE_ERROR':
      return cv.event(t, d)
    case 'CHANNEL_DELETE':
      if (d.id === v.channelId) (teardown(), setVoice({ ...idleVoice, selfMute: v.selfMute, selfDeaf: v.selfDeaf }))
      return
    case 'GUILD_DELETE':
      if (d.id === v.guildId) (teardown(), setVoice({ ...idleVoice, selfMute: v.selfMute, selfDeaf: v.selfDeaf }))
      return
    case 'LOGOUT':
      teardown()
      setVoice(idleVoice)
  }
}
