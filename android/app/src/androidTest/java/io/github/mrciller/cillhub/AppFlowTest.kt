package io.github.mrciller.cillhub

import android.Manifest
import android.app.Activity
import android.app.Instrumentation
import android.app.Notification
import android.app.NotificationManager
import android.app.RemoteInput
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.provider.MediaStore
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.test.performTouchInput
import androidx.core.app.NotificationCompat
import androidx.test.espresso.intent.Intents
import androidx.test.espresso.intent.Intents.intending
import androidx.test.espresso.intent.matcher.IntentMatchers.hasAction
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import io.github.mrciller.cillhub.data.Session
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.BeforeClass
import org.junit.FixMethodOrder
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters
import org.xmlpull.v1.XmlPullParser

/**
 * End to end against a throwaway Cillhub instance (debug build pointed at it with -Pcillhub.url, see
 * scripts/emulator-test.sh), through the native UI: register, log out and in, a server and channel, send and receive,
 * reply, reaction, image upload and viewer, a DM, then the background parts: a DM as a MessagingStyle notification,
 * inline reply, mark as read, a ringing DM call, tapping a notification. "bob" is driven over REST and a test gateway.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class AppFlowTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()
    private val instr = InstrumentationRegistry.getInstrumentation()
    private val ctx: Context = instr.targetContext
    private val device = UiDevice.getInstance(instr)
    private val nm = ctx.getSystemService(NotificationManager::class.java)

    companion object {
        const val PASSWORD = "hunter2hunter2"
        val run = (System.currentTimeMillis() % 1_000_000).toString()
        lateinit var alice: Pair<String, String>
        lateinit var bob: Pair<String, String>
        lateinit var guild: String
        lateinit var general: String
        lateinit var dm: String

        @BeforeClass @JvmStatic fun permissions() {
            val i = InstrumentationRegistry.getInstrumentation()
            i.uiAutomation.grantRuntimePermission(i.targetContext.packageName, Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    private fun rest(method: String, path: String, token: String?, body: JSONObject? = null): String {
        val b = Request.Builder().url(Config.API + path)
        token?.let { b.header("Authorization", it) }
        b.method(method, body?.toString()?.toRequestBody("application/json".toMediaType()) ?: if (method == "PUT") ByteArray(0).toRequestBody(null) else null)
        Api.http.newCall(b.build()).execute().use { res ->
            val text = res.body.string()
            assertTrue("$method $path -> ${res.code} $text", res.isSuccessful)
            return text
        }
    }

    private fun register(name: String): Pair<String, String> {
        val token = JSONObject(rest("POST", "/auth/register", null, JSONObject().put("email", "$name@example.com").put("username", name).put("password", PASSWORD))).getString("token")
        return token to JSONObject(rest("GET", "/users/@me", token)).getString("id")
    }

    private fun <T> waitFor(what: String, timeoutMs: Long = 20_000, f: () -> T?): T {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            f()?.let { return it }
            Thread.sleep(250)
        }
        throw AssertionError("timed out: $what")
    }

    /** Waits until a node matches (in any window, e.g. dialogs and sheets), then returns the last match. */
    private fun node(m: SemanticsMatcher, timeoutMs: Long = 20_000) = try {
        ui.waitUntil(timeoutMs) { ui.onAllNodes(m, useUnmergedTree = false).fetchSemanticsNodes().isNotEmpty() }
        ui.onAllNodes(m).onLast()
    } catch (e: ComposeTimeoutException) {
        throw AssertionError("not shown: ${m.description}")
    }

    private fun text(t: String) = node(hasText(t, substring = true))
    private fun button(t: String) = node(hasText(t) and hasClickAction())
    private fun desc(d: String) = node(hasContentDescription(d, substring = true))
    private fun field(label: String) = node(hasText(label) and hasSetTextAction())

    // the shell user writes them (the app's own files go when the test uninstalls it); scripts/emulator-test.sh pulls them
    private fun shot(name: String) {
        device.waitForIdle()
        device.executeShellCommand("mkdir -p /data/local/tmp/cillcord-shots")
        device.executeShellCommand("screencap -p /data/local/tmp/cillcord-shots/$name.png")
    }

    private fun notification(tag: String?, id: Int): Notification? = nm.activeNotifications.firstOrNull { it.tag == tag && it.id == id }?.notification
    private fun messages(channel: String, token: String) = JSONArray(rest("GET", "/channels/$channel/messages?limit=10", token)).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }

    @Test fun a_androidAutoDeclarations() {
        val pm = ctx.packageManager
        val meta = pm.getApplicationInfo(ctx.packageName, PackageManager.GET_META_DATA).metaData
        val desc = meta.getInt("com.google.android.gms.car.application")
        assertTrue("automotive_app_desc declared", desc != 0)
        val uses = ArrayList<String>()
        ctx.resources.getXml(desc).use { x ->
            while (x.next() != XmlPullParser.END_DOCUMENT) if (x.eventType == XmlPullParser.START_TAG && x.name == "uses") uses.add(x.getAttributeValue(null, "name"))
        }
        assertTrue("messaging via notifications", "notification" in uses)
        assertTrue("car app service (calling)", "template" in uses)
        val car = pm.queryIntentServices(Intent("androidx.car.app.CarAppService").setPackage(ctx.packageName).addCategory("androidx.car.app.category.CALLING"), 0)
        assertEquals(1, car.size)
        val messaging = pm.queryIntentServices(Intent("androidx.car.app.CarAppService").setPackage(ctx.packageName).addCategory("androidx.car.app.category.MESSAGING"), 0)
        assertEquals("the templated messaging app", 1, messaging.size)
        assertEquals("ConversationItem needs Car API 7", 7, meta.getInt("androidx.car.app.minCarApiLevel"))
        val perms = pm.getPackageInfo(ctx.packageName, PackageManager.GET_PERMISSIONS).requestedPermissions!!.toSet()
        assertTrue(Manifest.permission.MANAGE_OWN_CALLS in perms)
        assertTrue(Manifest.permission.REQUEST_INSTALL_PACKAGES in perms)
    }

    @Test fun b_registerLogOutAndLogIn() {
        text("Ready up")
        shot("01-login")
        button("Create an account").performClick()
        field("Email").performTextInput("alice$run@example.com")
        field("Username").performTextInput("alice$run")
        field("New password (at least 8 characters)").performTextInput(PASSWORD)
        button("Create account").performClick()
        val token = waitFor("token after registering", 30_000) { TokenStore.get(ctx) }
        val id = JSONObject(rest("GET", "/users/@me", token)).getString("id")
        alice = token to id
        waitFor("background gateway connected", 30_000) { GatewayService.connected.takeIf { it } }

        node(hasText("You") and hasClickAction()).performClick()
        text("alice$run")
        button("Log out").performClick()
        node(hasText("Log out") and hasClickAction()).performClick() // the dialog's confirm
        text("Ready up")
        assertEquals(null, TokenStore.get(ctx))
        field("Email or username").performTextInput("alice$run")
        field("Password").performTextInput(PASSWORD)
        button("Log in").performClick()
        val again = waitFor("token after logging in", 30_000) { TokenStore.get(ctx) }
        alice = again to id
        waitFor("background gateway connected", 30_000) { GatewayService.connected.takeIf { it } }
    }

    @Test fun c_seeServerAndChannel() {
        bob = register("bob$run")
        val g = JSONObject(rest("POST", "/guilds", bob.first, JSONObject().put("name", "Android Test")))
        guild = g.getString("id")
        general = (0 until g.getJSONArray("channels").length()).map { g.getJSONArray("channels").getJSONObject(it) }.first { it.optString("name") == "general" }.getString("id")
        rest("POST", "/channels/$general/messages", bob.first, JSONObject().put("content", "Welcome to **Android Test**"))
        val invite = JSONObject(rest("POST", "/channels/$general/invites", bob.first, JSONObject().put("max_age", 0))).getString("code")
        rest("POST", "/invites/$invite", alice.first, JSONObject())

        desc("Android Test").performClick()
        node(hasText("general") and hasClickAction()).performClick()
        text("Welcome to")
        shot("02-channel")
    }

    @Test fun d_sendAndReceive() {
        node(hasText("general") and hasClickAction()).performClick()
        node(hasSetTextAction()).performTextInput("Hello from the native app")
        desc("Send").performClick()
        waitFor("bob sees alice's message") { messages(general, bob.first).firstOrNull { it.optString("content") == "Hello from the native app" } }
        rest("POST", "/channels/$general/messages", bob.first, JSONObject().put("content", "Got it, see you at the scrim"))
        text("Got it, see you at the scrim")
    }

    @Test fun e_replyAndReaction() {
        node(hasText("general") and hasClickAction()).performClick()
        text("see you at the scrim").performTouchInput { longClick() }
        button("Reply").performClick()
        text("Replying to bob$run")
        node(hasSetTextAction()).performTextInput("On my way")
        desc("Send").performClick()
        val reply = waitFor("the reply arrives") { messages(general, bob.first).firstOrNull { it.optString("content") == "On my way" } }
        assertEquals(19, reply.getInt("type"))
        val original = messages(general, bob.first).first { it.optString("content") == "Got it, see you at the scrim" }
        assertEquals(original.getString("id"), reply.getJSONObject("message_reference").getString("message_id"))

        text("see you at the scrim").performTouchInput { longClick() }
        desc("🔥").performClick()
        waitFor("alice's reaction on the server") {
            messages(general, bob.first).first { it.getString("id") == original.getString("id") }.optJSONArray("reactions")?.takeIf { it.length() == 1 }
        }
        rest("PUT", "/channels/$general/messages/${original.getString("id")}/reactions/${Uri.encode("👍")}/@me", bob.first)
        desc("👍, 1 reaction")
        desc("🔥, 1 reaction, you reacted")
        shot("03-reply-reaction")
    }

    @Test fun f_imageAttachmentUploadAndView() {
        // a PNG in the app's own media, returned by the (stubbed) system photo picker
        val bmp = Bitmap.createBitmap(320, 200, Bitmap.Config.ARGB_8888).apply { eraseColor(Color.rgb(34, 225, 255)) }
        val uri: Uri = ctx.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, ContentValues().apply {
            put(MediaStore.Images.Media.DISPLAY_NAME, "cyan-$run.png"); put(MediaStore.Images.Media.MIME_TYPE, "image/png")
        })!!
        ctx.contentResolver.openOutputStream(uri)!!.use { bmp.compress(Bitmap.CompressFormat.PNG, 100, it) }
        Intents.init()
        try {
            intending(hasAction(MediaStore.ACTION_PICK_IMAGES)).respondWith(Instrumentation.ActivityResult(Activity.RESULT_OK, Intent().setData(uri)))
            node(hasText("general") and hasClickAction()).performClick()
            desc("Attach").performClick()
            button("Photos and videos").performClick()
            text("cyan-$run.png")
            desc("Send").performClick()
        } finally {
            Intents.release()
        }
        val sent = waitFor("the image arrives", 30_000) { messages(general, bob.first).firstOrNull { (it.optJSONArray("attachments")?.length() ?: 0) == 1 } }
        val a = sent.getJSONArray("attachments").getJSONObject(0)
        assertEquals("cyan-$run.png", a.getString("filename"))
        assertEquals(320, a.getInt("width"))
        desc("cyan-$run.png").performClick() // opens the viewer
        node(hasContentDescription("Download"))
        shot("04-image-viewer")
        desc("Close").performClick()
        ctx.contentResolver.delete(uri, null, null)
    }

    @Test fun g_directMessage() {
        dm = JSONObject(rest("POST", "/users/@me/channels", bob.first, JSONObject().put("recipient_id", alice.second))).getString("id")
        rest("POST", "/channels/$dm/messages", bob.first, JSONObject().put("content", "Private plan for tonight"))
        node(hasText("Messages") and hasClickAction()).performClick()
        node(hasText("bob$run") and hasClickAction()).performClick()
        text("Private plan for tonight")
        node(hasSetTextAction()).performTextInput("Sounds good")
        desc("Send").performClick()
        waitFor("bob gets the DM reply") { messages(dm, bob.first).firstOrNull { it.optString("content") == "Sounds good" } }
        shot("05-dm")
    }

    @Test fun h_dmWhileBackgroundedBecomesMessagingStyleNotification() {
        device.pressHome()
        Thread.sleep(1500)
        rest("POST", "/channels/$dm/messages", bob.first, JSONObject().put("content", "Are you on your way to the scrim?"))
        val n = waitFor("DM notification") { notification("ch:$dm", Notifications.ID_MESSAGE) }

        val style = NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(n)
        assertNotNull("MessagingStyle", style)
        val msg = style!!.messages.last()
        assertEquals("Are you on your way to the scrim?", msg.text.toString())
        assertEquals("bob$run", msg.person!!.name.toString())
        assertEquals(bob.second, msg.person!!.key)
        assertFalse("a 1:1 DM is not a group conversation", style.isGroupConversation)
        assertEquals(alice.second, style.user.key)
        assertEquals(Notification.CATEGORY_MESSAGE, n.category)
        assertEquals("ch-$dm", n.shortcutId)
        assertNotNull(n.contentIntent)
        // Android Auto's messaging requirements: reply with RemoteInput and mark-as-read, both without UI
        val actions = (0 until NotificationCompat.getActionCount(n)).map { NotificationCompat.getAction(n, it)!! }
        val reply = actions.single { it.semanticAction == NotificationCompat.Action.SEMANTIC_ACTION_REPLY }
        assertFalse(reply.showsUserInterface)
        assertTrue(reply.remoteInputs!!.isNotEmpty())
        val read = actions.single { it.semanticAction == NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ }
        assertFalse(read.showsUserInterface)
        device.openNotification()
        device.wait(Until.hasObject(By.textContains("scrim")), 5_000)
        shot("06-dm-notification")
        device.pressBack()
    }

    @Test fun i_inlineReplyAndMarkAsRead() {
        device.pressHome()
        val n = waitFor("DM notification") { notification("ch:$dm", Notifications.ID_MESSAGE) }
        val action = n.actions.single { it.semanticAction == Notification.Action.SEMANTIC_ACTION_REPLY }
        // what Android Auto does with a voice reply: fire the action with the RemoteInput result
        val fill = Intent()
        RemoteInput.addResultsToIntent(action.remoteInputs, fill, Bundle().apply { putCharSequence(Notifications.REPLY_KEY, "Five minutes away") })
        action.actionIntent.send(ctx, 0, fill)
        val got = waitFor("bob receives the reply") { messages(dm, bob.first).firstOrNull { it.optString("content") == "Five minutes away" } }
        assertEquals(alice.second, got.getJSONObject("author").getString("id"))
        waitFor("notification cleared after the reply") { if (notification("ch:$dm", Notifications.ID_MESSAGE) == null) true else null }

        val sent = JSONObject(rest("POST", "/channels/$dm/messages", bob.first, JSONObject().put("content", "Bring the headset")))
        val n2 = waitFor("second DM notification") { notification("ch:$dm", Notifications.ID_MESSAGE) }
        n2.actions.single { it.semanticAction == Notification.Action.SEMANTIC_ACTION_MARK_AS_READ }.actionIntent.send()
        waitFor("notification removed") { if (notification("ch:$dm", Notifications.ID_MESSAGE) == null) true else null }
        val readState = waitFor("read state on the server") {
            val gw = TestGateway(alice.first)
            val states = gw.ready.getJSONArray("read_state")
            gw.close()
            (0 until states.length()).map { states.getJSONObject(it) }.firstOrNull { it.optString("id") == dm && it.optString("last_message_id") == sent.getString("id") }
        }
        assertEquals(0, readState.optInt("mention_count"))
    }

    @Test fun j_incomingCallRingsAndDeclineStopsRinging() {
        device.pressHome()
        val bobGw = TestGateway(bob.first)
        try {
            bobGw.send(4, JSONObject().put("guild_id", JSONObject.NULL).put("channel_id", dm).put("self_mute", false).put("self_deaf", false))
            bobGw.event("CALL_CREATE") { it.optString("channel_id") == dm }
            rest("POST", "/channels/$dm/call/ring", bob.first, JSONObject().put("recipients", JSONArray().put(alice.second)))
            bobGw.event("CALL_UPDATE") { it.optJSONArray("ringing")?.toString()?.contains(alice.second) == true }

            val n = waitFor("ringing CallStyle notification") { notification(null, Notifications.ID_CALL) }
            assertEquals(Notification.CATEGORY_CALL, n.category)
            assertEquals("android.app.Notification\$CallStyle", n.extras.getString(Notification.EXTRA_TEMPLATE))
            assertEquals(1 /* CALL_TYPE_INCOMING */, n.extras.getInt("android.callType"))
            assertNotNull("full-screen intent for the lock screen", n.fullScreenIntent)
            assertTrue("hosted by the call foreground service (Telecom)", n.flags and Notification.FLAG_FOREGROUND_SERVICE != 0)
            assertEquals(Calls.State.RINGING, Calls.current?.state)
            device.openNotification()
            device.wait(Until.hasObject(By.textContains("bob$run")), 5_000)
            shot("07-incoming-call")
            device.pressBack()

            n.actions.first().actionIntent.send() // decline = the CallStyle's first action
            bobGw.event("CALL_UPDATE") { it.optJSONArray("ringing")?.length() == 0 }
            waitFor("call notification gone") { if (notification(null, Notifications.ID_CALL) == null) true else null }
            assertEquals(null, Calls.current)
            bobGw.send(4, JSONObject().put("guild_id", JSONObject.NULL).put("channel_id", JSONObject.NULL))
        } finally {
            bobGw.close()
        }
    }

    @Test fun k_tapOpensTheConversationAndReadsIt() {
        device.pressHome()
        Thread.sleep(1000)
        rest("POST", "/channels/$dm/messages", bob.first, JSONObject().put("content", "Open me"))
        val n = waitFor("DM notification") { notification("ch:$dm", Notifications.ID_MESSAGE) }
        Thread.sleep(6000) // let the heads-up banner (which also shows the text) go away
        n.contentIntent.send()
        text("Open me")
        // the open conversation acks; the gateway's MESSAGE_ACK clears the notification
        waitFor("notification cleared by reading in the app") { if (notification("ch:$dm", Notifications.ID_MESSAGE) == null) true else null }
        waitFor("read on the server") { Session.store.value.readStates[dm]?.lastMessageId?.takeIf { it == Session.store.value.channels[dm]?.lastMessageId } }
        shot("08-opened-dm")
    }

    @Test fun l_settingsAndStatus() {
        node(hasText("You") and hasClickAction()).performClick()
        button("Online").performClick()
        node(hasText("Do not disturb") and hasClickAction()).performClick()
        waitFor("status saved on the server") { JSONObject(rest("GET", "/users/@me/settings", alice.first)).optString("status").takeIf { it == "dnd" } }
        button("Notifications").performClick()
        text("through the background connection")
        shot("09-settings")
    }
}
