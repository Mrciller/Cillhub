package io.github.mrciller.cillhub.car

import io.github.mrciller.cillhub.data.Channel
import io.github.mrciller.cillhub.data.Perm
import io.github.mrciller.cillhub.data.Seal
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.State
import io.github.mrciller.cillhub.data.cmpId
import io.github.mrciller.cillhub.data.isPrivate
import io.github.mrciller.cillhub.ui.instantOf

/** What the car screens show, derived from the app's state (pure, unit-tested); CarService turns it into templates. */
object CarModel {
    data class Msg(val id: String, val senderId: String, val sender: String, val text: String, val time: Long, val read: Boolean)
    data class Conversation(val channel: Channel, val title: String, val group: Boolean, val messages: List<Msg>, val loaded: Boolean)
    data class VoiceRow(val channel: Channel, val title: String, val people: String, val count: Int)

    /** DMs and group DMs by activity, plus server channels with unread messages or mentions; newest first. */
    fun conversations(s: State, limit: Int, perConversation: Int = 5): List<Conversation> {
        val dms = Sel.privateChannels(s)
        val guild = Sel.unreadChannels(s).filter { !isPrivate(it) && it.type in Sel.TEXT_TYPES }
        return (dms + guild).distinctBy { it.id }.sortedWith { a, b -> cmpId(b.lastMessageId ?: b.id, a.lastMessageId ?: a.id) }.take(limit).map { c ->
            val read = s.readStates[c.id]?.lastMessageId
            val list = s.messages[c.id].orEmpty().filter { !it.pending && !it.failed && (it.seal == null || it.seal == Seal.OPEN) && (it.content.isNotBlank() || it.attachments.isNotEmpty()) }.takeLast(perConversation)
            Conversation(
                c, title(s, c), c.type != 1,
                list.map { m ->
                    Msg(m.id, m.author.id, Sel.memberName(s, c.guildId, m.author.id), m.content.ifBlank { m.attachments.joinToString { it.filename } },
                        instantOf(m.timestamp)?.toEpochMilli() ?: 0L, m.author.id == s.me?.id || (read != null && cmpId(m.id, read) <= 0))
                },
                s.messages.containsKey(c.id),
            )
        }
    }

    /** "#general · Server" for server channels (as the notifications title them), the DM or group name otherwise. */
    fun title(s: State, c: Channel): String = if (isPrivate(c)) Sel.privateName(s, c) else "#${c.name ?: ""} · ${s.guilds[c.guildId]?.name ?: ""}"

    /** Voice channels and stages the user may join, the busy ones first, then by server and position. */
    fun voiceChannels(s: State, limit: Int): List<VoiceRow> =
        s.guilds.keys.flatMap { g -> Sel.sidebar(s, g).flatMap { it.channels }.filter { it.type in Sel.VOICE_TYPES && Perm.has(Sel.perms(s, g, it), Perm.CONNECT) } }
            .map { c -> VoiceRow(c, "${c.name ?: ""} · ${s.guilds[c.guildId]?.name ?: ""}", Sel.voiceSummary(s, c.guildId, c.id), Sel.voiceUsers(s, c.guildId, c.id).size) }
            .sortedByDescending { it.count }
            .take(limit)
}
