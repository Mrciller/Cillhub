package io.github.mrciller.cillhub

import android.app.Activity
import android.app.AlarmManager
import android.app.PendingIntent
import android.app.AlertDialog
import android.content.Context
import android.content.Intent
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.util.Log
import android.widget.Toast
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import okhttp3.Request
import java.io.File

/**
 * Self-update from <origin>/download/android/cillhub.json: checked at start and daily, the feed must carry a valid
 * cillhub.json.sig from a pinned release key (UpdateInfo.KEYS), the APK is downloaded, its SHA-256 checked against
 * the feed, and the user confirms the install (PackageInstaller session; Android also requires the same signing key
 * as the installed app).
 */
object Updater {
    private const val TAG = "CillcordUpdate"
    private const val MAX_APK = 200L * 1024 * 1024
    private val main = Handler(Looper.getMainLooper())

    fun scheduleDaily(ctx: Context) {
        val pi = PendingIntent.getBroadcast(ctx, 31, Intent(ctx, ActionReceiver::class.java).setAction(ActionReceiver.CHECK_UPDATE), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        ctx.getSystemService(AlarmManager::class.java)
            .setInexactRepeating(AlarmManager.ELAPSED_REALTIME, SystemClock.elapsedRealtime() + AlarmManager.INTERVAL_DAY, AlarmManager.INTERVAL_DAY, pi)
    }

    /** Blocking. The newer release, or null. */
    fun fetch(): UpdateInfo? {
        val get = { url: String -> Api.http.newCall(Request.Builder().url(url).header("Cache-Control", "no-cache").build()).execute().use { res -> if (res.isSuccessful) res.body.bytes() else null } }
        val feed = get(Config.UPDATE_FEED) ?: return null
        val sig = get(Config.UPDATE_FEED + ".sig") ?: return null
        if (!UpdateInfo.signed(feed, sig)) { Log.w(TAG, "feed signature does not verify"); return null }
        val info = UpdateInfo.parse(String(feed), Config.DEFAULT_ORIGIN, android.os.Build.SUPPORTED_ABIS.toList()) ?: return null
        return info.takeIf { it.versionCode > BuildConfig.VERSION_CODE }
    }

    /** At app start: ask in a dialog. interactive (settings button): also say when there is nothing new. */
    fun checkFromActivity(activity: Activity, interactive: Boolean) {
        val prefs = Prefs(activity)
        Thread {
            val info = try { fetch() } catch (e: Exception) { Log.i(TAG, "check failed: ${e.message}"); null }
            prefs.lastUpdateCheck = System.currentTimeMillis()
            main.post {
                if (activity.isFinishing) return@post
                if (info == null) { if (interactive) Toast.makeText(activity, R.string.update_none, Toast.LENGTH_SHORT).show(); return@post }
                if (!interactive && prefs.skippedVersion == info.versionCode) return@post
                AlertDialog.Builder(activity)
                    .setTitle(activity.getString(R.string.update_title, info.versionName))
                    .setMessage(info.notes.ifBlank { activity.getString(R.string.update_text) })
                    .setPositiveButton(R.string.update_install) { _, _ -> install(activity, info) }
                    .setNegativeButton(R.string.update_later) { _, _ -> prefs.skippedVersion = info.versionCode }
                    .show()
            }
        }.start()
    }

    /** Daily alarm: only a notification; installing needs the user anyway. */
    fun checkInBackground(ctx: Context) {
        val info = try { fetch() } catch (e: Exception) { null } ?: return
        Prefs(ctx).lastUpdateCheck = System.currentTimeMillis()
        val open = PendingIntent.getActivity(ctx, 32, Intent(ctx, MainActivity::class.java).putExtra(MainActivity.EXTRA_UPDATE, true), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(ctx, Notifications.CH_UPDATES).setSmallIcon(R.drawable.ic_stat_cillcord)
            .setContentTitle(ctx.getString(R.string.update_title, info.versionName)).setContentText(ctx.getString(R.string.update_tap))
            .setContentIntent(open).setAutoCancel(true).build()
        try { NotificationManagerCompat.from(ctx).notify(Notifications.ID_UPDATE, n) } catch (e: SecurityException) { }
    }

    fun install(activity: Activity, info: UpdateInfo) {
        val pm = activity.packageManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !pm.canRequestPackageInstalls()) {
            Toast.makeText(activity, R.string.update_allow_installs, Toast.LENGTH_LONG).show()
            activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${activity.packageName}")))
            return
        }
        Toast.makeText(activity, R.string.update_downloading, Toast.LENGTH_SHORT).show()
        val ctx = activity.applicationContext
        Thread {
            val ok = try { download(ctx, info) } catch (e: Exception) { Log.w(TAG, "download failed: ${e.message}"); null }
            if (ok == null) { main.post { Toast.makeText(ctx, R.string.update_failed, Toast.LENGTH_LONG).show() }; return@Thread }
            try { commit(ctx, ok) } catch (e: Exception) { Log.w(TAG, "install failed: ${e.message}"); main.post { Toast.makeText(ctx, R.string.update_failed, Toast.LENGTH_LONG).show() } }
        }.start()
    }

    /** Downloads into the app's cache and returns the file only if its SHA-256 matches the feed. */
    fun download(ctx: Context, info: UpdateInfo): File? {
        val dir = File(ctx.cacheDir, "updates").apply { mkdirs(); listFiles()?.forEach { it.delete() } }
        val file = File(dir, "cillhub-${info.versionCode}.apk")
        try {
            Api.http.newCall(Request.Builder().url(info.url).build()).execute().use { res ->
                if (!res.isSuccessful) { file.delete(); return null }
                // a redirect must not take us to another origin
                if (Origins.of(res.request.url.toString()) != Config.DEFAULT_ORIGIN) { file.delete(); return null }
                val body = res.body
                if (body.contentLength() > MAX_APK) { file.delete(); return null }
                body.byteStream().use { input -> file.outputStream().use { out ->
                    val buf = ByteArray(64 * 1024); var total = 0L
                    while (true) {
                        val n = input.read(buf)
                        if (n < 0) break
                        total += n
                        if (total > MAX_APK) {
                            file.delete()
                            return null
                        }
                        out.write(buf, 0, n)
                    }
                } }
            }
        } catch (e: Exception) {
            file.delete()
            throw e
        }
        if (!UpdateInfo.verify(file, info.sha256)) { file.delete(); Log.w(TAG, "sha256 mismatch"); return null }
        return file
    }

    private fun commit(ctx: Context, apk: File) {
        val installer = ctx.packageManager.packageInstaller
        val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
        params.setAppPackageName(ctx.packageName)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_REQUIRED)
        val id = installer.createSession(params)
        installer.openSession(id).use { session ->
            session.openWrite("cillhub.apk", 0, apk.length()).use { out -> apk.inputStream().use { it.copyTo(out) }; session.fsync(out) }
            val status = PendingIntent.getBroadcast(ctx, 33, Intent(ctx, ActionReceiver::class.java).setAction(ActionReceiver.INSTALL_STATUS),
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE) // the installer adds its status extras
            session.commit(status.intentSender)
        }
    }
}
