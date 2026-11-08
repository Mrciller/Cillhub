package io.github.mrciller.cillhub

import okhttp3.Request
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/** A minimal second client for the tests (the "other user"): identify, wait for dispatches, send ops. */
class TestGateway(token: String) {
    private val frames = LinkedBlockingQueue<JSONObject>()
    private val seen = ArrayList<JSONObject>()
    private val ws: WebSocket = Api.http.newWebSocket(Request.Builder().url(Config.GATEWAY).build(), object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) { frames.add(JSONObject(text)) }
    })
    val ready: JSONObject

    init {
        next { it.optInt("op") == 10 }
        ws.send(JSONObject().put("op", 2).put("d", JSONObject().put("token", token).put("properties", JSONObject().put("os", "test"))).toString())
        ready = event("READY")
    }

    fun send(op: Int, d: JSONObject) = ws.send(JSONObject().put("op", op).put("d", d).toString())

    fun next(timeoutMs: Long = 15_000, pred: (JSONObject) -> Boolean): JSONObject {
        synchronized(seen) { seen.firstOrNull(pred)?.let { seen.remove(it); return it } }
        val end = System.currentTimeMillis() + timeoutMs
        while (true) {
            val left = end - System.currentTimeMillis()
            if (left <= 0) throw AssertionError("timed out waiting for a gateway frame")
            val f = frames.poll(left, TimeUnit.MILLISECONDS) ?: continue
            if (pred(f)) return f
            synchronized(seen) { seen.add(f) }
        }
    }

    fun event(t: String, timeoutMs: Long = 15_000, pred: (JSONObject) -> Boolean = { true }): JSONObject =
        next(timeoutMs) { it.optString("t") == t && pred(it.optJSONObject("d") ?: JSONObject()) }.getJSONObject("d")

    fun close() = ws.close(1000, null)
}
