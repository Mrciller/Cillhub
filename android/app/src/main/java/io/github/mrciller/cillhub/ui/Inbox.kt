package io.github.mrciller.cillhub.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import io.github.mrciller.cillhub.data.isThread
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.Message
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.isPrivate
import kotlinx.coroutines.launch

/** Inbox: recent mentions (pull to refresh) and unread conversations with "Mark all as read". */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun InboxScreen() {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val nav = LocalNav.current
    val ctx = LocalContext.current
    var tab by rememberSaveable { mutableStateOf(0) }
    var mentions by remember { mutableStateOf<List<Message>?>(null) }
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun load() = scope.launch { refreshing = true; try { mentions = Session.mentions(); error = null } catch (e: Exception) { error = errorText(ctx, e) }; refreshing = false }
    LaunchedEffect(Unit) { load() }
    val unread = Sel.unreadChannels(state)
    Scaffold(topBar = {
        Column {
            TopAppBar(title = { Text(s(R.string.tab_inbox).uppercase()) }, actions = {
                if (tab == 1 && unread.isNotEmpty()) TextButton({ scope.launch { runCatching { Session.ackBulk(unread) }.onFailure { error = errorText(ctx, it) } } }, shape = MaterialTheme.shapes.small) { Text(s(R.string.mark_all_read)) }
            })
            PrimaryTabRow(tab) {
                Tab(tab == 0, { tab = 0 }, unselectedContentColor = MaterialTheme.colorScheme.onSurfaceVariant, text = { Text(s(R.string.mentions_tab)) })
                Tab(tab == 1, { tab = 1 }, unselectedContentColor = MaterialTheme.colorScheme.onSurfaceVariant, text = { Text(if (unread.isEmpty()) s(R.string.unreads_tab) else "${s(R.string.unreads_tab)} (${unread.size})") })
                Tab(tab == 2, { tab = 2 }, unselectedContentColor = MaterialTheme.colorScheme.onSurfaceVariant, text = { Text(s(R.string.active_threads_tab)) })
            }
        }
    }) { pad ->
        val activeThreads = remember(state.channels) {
            state.channels.values.filter { (it.isThread || it.type == 11 || it.type == 12) && it.threadMetadata?.archived != true }
                .sortedByDescending { it.lastMessageId ?: it.id }
        }

        when (tab) {
            0 -> PullToRefreshBox(refreshing, { load() }, Modifier.padding(pad).fillMaxSize()) {
                val list = mentions
                when {
                    error != null && list == null -> EmptyState(R.drawable.ms_error, error!!)
                    list == null -> Loading()
                    list.isEmpty() -> EmptyState(R.drawable.ms_alternate_email, s(R.string.no_mentions_title), s(R.string.no_mentions_text))
                    else -> LazyColumn(Modifier.fillMaxSize()) {
                        items(list, key = { it.id }) { m ->
                            val ch = state.channels[m.channelId]
                            val where = ch?.let { c -> if (isPrivate(c)) Sel.privateName(state, c) else "#${c.name}" + (c.guildId?.let { state.guilds[it]?.name }?.let { " · $it" } ?: "") } ?: ""
                            Column(Modifier.fillMaxWidth().clickable { nav.openChannel(m.channelId) }.padding(horizontal = 16.dp, vertical = 12.dp)) {
                                Text(where, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                Row(Modifier.padding(top = 6.dp), verticalAlignment = Alignment.Top) {
                                    Avatar(state.users[m.author.id] ?: m.author, 32.dp)
                                    Spacer(Modifier.width(10.dp))
                                    Column(Modifier.weight(1f)) {
                                        Row { Text(Sel.memberName(state, m.guildId, m.author.id), fontWeight = FontWeight.SemiBold); Spacer(Modifier.width(8.dp)); Text(messageTime(ctx, m.timestamp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                        MarkdownText(m.content.take(500), state, m.guildId, style = MaterialTheme.typography.bodyMedium)
                                    }
                                }
                            }
                            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                        }
                    }
                }
            }
            1 -> {
                if (unread.isEmpty()) EmptyState(R.drawable.ms_done_all, s(R.string.all_caught_up), modifier = Modifier.padding(pad))
                else LazyColumn(Modifier.padding(pad).fillMaxSize()) {
                    items(unread, key = { it.id }) { c ->
                        if (isPrivate(c)) DmRow(state, c, false) { nav.openChannel(c.id) }
                        else ListItem(
                            headlineContent = { Text("#" + (c.name ?: ""), fontWeight = FontWeight.SemiBold) },
                            supportingContent = { Text(c.guildId?.let { state.guilds[it]?.name } ?: "") },
                            leadingContent = { c.guildId?.let { state.guilds[it] }?.let { g -> Picture(guildIconUrl(g), g.name, g.id, 40.dp, MaterialTheme.shapes.medium) } },
                            trailingContent = { CountBadge(Sel.mentions(state, c.id)) },
                            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                            modifier = Modifier.clickable { nav.openChannel(c.id) },
                        )
                    }
                }
            }
            2 -> {
                if (activeThreads.isEmpty()) EmptyState(R.drawable.ms_forum, s(R.string.no_active_threads_title), s(R.string.no_active_threads_text), modifier = Modifier.padding(pad))
                else LazyColumn(Modifier.padding(pad).fillMaxSize()) {
                    items(activeThreads, key = { it.id }) { t ->
                        val parent = t.parentId?.let { state.channels[it] }
                        val guild = t.guildId?.let { state.guilds[it] }
                        val sub = buildString {
                            if (parent != null) append("#${parent.name}")
                            if (guild != null) append(" · ${guild.name}")
                            if ((t.messageCount ?: 0) > 0) append(" · ${t.messageCount} msgs")
                        }
                        ListItem(
                            headlineContent = {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    if (t.solvedMessageId != null) {
                                        Text("✓ ", color = LocalExtra.current.online, fontWeight = FontWeight.Bold)
                                    }
                                    Text(t.name ?: "", fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                }
                            },
                            supportingContent = { Text(sub, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                            leadingContent = {
                                Box(
                                    Modifier.size(40.dp).clip(MaterialTheme.shapes.medium).background(MaterialTheme.colorScheme.surfaceContainerHigh),
                                    contentAlignment = Alignment.Center,
                                ) {
                                    Ic(if (t.solvedMessageId != null) R.drawable.ms_check else R.drawable.ms_forum, null, tint = if (t.solvedMessageId != null) LocalExtra.current.online else MaterialTheme.colorScheme.primary)
                                }
                            },
                            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                            modifier = Modifier.clickable { nav.openChannel(t.id) },
                        )
                    }
                }
            }
        }
    }
}
