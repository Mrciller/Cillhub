package io.github.mrciller.cillhub.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Role assignment, moderation and overwrite checks, as the server enforces them (permissions.js, roles.js, members.js, channels.js). */
class AdminPermsTest {
    private val P = Perm
    private val everyone = Role("g", "@everyone", position = 0, permissions = P.VIEW_CHANNEL.toString())
    private val admin = Role("a", "Admin", position = 4, permissions = P.ADMINISTRATOR.toString())
    private val mod = Role("m", "Mod", position = 3, permissions = (P.MANAGE_ROLES or P.KICK_MEMBERS or P.MODERATE_MEMBERS).toString())
    private val helper = Role("h", "Helper", position = 2, permissions = "0")
    private val bot = Role("b", "Bot", position = 1, managed = true)
    private val g = Guild("g", ownerId = "o", roles = listOf(everyone, admin, mod, helper, bot))
    private val modM = Member(User("mod"), roles = listOf("m"))
    private val helperM = Member(User("hlp"), roles = listOf("h"))
    private val adminM = Member(User("adm"), roles = listOf("a"))
    private val peer = Member(User("peer"), roles = listOf("m"))

    @Test fun assignOnlyRolesBelowOwnHighest() {
        assertTrue(Perm.canAssignRole(g, "mod", modM, helper))
        assertFalse("same position as own highest", Perm.canAssignRole(g, "mod", modM, mod))
        assertFalse("above", Perm.canAssignRole(g, "mod", modM, admin))
        assertFalse("never @everyone", Perm.canAssignRole(g, "mod", modM, everyone))
        assertFalse("never managed", Perm.canAssignRole(g, "o", null, bot))
        assertFalse("no MANAGE_ROLES", Perm.canAssignRole(g, "hlp", helperM, everyone.copy(id = "x", position = 1)))
    }

    @Test fun ownerAndAdministratorRanks() {
        assertTrue("owner may assign any role", Perm.canAssignRole(g, "o", null, admin))
        assertTrue("admin has MANAGE_ROLES via ADMINISTRATOR", Perm.canAssignRole(g, "adm", adminM, mod))
        assertFalse("but not its own position", Perm.canAssignRole(g, "adm", adminM, admin))
        assertTrue("@everyone is editable below the actor", Perm.canManageRole(g, "mod", modM, everyone))
    }

    @Test fun moderationNeedsAHigherRank() {
        assertTrue(Perm.canModerate(g, "mod", modM, P.KICK_MEMBERS, "hlp", helperM))
        assertFalse("equal rank", Perm.canModerate(g, "mod", modM, P.KICK_MEMBERS, "peer", peer))
        assertFalse("never the owner", Perm.canModerate(g, "adm", adminM, P.KICK_MEMBERS, "o", null))
        assertFalse("never oneself", Perm.canModerate(g, "o", null, P.KICK_MEMBERS, "o", null))
        assertFalse("without the permission", Perm.canModerate(g, "mod", modM, P.BAN_MEMBERS, "hlp", helperM))
        assertTrue(Perm.canTimeout(g, "mod", modM, "hlp", helperM))
        assertFalse("administrators cannot be timed out", Perm.canTimeout(g, "o", null, "adm", adminM))
    }

    @Test fun overwrites() {
        val chPerms = Perm.base(g, "mod", modM)
        assertTrue(Perm.canEditOverwrite(g, "mod", modM, chPerms, "h", 0))
        assertTrue("@everyone sits at 0", Perm.canEditOverwrite(g, "mod", modM, chPerms, "g", 0))
        assertFalse("own top role", Perm.canEditOverwrite(g, "mod", modM, chPerms, "m", 0))
        assertTrue("member below", Perm.canEditOverwrite(g, "mod", modM, chPerms, "hlp", 1, helperM))
        assertFalse("member at the same rank", Perm.canEditOverwrite(g, "mod", modM, chPerms, "peer", 1, peer))
        assertFalse("MANAGE_ROLES denied in the channel", Perm.canEditOverwrite(g, "mod", modM, chPerms and P.MANAGE_ROLES.inv(), "h", 0))
        assertEquals("grantable = channel | guild", P.VIEW_CHANNEL or P.MANAGE_ROLES or P.KICK_MEMBERS or P.MODERATE_MEMBERS or P.SEND_MESSAGES,
            Perm.grantable(g, "mod", modM, P.SEND_MESSAGES))
    }

    @Test fun nobodyLocksThemselvesOut() {
        // MANAGE_ROLES only through the lower role "h": dropping or editing that role costs it
        val h2 = helper.copy(permissions = P.MANAGE_ROLES.toString())
        val g2 = g.copy(roles = listOf(everyone, admin, mod, h2, bot, Role("t", "Top", position = 3)))
        val me = Member(User("x"), roles = listOf("t", "h"))
        assertFalse("own role removed", Perm.keepsAdmin(g2, "x", me, afterMe = me.copy(roles = listOf("t"))))
        assertFalse("role edited", Perm.keepsAdmin(g2, "x", me, after = g2.copy(roles = g2.roles.map { if (it.id == "h") it.copy(permissions = "0") else it })))
        assertTrue("an unrelated role edit", Perm.keepsAdmin(g2, "x", me, after = g2.copy(roles = g2.roles.map { if (it.id == "m") it.copy(permissions = "0") else it })))
        assertTrue("the owner always keeps it", Perm.keepsAdmin(g, "o", null, afterMe = null))
        assertTrue("never had it", Perm.keepsAdmin(g, "hlp", helperM, afterMe = helperM.copy(roles = emptyList())))

        val ch = Channel("c", type = 0, guildId = "g")
        val denyEveryone = { bit: Long -> listOf(Overwrite("g", 0, deny = bit.toString())) }
        assertFalse("@everyone denied VIEW_CHANNEL", Perm.keepsChannelAccess(g, "mod", modM, ch, denyEveryone(P.VIEW_CHANNEL)))
        assertFalse("@everyone denied MANAGE_ROLES", Perm.keepsChannelAccess(g, "mod", modM, ch, denyEveryone(P.MANAGE_ROLES)))
        assertTrue("own role allowed back in", Perm.keepsChannelAccess(g, "mod", modM, ch, denyEveryone(P.VIEW_CHANNEL) + Overwrite("m", 0, allow = P.VIEW_CHANNEL.toString())))
        assertTrue("administrators are never locked out", Perm.keepsChannelAccess(g, "adm", adminM, ch, denyEveryone(P.VIEW_CHANNEL)))
    }
}
