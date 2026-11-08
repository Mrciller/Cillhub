package io.github.mrciller.cillhub.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class StatsSummaryTest {
    @Test fun sumsAudioAndListsVideoWithCodecs() {
        val r = mapOf(
            "c1" to mapOf<String, Any?>("type" to "codec", "mimeType" to "video/H264"),
            "a" to mapOf<String, Any?>("type" to "inbound-rtp", "kind" to "audio", "packetsReceived" to 50L, "audioLevel" to 0.2),
            "b" to mapOf<String, Any?>("type" to "inbound-rtp", "kind" to "audio", "packetsReceived" to 25L, "audioLevel" to 0.4),
            "c" to mapOf<String, Any?>("type" to "outbound-rtp", "kind" to "audio", "packetsSent" to 10L, "bytesSent" to 900L),
            "d" to mapOf<String, Any?>("type" to "inbound-rtp", "kind" to "video", "framesDecoded" to 30L, "frameWidth" to 1280L, "frameHeight" to 720L, "codecId" to "c1"),
            "e" to mapOf<String, Any?>("type" to "outbound-rtp", "kind" to "video", "framesEncoded" to 12L, "frameWidth" to 320, "frameHeight" to 180),
        )
        val s = StatsSummary.of(listOf(r))
        assertEquals(75L, s.audioInPackets)
        assertEquals(0.4, s.audioInLevel, 1e-9)
        assertEquals(10L, s.audioOutPackets)
        assertEquals(900L, s.audioOutBytes)
        assertEquals(listOf(VoiceStats.Video(30, 1280, 720, "H264")), s.videoIn)
        assertEquals(listOf(VoiceStats.Video(12, 320, 180, "")), s.videoOut)
    }
}
