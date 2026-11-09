package io.github.mrciller.cillhub

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Only the call that is ringing now may put MainActivity over the lock screen (it is exported: any app can send the extras). */
class CallsTest {
    private fun call(state: Calls.State) = Calls.Call("100", "Alex", null, false, "Alex", state)

    @Test fun onlyTheRingingCallOfThatChannel() {
        assertTrue(Calls.rings(call(Calls.State.RINGING), "100"))
        assertFalse("no call at all", Calls.rings(null, "100"))
        assertFalse("another channel", Calls.rings(call(Calls.State.RINGING), "200"))
        assertFalse("already answered", Calls.rings(call(Calls.State.ACTIVE), "100"))
        assertFalse("a voice channel", Calls.rings(call(Calls.State.VOICE), "100"))
    }
}
