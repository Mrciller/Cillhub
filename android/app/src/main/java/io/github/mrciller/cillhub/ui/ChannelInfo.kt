package io.github.mrciller.cillhub.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryScrollableTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.Channel
import io.github.mrciller.cillhub.data.Message
import io.github.mrciller.cillhub.data.Overwrite
import io.github.mrciller.cillhub.data.Perm
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.State
import io.github.mrciller.cillhub.data.cmpId
import io.github.mrciller.cillhub.data.isThread
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

private val INFO_TABS = listOf(R.string.members, R.string.tab_media, R.string.tab_pins, R.string.tab_threads, R.string.tab_links, R.string.tab_files)

/** Channel info: who can see it (grouped by hoisted role), media, pins, threads, links and files; channel access for managers. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelInfoScreen(channelId: String) {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val nav = LocalNav.current
    val ch = state.channels[channelId]
    val gid = ch?.guildId
    if (ch == null || gid == null) { Loading(); return }
    var tab by rememberSaveable { mutableStateOf(0) }
    var editing by remember { mutableStateOf(false) }
    var notify by remember { mutableStateOf(false) }
    val perms = Sel.perms(state, gid, ch)
    Scaffold(topBar = {
        TopAppBar(
            title = {},
            navigationIcon = { IconButton(nav::back) { Ic(R.drawable.ms_arrow_back, s(R.string.back)) } },
            actions = {
                IconButton({ nav.openSearch(ch.id) }) { Ic(R.drawable.ms_search, s(R.string.search_messages)) }
                IconButton({ notify = true }) { Ic(R.drawable.ms_notifications, s(R.string.channel_notifications)) }
                if (Perm.has(perms, Perm.MANAGE_CHANNELS)) IconButton({ editing = true }) { Ic(R.drawable.ms_settings, s(R.string.edit_channel)) }
            },
        )
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            Row(Modifier.padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(52.dp).clip(Hud).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) {
                    Ic(channelIcon(ch), null, Modifier.size(28.dp), MaterialTheme.colorScheme.primary)
                }
                Spacer(Modifier.width(14.dp))
                Column {
                    Text(ch.name ?: "", style = MaterialTheme.typography.headlineSmall, modifier = Modifier.semantics { heading() })
                    Text(s(channelTypeLabel(ch)).uppercase(), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            PrimaryScrollableTabRow(tab, edgePadding = 8.dp) {
                INFO_TABS.forEachIndexed { i, label -> Tab(tab == i, { tab = i }, text = { Text(s(label)) }) }
            }
            when (tab) {
                0 -> ChannelMembers(state, gid, ch)
                1 -> MediaList(ch.id, "media", Modifier.fillMaxSize().padding(8.dp))
                2 -> PinsList(state, ch)
                3 -> ThreadsList(state, ch)
                4 -> MediaList(ch.id, "links", Modifier.fillMaxSize().padding(8.dp))
                else -> MediaList(ch.id, "files", Modifier.fillMaxSize().padding(8.dp))
            }
        }
    }
    if (editing) ChannelEditDialog(ch) { editing = false }
    if (notify) ChannelNotifySheet(state, gid, ch) { notify = false }
}

private val MUTE_FOR = listOf(900L to R.string.mute_15m, 3600L to R.string.mute_1h, 28800L to R.string.mute_8h, 86400L to R.string.mute_1d, 0L to R.string.mute_forever)

/** This channel's override in the user guild settings: notify level (all / mentions / nothing / server default) and mute for a while. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun ChannelNotifySheet(state: State, gid: String, ch: Channel, close: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var error by remember { mutableStateOf<String?>(null) }
    val o = state.guildSettings[gid]?.channelOverrides?.firstOrNull { it.channelId == ch.id }
    val muted = Sel.isChannelMuted(state, ch.copy(parentId = null)) // only this channel's own mute can be lifted here
    fun patch(f: kotlinx.serialization.json.JsonObjectBuilder.() -> Unit) = scope.launch {
        try {
            Session.rest.request("PATCH", "/users/@me/guilds/$gid/settings", buildJsonObject { put("channel_overrides", buildJsonObject { put(ch.id, buildJsonObject(f)) }) })
            close()
        } catch (e: Exception) { error = errorText(ctx, e) }
    }
    ModalBottomSheet(close) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = 24.dp)) {
            Text(s(R.string.channel_notifications), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 16.dp).semantics { heading() })
            Text("#" + (ch.name ?: ""), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp))
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) }
            val level = o?.messageNotifications ?: 3
            for ((v, label) in listOf(3 to R.string.notif_default, 0 to R.string.notif_all_messages, 1 to R.string.notif_only_mentions, 2 to R.string.notif_none)) {
                ListItem(
                    headlineContent = { Text(s(label)) },
                    leadingContent = { androidx.compose.material3.RadioButton(level == v, null) },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    modifier = Modifier.selectable(level == v, role = androidx.compose.ui.semantics.Role.RadioButton) { patch { put("message_notifications", v) } },
                )
            }
            Text(s(if (muted) R.string.channel_muted else R.string.mute_channel), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary,
                modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() })
            if (muted) {
                o?.muteConfig?.endTime?.let { Text(s(R.string.muted_until, messageTime(ctx, it)), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp)) }
                ListItem(headlineContent = { Text(s(R.string.unmute_channel), color = MaterialTheme.colorScheme.primary) }, leadingContent = { Ic(R.drawable.ms_notifications, null) },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    modifier = Modifier.clickable { patch { put("muted", false); put("mute_config", kotlinx.serialization.json.JsonNull) } })
            } else for ((secs, label) in MUTE_FOR) {
                ListItem(headlineContent = { Text(s(label)) }, colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    modifier = Modifier.clickable {
                        patch {
                            put("muted", true)
                            put("mute_config", if (secs == 0L) kotlinx.serialization.json.JsonNull else buildJsonObject {
                                put("end_time", java.time.Instant.now().plusSeconds(secs).toString()); put("selected_time_window", secs)
                            })
                        }
                    })
            }
        }
    }
}

fun channelTypeLabel(c: Channel) = when (c.type) {
    2 -> R.string.voice_channel; 4 -> R.string.category; 5 -> R.string.announcement_channel; 13 -> R.string.stage_channel; 15 -> R.string.forum_channel
    10, 11, 12 -> R.string.tab_threads
    else -> R.string.text_channel
}

@Composable
private fun ChannelMembers(state: State, gid: String, ch: Channel) {
    val nav = LocalNav.current
    val ctx = LocalContext.current
    LaunchedEffect(gid) { if (gid !in state.membersLoaded) runCatching { Session.loadMembers(gid) } }
    val groups = remember(state.members[gid], state.presences, state.guilds[gid], ch) { Sel.channelMembers(state, gid, ch) }
    val canAccess = !ch.isThread && Perm.has(Sel.perms(state, gid, ch), Perm.MANAGE_ROLES)
    val clock = rememberRevealClock()
    LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp)) {
        if (canAccess) item(key = "access") {
            Surface(onClick = { nav.openChannelAccess(ch.id) }, shape = Hud, color = MaterialTheme.colorScheme.surfaceContainerHigh, modifier = Modifier.fillMaxWidth()) {
                Row(Modifier.heightIn(min = 56.dp).padding(horizontal = 16.dp), verticalAlignment = Alignment.CenterVertically) {
                    Ic(R.drawable.ms_settings, null)
                    Text(s(R.string.manage_channel_access), Modifier.weight(1f).padding(start = 16.dp), style = MaterialTheme.typography.titleSmall)
                    Ic(R.drawable.ms_chevron_right, null)
                }
            }
        }
        for (grp in groups) {
            val label = grp.role?.name ?: ctx.getString(when (grp.key) { "offline" -> R.string.offline; "bots" -> R.string.bots; else -> R.string.online })
            item(key = "h" + grp.key) {
                SectionHeader(ctx.getString(R.string.group_count, label, grp.members.size), Modifier.padding(start = 4.dp, end = 4.dp, top = 18.dp, bottom = 6.dp),
                    color = grp.role?.color?.takeIf { it != 0 }?.let { Color(0xFF000000 or it.toLong()) } ?: MaterialTheme.colorScheme.onSurfaceVariant)
            }
            item(key = "g" + grp.key) {
                Surface(shape = Hud, color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.animateItem()) {
                    Column { grp.members.forEachIndexed { i, m -> Box(Modifier.reveal(i, clock)) { MemberRow(state, gid, m) { m.user?.let { nav.openProfile(it.id, gid) } } } } }
                }
            }
        }
    }
}

@Composable
private fun PinsList(state: State, ch: Channel) {
    val ctx = LocalContext.current
    var pins by remember { mutableStateOf<List<Message>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(ch.id) { try { pins = Session.rest.get<List<Message>>("/channels/${ch.id}/pins") } catch (e: Exception) { error = errorText(ctx, e) } }
    val list = pins
    when {
        error != null -> Text(error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
        list == null -> Loading()
        list.isEmpty() -> EmptyState(R.drawable.ms_push_pin, s(R.string.no_pins))
        else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(vertical = 8.dp)) {
            items(list, key = { it.id }) { m -> MessageItem(state, m, true, ch.guildId, onLongPress = {}, onReply = {}, onReact = {}, onAddReaction = {}, onJump = {}, canReply = false) }
        }
    }
}

@Composable
private fun ThreadsList(state: State, ch: Channel) {
    val nav = LocalNav.current
    LaunchedEffect(ch.id) { runCatching { Session.loadArchivedThreads(ch.id) } }
    val threads = state.channels.values.filter { it.parentId == ch.id && it.isThread }.sortedWith { a, b -> cmpId(b.lastMessageId ?: b.id, a.lastMessageId ?: a.id) }
    if (threads.isEmpty()) { EmptyState(R.drawable.ms_forum, s(R.string.no_active_threads_title)); return }
    LazyColumn(Modifier.fillMaxSize()) {
        items(threads, key = { it.id }) { t ->
            ListItem(
                headlineContent = { Text(t.name ?: "", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                supportingContent = {
                    Text(listOfNotNull(LocalContext.current.resources.getQuantityString(R.plurals.thread_messages, t.messageCount, t.messageCount),
                        if (t.threadMetadata?.archived == true) s(R.string.archived) else null).joinToString(" · "))
                },
                leadingContent = { Ic(R.drawable.ms_forum, null) },
                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                modifier = Modifier.clickable { nav.openChannel(t.id) },
            )
        }
    }
}

/** Permission overwrites of a channel: add a role or member, set allow / neutral / deny per permission, remove. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelAccessScreen(channelId: String) {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val nav = LocalNav.current
    val ch = state.channels[channelId]
    val g = ch?.guildId?.let { state.guilds[it] }
    val me = state.me
    if (ch == null || g == null || me == null) { Loading(); return }
    val myMember = Sel.myMember(state, g.id)
    val chPerms = Sel.perms(state, g.id, ch)
    var editing by remember { mutableStateOf<Overwrite?>(null) }
    var adding by remember { mutableStateOf(false) }
    fun canEdit(o: Overwrite) = Perm.canEditOverwrite(g, me.id, myMember, chPerms, o.id, o.type, state.members[g.id]?.get(o.id))
    fun targetName(o: Overwrite) = if (o.type == 0) g.roles.firstOrNull { it.id == o.id }?.name?.let { if (o.id == g.id) "@everyone" else it } ?: o.id else Sel.memberName(state, g.id, o.id)
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Column { Text(s(R.string.manage_channel_access).uppercase(), maxLines = 1, overflow = TextOverflow.Ellipsis); Text("#" + (ch.name ?: ""), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } },
                navigationIcon = { IconButton(nav::back) { Ic(R.drawable.ms_arrow_back, s(R.string.back)) } },
                actions = { IconButton({ adding = true }) { Ic(R.drawable.ms_add, s(R.string.add_role_or_member)) } },
            )
        },
    ) { pad ->
        val list = ch.permissionOverwrites.sortedWith(compareBy({ it.type }, { o -> -(g.roles.firstOrNull { it.id == o.id }?.position ?: 0) }))
        LazyColumn(Modifier.padding(pad).fillMaxSize()) {
            item { Text(s(R.string.channel_access_hint), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp)) }
            items(list, key = { it.id }) { o ->
                val ok = canEdit(o)
                ListItem(
                    headlineContent = { Text(targetName(o)) },
                    supportingContent = { Text(s(R.string.overwrite_summary, java.lang.Long.bitCount(Perm.bits(o.allow)), java.lang.Long.bitCount(Perm.bits(o.deny)))) },
                    leadingContent = {
                        if (o.type == 1) Avatar(state.users[o.id], 36.dp)
                        else RoleDot(g.roles.firstOrNull { it.id == o.id }?.color ?: 0)
                    },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    modifier = Modifier.alpha(if (ok) 1f else 0.5f).clickable(enabled = ok) { editing = o },
                )
            }
        }
    }
    if (adding) {
        val taken = ch.permissionOverwrites.map { it.id }.toSet()
        val roles = g.roles.filter { it.id !in taken && Perm.canEditOverwrite(g, me.id, myMember, chPerms, it.id, 0) }.sortedByDescending { it.position }
        val members = state.members[g.id].orEmpty().values.mapNotNull { m -> m.user?.id?.takeIf { it !in taken && Perm.canEditOverwrite(g, me.id, myMember, chPerms, it, 1, m) } }
        TargetPicker(state, g.id, roles, members, close = { adding = false }) { id, type -> adding = false; editing = Overwrite(id, type) }
    }
    editing?.let { o -> OverwriteEditor(ch, o, targetName(o), Perm.grantable(g, me.id, myMember, chPerms), { Perm.keepsChannelAccess(g, me.id, myMember, ch, it) }) { editing = null } }
}

@Composable
fun RoleDot(color: Int, size: androidx.compose.ui.unit.Dp = 12.dp) =
    Box(Modifier.size(size).clip(androidx.compose.foundation.shape.CircleShape).background(if (color != 0) Color(0xFF000000 or color.toLong()) else MaterialTheme.colorScheme.outline))

/** Pick a role (from [roles]) or a member (from [members], searchable). */
@Composable
private fun TargetPicker(state: State, gid: String, roles: List<io.github.mrciller.cillhub.data.Role>, members: List<String>, close: () -> Unit, pick: (String, Int) -> Unit) {
    var q by rememberSaveable { mutableStateOf("") }
    val shown = members.filter { q.isBlank() || Sel.memberName(state, gid, it).contains(q.trim(), ignoreCase = true) || state.users[it]?.username?.contains(q.trim(), true) == true }
        .sortedBy { Sel.memberName(state, gid, it).lowercase() }.take(50)
    AlertDialog(
        onDismissRequest = close,
        title = { Text(s(R.string.add_role_or_member)) },
        text = {
            LazyColumn(Modifier.heightIn(max = 420.dp)) {
                item { Text(s(R.string.roles), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(vertical = 4.dp)) }
                items(roles, key = { "r" + it.id }) { r ->
                    ListItem(headlineContent = { Text(if (r.id == gid) "@everyone" else r.name) }, leadingContent = { RoleDot(r.color) },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent), modifier = Modifier.clickable { pick(r.id, 0) })
                }
                item {
                    Text(s(R.string.members), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
                    OutlinedTextField(q, { q = it }, placeholder = { Text(s(R.string.search_members)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                }
                items(shown, key = { "m$it" }) { id ->
                    ListItem(headlineContent = { Text(Sel.memberName(state, gid, id)) }, leadingContent = { Avatar(state.users[id], 32.dp) },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent), modifier = Modifier.clickable { pick(id, 1) })
                }
            }
        },
        confirmButton = { TextButton(close) { Text(s(R.string.cancel)) } },
    )
}

/** Allow / neutral / deny for every channel permission; bits the actor does not hold stay locked (the server refuses them). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun OverwriteEditor(ch: Channel, o: Overwrite, name: String, grantable: Long, keepsAccess: (List<Overwrite>) -> Boolean, close: () -> Unit) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var allow by remember { mutableLongStateOf(Perm.bits(o.allow)) }
    var deny by remember { mutableLongStateOf(Perm.bits(o.deny)) }
    var error by remember { mutableStateOf<String?>(null) }
    val existing = ch.permissionOverwrites.any { it.id == o.id }
    fun run(f: suspend () -> Unit) = scope.launch { try { f(); close() } catch (e: Exception) { error = errorText(ctx, e) } }
    val others = ch.permissionOverwrites.filter { it.id != o.id }
    // refused before the request: the server would let the actor lock themselves out of the channel
    fun save(next: List<Overwrite>, f: suspend () -> Unit) { if (keepsAccess(next)) run(f) else error = ctx.getString(R.string.self_lockout) }
    ModalBottomSheet(close) {
        LazyColumn(Modifier.fillMaxWidth(), contentPadding = PaddingValues(bottom = 24.dp)) {
            item {
                Text(name, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold, modifier = Modifier.padding(horizontal = 16.dp))
                Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    FilledTonalButton({
                        save(others + Overwrite(o.id, o.type, allow.toString(), deny.toString())) {
                            Session.rest.request("PUT", "/channels/${ch.id}/permissions/${o.id}", buildJsonObject {
                                put("type", o.type); put("allow", allow.toString()); put("deny", deny.toString())
                            })
                        }
                    }, shape = MaterialTheme.shapes.small) { Text(s(R.string.save)) }
                    if (existing) TextButton({ save(others) { Session.rest.request("DELETE", "/channels/${ch.id}/permissions/${o.id}") } }) {
                        Text(s(R.string.remove_overwrite), color = MaterialTheme.colorScheme.error)
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(horizontal = 16.dp)) }
            }
            for ((group, bits) in PERM_GROUPS) {
                val channelBits = bits.filter { it.first !in GUILD_ONLY }
                if (channelBits.isEmpty()) continue
                item(key = "g$group") { Text(s(group), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() }) }
                items(channelBits, key = { it.first }) { (bit, label) ->
                    val value = if (Perm.has(allow, bit)) 1 else if (Perm.has(deny, bit)) -1 else 0
                    val enabled = Perm.has(grantable, bit)
                    Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                        Text(s(label), Modifier.weight(1f), color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
                        SingleChoiceSegmentedButtonRow {
                            listOf(-1 to R.string.perm_deny, 0 to R.string.perm_inherit, 1 to R.string.perm_allow).forEachIndexed { i, (v, desc) ->
                                val d = s(desc)
                                SegmentedButton(
                                    selected = value == v, enabled = enabled,
                                    onClick = {
                                        allow = if (v == 1) allow or bit else allow and bit.inv()
                                        deny = if (v == -1) deny or bit else deny and bit.inv()
                                    },
                                    shape = SegmentedButtonDefaults.itemShape(i, 3),
                                    icon = {},
                                    modifier = Modifier.semantics { contentDescription = d },
                                ) { Text(when (v) { -1 -> "✕"; 0 -> "/"; else -> "✓" }) }
                            }
                        }
                    }
                }
            }
        }
    }
}
