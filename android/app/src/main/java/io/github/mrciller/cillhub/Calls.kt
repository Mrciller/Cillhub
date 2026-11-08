package io.github.mrciller.cillhub

import android.app.Notification
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.telecom.DisconnectCause
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.voice.VStatus
import io.github.mrciller.cillhub.voice.Voice
import io.github.mrciller.cillhub.voice.VoiceUi
import org.json.JSONObject

/**
 * Calls on the phone: an incoming DM or group DM ring becomes a Telecom call (CallService, Jetpack core-telecom) with a
 * CallStyle notification, so it can be answered, declined and hung up from the lock screen, a watch or the car. Native
 * voice (Voice) runs the call; a guild voice channel is a Telecom call too, so audio focus, routing and interruptions
 * behave like a phone call. A voice connection made in the web client inside the app (WebCallActivity) is followed
 * through its bridge.
 */
object Calls {
    enum class State { RINGING, ACTIVE, VOICE }
    data class Call(
        val channelId: String, val name: String, val personId: String?, val isGroup: Boolean, val title: String,
        @Volatile var state: State, val guildId: String? = null,
        /** Run by native voice (not the web client). */
        val native: Boolean = true,
    )

    private const val TAG = "CillcordCalls"
    private const val RING_TIMEOUT_MS = 60_000L
    private val main = Handler(Looper.getMainLooper())
    @Volatile var current: Call? = null; private set
    private var lastVoice = VoiceUi()

    fun ring(ctx: Context, channelId: String, name: String, personId: String?, isGroup: Boolean, title: String) {
        synchronized(this) {
            if (current != null) return // one call at a time; the in-app call screen still shows the other ring
            current = Call(channelId, name, personId, isGroup, title, State.RINGING)
        }
        start(ctx)
        main.postDelayed({ if (current?.let { it.channelId == channelId && it.state == State.RINGING } == true) end(ctx, DisconnectCause.MISSED) }, RING_TIMEOUT_MS)
    }

    /** Our name left the ringing list (answered or declined elsewhere, or the caller gave up). */
    fun stopRinging(ctx: Context, channelId: String) {
        val c = current ?: return
        if (c.channelId == channelId && c.state == State.RINGING) end(ctx, DisconnectCause.MISSED)
    }

    fun remoteEnded(ctx: Context, channelId: String) {
        val c = current ?: return
        if (c.channelId == channelId && c.state == State.RINGING) end(ctx, DisconnectCause.MISSED)
    }

    /** Answer from the notification (the app is opening) or a remote surface (we open it): native voice joins the call. */
    fun answer(ctx: Context, channelId: String, openApp: Boolean) {
        val c = current ?: return
        if (c.channelId != channelId || c.state != State.RINGING) return
        c.state = State.ACTIVE
        CallService.command(ctx, CallService.ANSWER)
        Voice.join(null, channelId)
        if (openApp) try { ctx.startActivity(MainActivity.voiceIntent(ctx, channelId)) } catch (e: Exception) { Log.w(TAG, "could not open the app for the call: ${e.message}") }
    }

    fun decline(ctx: Context, channelId: String) {
        val c = current ?: return
        if (c.channelId != channelId || c.state != State.RINGING) return
        Thread { try { Api.of(ctx)?.stopRinging(channelId) } catch (e: Exception) { Log.w(TAG, "stop-ringing failed: ${e.message}") } }.start()
        end(ctx, DisconnectCause.REJECTED)
    }

    /** Hang up from the notification, the car or a headset. */
    fun hangUp(ctx: Context) {
        val c = current ?: return
        if (c.state == State.RINGING) return decline(ctx, c.channelId)
        if (c.native) Voice.leave() else WebLink.send(JSONObject().put("type", "leave-call"), queue = false)
        end(ctx, DisconnectCause.LOCAL)
    }

    /** Native voice changed (Voice.state, on the main thread): start, update or end the Telecom call. */
    fun onVoice(ctx: Context, v: VoiceUi) {
        val prev = lastVoice
        lastVoice = v
        val c = current
        val id = v.channelId
        if (id == null) {
            if (prev.channelId != null && c != null && c.native && c.state != State.RINGING) end(ctx, DisconnectCause.LOCAL)
            return
        }
        if (c == null || c.channelId != id) {
            if (c != null && c.state == State.RINGING && c.channelId != id) return // a ring for another call stays; one Telecom call at a time
            if (c != null) end(ctx, DisconnectCause.LOCAL) // moved to another channel
            val s = Session.store.value
            val ch = s.channels[id]
            val title = when {
                ch == null -> ctx.getString(R.string.voice_channel)
                v.guildId != null -> "#${ch.name ?: ""} · ${s.guilds[v.guildId]?.name ?: ""}"
                else -> Sel.privateName(s, ch)
            }
            val person = if (ch?.type == 1) ch.recipients.firstOrNull()?.id else null
            synchronized(this) { current = Call(id, title, person, v.guildId != null || ch?.type == 3, title, if (v.guildId != null) State.VOICE else State.ACTIVE, v.guildId) }
            start(ctx)
            return
        }
        if (c.state == State.RINGING) { c.state = State.ACTIVE; CallService.command(ctx, CallService.ANSWER) }
        if (v.status == VStatus.CONNECTED && prev.status != VStatus.CONNECTED) CallService.command(ctx, CallService.CONNECTED)
        else if (v.selfMute != prev.selfMute || v.video != prev.video || v.held != prev.held || v.status != prev.status) CallService.command(ctx, CallService.UPDATE)
    }

    /** The web client inside the app changed its voice connection (bridge "voice" message). */
    fun webVoice(ctx: Context, guildId: String?, channelId: String?) {
        val c = current
        if (channelId == null) { if (c != null && !c.native && c.state != State.RINGING) end(ctx, DisconnectCause.LOCAL); return }
        if (c != null && c.channelId == channelId && !c.native) { CallService.command(ctx, CallService.CONNECTED); return }
        if (c != null) end(ctx, DisconnectCause.LOCAL)
        val title = ctx.getString(if (guildId == null) R.string.call else R.string.voice_channel)
        synchronized(this) { current = Call(channelId, title, null, guildId != null, title, if (guildId == null) State.ACTIVE else State.VOICE, guildId, native = false) }
        start(ctx)
        CallService.command(ctx, CallService.CONNECTED)
    }

    fun end(ctx: Context, cause: Int) {
        synchronized(this) { current = null }
        CallService.end(ctx, cause)
        NotificationManagerCompat.from(ctx).cancel(Notifications.ID_CALL)
    }

    private fun start(ctx: Context) {
        try {
            CallService.start(ctx)
        } catch (e: Exception) {
            // not allowed to start a foreground service right now: ring with the notification alone (no Telecom)
            Log.w(TAG, "call service not started: ${e.message}")
            val c = current ?: return
            try { NotificationManagerCompat.from(ctx).notify(Notifications.ID_CALL, notification(ctx, c)) } catch (s: SecurityException) { }
        }
    }

    fun person(c: Call): Person = Person.Builder().setName(c.name).setKey(c.personId ?: c.channelId).setImportant(true).build()

    private fun broadcast(ctx: Context, code: Int, action: String, channelId: String? = null) = PendingIntent.getBroadcast(
        ctx, code, Intent(ctx, ActionReceiver::class.java).setAction(action).apply { channelId?.let { putExtra(ActionReceiver.EXTRA_CHANNEL, it) } },
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
    )

    fun notification(ctx: Context, c: Call): Notification {
        val open = if (c.native) MainActivity.voiceIntent(ctx, c.channelId) else WebCallActivity.intent(ctx, "/channels/${c.guildId ?: "@me"}/${c.channelId}")
        val b = NotificationCompat.Builder(ctx, Notifications.CH_CALLS)
            .setSmallIcon(R.drawable.ic_call)
            .setColor(0xFF22E1FF.toInt())
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setContentText(if (c.isGroup) c.title else ctx.getString(R.string.call_from_cillcord))
        val hangUp = broadcast(ctx, 11, ActionReceiver.HANG_UP)
        when (c.state) {
            State.RINGING -> {
                val answer = PendingIntent.getActivity(
                    ctx, 12, MainActivity.voiceIntent(ctx, c.channelId).setAction(MainActivity.ACTION_ANSWER),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
                )
                val full = PendingIntent.getActivity(ctx, 14, MainActivity.voiceIntent(ctx, c.channelId).putExtra(MainActivity.EXTRA_RINGING, true), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
                b.setStyle(NotificationCompat.CallStyle.forIncomingCall(person(c), broadcast(ctx, 13, ActionReceiver.DECLINE, c.channelId), answer))
                    .setFullScreenIntent(full, true)
                    .setContentIntent(full)
                    .setTimeoutAfter(RING_TIMEOUT_MS)
            }
            State.ACTIVE, State.VOICE -> {
                val v = Voice.state.value
                b.setStyle(NotificationCompat.CallStyle.forOngoingCall(person(c), hangUp))
                    .setContentIntent(PendingIntent.getActivity(ctx, 15, open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE))
                    .setUsesChronometer(true)
                    .setSilent(true)
                    .setContentText(if (c.state == State.VOICE) c.title else if (c.isGroup) c.title else ctx.getString(R.string.call_from_cillcord))
                if (c.native) b.addAction(
                    if (v.selfMute) R.drawable.ms_mic_off else R.drawable.ms_mic,
                    ctx.getString(if (v.selfMute) R.string.voice_unmute else R.string.voice_mute),
                    broadcast(ctx, 17, ActionReceiver.TOGGLE_MUTE),
                )
            }
        }
        return b.build()
    }
}
