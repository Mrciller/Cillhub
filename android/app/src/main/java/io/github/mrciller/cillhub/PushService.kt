package io.github.mrciller.cillhub

import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage

/**
 * Firebase Cloud Messaging (only with a google-services.json). The server sends data-only messages with
 * ids, never message text: {type: "message", channel_id, message_id}, {type: "call", channel_id} or
 * {type: "notice", title, body, url}. The app fetches the content itself over HTTPS with its token.
 */
class PushService : FirebaseMessagingService() {
    @Deprecated("Firebase 26 also reports tokens through onRegistered")
    override fun onNewToken(token: String) = Delivery.register(applicationContext, token)

    override fun onRegistered(token: String) = Delivery.register(applicationContext, token)

    override fun onMessageReceived(message: RemoteMessage) {
        val d = message.data
        if (TokenStore.get(this) == null) return
        val channel = BridgeMessage.snowflake(d["channel_id"])
        when (d["type"]) {
            "message" -> { val id = BridgeMessage.snowflake(d["message_id"]); if (channel != null && id != null) Hub.onPushedMessage(channel, id) }
            "call" -> if (channel != null) Hub.onPushedCall(channel)
            "notice" -> {
                val url = d["url"]?.takeIf { it.startsWith("/") && !it.startsWith("//") } ?: "/channels/@me"
                Notifications.notice(this, d["title"].orEmpty().take(100), d["body"].orEmpty().take(200), url)
            }
        }
    }
}
