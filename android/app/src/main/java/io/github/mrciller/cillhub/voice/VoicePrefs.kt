package io.github.mrciller.cillhub.voice

import android.content.Context
import org.json.JSONObject

/** Local voice preferences (settings.ts voiceSettings), kept on the phone. */
class VoicePrefs(ctx: Context) {
    private val p = ctx.applicationContext.getSharedPreferences("voice", Context.MODE_PRIVATE)

    var selfMute: Boolean
        get() = p.getBoolean("self_mute", false)
        set(v) = p.edit().putBoolean("self_mute", v).apply()
    var selfDeaf: Boolean
        get() = p.getBoolean("self_deaf", false)
        set(v) = p.edit().putBoolean("self_deaf", v).apply()
    /** Push-to-talk instead of voice activity: the mic only sends while the talk button is held. */
    var pushToTalk: Boolean
        get() = p.getBoolean("ptt", false)
        set(v) = p.edit().putBoolean("ptt", v).apply()
    /** Noise suppression mode: off, standard, speex, enhanced, studio */
    var noiseSuppressionMode: String
        get() = p.getString("noise_mode", "enhanced") ?: "enhanced"
        set(v) = p.edit().putString("noise_mode", v).apply()

    var noiseSuppression: Boolean
        get() = noiseSuppressionMode != "off"
        set(v) = run { noiseSuppressionMode = if (v) "enhanced" else "off" }

    var gateEnabled: Boolean
        get() = p.getBoolean("gate_enabled", false)
        set(v) = p.edit().putBoolean("gate_enabled", v).apply()

    var gateOpenDb: Float
        get() = p.getFloat("gate_open_db", -40f)
        set(v) = p.edit().putFloat("gate_open_db", v).apply()

    var gateCloseDb: Float
        get() = p.getFloat("gate_close_db", -48f)
        set(v) = p.edit().putFloat("gate_close_db", v).apply()

    var gateHoldMs: Int
        get() = p.getInt("gate_hold_ms", 150)
        set(v) = p.edit().putInt("gate_hold_ms", v).apply()

    var highPassFilter: Boolean
        get() = p.getBoolean("high_pass_filter", false)
        set(v) = p.edit().putBoolean("high_pass_filter", v).apply()

    var voiceCompressor: Boolean
        get() = p.getBoolean("voice_compressor", false)
        set(v) = p.edit().putBoolean("voice_compressor", v).apply()

    var echoCancellation: Boolean
        get() = p.getBoolean("echo_cancellation", true)
        set(v) = p.edit().putBoolean("echo_cancellation", v).apply()
    var autoGainControl: Boolean
        get() = p.getBoolean("auto_gain", true)
        set(v) = p.edit().putBoolean("auto_gain", v).apply()
    /** Opus discontinuous transmission; off by default: with a constant noise floor its gating sounds choppy. */
    var dtx: Boolean
        get() = p.getBoolean("dtx", false)
        set(v) = p.edit().putBoolean("dtx", v).apply()
    var screenQuality: ScreenQuality
        get() = runCatching { ScreenQuality.valueOf(p.getString("screen_quality", null) ?: "") }.getOrDefault(ScreenQuality.P720_30)
        set(v) = p.edit().putString("screen_quality", v.name).apply()
    var screenCodec: Codecs.Choice
        get() = runCatching { Codecs.Choice.valueOf(p.getString("screen_codec", null) ?: "") }.getOrDefault(Codecs.Choice.AUTO)
        set(v) = p.edit().putString("screen_codec", v.name).apply()
    /** 0..2 (up to 200%), local playback of soundboard sounds. */
    var soundboardVolume: Float
        get() = p.getFloat("soundboard_volume", 1.0f)
        set(v) = p.edit().putFloat("soundboard_volume", v).apply()

    var mutedSoundboardUsers: Set<String>
        get() = p.getStringSet("muted_soundboard_users", emptySet()) ?: emptySet()
        set(v) = p.edit().putStringSet("muted_soundboard_users", v).apply()

    fun isSoundboardMuted(userId: String) = userId in mutedSoundboardUsers

    fun setSoundboardMuted(userId: String, muted: Boolean) {
        val next = if (muted) mutedSoundboardUsers + userId else mutedSoundboardUsers - userId
        mutedSoundboardUsers = next
    }

    fun processing() = livekit.org.webrtc.audio.AudioProcessingOptions(echoCancellation, noiseSuppressionMode != "off", autoGainControl, true)

    /** user id -> 0..2 (1 = 100 %); capped below the web client's 300 % because phone speakers distort sooner. */
    fun volume(userId: String): Double = volumes().optDouble(userId, 1.0)
    fun setVolume(userId: String, v: Double) = p.edit().putString("volumes", volumes().put(userId, v.coerceIn(0.0, 2.0)).toString()).apply()
    private fun volumes() = runCatching { JSONObject(p.getString("volumes", "{}") ?: "{}") }.getOrDefault(JSONObject())
}
