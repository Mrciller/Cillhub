package io.github.mrciller.cillhub

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.util.Log
import androidx.core.app.RemoteInput
import androidx.core.content.IntentCompat

/** Notification actions (reply, mark as read, decline, hang up), the daily update alarm and installer status. Not exported. */
class ActionReceiver : BroadcastReceiver() {
    companion object {
        const val REPLY = "io.github.mrciller.cillhub.REPLY"
        const val MARK_READ = "io.github.mrciller.cillhub.MARK_READ"
        const val DECLINE = "io.github.mrciller.cillhub.DECLINE"
        const val HANG_UP = "io.github.mrciller.cillhub.HANG_UP"
        const val TOGGLE_MUTE = "io.github.mrciller.cillhub.TOGGLE_MUTE"
        const val CHECK_UPDATE = "io.github.mrciller.cillhub.CHECK_UPDATE"
        const val INSTALL_STATUS = "io.github.mrciller.cillhub.INSTALL_STATUS"
        const val EXTRA_CHANNEL = "channel_id"
        const val EXTRA_MESSAGE = "message_id"
        const val REPLY_SCHEME = "cillhub-reply"
        private const val TAG = "CillcordAction"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val ctx = context.applicationContext
        val channel = BridgeMessage.snowflake(if (intent.action == REPLY) intent.data?.takeIf { it.scheme == REPLY_SCHEME }?.schemeSpecificPart else intent.getStringExtra(EXTRA_CHANNEL))
        when (intent.action) {
            REPLY -> {
                val text = RemoteInput.getResultsFromIntent(intent)?.getCharSequence(Notifications.REPLY_KEY)?.toString()?.trim()
                if (channel == null || text.isNullOrEmpty()) return
                background {
                    try {
                        Api.of(ctx)?.send(channel, text.take(2000)) ?: return@background
                        Notifications.read(ctx, channel, null) // sending marks the channel read on the server too
                    } catch (e: Exception) {
                        Log.w(TAG, "reply failed: ${e.message}")
                        Notifications.repost(ctx, channel)
                    }
                }
            }
            MARK_READ -> {
                val message = BridgeMessage.snowflake(intent.getStringExtra(EXTRA_MESSAGE))
                if (channel == null) return
                Notifications.read(ctx, channel, null)
                if (message != null) background {
                    try { Api.of(ctx)?.ack(channel, message) } catch (e: Exception) { Log.w(TAG, "ack failed: ${e.message}") }
                }
            }
            DECLINE -> if (channel != null) Calls.decline(ctx, channel)
            HANG_UP -> Calls.hangUp(ctx)
            TOGGLE_MUTE -> io.github.mrciller.cillhub.voice.Voice.let { it.setSelfMute(!it.state.value.selfMute) }
            CHECK_UPDATE -> background { Updater.checkInBackground(ctx) }
            INSTALL_STATUS -> {
                val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)
                if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
                    IntentCompat.getParcelableExtra(intent, Intent.EXTRA_INTENT, Intent::class.java)?.let {
                        ctx.startActivity(it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }
                } else if (status != PackageInstaller.STATUS_SUCCESS) {
                    Log.w(TAG, "install status $status: ${intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE)}")
                }
            }
        }
    }

    private fun background(block: () -> Unit) {
        val pending = goAsync()
        Thread { try { block() } finally { pending.finish() } }.start()
    }
}
