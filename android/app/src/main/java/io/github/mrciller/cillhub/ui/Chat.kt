package io.github.mrciller.cillhub.ui

import android.net.Uri
import android.provider.OpenableColumns
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SmallFloatingActionButton
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import coil3.compose.AsyncImage
import io.github.mrciller.cillhub.Notifications
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.ApiError
import io.github.mrciller.cillhub.data.Attachment
import io.github.mrciller.cillhub.data.Channel
import io.github.mrciller.cillhub.data.Conn
import io.github.mrciller.cillhub.data.Message
import io.github.mrciller.cillhub.data.Perm
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.State
import io.github.mrciller.cillhub.data.Upload
import io.github.mrciller.cillhub.data.isPrivate
import io.github.mrciller.cillhub.data.isThread
import io.github.mrciller.cillhub.data.json
import kotlinx.coroutines.channels.Channel as Events
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonObject
import java.time.LocalDate

/** A picked file waiting to be sent. */
data class Picked(val uri: Uri, val name: String, val size: Long, val mime: String) {
    val isImage get() = mime.startsWith("image/")
}

/** One conversation: history paging, the composer (text, reply, edit, files) and send errors. */
class ChatViewModel(val channelId: String) : ViewModel() {
    var text by mutableStateOf("")
    var replyTo by mutableStateOf<Message?>(null)
    var editing by mutableStateOf<Message?>(null)
    val files = mutableStateListOf<Picked>()
    var loading by mutableStateOf(false)
    var loadError by mutableStateOf<Throwable?>(null)
    var progress by mutableStateOf<Float?>(null)
    val events = Events<Throwable>(Events.BUFFERED)

    fun load(force: Boolean = false) {
        if (loading || (!force && Session.store.value.messages.containsKey(channelId))) return
        loading = true; loadError = null
        viewModelScope.launch {
            try { Session.loadMessages(channelId) } catch (e: Exception) { loadError = e }
            loading = false
        }
    }

    fun older() {
        val s = Session.store.value
        val first = s.messages[channelId]?.firstOrNull { !it.pending && !it.failed } ?: return
        if (loading || s.hasMore[channelId] != true) return
        loading = true
        viewModelScope.launch {
            try { Session.loadMessages(channelId, first.id) } catch (e: Exception) { events.trySend(e) }
            loading = false
        }
    }

    fun startEdit(m: Message) { editing = m; replyTo = null; text = m.content }
    fun cancel() { if (editing != null) text = ""; editing = null; replyTo = null }

    /** False when nothing was sent (empty, too long). */
    fun send(ch: Channel, limit: Long, open: (Uri) -> java.io.InputStream?): Boolean {
        val content = text.trim()
        if (content.isEmpty() && files.isEmpty()) return false
        if (content.length > 2000) { events.trySend(IllegalArgumentException("2000")); return false }
        files.firstOrNull { it.size > limit }?.let { events.trySend(IllegalArgumentException("size:" + it.name)); return false }
        val edit = editing
        if (edit != null) {
            if (content.isEmpty()) return false
            text = ""; editing = null
            viewModelScope.launch { try { Session.edit(edit, content) } catch (e: Exception) { events.trySend(e) } }
            return true
        }
        val reply = replyTo
        val picked = files.toList()
        text = ""; replyTo = null; files.clear()
        Session.sentMessage(ch.id)
        viewModelScope.launch {
            try {
                val uploads = picked.map { p -> Upload(p.name, p.size, p.mime) { open(p.uri) ?: throw java.io.FileNotFoundException(p.name) } }
                if (uploads.isNotEmpty()) progress = 0f
                Session.send(ch, content, reply, uploads) { progress = it }
            } catch (e: Exception) { events.trySend(e) }
            progress = null
        }
        return true
    }

    /** Resend a failed message's text (files of a failed send are not kept). */
    fun retry(m: Message) {
        val ch = Session.store.value.channels[m.channelId] ?: return
        Session.discard(m)
        viewModelScope.launch { try { Session.send(ch, m.content, m.referencedMessage) } catch (e: Exception) { events.trySend(e) } }
    }

    fun react(m: Message, emoji: io.github.mrciller.cillhub.data.EmojiRef) = viewModelScope.launch {
        try { Session.toggleReaction(m, emoji) } catch (e: Exception) { events.trySend(e) }
    }

    fun delete(m: Message) = viewModelScope.launch { try { Session.delete(m) } catch (e: Exception) { events.trySend(e) } }

    fun favorite(g: io.github.mrciller.cillhub.data.FavoriteGif) = viewModelScope.launch { try { Session.toggleFavoriteGif(g) } catch (e: Exception) { events.trySend(e) } }

    fun sendGif(ch: Channel, url: String) = viewModelScope.launch { try { Session.send(ch, url, replyTo.also { replyTo = null }) } catch (e: Exception) { events.trySend(e) } }
}

private sealed interface Item { val key: String }
private data class DayItem(val day: LocalDate) : Item { override val key = "day$day" }
private data class MsgItem(val m: Message, val header: Boolean) : Item { override val key = m.nonce?.takeIf { m.pending || m.failed } ?: m.id }

/** Oldest first: day separators, and a header only where the author or a 7-minute gap changes (like the web client). */
private fun items(list: List<Message>): List<Item> {
    val out = ArrayList<Item>()
    var prev: Message? = null
    for (m in list) {
        val day = dayOf(m.timestamp)
        val prevDay = prev?.let { dayOf(it.timestamp) }
        if (day != null && day != prevDay) out += DayItem(day)
        val gap = prev?.let { p -> val a = instantOf(p.timestamp); val b = instantOf(m.timestamp); a == null || b == null || b.epochSecond - a.epochSecond > 420 } ?: true
        val header = prev == null || gap || day != prevDay || prev.author.id != m.author.id || m.type == 19 || m.type == 7 || prev.type == 7 || m.webhookId != null
        out += MsgItem(m, header)
        prev = m
    }
    return out
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChatScreen(channelId: String, showBack: Boolean) {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val vm: ChatViewModel = viewModel(key = "chat-$channelId") { ChatViewModel(channelId) }
    val ch = state.channels[channelId]
    val nav = LocalNav.current
    val ctx = LocalContext.current
    val snack = remember { SnackbarHostState() }
    val haptic = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    var missing by remember { mutableStateOf(false) }

    // a channel we do not know yet (deep link before READY, or not in READY): fetch it once the session is up
    LaunchedEffect(channelId, state.conn) {
        if (ch == null && state.conn == Conn.READY) try {
            Session.store.dispatch("CHANNEL_CREATE", json.parseToJsonElement(Session.rest.request("GET", "/channels/$channelId")).jsonObject)
        } catch (e: Exception) { missing = true }
    }
    if (ch == null) { if (missing) EmptyState(R.drawable.ms_error, s(R.string.channel_unavailable)) else Loading(); return }

    LaunchedEffect(channelId, state.conn) { if (state.conn == Conn.READY) vm.load() }
    LaunchedEffect(vm) {
        vm.events.receiveAsFlow().collect { e ->
            val msg = when {
                e is IllegalArgumentException && e.message == "2000" -> ctx.getString(R.string.too_long)
                e is IllegalArgumentException && e.message?.startsWith("size:") == true -> ctx.getString(R.string.file_too_big, e.message!!.removePrefix("size:"))
                e is ApiError && e.status == 429 -> ctx.getString(R.string.slowmode, Math.ceil(e.retryAfter).toInt().coerceAtLeast(1))
                else -> errorText(ctx, e)
            }
            snack.showSnackbar(msg)
        }
    }

    // this conversation is on screen: no notifications for it, and its notification goes
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    DisposableEffect(lifecycle, channelId) {
        val obs = LifecycleEventObserver { _, e ->
            if (e == Lifecycle.Event.ON_RESUME) { Session.openChannel = channelId; Notifications.read(ctx, channelId, null) }
            if (e == Lifecycle.Event.ON_PAUSE && Session.openChannel == channelId) Session.openChannel = null
        }
        lifecycle.addObserver(obs)
        onDispose { lifecycle.removeObserver(obs); if (Session.openChannel == channelId) Session.openChannel = null }
    }
    val resumed by lifecycle.currentStateFlow.collectAsStateWithLifecycle()

    val perms = Sel.perms(state, ch.guildId, ch)
    val canSend = Perm.has(perms, Perm.SEND_MESSAGES)
    val messages = state.messages[channelId]
    val list = remember(messages) { items(messages.orEmpty()).asReversed() }
    val listState = rememberLazyListState()
    val atBottom by remember { derivedStateOf { listState.firstVisibleItemIndex <= 1 } }
    var sheetFor by remember { mutableStateOf<Message?>(null) }
    var picker by remember { mutableStateOf<Message?>(null) }
    var confirmDelete by remember { mutableStateOf<Message?>(null) }
    var purgeMode by rememberSaveable { mutableStateOf(false) }
    val selectedPurgeIds = remember { mutableStateListOf<String>() }
    var confirmBulkDelete by remember { mutableStateOf(false) }
    var showMediaGallery by remember { mutableStateOf(false) }
    var threadNotifDialog by remember { mutableStateOf(false) }
    var createPollOpen by remember { mutableStateOf(false) }

    LaunchedEffect(channelId) {
        val draft = Session.getDraft(channelId)
        if (draft.isNotBlank() && vm.text.isBlank()) vm.text = draft
    }

    LaunchedEffect(ch.guildId) {
        if (ch.guildId != null) runCatching { Session.loadSnippets(ch.guildId) }
        // role colours and tags need the members
        if (ch.guildId != null && ch.guildId !in Session.store.value.membersLoaded) runCatching { Session.loadMembers(ch.guildId) }
    }

    // read: the newest message is visible while the app is in front
    val lastId = ch.lastMessageId
    LaunchedEffect(lastId, atBottom, resumed, messages != null) {
        if (lastId != null && atBottom && messages != null && resumed.isAtLeast(Lifecycle.State.RESUMED) &&
            (Sel.isUnread(state, ch) || Sel.mentions(state, ch.id) > 0)) Session.ack(channelId, lastId)
    }
    // older history when the top comes into view
    LaunchedEffect(listState, list.size) {
        snapshotFlow { listState.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0 }.collect { last -> if (last >= list.size - 5) vm.older() }
    }
    // a search result to show: older pages until it is loaded, then scroll there and tint it a moment
    var highlight by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(channelId) {
        // collected, not a keyed effect: clearing the request must not cancel the jump it started
        pendingJump.filterNotNull().filter { it.first == channelId }.collect { (_, mid) ->
            pendingJump.value = null
            Session.store.state.first { it.messages[channelId] != null }
            fun loaded() = Session.store.value.messages[channelId].orEmpty()
            snapshotFlow { vm.loading }.first { !it }
            vm.loading = true
            try {
                // shortcut: at most 40 pages (2000 messages) back; an around= window would need a list with gaps
                var pages = 0
                while (loaded().none { it.id == mid } && Session.store.value.hasMore[channelId] == true && pages++ < 40)
                    Session.loadMessages(channelId, loaded().firstOrNull { !it.pending && !it.failed }?.id ?: break)
            } catch (e: Exception) { if (e is kotlinx.coroutines.CancellationException) throw e; vm.events.trySend(e); return@collect } finally { vm.loading = false }
            val idx = items(loaded()).asReversed().indexOfFirst { it is MsgItem && it.m.id == mid }
            if (idx < 0) { snack.showSnackbar(ctx.getString(R.string.message_too_old)); return@collect }
            snapshotFlow { listState.layoutInfo.totalItemsCount }.first { it > idx }
            listState.scrollToItem(idx)
            highlight = mid
            kotlinx.coroutines.delay(2500)
            highlight = null
        }
    }
    // new message of our own: jump down
    val newest = messages?.lastOrNull()
    LaunchedEffect(newest?.id) { if (newest?.author?.id == state.me?.id && newest != null) listState.animateScrollToItem(0) }

    Scaffold(
        topBar = {
            ChatTopBar(
                state = state,
                ch = ch,
                showBack = showBack,
                purgeMode = purgeMode,
                selectedPurgeCount = selectedPurgeIds.size,
                onExitPurge = { purgeMode = false; selectedPurgeIds.clear() },
                onConfirmPurge = { confirmBulkDelete = true },
                onTogglePurge = { purgeMode = !purgeMode; selectedPurgeIds.clear() },
                onOpenMediaGallery = { showMediaGallery = true },
                onOpenThreadNotif = { threadNotifDialog = true },
            )
        },
        snackbarHost = { SnackbarHost(snack) },
        containerColor = MaterialTheme.colorScheme.surfaceContainer,
        contentWindowInsets = WindowInsets(0),
        bottomBar = {
            if (!purgeMode) {
                Composer(
                    state = state,
                    ch = ch,
                    vm = vm,
                    canSend = canSend,
                    canAttach = Perm.has(perms, Perm.ATTACH_FILES),
                    onOpenPoll = { createPollOpen = true },
                ) {
                    val limit = Session.instance.value?.maxUploadBytes ?: (25L * 1024 * 1024)
                    if (vm.send(ch, limit) { ctx.contentResolver.openInputStream(it) }) {
                        Session.clearDraft(ch.id)
                        haptic.performHapticFeedback(HapticFeedbackType.Confirm)
                    }
                }
            }
        },
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            if (ch.solvedMessageId != null) {
                Surface(
                    color = MaterialTheme.colorScheme.primaryContainer,
                    modifier = Modifier.fillMaxWidth().clickable {
                        val idx = list.indexOfFirst { it is MsgItem && it.m.id == ch.solvedMessageId }
                        if (idx >= 0) scope.launch { listState.animateScrollToItem(idx) }
                    },
                ) {
                    Row(
                        Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Ic(R.drawable.ms_check, null, Modifier.size(18.dp), MaterialTheme.colorScheme.onPrimaryContainer)
                        Spacer(Modifier.width(8.dp))
                        Text(
                            s(R.string.thread_solved_banner),
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                            modifier = Modifier.weight(1f),
                        )
                        Text(
                            s(R.string.jump),
                            style = MaterialTheme.typography.labelSmall,
                            fontWeight = FontWeight.Bold,
                            color = MaterialTheme.colorScheme.primary,
                        )
                    }
                }
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when {
                    messages == null && vm.loadError != null -> Column(Modifier.align(Alignment.Center), horizontalAlignment = Alignment.CenterHorizontally) {
                        Text(errorText(vm.loadError!!), color = MaterialTheme.colorScheme.error)
                        TextButton({ vm.load(force = true) }, shape = MaterialTheme.shapes.small) { Text(s(R.string.retry).uppercase()) }
                    }
                    messages == null -> Loading()
                    else -> LazyColumn(Modifier.fillMaxSize(), state = listState, reverseLayout = true, contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 8.dp)) {
                        items(list, key = { it.key }, contentType = { if (it is DayItem) 0 else 1 }) { item ->
                            when (item) {
                                is DayItem -> DaySeparator(item.day)
                                is MsgItem -> {
                                    Column(if (item.m.id == highlight) Modifier.background(MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.5f)) else Modifier) {
                                        if (purgeMode) {
                                            Row(
                                                Modifier.fillMaxWidth().clickable {
                                                    val id = item.m.id
                                                    if (selectedPurgeIds.contains(id)) selectedPurgeIds.remove(id)
                                                    else if (selectedPurgeIds.size < 100) selectedPurgeIds.add(id)
                                                },
                                                verticalAlignment = Alignment.CenterVertically,
                                            ) {
                                                Checkbox(
                                                    checked = selectedPurgeIds.contains(item.m.id),
                                                    onCheckedChange = { checked ->
                                                        val id = item.m.id
                                                        if (checked) {
                                                            if (selectedPurgeIds.size < 100) selectedPurgeIds.add(id)
                                                        } else selectedPurgeIds.remove(id)
                                                    },
                                                    modifier = Modifier.padding(start = 8.dp),
                                                )
                                                Box(Modifier.weight(1f)) {
                                                    MessageItem(
                                                        state, item.m, item.header, ch.guildId,
                                                        onLongPress = { },
                                                        onReply = { },
                                                        onReact = { },
                                                        onAddReaction = { },
                                                        onJump = { },
                                                        canReply = false,
                                                    )
                                                }
                                            }
                                        } else {
                                            MessageItem(
                                                state, item.m, item.header, ch.guildId,
                                                onLongPress = { haptic.performHapticFeedback(HapticFeedbackType.LongPress); sheetFor = item.m },
                                                onReply = { if (canSend) { vm.replyTo = item.m; vm.editing = null } },
                                                onReact = { e -> vm.react(item.m, e) },
                                                onAddReaction = { picker = item.m },
                                                onJump = { id -> list.indexOfFirst { it is MsgItem && it.m.id == id }.takeIf { it >= 0 }?.let { scope.launch { listState.animateScrollToItem(it) } } },
                                                canReply = canSend,
                                            )
                                        }

                                        if (isPrivate(ch)) {
                                            val reads = state.dmRecipientReads[channelId].orEmpty()
                                            val readers = reads.filter { it.value == item.m.id && it.key != state.me?.id }.keys
                                            if (readers.isNotEmpty()) {
                                                Row(
                                                    Modifier.fillMaxWidth().padding(end = 16.dp, top = 2.dp, bottom = 4.dp),
                                                    horizontalArrangement = Arrangement.End,
                                                    verticalAlignment = Alignment.CenterVertically,
                                                ) {
                                                    Text(s(R.string.seen_by) + " ", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                                    for (uid in readers) {
                                                        val u = state.users[uid]
                                                        if (u != null) {
                                                            Avatar(u, 16.dp)
                                                            Spacer(Modifier.width(2.dp))
                                                        }
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                        item(key = "top") {
                            if (state.hasMore[channelId] == true) Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(24.dp)) }
                            else ChannelStart(state, ch)
                        }
                    }
                }
                androidx.compose.animation.AnimatedVisibility(!atBottom && !purgeMode, Modifier.align(Alignment.BottomEnd).padding(16.dp)) {
                    SmallFloatingActionButton({ scope.launch { listState.animateScrollToItem(0) } }) { Ic(R.drawable.ms_expand_more, s(R.string.jump_to_present)) }
                }
            }
        }
    }

    sheetFor?.let { m ->
        MessageActions(state, m, ch, perms, vm, onClose = { sheetFor = null }, onPickReaction = { picker = m }, onDelete = { confirmDelete = m })
    }
    picker?.let { m -> ReactionPicker({ picker = null }) { e -> vm.react(m, e); picker = null } }
    confirmDelete?.let { m ->
        AlertDialog(
            onDismissRequest = { confirmDelete = null },
            title = { Text(s(R.string.delete_message_title).uppercase()) },
            text = { Text(s(R.string.delete_message_text)) },
            confirmButton = { TextButton({ vm.delete(m); confirmDelete = null }, shape = MaterialTheme.shapes.small) { Text(s(R.string.delete).uppercase(), color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton({ confirmDelete = null }, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) } },
        )
    }

    if (confirmBulkDelete) {
        AlertDialog(
            onDismissRequest = { confirmBulkDelete = false },
            title = { Text(s(R.string.bulk_delete_title).uppercase()) },
            text = { Text(s(R.string.bulk_delete_text, selectedPurgeIds.size)) },
            confirmButton = {
                TextButton(onClick = {
                    val toDelete = selectedPurgeIds.toList()
                    confirmBulkDelete = false
                    purgeMode = false
                    selectedPurgeIds.clear()
                    scope.launch {
                        try {
                            Session.bulkDelete(channelId, toDelete)
                        } catch (e: Exception) {
                            snack.showSnackbar(errorText(ctx, e))
                        }
                    }
                }, shape = MaterialTheme.shapes.small) {
                    Text(s(R.string.delete).uppercase(), color = MaterialTheme.colorScheme.error)
                }
            },
            dismissButton = { TextButton({ confirmBulkDelete = false }, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) } },
        )
    }

    if (showMediaGallery) {
        MediaGallerySheet(channelId) { showMediaGallery = false }
    }

    if (threadNotifDialog) {
        val member = ch.member
        ThreadNotifDialog(channelId, member?.flags ?: 0) { threadNotifDialog = false }
    }

    if (createPollOpen) {
        CreatePollDialog(channelId) { createPollOpen = false }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChatTopBar(
    state: State,
    ch: Channel,
    showBack: Boolean,
    purgeMode: Boolean,
    selectedPurgeCount: Int,
    onExitPurge: () -> Unit,
    onConfirmPurge: () -> Unit,
    onTogglePurge: () -> Unit,
    onOpenMediaGallery: () -> Unit,
    onOpenThreadNotif: () -> Unit,
) {
    val nav = LocalNav.current
    val ctx = LocalContext.current
    val other = if (ch.type == 1) ch.recipients.firstOrNull()?.let { state.users[it.id] ?: it } else null
    val perms = Sel.perms(state, ch.guildId, ch)
    val canPurge = Perm.has(perms, Perm.MANAGE_MESSAGES)
    val isThread = ch.isThread || ch.type == 11

    if (purgeMode) {
        TopAppBar(
            navigationIcon = { IconButton(onExitPurge) { Ic(R.drawable.ms_close, s(R.string.close)) } },
            title = { Text(s(R.string.purge_selected, selectedPurgeCount).uppercase(), fontWeight = FontWeight.Bold) },
            actions = {
                if (selectedPurgeCount > 0) {
                    IconButton(onConfirmPurge) {
                        Ic(R.drawable.ms_delete, s(R.string.delete), tint = MaterialTheme.colorScheme.error)
                    }
                }
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.errorContainer),
            windowInsets = TopAppBarDefaults.windowInsets.only(WindowInsetsSides.Top + WindowInsetsSides.End + if (showBack) WindowInsetsSides.Start else WindowInsetsSides.End),
        )
        return
    }

    TopAppBar(
        navigationIcon = { if (showBack) IconButton(nav::back) { Ic(R.drawable.ms_arrow_back, s(R.string.back)) } },
        title = {
            val titleClick = when {
                other != null -> Modifier.clickable(onClickLabel = s(R.string.view_profile)) { nav.openProfile(other.id, null) }
                ch.guildId != null -> Modifier.clickable(onClickLabel = s(R.string.channel_info)) { nav.openChannelInfo(ch.id) }
                else -> Modifier
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = titleClick) {
                if (other != null) { Avatar(other, 32.dp, Sel.presence(state, other.id)); Spacer(Modifier.width(10.dp)) }
                else if (!isPrivate(ch)) { Ic(channelIcon(ch), null, Modifier.size(22.dp), MaterialTheme.colorScheme.primary); Spacer(Modifier.width(6.dp)) }
                Column(Modifier.weight(1f, fill = false)) {
                    Text(Sel.channelName(state, ch), maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleLarge, modifier = Modifier.semantics { heading() })
                    val sub = when {
                        other != null -> ctx.getString(presenceLabel(Sel.presence(state, other.id)))
                        ch.type == 3 -> ctx.resources.getQuantityString(R.plurals.members_count, ch.recipients.size + 1, ch.recipients.size + 1)
                        else -> ch.topic
                    }
                    if (!sub.isNullOrBlank()) Text(sub, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                if (ch.guildId != null) Ic(R.drawable.ms_chevron_right, null, Modifier.size(20.dp), MaterialTheme.colorScheme.onSurfaceVariant)
            }
        },
        actions = {
            if (isPrivate(ch)) IconButton({ nav.openVoice(ch.id, start = !state.calls.containsKey(ch.id)) }) { Ic(R.drawable.ms_call, s(if (state.calls.containsKey(ch.id)) R.string.voice_join_call else R.string.start_call)) }
            if (isThread) IconButton(onOpenThreadNotif) { Ic(R.drawable.ms_notifications, s(R.string.thread_notifications)) }
            IconButton({ nav.openSearch(ch.id) }) { Ic(R.drawable.ms_search, s(R.string.search_messages)) }
            IconButton(onOpenMediaGallery) { Ic(R.drawable.ms_perm_media, s(R.string.media_files_links)) }
            if (canPurge) IconButton(onTogglePurge) { Ic(R.drawable.ms_delete, s(R.string.purge_messages)) }
            if (ch.guildId != null && showBack) IconButton({ nav.openMembers(ch.guildId) }) { Ic(R.drawable.ms_group, s(R.string.members)) }
        },
        colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
        windowInsets = TopAppBarDefaults.windowInsets.only(WindowInsetsSides.Top + WindowInsetsSides.End + if (showBack) WindowInsetsSides.Start else WindowInsetsSides.End),
    )
}

@Composable
private fun DaySeparator(day: LocalDate) {
    val ctx = LocalContext.current
    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
        Surface(
            color = MaterialTheme.colorScheme.surfaceContainerLow,
            shape = MaterialTheme.shapes.small,
            border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
            modifier = Modifier.padding(horizontal = 10.dp),
        ) {
            Text(dayLabel(ctx, day), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 10.dp, vertical = 3.dp).semantics { heading() })
        }
        HorizontalDivider(Modifier.weight(1f), color = MaterialTheme.colorScheme.outlineVariant)
    }
}

@Composable
private fun ChannelStart(state: State, ch: Channel) {
    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        shape = Hud,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth().padding(16.dp),
    ) {
        Column(Modifier.padding(20.dp)) {
            val name = Sel.channelName(state, ch)
            Box(
                Modifier.size(44.dp).clip(MaterialTheme.shapes.large).background(MaterialTheme.colorScheme.primaryContainer),
                contentAlignment = Alignment.Center,
            ) {
                Ic(if (isPrivate(ch)) R.drawable.ms_chat else channelIcon(ch), null, Modifier.size(22.dp), MaterialTheme.colorScheme.primary)
            }
            Spacer(Modifier.size(12.dp))
            Text((if (isPrivate(ch)) name else s(R.string.welcome_channel, name)).uppercase(), style = MaterialTheme.typography.headlineSmall)
            Text(if (isPrivate(ch)) s(R.string.dm_start, name) else s(R.string.channel_start, name), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = 4.dp))
        }
    }
}

@Composable
private fun Composer(
    state: State,
    ch: Channel,
    vm: ChatViewModel,
    canSend: Boolean,
    canAttach: Boolean,
    onOpenPoll: () -> Unit,
    send: () -> Unit,
) {
    val ctx = LocalContext.current
    val typing = Sel.typing(state, ch.id)
    var menu by remember { mutableStateOf(false) }
    var gifs by remember { mutableStateOf(false) }
    if (gifs) GifPicker({ gifs = false }) { vm.sendGif(ch, it) }
    fun add(uris: List<Uri>) {
        for (u in uris.take(10 - vm.files.size)) {
            var name = "file"; var size = 0L
            ctx.contentResolver.query(u, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) { name = c.getString(0) ?: name; size = c.getLong(1) }
            }
            vm.files += Picked(u, name, size, ctx.contentResolver.getType(u) ?: "application/octet-stream")
        }
    }
    val media = rememberLauncherForActivityResult(ActivityResultContracts.PickMultipleVisualMedia(10)) { add(it) }
    val docs = rememberLauncherForActivityResult(ActivityResultContracts.OpenMultipleDocuments()) { add(it) }

    val matchingSnippets = remember(vm.text, state.snippets[ch.guildId]) {
        if (vm.text.startsWith("!") && ch.guildId != null) {
            val q = vm.text.removePrefix("!").lowercase()
            state.snippets[ch.guildId]?.filter { it.name.lowercase().contains(q) }.orEmpty()
        } else emptyList()
    }

    Surface(color = MaterialTheme.colorScheme.surfaceContainer) {
        Column(Modifier.windowInsetsPadding(WindowInsets.ime.union(WindowInsets.navigationBars).only(WindowInsetsSides.Bottom + WindowInsetsSides.Horizontal))) {
            Text(
                when (typing.size) { 0 -> ""; 1 -> s(R.string.typing_one, typing[0]); 2 -> s(R.string.typing_two, typing[0], typing[1]); else -> s(R.string.typing_many) },
                style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1,
                modifier = Modifier.padding(horizontal = 16.dp).heightIn(min = 18.dp).semantics { liveRegion = LiveRegionMode.Polite },
            )
            val bar = vm.editing?.let { s(R.string.editing_message) } ?: vm.replyTo?.let { s(R.string.replying_to, Sel.memberName(state, ch.guildId, it.author.id)) }
            if (bar != null) Row(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainerHigh).padding(start = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                Ic(if (vm.editing != null) R.drawable.ms_edit else R.drawable.ms_reply, null, Modifier.size(18.dp), MaterialTheme.colorScheme.onSurfaceVariant)
                Text(bar, Modifier.weight(1f).padding(start = 8.dp), style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                IconButton(vm::cancel) { Ic(R.drawable.ms_close, s(R.string.cancel)) }
            }
            if (vm.files.isNotEmpty()) LazyRow(Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                items(vm.files.toList(), key = { it.uri.toString() }) { f ->
                    InputChip(
                        selected = false, onClick = { vm.files.remove(f) },
                        label = { Text(f.name, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.width(120.dp)) },
                        avatar = { if (f.isImage) AsyncImage(f.uri, null, Modifier.size(24.dp).clip(MaterialTheme.shapes.extraSmall), contentScale = ContentScale.Crop) else Ic(R.drawable.ms_description, null, Modifier.size(20.dp)) },
                        trailingIcon = { Ic(R.drawable.ms_close, s(R.string.remove_file, f.name), Modifier.size(18.dp)) },
                    )
                }
            }
            if (matchingSnippets.isNotEmpty()) {
                LazyRow(
                    Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                ) {
                    items(matchingSnippets, key = { it.id }) { snip ->
                        FilterChip(
                            selected = false,
                            onClick = {
                                vm.text = snip.content
                                Session.saveDraft(ch.id, snip.content)
                            },
                            label = { Text("!" + snip.name, fontWeight = FontWeight.Bold) },
                        )
                    }
                }
            }
            vm.progress?.let { androidx.compose.material3.LinearProgressIndicator(progress = { it }, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp)) }
            Row(Modifier.fillMaxWidth().padding(horizontal = 4.dp, vertical = 4.dp), verticalAlignment = Alignment.Bottom) {
                if (canAttach && vm.editing == null) Box {
                    IconButton({ menu = true }) { Ic(R.drawable.ms_add, s(R.string.attach)) }
                    DropdownMenu(menu, { menu = false }) {
                        DropdownMenuItem({ Text(s(R.string.attach_media)) }, { menu = false; media.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageAndVideo)) },
                            leadingIcon = { Ic(R.drawable.ms_add_photo_alternate, null) })
                        DropdownMenuItem({ Text(s(R.string.attach_file)) }, { menu = false; docs.launch(arrayOf("*/*")) }, leadingIcon = { Ic(R.drawable.ms_attach_file, null) })
                        DropdownMenuItem({ Text(s(R.string.create_poll)) }, { menu = false; onOpenPoll() }, leadingIcon = { Ic(R.drawable.ms_poll, null) })
                    }
                } else Spacer(Modifier.width(12.dp))
                TextField(
                    vm.text, {
                        vm.text = it
                        Session.saveDraft(ch.id, it)
                        if (it.isNotEmpty()) Session.typing(ch.id)
                    },
                    enabled = canSend,
                    placeholder = { Text(if (canSend) s(R.string.message_to, (if (isPrivate(ch)) "@" else "#") + Sel.channelName(state, ch)) else s(R.string.no_send_permission), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                    modifier = Modifier.weight(1f).heightIn(min = 48.dp, max = 160.dp),
                    shape = MaterialTheme.shapes.medium,
                    colors = TextFieldDefaults.colors(focusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent, unfocusedIndicatorColor = androidx.compose.ui.graphics.Color.Transparent, disabledIndicatorColor = androidx.compose.ui.graphics.Color.Transparent,
                        focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest, unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerHighest),
                    keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                )
                if (canSend && vm.editing == null && vm.text.isBlank()) IconButton({ gifs = true }) { Ic(R.drawable.ms_gif, s(R.string.gif_open)) }
                val ready = canSend && (vm.text.isNotBlank() || vm.files.isNotEmpty())
                IconButton(send, enabled = ready) { Ic(if (vm.editing != null) R.drawable.ms_check else R.drawable.ms_send, s(if (vm.editing != null) R.string.save else R.string.send), tint = if (ready) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant) }
            }
        }
    }
}

@Composable
private fun ThreadNotifDialog(channelId: String, currentFlags: Int, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = close,
        title = { Text(s(R.string.thread_notifications).uppercase()) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                val options = listOf(
                    0 to R.string.notif_all_messages,
                    1 to R.string.notif_only_mentions,
                    2 to R.string.notif_nothing,
                )
                for ((flag, labelRes) in options) {
                    Surface(
                        onClick = {
                            scope.launch {
                                runCatching { Session.updateThreadNotification(channelId, flag) }
                                close()
                            }
                        },
                        shape = MaterialTheme.shapes.small,
                        color = if (currentFlags == flag) MaterialTheme.colorScheme.primaryContainer else Color.Transparent,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Text(
                            s(labelRes),
                            style = MaterialTheme.typography.bodyLarge,
                            fontWeight = if (currentFlags == flag) FontWeight.Bold else FontWeight.Normal,
                            modifier = Modifier.padding(12.dp),
                        )
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = close, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) } },
    )
}

@Composable
fun CreatePollDialog(channelId: String, close: () -> Unit) {
    var question by rememberSaveable { mutableStateOf("") }
    val answers = remember { mutableStateListOf("", "") }
    var durationHours by rememberSaveable { mutableStateOf(24) }
    var allowMulti by rememberSaveable { mutableStateOf(false) }
    var isQuiz by rememberSaveable { mutableStateOf(false) }
    var correctAnswerIndex by rememberSaveable { mutableStateOf<Int?>(null) }
    var isAnonymous by rememberSaveable { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current

    AlertDialog(
        onDismissRequest = close,
        title = { Text(s(R.string.create_poll).uppercase()) },
        text = {
            LazyColumn(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                item {
                    OutlinedTextField(
                        value = question,
                        onValueChange = { question = it },
                        label = { Text(s(R.string.poll_question)) },
                        modifier = Modifier.fillMaxWidth(),
                        maxLines = 3,
                    )
                }
                item {
                    Text(s(R.string.poll_options), fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelMedium)
                }
                itemsIndexed(answers) { index, ans ->
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
                        if (isQuiz) {
                            RadioButton(
                                selected = correctAnswerIndex == index,
                                onClick = { correctAnswerIndex = index },
                            )
                        }
                        OutlinedTextField(
                            value = ans,
                            onValueChange = { answers[index] = it },
                            label = { Text(s(R.string.poll_option_n, index + 1)) },
                            singleLine = true,
                            modifier = Modifier.weight(1f),
                        )
                        if (answers.size > 2) {
                            IconButton(onClick = {
                                answers.removeAt(index)
                                if (correctAnswerIndex == index) correctAnswerIndex = null
                                else if (correctAnswerIndex != null && correctAnswerIndex!! > index) correctAnswerIndex = correctAnswerIndex!! - 1
                            }) {
                                Ic(R.drawable.ms_close, null)
                            }
                        }
                    }
                }
                if (answers.size < 10) {
                    item {
                        TextButton(onClick = { answers.add("") }, shape = MaterialTheme.shapes.small) {
                            Ic(R.drawable.ms_add, null)
                            Spacer(Modifier.width(4.dp))
                            Text(s(R.string.add_option).uppercase())
                        }
                    }
                }
                item {
                    HorizontalDivider(Modifier.padding(vertical = 4.dp))
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(s(R.string.poll_allow_multiselect))
                        Switch(checked = allowMulti, onCheckedChange = { allowMulti = it })
                    }
                }
                item {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(s(R.string.poll_quiz_mode))
                        Switch(checked = isQuiz, onCheckedChange = {
                            isQuiz = it
                            if (!it) correctAnswerIndex = null
                        })
                    }
                }
                item {
                    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(s(R.string.poll_anonymous_mode))
                        Switch(checked = isAnonymous, onCheckedChange = { isAnonymous = it })
                    }
                }
                if (error != null) {
                    item {
                        Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    val filteredAnswers = answers.filter { it.isNotBlank() }
                    if (question.isBlank() || filteredAnswers.size < 2) return@Button
                    scope.launch {
                        busy = true
                        error = null
                        try {
                            Session.createPoll(
                                channelId = channelId,
                                question = question.trim(),
                                answers = filteredAnswers.map { it.trim() },
                                allowMultiselect = allowMulti,
                                durationHours = durationHours,
                                anonymous = isAnonymous,
                                correctAnswerIndex = if (isQuiz) correctAnswerIndex else null,
                            )
                            close()
                        } catch (e: Exception) {
                            error = errorText(ctx, e)
                        } finally {
                            busy = false
                        }
                    }
                },
                enabled = !busy && question.isNotBlank() && answers.count { it.isNotBlank() } >= 2,
             shape = MaterialTheme.shapes.small) {
                Text(s(R.string.create).uppercase())
            }
        },
        dismissButton = {
            TextButton(onClick = close, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) }
        },
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MediaGallerySheet(channelId: String, onClose: () -> Unit) {
    var tab by rememberSaveable { mutableStateOf("media") } // "media", "files", "links"
    ModalBottomSheet(onDismissRequest = onClose, containerColor = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 16.dp).padding(bottom = 24.dp)) {
            Text(s(R.string.media_files_links), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.padding(bottom = 8.dp))

            androidx.compose.material3.PrimaryTabRow(
                selectedTabIndex = when (tab) { "files" -> 1; "links" -> 2; else -> 0 },
                containerColor = Color.Transparent,
            ) {
                androidx.compose.material3.Tab(selected = tab == "media", onClick = { tab = "media" }, text = { Text(s(R.string.tab_media)) })
                androidx.compose.material3.Tab(selected = tab == "files", onClick = { tab = "files" }, text = { Text(s(R.string.tab_files)) })
                androidx.compose.material3.Tab(selected = tab == "links", onClick = { tab = "links" }, text = { Text(s(R.string.tab_links)) })
            }

            Spacer(Modifier.height(12.dp))
            MediaList(channelId, tab, Modifier.fillMaxWidth().heightIn(max = 420.dp))
        }
    }
}

/** A channel's media grid, files or links (GET /channels/:id/media?tab=). */
@Composable
fun MediaList(channelId: String, tab: String, modifier: Modifier = Modifier) {
    var items by remember { mutableStateOf<List<Attachment>>(emptyList()) }
    var links by remember { mutableStateOf<List<String>>(emptyList()) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    val ctx = LocalContext.current
    val nav = LocalNav.current

    LaunchedEffect(channelId, tab) {
        loading = true
        error = null
        try {
            val msgs = Session.loadChannelMedia(channelId, tab)
            items = msgs.flatMap { it.attachments }
            val linkRegex = Regex("https?://\\S+")
            links = msgs.flatMap { m -> linkRegex.findAll(m.content).map { it.value }.toList() }
        } catch (e: Exception) {
            error = errorText(ctx, e)
        } finally {
            loading = false
        }
    }

    Box(modifier) {
            when {
                loading -> Box(Modifier.fillMaxWidth().height(160.dp), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
                error != null -> Text(error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
                tab == "media" && items.isEmpty() -> Text(s(R.string.no_media_found), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
                tab == "files" && items.isEmpty() -> Text(s(R.string.no_files_found), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
                tab == "links" && links.isEmpty() -> Text(s(R.string.no_links_found), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp))
                tab == "media" -> {
                    androidx.compose.foundation.lazy.grid.LazyVerticalGrid(
                        columns = androidx.compose.foundation.lazy.grid.GridCells.Fixed(3),
                        horizontalArrangement = Arrangement.spacedBy(4.dp),
                        verticalArrangement = Arrangement.spacedBy(4.dp),
                        modifier = Modifier.fillMaxSize(),
                    ) {
                        items(items.size, key = { items[it].id }) { idx ->
                            val a = items[idx]
                            val url = io.github.mrciller.cillhub.Config.cdn(a.url)
                            AsyncImage(
                                model = url,
                                contentDescription = a.filename,
                                contentScale = ContentScale.Crop,
                                modifier = Modifier.aspectRatio(1f).clip(MaterialTheme.shapes.small).clickable { nav.openImage(url, a.filename) },
                            )
                        }
                    }
                }
                tab == "files" -> {
                    LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        items(items, key = { it.id }) { a ->
                            Surface(
                                shape = MaterialTheme.shapes.medium,
                                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                                onClick = { download(ctx, io.github.mrciller.cillhub.Config.cdn(a.url), a.filename) },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Ic(R.drawable.ms_description, null, Modifier.size(24.dp), MaterialTheme.colorScheme.primary)
                                    Spacer(Modifier.width(8.dp))
                                    Column(Modifier.weight(1f)) {
                                        Text(a.filename, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = FontWeight.Medium)
                                        Text(android.text.format.Formatter.formatShortFileSize(ctx, a.size), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                    Ic(R.drawable.ms_download, null)
                                }
                            }
                        }
                    }
                }
                tab == "links" -> {
                    LazyColumn(Modifier.fillMaxSize(), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        items(links) { link ->
                            Surface(
                                shape = MaterialTheme.shapes.medium,
                                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                                onClick = { openUrl(ctx, link) },
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Row(Modifier.padding(10.dp), verticalAlignment = Alignment.CenterVertically) {
                                    Ic(R.drawable.ms_open_in_new, null, Modifier.size(20.dp), MaterialTheme.colorScheme.primary)
                                    Spacer(Modifier.width(8.dp))
                                    Text(link, maxLines = 2, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.primary)
                                }
                            }
                        }
                    }
                }
            }
    }
}
