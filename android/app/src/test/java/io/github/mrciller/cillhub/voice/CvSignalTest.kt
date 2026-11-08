package io.github.mrciller.cillhub.voice

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** cillvoice signalling as client/src/voice/cillvoice.ts and server/README.md "cillvoice" define it. */
class CvSignalTest {
    private val a1 = CvSignal.Track("t1", "u1", "audio", "microphone")
    private val v1 = CvSignal.Track("t2", "u1", "video", "camera")
    private val s2 = CvSignal.Track("t3", "u2", "video", "screen_share")

    @Test fun firstRoundAddsOneReceiverPerRemoteTrack() {
        val p = CvSignal.plan(listOf(a1, v1), emptyMap(), emptyList())
        assertEquals(emptyList<String>(), p.unmap)
        assertEquals(listOf(null to a1, null to v1), p.add)
    }

    @Test fun goneTracksAreReleasedAndTheirReceiversReusedByKind() {
        // t2 (video, mid 2) went away, t3 (video) arrived: mid 2 carries t3 now; t1 keeps mid 1
        val p = CvSignal.plan(listOf(a1, s2), mapOf("1" to a1, "2" to v1), emptyList())
        assertEquals(listOf("2"), p.unmap)
        assertEquals(listOf("2" to s2), p.add)
    }

    @Test fun freeReceiversOfTheRightKindComeFirst() {
        val p = CvSignal.plan(listOf(a1, v1), emptyMap(), listOf(CvSignal.Free("4", "video"), CvSignal.Free("3", "audio")))
        assertEquals(listOf("3" to a1, "4" to v1), p.add)
        // a free audio receiver never takes a video track
        val q = CvSignal.plan(listOf(v1), emptyMap(), listOf(CvSignal.Free("3", "audio")))
        assertEquals(listOf(null to v1), q.add)
    }

    @Test fun unchangedTracksMeanNoChange() {
        val p = CvSignal.plan(listOf(a1, v1), mapOf("1" to a1, "2" to v1), emptyList())
        assertTrue(p.unmap.isEmpty() && p.add.isEmpty())
    }

    @Test fun signalCarriesOfferPublishAndSubscribe() {
        val j = CvSignal.signal("tok", "v=0\r\n", linkedMapOf("microphone" to "0", "camera" to "1"), linkedMapOf("2" to a1))
        assertEquals("tok", j.getString("token"))
        assertEquals("v=0\r\n", j.getString("sdp"))
        val pub = j.getJSONArray("publish")
        assertEquals(listOf("0" to "microphone", "1" to "camera"), (0 until pub.length()).map { pub.getJSONObject(it).let { o -> o.getString("mid") to o.getString("source") } })
        val sub = j.getJSONArray("subscribe").getJSONObject(0)
        assertEquals("2" to "t1", sub.getString("mid") to sub.getString("track_id"))
    }

    @Test fun answerParsesSubscribedMidsAndTracks() {
        val a = CvSignal.answer(JSONObject("""{"channel_id":"9","sdp":"v=0","subscribed":[{"mid":"2","track_id":"t1","user_id":"u1","source":"microphone"}],
            "tracks":[{"id":"t1","user_id":"u1","kind":"audio","source":"microphone"},{"id":"","user_id":"x","kind":"audio","source":"microphone"}]}"""))
        assertEquals("v=0", a.sdp)
        assertEquals(setOf("2"), a.subscribed)
        assertEquals(listOf(a1), a.tracks) // a track without an id is dropped
    }

    private val answer = listOf(
        "v=0", "o=- 1 1 IN IP4 0.0.0.0", "s=-", "t=0 0", "a=group:BUNDLE 0 1",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "a=mid:0", "a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10;useinbandfec=1",
        "m=audio 9 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "a=mid:1", "a=rtpmap:111 opus/48000/2", "a=fmtp:111 minptime=10;useinbandfec=1",
        "",
    ).joinToString("\r\n")

    @Test fun dtxIsAddedToTheMicrophoneSectionOnly() {
        val m = CvSignal.munge(answer, "0", dtx = true)
        val secs = m.split("\r\nm=")
        assertTrue(secs[1].endsWith("a=fmtp:111 minptime=10;useinbandfec=1;usedtx=1"))
        assertFalse(secs[2].contains("usedtx"))
        assertEquals(answer.length + ";usedtx=1".length, m.length)
    }

    @Test fun mungingLeavesTheAnswerAloneWithoutDtxOrMic() {
        assertEquals(answer, CvSignal.munge(answer, "0", dtx = false))
        assertEquals(answer, CvSignal.munge(answer, null, dtx = true))
        assertEquals(answer, CvSignal.munge(answer, "7", dtx = true))
    }

    @Test fun codecPreferencePutsWantedFirstAndKeepsTheRest() {
        val all = listOf("VP8", "rtx", "VP9", "H264", "AV1", "red")
        assertEquals(listOf("H264", "VP8", "rtx", "VP9", "AV1", "red"), CvSignal.preferCodecs(all, { it }, listOf("H264", "VP8")))
        assertEquals(listOf("AV1", "H264", "VP8", "rtx", "VP9", "red"), CvSignal.preferCodecs(all, { it }, listOf("av1", "h264", "vp8")))
    }

    @Test fun layersLikeTheWebClient() {
        assertEquals(listOf("q", "h", "f"), CvSignal.CAMERA_LAYERS.map { it.rid })
        assertEquals(listOf(4.0, 2.0, 1.0), CvSignal.CAMERA_LAYERS.map { it.scaleDown })
        val s = CvSignal.screenLayers(ScreenQuality.P1080_60)
        assertEquals(listOf("h", "f"), s.map { it.rid })
        assertEquals(9_000_000, s[1].maxBitrate) // settings.ts: 6 Mbit/s at 1080p, x1.5 at 60 FPS
        assertEquals(2_250_000, s[0].maxBitrate)
        assertEquals(listOf(15, 60), s.map { it.maxFramerate })
    }

    @Test fun ridStaysNegotiatedOnInactiveSendSections() {
        val offer = listOf("v=0", "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:2", "a=extmap:10 ${CvSignal.RID}", "a=inactive",
            "m=video 9 UDP/TLS/RTP/SAVPF 96", "a=mid:3", "a=extmap:10 ${CvSignal.RID}", "a=recvonly", "").joinToString("\r\n")
        val answer = listOf("v=0", "m=video 50271 UDP/TLS/RTP/SAVPF 96", "a=mid:2", "a=extmap:4 urn:ietf:params:rtp-hdrext:sdes:mid", "a=inactive",
            "m=video 50271 UDP/TLS/RTP/SAVPF 96", "a=mid:3", "a=sendonly", "").joinToString("\r\n")
        val out = CvSignal.keepRid(answer, offer, setOf("2"))
        assertTrue(out.contains("a=mid:2\r\na=extmap:10 ${CvSignal.RID}\r\n"))
        assertFalse("only our send sections", out.split("\r\nm=")[2].contains(CvSignal.RID))
        assertEquals("already there: unchanged", out, CvSignal.keepRid(out, offer, setOf("2")))
        assertEquals(answer, CvSignal.keepRid(answer, offer, emptySet()))
    }
}
