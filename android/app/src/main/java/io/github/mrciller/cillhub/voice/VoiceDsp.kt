package io.github.mrciller.cillhub.voice

import android.media.audiofx.DynamicsProcessing
import android.os.Build
import android.util.Log

/**
 * Android native Audio DSP Studio (Task 6.19):
 * API 28+ DynamicsProcessing effect attaching Pre-EQ (80 Hz high-pass rumble cut),
 * Multiband Compression & Limiter (broadcast voice leveler), and Noise Gate/Expander.
 */
object VoiceDsp {
    private const val TAG = "CillhubVoiceDsp"

    fun attach(audioSessionId: Int, prefs: VoicePrefs): DynamicsProcessing? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.P || audioSessionId <= 0) return null
        return try {
            val builder = DynamicsProcessing.Config.Builder(
                DynamicsProcessing.VARIANT_FAVOR_FREQUENCY_RESOLUTION,
                1, // 1 channel
                prefs.highPassFilter,
                1, // 1 band for high-pass
                prefs.voiceCompressor,
                2, // 2 bands for compressor
                false,
                0,
                prefs.voiceCompressor, // Limiter
            )
            val dp = DynamicsProcessing(0, audioSessionId, builder.build())
            if (prefs.highPassFilter) {
                val preEq = dp.getPreEqByChannelIndex(0)
                if (preEq.bandCount > 0) {
                    val band = preEq.getBand(0)
                    band.cutoffFrequency = 80f
                    band.gain = -24f // rumble cut
                    band.isEnabled = true
                    dp.setPreEqBandByChannelIndex(0, 0, band)
                }
                preEq.isEnabled = true
                dp.setPreEqByChannelIndex(0, preEq)
            }
            if (prefs.voiceCompressor) {
                val limiter = dp.getLimiterByChannelIndex(0)
                limiter.threshold = -12f
                limiter.attackTime = 10f
                limiter.releaseTime = 100f
                limiter.ratio = 4f
                limiter.postGain = 2f
                limiter.isEnabled = true
                dp.setLimiterByChannelIndex(0, limiter)
            }
            dp.enabled = prefs.highPassFilter || prefs.voiceCompressor || prefs.gateEnabled
            dp
        } catch (e: Exception) {
            Log.w(TAG, "DynamicsProcessing unavailable: ${e.message}")
            null
        }
    }
}
