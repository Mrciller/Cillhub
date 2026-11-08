package io.github.mrciller.cillhub.voice

import org.junit.Assert.assertEquals
import org.junit.Test

class CodecsTest {
    private val phone = setOf("vp8", "vp9", "h264", "av1")

    @Test fun autoSendsH264UnlessTheEncoderForAv1IsHardware() {
        assertEquals(listOf("h264", "vp8"), Codecs.order(Codecs.Choice.AUTO, phone, hardwareAv1 = false))
        assertEquals(listOf("av1", "h264", "vp8"), Codecs.order(Codecs.Choice.AUTO, phone, hardwareAv1 = true))
    }

    @Test fun codecsThePhoneCannotEncodeAreLeftOut() {
        // the emulator: no H.264 encoder
        assertEquals(listOf("vp8"), Codecs.order(Codecs.Choice.AUTO, setOf("vp8", "vp9"), hardwareAv1 = false))
        assertEquals(listOf("vp8"), Codecs.order(Codecs.Choice.H264, setOf("vp8"), hardwareAv1 = false))
        assertEquals(listOf("vp8"), Codecs.order(Codecs.Choice.AV1, emptySet(), hardwareAv1 = false))
        assertEquals(listOf("av1", "h264", "vp8"), Codecs.order(Codecs.Choice.AV1, phone, hardwareAv1 = false))
    }

    @Test fun bitratesFollowTheWebClient() {
        assertEquals(1_500_000, ScreenQuality.P720_15.bitrate)
        assertEquals(2_500_000, ScreenQuality.P720_30.bitrate)
        assertEquals(6_000_000, ScreenQuality.P1080_30.bitrate)
    }

    @Test fun captureKeepsTheDisplayAspectAndOrientation() {
        assertEquals(576 to 1280, ScreenQuality.P720_30.fit(1080, 2400)) // portrait phone, 720p box
        assertEquals(1280 to 576, ScreenQuality.P720_30.fit(2400, 1080))
        assertEquals(1080 to 1920, ScreenQuality.P1080_30.fit(1080, 1920)) // fits exactly
        assertEquals(800 to 1280, ScreenQuality.P1080_30.fit(800, 1280)) // never scaled up
        assertEquals(1152 to 720, ScreenQuality.P720_30.fit(2560, 1600)) // a tablet: the short side limits
    }
}
