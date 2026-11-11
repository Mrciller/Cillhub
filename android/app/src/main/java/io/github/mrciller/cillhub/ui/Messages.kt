package io.github.mrciller.cillhub.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.Channel
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.State
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** Messages tab: a phone-first conversation list (search, last message and time), a Friends card on top,
 *  Add Friend in the top bar and a New Message button. On large screens the conversation beside it. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MessagesScreen(detail: String?) {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val nav = LocalNav.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val snack = remember { SnackbarHostState() }
    var query by rememberSaveable { mutableStateOf("") }
    var adding by rememberSaveable { mutableStateOf(false) }
    var grouping by rememberSaveable { mutableStateOf(false) }
    val allDms = Sel.privateChannels(state)
    val q = query.trim().lowercase()
    val dms = if (q.isEmpty()) allDms else allDms.filter { c ->
        Sel.privateName(state, c).lowercase().contains(q) || c.recipients.any { (state.users[it.id] ?: it).username.lowercase().contains(q) }
    }
    val pending = state.relationships.values.count { it.type == 3 }
    val friends = state.relationships.values.filter { it.type == 1 }.sortedBy { (state.users[it.id] ?: it.user)?.displayName?.lowercase() }
    val online = friends.count { Sel.presence(state, it.id) != "offline" }
    Row(Modifier.fillMaxSize()) {
        Box((if (nav.twoPane) Modifier.width(360.dp) else Modifier.weight(1f)).fillMaxHeight().background(MaterialTheme.colorScheme.surfaceContainerLow)) {
            Column(Modifier.fillMaxSize()) {
                TopAppBar(
                    title = { Text(s(R.string.tab_messages).uppercase()) },
                    actions = {
                        IconButton({ adding = true }) { Ic(R.drawable.ms_person_add, s(R.string.add_friend)) }
                    },
                    colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surfaceContainerLow),
                    windowInsets = TopAppBarDefaults.windowInsets.only(WindowInsetsSides.Top + if (nav.twoPane) WindowInsetsSides.Start else WindowInsetsSides.Horizontal),
                )
                val clock = rememberRevealClock()
                LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(bottom = 96.dp)) {
                    item(key = "search") {
                        OutlinedTextField(
                            value = query,
                            onValueChange = { query = it },
                            placeholder = { Text(s(R.string.search_conversations)) },
                            singleLine = true,
                            shape = MaterialTheme.shapes.small,
                            trailingIcon = if (query.isNotEmpty()) { { IconButton({ query = "" }) { Ic(R.drawable.ms_close, s(R.string.close)) } } } else null,
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 4.dp),
                        )
                    }
                    item(key = "friends") {
                        Surface(
                            shape = Hud,
                            color = MaterialTheme.colorScheme.surfaceContainer,
                            border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f)),
                            modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp).clip(Hud).clickable(onClick = nav::openFriends),
                        ) {
                            ListItem(
                                headlineContent = { Text(s(R.string.friends), fontWeight = FontWeight.SemiBold) },
                                supportingContent = {
                                    Text(
                                        if (pending > 0) ctx.resources.getQuantityString(R.plurals.pending_requests, pending, pending)
                                        else ctx.getString(R.string.friends_online_summary, online, friends.size),
                                        color = if (pending > 0) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                },
                                leadingContent = { Box(Modifier.size(44.dp).clip(MaterialTheme.shapes.large).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) { Ic(R.drawable.ms_group, null, tint = MaterialTheme.colorScheme.onPrimaryContainer) } },
                                trailingContent = {
                                    Row(verticalAlignment = Alignment.CenterVertically) {
                                        CountBadge(pending)
                                        Ic(R.drawable.ms_chevron_right, null, tint = MaterialTheme.colorScheme.onSurfaceVariant)
                                    }
                                },
                                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                            )
                        }
                    }
                    if (allDms.isNotEmpty()) item(key = "hdr") {
                        SectionHeader(s(R.string.direct_messages_header), Modifier.padding(start = 20.dp, end = 20.dp, top = 8.dp, bottom = 4.dp))
                    }
                    if (allDms.isEmpty()) item {
                        Column(Modifier.fillMaxWidth().heightIn(min = 320.dp), horizontalAlignment = Alignment.CenterHorizontally) {
                            EmptyState(R.drawable.ms_chat, s(R.string.no_dms_title), s(R.string.no_dms_text), Modifier.heightIn(min = 240.dp, max = 300.dp))
                            Button(nav::openFriends, shape = MaterialTheme.shapes.small) { Ic(R.drawable.ms_group, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(s(R.string.friends)) }
                        }
                    }
                    itemsIndexed(dms, key = { _, it -> it.id }) { i, c -> Box(Modifier.animateItem().reveal(i, clock)) { DmRow(state, c, c.id == detail) { nav.openChannel(c.id) } } }
                }
            }
            FloatingActionButton(
                onClick = { if (friends.isEmpty()) adding = true else grouping = true },
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
                modifier = Modifier.align(Alignment.BottomEnd).padding(16.dp),
            ) { Ic(R.drawable.ms_edit, s(R.string.new_group)) }
            SnackbarHost(snack, Modifier.align(Alignment.BottomCenter))
        }
        if (nav.twoPane) androidx.compose.material3.VerticalDivider(color = MaterialTheme.colorScheme.outlineVariant)
        if (nav.twoPane) Box(Modifier.weight(1f).fillMaxHeight().background(MaterialTheme.colorScheme.surfaceContainer)) {
            if (detail != null && state.channels.containsKey(detail)) ChatScreen(detail, showBack = false)
            else EmptyState(R.drawable.ms_chat, s(R.string.pick_conversation))
        }
    }
    if (adding) AddFriendDialog(onDismiss = { adding = false }) { name ->
        adding = false
        scope.launch {
            try { Session.addFriend(name); snack.showSnackbar(ctx.getString(R.string.request_sent)) }
            catch (e: Exception) { snack.showSnackbar(errorText(ctx, e)) }
        }
    }
    if (grouping) NewGroupDmDialog(friends, state, onDismiss = { grouping = false }) { ids ->
        grouping = false
        scope.launch {
            try {
                // one person: their 1:1 conversation; more: a group
                val c = if (ids.size == 1) Session.openDm(ids[0]) else Session.createGroupDm(ids)
                nav.openChannel(c.id)
            } catch (e: Exception) { snack.showSnackbar(errorText(ctx, e)) }
        }
    }
}

private const val SNOWFLAKE_EPOCH = 1420070400000L
private val dmTimeFmt = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT)
private val dmDateFmt = DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT)

/** "10:32" today, "Yesterday" or a short date, from a message id. */
private fun dmTime(ctx: android.content.Context, id: String?): String {
    val ms = id?.toLongOrNull()?.let { (it ushr 22) + SNOWFLAKE_EPOCH } ?: return ""
    val t = Instant.ofEpochMilli(ms).atZone(ZoneId.systemDefault())
    val today = LocalDate.now()
    return when (t.toLocalDate()) {
        today -> t.format(dmTimeFmt)
        today.minusDays(1) -> ctx.getString(R.string.yesterday)
        else -> t.format(dmDateFmt)
    }
}

@Composable
fun DmRow(state: State, c: Channel, selected: Boolean, onClick: () -> Unit) {
    val unread = Sel.isUnread(state, c)
    val mentions = Sel.mentions(state, c.id)
    val draft = state.drafts[c.id]?.takeIf { it.isNotBlank() }
    val other = if (c.type == 1) c.recipients.firstOrNull()?.let { state.users[it.id] ?: it } else null
    val name = Sel.privateName(state, c)
    val ctx = LocalContext.current
    val status = other?.let { Sel.presence(state, it.id) }
    val custom = other?.let { Sel.customStatus(state, it.id)?.state }
    val loaded = state.messages[c.id]
    val last = loaded?.firstOrNull { it.id == c.lastMessageId } ?: loaded?.lastOrNull { !it.pending }
    val preview: String? = when {
        draft != null -> "✎ $draft"
        last != null -> {
            val who = if (last.author.id == state.me?.id) ctx.getString(R.string.you_prefix) else if (c.type == 3) "${last.author.displayName}: " else ""
            val body = last.content.ifBlank { if (last.attachments.isNotEmpty()) ctx.getString(R.string.attachment) else if (last.poll != null) "📊" else "" }
            (who + body).replace('\n', ' ').takeIf { body.isNotBlank() }
        }
        c.type == 3 -> ctx.resources.getQuantityString(R.plurals.members_count, c.recipients.size + 1, c.recipients.size + 1)
        !custom.isNullOrBlank() -> custom
        status != null -> ctx.getString(presenceLabel(status))
        else -> null
    }
    val time = dmTime(ctx, c.lastMessageId)
    ListItem(
        headlineContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(name, maxLines = 1, overflow = TextOverflow.Ellipsis, fontWeight = if (unread) FontWeight.Bold else FontWeight.SemiBold, modifier = Modifier.weight(1f))
                if (time.isNotEmpty()) Text(time, style = MaterialTheme.typography.labelSmall, color = if (unread) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
            }
        },
        supportingContent = preview?.let { p ->
            {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    Text(
                        p, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f),
                        color = if (draft != null) MaterialTheme.colorScheme.primary else if (unread) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
                        fontWeight = if (unread) FontWeight.Medium else FontWeight.Normal,
                    )
                    if (mentions > 0) CountBadge(mentions) else if (unread) Box(Modifier.size(10.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary))
                }
            }
        },
        leadingContent = {
            if (other != null) Avatar(other, 48.dp, status)
            else Picture(groupIconUrl(c), name, c.id, 48.dp)
        },
        trailingContent = if (preview == null && (mentions > 0 || unread)) { { if (mentions > 0) CountBadge(mentions) else Box(Modifier.size(10.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary)) } } else null,
        colors = ListItemDefaults.colors(containerColor = if (selected) MaterialTheme.colorScheme.secondaryContainer else Color.Transparent),
        modifier = Modifier.padding(horizontal = 8.dp).clip(MaterialTheme.shapes.extraSmall).clickable(onClick = onClick).semantics(mergeDescendants = true) {
            this.selected = selected
            stateDescription = listOfNotNull(
                status?.let { ctx.getString(presenceLabel(it)) },
                if (mentions > 0) ctx.resources.getQuantityString(R.plurals.mentions, mentions, mentions) else if (unread) ctx.getString(R.string.unread) else null,
            ).joinToString(", ")
        },
    )
}
