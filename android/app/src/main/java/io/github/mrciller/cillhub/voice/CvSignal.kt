package io.github.mrciller.cillhub.voice

import org.json.JSONArray
import org.json.JSONObject

/**
 * The pure half of cillvoice signalling (server/README.md "cillvoice", the web client's src/voice/cillvoice.ts): which
 * receive transceivers carry which remote track, the op 50 payload, the answer, the SDP munging and the send layers.
 * CillvoiceVoice does the WebRTC calls around it. Unit-tested.
 */
object CvSignal {
    const val OP = 50
    val SOURCES = listOf("microphone", "camera", "screen_share", "screen_share_audio")

    /** A remote track the server offers us (CILLVOICE_TRACKS / CILLVOICE_ANSWER `tracks`). */
    data class Track(val id: String, val userId: String, val kind: String, val source: String)

    /** A receive transceiver that carries nothing and can take a remote track of its kind. */
    data class Free(val mid: String, val kind: String)

    /** What one negotiation round changes: mids to release, then each wanted track with a free mid to reuse (or null: add a transceiver). */
    data class Plan(val unmap: List<String>, val add: List<Pair<String?, Track>>)

    fun plan(remote: List<Track>, mapped: Map<String, Track>, free: List<Free>): Plan {
        val want = remote.associateBy { it.id }
        val unmap = mapped.filterValues { it.id !in want }.keys.toList()
        val have = mapped.filterKeys { it !in unmap }.values.map { it.id }.toSet()
        val pool = (free + unmap.mapNotNull { m -> mapped[m]?.let { Free(m, it.kind) } }).toMutableList()
        val add = want.values.filter { it.id !in have }.map { t ->
            val f = pool.firstOrNull { it.kind == t.kind }?.also { pool.remove(it) }
            f?.mid to t
        }
        return Plan(unmap, add)
    }

    /** Op 50 CILLVOICE_SIGNAL: the offer, which send transceivers carry which source, which receive mid carries which track. */
    fun signal(token: String, sdp: String, publish: Map<String, String>, subscribe: Map<String, Track>): JSONObject = JSONObject()
        .put("token", token)
        .put("sdp", sdp)
        .put("publish", JSONArray().also { a -> publish.forEach { (source, mid) -> a.put(JSONObject().put("mid", mid).put("source", source)) } })
        .put("subscribe", JSONArray().also { a -> subscribe.forEach { (mid, t) -> a.put(JSONObject().put("mid", mid).put("track_id", t.id)) } })

    data class Answer(val sdp: String, val subscribed: Set<String>, val tracks: List<Track>)

    fun tracks(a: JSONArray?): List<Track> = (0 until (a?.length() ?: 0)).mapNotNull { i ->
        a!!.optJSONObject(i)?.let { Track(it.optString("id"), it.optString("user_id"), it.optString("kind"), it.optString("source")) }?.takeIf { it.id.isNotEmpty() }
    }

    fun answer(d: JSONObject): Answer {
        val sub = d.optJSONArray("subscribed")
        return Answer(
            d.optString("sdp"),
            (0 until (sub?.length() ?: 0)).mapNotNull { sub!!.optJSONObject(it)?.optString("mid") }.toSet(),
            tracks(d.optJSONArray("tracks")),
        )
    }

    /** Opus DTX is the receiver's wish in SDP: adds usedtx=1 to our microphone's m-section of the answer when wanted. */
    fun munge(sdp: String, micMid: String?, dtx: Boolean): String {
        if (!dtx || micMid == null) return sdp
        return sdp.split("\r\nm=").joinToString("\r\nm=") { sec ->
            if ("\r\na=mid:$micMid\r\n" in sec) sec.replace(Regex("(a=fmtp:\\d+ minptime=10;useinbandfec=1)"), "$1;usedtx=1") else sec
        }
    }

    const val RID = "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id"

    /**
     * Keeps the RID header extension on our simulcast send sections. The server answers a camera or screen section that
     * went inactive without it, and Android's libwebrtc then refuses its next offer ("negotiates simulcast but does not
     * negotiate the RID RTP header extension"); adding our own offer's extmap line to the answer keeps it negotiated.
     */
    fun keepRid(answer: String, offer: String, mids: Set<String>): String {
        if (mids.isEmpty()) return answer
        val ids = offer.split("\r\nm=").mapNotNull { sec ->
            val mid = Regex("\r\na=mid:(\\S+)").find(sec)?.groupValues?.get(1) ?: return@mapNotNull null
            val id = Regex("\r\na=extmap:(\\d+) ${Regex.escape(RID)}").find(sec)?.groupValues?.get(1) ?: return@mapNotNull null
            mid to id
        }.toMap()
        return answer.split("\r\nm=").joinToString("\r\nm=") { sec ->
            val mid = Regex("\r\na=mid:(\\S+)").find(sec)?.groupValues?.get(1)
            val id = ids[mid]
            if (mid == null || mid !in mids || id == null || RID in sec || !sec.startsWith("video ") || sec.startsWith("video 0 ")) sec
            else sec.replace("\r\na=mid:$mid", "\r\na=mid:$mid\r\na=extmap:$id $RID")
        }
    }

    /** Puts the wanted codecs first (by name, e.g. "H264"), keeping the rest in their order; the server answers in this order. */
    fun <T> preferCodecs(all: List<T>, name: (T) -> String, wanted: List<String>): List<T> {
        val rank = { c: T -> wanted.indexOfFirst { it.equals(name(c), ignoreCase = true) }.let { if (it < 0) wanted.size else it } }
        return all.sortedBy(rank)
    }

    /** One simulcast layer as sent: rid, scale-down and caps. */
    data class Layer(val rid: String, val scaleDown: Double, val maxBitrate: Int, val maxFramerate: Int? = null)

    // cillvoice.ts CAMERA_LAYERS: every layer names its scale, so the encoder does not apply its own simulcast table
    val CAMERA_LAYERS = listOf(Layer("q", 4.0, 150_000), Layer("h", 2.0, 450_000), Layer("f", 1.0, 1_700_000))

    /** cillvoice.ts screenLayers: the full layer as chosen and a half-size one at a quarter of the rate. */
    fun screenLayers(q: ScreenQuality) = listOf(
        Layer("h", 2.0, q.bitrate / 4, minOf(q.fps, 15)),
        Layer("f", 1.0, q.bitrate, q.fps),
    )
}
