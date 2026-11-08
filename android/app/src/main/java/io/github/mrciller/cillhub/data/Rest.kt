package io.github.mrciller.cillhub.data

import io.github.mrciller.cillhub.Api
import io.github.mrciller.cillhub.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/** An API error: HTTP status (0 = unreachable), v9 error code, the server's message, and retry_after for 429s. */
class ApiError(val status: Int, val code: Int, message: String, val retryAfter: Double = 0.0) : IOException(message) {
    companion object {
        /** The first field message of a 50035 answer ("Username is unavailable."), else the message. */
        fun parse(status: Int, text: String, retryHeader: String?): ApiError {
            val body = runCatching { json.parseToJsonElement(text).jsonObject }.getOrNull()
            val code = body?.get("code")?.jsonPrimitive?.intOrNull ?: 0
            val msg = (if (code == 50035) firstFieldError(body?.get("errors")) else null) ?: body?.get("message")?.jsonPrimitive?.contentOrNull ?: "Request failed ($status)"
            val retry = body?.get("retry_after")?.jsonPrimitive?.doubleOrNull ?: retryHeader?.toDoubleOrNull() ?: 0.0
            return ApiError(status, code, msg, retry)
        }

        private fun firstFieldError(e: JsonElement?): String? {
            val o = e as? JsonObject ?: return null
            o["_errors"]?.jsonArray?.firstOrNull()?.jsonObject?.get("message")?.jsonPrimitive?.contentOrNull?.let { return it }
            return o.values.firstNotNullOfOrNull { firstFieldError(it) }
        }
    }
}

/** A file to upload: opened lazily so large files stream instead of sitting in memory. */
class Upload(val name: String, val size: Long, val mime: String, val open: () -> java.io.InputStream)

/**
 * Suspending REST client for the UI (OkHttp + kotlinx.serialization). Rate limits: a 429 with a short retry_after
 * is waited out and retried (twice at most); message sends never retry silently, so slowmode reaches the user.
 */
class Rest(private val base: () -> String, private val token: () -> String?) {
    private val JSON = "application/json".toMediaType()

    suspend fun request(method: String, path: String, body: JsonElement? = null, retry: Boolean = true): String =
        send(retry) { b ->
            val rb = body?.toString()?.toRequestBody(JSON) ?: if (method in setOf("POST", "PUT", "PATCH")) ByteArray(0).toRequestBody(null) else null
            b.url(base() + path).method(method, rb)
        }

    suspend inline fun <reified T> get(path: String): T = json.decodeFromString(request("GET", path))
    suspend inline fun <reified T> call(method: String, path: String, body: JsonElement? = null): T = json.decodeFromString(request(method, path, body))

    /** POST multipart with payload_json and files[n] (CONTRACT-v2 section 6), reporting upload progress 0..1. */
    suspend fun multipart(path: String, payload: JsonObject, files: List<Upload>, progress: (Float) -> Unit = {}): String {
        val total = files.sumOf { it.size }.coerceAtLeast(1)
        var sent = 0L
        val form = MultipartBody.Builder().setType(MultipartBody.FORM).addFormDataPart("payload_json", payload.toString())
        files.forEachIndexed { i, f ->
            form.addFormDataPart("files[$i]", f.name, object : RequestBody() {
                override fun contentType() = f.mime.toMediaType()
                override fun contentLength() = if (f.size > 0) f.size else -1
                override fun writeTo(sink: okio.BufferedSink) {
                    f.open().use { input ->
                        val buf = ByteArray(32 * 1024)
                        while (true) {
                            val n = input.read(buf)
                            if (n < 0) break
                            sink.write(buf, 0, n)
                            sent += n
                            progress((sent.toFloat() / total).coerceAtMost(1f))
                        }
                    }
                }
            })
        }
        return send(retry = false) { it.url(base() + path).post(form.build()) }
    }

    private suspend fun send(retry: Boolean, build: (Request.Builder) -> Request.Builder): String {
        var attempt = 0
        while (true) {
            val b = Request.Builder().header("User-Agent", "Cillhub-Android/${BuildConfig.VERSION_NAME}")
            token()?.let { b.header("Authorization", it) }
            val req = build(b).build()
            val (code, text, retryAfter) = withContext(Dispatchers.IO) {
                try {
                    Api.http.newCall(req).execute().use { Triple(it.code, it.body.string(), it.header("Retry-After")) }
                } catch (e: IOException) {
                    throw ApiError(0, 0, e.message ?: "unreachable")
                }
            }
            if (code in 200..299) return text
            val err = ApiError.parse(code, text, retryAfter)
            if (code == 429 && retry && attempt < 2 && err.retryAfter in 0.0..5.0) {
                attempt++
                delay((err.retryAfter * 1000).toLong() + 100)
                continue
            }
            throw err
        }
    }
}
