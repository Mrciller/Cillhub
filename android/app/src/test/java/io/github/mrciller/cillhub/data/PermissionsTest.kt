package io.github.mrciller.cillhub.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** The same vectors as the self-check in client/src/permissions.ts, plus the overwrite and timeout edge cases. */
class PermissionsTest {
    private val P = Perm
    private val g = Guild("g", ownerId = "o", roles = listOf(
        Role("g", "@everyone", position = 0, permissions = (P.VIEW_CHANNEL or P.SEND_MESSAGES or P.ATTACH_FILES or P.SEND_MESSAGES_IN_THREADS).toString()),
        Role("r", "Staff", position = 1, permissions = P.KICK_MEMBERS.toString()),
    ))
    private val m = Member(User("u", "u"), roles = listOf("r"))
    private val ch = Channel("c", 0, permissionOverwrites = listOf(
        Overwrite("g", 0, "0", (P.VIEW_CHANNEL or P.SEND_MESSAGES).toString()), Overwrite("r", 0, P.VIEW_CHANNEL.toString(), "0"),
    ))

    @Test fun roleOverwriteReAllowsViewAndNoSendDropsAttach() =
        assertEquals(P.VIEW_CHANNEL or P.KICK_MEMBERS or P.SEND_MESSAGES_IN_THREADS, Perm.channel(g, "u", m, ch))

    @Test fun noViewMeansNothing() = assertEquals(0L, Perm.channel(g, "x", null, ch))
    @Test fun ownerHasEverything() = assertEquals(Perm.ALL, Perm.channel(g, "o", null, ch))
    @Test fun hierarchy() { assertTrue(Perm.outranks(g, "u", m, "x", null)); assertFalse(Perm.outranks(g, "u", m, "o", null)) }

    @Test fun threadsUseSendMessagesInThreads() {
        val thread = Channel("t", 11, parentId = "c")
        assertTrue(Perm.has(Perm.channel(g, "u", m, thread, ch), P.SEND_MESSAGES))
        val locked = thread.copy(threadMetadata = ThreadMetadata(locked = true))
        assertFalse("locked thread without MANAGE_THREADS", Perm.has(Perm.channel(g, "u", m, locked, ch), P.SEND_MESSAGES))
    }

    @Test fun timedOutKeepsOnlyViewAndHistory() {
        val now = Instant.parse("2026-11-05T12:00:00Z")
        val out = m.copy(communicationDisabledUntil = "2026-11-05T12:01:00Z")
        assertEquals(P.VIEW_CHANNEL, Perm.base(g, "u", out, now))
        assertEquals("expired timeout is ignored", Perm.base(g, "u", m, now), Perm.base(g, "u", m.copy(communicationDisabledUntil = "2026-11-05T11:00:00Z"), now))
    }

    @Test fun administratorSkipsOverwrites() {
        val admin = g.copy(roles = g.roles + Role("a", "Admin", position = 2, permissions = P.ADMINISTRATOR.toString()))
        assertEquals(Perm.ALL, Perm.channel(admin, "u", m.copy(roles = listOf("a")), ch))
    }

    @Test fun memberOverwriteBeatsRoleOverwrite() {
        val c = ch.copy(permissionOverwrites = ch.permissionOverwrites + Overwrite("u", 1, "0", P.VIEW_CHANNEL.toString()))
        assertEquals(0L, Perm.channel(g, "u", m, c))
    }

    @Test fun guildWithoutEveryoneRoleUsesTheDefault() {
        val bare = Guild("g2", ownerId = "o")
        assertEquals(Perm.DEFAULT_EVERYONE.toLong(), Perm.base(bare, "u", null))
    }

    @Test fun voiceWithoutConnectDropsSpeak() {
        val voice = Channel("v", 2, permissionOverwrites = listOf(Overwrite("g", 0, P.SPEAK.toString(), P.CONNECT.toString())))
        val p = Perm.channel(g, "u", m, voice)
        assertFalse(Perm.has(p, P.SPEAK))
        assertTrue(Perm.has(p, P.VIEW_CHANNEL))
    }

    @Test fun pendingMemberIsReadOnly() = assertEquals(P.VIEW_CHANNEL, Perm.base(g, "u", m.copy(pending = true)) and (P.VIEW_CHANNEL or P.SEND_MESSAGES))

    @Test fun unreadChannelsExcludesThreadWhoseParentCannotBeViewed() {
        val hiddenParent = Channel("hp", 0, guildId = "g", permissionOverwrites = listOf(Overwrite("g", 0, "0", P.VIEW_CHANNEL.toString())))
        val thread = Channel("th", 11, guildId = "g", parentId = "hp", lastMessageId = "100")
        val s = State(me = User("u", "u"), guilds = mapOf("g" to g), channels = mapOf("hp" to hiddenParent, "th" to thread))
        assertTrue("thread under hidden parent is not visible in unreadChannels", Sel.unreadChannels(s).isEmpty())
    }
}
