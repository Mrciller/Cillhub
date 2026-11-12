package io.github.mrciller.cillhub

import android.Manifest
import android.content.Context
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.voice.CallAudio
import io.github.mrciller.cillhub.voice.VStatus
import io.github.mrciller.cillhub.voice.Voice
import io.github.mrciller.cillhub.voice.VoiceStats
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.FixMethodOrder
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters

/**
 * Native voice against a real media server, with a headless Chromium running the web client as the other person
 * (scripts/web-peer.cjs, driven over HTTP). Instrumentation arguments: `voiceServer` (the throwaway server as the
 * emulator reaches it), `voiceWebBase` (the same server as the host's browser reaches it), `webPeer` (the peer's
 * control URL), `backend` ("cillvoice" or "LiveKit"). scripts/emulator-test.sh runs this once per backend.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class VoiceFlowTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()
    private val instr = InstrumentationRegistry.getInstrumentation()
    private val ctx: Context = instr.targetContext
    private val device = UiDevice.getInstance(instr)

    companion object {
        private val args = InstrumentationRegistry.getArguments()
        val server: String = args.getString("voiceServer") ?: "http://10.0.2.2:3361"
        val webBase: String = args.getString("voiceWebBase") ?: "http://127.0.0.1:3361"
        val peer: String = args.getString("webPeer") ?: "http://10.0.2.2:3370"
        val backend: String = args.getString("backend") ?: "cillvoice"
        val tag = backend.lowercase()
        val run = (System.currentTimeMillis() % 1_000_000).toString()
        lateinit var me: Pair<String, String>
        lateinit var web: Pair<String, String>
        lateinit var guild: String
        lateinit var lounge: String
        const val GUILD = "Voice Lab"

        private fun http(method: String, url: String, token: String? = null, body: JSONObject? = null): String {
            val b = Request.Builder().url(url)
            token?.let { b.header("Authorization", it) }
            b.method(method, body?.toString()?.toRequestBody("application/json".toMediaType()) ?: if (method == "POST" || method == "PUT") ByteArray(0).toRequestBody(null) else null)
            Api.http.newBuilder().readTimeout(90, java.util.concurrent.TimeUnit.SECONDS).build().newCall(b.build()).execute().use { res ->
                val text = res.body.string()
                assertTrue("$method $url -> ${res.code} $text", res.isSuccessful)
                return text
            }
        }
        fun rest(method: String, path: String, token: String?, body: JSONObject? = null) = http(method, "$server/api/v9$path", token, body)
        fun peer(path: String, body: JSONObject? = null) = JSONObject(http(if (body == null) "GET" else "POST", "$peer$path", body = body))
        private fun register(name: String): Pair<String, String> {
            val token = JSONObject(rest("POST", "/auth/register", null, JSONObject().put("email", "$name@example.com").put("username", name).put("password", "hunter2hunter2").put("age_confirmed", true))).getString("token")
            return token to JSONObject(rest("GET", "/users/@me", token)).getString("id")
        }

        /** Two accounts, a server with a voice channel, both in it; the app signed in as the first (no UI: AppFlowTest covers sign-in). */
        @BeforeClass @JvmStatic fun setUp() {
            val i = InstrumentationRegistry.getInstrumentation()
            for (p in listOf(Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA))
                i.uiAutomation.grantRuntimePermission(i.targetContext.packageName, p)
            me = register("droid$tag$run")
            web = register("webby$tag$run")
            val g = JSONObject(rest("POST", "/guilds", web.first, JSONObject().put("name", GUILD)))
            guild = g.getString("id")
            val general = (0 until g.getJSONArray("channels").length()).map { g.getJSONArray("channels").getJSONObject(it) }.first { it.optString("name") == "general" }.getString("id")
            lounge = JSONObject(rest("POST", "/guilds/$guild/channels", web.first, JSONObject().put("name", "Lounge").put("type", 2))).getString("id")
            val invite = JSONObject(rest("POST", "/channels/$general/invites", web.first, JSONObject().put("max_age", 0))).getString("code")
            rest("POST", "/invites/$invite", me.first, JSONObject())
            Session.useServer(server, null)
            Session.signedIn(me.first)
        }
    }

    private fun <T> waitFor(what: String, timeoutMs: Long = 30_000, f: () -> T?): T {
        val end = System.currentTimeMillis() + timeoutMs
        var last: Throwable? = null
        while (System.currentTimeMillis() < end) {
            ui.waitForIdle() // Compose only draws frames while the test syncs with it
            try { f()?.let { return it } } catch (e: Throwable) { last = e }
            Thread.sleep(300)
        }
        throw AssertionError("timed out: $what" + (last?.let { " ($it)" } ?: "") + " voice=${Voice.state.value.copy(tiles = emptyList())}")
    }

    private fun node(m: SemanticsMatcher, timeoutMs: Long = 30_000) = try {
        ui.waitUntil(timeoutMs) { ui.onAllNodes(m).fetchSemanticsNodes().isNotEmpty() }
        ui.onAllNodes(m).onLast()
    } catch (e: ComposeTimeoutException) {
        shot("fail-$tag-${System.currentTimeMillis() % 100000}")
        throw AssertionError("not shown: ${m.description}")
    }
    private fun button(t: String) = node(hasText(t) and hasClickAction())
    private fun desc(d: String) = node(hasContentDescription(d) and hasClickAction())

    private fun shot(name: String) {
        ui.waitForIdle()
        device.waitForIdle()
        device.executeShellCommand("mkdir -p /data/local/tmp/cillcord-shots")
        device.executeShellCommand("screencap -p /data/local/tmp/cillcord-shots/$name.png")
    }

    /** Each test starts a fresh activity on the server list: go back to the voice screen of the channel we are in. */
    private fun openLounge() {
        node(hasContentDescription(GUILD, substring = true) and hasClickAction()).performClick()
        button("Lounge").performClick()
        desc("Leave")
    }

    private fun stats(): VoiceStats = runBlocking { Voice.stats() } ?: VoiceStats()
    private fun webStats() = peer("/stats")
    private fun voiceState(userId: String) = Session.store.value.voiceStates[guild]?.get(userId)

    /** A counter keeps rising over a few seconds (media flows). */
    private fun rising(what: String, timeoutMs: Long = 30_000, read: () -> Long) {
        val start = read()
        waitFor(what, timeoutMs) { if (read() > start + 20) true else null }
    }

    /** A counter stays (almost) still for a few seconds (media stopped). */
    private fun still(what: String, read: () -> Long) {
        Thread.sleep(2500) // what was in flight arrives
        val a = read()
        Thread.sleep(3000)
        val b = read()
        assertTrue("$what: $a -> $b", b - a <= 10)
    }

    private fun webAudioIn() = webStats().optLong("audioIn")
    private fun webVideo(min: Int = 1): JSONArray? = webStats().getJSONArray("videoIn").takeIf { a -> (0 until a.length()).count { a.getJSONObject(it).optLong("frames") > 0 } >= min }

    @Test fun a_joinAndHearTheWebParticipant() {
        peer("/join", JSONObject().put("base", webBase).put("token", web.first).put("guild", guild).put("guildName", GUILD).put("channel", "Lounge"))
        waitFor("the web participant in the voice channel") { voiceState(web.second) }
        node(hasContentDescription(GUILD, substring = true) and hasClickAction()).performClick()
        button("Lounge").performClick()
        button("Join voice").performClick()
        waitFor("connected through $backend", 45_000) { Voice.state.value.takeIf { it.status == VStatus.CONNECTED && it.backend == backend } }
        waitFor("our voice state on the server") { voiceState(me.second) }
        assertEquals("a Telecom call (or the audio fallback) runs the channel", lounge, Calls.current?.channelId)
        // the browser plays a speech file as its microphone: its packets reach us and carry sound
        rising("audio from the web participant") { stats().audioInPackets }
        waitFor("the web participant's voice has a level") { stats().audioInLevel.takeIf { it > 0.01 } }
        // and ours reach the browser
        rising("our audio at the web participant") { webAudioIn() }
        waitFor("the speaking indicator for the web participant", 20_000) { Voice.state.value.speaking.takeIf { web.second in it } }
        assertTrue("audio routes reported", CallAudio.state.value.devices.isNotEmpty())
        shot("voice-$tag-grid")
    }

    @Test fun b_muteAndDeafen() {
        openLounge()
        desc("Mute").performClick()
        waitFor("self_mute on the server") { voiceState(me.second)?.takeIf { it.selfMute } }
        still("no audio from us while muted") { webAudioIn() }
        desc("Unmute").performClick()
        waitFor("unmuted on the server") { voiceState(me.second)?.takeIf { !it.selfMute } }
        rising("our audio flows again") { webAudioIn() }

        desc("Deafen").performClick()
        waitFor("self_deaf on the server") { voiceState(me.second)?.takeIf { it.selfDeaf && it.selfMute } }
        assertTrue("deafened locally", Voice.deafened())
        shot("voice-$tag-controls")
        desc("Undeafen").performClick()
        waitFor("undeafened, mute restored") { voiceState(me.second)?.takeIf { !it.selfDeaf && !it.selfMute } }
    }

    @Test fun c_cameraBothWays() {
        openLounge()
        desc("Turn on camera").performClick()
        waitFor("self_video on the server") { voiceState(me.second)?.takeIf { it.selfVideo } }
        waitFor("the web participant decodes our camera", 45_000) { webVideo() }
        desc("Switch camera").performClick()
        peer("/camera", JSONObject().put("on", true))
        waitFor("we decode the web participant's camera", 45_000) { stats().videoIn.firstOrNull { it.frames > 0 } }
        waitFor("a camera tile from the web participant") { Voice.state.value.tiles.firstOrNull { it.userId == web.second && !it.screen } }
        Thread.sleep(1500)
        shot("voice-$tag-camera")
        desc("Turn off camera").performClick()
        waitFor("camera off on the server") { voiceState(me.second)?.takeIf { !it.selfVideo } }
        peer("/camera", JSONObject().put("on", false))
    }

    @Test fun d_viewTheWebScreenShare() {
        openLounge()
        peer("/screen", JSONObject().put("on", true))
        waitFor("a screen share tile", 45_000) { Voice.state.value.tiles.firstOrNull { it.userId == web.second && it.screen } }
        waitFor("screen share frames decoded", 45_000) { stats().videoIn.firstOrNull { it.frames > 0 && it.width >= 640 } }
        node(hasText("webby$tag$run’s screen", substring = true)).performClick()
        desc("Exit full screen")
        Thread.sleep(1500)
        shot("voice-$tag-screen-viewer")
        desc("Exit full screen").performClick()
        peer("/screen", JSONObject().put("on", false))
        waitFor("the screen share tile goes", 20_000) { if (Voice.state.value.tiles.none { it.screen }) true else null }
    }

    @Test fun e_shareThePhoneScreen() {
        openLounge()
        desc("Share your screen").performClick()
        button("Share").performClick()
        // Android's consent: 14+ starts on "one app"; the spinner switches to the entire screen
        device.wait(Until.hasObject(By.res("android:id/button1")), 15_000)
        device.findObject(By.res("com.android.systemui:id/screen_share_mode_options"))?.let { spinner ->
            spinner.click()
            device.wait(Until.hasObject(By.textContains("ntire screen")), 5_000)
            device.findObjects(By.textContains("ntire screen")).last().click()
            Thread.sleep(800)
        }
        if (device.findObject(By.res("android:id/button1")) == null) device.executeShellCommand("uiautomator dump /data/local/tmp/cillcord-shots/consent-$tag.xml")
        device.findObject(By.res("android:id/button1")).click()
        waitFor("self_stream on the server", 30_000) { voiceState(me.second)?.takeIf { it.selfStream } }
        waitFor("the web client shows our screen", 45_000) { webStats().getJSONArray("videos").takeIf { it.length() > 0 } }
        waitFor("frames of our screen at the web participant", 45_000) { webVideo() }
        val sent = waitFor("our screen encoder runs") { stats().videoOut.firstOrNull { it.frames > 0 } }
        assertTrue("screen sent in a portrait size: $sent", sent.height >= sent.width)
        peer("/shot?path=/tmp/cillhub-webpeer-$tag-sees-phone.png".let { it }) // pulled by emulator-test.sh from the host side
        shot("voice-$tag-sharing")
        desc("Stop sharing").performClick()
        waitFor("stream off on the server") { voiceState(me.second)?.takeIf { !it.selfStream } }
    }

    @Test fun f_leave() {
        openLounge()
        desc("Leave").performClick()
        waitFor("voice idle") { Voice.state.value.takeIf { it.status == VStatus.IDLE } }
        waitFor("our voice state gone on the server") { if (voiceState(me.second) == null) true else null }
        waitFor("the call ended") { if (Calls.current == null) true else null }
        assertEquals(listOf(web.second), Sel.voiceUsers(Session.store.value, guild, lounge).map { it.userId })
        peer("/reset", JSONObject())
    }

    @Test fun g_answerADmCallFromTheNotificationAndHangUp() {
        val nm = ctx.getSystemService(android.app.NotificationManager::class.java)
        val dm = JSONObject(rest("POST", "/users/@me/channels", web.first, JSONObject().put("recipient_id", me.second))).getString("id")
        waitFor("the DM in our store") { Session.store.value.channels[dm] }
        peer("/call", JSONObject().put("base", webBase).put("token", web.first).put("channel", dm))
        val ring = waitFor("the call rings natively") { nm.activeNotifications.firstOrNull { it.id == Notifications.ID_CALL }?.notification?.takeIf { Calls.current?.state == Calls.State.RINGING } }
        ring.actions[1].actionIntent.send() // CallStyle: decline, answer
        waitFor("connected to the DM call through $backend", 45_000) { Voice.state.value.takeIf { it.channelId == dm && it.guildId == null && it.status == VStatus.CONNECTED } }
        assertEquals(Calls.State.ACTIVE, Calls.current?.state)
        rising("audio from the caller") { stats().audioInPackets }
        rising("our audio at the caller") { webAudioIn() }
        desc("Leave")
        shot("voice-$tag-dm-call")
        val ongoing = waitFor("the ongoing call notification with mute") { nm.activeNotifications.firstOrNull { it.id == Notifications.ID_CALL }?.notification?.takeIf { n -> n.actions?.any { it.title == "Mute" } == true } }
        ongoing.actions.first { it.title == "Mute" }.actionIntent.send()
        waitFor("muted from the notification") { Voice.state.value.takeIf { it.selfMute } }
        Voice.setSelfMute(false)
        ongoing.actions.first().actionIntent.send() // hang up
        waitFor("left the call") { Voice.state.value.takeIf { it.status == VStatus.IDLE } }
        waitFor("our voice state gone") { if (Session.store.value.voiceStates["@me"]?.get(me.second) == null) true else null }
        peer("/reset", JSONObject())
    }
}
