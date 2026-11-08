package io.github.mrciller.cillhub

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ConversationsTest {
    private fun m(id: String, author: String = "2") = Msg(id, author, "Bob", null, "text $id", id.toLong())

    @Test fun groupsMessagesPerChannelInOrderWithoutDuplicates() {
        val c = Conversations(cap = 3)
        c.add("10", null, "Bob", false, m("5"))
        c.add("10", null, "Bob", false, m("3"))
        assertNull("same message from FCM and the gateway", c.add("10", null, "Bob", false, m("5")))
        c.add("11", "g", "#general · Team", true, m("4"))
        assertEquals(listOf("3", "5"), c.get("10")!!.messages.map { it.id })
        assertEquals(1, c.get("11")!!.messages.size)
        assertEquals("/channels/g/11", c.get("11")!!.path)
        assertEquals("/channels/@me/10", c.get("10")!!.path)
        c.add("10", null, "Bob", false, m("6")); c.add("10", null, "Bob", false, m("7"))
        assertEquals("capped, oldest dropped", listOf("5", "6", "7"), c.get("10")!!.messages.map { it.id })
    }

    @Test fun readRemovesUpToTheAckedMessage() {
        val c = Conversations()
        listOf("1", "2", "3").forEach { c.add("10", null, "Bob", false, m(it)) }
        assertFalse(c.read("10", "2"))
        assertEquals(listOf("3"), c.get("10")!!.messages.map { it.id })
        assertTrue(c.read("10", "3"))
        assertNull(c.get("10"))
        assertFalse("unknown channel", c.read("99", null))
        c.add("10", null, "Bob", false, m("4"))
        assertTrue(c.read("10", null))
    }

    @Test fun snowflakesCompareNumerically() {
        val c = Conversations()
        c.add("10", null, "Bob", false, m("999"))
        c.add("10", null, "Bob", false, m("1000"))
        assertEquals(listOf("999", "1000"), c.get("10")!!.messages.map { it.id })
        assertFalse(c.read("10", "999"))
    }

    @Test fun textResolvesMentionsEmojiAndAttachments() {
        val msg = JSONObject("""{"content":"hey <@100> <:pog:123> <@&5> <#7> <@!100>","mentions":[{"id":"100","username":"carol","global_name":"Carol"}]}""")
        assertEquals("hey @Carol :pog: @role #channel @Carol", Conversations.text(msg))
        assertEquals("sent an attachment", Conversations.text(JSONObject("""{"content":"","attachments":[{"id":"1"}]}""")))
        assertEquals("Title", Conversations.text(JSONObject("""{"content":"","embeds":[{"title":"Title"}]}""")))
        assertEquals(1000, Conversations.text(JSONObject().put("content", "x".repeat(5000))).length)
    }

    @Test fun authorAndTitles() {
        assertEquals("Nick", Conversations.author(JSONObject("""{"author":{"username":"bob"},"member":{"nick":"Nick"}}""")))
        assertEquals("Bobby", Conversations.author(JSONObject("""{"author":{"username":"bob","global_name":"Bobby"},"member":{"nick":null}}""")))
        assertEquals("bob", Conversations.author(JSONObject("""{"author":{"username":"bob","global_name":null}}""")))
        val dm = JSONObject("""{"type":1,"recipients":[{"id":"2","username":"bob"}]}""")
        assertEquals("bob", Conversations.title(dm, "1", null))
        val group = JSONObject("""{"type":3,"name":null,"recipients":[{"id":"2","username":"bob"},{"id":"3","username":"cat"}]}""")
        assertEquals("bob, cat", Conversations.title(group, "1", null))
        assertEquals("Squad", Conversations.title(JSONObject("""{"type":3,"name":"Squad"}"""), "1", null))
        assertEquals("#general · Team", Conversations.title(JSONObject("""{"type":0,"name":"general"}"""), "1", "Team"))
        assertNotNull(Conversations.title(JSONObject("""{"type":1}"""), "1", null))
    }
}
