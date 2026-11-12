package io.github.mrciller.cillhub.car

import android.Manifest
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import androidx.car.app.CarAppService
import androidx.car.app.CarContext
import androidx.car.app.CarToast
import androidx.car.app.Screen
import androidx.car.app.Session
import androidx.car.app.constraints.ConstraintManager
import androidx.car.app.messaging.model.CarMessage
import androidx.car.app.messaging.model.ConversationCallback
import androidx.car.app.messaging.model.ConversationItem
import androidx.car.app.model.Action
import androidx.car.app.model.CarIcon
import androidx.car.app.model.CarText
import androidx.car.app.model.Header
import androidx.car.app.model.ItemList
import androidx.car.app.model.ListTemplate
import androidx.car.app.model.MessageTemplate
import androidx.car.app.model.Row
import androidx.car.app.model.SectionedItemList
import androidx.car.app.model.Template
import androidx.car.app.model.Toggle
import androidx.car.app.validation.HostValidator
import androidx.core.app.Person
import androidx.core.content.ContextCompat
import androidx.core.graphics.drawable.IconCompat
import androidx.lifecycle.lifecycleScope
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.TokenStore
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session as Hub
import io.github.mrciller.cillhub.voice.VStatus
import io.github.mrciller.cillhub.voice.Voice
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch

/**
 * Cillhub in Android Auto (Car App Library, messaging and calling categories, Car API 7+): conversations with their
 * newest messages (the car reads them aloud, offers voice reply and mark as read), voice channels and DM calls to join
 * (the call then runs in Android Auto's own call view through Telecom), and the status. Older head units keep the
 * notification messaging and the Telecom calls, which do not need this service.
 */
class CarService : CarAppService() {
    override fun createHostValidator(): HostValidator =
        if (applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0) HostValidator.ALLOW_ALL_HOSTS_VALIDATOR
        else HostValidator.Builder(applicationContext).addAllowedHosts(androidx.car.app.R.array.hosts_allowlist_sample).build()

    override fun onCreateSession(): Session = object : Session() {
        override fun onCreateScreen(intent: Intent): Screen {
            Hub.connect() // the car may start the app without any screen of it open
            return if (TokenStore.get(carContext) == null) SignedOutScreen(carContext) else ConversationsScreen(carContext)
        }
    }
}

private fun icon(ctx: CarContext, res: Int) = CarIcon.Builder(IconCompat.createWithResource(ctx, res)).build()
private fun limit(ctx: CarContext, fallback: Int = 6) =
    runCatching { ctx.getCarService(ConstraintManager::class.java).getContentLimit(ConstraintManager.CONTENT_LIMIT_TYPE_LIST) }.getOrDefault(fallback)

/** Sign in happens on the phone: say so, nothing else to do in the car. */
class SignedOutScreen(ctx: CarContext) : Screen(ctx) {
    override fun onGetTemplate(): Template = MessageTemplate.Builder(carContext.getString(R.string.car_signed_out))
        .setHeader(Header.Builder().setTitle(carContext.getString(R.string.app_name)).setStartHeaderAction(Action.APP_ICON).build()).build()
}

/** Redraws when what it shows changes; a refresh with the same structure does not use template quota. */
private fun Screen.follow(key: () -> Any) {
    lifecycleScope.launch {
        @OptIn(kotlinx.coroutines.FlowPreview::class)
        combine(Hub.store.state, Voice.state) { _, _ -> key() }.distinctUntilChanged().debounce(300).collect { invalidate() }
    }
}

/** The root: conversations (ConversationItem), with Voice and Status in the header. */
class ConversationsScreen(ctx: CarContext) : Screen(ctx) {
    private val requested = HashSet<String>()

    init { follow { CarModel.conversations(Hub.store.value, limit(carContext)) } }

    override fun onGetTemplate(): Template {
        val s = Hub.store.value
        val me = s.me
        val list = CarModel.conversations(s, limit(carContext))
        // history is fetched only for what the car shows, once per conversation
        for (c in list) if (!c.loaded && requested.add(c.channel.id)) Hub.scope.launch { runCatching { Hub.loadMessages(c.channel.id) } }
        val items = ItemList.Builder().setNoItemsMessage(carContext.getString(R.string.car_no_conversations))
        val self = Person.Builder().setName(me?.displayName ?: "").setKey(me?.id ?: "me").build()
        for (c in list) items.addItem(
            ConversationItem.Builder()
                .setId("ch-${c.channel.id}") // the same id as the notification's conversation shortcut
                .setTitle(CarText.create(c.title))
                .setIcon(icon(carContext, if (c.channel.guildId != null) R.drawable.ms_tag else R.drawable.ms_chat))
                .setSelf(self)
                .setGroupConversation(c.group)
                .setMessages(c.messages.ifEmpty { listOf(CarModel.Msg("", "", "", carContext.getString(R.string.car_loading), 0, true)) }.map { m ->
                    CarMessage.Builder()
                        .setSender(if (m.senderId == me?.id) self else Person.Builder().setName(m.sender).setKey(m.senderId.ifEmpty { "cillhub" }).build())
                        .setBody(CarText.create(m.text)).setReceivedTimeEpochMillis(m.time).setRead(m.read).build()
                })
                .setConversationCallback(callback(c.channel.id))
                .build()
        )
        return ListTemplate.Builder()
            .setHeader(Header.Builder().setTitle(carContext.getString(R.string.app_name)).setStartHeaderAction(Action.APP_ICON)
                .addEndHeaderAction(Action.Builder().setIcon(icon(carContext, R.drawable.ms_volume_up)).setTitle(carContext.getString(R.string.car_voice))
                    .setOnClickListener { screenManager.push(VoiceScreen(carContext)) }.build())
                .addEndHeaderAction(Action.Builder().setIcon(icon(carContext, R.drawable.ms_account_circle)).setTitle(carContext.getString(R.string.set_status))
                    .setOnClickListener { screenManager.push(StatusScreen(carContext)) }.build())
                .build())
            .setSingleList(items.build())
            .build()
    }

    /** Mark as read and the dictated reply reuse the app's own ack and send. */
    private fun callback(channelId: String) = object : ConversationCallback {
        override fun onMarkAsRead() {
            Hub.store.value.channels[channelId]?.lastMessageId?.let { Hub.ack(channelId, it) }
        }
        override fun onTextReply(text: String) {
            val ch = Hub.store.value.channels[channelId] ?: return
            Hub.scope.launch {
                runCatching { Hub.send(ch, text.take(2000)) }.onFailure {
                    if (it is io.github.mrciller.cillhub.data.E2ee.Refused) CarToast.makeText(carContext, it.message + " " + carContext.getString(R.string.e2ee_open_app), CarToast.LENGTH_LONG).show()
                    else CarToast.makeText(carContext, R.string.car_reply_failed, CarToast.LENGTH_LONG).show()
                }
            }
        }
    }
}

/** Voice channels with who is in them, the current call's mute, deafen and leave, and calls to recent DMs. */
class VoiceScreen(ctx: CarContext) : Screen(ctx) {
    init { follow { Triple(CarModel.voiceChannels(Hub.store.value, limit(carContext)), Voice.state.value.let { listOf(it.channelId, it.status, it.selfMute, it.selfDeaf) }, Sel.privateChannels(Hub.store.value).take(3).map { it.id }) } }

    private fun join(guildId: String?, channelId: String, ring: Boolean) {
        if (ContextCompat.checkSelfPermission(carContext, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED)
            CarToast.makeText(carContext, R.string.car_mic_on_phone, CarToast.LENGTH_LONG).show() // joins listen-only
        Voice.join(guildId, channelId, ring)
    }

    override fun onGetTemplate(): Template {
        val s = Hub.store.value
        val v = Voice.state.value
        val max = limit(carContext)
        val b = ListTemplate.Builder().setHeader(Header.Builder().setTitle(carContext.getString(R.string.car_voice)).setStartHeaderAction(Action.BACK).build())
        v.channelId?.let { id ->
            val ch = s.channels[id]
            val now = ItemList.Builder()
                .addItem(Row.Builder().setTitle(carContext.getString(R.string.voice_mute)).setImage(icon(carContext, R.drawable.ms_mic_off))
                    .setToggle(Toggle.Builder { Voice.setSelfMute(it) }.setChecked(v.selfMute).build()).build())
                .addItem(Row.Builder().setTitle(carContext.getString(R.string.voice_deafen)).setImage(icon(carContext, R.drawable.ms_headset_off))
                    .setToggle(Toggle.Builder { Voice.setSelfDeaf(it) }.setChecked(v.selfDeaf).build()).build())
                .addItem(Row.Builder().setTitle(carContext.getString(R.string.voice_leave)).setImage(icon(carContext, R.drawable.ms_call_end))
                    .setOnClickListener { Voice.leave() }.build())
                .build()
            val status = if (v.status == VStatus.CONNECTED) carContext.getString(R.string.voice_connected) else carContext.getString(R.string.voice_connecting)
            b.addSectionedList(SectionedItemList.create(now, "$status: ${ch?.let { CarModel.title(s, it) } ?: ""}"))
        }
        val channels = ItemList.Builder().setNoItemsMessage(carContext.getString(R.string.car_no_voice))
        for (r in CarModel.voiceChannels(s, max)) channels.addItem(
            Row.Builder().setTitle(r.title).addText(r.people.ifEmpty { carContext.getString(R.string.voice_empty) })
                .setImage(icon(carContext, R.drawable.ms_volume_up))
                .setOnClickListener { join(r.channel.guildId, r.channel.id, false) }.build()
        )
        b.addSectionedList(SectionedItemList.create(channels.build(), carContext.getString(R.string.car_voice_channels)))
        val dms = Sel.privateChannels(s).take(3)
        if (dms.isNotEmpty()) {
            val calls = ItemList.Builder()
            for (c in dms) calls.addItem(
                Row.Builder().setTitle(Sel.privateName(s, c)).addText(carContext.getString(if (s.calls.containsKey(c.id)) R.string.voice_join_call else R.string.start_call))
                    .setImage(icon(carContext, R.drawable.ms_call)).setOnClickListener { join(null, c.id, !s.calls.containsKey(c.id)) }.build()
            )
            b.addSectionedList(SectionedItemList.create(calls.build(), carContext.getString(R.string.car_calls)))
        }
        return b.build()
    }
}

/** Online, idle, do not disturb, invisible: a radio list. */
class StatusScreen(ctx: CarContext) : Screen(ctx) {
    private val options = listOf("online" to R.string.status_online, "idle" to R.string.status_idle, "dnd" to R.string.status_dnd, "invisible" to R.string.status_invisible)

    init { follow { Hub.store.value.myStatus } }

    override fun onGetTemplate(): Template {
        val items = ItemList.Builder()
        options.forEach { (_, label) -> items.addItem(Row.Builder().setTitle(carContext.getString(label)).build()) }
        items.setSelectedIndex(options.indexOfFirst { it.first == Hub.store.value.myStatus }.coerceAtLeast(0))
        items.setOnSelectedListener { i -> Hub.setStatus(options[i].first) }
        return ListTemplate.Builder().setHeader(Header.Builder().setTitle(carContext.getString(R.string.set_status)).setStartHeaderAction(Action.BACK).build())
            .setSingleList(items.build()).build()
    }
}
