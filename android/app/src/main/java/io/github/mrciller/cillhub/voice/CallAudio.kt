package io.github.mrciller.cillhub.voice

import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.core.telecom.CallEndpointCompat
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Call audio for native voice: the route picker's state and how a route is applied. During a Telecom call (CallService)
 * Telecom owns routing, audio mode and focus, so routes are its endpoints; without Telecom (it refused the call) this
 * sets the communication mode, asks for audio focus and routes through AudioManager itself.
 */
object CallAudio {
    private const val TAG = "CillhubAudio"
    data class Routes(val devices: List<AudioRouter.Device> = emptyList(), val current: AudioRouter.Device? = null)

    private val _state = MutableStateFlow(Routes())
    val state: StateFlow<Routes> = _state
    /** Guild voice and calls with video play on the speaker; audio-only DM calls on the earpiece, like a phone call. */
    private val router = AudioRouter { Voice.state.value.let { v -> v.guildId != null || v.video || v.tiles.any { !it.local } } }

    // ---------- Telecom ----------
    private var endpoints: Map<String, CallEndpointCompat> = emptyMap()
    private var pending: String? = null
    /** Set by CallService while its Telecom call runs. */
    @Volatile var telecom: ((CallEndpointCompat) -> Unit)? = null

    private fun type(t: Int) = when (t) {
        CallEndpointCompat.TYPE_EARPIECE -> AudioRouter.Type.EARPIECE
        CallEndpointCompat.TYPE_WIRED_HEADSET -> AudioRouter.Type.WIRED
        CallEndpointCompat.TYPE_BLUETOOTH -> AudioRouter.Type.BLUETOOTH
        else -> AudioRouter.Type.SPEAKER
    }

    fun telecomEndpoints(list: List<CallEndpointCompat>) = synchronized(this) {
        val usable = list.filter { it.type != CallEndpointCompat.TYPE_STREAMING && it.type != CallEndpointCompat.TYPE_UNKNOWN }
        endpoints = usable.associateBy { it.identifier.toString() }
        apply(router.devices(usable.map { AudioRouter.Device(type(it.type), it.identifier.toString(), it.name.toString()) }))
    }

    /** Telecom's current endpoint: ours once a request settles, or one the user picked elsewhere (system UI, the car). */
    fun telecomCurrent(e: CallEndpointCompat) = synchronized(this) {
        val id = e.identifier.toString()
        if (pending != null) { if (id == pending) pending = null else return }
        if (id != router.current?.id && endpoints.containsKey(id)) router.choose(id)
        _state.value = Routes(router.available, router.current)
    }

    fun choose(id: String) = synchronized(this) { apply(router.choose(id)) }
    /** Video started or stopped, or a DM call became a guild call: the default route may change. */
    fun refresh() = synchronized(this) { apply(router.refresh()) }

    private fun apply(d: AudioRouter.Device?) {
        _state.value = Routes(router.available, d)
        if (d == null) return
        val t = telecom
        if (t != null) endpoints[d.id]?.let { pending = d.id; t(it) } else manualRoute(d)
    }

    // ---------- without Telecom ----------
    private var am: AudioManager? = null
    private var focus: AudioFocusRequest? = null
    private val deviceCallback = object : AudioDeviceCallback() {
        override fun onAudioDevicesAdded(added: Array<out AudioDeviceInfo>) = manualDevices()
        override fun onAudioDevicesRemoved(removed: Array<out AudioDeviceInfo>) = manualDevices()
    }

    fun startManual(ctx: Context) = synchronized(this) {
        if (am != null) return
        val a = ctx.getSystemService(AudioManager::class.java)
        am = a
        a.mode = AudioManager.MODE_IN_COMMUNICATION
        val attrs = AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION).setContentType(AudioAttributes.CONTENT_TYPE_SPEECH).build()
        focus = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT).setAudioAttributes(attrs)
            .setOnAudioFocusChangeListener { f -> Voice.setHeld(f == AudioManager.AUDIOFOCUS_LOSS || f == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) }.build()
            .also { a.requestAudioFocus(it) }
        a.registerAudioDeviceCallback(deviceCallback, Handler(Looper.getMainLooper()))
        manualDevices()
    }

    fun stop() = synchronized(this) {
        telecom = null; pending = null; endpoints = emptyMap()
        am?.let { a ->
            a.unregisterAudioDeviceCallback(deviceCallback)
            focus?.let { a.abandonAudioFocusRequest(it) }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) a.clearCommunicationDevice() else @Suppress("DEPRECATION") run { a.isSpeakerphoneOn = false; a.stopBluetoothSco() }
            a.mode = AudioManager.MODE_NORMAL
        }
        am = null; focus = null
        router.devices(emptyList())
        _state.value = Routes()
    }

    private fun manualType(t: Int) = when (t) {
        AudioDeviceInfo.TYPE_BUILTIN_EARPIECE -> AudioRouter.Type.EARPIECE
        AudioDeviceInfo.TYPE_BUILTIN_SPEAKER -> AudioRouter.Type.SPEAKER
        AudioDeviceInfo.TYPE_WIRED_HEADSET, AudioDeviceInfo.TYPE_WIRED_HEADPHONES, AudioDeviceInfo.TYPE_USB_HEADSET -> AudioRouter.Type.WIRED
        AudioDeviceInfo.TYPE_BLUETOOTH_SCO -> AudioRouter.Type.BLUETOOTH
        else -> null
    }

    private fun manualDevices() = synchronized(this) {
        val a = am ?: return
        val list = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) a.availableCommunicationDevices
        else a.getDevices(AudioManager.GET_DEVICES_OUTPUTS).toList()
        apply(router.devices(list.mapNotNull { d -> manualType(d.type)?.let { AudioRouter.Device(it, if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) d.id.toString() else it.name, d.productName.toString()) } }.distinctBy { it.id }))
    }

    private fun manualRoute(d: AudioRouter.Device) {
        val a = am ?: return
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) a.availableCommunicationDevices.firstOrNull { it.id.toString() == d.id }?.let { a.setCommunicationDevice(it) }
            else @Suppress("DEPRECATION") {
                a.isSpeakerphoneOn = d.type == AudioRouter.Type.SPEAKER
                if (d.type == AudioRouter.Type.BLUETOOTH) a.startBluetoothSco() else a.stopBluetoothSco()
            }
        } catch (e: Exception) { Log.w(TAG, "route: ${e.message}") }
    }
}
