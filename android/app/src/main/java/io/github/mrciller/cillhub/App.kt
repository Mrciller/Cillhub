package io.github.mrciller.cillhub

import android.app.Application
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import coil3.ImageLoader
import coil3.PlatformContext
import coil3.SingletonImageLoader
import coil3.network.okhttp.OkHttpNetworkFetcherFactory
import io.github.mrciller.cillhub.data.Session

class App : Application(), SingletonImageLoader.Factory {
    // images (avatars, attachments, embeds) share the app's OkHttp client
    override fun newImageLoader(context: PlatformContext): ImageLoader =
        ImageLoader.Builder(context).components { add(OkHttpNetworkFetcherFactory(callFactory = { Api.http })) }.build()

    override fun onCreate() {
        super.onCreate()
        Session.init(this)
        Hub.init(this)
        io.github.mrciller.cillhub.voice.Voice.init(this)
        Notifications.createChannels(this)
        Updater.scheduleDaily(this)
        // long-press the launcher icon -> Settings (also under App info -> app settings)
        val settings = ShortcutInfoCompat.Builder(this, "settings").setShortLabel(getString(R.string.settings))
            .setIcon(IconCompat.createWithResource(this, R.mipmap.ic_launcher))
            .setIntent(Intent(this, MainActivity::class.java).setAction(Intent.ACTION_VIEW).putExtra(MainActivity.EXTRA_SETTINGS, true)).build()
        try { ShortcutManagerCompat.pushDynamicShortcut(this, settings) } catch (e: Exception) { }
    }
}
