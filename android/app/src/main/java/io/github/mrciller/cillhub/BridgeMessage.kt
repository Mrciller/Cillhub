package io.github.mrciller.cillhub

import org.json.JSONObject

/** Messages the web client posts to window.CillcordAndroid (see client/src/android/bridge.ts). */
sealed class BridgeMessage {
    data object Ready : BridgeMessage()
    data class Token(val token: String) : BridgeMessage()
    data object Logout : BridgeMessage()
    /** The web client's voice connection: channel null = disconnected; guildId null = DM/group call. */
    data class Voice(val guildId: String?, val channelId: String?) : BridgeMessage()

    companion object {
        private val TOKEN = Regex("^[A-Za-z0-9_\\-.]{20,200}$")
        private val SNOWFLAKE = Regex("^\\d{1,19}$")

        fun snowflake(v: Any?): String? = (v as? String)?.takeIf { SNOWFLAKE.matches(it) }

        /** Anything malformed is null and ignored: the page is trusted only to the shape it may send. */
        fun parse(data: String?): BridgeMessage? = try {
            val o = JSONObject(data ?: return null)
            when (o.optString("type")) {
                "ready" -> Ready
                "token" -> o.optString("token").takeIf { TOKEN.matches(it) }?.let { Token(it) }
                "logout" -> Logout
                "voice" -> {
                    val ch = if (o.isNull("channel_id")) null else snowflake(o.opt("channel_id")) ?: return null
                    val g = if (o.isNull("guild_id")) null else snowflake(o.opt("guild_id")) ?: return null
                    Voice(g, ch)
                }
                else -> null
            }
        } catch (e: Exception) {
            null
        }
    }
}
