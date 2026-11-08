package io.github.mrciller.cillhub.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.util.Log
import io.livekit.android.LiveKit
import io.livekit.android.webrtc.CustomVideoDecoderFactory
import io.livekit.android.webrtc.CustomVideoEncoderFactory
import livekit.org.webrtc.EglBase

/** Process-wide media pieces both backends share: libwebrtc set-up, one EGL context for every renderer, codec support. */
object Media {
    private const val TAG = "CillhubMedia"

    /** One EGL context for encoders, decoders and the call grid's renderers (LiveKit gets it as an override). */
    val egl: EglBase by lazy { EglBase.create() }

    private var inited = false
    fun init(ctx: Context) { if (!inited) { LiveKit.init(ctx.applicationContext); inited = true } }

    /** Video codecs this phone can send ("h264", "vp8", "av1", "vp9"): what the encoder factory offers (settings.ts canEncode). */
    val canEncode: Set<String> by lazy {
        runCatching { CustomVideoEncoderFactory(egl.eglBaseContext, true, false).supportedCodecs.map { it.name.lowercase() }.toSet() }.getOrDefault(setOf("vp8"))
    }
    val decodesAv1: Boolean by lazy { runCatching { CustomVideoDecoderFactory(egl.eglBaseContext).supportedCodecs.any { it.name.equals("AV1", true) } }.getOrDefault(false) }
    val hardwareAv1: Boolean by lazy { Codecs.hardwareAv1() }

    fun screenCodecs(choice: Codecs.Choice) = Codecs.order(choice, canEncode, hardwareAv1)

    /** Plays a soundboard sound on the call's audio route (VOICE_CHANNEL_EFFECT_SEND). */
    fun playSound(url: String, volume: Float) {
        try {
            MediaPlayer().apply {
                setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                setDataSource(url)
                val normVol = volume.coerceIn(0f, 1f)
                setVolume(normVol, normVol)
                setOnPreparedListener { mp ->
                    if (volume > 1.0f) {
                        runCatching {
                            val le = android.media.audiofx.LoudnessEnhancer(mp.audioSessionId)
                            val gainMb = ((volume - 1.0f) * 600f).toInt()
                            le.setTargetGain(gainMb)
                            le.enabled = true
                        }
                    }
                    mp.start()
                }
                setOnCompletionListener { it.release() }
                setOnErrorListener { mp, _, _ -> mp.release(); true }
                prepareAsync()
            }
        } catch (e: Exception) {
            Log.w(TAG, "sound failed: ${e.message}")
        }
    }
}
