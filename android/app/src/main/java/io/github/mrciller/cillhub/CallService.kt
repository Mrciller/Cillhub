package io.github.mrciller.cillhub

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.net.Uri
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.telecom.DisconnectCause
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.core.telecom.CallAttributesCompat
import androidx.core.telecom.CallsManager
import io.github.mrciller.cillhub.voice.AudioRouter
import io.github.mrciller.cillhub.voice.CallAudio
import io.github.mrciller.cillhub.voice.Voice
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

/**
 * Foreground service for the current call or voice channel. Hosts the Telecom call (Jetpack core-telecom): its callbacks
 * are what the lock screen, watches and Android Auto use, and Telecom owns audio focus and routing (CallAudio). Types:
 * phoneCall, plus microphone once connected, camera while the camera sends and mediaProjection while the screen is shared.
 * Holds the proximity wake lock while the call plays on the earpiece.
 */
class CallService : Service() {
    companion object {
        const val START = "start"
        const val ANSWER = "answer"
        const val CONNECTED = "connected"
        const val UPDATE = "update"
        const val END = "end"
        private const val PROJECTION = "projection"
        private const val TAG = "CillcordCallService"
        @Volatile private var running = false
        @Volatile private var projecting = false
        @Volatile private var projectionReady: CompletableDeferred<Boolean>? = null

        fun start(ctx: Context) = ContextCompat.startForegroundService(ctx, Intent(ctx, CallService::class.java).setAction(START))

        fun command(ctx: Context, action: String) {
            if (running) ctx.startService(Intent(ctx, CallService::class.java).setAction(action))
        }

        fun end(ctx: Context, cause: Int) {
            if (running) ctx.startService(Intent(ctx, CallService::class.java).setAction(END).putExtra("cause", cause))
        }

        /** Adds (or drops) the mediaProjection type; true once the service runs with it, which Android 14+ needs before the projection starts. */
        suspend fun projection(ctx: Context, on: Boolean): Boolean {
            projecting = on
            if (!running) return false
            projectionReady?.complete(false)
            val ready = CompletableDeferred<Boolean>().also { if (on) projectionReady = it }
            ctx.startService(Intent(ctx, CallService::class.java).setAction(PROJECTION).putExtra("enable", on))
            return if (on) ready.await() else true
        }
    }

    private sealed class Cmd {
        data object Answer : Cmd()
        data object Active : Cmd()
        data class Disconnect(val cause: Int) : Cmd()
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var telecom: CallsManager? = null
    private var cmds: Channel<Cmd>? = null
    private var callFor: String? = null
    private var proximity: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        telecom = try {
            CallsManager(this).also { it.registerAppWithTelecom(CallsManager.CAPABILITY_BASELINE or CallsManager.CAPABILITY_SUPPORTS_VIDEO_CALLING) }
        } catch (e: Exception) {
            Log.w(TAG, "Telecom unavailable: ${e.message}")
            null
        }
        // the screen goes dark while the phone is at the ear (earpiece route)
        scope.launch {
            CallAudio.state.collect { r ->
                val ear = r.current?.type == AudioRouter.Type.EARPIECE && Calls.current?.let { it.state != Calls.State.RINGING && it.native } == true
                proximityLock(ear)
            }
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val c = Calls.current
        when (intent?.action) {
            START -> {
                if (c == null) { foreground(null); stopSelf(); return START_NOT_STICKY }
                foreground(c)
                if (callFor != c.channelId) addCall(c)
            }
            ANSWER -> { cmds?.trySend(Cmd.Answer); c?.let { foreground(it) } }
            CONNECTED -> { cmds?.trySend(Cmd.Active); c?.let { foreground(it) }; CallAudio.refresh() }
            UPDATE -> { c?.let { foreground(it) }; CallAudio.refresh() }
            PROJECTION -> {
                val enable = intent?.getBooleanExtra("enable", projecting) ?: projecting
                projecting = enable
                val ok = c != null && foreground(c)
                val ready = projectionReady
                projectionReady = null
                ready?.complete(ok && projecting)
            }
            END -> {
                cmds?.trySend(Cmd.Disconnect(intent.getIntExtra("cause", DisconnectCause.LOCAL)))
                cmds = null; callFor = null
                CallAudio.stop()
                proximityLock(false)
                if (Calls.current == null) {
                    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
        }
        return START_NOT_STICKY
    }

    private fun granted(p: String) = ContextCompat.checkSelfPermission(this, p) == PackageManager.PERMISSION_GRANTED

    /** Starts or updates the foreground notification with the types the call needs now; false if the full set was refused. */
    private fun foreground(c: Calls.Call?): Boolean {
        val n = if (c != null) Calls.notification(this, c) else androidx.core.app.NotificationCompat.Builder(this, Notifications.CH_CONNECTION).setSmallIcon(R.drawable.ic_call).build()
        var type = 0
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            type = ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL
            val live = c != null && c.state != Calls.State.RINGING
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                if (live && granted(android.Manifest.permission.RECORD_AUDIO)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
                if (live && c?.native == true && Voice.state.value.video && granted(android.Manifest.permission.CAMERA)) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA
            }
            if (live && projecting) type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        }
        return try {
            ServiceCompat.startForeground(this, Notifications.ID_CALL, n, type)
            true
        } catch (e: Exception) {
            Log.w(TAG, "startForeground($type) failed: ${e.message}")
            ServiceCompat.startForeground(this, Notifications.ID_CALL, n, if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ServiceInfo.FOREGROUND_SERVICE_TYPE_PHONE_CALL else 0)
            false
        }
    }

    private fun proximityLock(on: Boolean) {
        if (on && proximity?.isHeld != true) {
            val pm = getSystemService(PowerManager::class.java)
            if (pm.isWakeLockLevelSupported(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK))
                proximity = pm.newWakeLock(PowerManager.PROXIMITY_SCREEN_OFF_WAKE_LOCK, "cillhub:proximity").also { it.acquire(4 * 3600_000L) }
        } else if (!on) {
            proximity?.takeIf { it.isHeld }?.release()
            proximity = null
        }
    }

    private fun addCall(c: Calls.Call) {
        val tm = telecom ?: return CallAudio.startManual(this)
        val channel = Channel<Cmd>(Channel.UNLIMITED)
        cmds = channel
        callFor = c.channelId
        val attrs = CallAttributesCompat(
            displayName = c.name,
            address = Uri.parse("cillcord:${c.channelId}"),
            direction = if (c.state == Calls.State.RINGING) CallAttributesCompat.DIRECTION_INCOMING else CallAttributesCompat.DIRECTION_OUTGOING,
            callType = CallAttributesCompat.CALL_TYPE_AUDIO_CALL,
            callCapabilities = 0,
        )
        val ctx = applicationContext
        scope.launch {
            try {
                tm.addCall(
                    attrs,
                    // from a watch, headset or the car: native voice joins without opening the app
                    onAnswer = { _ -> Calls.answer(ctx, c.channelId, openApp = false) },
                    onDisconnect = { _ ->
                        val cur = Calls.current
                        if (cur?.channelId == c.channelId) {
                            if (cur.state == Calls.State.RINGING) Calls.decline(ctx, c.channelId) else Calls.hangUp(ctx)
                        }
                    },
                    // another call (a phone call) holds ours, then gives it back
                    onSetActive = { Voice.setHeld(false) },
                    onSetInactive = { Voice.setHeld(true) },
                ) {
                    // CallControlScope is a CoroutineScope that lives as long as the Telecom call
                    CallAudio.telecom = { e -> launch { requestEndpointChange(e) } }
                    launch { availableEndpoints.collect { CallAudio.telecomEndpoints(it) } }
                    launch { currentCallEndpoint.collect { CallAudio.telecomCurrent(it) } }
                    // mute from the car's or the system's call controls
                    launch { isMuted.drop(1).collect { m -> if (c.native && m != Voice.state.value.selfMute) Voice.setSelfMute(m) } }
                    launch {
                        if (c.state != Calls.State.RINGING) setActive()
                        for (cmd in channel) {
                            when (cmd) {
                                Cmd.Answer -> answer(CallAttributesCompat.CALL_TYPE_AUDIO_CALL)
                                Cmd.Active -> setActive()
                                is Cmd.Disconnect -> { disconnect(DisconnectCause(cmd.cause)); this@addCall.cancel(); break }
                            }
                        }
                    }
                }
            } catch (e: kotlinx.coroutines.CancellationException) {
                // service ended
            } catch (e: Exception) {
                Log.w(TAG, "Telecom call failed: ${e.message}")
                if (callFor == c.channelId) CallAudio.startManual(ctx)
            }
        }
    }

    override fun onDestroy() {
        running = false
        projecting = false
        projectionReady?.complete(false)
        CallAudio.stop()
        proximityLock(false)
        scope.cancel()
        super.onDestroy()
    }
}
