package io.github.mrciller.cillhub.voice

import android.content.Intent
import livekit.org.webrtc.VideoTrack
import org.json.JSONObject

/** One video in the call grid: someone's camera or screen share (ours included). */
data class Tile(
    val userId: String, val screen: Boolean, val track: VideoTrack, val local: Boolean,
    /** LiveKit's own track: renderers go through it, so adaptive stream sees what is on screen (and pauses what is not). */
    val lk: io.livekit.android.room.track.VideoTrack? = null,
) {
    val key get() = "$userId:${if (screen) "screen" else "camera"}"
}

/** Counters from getStats() for the tests and the connection details: what flows in and out right now. */
data class VoiceStats(
    val audioInPackets: Long = 0, val audioInLevel: Double = 0.0,
    val audioOutPackets: Long = 0, val audioOutBytes: Long = 0,
    val videoIn: List<Video> = emptyList(), val videoOut: List<Video> = emptyList(),
) {
    data class Video(val frames: Long, val width: Int, val height: Int, val codec: String)
}

/** What the voice manager (Voice) needs from a media backend: LiveKit or cillvoice. Calls arrive on Voice's single thread. */
interface VoiceBackend {
    val name: String
    fun connect()
    fun close()
    suspend fun setMic(on: Boolean)
    /** Volume per remote user, 0 when deafened (remote audio only; 1.0 = 100 %). */
    fun applyVolumes(volume: (userId: String) -> Double)
    suspend fun setCamera(on: Boolean, front: Boolean)
    fun flipCamera(front: Boolean)
    suspend fun startScreen(data: Intent, q: ScreenQuality, codecs: List<String>)
    suspend fun stopScreen()
    fun tiles(myId: String): List<Tile>
    /** Noise suppression, echo cancellation or auto gain changed: capture the microphone again with them. */
    suspend fun restartMic()
    /** The phone moved to another network (cillvoice restarts ICE; LiveKit reconnects by itself). */
    fun networkChanged() {}
    /** CILLVOICE_* dispatches. */
    fun onGateway(t: String, d: JSONObject) {}
    suspend fun stats(): VoiceStats

    /** Events back to Voice (any thread). */
    interface Listener {
        fun connected()
        fun reconnecting()
        fun lost(detail: String)
        fun speaking(ids: Set<String>)
        fun tracksChanged()
        fun screenEnded()
    }
}

/** Aggregates WebRTC stats reports (member maps) into [VoiceStats]; shared by both backends. */
object StatsSummary {
    fun of(reports: List<Map<String, Map<String, Any?>>>): VoiceStats {
        var aIn = 0L; var level = 0.0; var aOut = 0L; var aOutBytes = 0L
        val vIn = mutableListOf<VoiceStats.Video>(); val vOut = mutableListOf<VoiceStats.Video>()
        for (r in reports) for ((type, m) in r.values.map { (it["type"] as? String ?: "") to it }) {
            val kind = m["kind"] as? String
            val codec = (m["codecId"] as? String)?.let { r[it]?.get("mimeType") as? String }?.substringAfter('/') ?: ""
            fun num(k: String) = (m[k] as? Number)?.toLong() ?: 0L
            fun int(k: String) = (m[k] as? Number)?.toInt() ?: 0
            when {
                type == "inbound-rtp" && kind == "audio" -> { aIn += num("packetsReceived"); level = maxOf(level, (m["audioLevel"] as? Number)?.toDouble() ?: 0.0) }
                type == "outbound-rtp" && kind == "audio" -> { aOut += num("packetsSent"); aOutBytes += num("bytesSent") }
                type == "inbound-rtp" && kind == "video" -> vIn += VoiceStats.Video(num("framesDecoded"), int("frameWidth"), int("frameHeight"), codec)
                type == "outbound-rtp" && kind == "video" -> vOut += VoiceStats.Video(num("framesEncoded"), int("frameWidth"), int("frameHeight"), codec)
            }
        }
        return VoiceStats(aIn, level, aOut, aOutBytes, vIn, vOut)
    }
}
