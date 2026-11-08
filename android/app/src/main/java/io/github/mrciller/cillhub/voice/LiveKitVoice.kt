package io.github.mrciller.cillhub.voice

import android.content.Context
import android.content.Intent
import android.util.Log
import io.github.mrciller.cillhub.Api
import io.livekit.android.AudioOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.audio.NoAudioHandler
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.participant.AudioTrackPublishDefaults
import io.livekit.android.room.participant.BackupVideoCodec
import io.livekit.android.room.participant.VideoTrackPublishOptions
import io.livekit.android.room.track.CameraPosition
import io.livekit.android.room.track.LocalAudioTrackOptions
import io.livekit.android.room.track.LocalVideoTrack
import io.livekit.android.room.track.LocalVideoTrackOptions
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.Track
import io.livekit.android.room.track.VideoCaptureParameter
import io.livekit.android.room.track.VideoEncoding
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import livekit.org.webrtc.RTCStatsReport
import livekit.org.webrtc.RtpParameters
import kotlin.coroutines.resume

/**
 * Voice through a LiveKit server with the official Android SDK (engine.ts for LiveKit). Audio routing and focus stay
 * with Telecom (CallService), so the SDK's own audio handling is off.
 */
class LiveKitVoice(
    private val ctx: Context,
    private val url: String,
    private val token: String,
    private val l: VoiceBackend.Listener,
    private val prefs: VoicePrefs,
) : VoiceBackend {
    override val name = "LiveKit"
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val room: Room = LiveKit.create(
        ctx,
        RoomOptions(
            adaptiveStream = true, dynacast = true,
            audioTrackCaptureDefaults = audioOptions(),
            audioTrackPublishDefaults = AudioTrackPublishDefaults(audioBitrate = 64_000, dtx = prefs.dtx, red = true),
        ),
        LiveKitOverrides(okHttpClient = Api.http, eglBase = Media.egl, audioOptions = AudioOptions(audioHandler = NoAudioHandler())),
    )
    private var closed = false

    private fun audioOptions() = LocalAudioTrackOptions(noiseSuppression = prefs.noiseSuppression, echoCancellation = prefs.echoCancellation, autoGainControl = prefs.autoGainControl)

    override fun connect() {
        scope.launch {
            room.events.collect { e ->
                when (e) {
                    is RoomEvent.ActiveSpeakersChanged -> l.speaking(e.speakers.mapNotNull { it.identity?.value }.toSet())
                    is RoomEvent.TrackSubscribed, is RoomEvent.TrackUnsubscribed, is RoomEvent.ParticipantConnected, is RoomEvent.ParticipantDisconnected,
                    is RoomEvent.TrackMuted, is RoomEvent.TrackUnmuted, is RoomEvent.LocalTrackSubscribed, is RoomEvent.TrackPublished, is RoomEvent.TrackUnpublished -> l.tracksChanged()
                    is RoomEvent.Reconnecting -> l.reconnecting()
                    is RoomEvent.Reconnected -> l.connected()
                    is RoomEvent.Disconnected -> if (!closed) l.lost(e.error?.message ?: "")
                    // stage: the server grants the microphone when we become a speaker
                    is RoomEvent.ParticipantPermissionsChanged -> l.connected()
                    else -> {}
                }
            }
        }
        scope.launch {
            try {
                room.connect(url, token)
                // viewers without AV1 say so, and sharers leave AV1 out while one is in the room (engine.ts dropAv1)
                if (!Media.decodesAv1) runCatching { room.localParticipant.updateAttributes(mapOf("av1" to "0")) }
                l.connected()
            } catch (e: Exception) {
                if (!closed) l.lost(e.message ?: "")
            }
        }
    }

    override fun close() {
        closed = true
        runCatching { room.disconnect() }
        runCatching { room.release() }
        scope.cancel()
    }

    override suspend fun setMic(on: Boolean) { room.localParticipant.setMicrophoneEnabled(on) }

    override fun applyVolumes(volume: (String) -> Double) {
        for (p in room.remoteParticipants.values) {
            val v = volume(p.identity?.value ?: continue)
            for (pub in p.trackPublications.values) (pub.track as? RemoteAudioTrack)?.setVolume(v)
        }
    }

    override suspend fun setCamera(on: Boolean, front: Boolean) {
        room.videoTrackCaptureDefaults = room.videoTrackCaptureDefaults.copy(position = if (front) CameraPosition.FRONT else CameraPosition.BACK)
        room.localParticipant.setCameraEnabled(on)
    }

    override fun flipCamera(front: Boolean) {
        (room.localParticipant.getTrackPublication(Track.Source.CAMERA)?.track as? LocalVideoTrack)?.switchCamera(position = if (front) CameraPosition.FRONT else CameraPosition.BACK)
    }

    override suspend fun startScreen(data: Intent, q: ScreenQuality, codecs: List<String>) {
        val blocked = room.remoteParticipants.values.any { it.attributes["av1"] == "0" }
        val list = codecs.filter { it != "av1" || !blocked }.ifEmpty { listOf("vp8") }
        val lp = room.localParticipant
        val track = lp.createScreencastTrack(
            mediaProjectionPermissionResultData = data,
            // LiveKit takes the longest side as width and the shortest as height, and turns them with the display
            options = LocalVideoTrackOptions(isScreencast = true, captureParams = displaySize(ctx).let { (w, h) -> q.fit(w, h) }.let { (w, h) -> VideoCaptureParameter(maxOf(w, h), minOf(w, h), q.fps) }),
        ) { l.screenEnded() }
        track.startCapture() // CallService already runs as a mediaProjection foreground service
        lp.publishVideoTrack(
            track,
            VideoTrackPublishOptions(
                source = Track.Source.SCREEN_SHARE, videoCodec = list[0], videoEncoding = VideoEncoding(q.bitrate, q.fps),
                scalabilityMode = if (list[0] == "av1") "L1T1" else null,
                // LiveKit adds this copy when a viewer cannot decode the first codec: H.264 behind AV1, else VP8
                backupCodec = BackupVideoCodec(codec = if (list[0] == "av1" && "h264" in list) "h264" else "vp8"),
                degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION,
            ),
        )
        // shortcut: an AV1 share is not republished as H.264 when a viewer without AV1 joins later (the web client does); the next share leaves AV1 out
    }

    override suspend fun stopScreen() {
        room.localParticipant.getTrackPublication(Track.Source.SCREEN_SHARE)?.track?.let { room.localParticipant.unpublishTrack(it) }
    }

    override fun tiles(myId: String): List<Tile> {
        val out = mutableListOf<Tile>()
        for (p in listOf(room.localParticipant) + room.remoteParticipants.values) {
            val id = p.identity?.value ?: continue
            for (pub in p.trackPublications.values) {
                val t = pub.track as? io.livekit.android.room.track.VideoTrack ?: continue
                if (pub.muted) continue
                out += Tile(id, pub.source == Track.Source.SCREEN_SHARE, t.rtcTrack, p === room.localParticipant, t)
            }
        }
        return out
    }

    override suspend fun restartMic() {
        room.audioTrackCaptureDefaults = audioOptions()
        // applied to the running capture, no republish
        (room.localParticipant.getTrackPublication(Track.Source.MICROPHONE)?.track?.rtcTrack as? livekit.org.webrtc.AudioTrack)
            ?.setAudioProcessingOptions(prefs.processing())
    }

    private suspend fun report(get: (livekit.org.webrtc.RTCStatsCollectorCallback) -> Unit): Map<String, Map<String, Any?>> = suspendCancellableCoroutine { c ->
        get { r: RTCStatsReport -> c.resume(r.statsMap.mapValues { (_, s) -> s.members + ("type" to s.type) }) }
    }

    override suspend fun stats(): VoiceStats = try {
        StatsSummary.of(listOf(report { room.getPublisherRTCStats(it) }, report { room.getSubscriberRTCStats(it) }))
    } catch (e: Exception) {
        Log.w("CillhubLiveKit", "stats: $e"); VoiceStats()
    }
}
