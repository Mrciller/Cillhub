package io.github.mrciller.cillhub.voice

import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.os.Build

/** Screen share presets (the web client's Stream Quality, settings.ts). The phone captures its own screen, so "source" is the display size. */
enum class ScreenQuality(val height: Int, val fps: Int) {
    P720_15(720, 15), P720_30(720, 30), P1080_30(1080, 30), P1080_60(1080, 60);

    /** settings.ts streamBitrate: the full layer's rate for this choice. */
    val bitrate: Int get() = ((if (height >= 1080) 6_000_000 else 2_500_000) * (if (fps == 60) 1.5 else if (fps == 15) 0.6 else 1.0)).toInt()
    /** The 16:9 box the capture must fit in (longest side x shortest side). */
    val width: Int get() = height * 16 / 9

    /** Capture size for a display: its aspect ratio kept, within width x height (either orientation), even numbers for the encoder. */
    fun fit(displayW: Int, displayH: Int): Pair<Int, Int> {
        val long = maxOf(displayW, displayH).coerceAtLeast(2)
        val short = minOf(displayW, displayH).coerceAtLeast(2)
        val scale = minOf(1.0, width.toDouble() / long, height.toDouble() / short)
        val even = { v: Double -> (v.toInt() / 2 * 2).coerceAtLeast(2) }
        val (w, h) = even(long * scale) to even(short * scale)
        return if (displayW >= displayH) w to h else h to w
    }
}

/**
 * Which video codecs to send a screen share with, best first (settings.ts screenCodecs). Auto: AV1 only when the phone has
 * a hardware AV1 encoder, then H.264 (phones encode it in hardware), VP8 last. A codec the device cannot encode is left out.
 */
object Codecs {
    enum class Choice { AUTO, H264, AV1, VP8 }

    fun order(choice: Choice, canEncode: Set<String>, hardwareAv1: Boolean): List<String> {
        val want = when (choice) {
            Choice.AUTO -> listOfNotNull("av1".takeIf { hardwareAv1 }, "h264", "vp8")
            Choice.AV1 -> listOf("av1", "h264", "vp8")
            Choice.H264 -> listOf("h264", "vp8")
            Choice.VP8 -> listOf("vp8")
        }
        return want.filter { it in canEncode }.ifEmpty { listOf("vp8") }
    }

    /** Whether this phone reports an AV1 encoder that is hardware (API 29+ tells; older phones have none). */
    fun hardwareAv1(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return false
        return try {
            MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos.any { c: MediaCodecInfo ->
                c.isEncoder && c.isHardwareAccelerated && !c.isSoftwareOnly && c.supportedTypes.any { it.equals("video/av01", ignoreCase = true) }
            }
        } catch (e: Exception) { false }
    }
}
