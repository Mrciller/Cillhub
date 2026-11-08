package io.github.mrciller.cillhub

import java.net.URI

/** Origin checks for navigation, permissions and the JS bridge (pure Kotlin, unit-tested). */
object Origins {
    /** "scheme://host[:port]" for http(s) URLs, else null. Default ports are dropped, as browsers do. */
    fun of(url: String?): String? = try {
        val u = URI(url ?: return null)
        val scheme = u.scheme?.lowercase()
        val host = u.host?.lowercase()
        if ((scheme != "https" && scheme != "http") || host.isNullOrEmpty()) null
        else {
            val default = (scheme == "https" && u.port == 443) || (scheme == "http" && u.port == 80)
            if (u.port == -1 || default) "$scheme://$host" else "$scheme://$host:${u.port}"
        }
    } catch (e: Exception) {
        null
    }

    fun same(url: String?, origin: String): Boolean = of(url) == origin

    /** The bridge only talks to the app's own origin, and only from the top frame (no iframes, e.g. embeds). */
    fun bridgeAccepts(sourceOrigin: String?, isMainFrame: Boolean, origin: String): Boolean =
        isMainFrame && of(sourceOrigin) == origin
}
