package io.github.mrciller.cillhub.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.Channel
import io.github.mrciller.cillhub.data.ForumTag
import io.github.mrciller.cillhub.data.Perm
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.cmpId
import kotlinx.coroutines.launch

/**
 * 100% Native Jetpack Compose Forum Screen (Task 6.3):
 * Replaces the old WebView wrapper. Supports post filtering by tags, solved/unsolved filter,
 * pinned forum posts, native creation, and opening threads in ChatScreen.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ForumScreen(channelId: String, showBack: Boolean = true) {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val ch = state.channels[channelId]
    val nav = LocalNav.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()

    if (ch == null) {
        EmptyState(R.drawable.ms_forum, s(R.string.channel_unavailable))
        return
    }

    LaunchedEffect(channelId) {
        runCatching { Session.loadArchivedThreads(channelId, "public") }
    }

    var search by rememberSaveable { mutableStateOf("") }
    val selectedTags = remember { mutableStateListOf<String>() }
    var solvedFilter by rememberSaveable { mutableStateOf("all") } // all, solved, unsolved
    var sortLatest by rememberSaveable { mutableStateOf(ch.defaultSortOrder != 1) } // true: latest activity, false: creation time
    var newPostOpen by rememberSaveable { mutableStateOf(false) }

    val perms = Sel.perms(state, ch.guildId, ch)
    val canPost = Perm.has(perms, Perm.SEND_MESSAGES)

    val posts = remember(state.channels, search, selectedTags.toList(), solvedFilter, sortLatest) {
        state.channels.values
            .filter { it.parentId == channelId }
            .filter { p ->
                val q = search.trim().lowercase()
                if (q.isNotEmpty() && p.name?.lowercase()?.contains(q) != true) return@filter false
                if (selectedTags.isNotEmpty() && !p.appliedTags.any { it in selectedTags }) return@filter false
                if (solvedFilter == "solved" && p.solvedMessageId == null) return@filter false
                if (solvedFilter == "unsolved" && p.solvedMessageId != null) return@filter false
                true
            }
            .sortedWith { a, b ->
                val aPinned = (a.flags and 2) != 0
                val bPinned = (b.flags and 2) != 0
                if (aPinned != bPinned) {
                    if (bPinned) 1 else -1
                } else if (sortLatest) {
                    cmpId(b.lastMessageId ?: b.id, a.lastMessageId ?: a.id)
                } else {
                    cmpId(b.id, a.id)
                }
            }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    if (showBack) IconButton(nav::back) { Ic(R.drawable.ms_arrow_back, s(R.string.back)) }
                },
                title = {
                    Column {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Ic(R.drawable.ms_forum, null, Modifier.size(20.dp), MaterialTheme.colorScheme.onSurfaceVariant)
                            Spacer(Modifier.width(8.dp))
                            Text(ch.name ?: "", maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.titleMedium, modifier = Modifier.semantics { heading() })
                        }
                        if (!ch.topic.isNullOrBlank()) {
                            Text(ch.topic, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                },
                actions = {
                    IconButton({ sortLatest = !sortLatest }) {
                        Ic(R.drawable.ms_refresh, if (sortLatest) s(R.string.forum_sort_activity) else s(R.string.forum_sort_creation))
                    }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surfaceContainer),
            )
        },
        floatingActionButton = {
            if (canPost) {
                FloatingActionButton(
                    onClick = { newPostOpen = true },
                    shape = Hud,
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ) {
                    Ic(R.drawable.ms_add, s(R.string.forum_new_post))
                }
            }
        },
        containerColor = MaterialTheme.colorScheme.surfaceContainerLow,
    ) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            // Search & Filter Toolbar
            Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer).padding(horizontal = 12.dp, vertical = 6.dp)) {
                OutlinedTextField(
                    value = search,
                    onValueChange = { search = it },
                    placeholder = { Text(s(R.string.forum_search_hint), style = MaterialTheme.typography.bodyMedium) },
                    singleLine = true,
                    shape = MaterialTheme.shapes.medium,
                    modifier = Modifier.fillMaxWidth().height(48.dp),
                    trailingIcon = {
                        if (search.isNotEmpty()) {
                            IconButton({ search = "" }) { Ic(R.drawable.ms_close, s(R.string.close)) }
                        }
                    },
                )
                Spacer(Modifier.height(6.dp))
                Row(
                    Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    // Solved status filters
                    FilterChip(
                        selected = solvedFilter == "all",
                        onClick = { solvedFilter = "all" },
                        label = { Text(s(R.string.forum_all)) },
                    )
                    FilterChip(
                        selected = solvedFilter == "solved",
                        onClick = { solvedFilter = "solved" },
                        label = { Text("✓ " + s(R.string.forum_solved)) },
                    )
                    FilterChip(
                        selected = solvedFilter == "unsolved",
                        onClick = { solvedFilter = "unsolved" },
                        label = { Text(s(R.string.forum_unsolved)) },
                    )
                    // Forum tags
                    ch.availableTags.forEach { tag ->
                        val isSel = tag.id in selectedTags
                        FilterChip(
                            selected = isSel,
                            onClick = {
                                if (isSel) selectedTags.remove(tag.id) else selectedTags.add(tag.id)
                            },
                            label = { Text(tag.name) },
                        )
                    }
                }
            }
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)

            // Posts List
            if (posts.isEmpty()) {
                EmptyState(
                    R.drawable.ms_forum,
                    s(R.string.forum_no_posts_title),
                    s(R.string.forum_no_posts_text),
                    modifier = Modifier.weight(1f),
                )
            } else {
                LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = androidx.compose.foundation.layout.PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                    items(posts, key = { it.id }) { post ->
                        ForumPostCard(post, ch, state) {
                            nav.openChannel(post.id)
                        }
                    }
                }
            }
        }
    }

    if (newPostOpen) {
        NewPostDialog(
            forum = ch,
            onDismiss = { newPostOpen = false },
            onCreated = { newThread ->
                newPostOpen = false
                nav.openChannel(newThread.id)
            },
        )
    }
}

@Composable
private fun ForumPostCard(post: Channel, forum: Channel, state: io.github.mrciller.cillhub.data.State, onClick: () -> Unit) {
    val author = Sel.memberName(state, forum.guildId, post.ownerId ?: "")
    val isPinned = (post.flags and 2) != 0
    val isSolved = post.solvedMessageId != null
    val msgCount = if (post.totalMessageSent > 0) post.totalMessageSent else post.messageCount
    val appliedTags = forum.availableTags.filter { it.id in post.appliedTags }

    Surface(
        onClick = onClick,
        color = MaterialTheme.colorScheme.surfaceContainer,
        shape = MaterialTheme.shapes.medium,
        border = androidx.compose.foundation.BorderStroke(1.dp, if (isSolved) LocalExtra.current.online.copy(alpha = 0.5f) else MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp)) {
            // Badges & Tags Row
            if (isPinned || isSolved || appliedTags.isNotEmpty()) {
                Row(
                    Modifier.fillMaxWidth().padding(bottom = 6.dp),
                    horizontalArrangement = Arrangement.spacedBy(6.dp),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    if (isPinned) {
                        Surface(
                            color = MaterialTheme.colorScheme.secondaryContainer,
                            shape = MaterialTheme.shapes.extraSmall,
                        ) {
                            Row(Modifier.padding(horizontal = 6.dp, vertical = 2.dp), verticalAlignment = Alignment.CenterVertically) {
                                Ic(R.drawable.ms_push_pin, s(R.string.forum_pinned), Modifier.size(12.dp), MaterialTheme.colorScheme.primary)
                                Spacer(Modifier.width(3.dp))
                                Text(s(R.string.forum_pinned), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.primary)
                            }
                        }
                    }
                    if (isSolved) {
                        Surface(
                            color = LocalExtra.current.online.copy(alpha = 0.18f),
                            shape = MaterialTheme.shapes.extraSmall,
                        ) {
                            Text(
                                "✓ " + s(R.string.forum_solved),
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.Bold,
                                color = LocalExtra.current.online,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                    }
                    appliedTags.forEach { tag ->
                        Surface(
                            color = MaterialTheme.colorScheme.surfaceContainerHigh,
                            shape = MaterialTheme.shapes.extraSmall,
                        ) {
                            Text(
                                tag.name,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            )
                        }
                    }
                }
            }

            // Title
            Text(
                post.name ?: s(R.string.untitled_post),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )

            Spacer(Modifier.height(4.dp))

            // Author & Stats Row
            Row(
                Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.SpaceBetween,
            ) {
                Text(
                    author,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false),
                )
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Ic(R.drawable.ms_chat, null, Modifier.size(14.dp), MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.width(4.dp))
                    Text(
                        msgCount.toString(),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (post.threadMetadata?.archived == true) {
                        Spacer(Modifier.width(8.dp))
                        Text(
                            "· " + s(R.string.archived),
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.outline,
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun NewPostDialog(forum: Channel, onDismiss: () -> Unit, onCreated: (Channel) -> Unit) {
    var title by rememberSaveable { mutableStateOf("") }
    var content by rememberSaveable { mutableStateOf("") }
    val tags = remember { mutableStateListOf<String>() }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current

    val needTag = (forum.flags and 16) != 0 && forum.availableTags.isNotEmpty()
    val canSubmit = title.trim().isNotEmpty() && content.trim().isNotEmpty() && (!needTag || tags.isNotEmpty()) && !busy

    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text(s(R.string.forum_new_post), fontWeight = FontWeight.Bold) },
        text = {
            Column(Modifier.fillMaxWidth().heightIn(max = 420.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                OutlinedTextField(
                    value = title,
                    onValueChange = { title = it.take(100) },
                    label = { Text(s(R.string.forum_post_title)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                OutlinedTextField(
                    value = content,
                    onValueChange = { content = it.take(2000) },
                    label = { Text(s(R.string.forum_post_message)) },
                    minLines = 3,
                    maxLines = 6,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (forum.availableTags.isNotEmpty()) {
                    Text(if (needTag) s(R.string.tags_required) else s(R.string.tags), style = MaterialTheme.typography.labelMedium)
                    Row(
                        Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()),
                        horizontalArrangement = Arrangement.spacedBy(6.dp),
                    ) {
                        forum.availableTags.forEach { tag ->
                            val sel = tag.id in tags
                            FilterChip(
                                selected = sel,
                                onClick = { if (sel) tags.remove(tag.id) else tags.add(tag.id) },
                                label = { Text(tag.name) },
                            )
                        }
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
            }
        },
        confirmButton = {
            Button(
                onClick = {
                    busy = true
                    error = null
                    scope.launch {
                        try {
                            val th = Session.startForumPost(forum.id, title.trim(), content.trim(), tags.toList(), forum.defaultAutoArchiveDuration)
                            onCreated(th)
                        } catch (e: Exception) {
                            error = errorText(ctx, e)
                            busy = false
                        }
                    }
                },
                enabled = canSubmit,
             shape = Hud) {
                Text(s(R.string.forum_post))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text(s(R.string.cancel)) }
        },
    )
}
