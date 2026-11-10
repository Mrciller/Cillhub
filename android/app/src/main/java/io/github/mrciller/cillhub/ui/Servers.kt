package io.github.mrciller.cillhub.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.border
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.CutCornerShape
import androidx.compose.ui.draw.drawBehind
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.annotation.DrawableRes
import androidx.annotation.StringRes
import io.github.mrciller.cillhub.Config
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.Channel
import io.github.mrciller.cillhub.data.Guild
import io.github.mrciller.cillhub.data.Perm
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.State
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** Servers tab: a vertical server rail next to the selected server's channels; on large screens the chat beside them. */
@Composable
fun ServersScreen(selected: String?, select: (String) -> Unit, detailChannel: String?) {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val guildId = selected?.takeIf { state.guilds.containsKey(it) } ?: state.guilds.keys.firstOrNull()
    var adding by rememberSaveable { mutableStateOf(false) }
    val nav = LocalNav.current
    // two panes always show a chat: the picked channel, else where the server opens
    val shown = if (!nav.twoPane) null else detailChannel?.takeIf { state.channels[it]?.guildId == guildId } ?: guildId?.let { Sel.firstText(state, it)?.id }
    Row(Modifier.fillMaxSize()) {
        ServerRail(state, guildId, select) { adding = true }
        Box((if (nav.twoPane) Modifier.width(300.dp) else Modifier.weight(1f)).fillMaxHeight()) {
            val g = guildId?.let { state.guilds[it] }
            if (g == null) {
                if (state.conn == io.github.mrciller.cillhub.data.Conn.READY) EmptyState(R.drawable.ms_dns, s(R.string.no_servers_title), s(R.string.no_servers_text))
                else Loading()
            } else ChannelList(state, g, shown)
        }
        if (nav.twoPane) Box(Modifier.weight(1f).fillMaxHeight().background(MaterialTheme.colorScheme.surfaceContainer)) {
            if (shown != null) {
                val sc = state.channels[shown]
                if (sc != null && sc.type == 15) {
                    ForumScreen(shown, showBack = false)
                } else {
                    ChatScreen(shown, showBack = false)
                }
            } else {
                EmptyState(R.drawable.ms_forum, s(R.string.pick_channel))
            }
        }
    }
    if (adding) AddServerDialog { adding = false }
}

@Composable
fun Loading() = Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { androidx.compose.material3.CircularProgressIndicator() }

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ServerRail(state: State, selected: String?, select: (String) -> Unit, add: () -> Unit) {
    val ctx = LocalContext.current
    val nav = LocalNav.current
    val clock = rememberRevealClock()
    LazyColumn(
        Modifier.width(76.dp).fillMaxHeight().background(if (LocalExtra.current.isDark) MaterialTheme.colorScheme.surfaceContainerLowest else MaterialTheme.colorScheme.surfaceContainerHighest)
            .windowInsetsPadding(WindowInsets.safeDrawing.only(WindowInsetsSides.Top + WindowInsetsSides.Start)),
        horizontalAlignment = Alignment.CenterHorizontally,
        contentPadding = androidx.compose.foundation.layout.PaddingValues(vertical = 8.dp),
    ) {
        itemsIndexed(state.guilds.values.toList(), key = { _, it -> it.id }) { index, g ->
            val badge = Sel.guildBadge(state, g.id)
            val isSel = g.id == selected
            val desc = buildString {
                append(g.name)
                if (badge.mentions > 0) append(", ").append(ctx.resources.getQuantityString(R.plurals.mentions, badge.mentions, badge.mentions))
                else if (badge.unread) append(", ").append(ctx.getString(R.string.unread))
            }
            val interaction = remember { androidx.compose.foundation.interaction.MutableInteractionSource() }
            Box(Modifier.fillMaxWidth().height(60.dp).reveal(index, clock), contentAlignment = Alignment.Center) {
                // selection / unread mark on the left edge (accent when selected)
                if (isSel || badge.unread) Box(Modifier.align(Alignment.CenterStart).width(4.dp).height(if (isSel) 36.dp else 10.dp)
                    .background(if (isSel) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface))
                // the selected server carries the HUD bevel, the others a lighter cut
                val shape = if (isSel) Hud else CutCornerShape(8.dp)
                Box(
                    Modifier.size(50.dp).pressScale(interaction).clip(shape)
                        .then(if (isSel) Modifier.border(2.dp, MaterialTheme.colorScheme.primary, shape) else Modifier)
                        .combinedClickable(
                            interactionSource = interaction, indication = androidx.compose.material3.ripple(),
                            role = Role.Tab, onClickLabel = g.name, onClick = { select(g.id) },
                            onLongClickLabel = ctx.getString(R.string.server_settings),
                            onLongClick = if (canOpenServerSettings(state, g.id)) { { nav.openServerSettings(g.id) } } else null,
                        )
                        .semantics(mergeDescendants = true) { contentDescription = desc; this.selected = isSel },
                    contentAlignment = Alignment.Center,
                ) {
                    Picture(guildIconUrl(g), g.name, g.id, 50.dp, shape)
                }
                CountBadge(badge.mentions, Modifier.align(Alignment.BottomEnd).padding(end = 8.dp, bottom = 4.dp))
            }
        }
        item {
            Box(Modifier.fillMaxWidth().height(60.dp), contentAlignment = Alignment.Center) {
                Surface(
                    onClick = add, shape = CutCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceContainerHigh,
                    border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                    modifier = Modifier.size(50.dp),
                ) {
                    Box(contentAlignment = Alignment.Center) { Ic(R.drawable.ms_add, s(R.string.add_server), tint = MaterialTheme.colorScheme.primary) }
                }
            }
        }
    }
}

fun channelIcon(c: Channel) = when (c.type) {
    2, 13 -> R.drawable.ms_volume_up
    5 -> R.drawable.ms_campaign
    15 -> R.drawable.ms_forum
    else -> R.drawable.ms_tag
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChannelList(state: State, g: Guild, selected: String?) {
    val nav = LocalNav.current
    val ctx = LocalContext.current
    val collapsed = remember { mutableStateMapOf<String, Boolean>() }
    var sheetFor by remember { mutableStateOf<Channel?>(null) }
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    val hold = { c: Channel -> haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.LongPress); sheetFor = c }
    val clock = rememberRevealClock()
    val groups = remember(state.channels, state.guilds[g.id], state.members[g.id], state.readStates, state.guildSettings) { Sel.sidebar(state, g.id) }
    Column(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerLow)) {
        TopAppBar(
            title = {
                val admin = canOpenServerSettings(state, g.id)
                Text(g.name.uppercase(), maxLines = 1, overflow = TextOverflow.Ellipsis,
                    modifier = if (admin) Modifier.clickable(onClickLabel = s(R.string.server_settings)) { nav.openServerSettings(g.id) } else Modifier)
            },
            actions = {
                IconButton({ nav.openMembers(g.id) }) { Ic(R.drawable.ms_group, s(R.string.members)) }
                if (canOpenServerSettings(state, g.id)) IconButton({ nav.openServerSettings(g.id) }) { Ic(R.drawable.ms_settings, s(R.string.server_settings)) }
            },
            colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
            windowInsets = if (nav.twoPane) TopAppBarDefaults.windowInsets.only(WindowInsetsSides.Top) else TopAppBarDefaults.windowInsets.only(WindowInsetsSides.Top + WindowInsetsSides.End),
        )
        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        LazyColumn(Modifier.fillMaxSize(), contentPadding = androidx.compose.foundation.layout.PaddingValues(bottom = 16.dp)) {
            for (grp in groups) {
                val cat = grp.category
                val closed = cat != null && collapsed[cat.id] == true
                if (cat != null) item(key = "cat" + cat.id) {
                    Row(
                        Modifier.fillMaxWidth().heightIn(min = 48.dp)
                            .combinedClickable(onClickLabel = s(if (closed) R.string.expand else R.string.collapse), onLongClickLabel = s(R.string.channel_options), onLongClick = { hold(cat) }) { collapsed[cat.id] = !closed }
                            .padding(start = 12.dp, end = 16.dp, top = 8.dp)
                            .semantics(mergeDescendants = true) { heading(); stateDescription = ctx.getString(if (closed) R.string.collapsed else R.string.expanded) },
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        Ic(R.drawable.ms_expand_more, null, Modifier.size(18.dp).rotate(if (closed) -90f else 0f), MaterialTheme.colorScheme.onSurfaceVariant)
                        Spacer(Modifier.width(4.dp))
                        SectionHeader(cat.name ?: "")
                    }
                }
                // a collapsed category still shows its unread or open channels
                val shown = if (closed) grp.channels.filter { it.id == selected || Sel.isUnread(state, it) || Sel.mentions(state, it.id) > 0 } else grp.channels
                itemsIndexed(shown, key = { _, it -> it.id }) { index, c ->
                    Column(Modifier.animateItem().reveal(index, clock)) {
                        ChannelRow(
                            state,
                            c,
                            c.id == selected,
                            onClick = { nav.openChannel(c.id) },
                            onLongClick = { hold(c) },
                        )
                        if (c.type in Sel.VOICE_TYPES) VoiceChannelUsers(state, c)
                    }
                }
            }
        }
    }
    sheetFor?.let { ChannelActionSheet(state, g, it) { sheetFor = null } }
}

/** What a long-press on a channel or category offers, in sheet order, by the viewer's permissions in it. */
enum class ChannelAction(@StringRes val label: Int, @DrawableRes val icon: Int) {
    EDIT(R.string.edit_channel, R.drawable.ms_edit), ACCESS(R.string.manage_channel_access, R.drawable.ms_lock),
    NOTIFY(R.string.channel_notifications, R.drawable.ms_notifications), MARK_READ(R.string.mark_read, R.drawable.ms_done_all),
    COPY_LINK(R.string.copy_link, R.drawable.ms_content_copy), CLONE(R.string.clone_channel, R.drawable.ms_forum), DELETE(R.string.delete_channel, R.drawable.ms_delete),
}

fun channelActions(perms: Long, category: Boolean): List<ChannelAction> = buildList {
    val manage = Perm.has(perms, Perm.MANAGE_CHANNELS)
    if (manage) add(ChannelAction.EDIT)
    if (Perm.has(perms, Perm.MANAGE_ROLES)) add(ChannelAction.ACCESS)
    add(ChannelAction.NOTIFY); add(ChannelAction.MARK_READ)
    if (!category) add(ChannelAction.COPY_LINK)
    if (manage && !category) add(ChannelAction.CLONE)
    if (manage) add(ChannelAction.DELETE)
}

/** Long-press sheet for a channel or category; the editors it opens are the ones from channel info and server settings. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ChannelActionSheet(state: State, g: Guild, c: Channel, close: () -> Unit) {
    val nav = LocalNav.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val clipboard = androidx.compose.ui.platform.LocalClipboard.current
    val category = c.type == 4
    var next by remember { mutableStateOf<ChannelAction?>(null) } // the dialog or sheet opened from here replaces this sheet
    if (next == null) androidx.compose.material3.ModalBottomSheet(close) {
        Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
            Text((if (category) "" else "#") + (c.name ?: ""), style = MaterialTheme.typography.titleLarge, fontWeight = androidx.compose.ui.text.font.FontWeight.Bold,
                maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp).semantics { heading() })
            for (a in channelActions(Sel.perms(state, g.id, c), category)) {
                val label = when {
                    category && a == ChannelAction.EDIT -> R.string.edit_category
                    category && a == ChannelAction.DELETE -> R.string.delete_category
                    else -> a.label
                }
                val color = if (a == ChannelAction.DELETE) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
                androidx.compose.material3.ListItem(
                    headlineContent = { Text(s(label), color = color) },
                    leadingContent = { Ic(a.icon, null, Modifier.size(24.dp), color) },
                    colors = androidx.compose.material3.ListItemDefaults.colors(containerColor = androidx.compose.ui.graphics.Color.Transparent),
                    modifier = Modifier.clickable {
                        when (a) {
                            ChannelAction.ACCESS -> { close(); nav.openChannelAccess(c.id) }
                            ChannelAction.MARK_READ -> {
                                scope.launch { runCatching { Session.ackBulk(if (category) state.channels.values.filter { it.parentId == c.id } else listOf(c)) } }
                                close()
                            }
                            ChannelAction.COPY_LINK -> {
                                val link = Config.APP_URL.trimEnd('/') + "/channels/${g.id}/${c.id}"
                                scope.launch { clipboard.setClipEntry(androidx.compose.ui.platform.ClipEntry(android.content.ClipData.newPlainText("link", link))) }
                                if (android.os.Build.VERSION.SDK_INT < 33) android.widget.Toast.makeText(ctx, R.string.copied, android.widget.Toast.LENGTH_SHORT).show() // 13+ confirms on its own
                                close()
                            }
                            else -> next = a
                        }
                    },
                )
            }
        }
    }
    when (next) {
        ChannelAction.EDIT -> ChannelEditDialog(c, close)
        ChannelAction.CLONE -> CloneChannelDialog(c, close)
        ChannelAction.NOTIFY -> ChannelNotifySheet(state, g.id, c, close)
        ChannelAction.DELETE -> AlertDialog(
            onDismissRequest = close,
            title = { Text(s(if (category) R.string.delete_category else R.string.delete_channel)) },
            text = { Text(s(R.string.delete_channel_confirm, c.name ?: "")) },
            confirmButton = { TextButton({ scope.launch { runCatching { Session.rest.request("DELETE", "/channels/${c.id}") }; close() } }) { Text(s(R.string.delete), color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton(close) { Text(s(R.string.cancel)) } },
        )
        else -> {}
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ChannelRow(
    state: State,
    c: Channel,
    selected: Boolean,
    onClick: () -> Unit,
    onLongClick: () -> Unit,
) {
    val unread = Sel.isUnread(state, c)
    val mentions = Sel.mentions(state, c.id)
    val muted = Sel.isChannelMuted(state, c)
    val hasDraft = !state.drafts[c.id].isNullOrBlank()
    val ctx = LocalContext.current
    val color = when {
        selected || unread -> MaterialTheme.colorScheme.onSurface
        muted -> MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.6f)
        else -> MaterialTheme.colorScheme.onSurfaceVariant
    }
    val accent = MaterialTheme.colorScheme.primary
    Row(
        Modifier.fillMaxWidth().padding(horizontal = 8.dp, vertical = 1.dp).clip(Hud)
            .background(if (selected) MaterialTheme.colorScheme.secondaryContainer else androidx.compose.ui.graphics.Color.Transparent)
            // the open channel: bevelled row with an accent edge
            .drawBehind { if (selected) drawRect(accent, size = androidx.compose.ui.geometry.Size(3.dp.toPx(), size.height)) }
            .combinedClickable(onClick = onClick, onLongClickLabel = s(R.string.channel_options), onLongClick = onLongClick).heightIn(min = 48.dp).padding(horizontal = 12.dp)
            .semantics(mergeDescendants = true) {
                this.selected = selected
                stateDescription = listOfNotNull(
                    ctx.getString(when (c.type) { 2, 13 -> R.string.voice_channel; 5 -> R.string.announcement_channel; 15 -> R.string.forum_channel; else -> R.string.text_channel }),
                    if (mentions > 0) ctx.resources.getQuantityString(R.plurals.mentions, mentions, mentions) else if (unread) ctx.getString(R.string.unread) else null,
                ).joinToString(", ")
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Ic(channelIcon(c), null, Modifier.size(20.dp), color)
        Spacer(Modifier.width(10.dp))
        Text(c.name ?: "", color = color, fontWeight = if (unread || selected) FontWeight.SemiBold else FontWeight.Normal, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
        if (hasDraft) {
            Text("✎", color = MaterialTheme.colorScheme.primary, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.padding(end = 6.dp))
        }
        if (mentions > 0) CountBadge(mentions) else if (unread) Box(Modifier.size(8.dp).clip(CircleShape).background(MaterialTheme.colorScheme.onSurface))
    }
}

@Composable
private fun CloneChannelDialog(channel: Channel, close: () -> Unit) {
    var name by rememberSaveable { mutableStateOf(channel.name ?: "") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val nav = LocalNav.current

    AlertDialog(
        onDismissRequest = close,
        title = { Text(s(R.string.clone_channel)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text(s(R.string.channel_name)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (error != null) Text(error!!, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    if (name.isBlank()) return@Button
                    scope.launch {
                        busy = true; error = null
                        try {
                            val cloned = Session.cloneChannel(channel.id, name.trim())
                            close()
                            nav.openChannel(cloned.id)
                        } catch (e: Exception) {
                            error = errorText(ctx, e)
                        } finally {
                            busy = false
                        }
                    }
                },
                enabled = !busy && name.isNotBlank(),
             shape = Hud) { Text(s(R.string.clone)) }
        },
        dismissButton = { TextButton(onClick = close) { Text(s(R.string.cancel)) } },
    )
}

/** Join a server with an invite link or code, or create one. */
@Composable
private fun AddServerDialog(close: () -> Unit) {
    var invite by rememberSaveable { mutableStateOf("") }
    var name by rememberSaveable { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    val nav = LocalNav.current
    fun run(block: suspend () -> Unit) = scope.launch {
        busy = true; error = null
        try { block(); close() } catch (e: Exception) { error = errorText(ctx, e) }
        busy = false
    }
    AlertDialog(
        onDismissRequest = close,
        title = { Text(s(R.string.add_server)) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text(s(R.string.join_server_text), style = MaterialTheme.typography.bodyMedium)
                OutlinedTextField(invite, { invite = it }, label = { Text(s(R.string.invite_link)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                TextButton(enabled = invite.isNotBlank() && !busy, onClick = {
                    val code = invite.trim().trimEnd('/').substringAfterLast('/')
                    run {
                        val g = Session.rest.request("POST", "/invites/${java.net.URLEncoder.encode(code, "UTF-8")}")
                        val sys = io.github.mrciller.cillhub.data.json.parseToJsonElement(g).jsonObject["system_channel_id"]
                        Session.store.dispatch("GUILD_CREATE", io.github.mrciller.cillhub.data.json.parseToJsonElement(g).jsonObject)
                        (sys as? kotlinx.serialization.json.JsonPrimitive)?.content?.let { nav.openChannel(it) }
                    }
                }) { Text(s(R.string.join_server)) }
                HorizontalDivider()
                OutlinedTextField(name, { name = it }, label = { Text(s(R.string.new_server_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                TextButton(enabled = name.isNotBlank() && !busy, onClick = {
                    run {
                        val g = Session.rest.request("POST", "/guilds", buildJsonObject { put("name", name.trim()) })
                        Session.store.dispatch("GUILD_CREATE", io.github.mrciller.cillhub.data.json.parseToJsonElement(g).jsonObject)
                    }
                }) { Text(s(R.string.create_server)) }
                if (error != null) Text(error!!, color = MaterialTheme.colorScheme.error)
            }
        },
        confirmButton = { TextButton(close) { Text(s(R.string.close)) } },
    )
}
