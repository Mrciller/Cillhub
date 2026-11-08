package io.github.mrciller.cillhub

import org.json.JSONObject

/**
 * v9-style gateway session logic, without any transport (unit-tested): HELLO -> IDENTIFY or RESUME,
 * heartbeats with the last sequence, dispatch numbering, op 7/9 and the close codes that end the session.
 * The transport (GatewayConnection) feeds frames in and acts on the returned [Action].
 */
class GatewayProtocol(
    private val token: () -> String?,
    private val properties: JSONObject,
    private val send: (String) -> Unit,
    private val dispatch: (type: String, data: JSONObject?) -> Unit,
    /** Whether the user is away from the app (nothing visible): op 3 afk after READY, so the server keeps pushes going. */
    private val afk: () -> Boolean = { true },
) {
    enum class Action { NONE, START_HEARTBEAT, RECONNECT, STOP }

    var sessionId: String? = null; private set
    var seq: Long? = null; private set
    var heartbeatMs: Long = 41250; private set
    private var acked = true

    /** Called for each text frame. */
    fun onText(text: String): Action {
        val f = try { JSONObject(text) } catch (e: Exception) { return Action.NONE }
        if (!f.isNull("s")) seq = f.optLong("s")
        return when (f.optInt("op", -1)) {
            10 -> {
                heartbeatMs = f.optJSONObject("d")?.optLong("heartbeat_interval", 41250) ?: 41250
                acked = true
                val t = token() ?: return Action.STOP
                val sid = sessionId
                if (sid != null && seq != null) {
                    send(JSONObject().put("op", 6).put("d", JSONObject().put("token", t).put("session_id", sid).put("seq", seq)).toString())
                } else identify(t)
                Action.START_HEARTBEAT
            }
            11 -> { acked = true; Action.NONE }
            1 -> { heartbeatNow(); Action.NONE }
            7 -> Action.RECONNECT
            9 -> {
                // invalid session (our RESUME was refused): identify afresh on this socket
                identify(token() ?: return Action.STOP)
                Action.NONE
            }
            0 -> {
                val type = f.optString("t")
                val d = f.optJSONObject("d")
                if (type == "READY") {
                    sessionId = d?.optString("session_id")?.takeIf { it.isNotEmpty() }
                    // a background connection is not the user being active: keep Web Push going to their other devices
                    send(presence(afk()))
                }
                dispatch(type, d)
                Action.NONE
            }
            else -> Action.NONE
        }
    }

    /** Op 3 with only the AFK flag: never overwrites the user's saved status. */
    fun presence(afk: Boolean): String = JSONObject().put("op", 3).put("d", JSONObject().put("afk", afk)).toString()

    /** Op 3 that sets (and the server persists) the user's status. */
    fun status(status: String, afk: Boolean): String =
        JSONObject().put("op", 3).put("d", JSONObject().put("status", status).put("since", 0).put("afk", afk)).toString()

    private fun identify(t: String) {
        sessionId = null; seq = null
        send(JSONObject().put("op", 2).put("d", JSONObject().put("token", t).put("properties", properties)).toString())
    }

    private fun heartbeatNow() {
        send(JSONObject().put("op", 1).put("d", seq ?: JSONObject.NULL).toString())
    }

    /** Timer tick. False when the previous heartbeat was never acked: the connection is a zombie, reconnect. */
    fun heartbeat(): Boolean {
        if (!acked) return false
        acked = false
        heartbeatNow()
        return true
    }

    /** Socket closed with this code: what to do next. */
    fun onClose(code: Int): Action = when (code) {
        4004 -> { sessionId = null; seq = null; Action.STOP } // token revoked or wrong
        4010, 4011, 4012, 4013, 4014 -> Action.STOP
        4007, 4009 -> { sessionId = null; seq = null; Action.RECONNECT }
        else -> Action.RECONNECT
    }
}
