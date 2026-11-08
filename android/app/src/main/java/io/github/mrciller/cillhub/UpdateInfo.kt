package io.github.mrciller.cillhub

import org.json.JSONObject
import java.io.File
import java.io.InputStream
import java.security.MessageDigest

/**
 * android/cillhub.json from the download page: {versionCode, versionName, url, sha256, notes, abis?} (pure, unit-tested).
 * `abis` maps an ABI ("arm64-v8a") to {url, sha256} of the APK built for it; the phone takes the first of its own ABIs
 * (Build.SUPPORTED_ABIS, best first) the feed has, else `url`, the universal APK.
 */
data class UpdateInfo(val versionCode: Int, val versionName: String, val url: String, val sha256: String, val notes: String) {
    companion object {
        private val HEX64 = Regex("^[0-9a-f]{64}$")

        /** Null unless well-formed and the APK comes from the app's own origin over the same scheme. */
        fun parse(json: String, origin: String, abis: List<String> = emptyList()): UpdateInfo? = try {
            val o = JSONObject(json)
            val code = o.getInt("versionCode")
            val split = o.optJSONObject("abis")?.let { m -> abis.firstNotNullOfOrNull { m.optJSONObject(it) } }
            val url = split?.getString("url") ?: o.getString("url")
            val sha = (split?.getString("sha256") ?: o.getString("sha256")).lowercase()
            if (code <= 0 || !HEX64.matches(sha) || Origins.of(url) != origin || !url.substringBefore('?').endsWith(".apk")) null
            else UpdateInfo(code, o.optString("versionName", code.toString()).take(40), url, sha, o.optString("notes").take(2000))
        } catch (e: Exception) {
            null
        }

        fun sha256(input: InputStream): String {
            val md = MessageDigest.getInstance("SHA-256")
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
            return md.digest().joinToString("") { "%02x".format(it) }
        }

        fun verify(file: File, expected: String): Boolean = file.inputStream().use { sha256(it) } == expected.lowercase()
    }
}
