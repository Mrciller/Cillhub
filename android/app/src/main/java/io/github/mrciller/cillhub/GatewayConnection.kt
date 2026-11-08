package io.github.mrciller.cillhub

import android.os.Build
import android.util.Log
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import kotlin.random.Random

/** Reconnect delays: 1 s doubling to 60 s, plus up to 50 % jitter so clients do not reconnect in step (unit-tested). */
class Backoff(private val min: Long = 1000L, private val max: Long = 60_000L, private val random: (Long) -> Long = { Random.nextLong(it) }) {
    private var current = min
    fun next(): Long {
        val wait = current + random(current / 2 + 1)
        current = minOf(current * 2, max)
        return wait
    }
    fun reset() { current = min }
}

/**
 * The WebSocket transport around [GatewayProtocol]: connects, heartbeats, reconnects with backoff
 * (1 s doubling to 60 s, reset once a session is ready) and resumes. All state lives on one thread.
 */
class GatewayConnection(
    private val token: () -> String?,
    private val onDispatch: (String, JSONObject?) -> Unit,
    private val onState: (connected: Boolean) -> Unit,
    private val onAuthFailed: () -> Unit,
    private val afk: () -> Boolean = { true },
) {
    private val exec = Executors.newSingleThreadScheduledExecutor { Thread(it, "cillcord-gateway") }
    private var ws: WebSocket? = null
    private var generation = 0
    private var stopped = false
    private val backoff = Backoff()
    private var beat: ScheduledFuture<*>? = null
    private var retry: ScheduledFuture<*>? = null

    private val protocol = GatewayProtocol(
        token = token,
        properties = JSONObject().put("os", "Android").put("browser", "Cillhub Android").put("device", Build.MODEL ?: "Android"),
        send = { ws?.send(it) },
        dispatch = { t, d ->
            if (t == "READY" || t == "RESUMED") { backoff.reset(); onState(true) }
            onDispatch(t, d)
        },
        afk = afk,
    )

    /** Sends a frame built by the protocol (presence, status) if a session is up; dropped otherwise (IDENTIFY/READY resend state). */
    fun send(frame: GatewayProtocol.() -> String) = exec.execute { if (protocol.sessionId != null) ws?.send(protocol.frame()) }

    /** Any op (voice state op 4, cillvoice op 50) while a session is up; false if it could not be queued. */
    fun op(op: Int, d: JSONObject) = send { JSONObject().put("op", op).put("d", d).toString() }

    fun start() = exec.execute { stopped = false; if (ws == null && retry == null) connect() }

    fun stop() = exec.execute {
        stopped = true
        beat?.cancel(false); retry?.cancel(false); retry = null
        ws?.close(1000, null); ws = null
        generation++
    }

    /** The network came back: skip the remaining backoff. */
    fun kick() = exec.execute {
        if (!stopped && ws == null) { retry?.cancel(false); retry = null; backoff.reset(); connect() }
    }

    private fun connect() {
        retry = null
        if (stopped) return
        if (token() == null) return onAuthFailed()
        val gen = ++generation
        val url = try { Config.GATEWAY } catch (e: Exception) { return }
        ws = Api.http.newWebSocket(Request.Builder().url(url).header("User-Agent", "Cillhub-Android/${BuildConfig.VERSION_NAME}").build(), object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) = exec.execute { if (gen == generation) act(protocol.onText(text)) }
            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(1000, null) }
            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) = exec.execute { if (gen == generation) closed(code) }
            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) = exec.execute {
                if (gen == generation) { Log.i("CillcordGateway", "connection failed: ${t.javaClass.simpleName}"); closed(-1) }
            }
        })
    }

    private fun closed(code: Int) {
        ws = null
        beat?.cancel(false)
        onState(false)
        if (protocol.onClose(code) == GatewayProtocol.Action.STOP) { stopped = true; onAuthFailed() } else scheduleReconnect()
    }

    private fun act(a: GatewayProtocol.Action) {
        when (a) {
            GatewayProtocol.Action.START_HEARTBEAT -> {
                beat?.cancel(false)
                val every = protocol.heartbeatMs
                beat = exec.scheduleWithFixedDelay({ if (!protocol.heartbeat()) reconnect() }, (every * Random.nextDouble()).toLong(), every, TimeUnit.MILLISECONDS)
            }
            GatewayProtocol.Action.RECONNECT -> reconnect()
            GatewayProtocol.Action.STOP -> { stopped = true; ws?.close(1000, null); ws = null; onAuthFailed() }
            GatewayProtocol.Action.NONE -> {}
        }
    }

    /** Drop this socket (zombie, op 7) and connect again; HELLO then resumes the session. */
    private fun reconnect() {
        generation++
        beat?.cancel(false)
        ws?.cancel(); ws = null
        onState(false)
        scheduleReconnect()
    }

    private fun scheduleReconnect() {
        if (stopped || retry != null) return
        val wait = backoff.next()
        retry = exec.schedule({ connect() }, wait, TimeUnit.MILLISECONDS)
    }
}
