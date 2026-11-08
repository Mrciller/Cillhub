package io.github.mrciller.cillhub

import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/**
 * Which messages notify, mirroring the server's push rules (server/src/message.js bumpMentions and
 * server/src/userdata.js notifies): every DM and group DM message, guild messages that mention the user,
 * one of their roles or @everyone/@here; filtered by the user's notification settings and mutes.
 */
object NotifyRules {
    private const val SUPPRESS_NOTIFICATIONS = 1 shl 12
    private const val EPHEMERAL = 1 shl 6
    private val NOTIFIABLE_TYPES = setOf(0, 19, 20, 23)

    /** "dm" | "user" | "role" | "everyone" | null. myRoles is only asked when the message pings roles. */
    fun kind(m: JSONObject, me: String, isPrivate: Boolean, myRoles: () -> Set<String>): String? {
        if (m.optInt("flags") and (SUPPRESS_NOTIFICATIONS or EPHEMERAL) != 0) return null
        if (m.optInt("type", 0) !in NOTIFIABLE_TYPES) return null
        if (m.optJSONObject("author")?.optString("id") == me) return null
        if (isPrivate) return "dm"
        val mentions = m.optJSONArray("mentions") ?: JSONArray()
        for (i in 0 until mentions.length()) if (mentions.optJSONObject(i)?.optString("id") == me) return "user"
        val roles = m.optJSONArray("mention_roles")
        if (roles != null && roles.length() > 0) {
            val mine = myRoles()
            for (i in 0 until roles.length()) if (roles.optString(i) in mine) return "role"
        }
        if (m.optBoolean("mention_everyone")) return "everyone"
        return null
    }

    private fun muteActive(muted: Boolean, cfg: JSONObject?, now: Instant): Boolean {
        if (!muted) return false
        val end = cfg?.takeIf { !it.isNull("end_time") }?.optString("end_time")?.takeIf { it.isNotEmpty() } ?: return true
        return try { Instant.parse(end).isAfter(now) } catch (e: Exception) { true }
    }

    /** settings: the user_guild_settings entry for the channel's guild ("@me" for DMs), null = defaults. */
    fun allowed(settings: JSONObject?, channelId: String, parentId: String?, kind: String, now: Instant = Instant.now()): Boolean {
        val gs = settings ?: return true // defaults: mobile_push on, nothing muted, all messages
        if (!gs.optBoolean("mobile_push", true)) return false
        if (muteActive(gs.optBoolean("muted"), gs.optJSONObject("mute_config"), now)) return false
        val ids = listOfNotNull(channelId, parentId)
        val all = gs.optJSONArray("channel_overrides") ?: JSONArray()
        val overrides = (0 until all.length()).mapNotNull { all.optJSONObject(it) }.filter { it.optString("channel_id") in ids }
        if (overrides.any { muteActive(it.optBoolean("muted"), it.optJSONObject("mute_config"), now) }) return false
        val own = overrides.find { it.optString("channel_id") == channelId && it.optInt("message_notifications", 3) != 3 }
            ?: overrides.find { it.optInt("message_notifications", 3) != 3 }
        val level = own?.optInt("message_notifications") ?: gs.optInt("message_notifications", 0)
        if (level == 2) return false
        if (kind == "everyone" && gs.optBoolean("suppress_everyone")) return false
        if (kind == "role" && gs.optBoolean("suppress_roles")) return false
        return true
    }
}
