package io.github.mrciller.cillhub

import android.content.Context
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit

/** The few REST calls the native side makes (blocking; call off the main thread). */
class Api(private val token: String) {
    class HttpError(val status: Int, msg: String) : IOException(msg)

    companion object {
        val http: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .pingInterval(0, TimeUnit.SECONDS)
            .build()
        private val JSON = "application/json".toMediaType()

        fun of(ctx: Context): Api? = TokenStore.get(ctx)?.let { Api(it) }
    }

    private fun call(method: String, path: String, body: JSONObject? = null): String {
        val req = Request.Builder().url(Config.API + path)
            .header("Authorization", token)
            .header("User-Agent", "Cillhub-Android/${BuildConfig.VERSION_NAME}")
            .method(method, body?.toString()?.toRequestBody(JSON) ?: if (method == "POST" || method == "PUT") ByteArray(0).toRequestBody(null) else null)
            .build()
        http.newCall(req).execute().use { res ->
            val text = res.body.string()
            if (!res.isSuccessful) throw HttpError(res.code, "$method ${path.substringBefore('?')} -> ${res.code}")
            return text
        }
    }

    fun me(): JSONObject = JSONObject(call("GET", "/users/@me"))
    fun channel(id: String): JSONObject = JSONObject(call("GET", "/channels/$id"))
    fun message(channelId: String, id: String): JSONObject = JSONObject(call("GET", "/channels/$channelId/messages/$id"))
    fun member(guildId: String, userId: String): JSONObject = JSONObject(call("GET", "/guilds/$guildId/members/$userId"))
    fun guild(id: String): JSONObject = JSONObject(call("GET", "/guilds/$id"))

    fun send(channelId: String, content: String): JSONObject = JSONObject(
        call("POST", "/channels/$channelId/messages", JSONObject().put("content", content).put("nonce", System.currentTimeMillis().toString()))
    )
    fun ack(channelId: String, messageId: String) { call("POST", "/channels/$channelId/messages/$messageId/ack", JSONObject()) }
    fun stopRinging(channelId: String) { call("POST", "/channels/$channelId/call/stop-ringing", JSONObject()) }

    fun fcmEnabled(): Boolean = JSONObject(call("GET", "/push/fcm")).optBoolean("enabled")
    fun registerFcm(fcmToken: String) { call("POST", "/users/@me/fcm-tokens", JSONObject().put("token", fcmToken)) }
    fun unregisterFcm(fcmToken: String) { call("DELETE", "/users/@me/fcm-tokens", JSONObject().put("token", fcmToken)) }
}
