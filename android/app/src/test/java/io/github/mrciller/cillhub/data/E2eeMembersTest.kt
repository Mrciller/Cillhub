package io.github.mrciller.cillhub.data

import io.github.mrciller.cillhub.data.E2eeMembers.Memory
import io.github.mrciller.cillhub.data.E2eeMembers.Plan
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Member memory and send rules of encrypted DMs, the same cases as client/scripts/e2ee-members.test.mjs. */
class E2eeMembersTest {
    @Test fun wrapTargetIsThePinnedKeyWhateverTheServerSaysLater() {
        // the key-change check saw the pinned key A; a later server answer B never becomes the target
        assertEquals("A", E2eeMembers.wrapTarget("B", listOf("old", "A")))
        assertEquals("A", E2eeMembers.wrapTarget("A", listOf("A")))
        assertNull("no key on the server: no wrap", E2eeMembers.wrapTarget("", listOf("A")))
        assertNull(E2eeMembers.wrapTarget("B", emptyList()))
    }

    @Test fun firstUseStoresTheListAndA1to1DmNeedsExactlyOneOther() {
        assertEquals(Memory(listOf("sam")), E2eeMembers.check(1, null, listOf("sam")).next)
        for (others in listOf(emptyList(), listOf("sam", "kim"))) {
            val r = E2eeMembers.check(1, null, others)
            assertTrue(r.bad); assertNull(r.next); assertTrue(r.accepted.isEmpty())
        }
    }

    @Test fun oneToOneDmRefusesAnyChangeWithoutAccept() {
        val mem = Memory(listOf("sam"))
        val ghost = E2eeMembers.check(1, mem, listOf("sam", "kim"))
        assertTrue(ghost.bad); assertNull(ghost.next); assertEquals(listOf("sam"), ghost.accepted)
        assertTrue(E2eeMembers.check(1, mem, listOf("kim")).bad)
        assertFalse(E2eeMembers.check(1, mem, listOf("sam")).bad)
    }

    @Test fun groupDmAddWaitsForAcceptAndGoneMembersKeepOnlyOldWraps() {
        val mem = Memory(listOf("sam", "robin"))
        val r = E2eeMembers.check(3, mem, listOf("sam", "robin", "kim"))
        assertEquals(listOf("kim"), r.added); assertFalse(r.bad); assertNull(r.next)
        assertFalse(E2eeMembers.trusted(mem, "alex", "kim", current = true))
        assertFalse("old epochs too", E2eeMembers.trusted(mem, "alex", "kim", current = false))
        val after = E2eeMembers.accept(mem, "kim", 4)
        assertTrue(E2eeMembers.check(3, after, listOf("sam", "robin", "kim")).added.isEmpty())
        assertTrue(E2eeMembers.trusted(after, "alex", "kim", current = true))
        val gone = E2eeMembers.check(3, mem, listOf("sam")).next!!
        assertEquals(Memory(listOf("sam"), listOf("robin")), gone)
        assertFalse(E2eeMembers.trusted(gone, "alex", "robin", current = true))
        assertTrue(E2eeMembers.trusted(gone, "alex", "robin", current = false))
        assertEquals("coming back needs Accept again", listOf("robin"), E2eeMembers.check(3, gone, listOf("sam", "robin")).added)
        assertTrue(E2eeMembers.trusted(null, "alex", "alex", current = true))
    }

    @Test fun aFailedWrapCheckIsNeverRenewedSilently() {
        val w = listOf("alex", "sam")
        assertEquals(Plan.USE, E2eeMembers.plan(4, false, true, w, emptyList(), w, null))
        assertEquals(Plan.REFUSE, E2eeMembers.plan(4, true, false, w, emptyList(), w, null))
        assertEquals(Plan.RENEW, E2eeMembers.plan(4, false, false, w, emptyList(), w, null))
        assertEquals(Plan.RENEW, E2eeMembers.plan(4, false, true, w, listOf("sam"), w, null))
        assertEquals("a member left", Plan.RENEW, E2eeMembers.plan(4, false, true, w, emptyList(), listOf("alex"), null))
        assertEquals("the key of the Accept epoch", Plan.RENEW, E2eeMembers.plan(4, false, true, w, emptyList(), w + "kim", 4))
        assertEquals(Plan.USE, E2eeMembers.plan(5, false, true, w, emptyList(), w, 4))
    }
}
