package io.github.mrciller.cillhub.data

import java.time.Instant

/** Derived state: permissions, names, unread (client/src/selectors.ts). Pure functions over [State]. */
object Sel {
    /** Channels with a message list: text, DM, voice text chat, group DM, announcement, threads, stage. */
    val CHAT_TYPES = setOf(0, 1, 2, 3, 5, 10, 11, 12, 13)
    val VOICE_TYPES = setOf(2, 13)
    /** Text channels this app opens natively (voice, stage and forum are later phases). */
    val TEXT_TYPES = setOf(0, 1, 3, 5, 10, 11, 12)

    fun myMember(s: State, guildId: String?) = guildId?.let { g -> s.me?.let { s.members[g]?.get(it.id) } }

    private fun parentOf(s: State, c: Channel?) = if (Perm.isThread(c) && c?.parentId != null) s.channels[c.parentId] else null

    /** Permissions of the current user in a guild or one of its channels; DMs allow what a DM participant can do. */
    fun perms(s: State, guildId: String?, channel: Channel? = null): Long {
        val guild = guildId?.let { s.guilds[it] }
        val me = s.me?.id
        if (guild == null || me == null) return if (isPrivate(channel)) Perm.DM else 0L
        val member = myMember(s, guildId)
        return if (channel != null) Perm.channel(guild, me, member, channel, parentOf(s, channel)) else Perm.base(guild, me, member)
    }

    fun can(s: State, channel: Channel, bit: Long) = Perm.has(perms(s, channel.guildId, channel), bit)

    /** Adding a new reaction requires both ADD_REACTIONS and READ_MESSAGE_HISTORY (client/src/chat/MessageItem.tsx). */
    fun canAddReaction(perms: Long) = Perm.has(perms, Perm.ADD_REACTIONS) && Perm.has(perms, Perm.READ_MESSAGE_HISTORY)

    fun memberName(s: State, guildId: String?, userId: String): String =
        guildId?.let { s.members[it]?.get(userId)?.nick }?.takeIf { it.isNotBlank() } ?: s.users[userId]?.displayName ?: "Unknown"

    /** Colour of the member's highest coloured role (0xRRGGBB), or null. */
    fun roleColor(s: State, guildId: String?, userId: String): Int? {
        val g = guildId?.let { s.guilds[it] } ?: return null
        val m = s.members[g.id]?.get(userId) ?: return null
        return g.roles.filter { it.color != 0 && it.id in m.roles }.maxByOrNull { it.position }?.color
    }

    private fun muteActive(muted: Boolean, cfg: MuteConfig?, now: Instant): Boolean =
        muted && (cfg?.endTime == null || runCatching { Instant.parse(cfg.endTime).isAfter(now) }.getOrDefault(true))

    fun settingsKey(c: Channel?) = c?.guildId ?: "@me"
    fun isGuildMuted(s: State, guildId: String, now: Instant = Instant.now()) = s.guildSettings[guildId]?.let { muteActive(it.muted, it.muteConfig, now) } ?: false

    /** Muted by its own override or its category's (threads follow their parent). */
    fun isChannelMuted(s: State, c: Channel, now: Instant = Instant.now()): Boolean {
        val o = s.guildSettings[settingsKey(c)]?.channelOverrides?.firstOrNull { it.channelId == c.id }
        if (o != null && muteActive(o.muted, o.muteConfig, now)) return true
        return c.parentId?.let { s.channels[it] }?.let { isChannelMuted(s, it, now) } ?: false
    }

    /** Unread: newer last_message_id than the read state; muted channels never look unread (mentions still badge). */
    fun isUnread(s: State, c: Channel, now: Instant = Instant.now()): Boolean {
        if (c.type !in CHAT_TYPES || c.lastMessageId == null) return false
        if (isChannelMuted(s, c, now)) return false
        val read = s.readStates[c.id]?.lastMessageId
        return read == null || cmpId(c.lastMessageId, read) > 0
    }

    fun mentions(s: State, channelId: String) = s.readStates[channelId]?.mentionCount ?: 0

    data class Group(val category: Channel?, val channels: List<Channel>)

    private val byPos = Comparator<Channel> { a, b -> if (a.position != b.position) a.position - b.position else cmpId(a.id, b.id) }
    private val inGroup = Comparator<Channel> { a, b ->
        val v = (if (a.type in VOICE_TYPES) 1 else 0) - (if (b.type in VOICE_TYPES) 1 else 0)
        if (v != 0) v else byPos.compare(a, b)
    }

    /** Channels the user can VIEW, in sidebar order: uncategorized first, then categories by position. */
    fun sidebar(s: State, guildId: String): List<Group> {
        val all = s.channels.values.filter { it.guildId == guildId && !Perm.isThread(it) }
        val view = { c: Channel -> Perm.has(perms(s, guildId, c), Perm.VIEW_CHANNEL) }
        val cats = all.filter { it.type == 4 }.sortedWith(byPos)
        val catIds = cats.map { it.id }.toSet()
        fun children(id: String?) = all.filter { it.type != 4 && (if (id != null) it.parentId == id else it.parentId == null || it.parentId !in catIds) && view(it) }.sortedWith(inGroup)
        val out = mutableListOf(Group(null, children(null)))
        for (cat in cats) {
            val ch = children(cat.id)
            if (ch.isNotEmpty() || view(cat)) out += Group(cat, ch)
        }
        return out
    }

    /** Where a guild opens: its system channel if visible, else the first text channel. */
    fun firstText(s: State, guildId: String): Channel? {
        val list = sidebar(s, guildId).flatMap { it.channels }.filter { it.type == 0 || it.type == 5 }
        return list.firstOrNull { it.id == s.guilds[guildId]?.systemChannelId } ?: list.firstOrNull()
    }

    data class Badge(val unread: Boolean, val mentions: Int)

    fun guildBadge(s: State, guildId: String): Badge {
        val muted = isGuildMuted(s, guildId)
        var unread = false
        var mentions = 0
        for (g in sidebar(s, guildId)) for (c in g.channels) {
            unread = unread || (!muted && isUnread(s, c))
            mentions += mentions(s, c.id)
        }
        return Badge(unread, mentions)
    }

    /** DMs and group DMs, newest activity first. */
    fun privateChannels(s: State): List<Channel> =
        s.channels.values.filter { isPrivate(it) }.sortedWith { a, b -> cmpId(b.lastMessageId ?: b.id, a.lastMessageId ?: a.id) }

    fun privateName(s: State, c: Channel): String = when (c.type) {
        3 -> c.name?.takeIf { it.isNotBlank() } ?: c.recipients.joinToString(", ") { (s.users[it.id] ?: it).displayName }.ifBlank { "Unnamed" }
        else -> c.recipients.firstOrNull()?.let { (s.users[it.id] ?: it).displayName } ?: "Unknown"
    }

    fun channelName(s: State, c: Channel) = if (isPrivate(c)) privateName(s, c) else c.name ?: ""

    /** Unread channels for the inbox: visible, not muted, newest first. */
    fun unreadChannels(s: State): List<Channel> = s.channels.values.filter { c ->
        val visible = if (c.guildId != null) s.guilds.containsKey(c.guildId) && Perm.has(perms(s, c.guildId, c), Perm.VIEW_CHANNEL) else isPrivate(c)
        visible && (isUnread(s, c) || mentions(s, c.id) > 0)
    }.sortedWith { a, b -> cmpId(b.lastMessageId ?: b.id, a.lastMessageId ?: a.id) }

    /** Unread badge for the Messages tab: DMs with unread messages or mentions. */
    fun unreadDms(s: State, now: Instant = Instant.now()) = privateChannels(s).count { isUnread(s, it, now) || mentions(s, it.id) > 0 }

    fun isBlocked(s: State, userId: String) = s.relationships[userId]?.type == 2

    /** Names of people typing in a channel right now. */
    fun typing(s: State, channelId: String, now: Long = System.currentTimeMillis()): List<String> {
        val ch = s.channels[channelId]
        return s.typing[channelId].orEmpty().filter { it.value > now && it.key != s.me?.id }.keys.map { memberName(s, ch?.guildId, it) }
    }

    /** Presence for display: our own comes from the chosen status. */
    fun presence(s: State, userId: String) = s.presences[userId] ?: "offline"

    fun customStatus(s: State, userId: String) = s.activities[userId]?.firstOrNull { it.type == 4 }

    /** Who is in a voice channel or DM call, in join order as the server sent them. */
    fun voiceUsers(s: State, guildId: String?, channelId: String): List<VoiceState> =
        s.voiceStates[voiceKey(guildId)].orEmpty().values.filter { it.channelId == channelId }

    /** Our own voice state on this account (any device), or null. */
    fun myVoice(s: State): VoiceState? {
        val me = s.me?.id ?: return null
        return s.voiceStates.values.firstNotNullOfOrNull { it[me] }
    }

    /** CONNECT and room left (or MOVE_MEMBERS), selectors.ts canJoinVoice. */
    fun canJoinVoice(s: State, c: Channel): Boolean {
        if (isPrivate(c)) return true
        val p = perms(s, c.guildId, c)
        val n = voiceUsers(s, c.guildId, c.id).size
        return Perm.has(p, Perm.CONNECT) && (c.userLimit == 0 || n < c.userLimit || Perm.has(p, Perm.MOVE_MEMBERS))
    }

    /** "Anna, Ben +2" for a channel row (the car list and notifications). */
    fun voiceSummary(s: State, guildId: String?, channelId: String, max: Int = 2): String {
        val names = voiceUsers(s, guildId, channelId).map { memberName(s, guildId, it.userId) }
        return if (names.size <= max) names.joinToString(", ") else names.take(max).joinToString(", ") + " +${names.size - max}"
    }
}
