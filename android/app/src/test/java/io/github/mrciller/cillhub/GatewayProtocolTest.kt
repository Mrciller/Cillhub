package io.github.mrciller.cillhub

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GatewayProtocolTest {
    private val sent = ArrayList<JSONObject>()
    private val events = ArrayList<Pair<String, JSONObject?>>()
    private var token: String? = "tok_abcdefghijklmnopqrstuvwxyz"
    private val p = GatewayProtocol({ token }, JSONObject().put("os", "Android"), { sent.add(JSONObject(it)) }, { t, d -> events.add(t to d) })

    private fun hello() = p.onText("""{"op":10,"d":{"heartbeat_interval":41250},"s":null,"t":null}""")
    private fun ready(seq: Int) = p.onText("""{"op":0,"t":"READY","s":$seq,"d":{"session_id":"abc","user":{"id":"1"}}}""")

    @Test fun helloIdentifiesWithTokenAndProperties() {
        assertEquals(GatewayProtocol.Action.START_HEARTBEAT, hello())
        assertEquals(41250L, p.heartbeatMs)
        val id = sent.single()
        assertEquals(2, id.getInt("op"))
        assertEquals(token, id.getJSONObject("d").getString("token"))
        assertEquals("Android", id.getJSONObject("d").getJSONObject("properties").getString("os"))
    }

    @Test fun readyStoresSessionAndMarksTheConnectionAfk() {
        hello(); sent.clear()
        ready(1)
        assertEquals("abc", p.sessionId)
        assertEquals(1L, p.seq)
        assertEquals("READY", events.single().first)
        val presence = sent.single()
        assertEquals(3, presence.getInt("op"))
        assertTrue(presence.getJSONObject("d").getBoolean("afk"))
        assertFalse(presence.getJSONObject("d").has("status")) // never overwrites the user's saved status
    }

    @Test fun heartbeatCarriesLastSequenceAndDetectsZombies() {
        hello(); ready(1)
        p.onText("""{"op":0,"t":"MESSAGE_CREATE","s":2,"d":{"id":"5"}}""")
        sent.clear()
        assertTrue(p.heartbeat())
        assertEquals(1, sent.last().getInt("op"))
        assertEquals(2L, sent.last().getLong("d"))
        assertFalse("no ack since the last beat", p.heartbeat())
        p.onText("""{"op":11}""")
        assertTrue(p.heartbeat())
    }

    @Test fun serverRequestedHeartbeatIsAnsweredAtOnce() {
        hello(); sent.clear()
        p.onText("""{"op":1,"d":null}""")
        assertEquals(1, sent.single().getInt("op"))
    }

    @Test fun reconnectResumesWithSessionAndSeq() {
        hello(); ready(7)
        assertEquals(GatewayProtocol.Action.RECONNECT, p.onClose(1006))
        sent.clear()
        hello()
        val resume = sent.single()
        assertEquals(6, resume.getInt("op"))
        assertEquals("abc", resume.getJSONObject("d").getString("session_id"))
        assertEquals(7L, resume.getJSONObject("d").getLong("seq"))
    }

    @Test fun invalidSessionIdentifiesAfresh() {
        hello(); ready(3); p.onClose(1006); hello(); sent.clear()
        assertEquals(GatewayProtocol.Action.NONE, p.onText("""{"op":9,"d":false}"""))
        assertEquals(2, sent.single().getInt("op"))
        assertNull(p.sessionId)
    }

    @Test fun opReconnectAndCloseCodes() {
        hello(); ready(1)
        assertEquals(GatewayProtocol.Action.RECONNECT, p.onText("""{"op":7,"d":null}"""))
        assertEquals(GatewayProtocol.Action.STOP, p.onClose(4004)) // token revoked: stop, do not hammer the server
        assertNull(p.sessionId)
        assertEquals(GatewayProtocol.Action.RECONNECT, p.onClose(4009)) // session timed out: new session
        assertEquals(GatewayProtocol.Action.RECONNECT, p.onClose(1001))
    }

    @Test fun noTokenStops() {
        token = null
        assertEquals(GatewayProtocol.Action.STOP, hello())
        assertTrue(sent.isEmpty())
    }

    @Test fun garbageIsIgnored() {
        assertEquals(GatewayProtocol.Action.NONE, p.onText("not json"))
        assertTrue(events.isEmpty())
    }
}
