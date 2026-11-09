package io.github.mrciller.cillhub.ui

import io.github.mrciller.cillhub.data.Channel
import io.github.mrciller.cillhub.data.Role
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure helpers behind the server settings pages. */
class AdminHelpersTest {
    @Test fun emojiNamesFromFiles() {
        assertEquals("party_parrot", emojiName("party parrot.gif"))
        assertEquals("ok", emojiName("--ok--.png"))
        assertEquals("emoji", emojiName("ä.png"))
        assertEquals(32, emojiName("a".repeat(40) + ".png").length)
        for (f in listOf("x.png", "Kim's cat!!.webp", "a".repeat(40))) assertTrue(f, EMOJI_NAME.matches(emojiName(f)))
    }

    private fun r(id: String, pos: Int) = Role(id = id, name = id, position = pos)

    @Test fun rolePositionsTopFirst() {
        assertEquals(listOf("b" to 3, "a" to 2, "c" to 1), rolePositions(listOf(r("b", 1), r("a", 3), r("c", 2))))
    }

    @Test fun lockedRolesMustNotMove() {
        val before = listOf(r("top", 3), r("mid", 2), r("low", 1))
        val movable = { x: Role -> x.id != "top" }
        assertTrue(rolesStayPut(before, listOf(before[0], before[2], before[1]), movable))
        assertFalse("a movable role passed above a locked one", rolesStayPut(before, listOf(before[1], before[0], before[2]), movable))
    }

    private fun c(id: String, type: Int = 0, parent: String? = null, pos: Int = 0) = Channel(id = id, type = type, parentId = parent, position = pos)

    @Test fun channelDraggedIntoAnotherCategory() {
        // general | A: a1 a2 | B: b1 ; a1 dragged below B
        val flat = listOf(c("general"), c("A", 4, pos = 0), c("a2", parent = "A", pos = 1), c("B", 4, pos = 1), c("b1", parent = "B"), c("a1", parent = "A", pos = 0))
        val moves = channelMoves(flat, flat.last()).associateBy { it.id }
        assertEquals("B", moves["a1"]!!.parentId)
        assertEquals(1, moves["a1"]!!.position)
        assertEquals(0, moves["a2"]!!.position)
        assertFalse("untouched channels are not sent", "b1" in moves || "general" in moves || "A" in moves || "B" in moves)
    }

    @Test fun channelDraggedAboveAllCategoriesLeavesItsCategory() {
        val flat = listOf(c("a1", parent = "A"), c("general"), c("A", 4))
        val moves = channelMoves(flat, flat.first()).associateBy { it.id }
        assertEquals(null, moves["a1"]!!.parentId)
        assertEquals(0, moves["a1"]!!.position)
        assertEquals(1, moves["general"]!!.position)
    }

    @Test fun categoryKeepsItsChannels() {
        // B dragged above A: a1 now sits under B in the flat list but stays in A
        val flat = listOf(c("B", 4, pos = 1), c("a1", parent = "A"), c("A", 4, pos = 0), c("b1", parent = "B"))
        val moves = channelMoves(flat, flat.first()).associateBy { it.id }
        assertEquals(0, moves["B"]!!.position)
        assertEquals(1, moves["A"]!!.position)
        assertFalse("a1" in moves || "b1" in moves)
    }
}
