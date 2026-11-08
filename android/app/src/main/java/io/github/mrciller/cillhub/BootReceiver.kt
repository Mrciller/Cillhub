package io.github.mrciller.cillhub

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** After a reboot or an update, reconnect the background service (if it is on and someone is logged in). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        Delivery.apply(context.applicationContext)
        Updater.scheduleDaily(context.applicationContext)
    }
}
