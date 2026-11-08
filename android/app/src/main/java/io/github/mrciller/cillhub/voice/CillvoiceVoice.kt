package io.github.mrciller.cillhub.voice

import android.content.Context
import android.content.Intent
import android.hardware.display.DisplayManager
import android.media.projection.MediaProjection
import android.util.DisplayMetrics
import android.util.Log
import android.view.Display
import io.github.mrciller.cillhub.data.Session
import io.livekit.android.webrtc.CustomVideoDecoderFactory
import io.livekit.android.webrtc.CustomVideoEncoderFactory
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeout
import livekit.org.webrtc.AudioSource
import livekit.org.webrtc.AudioTrack
import livekit.org.webrtc.Camera1Enumerator
import livekit.org.webrtc.Camera2Enumerator
import livekit.org.webrtc.CameraEnumerator
import livekit.org.webrtc.CameraVideoCapturer
import livekit.org.webrtc.DataChannel
import livekit.org.webrtc.IceCandidate
import livekit.org.webrtc.MediaConstraints
import livekit.org.webrtc.MediaStream
import livekit.org.webrtc.MediaStreamTrack
import livekit.org.webrtc.PeerConnection
import livekit.org.webrtc.PeerConnectionFactory
import livekit.org.webrtc.RtpParameters
import livekit.org.webrtc.RtpReceiver
import livekit.org.webrtc.RtpTransceiver
import livekit.org.webrtc.RtpTransceiver.RtpTransceiverDirection as Dir
import livekit.org.webrtc.ScreenCapturerAndroid
import livekit.org.webrtc.SdpObserver
import livekit.org.webrtc.SessionDescription
import livekit.org.webrtc.SurfaceTextureHelper
import livekit.org.webrtc.VideoCapturer
import livekit.org.webrtc.VideoSource
import livekit.org.webrtc.VideoTrack
import livekit.org.webrtc.audio.JavaAudioDeviceModule
import org.json.JSONObject
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/** The display's full size in pixels, for fitting a screen capture. */
fun displaySize(ctx: Context): Pair<Int, Int> {
    val m = DisplayMetrics()
    @Suppress("DEPRECATION") ctx.getSystemService(DisplayManager::class.java).getDisplay(Display.DEFAULT_DISPLAY).getRealMetrics(m)
    return m.widthPixels to m.heightPixels
}

/**
 * Voice through cillvoice, the server's built-in media server (client/src/voice/cillvoice.ts): one PeerConnection on the
 * libwebrtc the LiveKit SDK ships. This side always offers (its send transceivers plus one receive transceiver per remote
 * track) over gateway op 50 and gets CILLVOICE_ANSWER back; CILLVOICE_TRACKS starts another round.
 */
class CillvoiceVoice(
    private val ctx: Context,
    private val token: String,
    private val l: VoiceBackend.Listener,
    private val prefs: VoicePrefs,
) : VoiceBackend {
    override val name = "cillvoice"
    private val tag = "CillhubCillvoice"
    private val scope = CoroutineScope(SupervisorJob() + Voice.thread)
    private val adm = JavaAudioDeviceModule.builder(ctx)
        .setUseHardwareAcousticEchoCanceler(prefs.echoCancellation && JavaAudioDeviceModule.isBuiltInAcousticEchoCancelerSupported())
        .setUseHardwareNoiseSuppressor(prefs.noiseSuppression && JavaAudioDeviceModule.isBuiltInNoiseSuppressorSupported())
        .createAudioDeviceModule()
    private val factory: PeerConnectionFactory = PeerConnectionFactory.builder()
        .setAudioDeviceModule(adm)
        .setVideoEncoderFactory(CustomVideoEncoderFactory(Media.egl.eglBaseContext, true, false))
        .setVideoDecoderFactory(CustomVideoDecoderFactory(Media.egl.eglBaseContext))
        .createPeerConnectionFactory()
    private val pc: PeerConnection
    private var remote: List<CvSignal.Track> = emptyList()
    private val mapped = LinkedHashMap<String, CvSignal.Track>() // receive mid -> remote track
    private val pub = LinkedHashMap<String, RtpTransceiver>() // source -> send transceiver
    // every transceiver we added: PeerConnection.getTransceivers() disposes the Java objects it handed out before, so it is never called
    private val all = mutableListOf<RtpTransceiver>()
    private fun add(t: RtpTransceiver) = t.also { all += it }
    private var micSource: AudioSource? = null
    private var mic: AudioTrack? = null
    private var micOn = false
    private class Capture(val capturer: VideoCapturer, val helper: SurfaceTextureHelper, val source: VideoSource, val track: VideoTrack) {
        fun dispose() { runCatching { capturer.stopCapture() }; capturer.dispose(); track.dispose(); source.dispose(); helper.dispose() }
    }
    private var camera: Capture? = null
    private var screen: Capture? = null
    private var busy = false
    private var again = false
    private var waiting: CompletableDeferred<CvSignal.Answer>? = null
    @Volatile private var closed = false
    private var volume: (String) -> Double = { 1.0 }

    init {
        val cfg = PeerConnection.RTCConfiguration(emptyList()).apply {
            bundlePolicy = PeerConnection.BundlePolicy.MAXBUNDLE
            rtcpMuxPolicy = PeerConnection.RtcpMuxPolicy.REQUIRE
            sdpSemantics = PeerConnection.SdpSemantics.UNIFIED_PLAN
            // keeps gathering on a new network, so a network change can restart ICE without a new connection
            continualGatheringPolicy = PeerConnection.ContinualGatheringPolicy.GATHER_CONTINUALLY
        }
        pc = factory.createPeerConnection(cfg, object : PeerConnection.Observer {
            override fun onConnectionChange(s: PeerConnection.PeerConnectionState) {
                if (closed) return
                when (s) {
                    PeerConnection.PeerConnectionState.CONNECTED -> l.connected()
                    PeerConnection.PeerConnectionState.DISCONNECTED -> l.reconnecting() // ICE may recover by itself within seconds
                    PeerConnection.PeerConnectionState.FAILED -> l.lost("")
                    else -> {}
                }
            }
            override fun onSignalingChange(s: PeerConnection.SignalingState) {}
            override fun onIceConnectionChange(s: PeerConnection.IceConnectionState) {}
            override fun onIceConnectionReceivingChange(b: Boolean) {}
            override fun onIceGatheringChange(s: PeerConnection.IceGatheringState) {}
            override fun onIceCandidate(c: IceCandidate) {} // the server is ICE-lite and learns our address from the checks
            override fun onIceCandidatesRemoved(c: Array<out IceCandidate>) {}
            override fun onAddStream(s: MediaStream) {}
            override fun onRemoveStream(s: MediaStream) {}
            override fun onDataChannel(d: DataChannel) {}
            override fun onRenegotiationNeeded() {}
            override fun onAddTrack(r: RtpReceiver, s: Array<out MediaStream>) {}
        }) ?: throw IllegalStateException("no peer connection")
        // the microphone transceiver always exists, so there is something to connect even while muted or listening only
        pub["microphone"] = add(pc.addTransceiver(MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO, RtpTransceiver.RtpTransceiverInit(Dir.SEND_ONLY)))
    }

    override fun connect() { scope.launch { runCatching { negotiate() }.onFailure { if (!closed) l.lost(it.message ?: "") } } }

    override fun close() {
        closed = true
        waiting?.cancel()
        scope.cancel()
        camera?.dispose(); camera = null
        screen?.dispose(); screen = null
        mic?.dispose(); mic = null
        micSource?.dispose(); micSource = null
        pc.dispose()
        factory.dispose()
        adm.release()
    }

    private fun isPub(t: RtpTransceiver) = pub.values.any { it === t }
    private fun kindOf(t: RtpTransceiver) = if (t.mediaType == MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO) "audio" else "video"
    private fun byMid(mid: String) = all.firstOrNull { it.mid == mid }

    private suspend fun sdp(block: (SdpObserver) -> Unit): SessionDescription? = suspendCancellableCoroutine { c ->
        block(object : SdpObserver {
            override fun onCreateSuccess(d: SessionDescription) = c.resume(d)
            override fun onSetSuccess() = c.resume(null)
            override fun onCreateFailure(e: String?) = c.resumeWithException(IllegalStateException(e))
            override fun onSetFailure(e: String?) = c.resumeWithException(IllegalStateException(e))
        })
    }

    /** One offer/answer round at a time; changes during a round trigger another. */
    private suspend fun negotiate() {
        if (busy) { again = true; return }
        busy = true
        try {
            do {
                again = false
                val free = all.filter { t -> t.mid != null && !mapped.containsKey(t.mid) && !isPub(t) && t.direction == Dir.INACTIVE }.map { CvSignal.Free(it.mid, kindOf(it)) }
                val plan = CvSignal.plan(remote, mapped, free)
                plan.unmap.forEach { unmap(it) }
                val pending = plan.add.map { (mid, t) ->
                    val tr = mid?.let { byMid(it) } ?: add(pc.addTransceiver(
                        if (t.kind == "audio") MediaStreamTrack.MediaType.MEDIA_TYPE_AUDIO else MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO,
                        RtpTransceiver.RtpTransceiverInit(Dir.RECV_ONLY),
                    ))
                    tr.direction = Dir.RECV_ONLY
                    tr to t
                }
                val offer = sdp { pc.createOffer(it, MediaConstraints()) }!!
                sdp { pc.setLocalDescription(it, offer) }
                if (closed) return
                for ((tr, t) in pending) mapped[tr.mid] = t
                val publish = pub.filterValues { it.mid != null && it.direction != Dir.INACTIVE }.mapValues { it.value.mid }
                val w = CompletableDeferred<CvSignal.Answer>()
                waiting = w
                Session.op(CvSignal.OP, CvSignal.signal(token, offer.description, publish, mapped))
                val a = try { withTimeout(10_000) { w.await() } } catch (e: kotlinx.coroutines.TimeoutCancellationException) { throw IllegalStateException("the voice server did not answer") }
                if (closed) return
                sdp { pc.setRemoteDescription(it, SessionDescription(SessionDescription.Type.ANSWER, CvSignal.keepRid(CvSignal.munge(a.sdp, pub["microphone"]?.mid, prefs.dtx), offer.description,
                    listOfNotNull(pub["camera"]?.mid, pub["screen_share"]?.mid).toSet()))) }
                mapped.keys.filter { it !in a.subscribed }.forEach { unmap(it) }
                applyVolumes(volume)
                if (a.tracks != remote) { remote = a.tracks; again = true }
                l.tracksChanged()
            } while (again && !closed)
        } finally {
            busy = false
        }
    }

    private fun unmap(mid: String) {
        mapped.remove(mid)
        byMid(mid)?.takeIf { !isPub(it) }?.direction = Dir.INACTIVE
    }

    override fun onGateway(t: String, d: JSONObject) {
        when (t) {
            "CILLVOICE_ANSWER" -> { val w = waiting; waiting = null; w?.complete(CvSignal.answer(d)) }
            "CILLVOICE_ERROR" -> { val w = waiting; waiting = null; w?.completeExceptionally(IllegalStateException(d.optString("message", "voice error"))) }
            "CILLVOICE_TRACKS" -> { remote = CvSignal.tracks(d.optJSONArray("tracks")); scope.launch { runCatching { negotiate() }.onFailure { Log.w(tag, "negotiation: $it") } } }
            "CILLVOICE_SPEAKING" -> d.optJSONArray("speaking").also { Log.d(tag, "speaking: $it") }.let { a -> l.speaking((0 until (a?.length() ?: 0)).map { a!!.optString(it) }.toSet()) }
        }
    }

    override fun networkChanged() {
        if (closed) return
        pc.restartIce()
        scope.launch { runCatching { negotiate() } }
    }

    // ---------- microphone ----------

    private fun micTrack(): AudioTrack {
        mic?.let { return it }
        val c = MediaConstraints().apply {
            mandatory += MediaConstraints.KeyValuePair("googEchoCancellation", prefs.echoCancellation.toString())
            mandatory += MediaConstraints.KeyValuePair("googNoiseSuppression", prefs.noiseSuppression.toString())
            mandatory += MediaConstraints.KeyValuePair("googAutoGainControl", prefs.autoGainControl.toString())
            mandatory += MediaConstraints.KeyValuePair("googHighpassFilter", "true")
        }
        val src = factory.createAudioSource(c).also { micSource = it }
        return factory.createAudioTrack("microphone", src).also { it.setAudioProcessingOptions(prefs.processing()); mic = it }
    }

    override suspend fun setMic(on: Boolean) {
        micOn = on
        val sender = pub["microphone"]!!.sender
        sender.setTrack(if (on) micTrack() else null, false)
        // without a track Android's libwebrtc still sends silence: the encoding goes inactive so nothing is sent
        val p = sender.parameters
        if (p.encodings.isNotEmpty()) { p.encodings.forEach { it.active = on; it.maxBitrateBps = 64_000 }; sender.parameters = p }
    }

    override suspend fun restartMic() { mic?.setAudioProcessingOptions(prefs.processing()) }

    override fun applyVolumes(volume: (String) -> Double) {
        this.volume = volume
        if (closed) return
        for ((mid, r) in mapped) if (r.kind == "audio") (byMid(mid)?.receiver?.track() as? AudioTrack)?.setVolume(volume(r.userId))
    }

    // ---------- camera and screen ----------

    private suspend fun publishVideo(source: String, track: VideoTrack, layers: List<CvSignal.Layer>, codecs: List<String>? = null) {
        var tr = pub[source]
        if (tr != null) {
            tr.sender.setTrack(track, false)
            tr.direction = Dir.SEND_ONLY
            // back from inactive: every layer on again with this share's caps (where the sender still lists it)
            val p = tr.sender.parameters
            p.encodings.forEachIndexed { i, e -> layers.getOrNull(i)?.let { ly -> e.active = true; e.maxBitrateBps = ly.maxBitrate; e.maxFramerate = ly.maxFramerate; e.scaleResolutionDownBy = ly.scaleDown } }
            tr.sender.parameters = p
        } else {
            val av1 = codecs?.firstOrNull() == "av1"
            val enc = layers.map { ly ->
                RtpParameters.Encoding(ly.rid, true, ly.scaleDown).apply {
                    maxBitrateBps = ly.maxBitrate
                    maxFramerate = ly.maxFramerate
                    // AV1 names its scalability mode on every layer, or it is read as SVC instead of simulcast
                    if (av1) scalabilityMode = "L1T1"
                }
            }
            tr = add(pc.addTransceiver(track, RtpTransceiver.RtpTransceiverInit(Dir.SEND_ONLY, listOf(source), enc)))
            pub[source] = tr
        }
        if (codecs != null) {
            // the preferences must come from the receiver's capabilities (as RTCRtpReceiver.getCapabilities in the browser)
            val all = factory.getRtpReceiverCapabilities(MediaStreamTrack.MediaType.MEDIA_TYPE_VIDEO).codecs
            val err = tr!!.setCodecPreferences(CvSignal.preferCodecs(all, { it.name }, codecs.map { if (it == "h264") "H264" else it.uppercase() }))
            if (err?.isError == true) Log.w(tag, "codec preference ${codecs.joinToString()}: ${err.error()?.message}")
        }
        negotiate()
    }

    private suspend fun unpublish(source: String) {
        val tr = pub[source] ?: return
        // kept and reused, not stopped: after a stopped transceiver Android's libwebrtc refuses the next simulcast offer
        // ("negotiates simulcast but does not negotiate the RID RTP header extension")
        tr.sender.setTrack(null, false)
        tr.direction = Dir.INACTIVE
        negotiate()
    }

    private fun capture(name: String, capturer: VideoCapturer, screencast: Boolean, w: Int, h: Int, fps: Int): Capture {
        val helper = SurfaceTextureHelper.create(name, Media.egl.eglBaseContext)
        val source = factory.createVideoSource(screencast)
        capturer.initialize(helper, ctx, source.capturerObserver)
        capturer.startCapture(w, h, fps)
        return Capture(capturer, helper, source, factory.createVideoTrack(name, source))
    }

    private fun cameraName(front: Boolean): String? {
        val e: CameraEnumerator = if (Camera2Enumerator.isSupported(ctx)) Camera2Enumerator(ctx) else Camera1Enumerator(true)
        return e.deviceNames.firstOrNull { e.isFrontFacing(it) == front } ?: e.deviceNames.firstOrNull()
    }

    override suspend fun setCamera(on: Boolean, front: Boolean) {
        if (!on) { unpublish("camera"); camera?.dispose(); camera = null; return }
        camera?.dispose()
        val name = cameraName(front) ?: throw IllegalStateException("no camera")
        val e: CameraEnumerator = if (Camera2Enumerator.isSupported(ctx)) Camera2Enumerator(ctx) else Camera1Enumerator(true)
        val c = capture("camera", e.createCapturer(name, null), false, 1280, 720, 30)
        camera = c
        publishVideo("camera", c.track, CvSignal.CAMERA_LAYERS)
    }

    override fun flipCamera(front: Boolean) {
        val cap = camera?.capturer as? CameraVideoCapturer ?: return
        cameraName(front)?.let { cap.switchCamera(null, it) }
    }

    override suspend fun startScreen(data: Intent, q: ScreenQuality, codecs: List<String>) {
        screen?.dispose()
        val (w, h) = displaySize(ctx).let { (dw, dh) -> q.fit(dw, dh) }
        val cap = ScreenCapturerAndroid(data, object : MediaProjection.Callback() { override fun onStop() { l.screenEnded() } })
        val c = capture("screen_share", cap, true, w, h, q.fps)
        screen = c
        publishVideo("screen_share", c.track, CvSignal.screenLayers(q), codecs)
        pub["screen_share"]?.sender?.let { s -> val p = s.parameters; p.degradationPreference = RtpParameters.DegradationPreference.MAINTAIN_RESOLUTION; s.parameters = p }
    }

    override suspend fun stopScreen() { unpublish("screen_share"); screen?.dispose(); screen = null }

    override fun tiles(myId: String): List<Tile> {
        if (closed) return emptyList()
        val out = mutableListOf<Tile>()
        camera?.let { out += Tile(myId, false, it.track, true) }
        screen?.let { out += Tile(myId, true, it.track, true) }
        for ((mid, r) in mapped) {
            if (r.kind != "video") continue
            val tr = byMid(mid) ?: continue
            if (tr.currentDirection == Dir.RECV_ONLY) (tr.receiver.track() as? VideoTrack)?.let { out += Tile(r.userId, r.source == "screen_share", it, false) }
        }
        return out
    }

    override suspend fun stats(): VoiceStats = suspendCancellableCoroutine { c ->
        pc.getStats { r -> c.resume(StatsSummary.of(listOf(r.statsMap.mapValues { (_, s) -> s.members + ("type" to s.type) }))) }
    }
}
