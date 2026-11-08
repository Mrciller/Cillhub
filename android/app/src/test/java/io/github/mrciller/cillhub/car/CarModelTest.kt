package io.github.mrciller.cillhub.car

import io.github.mrciller.cillhub.data.Message
import io.github.mrciller.cillhub.data.Reducer
import io.github.mrciller.cillhub.data.State
import io.github.mrciller.cillhub.data.json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class CarModelTest {
    private fun o(s: String) = json.parseToJsonElement(s).jsonObject
    private val ready = o("""{"session_id":"s","user":{"id":"1","username":"me"},
      "guilds":[{"id":"10","name":"Team","owner_id":"2","roles":[{"id":"10","permissions":"70356545"}],
        "channels":[{"id":"100","type":0,"name":"general","position":0,"last_message_id":"510"},{"id":"101","type":0,"name":"quiet","position":1,"last_message_id":"90"},
                    {"id":"103","type":2,"name":"Lounge","position":2},{"id":"104","type":2,"name":"Empty","position":3},
                    {"id":"105","type":2,"name":"Locked","position":4,"permission_overwrites":[{"id":"10","type":0,"allow":"0","deny":"1048576"}]}],
        "voice_states":[{"channel_id":"104","user_id":"2","session_id":"x"},{"channel_id":"104","user_id":"3","session_id":"y"},{"channel_id":"104","user_id":"4","session_id":"z"}],
        "members":[{"user":{"id":"1","username":"me"},"roles":[],"joined_at":"x"},{"user":{"id":"2","username":"bob","global_name":"Bob"},"roles":[],"joined_at":"x"},
                   {"user":{"id":"3","username":"cat"},"roles":[],"joined_at":"x"},{"user":{"id":"4","username":"dan"},"roles":[],"joined_at":"x"}]}],
      "private_channels":[{"id":"200","type":1,"recipients":[{"id":"2","username":"bob","global_name":"Bob"}],"last_message_id":"600"},
                          {"id":"201","type":3,"name":"Squad","recipients":[{"id":"2","username":"bob"},{"id":"3","username":"cat"}],"last_message_id":"300"}],
      "read_state":[{"id":"100","last_message_id":"500","mention_count":1},{"id":"101","last_message_id":"90"},{"id":"200","last_message_id":"590"},{"id":"201","last_message_id":"300"}]}""")
    private fun msg(id: String, ch: String, author: String, text: String) = json.decodeFromJsonElement(Message.serializer(),
        o("""{"id":"$id","channel_id":"$ch","author":{"id":"$author","username":"u$author","global_name":${if (author == "2") "\"Bob\"" else "null"}},"content":"$text","timestamp":"2026-11-05T10:00:00Z"}"""))
    private var s: State = Reducer.apply(State(), "READY", ready)

    @Test fun conversationsAreDmsAndUnreadServerChannelsNewestFirst() {
        val list = CarModel.conversations(s, 10)
        assertEquals(listOf("200", "100", "201"), list.map { it.channel.id }) // #quiet is read: not listed
        assertEquals(listOf("Bob", "#general · Team", "Squad"), list.map { it.title })
        assertEquals(listOf(false, true, true), list.map { it.group })
        assertFalse("history not fetched yet", list[0].loaded)
        assertEquals(2, CarModel.conversations(s, 2).size)
    }

    @Test fun newestMessagesWithReadFlags() {
        s = Reducer.page(s, "200", (0 until 8).map { msg((590 + it).toString(), "200", if (it == 7) "1" else "2", "m$it") }.reversed(), null, 50)
        val c = CarModel.conversations(s, 10).first()
        assertTrue(c.loaded)
        assertEquals(listOf("593", "594", "595", "596", "597"), c.messages.map { it.id })
        assertEquals(5, c.messages.size)
        assertEquals(listOf(false, false, false, false, true), c.messages.map { it.read }) // 593.. unread; our own counts as read
        assertEquals("Bob", c.messages[0].sender)
    }

    @Test fun voiceChannelsBusyFirstWithoutTheLockedOne() {
        val rows = CarModel.voiceChannels(s, 10)
        assertEquals(listOf("104", "103"), rows.map { it.channel.id })
        assertEquals("Bob, cat +1", rows[0].people)
        assertEquals("Empty · Team", rows[0].title)
        assertEquals("", rows[1].people)
    }
}
