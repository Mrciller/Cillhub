package io.github.mrciller.cillhub

import androidx.car.app.OnDoneCallback
import androidx.car.app.messaging.model.ConversationItem
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.Row
import androidx.car.app.serialization.Bundleable
import androidx.car.app.testing.TestCarContext
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import io.github.mrciller.cillhub.car.ConversationsScreen
import io.github.mrciller.cillhub.car.StatusScreen
import io.github.mrciller.cillhub.car.VoiceScreen
import io.github.mrciller.cillhub.data.Message
import io.github.mrciller.cillhub.data.Reducer
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.json
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/** The Android Auto screens built against a test car host (no head unit needed): what they list and what their callbacks do. */
@RunWith(AndroidJUnit4::class)
class CarScreensTest {
    private val instr = InstrumentationRegistry.getInstrumentation()
    private lateinit var car: TestCarContext
    private fun o(s: String) = json.parseToJsonElement(s).jsonObject
    private val done = object : OnDoneCallback { override fun onSuccess(response: Bundleable?) {}; override fun onFailure(response: Bundleable) {} }

    @Before fun setUp() {
        instr.runOnMainSync { car = TestCarContext.createCarContext(instr.targetContext) }
        Session.store.reset()
        Session.store.dispatch("READY", o("""{"session_id":"s","user":{"id":"1","username":"me","global_name":"Me"},
          "guilds":[{"id":"10","name":"Team","owner_id":"2","roles":[{"id":"10","permissions":"70356545"}],
            "channels":[{"id":"100","type":0,"name":"general","position":0,"last_message_id":"510"},{"id":"103","type":2,"name":"Lounge","position":2}],
            "voice_states":[{"channel_id":"103","user_id":"2","session_id":"x"}],
            "members":[{"user":{"id":"2","username":"bob","global_name":"Bob"},"roles":[],"joined_at":"x"}]}],
          "private_channels":[{"id":"200","type":1,"recipients":[{"id":"2","username":"bob","global_name":"Bob"}],"last_message_id":"600"}],
          "read_state":[{"id":"100","last_message_id":"500","mention_count":1},{"id":"200","last_message_id":"590"}],
          "user_settings":{"status":"online"}}"""))
        val msgs = listOf("595" to "Are you coming to the scrim?", "600" to "We start at 8").map { (id, t) ->
            json.decodeFromJsonElement(Message.serializer(), o("""{"id":"$id","channel_id":"200","author":{"id":"2","username":"bob","global_name":"Bob"},"content":"$t","timestamp":"2026-11-05T10:00:00Z"}"""))
        }
        Session.store.update { Reducer.page(it, "200", msgs.reversed(), null, 50) }
    }

    private fun <T> onMain(f: () -> T): T { var r: T? = null; instr.runOnMainSync { r = f() }; return r!! }

    @Test fun conversationsReadAloudReplyAndMarkRead() {
        val t = onMain { ConversationsScreen(car).onGetTemplate() } as ListTemplate
        val items = t.singleList!!.items.map { it as ConversationItem }
        assertEquals(listOf("ch-200", "ch-100"), items.map { it.id })
        assertEquals(listOf("Bob", "#general · Team"), items.map { it.title.toString() })
        val dm = items[0]
        assertEquals(listOf("Are you coming to the scrim?", "We start at 8"), dm.messages.map { it.body.toString() })
        assertEquals(listOf(false, false), dm.messages.map { it.isRead })
        assertEquals("Me", dm.self.name)
        assertTrue("server channels are group conversations", items[1].isGroupConversation)
        assertEquals(2, t.header!!.endHeaderActions.size) // Voice and Status

        dm.conversationCallbackDelegate.sendMarkAsRead(done)
        waitFor { Session.store.value.readStates["200"]?.lastMessageId == "600" }
        dm.conversationCallbackDelegate.sendTextReply("On my way", done)
        waitFor { Session.store.value.messages["200"].orEmpty().any { it.content == "On my way" } }
    }

    @Test fun voiceChannelsAndCalls() {
        val t = onMain { VoiceScreen(car).onGetTemplate() } as ListTemplate
        val sections = t.sectionedLists
        assertEquals(listOf("Voice channels", "Calls"), sections.map { it.header.toString() })
        val lounge = sections[0].itemList.items.single() as Row
        assertEquals("Lounge · Team", lounge.title.toString())
        assertEquals("Bob", lounge.texts.single().toString())
        assertEquals("Bob", (sections[1].itemList.items.single() as Row).title.toString())
    }

    @Test fun statusIsARadioList() {
        val t = onMain { StatusScreen(car).onGetTemplate() } as ListTemplate
        val list = t.singleList!!
        assertEquals(4, list.items.size)
        assertEquals(0, list.selectedIndex)
        list.onSelectedDelegate!!.sendSelected(2, done)
        waitFor { Session.store.value.myStatus == "dnd" }
    }

    private fun waitFor(f: () -> Boolean) {
        val end = System.currentTimeMillis() + 5000
        while (!f()) { if (System.currentTimeMillis() > end) throw AssertionError("timed out"); Thread.sleep(50) }
    }
}
