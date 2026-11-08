package io.github.mrciller.cillhub

import android.content.Context

/** Local app settings (not synced). */
class Prefs(ctx: Context) {
    private val p = ctx.getSharedPreferences("settings", Context.MODE_PRIVATE)

    /** Foreground service with the native gateway connection; the delivery path that needs no Firebase. */
    var background: Boolean
        get() = p.getBoolean("background", true)
        set(v) = p.edit().putBoolean("background", v).apply()

    /** The FCM registration token currently registered with the server, if any. */
    var fcmRegistered: String?
        get() = p.getString("fcm_registered", null)
        set(v) = p.edit().putString("fcm_registered", v).apply()

    /** The server the user signed in to; null = the default hub. */
    var serverUrl: String?
        get() = p.getString("server_url", null)
        set(v) = p.edit().putString("server_url", v).apply()

    /** "system" | "light" | "dark" */
    var theme: String
        get() = p.getString("theme", "system") ?: "system"
        set(v) = p.edit().putString("theme", v).apply()

    /** Material You colours from the wallpaper (Android 12+); off by default, the Cillhub palette is the default. */
    var dynamicColor: Boolean
        get() = p.getBoolean("dynamic_color", false)
        set(v) = p.edit().putBoolean("dynamic_color", v).apply()

    /** "" = follow the system, else a language tag ("en", "de"); used below Android 13 (13+ keeps it in LocaleManager). */
    var language: String
        get() = p.getString("language", "") ?: ""
        set(v) = p.edit().putString("language", v).commit().let { }

    var lastUpdateCheck: Long
        get() = p.getLong("last_update_check", 0)
        set(v) = p.edit().putLong("last_update_check", v).apply()

    /** versionCode the user dismissed, so the start-up prompt is not repeated for it. */
    var skippedVersion: Int
        get() = p.getInt("skipped_version", 0)
        set(v) = p.edit().putInt("skipped_version", v).apply()

    /** Whether to send/receive DM read receipts ("seen by"). */
    var dmReadReceipts: Boolean
        get() = p.getBoolean("dm_read_receipts", true)
        set(v) = p.edit().putBoolean("dm_read_receipts", v).apply()
}
