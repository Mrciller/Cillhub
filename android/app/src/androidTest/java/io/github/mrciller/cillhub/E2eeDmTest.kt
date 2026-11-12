package io.github.mrciller.cillhub

import android.Manifest
import android.app.Notification
import android.app.NotificationManager
import android.app.RemoteInput
import android.content.Intent
import android.os.Bundle
import androidx.compose.ui.test.ComposeTimeoutException
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.hasClickAction
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasSetTextAction
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createAndroidComposeRule
import androidx.compose.ui.test.onLast
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.core.app.NotificationCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.UiDevice
import io.github.mrciller.cillhub.data.E2eeCrypto
import io.github.mrciller.cillhub.data.Envelope
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.json
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
 * Encrypted DMs end to end against a throwaway instance: Alex is the app (turns encryption on in Settings, the DM gets its
 * first key), Sam is driven over REST with the same Kotlin crypto. Messages go both ways through the composer, a
 * notification and its quick reply; the server only ever stores the placeholder next to the envelope.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class E2eeDmTest {
    @get:Rule val ui = createAndroidComposeRule<MainActivity>()
    private val instr = InstrumentationRegistry.getInstrumentation()
    private val device = UiDevice.getInstance(instr)
    private val nm = instr.targetContext.getSystemService(NotificationManager::class.java)

    companion object {
        const val PLACEHOLDER = "Encrypted message. Update the app to read it."
        val run = (System.currentTimeMillis() % 1_000_000).toString()
        lateinit var alex: Pair<String, String>
        lateinit var sam: Pair<String, String>
        lateinit var samKey: E2eeCrypto.AccountKey
        lateinit var dm: String
        lateinit var hello: String

        fun rest(method: String, path: String, token: String?, body: JSONObject? = null): String {
            val b = Request.Builder().url(Config.API + path)
            token?.let { b.header("Authorization", it) }
            b.method(method, body?.toString()?.toRequestBody("application/json".toMediaType()) ?: if (method == "PUT" || method == "POST") ByteArray(0).toRequestBody(null) else null)
            Api.http.newCall(b.build()).execute().use { res ->
                val text = res.body.string()
                assertTrue("$method $path -> ${res.code} $text", res.isSuccessful)
                return text
            }
        }
        private fun register(name: String): Pair<String, String> {
            val token = JSONObject(rest("POST", "/auth/register", null, JSONObject().put("email", "$name@example.com").put("username", name).put("password", "hunter2hunter2").put("age_confirmed", true))).getString("token")
            return token to JSONObject(rest("GET", "/users/@me", token)).getString("id")
        }

        /** Sam with an account key (no app: REST and E2eeCrypto), a DM with Alex; the app signed in as Alex. */
        @BeforeClass @JvmStatic fun setUp() {
            val i = InstrumentationRegistry.getInstrumentation()
            i.uiAutomation.grantRuntimePermission(i.targetContext.packageName, Manifest.permission.POST_NOTIFICATIONS)
            alex = register("alex$run")
            sam = register("sam$run")
            samKey = E2eeCrypto.newAccountKey()
            rest("PUT", "/users/@me/e2ee/keys", sam.first, JSONObject().put("public_key", samKey.pub)
                .put("backup", E2eeCrypto.sealBackup(E2eeCrypto.random(20), sam.second, samKey.pkcs8)))
            // DMs need a friendship (or a shared server)
            rest("POST", "/users/@me/relationships", sam.first, JSONObject().put("username", "alex$run"))
            rest("PUT", "/users/@me/relationships/${sam.second}", alex.first, JSONObject())
            dm = JSONObject(rest("POST", "/users/@me/channels", sam.first, JSONObject().put("recipient_id", alex.second))).getString("id")
            // a plain first message (before either side had encryption on) so the DM is listed; it stays readable to the server
            hello = JSONObject(rest("POST", "/channels/$dm/messages", sam.first, JSONObject().put("content", "Hi Alex"))).getString("id")
            Session.signedIn(alex.first)
        }
    }

    private fun <T> waitFor(what: String, timeoutMs: Long = 30_000, f: () -> T?): T {
        val end = System.currentTimeMillis() + timeoutMs
        var last: Throwable? = null
        while (System.currentTimeMillis() < end) {
            try { f()?.let { return it } } catch (e: Throwable) { last = e }
            Thread.sleep(300)
        }
        throw AssertionError("timed out: $what" + (last?.let { " ($it)" } ?: ""))
    }
    private fun node(m: SemanticsMatcher, timeoutMs: Long = 30_000) = try {
        ui.waitUntil(timeoutMs) { ui.onAllNodes(m).fetchSemanticsNodes().isNotEmpty() }
        ui.onAllNodes(m).onLast()
    } catch (e: ComposeTimeoutException) {
        shot("e2ee-fail-${System.currentTimeMillis() % 100000}")
        throw AssertionError("not shown: ${m.description}")
    }
    private fun text(t: String) = node(hasText(t, substring = true))
    private fun button(t: String) = node(hasText(t, ignoreCase = true) and hasClickAction())
    private fun shot(name: String) {
        device.waitForIdle()
        device.executeShellCommand("mkdir -p /data/local/tmp/cillcord-shots")
        device.executeShellCommand("screencap -p /data/local/tmp/cillcord-shots/$name.png")
    }
    private fun notification(): Notification? = nm.activeNotifications.firstOrNull { it.tag == "ch:$dm" && it.id == Notifications.ID_MESSAGE }?.notification

    private fun messages() = JSONArray(rest("GET", "/channels/$dm/messages?limit=20", sam.first)).let { a -> (0 until a.length()).map { a.getJSONObject(it) } }
    /** Sam's side: the current channel key, unwrapped with the key of whoever made the wrap (Alex). */
    private fun samChannelKey(): Pair<Int, ByteArray> {
        val r = JSONObject(rest("GET", "/channels/$dm/e2ee/keys", sam.first))
        val epoch = r.getInt("epoch")
        val keys = r.getJSONArray("keys")
        val w = (0 until keys.length()).map { keys.getJSONObject(it) }.first { it.getInt("epoch") == epoch }.getString("wrapped")
        val by = E2eeCrypto.wrapper(w)!!
        val byPub = JSONObject(rest("GET", "/users/$by/e2ee/keys", sam.first)).getString("public_key")
        return epoch to E2eeCrypto.unwrap(E2eeCrypto.importPrivate(samKey.pkcs8), w, dm, epoch, sam.second, listOf(byPub))
    }
    /** What Sam reads: the server's stored text must be the placeholder, the envelope opens to [text]. */
    private fun samReads(text: String): JSONObject = waitFor("Sam reads \"$text\"") {
        val (_, key) = samChannelKey()
        messages().firstOrNull { m ->
            val env = m.optJSONObject("e2ee_envelope") ?: return@firstOrNull false
            val e = json.decodeFromString(Envelope.serializer(), env.toString())
            val plain = runCatching { JSONObject(E2eeCrypto.open(key, dm, m.getJSONObject("author").getString("id"), e).first).getString("content") }.getOrNull()
            plain == text
        }
    }.also { m ->
        assertEquals(PLACEHOLDER, m.getString("content"))
        assertEquals(alex.second, m.getJSONObject("author").getString("id"))
    }
    private fun samSends(text: String): JSONObject {
        val (epoch, key) = samChannelKey()
        val env = E2eeCrypto.seal(key, dm, sam.second, epoch, JSONObject().put("content", text).put("files", JSONArray()).toString()).envelope
        val sent = JSONObject(rest("POST", "/channels/$dm/messages", sam.first, JSONObject().put("nonce", System.nanoTime().toString())
            .put("e2ee_envelope", JSONObject(json.encodeToString(Envelope.serializer(), env)))))
        assertEquals(PLACEHOLDER, sent.getString("content"))
        return sent
    }

    @Test fun a_turnOnInSettingsAndSeeTheRecoveryKeyOnce() {
        node(hasText("You") and hasClickAction()).performClick()
        node(hasText("Encrypted messages") and hasClickAction()).performClick()
        button("Turn on encrypted messages").performClick()
        text("Your recovery key".uppercase())
        // 32 base32 characters in groups of 4, shown once
        node(SemanticsMatcher("a recovery key") { n -> (if (n.config.contains(androidx.compose.ui.semantics.SemanticsProperties.Text)) n.config[androidx.compose.ui.semantics.SemanticsProperties.Text] else emptyList()).any { Regex("^[A-Z2-7]{4}(-[A-Z2-7]{4}){7}$").matches(it.text.replace("\n", "-")) } })
        shot("e2ee-01-recovery-key")
        node(hasText("I saved my recovery key") and hasClickAction()).performClick()
        button("Done").performClick()
        text("Encrypted messages are on for this device.")
        val pub = JSONObject(rest("GET", "/users/${alex.second}/e2ee/keys", sam.first)).getString("public_key")
        assertEquals(65, E2eeCrypto.unb64(pub).size)
    }

    @Test fun b_dmBecomesEncryptedAndAlexSends() {
        node(hasText("Messages") and hasClickAction()).performClick()
        node(hasText("sam$run") and hasClickAction()).performClick()
        text("Hi Alex")
        // opening the DM with both keys set up creates the first key epoch, wrapped by Alex for both
        waitFor("epoch 1") { JSONObject(rest("GET", "/channels/$dm", sam.first)).optInt("e2ee_epoch").takeIf { it >= 1 } }
        node(hasContentDescription("End-to-end encrypted") and hasClickAction())
        node(hasSetTextAction()).performTextInput("Meet at the arena at eight")
        node(hasContentDescription("Send") and hasClickAction()).performClick()
        samReads("Meet at the arena at eight")
        text("Meet at the arena at eight")
        shot("e2ee-02-sent")
    }

    @Test fun c_samSendsAndTheAppDecrypts() {
        node(hasText("Messages") and hasClickAction()).performClick()
        node(hasText("sam$run") and hasClickAction()).performClick()
        samSends("Bring the spare keyboard")
        text("Bring the spare keyboard")
        assertTrue("placeholder never shown", ui.onAllNodes(hasText(PLACEHOLDER, substring = true)).fetchSemanticsNodes().isEmpty())
        shot("e2ee-03-received")
    }

    @Test fun d_notificationDecryptsAndQuickReplyEncrypts() {
        device.pressHome()
        Thread.sleep(1500)
        samSends("Running ten minutes late")
        val n = waitFor("DM notification") { notification()?.takeIf { NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(it)?.messages?.lastOrNull()?.text?.toString() == "Running ten minutes late" } }
        val action = n.actions.single { it.semanticAction == Notification.Action.SEMANTIC_ACTION_REPLY }
        val fill = Intent()
        RemoteInput.addResultsToIntent(action.remoteInputs, fill, Bundle().apply { putCharSequence(Notifications.REPLY_KEY, "No problem, see you there") })
        action.actionIntent.send(instr.targetContext, 0, fill)
        samReads("No problem, see you there")
        // nothing in the conversation is stored as plain text
        assertTrue(messages().filter { it.getString("id") != hello }.all { it.optJSONObject("e2ee_envelope") != null && it.getString("content") == PLACEHOLDER })
    }
}
