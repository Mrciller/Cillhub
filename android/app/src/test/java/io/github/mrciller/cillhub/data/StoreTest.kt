package io.github.mrciller.cillhub.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** Gateway reducer and unread/mention logic (store.ts / selectors.ts). */
class StoreTest {
    private fun o(s: String): JsonObject = json.parseToJsonElement(s).jsonObject
    private val ready = o("""{
      "v":9,"session_id":"s","user":{"id":"1","username":"me","email":"a@b.c"},
      "guilds":[{"id":"10","name":"G","owner_id":"2","member_count":2,
        "roles":[{"id":"10","name":"@everyone","position":0,"permissions":"70356545"},{"id":"11","name":"Team","position":1,"permissions":"0","color":3447003}],
        "channels":[{"id":"100","type":0,"name":"general","position":0,"last_message_id":"500","permission_overwrites":[]},
                    {"id":"101","type":4,"name":"Cat","position":0},
                    {"id":"102","type":0,"name":"secret","parent_id":"101","position":1,"last_message_id":"9","permission_overwrites":[{"id":"10","type":0,"allow":"0","deny":"1024"}]},
                    {"id":"103","type":2,"name":"Voice","parent_id":"101","position":0}],
        "members":[{"user":{"id":"1","username":"me"},"roles":["11"],"joined_at":"x"},{"user":{"id":"2","username":"bob","global_name":"Bob"},"roles":[],"joined_at":"x"}]}],
      "private_channels":[{"id":"200","type":1,"recipients":[{"id":"2","username":"bob"}],"last_message_id":"600"}],
      "users":[],"presences":[{"user":{"id":"2"},"status":"idle"}],
      "read_state":[{"id":"100","last_message_id":"500","mention_count":0},{"id":"200","last_message_id":"590","mention_count":1}],
      "relationships":[{"id":"2","type":1,"user":{"id":"2","username":"bob"}}],
      "user_settings":{"status":"dnd"},
      "user_guild_settings":{"entries":[{"guild_id":"10","muted":false,"channel_overrides":[]}]}
    }""")
    private fun msg(id: String, ch: String, author: String, extra: String = "") = o("""{"id":"$id","channel_id":"$ch","author":{"id":"$author","username":"u$author","global_name":${if (author == "2") "\"Bob\"" else "null"}},"content":"hi","timestamp":"2026-11-05T10:00:00Z"$extra}""")
    private var s = Reducer.apply(State(), "READY", ready)

    @Test fun readyBuildsTheState() {
        assertEquals(Conn.READY, s.conn)
        assertEquals("dnd", s.myStatus)
        assertEquals("dnd", s.presences["1"])
        assertEquals("idle", s.presences["2"])
        assertEquals(setOf("100", "101", "102", "103", "200"), s.channels.keys)
        assertEquals("10", s.channels["100"]!!.guildId)
        assertEquals("Bob", Sel.memberName(s, "10", "2"))
        assertEquals(3447003, Sel.roleColor(s, "10", "1"))
        assertEquals(1, s.guildSettings.size)
    }

    @Test fun sidebarHidesWhatTheUserCannotView() {
        val groups = Sel.sidebar(s, "10")
        assertEquals(listOf("100"), groups[0].channels.map { it.id })
        assertEquals("101", groups[1].category!!.id)
        assertEquals("voice only: #secret is denied to @everyone", listOf("103"), groups[1].channels.map { it.id })
        assertEquals("100", Sel.firstText(s, "10")!!.id)
    }

    @Test fun unreadAndMentions() {
        assertFalse("read up to 500", Sel.isUnread(s, s.channels["100"]!!))
        assertTrue("DM 600 > 590", Sel.isUnread(s, s.channels["200"]!!))
        assertEquals(1, Sel.mentions(s, "200"))
        s = Reducer.apply(s, "MESSAGE_CREATE", msg("501", "100", "2", ""","mentions":[{"id":"1","username":"me"}]"""))
        assertTrue(Sel.isUnread(s, s.channels["100"]!!))
        assertEquals("a mention counts up", 1, Sel.mentions(s, "100"))
        assertEquals(Sel.Badge(true, 1), Sel.guildBadge(s, "10"))
        s = Reducer.apply(s, "MESSAGE_ACK", o("""{"channel_id":"100","message_id":"501"}"""))
        assertFalse(Sel.isUnread(s, s.channels["100"]!!))
        assertEquals(0, Sel.mentions(s, "100"))
        assertEquals(listOf("200"), Sel.unreadChannels(s).map { it.id })
    }

    @Test fun mutedChannelIsNotUnreadButStillCountsMentions() {
        val mute = o("""{"guild_id":"10","channel_overrides":[{"channel_id":"100","muted":true,"mute_config":{"end_time":null}}]}""")
        s = Reducer.apply(s, "USER_GUILD_SETTINGS_UPDATE", mute)
        s = Reducer.apply(s, "MESSAGE_CREATE", msg("502", "100", "2", ""","mention_everyone":true"""))
        assertFalse(Sel.isUnread(s, s.channels["100"]!!))
        assertEquals(1, Sel.mentions(s, "100"))
        // a mute that ended no longer hides it
        val ended = o("""{"guild_id":"10","channel_overrides":[{"channel_id":"100","muted":true,"mute_config":{"end_time":"2026-01-01T00:00:00Z"}}]}""")
        s = Reducer.apply(s, "USER_GUILD_SETTINGS_UPDATE", ended)
        assertTrue(Sel.isUnread(s, s.channels["100"]!!, Instant.parse("2026-11-05T12:00:00Z")))
    }

    @Test fun ownMessageMarksReadAndEchoReplacesThePendingCopy() {
        s = Reducer.page(s, "100", emptyList(), null, 50)
        val me = s.me!!
        val pending = Message("pending-n1", channelId = "100", author = me, content = "hi", nonce = "n1", pending = true)
        s = Reducer.addMessage(s, pending)
        assertEquals(1, s.messages["100"]!!.size)
        s = Reducer.apply(s, "MESSAGE_CREATE", msg("503", "100", "1", ""","nonce":"n1""""))
        assertEquals(listOf("503"), s.messages["100"]!!.map { it.id })
        assertFalse(s.messages["100"]!![0].pending)
        assertEquals("503", s.readStates["100"]!!.lastMessageId)
    }

    @Test fun reactionsCountAndIgnoreOurOwnEcho() {
        s = Reducer.page(s, "100", listOf(json.decodeFromJsonElement(Message.serializer(), msg("510", "100", "2"))), null, 50)
        val ev = { user: String -> o("""{"user_id":"$user","channel_id":"100","message_id":"510","emoji":{"id":null,"name":"🔥"}}""") }
        s = Reducer.react(s, "100", "510", "1", EmojiRef(name = "🔥"), true) // optimistic
        s = Reducer.apply(s, "MESSAGE_REACTION_ADD", ev("1")) // echo: ignored
        s = Reducer.apply(s, "MESSAGE_REACTION_ADD", ev("2"))
        val r = s.messages["100"]!![0].reactions.single()
        assertEquals(2, r.count); assertTrue(r.me)
        s = Reducer.apply(s, "MESSAGE_REACTION_REMOVE", ev("1"))
        s = Reducer.apply(s, "MESSAGE_REACTION_REMOVE", ev("2"))
        assertTrue(s.messages["100"]!![0].reactions.isEmpty())
    }

    @Test fun pagingMergesOlderHistory() {
        val page = { ids: List<String> -> ids.map { json.decodeFromJsonElement(Message.serializer(), msg(it, "100", "2")) } }
        s = Reducer.page(s, "100", page(listOf("30", "29")), null, 2)
        assertEquals(true, s.hasMore["100"])
        s = Reducer.page(s, "100", page(listOf("28")), "29", 2)
        assertEquals(listOf("28", "29", "30"), s.messages["100"]!!.map { it.id })
        assertEquals(false, s.hasMore["100"])
    }

    @Test fun partialUpdateDeleteAndTyping() {
        s = Reducer.page(s, "100", listOf(json.decodeFromJsonElement(Message.serializer(), msg("520", "100", "2"))), null, 50)
        s = Reducer.apply(s, "MESSAGE_UPDATE", o("""{"id":"520","channel_id":"100","embeds":[{"title":"T"}]}"""))
        assertEquals("T", s.messages["100"]!![0].embeds.single().title)
        assertEquals("hi", s.messages["100"]!![0].content)
        s = Reducer.apply(s, "TYPING_START", o("""{"channel_id":"100","user_id":"2","timestamp":1}"""), now = 1000)
        assertEquals(listOf("Bob"), Sel.typing(s, "100", now = 2000))
        assertTrue(Sel.typing(s, "100", now = 20_000).isEmpty())
        s = Reducer.apply(s, "MESSAGE_DELETE", o("""{"id":"520","channel_id":"100"}"""))
        assertTrue(s.messages["100"]!!.isEmpty())
    }

    @Test fun membershipAndRelationships() {
        s = Reducer.apply(s, "GUILD_MEMBER_REMOVE", o("""{"guild_id":"10","user":{"id":"1"}}"""))
        assertNull("we were removed: the guild goes", s.guilds["10"])
        assertFalse(s.channels.containsKey("100"))
        s = Reducer.apply(s, "RELATIONSHIP_REMOVE", o("""{"id":"2","type":1}"""))
        assertTrue(s.relationships.isEmpty())
        s = Reducer.apply(s, "PRESENCE_UPDATE", o("""{"user":{"id":"2"},"status":"online","activities":[{"type":4,"name":"Custom Status","state":"scrims"}]}"""))
        assertEquals("scrims", Sel.customStatus(s, "2")!!.state)
    }

    @Test fun malformedEventsAreIgnored() {
        val before = s
        s = Reducer.apply(s, "MESSAGE_CREATE", o("""{"id":"1"}"""))
        assertEquals(before, s)
    }

    @Test fun snowflakeOrder() {
        assertTrue(cmpId("10", "9") > 0)
        assertTrue(cmpId("1234", "1235") < 0)
    }

    // ---------- voice (Phase 2) ----------

    private fun vs(user: String, ch: String?, guild: String? = "10", extra: String = "") =
        o("""{"guild_id":${guild?.let { "\"$it\"" } ?: "null"},"channel_id":${ch?.let { "\"$it\"" } ?: "null"},"user_id":"$user","session_id":"x","self_mute":false,"self_deaf":false,"mute":false,"deaf":false$extra}""")

    @Test fun voiceStatesJoinMoveAndLeave() {
        s = Reducer.apply(s, "VOICE_STATE_UPDATE", vs("2", "103", extra = ""","member":{"user":{"id":"2","username":"bob","global_name":"Bobby"},"roles":[],"joined_at":"x"}"""))
        assertEquals(listOf("2"), Sel.voiceUsers(s, "10", "103").map { it.userId })
        assertEquals("Bobby", s.users["2"]!!.displayName) // the member in the event updates the user
        s = Reducer.apply(s, "VOICE_STATE_UPDATE", vs("1", "103", extra = ""","self_mute":true"""))
        assertEquals("Bobby, me", Sel.voiceSummary(s, "10", "103"))
        assertTrue(Sel.myVoice(s)!!.selfMute)
        s = Reducer.apply(s, "VOICE_STATE_UPDATE", vs("2", null))
        assertEquals(listOf("1"), Sel.voiceUsers(s, "10", "103").map { it.userId })
        assertNull(s.voiceStates["10"]!!["2"])
    }

    @Test fun readyAndGuildCreateCarryVoiceStates() {
        val g = o("""{"id":"20","name":"H","owner_id":"1","channels":[{"id":"300","type":2,"name":"Lounge","user_limit":1}],
            "voice_states":[{"channel_id":"300","user_id":"2","session_id":"y","self_video":true,"member":{"user":{"id":"2","username":"bob"},"roles":[],"joined_at":"x"}}]}""")
        s = Reducer.apply(s, "GUILD_CREATE", g)
        val v = Sel.voiceUsers(s, "20", "300").single()
        assertEquals("20", v.guildId)
        assertTrue(v.selfVideo)
        assertNull(s.guilds["20"]!!.voiceStates)
        // full (user_limit 1) and we are the owner: MOVE_MEMBERS lets us in anyway
        assertTrue(Sel.canJoinVoice(s, s.channels["300"]!!))
        s = Reducer.apply(s, "GUILD_DELETE", o("""{"id":"20"}"""))
        assertNull(s.voiceStates["20"])
    }

    @Test fun aFullChannelKeepsOthersOut() {
        val full = s.channels["103"]!!.copy(userLimit = 1)
        s = s.copy(channels = s.channels + ("103" to full))
        assertTrue(Sel.canJoinVoice(s, full))
        s = Reducer.apply(s, "VOICE_STATE_UPDATE", vs("2", "103"))
        assertFalse(Sel.canJoinVoice(s, full))
    }

    @Test fun dmCallsLiveUnderMe() {
        s = Reducer.apply(s, "CALL_CREATE", o("""{"channel_id":"200","ringing":["1"],"voice_states":[{"channel_id":"200","user_id":"2","session_id":"z"}]}"""))
        assertEquals(listOf("1"), s.calls["200"]!!.ringing)
        assertEquals(listOf("2"), Sel.voiceUsers(s, null, "200").map { it.userId })
        s = Reducer.apply(s, "CALL_UPDATE", o("""{"channel_id":"200","ringing":[]}"""))
        assertEquals(emptyList<String>(), s.calls["200"]!!.ringing)
        s = Reducer.apply(s, "CALL_DELETE", o("""{"channel_id":"200"}"""))
        assertNull(s.calls["200"])
        assertTrue(Sel.voiceUsers(s, null, "200").isEmpty())
        assertTrue(Sel.canJoinVoice(s, s.channels["200"]!!))
    }

    @Test fun voiceChannelStatus() {
        s = Reducer.apply(s, "VOICE_CHANNEL_STATUS_UPDATE", o("""{"id":"103","guild_id":"10","status":"Scrim vs Team X"}"""))
        assertEquals("Scrim vs Team X", s.channels["103"]!!.status)
        s = Reducer.apply(s, "VOICE_CHANNEL_STATUS_UPDATE", o("""{"id":"103","guild_id":"10","status":""}"""))
        assertNull(s.channels["103"]!!.status)
    }

    @Test fun readyKeepsTheSessionId() = assertEquals("s", s.sessionId)

    @Test fun messageUpdateAndDeletePropagateToReplyPreviewsAndLastMessageId() {
        val original = json.decodeFromJsonElement(Message.serializer(), msg("601", "100", "2"))
        val reply = json.decodeFromJsonElement(
            Message.serializer(),
            msg("602", "100", "1", ""","type":19,"message_reference":{"message_id":"601","channel_id":"100"},"referenced_message":{"id":"601","channel_id":"100","author":{"id":"2","username":"u2","global_name":"Bob"},"content":"hi","timestamp":"2026-11-05T10:00:00Z"}"""),
        )
        s = Reducer.page(s, "100", listOf(reply, original), null, 50)
        s = s.copy(channels = s.channels + ("100" to s.channels["100"]!!.copy(lastMessageId = "602")))

        // Editing the original message updates referencedMessage on the reply
        s = Reducer.apply(s, "MESSAGE_UPDATE", o("""{"id":"601","channel_id":"100","content":"edited original","edited_timestamp":"2026-11-05T10:01:00Z"}"""))
        val updatedReply = s.messages["100"]!!.first { it.id == "602" }
        assertEquals("edited original", updatedReply.referencedMessage?.content)

        // Deleting the original message clears referencedMessage on the reply
        s = Reducer.apply(s, "MESSAGE_DELETE", o("""{"id":"601","channel_id":"100"}"""))
        val replyAfterDelete = s.messages["100"]!!.single()
        assertEquals("602", replyAfterDelete.id)
        assertNull("referencedMessage cleared so UI shows original deleted", replyAfterDelete.referencedMessage)

        // Deleting the newest message updates channel.lastMessageId to the remaining newest (or null when empty)
        s = Reducer.apply(s, "MESSAGE_DELETE", o("""{"id":"602","channel_id":"100"}"""))
        assertNull(s.channels["100"]!!.lastMessageId)
    }

    @Test fun guildRoleDeleteCleansMemberRolesAndChannelOverwrites() {
        // Give #secret (102) an overwrite on role 11 that denies SEND_MESSAGES (2048), while @everyone overwrite is cleared
        val secret = s.channels["102"]!!.copy(
            permissionOverwrites = listOf(Overwrite(id = "11", type = 0, allow = "1024", deny = "2048")),
        )
        s = s.copy(channels = s.channels + ("102" to secret))
        assertFalse("role 11 denies SEND_MESSAGES", Sel.can(s, s.channels["102"]!!, Perm.SEND_MESSAGES))

        s = Reducer.apply(s, "GUILD_ROLE_DELETE", o("""{"guild_id":"10","role_id":"11"}"""))
        assertFalse("role 11 removed from member", "11" in s.members["10"]!!["1"]!!.roles)
        assertTrue("role 11 overwrite removed from channel", s.channels["102"]!!.permissionOverwrites.none { it.id == "11" })
        assertTrue("member can send messages after role with deny overwrite is deleted", Sel.can(s, s.channels["102"]!!, Perm.SEND_MESSAGES))
    }

    @Test fun canAddReactionRequiresBothAddReactionsAndReadHistory() {
        assertTrue(Sel.canAddReaction(Perm.ADD_REACTIONS or Perm.READ_MESSAGE_HISTORY))
        assertFalse("READ_MESSAGE_HISTORY alone is not enough", Sel.canAddReaction(Perm.READ_MESSAGE_HISTORY))
        assertFalse("ADD_REACTIONS alone is not enough", Sel.canAddReaction(Perm.ADD_REACTIONS))
    }

    @Test fun unreadDmsIncludesMutedDmWithMentions() {
        val muteDm = o("""{"guild_id":null,"channel_overrides":[{"channel_id":"200","muted":true,"mute_config":{"end_time":null}}]}""")
        s = Reducer.apply(s, "USER_GUILD_SETTINGS_UPDATE", muteDm)
        assertFalse("muted DM is not unread by lastMessageId alone", Sel.isUnread(s, s.channels["200"]!!))
        assertEquals("muted DM with mentionCount=1 still counts in unreadDms badge", 1, Sel.unreadDms(s))
    }

    @Test fun favoriteGifsFromSettingsUpdate() {
        val gif = """{"url":"https://example.com/g","src":"https://example.com/g.gif","width":10,"height":20,"format":"gif"}"""
        s = Reducer.apply(s, "USER_SETTINGS_UPDATE", o("""{"favorite_gifs":[$gif]}"""))
        assertEquals(listOf(FavoriteGif("https://example.com/g", "https://example.com/g.gif", 10, 20, "gif")), s.favoriteGifs)
        assertEquals("other keys leave the status alone", "dnd", s.myStatus)
        s = Reducer.apply(s, "USER_SETTINGS_UPDATE", o("""{"status":"idle"}"""))
        assertEquals("idle", s.myStatus)
        assertEquals(1, s.favoriteGifs.size)
        val fromReady = Reducer.apply(State(), "READY", JsonObject(ready + ("user_settings" to o("""{"status":"online","favorite_gifs":[$gif]}"""))))
        assertEquals(1, fromReady.favoriteGifs.size)
    }

    @Test fun channelMembersGroupByHoistedRole() {
        s = Reducer.apply(s, "GUILD_ROLE_UPDATE", o("""{"guild_id":"10","role":{"id":"11","name":"Team","position":1,"permissions":"0","hoist":true}}"""))
        val groups = Sel.channelMembers(s, "10", s.channels["100"]!!)
        assertEquals(listOf("11", "online"), groups.map { it.key })
        assertEquals("Team", groups[0].role?.name)
        assertEquals(listOf("2"), groups[1].members.map { it.user!!.id })
        assertEquals("only the owner sees the hidden channel", listOf("online"), Sel.channelMembers(s, "10", s.channels["102"]!!).map { it.key })
        s = Reducer.apply(s, "PRESENCE_UPDATE", o("""{"user":{"id":"2"},"status":"offline"}"""))
        assertEquals(listOf("11", "offline"), Sel.channelMembers(s, "10", s.channels["100"]!!).map { it.key })
    }
}
