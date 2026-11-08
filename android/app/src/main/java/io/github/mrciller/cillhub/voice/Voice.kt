package io.github.mrciller.cillhub.voice

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log
import androidx.core.content.ContextCompat
import io.github.mrciller.cillhub.CallService
import io.github.mrciller.cillhub.Calls
import io.github.mrciller.cillhub.Config
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.Perm
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.isPrivate
import io.github.mrciller.cillhub.data.voiceKey
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import org.json.JSONObject

enum class VStatus { IDLE, WAITING, CONNECTING, CONNECTED, ERROR, UNCONFIGURED }

/** The voice connection as the screens, the call service and the car see it (the web client's state.voice). */
data class VoiceUi(
    val guildId: String? = null,
    val channelId: String? = null,
    val status: VStatus = VStatus.IDLE,
    /** A string resource with one optional %s for [errorDetail]; 0 = no error. */
    val error: Int = 0,
    val errorDetail: String = "",
    val selfMute: Boolean = false,
    val selfDeaf: Boolean = false,
    val video: Boolean = false,
    val frontCamera: Boolean = true,
    val stream: Boolean = false,
    val speaking: Set<String> = emptySet(),
    val backend: String? = null,
    val tiles: List<Tile> = emptyList(),
    /** user id -> emoji of a soundboard sound they just played (3 s) */
    val effects: Map<String, String> = emptyMap(),
    /** Push-to-talk button held. */
    val talking: Boolean = false,
    /** Another call (a phone call) holds ours: mic and sound off until it ends. */
    val held: Boolean = false,
) {
    val active get() = channelId != null
}

/**
 * Native voice and video (client/src/voice/engine.ts): gateway op 4 and VOICE_SERVER_UPDATE, then the media backend the
 * server names (LiveKit, or "cillvoice" for the built-in media server). Mute, deafen, push-to-talk, server mute/deafen and
 * moves, stage audience, per-user volume, camera, screen share, soundboard playback. Everything runs on one thread.
 */
object Voice {
    private const val TAG = "CillhubVoice"
    private lateinit var app: Context
    lateinit var prefs: VoicePrefs; private set
    private val _state = MutableStateFlow(VoiceUi())
    val state: StateFlow<VoiceUi> = _state
    /** The one thread voice runs on; the backends use it too, so their state needs no locks. */
    @OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)
    val thread = Dispatchers.Default.limitedParallelism(1)
    private val scope = CoroutineScope(SupervisorJob() + thread)
    private var backend: VoiceBackend? = null
    private var last: Pair<String, String>? = null
    private var ringOnJoin: String? = null
    private var joinTimer: Job? = null
    private var mutedBeforeDeaf = false
    private var network: Network? = null

    fun init(ctx: Context) {
        app = ctx.applicationContext
        prefs = VoicePrefs(app)
        _state.value = VoiceUi(selfMute = prefs.selfMute, selfDeaf = prefs.selfDeaf)
        // the call service, Telecom and the notification follow the voice state
        CoroutineScope(Dispatchers.Main).launch { state.collect { Calls.onVoice(app, it) } }
        runCatching {
            app.getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(n: Network) { scope.launch { if (network != null && network != n) backend?.networkChanged(); network = n } }
            })
        }
    }

    private fun set(f: (VoiceUi) -> VoiceUi) = _state.update(f)
    private fun error(res: Int, detail: String = "") = set { it.copy(error = res, errorDetail = detail) }
    private fun idle(v: VoiceUi) = VoiceUi(selfMute = v.selfMute, selfDeaf = v.selfDeaf)

    // ---------- actions (any thread) ----------

    /** Joins a guild voice channel or stage, or a DM / group DM call with [guildId] null; [ring] rings the others once we are in. */
    fun join(guildId: String?, channelId: String, ring: Boolean = false) = scope.launch {
        ringOnJoin = if (ring) channelId else null
        val v = state.value
        if (v.channelId == channelId && v.status != VStatus.ERROR) return@launch
        teardown() // the server moves our single voice state; the new room comes with VOICE_SERVER_UPDATE
        _state.value = VoiceUi(guildId, channelId, VStatus.WAITING, selfMute = prefs.selfMute, selfDeaf = prefs.selfDeaf)
        sendState()
        waitForServer()
    }

    fun leave() = scope.launch {
        val v = state.value
        if (v.channelId != null) Session.op(4, JSONObject().put("guild_id", v.guildId ?: JSONObject.NULL).put("channel_id", JSONObject.NULL).put("self_mute", v.selfMute).put("self_deaf", v.selfDeaf))
        teardown()
        _state.value = idle(v)
    }

    /** Retries the media connection with the last token, or asks the gateway for a new one. */
    fun retry() = scope.launch {
        val l = last
        val v = state.value
        if (l != null) connectBackend(l.first, l.second)
        else if (v.channelId != null) { set { it.copy(status = VStatus.WAITING, error = 0) }; sendState(); waitForServer() }
    }

    fun setSelfMute(mute: Boolean) = scope.launch {
        val v = state.value
        // unmuting while deafened undeafens too
        val deaf = if (mute) v.selfDeaf else false
        prefs.selfMute = mute; prefs.selfDeaf = deaf
        set { it.copy(selfMute = mute, selfDeaf = deaf) }
        sendState(); syncMic()
    }

    /** Deafening also mutes; undeafening restores the mute state from before. */
    fun setSelfDeaf(deaf: Boolean) = scope.launch {
        val v = state.value
        if (deaf && !v.selfDeaf) mutedBeforeDeaf = v.selfMute
        val mute = deaf || (if (v.selfDeaf) mutedBeforeDeaf else v.selfMute)
        prefs.selfMute = mute; prefs.selfDeaf = deaf
        set { it.copy(selfDeaf = deaf, selfMute = mute) }
        sendState(); syncMic()
    }

    fun setTalking(down: Boolean) = scope.launch { if (state.value.talking != down) { set { it.copy(talking = down) }; syncMic() } }

    /** Telecom put the call on hold (a phone call came in) or made it active again. */
    fun setHeld(held: Boolean) = scope.launch { if (state.value.held != held) { set { it.copy(held = held) }; syncMic() } }

    fun setUserVolume(userId: String, volume: Double) = scope.launch { prefs.setVolume(userId, volume); applyVolumes() }

    fun toggleCamera() = scope.launch {
        val b = backend ?: return@launch
        val v = state.value
        try {
            b.setCamera(!v.video, v.frontCamera)
            set { it.copy(video = !v.video) }
            sendState()
        } catch (e: Exception) {
            Log.w(TAG, "camera: $e"); error(R.string.voice_err_camera, e.message ?: "")
        }
        tracks()
    }

    fun flipCamera() = scope.launch {
        val v = state.value
        if (!v.video) return@launch
        backend?.flipCamera(!v.frontCamera)
        set { it.copy(frontCamera = !v.frontCamera) }
    }

    /** Starts sharing the screen with the MediaProjection consent [data] (from the activity). */
    fun startScreen(data: Intent) = scope.launch {
        val b = backend ?: return@launch
        if (state.value.stream) return@launch
        try {
            // Android 14+: a foreground service of type mediaProjection must run before the projection is used
            if (withTimeoutOrNull(5000) { CallService.projection(app, true) } != true) throw IllegalStateException("no foreground service")
            b.startScreen(data, prefs.screenQuality, Media.screenCodecs(prefs.screenCodec))
            set { it.copy(stream = true) }
            sendState()
        } catch (e: Exception) {
            Log.w(TAG, "screen: $e"); error(R.string.voice_err_screen, e.message ?: "")
            CallService.projection(app, false)
        }
        tracks()
    }

    fun stopScreen() = scope.launch {
        if (!state.value.stream) return@launch
        runCatching { backend?.stopScreen() }
        set { it.copy(stream = false) }
        sendState()
        CallService.projection(app, false)
        tracks()
    }

    /** Processing settings changed: capture the mic again with them. */
    fun audioSettingsChanged() = scope.launch { runCatching { backend?.restartMic() } }

    fun clearError() = set { it.copy(error = 0, errorDetail = "") }

    suspend fun stats(): VoiceStats? = backend?.stats()

    // ---------- internals ----------

    private fun sendState() {
        val v = state.value
        if (v.guildId == null && v.channelId == null) return
        Session.op(4, JSONObject().put("guild_id", v.guildId ?: JSONObject.NULL).put("channel_id", v.channelId ?: JSONObject.NULL)
            .put("self_mute", v.selfMute || v.selfDeaf).put("self_deaf", v.selfDeaf).put("self_video", v.video).put("self_stream", v.stream))
    }

    // The server ignores joins it does not allow (no CONNECT, channel full) without an error event.
    private fun waitForServer() {
        joinTimer?.cancel()
        joinTimer = scope.launch { delay(5000); if (state.value.status == VStatus.WAITING) set { it.copy(status = VStatus.ERROR, error = R.string.voice_err_join) } }
    }

    private fun teardown() {
        joinTimer?.cancel()
        backend?.close()
        backend = null
        last = null
        if (state.value.stream) scope.launch { CallService.projection(app, false) }
        set { it.copy(tiles = emptyList(), speaking = emptySet(), backend = null, video = false, stream = false) }
    }

    /** LiveKit endpoint as a ws(s) URL; full URLs, bare hosts and root-relative paths (engine.ts wsUrl). */
    fun wsUrl(endpoint: String, origin: String = Config.ORIGIN): String = when {
        endpoint.startsWith("ws://") || endpoint.startsWith("wss://") -> endpoint
        endpoint.startsWith("http://") || endpoint.startsWith("https://") -> endpoint.replaceFirst("http", "ws")
        endpoint.startsWith("/") -> origin.replaceFirst("http", "ws") + endpoint
        else -> (if (origin.startsWith("https")) "wss://" else "ws://") + endpoint
    }

    private fun connectBackend(endpoint: String, token: String) {
        teardown()
        last = endpoint to token
        Media.init(app)
        lateinit var b: VoiceBackend
        val l = object : VoiceBackend.Listener {
            private fun on(f: () -> Unit) { scope.launch { if (backend === b) f() } }
            init { Log.i(TAG, "connecting to $endpoint") }
            override fun connected() = on {
                Log.i(TAG, "voice connected (${b.name})"); set { it.copy(status = VStatus.CONNECTED, error = 0) }; scope.launch { syncMic(); tracks() } }
            override fun reconnecting() = on { set { it.copy(status = VStatus.CONNECTING) } }
            override fun lost(detail: String) = on {
                Log.w(TAG, "voice connection lost: $detail"); set { it.copy(status = VStatus.ERROR, error = R.string.voice_err_lost, errorDetail = detail) } }
            override fun speaking(ids: Set<String>) = on { set { it.copy(speaking = ids) } }
            override fun tracksChanged() = on { tracks(); applyVolumes() }
            override fun screenEnded() = on { if (state.value.stream) stopScreen() }
        }
        b = if (endpoint == "cillvoice") CillvoiceVoice(app, token, l, prefs) else LiveKitVoice(app, wsUrl(endpoint), token, l, prefs)
        backend = b
        set { it.copy(status = VStatus.CONNECTING, error = 0, speaking = emptySet(), backend = b.name) }
        b.connect()
    }

    private fun tracks() {
        val t = try { backend?.tiles(Session.store.value.me?.id ?: "") } catch (e: Exception) { Log.w(TAG, "tiles: $e"); null }
        set { it.copy(tiles = t ?: emptyList()) }
    }

    private fun micPermission() = ContextCompat.checkSelfPermission(app, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    /** Whether the microphone should send now (engine.ts micWanted). */
    fun micWanted(v: VoiceUi = state.value): Boolean {
        val s = Session.store.value
        val ch = v.channelId?.let { s.channels[it] }
        val st = s.me?.id?.let { s.voiceStates[voiceKey(v.guildId)]?.get(it) }
        // stage audience (suppress) never publishes; the server's grant enforces it too
        val allowed = (ch == null || isPrivate(ch) || Sel.can(s, ch, Perm.SPEAK)) && st?.mute != true && st?.deaf != true && st?.suppress != true
        return allowed && !v.selfMute && !v.selfDeaf && !v.held && (!prefs.pushToTalk || v.talking)
    }

    fun deafened(v: VoiceUi = state.value): Boolean {
        val s = Session.store.value
        val st = s.me?.id?.let { s.voiceStates[voiceKey(v.guildId)]?.get(it) }
        return v.selfDeaf || st?.deaf == true || v.held
    }

    private suspend fun syncMic() {
        val b = backend ?: return
        if (state.value.status != VStatus.CONNECTED) return
        val on = micWanted() && micPermission()
        try { b.setMic(on) } catch (e: Exception) { Log.w(TAG, "mic: $e"); error(R.string.voice_err_mic, e.message ?: "") }
        if (micWanted() && !micPermission()) error(R.string.voice_err_mic_permission)
        applyVolumes()
    }

    private fun applyVolumes() {
        val deaf = deafened()
        backend?.applyVolumes { uid -> if (deaf) 0.0 else prefs.volume(uid) }
    }

    /** Gateway hook: called after the store applied each dispatch (engine.ts voiceEvent). */
    fun onDispatch(t: String, d: JSONObject) {
        if (!::app.isInitialized) return
        when (t) {
            "READY", "VOICE_SERVER_UPDATE", "VOICE_STATE_UPDATE", "VOICE_CHANNEL_EFFECT_SEND", "CHANNEL_DELETE", "GUILD_DELETE",
            "CILLVOICE_ANSWER", "CILLVOICE_TRACKS", "CILLVOICE_SPEAKING", "CILLVOICE_ERROR" -> scope.launch { handle(t, d) }
        }
    }

    private fun str(d: JSONObject, k: String): String? = if (d.isNull(k)) null else d.optString(k).ifEmpty { null }

    private suspend fun handle(t: String, d: JSONObject) {
        val s = Session.store.value
        val v = state.value
        when (t) {
            "READY" -> {
                // a new gateway session lost the old voice state on the server: join again
                if (v.channelId != null && (if (v.guildId != null) s.guilds.containsKey(v.guildId) else s.channels.containsKey(v.channelId))) {
                    if (last == null) set { it.copy(status = VStatus.WAITING) }
                    sendState(); waitForServer()
                } else if (v.channelId != null) { teardown(); _state.value = idle(v) }
            }
            "VOICE_SERVER_UPDATE" -> {
                if (str(d, "guild_id") != v.guildId || v.channelId == null) return
                str(d, "channel_id")?.let { c -> set { it.copy(channelId = c) } }
                val endpoint = str(d, "endpoint")
                if (endpoint == null) { teardown(); set { it.copy(status = VStatus.UNCONFIGURED, error = R.string.voice_err_unconfigured) }; return }
                connectBackend(endpoint, d.optString("token"))
            }
            "VOICE_STATE_UPDATE" -> {
                if (str(d, "user_id") != s.me?.id || v.channelId == null) return
                val ch = str(d, "channel_id")
                if (ch != null && d.optString("session_id") != s.sessionId) { teardown(); _state.value = idle(v); return } // joined elsewhere
                if (str(d, "guild_id") != v.guildId) return
                if (ringOnJoin != null && ch == ringOnJoin) {
                    val id = ringOnJoin!!
                    ringOnJoin = null
                    Session.scope.launch { runCatching { Session.rest.request("POST", "/channels/$id/call/ring", kotlinx.serialization.json.buildJsonObject { put("recipients", kotlinx.serialization.json.JsonNull) }) } }
                }
                if (ch == null) { teardown(); _state.value = idle(v); return } // disconnected by someone or something
                if (ch != v.channelId) set { it.copy(channelId = ch) } // moved; a fresh VOICE_SERVER_UPDATE follows
                syncMic() // server mute/deafen may have changed
            }
            "VOICE_CHANNEL_EFFECT_SEND" -> {
                if (str(d, "channel_id") != v.channelId) return
                val user = d.optString("user_id")
                val sound = str(d, "sound_id")
                if (sound != null && !deafened()) {
                    if (user !in prefs.mutedSoundboardUsers && prefs.soundboardVolume > 0f) {
                        val url = str(d, "sound_url")?.let { Config.cdn(it) } ?: Config.cdn("/soundboard-sounds/$sound")
                        Media.playSound(url, (d.optDouble("sound_volume", 1.0).toFloat() * prefs.soundboardVolume).coerceIn(0f, 2f))
                    }
                }
                val emoji = d.optJSONObject("emoji")?.optString("name")?.ifEmpty { null } ?: "🔊"
                set { it.copy(effects = it.effects + (user to emoji)) }
                scope.launch { delay(3000); set { it.copy(effects = it.effects - user) } }
            }
            "CHANNEL_DELETE" -> if (str(d, "id") == v.channelId && v.channelId != null) { teardown(); _state.value = idle(v) }
            "GUILD_DELETE" -> if (str(d, "id") == v.guildId && v.guildId != null) { teardown(); _state.value = idle(v) }
            else -> backend?.onGateway(t, d)
        }
    }
}
