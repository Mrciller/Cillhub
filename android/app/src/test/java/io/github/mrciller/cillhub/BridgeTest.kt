package io.github.mrciller.cillhub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeTest {
    private val origin = "https://chat.example.org"

    @Test fun originsAreNormalised() {
        assertEquals(origin, Origins.of("https://chat.example.org/channels/@me"))
        assertEquals(origin, Origins.of("HTTPS://Chat.Example.org:443/"))
        assertEquals("http://10.0.2.2:3350", Origins.of("http://10.0.2.2:3350/x"))
        assertNull(Origins.of("javascript:alert(1)"))
        assertNull(Origins.of("file:///sdcard/x.html"))
        assertNull(Origins.of(null))
    }

    @Test fun bridgeOnlyForTheAppOriginsTopFrame() {
        assertTrue(Origins.bridgeAccepts("https://chat.example.org", true, origin))
        assertFalse("iframe (embeds, Watch Together)", Origins.bridgeAccepts("https://chat.example.org", false, origin))
        assertFalse(Origins.bridgeAccepts("https://chat.example.org.evil.example", true, origin))
        assertFalse(Origins.bridgeAccepts("https://chat.example.org@evil.example", true, origin))
        assertFalse(Origins.bridgeAccepts("http://chat.example.org", true, origin))
        assertFalse(Origins.bridgeAccepts("https://chat.example.org:8443", true, origin))
        assertFalse(Origins.bridgeAccepts("https://www.youtube.com", true, origin))
        assertFalse(Origins.bridgeAccepts("null", true, origin))
    }

    @Test fun messagesAreParsedStrictly() {
        val t = "a".repeat(43)
        assertEquals(BridgeMessage.Token(t), BridgeMessage.parse("""{"type":"token","token":"$t"}"""))
        assertNull("too short", BridgeMessage.parse("""{"type":"token","token":"abc"}"""))
        assertNull("bad characters", BridgeMessage.parse("""{"type":"token","token":"${"a".repeat(30)}\n\"x"}"""))
        assertEquals(BridgeMessage.Logout, BridgeMessage.parse("""{"type":"logout"}"""))
        assertEquals(BridgeMessage.Ready, BridgeMessage.parse("""{"type":"ready"}"""))
        assertEquals(BridgeMessage.Voice(null, "123"), BridgeMessage.parse("""{"type":"voice","guild_id":null,"channel_id":"123"}"""))
        assertEquals(BridgeMessage.Voice(null, null), BridgeMessage.parse("""{"type":"voice","channel_id":null}"""))
        assertNull(BridgeMessage.parse("""{"type":"voice","channel_id":"../x"}"""))
        assertNull(BridgeMessage.parse("""{"type":"eval","code":"x"}"""))
        assertNull(BridgeMessage.parse("nope"))
    }
}
