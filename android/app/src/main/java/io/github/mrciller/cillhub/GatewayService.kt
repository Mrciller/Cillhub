package io.github.mrciller.cillhub

import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import io.github.mrciller.cillhub.data.Session

/**
 * Background delivery without Firebase: a foreground service (type remoteMessaging) that keeps the app's gateway
 * connection (Session) open while no screen is visible, so Hub turns events into notifications. Shows a
 * minimum-priority notification.
 */
class GatewayService : Service() {
    companion object {
        private const val TAG = "CillcordGatewaySvc"
        @Volatile var running = false; private set
        /** The service runs and its connection is up. */
        val connected get() = running && Session.connected

        fun start(ctx: Context) = try {
            ContextCompat.startForegroundService(ctx, Intent(ctx, GatewayService::class.java))
        } catch (e: Exception) {
            Log.w(TAG, "not started: ${e.message}") // e.g. from the background on Android 12+; the next app start retries
        }

        fun stop(ctx: Context) = ctx.stopService(Intent(ctx, GatewayService::class.java))
    }

    private var shown: Boolean? = null
    private val net = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) = Session.kick()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        running = true
        Session.onConnectionChange = { if (shown != Session.connected) show() }
        show()
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(net)
        Session.connect()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        show()
        Session.connect()
        return START_STICKY
    }

    private fun show() {
        val up = Session.connected
        shown = up
        val settings = PendingIntent.getActivity(this, 21, Intent(this, MainActivity::class.java).putExtra(MainActivity.EXTRA_SETTINGS, true), PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(this, Notifications.CH_CONNECTION)
            .setSmallIcon(R.drawable.ic_stat_cillcord)
            .setContentTitle(getString(if (up) R.string.bg_connected else R.string.bg_connecting))
            .setContentText(getString(R.string.bg_hint))
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setShowWhen(false)
            .setContentIntent(settings)
            .build()
        try {
            ServiceCompat.startForeground(this, Notifications.ID_CONNECTION, n, if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING else 0)
        } catch (e: Exception) {
            Log.w(TAG, "startForeground failed: ${e.message}")
            try { NotificationManagerCompat.from(this).notify(Notifications.ID_CONNECTION, n) } catch (s: SecurityException) { }
        }
    }

    override fun onDestroy() {
        running = false
        Session.onConnectionChange = null
        try { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(net) } catch (e: Exception) { }
        Session.release()
        super.onDestroy()
    }
}
