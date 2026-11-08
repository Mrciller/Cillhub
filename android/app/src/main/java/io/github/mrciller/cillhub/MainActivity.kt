package io.github.mrciller.cillhub

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.SystemBarStyle
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.getValue
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.ui.AppearancePrefs
import io.github.mrciller.cillhub.ui.CillhubApp
import io.github.mrciller.cillhub.ui.CillhubTheme
import io.github.mrciller.cillhub.ui.inPip
import io.github.mrciller.cillhub.ui.pendingOpen
import io.github.mrciller.cillhub.ui.voiceScreenShown
import io.github.mrciller.cillhub.voice.Voice
import java.util.Locale
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch

/** The single activity: the native Compose app. Opens channels from notifications and shortcuts. */
class MainActivity : ComponentActivity() {
    companion object {
        const val EXTRA_PATH = "path"
        const val EXTRA_UPDATE = "update"
        const val EXTRA_SETTINGS = "settings"
        const val EXTRA_VOICE = "voice"
        const val EXTRA_RINGING = "ringing"
        const val ACTION_ANSWER = "io.github.mrciller.cillhub.ANSWER"
        private val PATH = Regex("^/channels/(@me|\\d{1,19})/(\\d{1,19})(/\\d{1,19})?$")

        /** Opens the voice screen of a channel or call (notifications, the call service). */
        fun voiceIntent(ctx: Context, channelId: String): Intent = Intent(ctx, MainActivity::class.java).setAction(Intent.ACTION_VIEW)
            .putExtra(EXTRA_VOICE, channelId).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    }

    private val askNotifications = registerForActivityResult(ActivityResultContracts.RequestPermission()) { }
    private var answerAfterMic: String? = null
    // answering without the microphone permission still joins, listen-only
    private val askMic = registerForActivityResult(ActivityResultContracts.RequestPermission()) { answerAfterMic?.let { Calls.answer(this, it, openApp = false) }; answerAfterMic = null }

    /** Picture-in-picture for a call with video (the voice screen's button, or leaving the app from the voice screen). */
    fun enterPip(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O || !packageManager.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE)) return false
        return runCatching { enterPictureInPictureMode(pipParams()) }.getOrDefault(false)
    }

    private fun pipParams(): android.app.PictureInPictureParams = android.app.PictureInPictureParams.Builder().setAspectRatio(android.util.Rational(16, 9)).apply {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) setAutoEnterEnabled(pipWanted())
    }.build()

    /** On the voice screen of a call that shows video. */
    private fun pipWanted() = voiceScreenShown.value && Voice.state.value.let { v -> v.active && v.tiles.any { !it.local } }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT in Build.VERSION_CODES.O until Build.VERSION_CODES.S && pipWanted()) enterPip()
    }

    override fun onPictureInPictureModeChanged(isInPictureInPictureMode: Boolean, newConfig: Configuration) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        inPip.value = isInPictureInPictureMode
    }

    // below Android 13 the app's own language setting (13+ uses the system's per-app language)
    override fun attachBaseContext(base: Context) {
        val lang = if (Build.VERSION.SDK_INT < 33) Prefs(base).language else ""
        if (lang.isEmpty()) return super.attachBaseContext(base)
        val conf = Configuration(base.resources.configuration).apply { setLocale(Locale.forLanguageTag(lang)) }
        super.attachBaseContext(base.createConfigurationContext(conf))
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        enableEdgeToEdge(SystemBarStyle.auto(android.graphics.Color.TRANSPARENT, android.graphics.Color.TRANSPARENT))
        super.onCreate(savedInstanceState)
        AppearancePrefs.load(Prefs(this))
        setContent {
            val theme by AppearancePrefs.theme.collectAsStateWithLifecycle()
            val dynamic by AppearancePrefs.dynamic.collectAsStateWithLifecycle()
            CillhubTheme(theme, dynamic) { CillhubApp() }
        }
        if (savedInstanceState == null) handle(intent)
        Delivery.apply(this)
        val prefs = Prefs(this)
        if (intent.getBooleanExtra(EXTRA_UPDATE, false) || System.currentTimeMillis() - prefs.lastUpdateCheck > 6 * 3600_000L) {
            Updater.checkFromActivity(this, interactive = intent.getBooleanExtra(EXTRA_UPDATE, false))
        }
        // Android 12+: leaving the app from a call with video turns it into picture-in-picture by itself
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) lifecycleScope.launch {
            kotlinx.coroutines.flow.combine(voiceScreenShown, Voice.state) { _, _ -> pipWanted() }.collect { runCatching { setPictureInPictureParams(pipParams()) } }
        }
        // and after the first login
        lifecycleScope.launch {
            Session.loggedIn.first { it }
            if (Build.VERSION.SDK_INT >= 33 && ContextCompat.checkSelfPermission(this@MainActivity, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
                askNotifications.launch(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent) // not setIntent(): the launch intent stays (tests find the activity by it; nothing re-reads it)
        if (intent.getBooleanExtra(EXTRA_UPDATE, false)) Updater.checkFromActivity(this, interactive = true)
    }

    /** Notification taps and conversation shortcuts carry /channels/<guild|@me>/<channel>. */
    private fun handle(i: Intent) {
        if (i.getBooleanExtra(EXTRA_SETTINGS, false) || i.action == Intent.ACTION_APPLICATION_PREFERENCES) { pendingOpen.value = "settings:notifications"; return }
        BridgeMessage.snowflake(i.getStringExtra(EXTRA_VOICE))?.let { id ->
            // a ring shows over the lock screen and turns the screen on, like a phone call
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O_MR1) { val ring = i.getBooleanExtra(EXTRA_RINGING, false) || i.action == ACTION_ANSWER; setShowWhenLocked(ring); setTurnScreenOn(ring) }
            if (i.action == ACTION_ANSWER) {
                if (ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) Calls.answer(this, id, openApp = false)
                else { answerAfterMic = id; askMic.launch(Manifest.permission.RECORD_AUDIO) }
            }
            pendingOpen.value = "voice:$id"
            return
        }
        val m = i.getStringExtra(EXTRA_PATH)?.let { PATH.matchEntire(it) } ?: return
        val channel = m.groupValues[2]
        Notifications.read(this, channel, null) // opened from its notification: that conversation counts as seen
        pendingOpen.value = channel
    }

    override fun onStart() {
        super.onStart()
        Session.setVisible(true)
    }

    override fun onStop() {
        Session.setVisible(false)
        super.onStop()
    }
}
