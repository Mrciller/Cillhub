package io.github.mrciller.cillhub

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Test

class BackoffTest {
    @Test fun doublesToSixtySecondsWithJitterAndResets() {
        val b = Backoff(random = { 0L })
        assertEquals(listOf(1000L, 2000L, 4000L, 8000L, 16000L, 32000L, 60000L, 60000L), (1..8).map { b.next() })
        b.reset()
        assertEquals(1000L, b.next())
        val jittered = Backoff(random = { it - 1 }) // the most jitter: up to half the delay on top
        assertEquals(1500L, jittered.next())
    }

    @Test fun presenceFramesNeverCarryAStatusUnlessAsked() {
        val p = GatewayProtocol({ "tok_abcdefghijklmnopqrstuvwxyz" }, JSONObject(), {}, { _, _ -> }, afk = { false })
        val afk = JSONObject(p.presence(false)).getJSONObject("d")
        assertEquals(false, afk.getBoolean("afk"))
        assertEquals(false, afk.has("status"))
        val st = JSONObject(p.status("dnd", true)).getJSONObject("d")
        assertEquals("dnd", st.getString("status"))
    }

    @Test fun visibleAppSendsAfkFalseAfterReady() {
        val sent = ArrayList<JSONObject>()
        val p = GatewayProtocol({ "tok_abcdefghijklmnopqrstuvwxyz" }, JSONObject(), { sent.add(JSONObject(it)) }, { _, _ -> }, afk = { false })
        p.onText("""{"op":10,"d":{"heartbeat_interval":41250}}""")
        p.onText("""{"op":0,"t":"READY","s":1,"d":{"session_id":"abc"}}""")
        assertEquals(false, sent.last().getJSONObject("d").getBoolean("afk"))
    }
}
