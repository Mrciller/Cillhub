package io.github.mrciller.cillhub

import org.json.JSONObject

/** One message as a notification shows it. */
data class Msg(val id: String, val authorId: String, val authorName: String, val avatar: String?, val text: String, val time: Long)

/** One channel's notification: its unread messages, newest last (pure state, unit-tested). */
class Conversation(val channelId: String, var guildId: String?, var title: String, var isGroup: Boolean) {
    val messages = ArrayList<Msg>()
    val path get() = "/channels/${guildId ?: "@me"}/$channelId"
}

class Conversations(private val cap: Int = 25) {
    private val map = LinkedHashMap<String, Conversation>()

    fun get(channelId: String): Conversation? = map[channelId]
    fun all(): List<Conversation> = map.values.toList()

    /** Adds a message (ignoring duplicates, e.g. the same message through FCM and the gateway). Null if it was a duplicate. */
    fun add(channelId: String, guildId: String?, title: String, isGroup: Boolean, msg: Msg): Conversation? {
        val c = map.getOrPut(channelId) { Conversation(channelId, guildId, title, isGroup) }
        c.title = title; c.isGroup = isGroup; c.guildId = guildId
        if (c.messages.any { it.id == msg.id }) return null
        c.messages.add(msg)
        c.messages.sortBy { it.id.toBigInteger() }
        while (c.messages.size > cap) c.messages.removeAt(0)
        return c
    }

    /** Read up to this message id (null = everything). True when nothing unread is left, so the notification goes. */
    fun read(channelId: String, upTo: String?): Boolean {
        val c = map[channelId] ?: return false
        if (upTo == null) { map.remove(channelId); return true }
        val limit = upTo.toBigInteger()
        c.messages.removeAll { it.id.toBigInteger() <= limit }
        if (c.messages.isEmpty()) { map.remove(channelId); return true }
        return false
    }

    fun clear() = map.clear()

    companion object {
        /** Notification text for a message: mentions resolved to names, custom emoji as :name:, attachments described. */
        fun text(m: JSONObject): String {
            var s = m.optString("content")
            val mentions = m.optJSONArray("mentions")
            if (mentions != null) for (i in 0 until mentions.length()) {
                val u = mentions.optJSONObject(i) ?: continue
                s = s.replace(Regex("<@!?${u.optString("id")}>"), "@" + displayName(u))
            }
            s = s.replace(Regex("<a?:(\\w+):\\d+>"), ":$1:")
                .replace(Regex("<@!?\\d+>"), "@someone")
                .replace(Regex("<@&\\d+>"), "@role")
                .replace(Regex("<#\\d+>"), "#channel")
            s = s.lines().joinToString("\n") { io.github.mrciller.cillhub.data.Md.plain(it) } // markdown shown as plain text
            if (s.isBlank()) {
                s = when {
                    (m.optJSONArray("attachments")?.length() ?: 0) > 0 -> "sent an attachment"
                    (m.optJSONArray("sticker_items")?.length() ?: 0) > 0 -> "sent a sticker"
                    (m.optJSONArray("embeds")?.length() ?: 0) > 0 ->
                        m.optJSONArray("embeds")!!.optJSONObject(0)?.let { it.optString("title").ifBlank { it.optString("description") } }?.ifBlank { null } ?: "sent an embed"
                    m.optJSONObject("poll") != null -> "started a poll"
                    else -> "sent a message"
                }
            }
            return if (s.length > 1000) s.take(999) + "…" else s
        }

        fun displayName(u: JSONObject): String =
            u.optString("global_name").takeIf { !u.isNull("global_name") && it.isNotBlank() } ?: u.optString("username", "Someone")

        /** Who wrote it: server nickname first, as the client shows it. */
        fun author(m: JSONObject): String {
            val nick = m.optJSONObject("member")?.let { if (it.isNull("nick")) null else it.optString("nick") }
            return nick?.takeIf { it.isNotBlank() } ?: displayName(m.optJSONObject("author") ?: JSONObject())
        }

        /** Notification title: the other person in a DM, the group's name, or #channel · Server. */
        fun title(ch: JSONObject, me: String?, guildName: String?): String = when (ch.optInt("type")) {
            1 -> recipients(ch, me).firstOrNull() ?: "Direct Message"
            3 -> ch.optString("name").takeIf { !ch.isNull("name") && it.isNotBlank() } ?: recipients(ch, me).joinToString(", ").ifBlank { "Group" }
            else -> "#" + ch.optString("name", "channel") + (guildName?.let { " · $it" } ?: "")
        }

        private fun recipients(ch: JSONObject, me: String?): List<String> {
            val r = ch.optJSONArray("recipients") ?: return emptyList()
            return (0 until r.length()).mapNotNull { r.optJSONObject(it) }.filter { it.optString("id") != me }.map { displayName(it) }
        }
    }
}
