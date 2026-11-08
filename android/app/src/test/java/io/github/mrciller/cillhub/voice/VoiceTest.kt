package io.github.mrciller.cillhub.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class VoiceTest {
    @Test fun liveKitEndpointsBecomeWebSocketUrls() {
        assertEquals("wss://lk.example/x", Voice.wsUrl("wss://lk.example/x", "https://hub.example"))
        assertEquals("ws://10.0.2.2:7880", Voice.wsUrl("http://10.0.2.2:7880", "https://hub.example"))
        assertEquals("wss://lk.example", Voice.wsUrl("https://lk.example", "https://hub.example"))
        assertEquals("wss://hub.example/livekit", Voice.wsUrl("/livekit", "https://hub.example"))
        assertEquals("ws://localhost:3300/livekit", Voice.wsUrl("/livekit", "http://localhost:3300"))
        assertEquals("wss://lk.example:7880", Voice.wsUrl("lk.example:7880", "https://hub.example"))
    }
}
