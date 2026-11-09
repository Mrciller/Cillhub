package io.github.mrciller.cillhub.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

enum class Conn { OFFLINE, CONNECTING, READY }

/** Everything the UI shows, as one immutable value (the native counterpart of client/src/store.ts). */
data class State(
    val conn: Conn = Conn.OFFLINE,
    val me: User? = null,
    /** In READY order, later joins appended. */
    val guilds: Map<String, Guild> = emptyMap(),
    val channels: Map<String, Channel> = emptyMap(),
    val users: Map<String, User> = emptyMap(),
    /** guild id -> user id -> member */
    val members: Map<String, Map<String, Member>> = emptyMap(),
    val membersLoaded: Set<String> = emptySet(),
    val presences: Map<String, String> = emptyMap(),
    val activities: Map<String, List<Activity>> = emptyMap(),
    val readStates: Map<String, ReadState> = emptyMap(),
    val relationships: Map<String, Relationship> = emptyMap(),
    /** guild id ("@me" for DMs) -> settings */
    val guildSettings: Map<String, UserGuildSettings> = emptyMap(),
    /** channel id -> messages, oldest first; only channels that were opened */
    val messages: Map<String, List<Message>> = emptyMap(),
    val hasMore: Map<String, Boolean> = emptyMap(),
    /** channel id -> user id -> expiry (epoch ms) */
    val typing: Map<String, Map<String, Long>> = emptyMap(),
    /** The status the user chose (READY user_settings / USER_SETTINGS_UPDATE). */
    val myStatus: String = "online",
    /** This gateway session (READY), to tell our own voice state from one on another device. */
    val sessionId: String = "",
    /** guild id ("@me" for DM and group DM calls) -> user id -> voice state */
    val voiceStates: Map<String, Map<String, VoiceState>> = emptyMap(),
    /** DM channel id -> active call */
    val calls: Map<String, CallInfo> = emptyMap(),
    /** DM/Group DM channel id -> user id -> last read message id */
    val dmRecipientReads: Map<String, Map<String, String>> = emptyMap(),
    /** guild id -> snippets */
    val snippets: Map<String, List<Snippet>> = emptyMap(),
    /** channel id -> draft text */
    val drafts: Map<String, String> = emptyMap(),
    /** The settings document's favorite_gifs. */
    val favoriteGifs: List<FavoriteGif> = emptyList(),
)

/** Voice states are kept per guild; DM and group DM calls (guild_id null) live under "@me" (store.ts voiceKey). */
fun voiceKey(guildId: String?) = guildId ?: "@me"

/** Snowflake order: longer ids are newer; equal lengths compare as text (store.ts cmpId). */
fun cmpId(a: String, b: String): Int = if (a.length != b.length) a.length - b.length else a.compareTo(b)

fun isPrivate(c: Channel?) = c?.type == 1 || c?.type == 3

class Store {
    private val flow = MutableStateFlow(State())
    val state: StateFlow<State> = flow
    val value get() = flow.value

    fun update(f: (State) -> State) = flow.update(f)
    fun dispatch(t: String, d: JsonObject) = flow.update { Reducer.apply(it, t, d) }
    fun reset() { flow.value = State() }
}

/** Pure gateway-event reducer (unit-tested). REST results go through the same functions. */
object Reducer {
    const val TYPING_MS = 10_000L
    private const val EPHEMERAL = 1 shl 6

    private inline fun <reified T> JsonObject.decode(): T = json.decodeFromJsonElement(this)
    private fun JsonObject.str(k: String) = this[k]?.let { if (it is JsonObject) null else it.jsonPrimitive.contentOrNull }

    fun apply(s: State, t: String, d: JsonObject, now: Long = System.currentTimeMillis()): State = try { applyOrThrow(s, t, d, now) } catch (e: Exception) { s } // a malformed event never breaks the state

    private fun applyOrThrow(s: State, t: String, d: JsonObject, now: Long): State { return when (t) {
        "READY" -> ready(s, d.decode(), d)
        "GUILD_CREATE" -> addGuild(s, d.decode())
        "GUILD_UPDATE" -> d.decode<Guild>().let { g -> s.guilds[g.id]?.let { old -> s.copy(guilds = s.guilds + (g.id to g.copy(roles = g.roles.ifEmpty { old.roles }, channels = null, members = null, presences = null, threads = null, voiceStates = null))) } ?: s }
        "GUILD_DELETE" -> removeGuild(s, d.str("id") ?: "")
        "GUILD_ROLE_CREATE", "GUILD_ROLE_UPDATE" -> {
            val gid = d.str("guild_id") ?: ""
            val role = json.decodeFromJsonElement<Role>(d["role"]!!)
            s.guilds[gid]?.let { g -> s.copy(guilds = s.guilds + (gid to g.copy(roles = g.roles.filter { it.id != role.id } + role))) } ?: s
        }
        "GUILD_ROLE_DELETE" -> {
            val gid = d.str("guild_id") ?: ""
            val rid = d.str("role_id") ?: ""
            val g = s.guilds[gid] ?: return s
            val updatedMembers = s.members[gid]?.mapValues { (_, m) -> if (rid in m.roles) m.copy(roles = m.roles - rid) else m }
            val updatedChannels = s.channels.mapValues { (_, c) ->
                if (c.guildId == gid && c.permissionOverwrites.any { it.id == rid }) c.copy(permissionOverwrites = c.permissionOverwrites.filter { it.id != rid }) else c
            }
            s.copy(
                guilds = s.guilds + (gid to g.copy(roles = g.roles.filter { it.id != rid })),
                members = if (updatedMembers != null) s.members + (gid to updatedMembers) else s.members,
                channels = updatedChannels,
            )
        }
        "CHANNEL_CREATE", "CHANNEL_UPDATE", "THREAD_CREATE", "THREAD_UPDATE" -> d.decode<Channel>().let { c ->
            s.copy(channels = s.channels + (c.id to c), users = s.users + c.recipients.associateBy { it.id })
        }
        "CHANNEL_DELETE", "THREAD_DELETE" -> (d.str("id") ?: "").let { id -> s.copy(channels = s.channels - id, messages = s.messages - id) }
        "CHANNEL_RECIPIENT_ADD", "CHANNEL_RECIPIENT_REMOVE" -> {
            val cid = d.str("channel_id") ?: ""
            val u = json.decodeFromJsonElement<User>(d["user"]!!)
            val add = t == "CHANNEL_RECIPIENT_ADD"
            if (!add && u.id == s.me?.id) s.copy(channels = s.channels - cid)
            else s.channels[cid]?.let { c ->
                s.copy(channels = s.channels + (cid to c.copy(recipients = c.recipients.filter { it.id != u.id } + listOfNotNull(u.takeIf { add }))), users = s.users + (u.id to u))
            } ?: s
        }
        "MESSAGE_CREATE" -> addMessage(s, d.decode())
        "MESSAGE_UPDATE" -> updateMessage(s, d)
        "MESSAGE_DELETE" -> deleteMessages(s, d.str("channel_id") ?: "", setOfNotNull(d.str("id")))
        "MESSAGE_DELETE_BULK" -> {
            val ids = d["ids"]?.jsonArray?.map { it.jsonPrimitive.content }?.toSet() ?: emptySet()
            deleteMessages(s, d.str("channel_id") ?: "", ids)
        }
        "MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE" -> react(
            s, d.str("channel_id") ?: "", d.str("message_id") ?: "", d.str("user_id") ?: "",
            json.decodeFromJsonElement(d["emoji"]!!), t == "MESSAGE_REACTION_ADD",
        )
        "MESSAGE_REACTION_REMOVE_ALL" -> patchMessage(s, d.str("channel_id") ?: "", d.str("message_id") ?: "") { it.copy(reactions = emptyList()) }
        "MESSAGE_REACTION_REMOVE_EMOJI" -> {
            val e = json.decodeFromJsonElement<EmojiRef>(d["emoji"]!!)
            patchMessage(s, d.str("channel_id") ?: "", d.str("message_id") ?: "") { m -> m.copy(reactions = m.reactions.filter { it.emoji.key != e.key }) }
        }
        "MESSAGE_ACK" -> ack(s, d.str("channel_id") ?: "", d.str("message_id"))
        "CHANNEL_RECIPIENT_ACK" -> {
            val cid = d.str("channel_id") ?: return s
            val uid = d.str("user_id") ?: return s
            val mid = d.str("message_id") ?: return s
            val cur = s.dmRecipientReads[cid].orEmpty() + (uid to mid)
            s.copy(dmRecipientReads = s.dmRecipientReads + (cid to cur))
        }
        "MESSAGE_POLL_VOTE_ADD", "MESSAGE_POLL_VOTE_REMOVE" -> votePoll(s, d, t == "MESSAGE_POLL_VOTE_ADD")
        "THREAD_MEMBER_UPDATE" -> {
            val tm = d.decode<ThreadMember>()
            val cid = d.str("id") ?: tm.id ?: return s
            s.channels[cid]?.let { ch -> s.copy(channels = s.channels + (cid to ch.copy(member = tm))) } ?: s
        }
        "GUILD_MEMBER_ADD", "GUILD_MEMBER_UPDATE" -> {
            val gid = d.str("guild_id") ?: ""
            val m = d.decode<Member>()
            val u = m.user ?: return s
            val old = s.members[gid]?.get(u.id)
            val merged = if (old != null && t == "GUILD_MEMBER_UPDATE") m.copy(joinedAt = m.joinedAt.ifEmpty { old.joinedAt }) else m
            s.copy(users = s.users + (u.id to u), members = withMembers(s, gid, listOf(merged)))
        }
        // op 8's answer (Session.loadMembers asks for it when REST stopped at its 1000-member page)
        "GUILD_MEMBERS_CHUNK" -> {
            val gid = d.str("guild_id") ?: return s
            val list = d["members"]?.let { json.decodeFromJsonElement<List<Member>>(it) }.orEmpty()
            val pres = d["presences"]?.let { json.decodeFromJsonElement<List<Presence>>(it) }.orEmpty()
            s.copy(users = s.users + list.mapNotNull { it.user }.associateBy { it.id }, members = withMembers(s, gid, list),
                presences = s.presences + pres.associate { it.user.id to it.status })
        }
        "GUILD_MEMBER_REMOVE" -> {
            val gid = d.str("guild_id") ?: ""
            val uid = d["user"]?.jsonObject?.str("id") ?: ""
            if (uid == s.me?.id) removeGuild(s, gid) else s.copy(members = s.members + (gid to (s.members[gid].orEmpty() - uid)))
        }
        "USER_UPDATE" -> d.decode<User>().let { u ->
            val merged = (s.users[u.id] ?: u).let { old -> u.copy(email = u.email ?: old.email, bio = u.bio ?: old.bio, pronouns = u.pronouns ?: old.pronouns) }
            s.copy(users = s.users + (u.id to merged), me = if (s.me?.id == u.id) merged.copy(email = u.email ?: s.me.email, mfaEnabled = s.me.mfaEnabled || u.mfaEnabled) else s.me)
        }
        "RELATIONSHIP_ADD", "RELATIONSHIP_UPDATE" -> d.decode<Relationship>().let { r ->
            val merged = if (r.user == null) r.copy(user = s.relationships[r.id]?.user) else r
            s.copy(relationships = s.relationships + (r.id to merged), users = merged.user?.let { s.users + (it.id to it) } ?: s.users)
        }
        "RELATIONSHIP_REMOVE" -> s.copy(relationships = s.relationships - (d.str("id") ?: ""))
        "PRESENCE_UPDATE" -> d.decode<Presence>().let { p ->
            s.copy(presences = s.presences + (p.user.id to p.status), activities = p.activities?.let { s.activities + (p.user.id to it) } ?: s.activities)
        }
        "USER_SETTINGS_UPDATE" -> {
            val next = d.str("status")?.let { st ->
                s.copy(myStatus = st, presences = s.me?.let { s.presences + (it.id to (if (st == "invisible") "offline" else st)) } ?: s.presences)
            } ?: s
            d["favorite_gifs"]?.let { next.copy(favoriteGifs = json.decodeFromJsonElement(it)) } ?: next
        }
        "USER_GUILD_SETTINGS_UPDATE" -> d.decode<UserGuildSettings>().let { g -> s.copy(guildSettings = s.guildSettings + ((g.guildId ?: "@me") to g)) }
        "TYPING_START" -> {
            val cid = d.str("channel_id") ?: ""
            val uid = d.str("user_id") ?: ""
            if (uid == s.me?.id) s
            else {
                val member = d["member"]?.let { runCatching { json.decodeFromJsonElement<Member>(it) }.getOrNull() }
                val users = member?.user?.let { s.users + (it.id to it) } ?: s.users
                val live = s.typing[cid].orEmpty().filterValues { it > now } + (uid to now + TYPING_MS)
                s.copy(typing = s.typing + (cid to live), users = users)
            }
        }
        "VOICE_STATE_UPDATE" -> setVoiceState(s, d.decode())
        "VOICE_CHANNEL_STATUS_UPDATE" -> (d.str("id") ?: "").let { id ->
            s.channels[id]?.let { c -> s.copy(channels = s.channels + (id to c.copy(status = d.str("status")?.ifEmpty { null }))) } ?: s
        }
        "CALL_CREATE" -> {
            val call = d.decode<CallInfo>()
            val states = d["voice_states"]?.let { json.decodeFromJsonElement<List<VoiceState>>(it) }.orEmpty()
            states.fold(s.copy(calls = s.calls + (call.channelId to call))) { acc, v -> setVoiceState(acc, v.copy(guildId = null)) }
        }
        "CALL_UPDATE" -> d.decode<CallInfo>().let { c -> s.copy(calls = s.calls + (c.channelId to c)) }
        "CALL_DELETE" -> (d.str("channel_id") ?: "").let { id ->
            s.copy(calls = s.calls - id, voiceStates = s.voiceStates + ("@me" to s.voiceStates["@me"].orEmpty().filterValues { it.channelId != id }))
        }
        else -> s
    } }

    fun setVoiceState(s: State, v: VoiceState): State {
        val key = voiceKey(v.guildId)
        val g = s.voiceStates[key].orEmpty()
        val users = v.member?.user?.let { s.users + (it.id to it) } ?: s.users
        val members = if (v.guildId != null && v.member?.user != null) withMembers(s, v.guildId, listOf(v.member)) else s.members
        return s.copy(voiceStates = s.voiceStates + (key to (if (v.channelId != null) g + (v.userId to v.copy(member = null)) else g - v.userId)), users = users, members = members)
    }

    private fun ready(s: State, r: Ready, raw: JsonObject): State {
        // user_guild_settings is {entries: [...]} (v9) or a bare list
        val ugs = raw["user_guild_settings"]?.let { el ->
            val list = if (el is JsonObject) el["entries"]?.jsonArray else runCatching { el.jsonArray }.getOrNull()
            list?.mapNotNull { runCatching { json.decodeFromJsonElement<UserGuildSettings>(it) }.getOrNull() }
        }.orEmpty()
        val status = r.userSettings?.status ?: "online"
        val dmReads = mutableMapOf<String, MutableMap<String, String>>()
        for (rr in r.recipientReadStates) {
            dmReads.getOrPut(rr.channelId) { mutableMapOf() }[rr.userId] = rr.lastMessageId
        }
        var next = State(
            conn = Conn.READY, me = r.user,
            channels = r.privateChannels.associateBy { it.id },
            users = (r.users + r.privateChannels.flatMap { it.recipients } + r.relationships.mapNotNull { it.user } + r.user).associateBy { it.id },
            // READY leaves our own presence out: an open session means our chosen status
            presences = r.presences.associate { it.user.id to it.status } + (r.user.id to (if (status == "invisible") "offline" else status)),
            activities = r.presences.filter { it.activities != null }.associate { it.user.id to it.activities!! },
            readStates = r.readState.associateBy { it.id },
            relationships = r.relationships.associateBy { it.id },
            guildSettings = ugs.associateBy { it.guildId ?: "@me" },
            myStatus = status,
            sessionId = r.sessionId,
            favoriteGifs = r.userSettings?.favoriteGifs.orEmpty(),
            dmRecipientReads = dmReads.mapValues { it.value.toMap() },
            // a fresh session may have missed events: cached history is dropped and refetched on view
        )
        for (g in r.guilds) next = addGuild(next, g)
        return next
    }

    fun addGuild(s: State, g: Guild): State {
        val members = g.members.orEmpty() + g.voiceStates.orEmpty().mapNotNull { it.member }
        val channels = g.channels.orEmpty().map { if (it.guildId == null) it.copy(guildId = g.id) else it } + g.threads.orEmpty().map { it.copy(guildId = g.id) }
        return s.copy(
            guilds = s.guilds + (g.id to g.copy(channels = null, members = null, presences = null, threads = null, voiceStates = null)),
            voiceStates = g.voiceStates?.let { vs -> s.voiceStates + (g.id to vs.filter { it.channelId != null }.associate { it.userId to it.copy(guildId = g.id, member = null) }) } ?: s.voiceStates,
            channels = s.channels + channels.associateBy { it.id },
            members = withMembers(s, g.id, members),
            membersLoaded = if (g.members.orEmpty().isNotEmpty() && g.members.orEmpty().size >= g.memberCount) s.membersLoaded + g.id else s.membersLoaded,
            users = s.users + members.mapNotNull { it.user }.associateBy { it.id },
            presences = g.presences?.let { ps -> s.presences + ps.associate { it.user.id to it.status } } ?: s.presences,
        )
    }

    fun removeGuild(s: State, id: String) = s.copy(
        guilds = s.guilds - id,
        channels = s.channels.filterValues { it.guildId != id },
        members = s.members - id,
        membersLoaded = s.membersLoaded - id,
        voiceStates = s.voiceStates - id,
    )

    fun withMembers(s: State, guildId: String, list: List<Member>): Map<String, Map<String, Member>> =
        if (list.isEmpty()) s.members else s.members + (guildId to (s.members[guildId].orEmpty() + list.mapNotNull { m -> m.user?.let { it.id to m } }))

    /** Does this message ping the current user (directly, a role of theirs, @everyone/@here, or any DM)? store.ts mentionsMe. */
    fun mentionsMe(s: State, m: Message): Boolean {
        val me = s.me ?: return false
        if (m.author.id == me.id) return false
        if (m.guildId == null && isPrivate(s.channels[m.channelId])) return true
        val roles = m.guildId?.let { s.members[it]?.get(me.id)?.roles }.orEmpty()
        val gs = m.guildId?.let { s.guildSettings[it] }
        return m.mentions.any { it.id == me.id } || (m.mentionEveryone && gs?.suppressEveryone != true) ||
            (gs?.suppressRoles != true && m.mentionRoles.any { it in roles })
    }

    fun addMessage(s: State, m: Message): State {
        val ch = s.channels[m.channelId]
        val mine = m.author.id == s.me?.id
        val list = s.messages[m.channelId]
        var readStates = s.readStates
        if (!m.pending && ch != null && ch.lastMessageId != m.id && list?.any { it.id == m.id } != true) {
            val rs = s.readStates[ch.id]
            // own messages are read; others that ping us count up like the server's mention_count
            if (mine || m.flags and EPHEMERAL != 0) readStates = readStates + (ch.id to ReadState(ch.id, m.id, 0))
            else if (mentionsMe(s, m) && m.type != 7) readStates = readStates + (ch.id to ReadState(ch.id, rs?.lastMessageId, (rs?.mentionCount ?: 0) + 1))
        }
        val fresh = ch != null && !m.pending && (ch.lastMessageId == null || cmpId(m.id, ch.lastMessageId) > 0)
        val typing = s.typing[m.channelId]
        return s.copy(
            messages = if (list == null) s.messages else s.messages + (m.channelId to upsert(
                // our own echo replaces the optimistic copy with the same nonce
                if (!m.pending && m.nonce != null) list.filterNot { it.pending && it.nonce == m.nonce && it.id != m.id } else list, m,
            )),
            channels = if (fresh) s.channels + (ch!!.id to ch.copy(lastMessageId = m.id)) else s.channels,
            typing = if (typing?.containsKey(m.author.id) == true) s.typing + (m.channelId to typing - m.author.id) else s.typing,
            users = if (s.users.containsKey(m.author.id)) s.users else s.users + (m.author.id to m.author),
            readStates = readStates,
        )
    }

    private fun upsert(list: List<Message>, m: Message): List<Message> {
        val i = list.indexOfFirst { it.id == m.id }
        if (i >= 0) return list.toMutableList().also { it[i] = m }
        val p = list.indexOfFirst { it.pending || it.failed } // unsent messages stay at the bottom
        return if (p < 0 || m.pending) list + m else list.toMutableList().also { it.add(p, m) }
    }

    private fun patchUpdated(old: Message, d: JsonObject): Message {
        if (d.containsKey("author")) {
            val incoming = d.decode<Message>()
            return incoming.copy(referencedMessage = incoming.referencedMessage ?: old.referencedMessage)
        }
        // partial update (e.g. embeds unfurled, pinned)
        return old.copy(
            content = d.str("content") ?: old.content,
            editedTimestamp = d.str("edited_timestamp") ?: old.editedTimestamp,
            embeds = d["embeds"]?.let { json.decodeFromJsonElement<List<Embed>>(it) } ?: old.embeds,
            attachments = d["attachments"]?.let { json.decodeFromJsonElement<List<Attachment>>(it) } ?: old.attachments,
            pinned = d["pinned"]?.jsonPrimitive?.booleanOrNull ?: old.pinned,
            flags = d["flags"]?.jsonPrimitive?.intOrNull ?: old.flags,
            poll = d["poll"]?.let { json.decodeFromJsonElement<Poll>(it) } ?: old.poll,
        )
    }

    fun votePoll(s: State, d: JsonObject, add: Boolean): State {
        val cid = d.str("channel_id") ?: return s
        val mid = d.str("message_id") ?: return s
        val uid = d.str("user_id") ?: return s
        val aid = d["answer_id"]?.jsonPrimitive?.intOrNull ?: return s
        val correctId = d["correct_answer_id"]?.jsonPrimitive?.intOrNull
        val me = uid == s.me?.id
        return patchMessage(s, cid, mid) { m ->
            val poll = m.poll ?: return@patchMessage m
            val res = poll.results ?: PollResults()
            val counts = res.answerCounts
            val c = counts.firstOrNull { it.id == aid }
            if (me && (c?.meVoted ?: false) == add) return@patchMessage m
            val next = if (c != null) {
                counts.map { if (it.id == aid) it.copy(count = maxOf(0, it.count + if (add) 1 else -1), meVoted = if (me) add else it.meVoted) else it }
            } else if (add) {
                counts + PollAnswerCount(aid, 1, meVoted = me)
            } else counts
            m.copy(
                poll = poll.copy(
                    correctAnswerId = correctId ?: poll.correctAnswerId,
                    results = res.copy(answerCounts = next)
                )
            )
        }
    }

    private fun updateMessage(s: State, d: JsonObject): State {
        val cid = d.str("channel_id") ?: return s
        val id = d.str("id") ?: return s
        return patchList(s, cid) { list ->
            val updatedTarget = list.firstOrNull { it.id == id }?.let { patchUpdated(it, d) }
            list.map { m ->
                when {
                    m.id == id -> updatedTarget ?: patchUpdated(m, d)
                    m.referencedMessage?.id == id -> m.copy(referencedMessage = updatedTarget ?: patchUpdated(m.referencedMessage, d))
                    m.messageReference?.messageId == id && updatedTarget != null -> m.copy(referencedMessage = updatedTarget)
                    else -> m
                }
            }
        }
    }

    fun deleteMessages(s: State, cid: String, ids: Set<String>): State {
        if (ids.isEmpty()) return s
        val next = patchList(s, cid) { l ->
            l.filter { it.id !in ids }.map { m ->
                if (m.referencedMessage != null && (m.referencedMessage.id in ids || m.messageReference?.messageId in ids)) {
                    m.copy(referencedMessage = null)
                } else m
            }
        }
        val ch = next.channels[cid]
        if (ch != null && ch.lastMessageId in ids && next.messages.containsKey(cid)) {
            val newest = next.messages[cid].orEmpty().lastOrNull { !it.pending && !it.failed }?.id
            return next.copy(channels = next.channels + (cid to ch.copy(lastMessageId = newest)))
        }
        return next
    }

    fun patchList(s: State, cid: String, f: (List<Message>) -> List<Message>): State =
        s.messages[cid]?.let { s.copy(messages = s.messages + (cid to f(it))) } ?: s

    fun patchMessage(s: State, cid: String, id: String, f: (Message) -> Message) =
        patchList(s, cid) { l -> l.map { if (it.id == id) f(it) else it } }

    fun react(s: State, cid: String, mid: String, userId: String, emoji: EmojiRef, add: Boolean): State {
        val me = userId == s.me?.id
        return patchMessage(s, cid, mid) { m ->
            val r = m.reactions.firstOrNull { it.emoji.key == emoji.key }
            when {
                me && (r?.me ?: false) == add -> m // our own optimistic change already applied
                add -> m.copy(reactions = if (r != null) m.reactions.map { if (it === r) it.copy(count = it.count + 1, me = it.me || me) else it } else m.reactions + Reaction(emoji, 1, me))
                r == null -> m
                r.count <= 1 -> m.copy(reactions = m.reactions.filter { it !== r })
                else -> m.copy(reactions = m.reactions.map { if (it === r) it.copy(count = it.count - 1, me = if (me) false else it.me) else it })
            }
        }
    }

    fun ack(s: State, cid: String, messageId: String?) = s.copy(readStates = s.readStates + (cid to ReadState(cid, messageId, 0)))

    /** A page of history (newest first, as the API returns it) merged under what is loaded. */
    fun page(s: State, cid: String, page: List<Message>, before: String?, limit: Int): State {
        val sorted = page.sortedWith { a, b -> cmpId(a.id, b.id) }
        val old = if (before == null) s.messages[cid].orEmpty().filter { it.pending || it.failed } else s.messages[cid].orEmpty()
        val ids = sorted.map { it.id }.toSet()
        val merged = if (before == null) sorted + old else sorted + old.filter { it.id !in ids }
        return s.copy(
            messages = s.messages + (cid to merged),
            hasMore = s.hasMore + (cid to (page.size >= limit)),
            users = s.users + page.map { it.author }.associateBy { it.id },
        )
    }
}
