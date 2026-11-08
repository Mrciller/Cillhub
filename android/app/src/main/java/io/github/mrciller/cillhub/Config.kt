package io.github.mrciller.cillhub

/**
 * Server addresses. The default hub is BuildConfig.APP_URL (the single prodUrl in app/build.gradle.kts; debug builds
 * take -Pcillhub.url). The user may sign in to another server ("Use another server"); that choice lives in Prefs.
 */
object Config {
    val DEFAULT_URL: String = BuildConfig.APP_URL.trimEnd('/')
    val DEFAULT_ORIGIN: String = requireNotNull(Origins.of(DEFAULT_URL)) { "bad APP_URL" }
    /** App updates always come from the default hub, whatever server the user chose. */
    val UPDATE_FEED: String = "$DEFAULT_URL/download/android/cillhub.json"

    /** The server in use (set at start from Prefs and on login). */
    @Volatile var APP_URL: String = DEFAULT_URL
    val ORIGIN: String get() = Origins.of(APP_URL) ?: DEFAULT_ORIGIN
    val API: String get() = "$APP_URL/api/v9"
    val GATEWAY: String get() = APP_URL.replaceFirst("http", "ws") + "/gateway?v=9&encoding=json"

    /** Root-relative CDN paths (avatars, attachments) resolve against the server. */
    fun cdn(path: String): String = if (path.startsWith("http://") || path.startsWith("https://")) path else APP_URL + path

    fun isDefault() = Origins.of(APP_URL) == DEFAULT_ORIGIN
}
