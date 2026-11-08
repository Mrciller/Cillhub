package io.github.mrciller.cillhub

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class NotifyRulesTest {
    private val me = "100"
    private fun msg(json: String) = JSONObject(json)
    private val noRoles = { emptySet<String>() }

    @Test fun everyDmMessageNotifies() {
        assertEquals("dm", NotifyRules.kind(msg("""{"content":"hi"}"""), me, true, noRoles))
    }

    @Test fun suppressNotificationsFlagWins() {
        assertNull(NotifyRules.kind(msg("""{"flags":4096}"""), me, true, noRoles))
        assertNull("ephemeral flag suppresses notifications", NotifyRules.kind(msg("""{"flags":64}"""), me, true, noRoles))
        assertNull("own message never notifies", NotifyRules.kind(msg("""{"author":{"id":"100"},"content":"hi"}"""), me, true, noRoles))
        assertNull("system join message never notifies", NotifyRules.kind(msg("""{"type":7,"content":"joined"}"""), me, true, noRoles))
    }

    @Test fun guildMentionKinds() {
        assertEquals("user", NotifyRules.kind(msg("""{"mentions":[{"id":"100"}]}"""), me, false, noRoles))
        assertEquals("role", NotifyRules.kind(msg("""{"mentions":[],"mention_roles":["7"]}"""), me, false) { setOf("7") })
        assertNull(NotifyRules.kind(msg("""{"mentions":[],"mention_roles":["8"]}"""), me, false) { setOf("7") })
        assertEquals("everyone", NotifyRules.kind(msg("""{"mention_everyone":true}"""), me, false, noRoles))
        assertNull(NotifyRules.kind(msg("""{"content":"plain"}"""), me, false, noRoles))
    }

    @Test fun rolesAreOnlyLookedUpWhenNeeded() {
        var asked = false
        NotifyRules.kind(msg("""{"mentions":[{"id":"100"}],"mention_roles":["7"]}"""), me) { asked = true; setOf() }.let { }
        assertFalse(asked)
    }

    private fun NotifyRules.kind(m: JSONObject, me: String, roles: () -> Set<String>) = kind(m, me, false, roles)

    private val now = Instant.parse("2026-11-04T12:00:00Z")

    @Test fun defaultsAllow() {
        assertTrue(NotifyRules.allowed(null, "1", null, "dm", now))
        assertTrue(NotifyRules.allowed(JSONObject("""{"message_notifications":0,"mobile_push":true}"""), "1", null, "user", now))
    }

    @Test fun mobilePushOffAndGuildMute() {
        assertFalse(NotifyRules.allowed(JSONObject("""{"mobile_push":false}"""), "1", null, "dm", now))
        assertFalse(NotifyRules.allowed(JSONObject("""{"muted":true,"mute_config":null}"""), "1", null, "dm", now))
        assertFalse(NotifyRules.allowed(JSONObject("""{"muted":true,"mute_config":{"end_time":"2026-11-04T13:00:00.000Z"}}"""), "1", null, "dm", now))
        assertTrue("expired mute", NotifyRules.allowed(JSONObject("""{"muted":true,"mute_config":{"end_time":"2026-11-04T11:00:00.000Z"}}"""), "1", null, "dm", now))
    }

    @Test fun channelAndParentOverrides() {
        val gs = JSONObject("""{"message_notifications":0,"channel_overrides":[{"channel_id":"5","muted":true,"mute_config":null,"message_notifications":3}]}""")
        assertFalse(NotifyRules.allowed(gs, "5", null, "user", now))
        assertFalse("thread in a muted channel", NotifyRules.allowed(gs, "9", "5", "user", now))
        assertTrue(NotifyRules.allowed(gs, "6", null, "user", now))
        val nothing = JSONObject("""{"message_notifications":1,"channel_overrides":[{"channel_id":"5","muted":false,"message_notifications":2}]}""")
        assertFalse(NotifyRules.allowed(nothing, "5", null, "user", now))
        assertFalse(NotifyRules.allowed(JSONObject("""{"message_notifications":2}"""), "5", null, "user", now))
    }

    @Test fun suppressEveryoneAndRoles() {
        val gs = JSONObject("""{"suppress_everyone":true,"suppress_roles":true}""")
        assertFalse(NotifyRules.allowed(gs, "1", null, "everyone", now))
        assertFalse(NotifyRules.allowed(gs, "1", null, "role", now))
        assertTrue(NotifyRules.allowed(gs, "1", null, "user", now))
    }
}
