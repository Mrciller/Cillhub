package io.github.mrciller.cillhub.ui

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.safeDrawing
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import io.github.mrciller.cillhub.Config
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.Member
import io.github.mrciller.cillhub.data.Perm
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import androidx.compose.material3.AssistChip
import androidx.compose.material3.InputChip
import io.github.mrciller.cillhub.data.Profile
import io.github.mrciller.cillhub.data.Relationship
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.State
import io.github.mrciller.cillhub.data.User
import kotlinx.coroutines.launch

/** Full-screen image with pinch zoom, pan and double-tap; download from the top bar. */
@Composable
fun ImageViewer(url: String, name: String, close: () -> Unit) {
    var scale by remember { mutableFloatStateOf(1f) }
    var offset by remember { mutableStateOf(Offset.Zero) }
    val ctx = LocalContext.current
    Dialog(close, DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false)) {
        Box(Modifier.fillMaxSize().background(Color.Black)) {
            AsyncImage(
                url, name,
                Modifier.fillMaxSize()
                    .pointerInput(Unit) {
                        detectTransformGestures { _, pan, zoom, _ ->
                            scale = (scale * zoom).coerceIn(1f, 6f)
                            offset = if (scale == 1f) Offset.Zero else offset + pan
                        }
                    }
                    .pointerInput(Unit) { detectTapGestures(onDoubleTap = { if (scale > 1f) { scale = 1f; offset = Offset.Zero } else scale = 2.5f }) }
                    .graphicsLayer { scaleX = scale; scaleY = scale; translationX = offset.x; translationY = offset.y },
                contentScale = ContentScale.Fit,
            )
            Row(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.safeDrawing).padding(4.dp), verticalAlignment = Alignment.CenterVertically) {
                IconButton(close) { Ic(R.drawable.ms_close, s(R.string.close), tint = Color.White) }
                Text(name, color = Color.White, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                IconButton({ download(ctx, url, name) }) { Ic(R.drawable.ms_download, s(R.string.download), tint = Color.White) }
            }
        }
    }
}

/** Profile bottom sheet: banner colour, avatar with status, names, bio, server roles, Message / Call / friend / block actions. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun ProfileSheet(userId: String, guildId: String?, close: () -> Unit) {
    val state by Session.store.state.collectAsStateWithLifecycle()
    var profile by remember { mutableStateOf<Profile?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var confirmRemove by remember { mutableStateOf(false) }
    var dialog by remember { mutableStateOf<String?>(null) }
    val ctx = LocalContext.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    LaunchedEffect(userId) { try { profile = Session.profile(userId, guildId) } catch (e: Exception) { error = errorText(ctx, e) } }
    val user = profile?.user ?: state.users[userId]
    val me = userId == state.me?.id
    val rel = state.relationships[userId]?.type
    ModalBottomSheet(close) {
        Column(Modifier.fillMaxWidth().verticalScroll(androidx.compose.foundation.rememberScrollState()).padding(bottom = 24.dp)) {
            val accent = profile?.userProfile?.accentColor?.let { Color(0xFF000000 or it.toLong()) } ?: MaterialTheme.colorScheme.primaryContainer
            Box(Modifier.fillMaxWidth().height(84.dp).padding(horizontal = 16.dp).clip(RoundedCornerShape(16.dp)).background(accent)) {
                profile?.userProfile?.banner?.let { AsyncImage(Config.cdn("/banners/$userId/$it.png?size=600"), null, Modifier.fillMaxSize(), contentScale = ContentScale.Crop) }
            }
            Box(Modifier.padding(start = 28.dp).offset(y = (-36).dp)) {
                Surface(shape = CircleShape, color = MaterialTheme.colorScheme.surfaceContainerLow) { Avatar(user, 80.dp, Sel.presence(state, userId), Modifier.padding(4.dp)) }
            }
            Column(Modifier.padding(horizontal = 24.dp).offset(y = (-28).dp)) {
                val name = if (guildId != null) Sel.memberName(state, guildId, userId) else user?.displayName ?: ""
                Text(name, style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold, modifier = Modifier.semantics { heading() })
                Text(listOfNotNull(user?.username?.let { "@$it" }, profile?.userProfile?.pronouns?.takeIf { it.isNotBlank() }).joinToString(" · "), color = MaterialTheme.colorScheme.onSurfaceVariant)
                Text(s(presenceLabel(Sel.presence(state, userId))), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                Sel.customStatus(state, userId)?.let { a -> Text(listOfNotNull(a.emoji?.name?.takeIf { a.emoji.id == null }, a.state).joinToString(" "), modifier = Modifier.padding(top = 8.dp)) }
                if (!me) {
                    FlowRow(Modifier.padding(top = 16.dp), horizontalArrangement = Arrangement.spacedBy(8.dp), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                        Button({
                            scope.launch { try { val c = Session.openDm(userId); close(); nav.openChannel(c.id) } catch (e: Exception) { error = errorText(ctx, e) } }
                        }) { Ic(R.drawable.ms_chat, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(s(R.string.message)) }
                        FilledTonalButton({
                            scope.launch { try { val c = Session.openDm(userId); close(); nav.openVoice(c.id, start = !state.calls.containsKey(c.id)) } catch (e: Exception) { error = errorText(ctx, e) } }
                        }) { Ic(R.drawable.ms_call, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(s(R.string.call)) }
                        when (rel) {
                            null -> if (user?.bot != true) FilledTonalButton({ scope.launch { try { Session.addFriend(user?.username ?: return@launch) } catch (e: Exception) { error = errorText(ctx, e) } } }) {
                                Ic(R.drawable.ms_person_add, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(s(R.string.add_friend))
                            }
                            3 -> {
                                FilledTonalButton({ scope.launch { runCatching { Session.acceptFriend(userId) } } }) {
                                    Ic(R.drawable.ms_check, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(s(R.string.accept))
                                }
                                OutlinedButton({ scope.launch { runCatching { Session.removeRelationship(userId) } } }) { Text(s(R.string.decline)) }
                            }
                            4 -> OutlinedButton({ scope.launch { runCatching { Session.removeRelationship(userId) } } }) {
                                Ic(R.drawable.ms_close, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(s(R.string.cancel_request))
                            }
                            1 -> OutlinedButton({ confirmRemove = true }) {
                                Ic(R.drawable.ms_person_remove, null, Modifier.size(18.dp)); Spacer(Modifier.width(6.dp)); Text(s(R.string.remove_friend))
                            }
                            2 -> FilledTonalButton({ scope.launch { runCatching { Session.removeRelationship(userId) } } }) {
                                Text(s(R.string.unblock))
                            }
                            else -> {}
                        }
                        if (rel != 2 && user?.bot != true) {
                            TextButton({ scope.launch { runCatching { Session.blockUser(userId) } } }) {
                                Text(s(R.string.block_user), color = MaterialTheme.colorScheme.error)
                            }
                        }
                    }
                }
                val bio = profile?.guildMember?.let { profile?.userProfile?.bio }?.takeIf { it.isNotBlank() } ?: profile?.userProfile?.bio?.takeIf { it.isNotBlank() }
                if (bio != null) {
                    Text(s(R.string.about_me), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 20.dp, bottom = 4.dp))
                    MarkdownText(bio, state, guildId, style = MaterialTheme.typography.bodyMedium)
                }
                val g = guildId?.let { state.guilds[it] }
                // the store's copy first: it follows GUILD_MEMBER_UPDATE after a role change
                val target = guildId?.let { state.members[it]?.get(userId) } ?: profile?.guildMember
                val meId = state.me?.id ?: ""
                val myM = Sel.myMember(state, guildId)
                val roles = target?.roles.orEmpty().mapNotNull { r -> g?.roles?.firstOrNull { it.id == r } }.sortedByDescending { it.position }
                val assignable = if (g != null && target != null) g.roles.filter { Perm.canAssignRole(g, meId, myM, it) }.map { it.id }.toSet() else emptySet()
                fun act(f: suspend () -> Unit) = scope.launch { try { f(); error = null } catch (e: Exception) { error = errorText(ctx, e) } }
                if (roles.isNotEmpty() || assignable.isNotEmpty()) {
                    Text(s(R.string.roles), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 20.dp, bottom = 4.dp))
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                        for (r in roles) {
                            if (r.id in assignable) InputChip(
                                selected = false,
                                onClick = {
                                    act {
                                        check(!me || Perm.keepsAdmin(g!!, meId, myM, afterMe = myM?.copy(roles = myM.roles - r.id))) { ctx.getString(R.string.self_lockout) }
                                        Session.setMemberRole(guildId!!, userId, r.id, false)
                                    }
                                },
                                label = { Text(r.name) }, leadingIcon = { RoleDot(r.color, 10.dp) },
                                trailingIcon = { Ic(R.drawable.ms_close, s(R.string.remove_role, r.name), Modifier.size(18.dp)) },
                            ) else Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.surfaceContainerHighest) {
                                Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                                    RoleDot(r.color, 10.dp)
                                    Spacer(Modifier.width(6.dp))
                                    Text(r.name, style = MaterialTheme.typography.labelLarge)
                                }
                            }
                        }
                        if (assignable.any { it !in target?.roles.orEmpty() }) AssistChip(
                            onClick = { dialog = "role" }, label = { Text(s(R.string.add_role)) }, leadingIcon = { Ic(R.drawable.ms_add, null, Modifier.size(18.dp)) },
                        )
                    }
                }
                // canModerate never offers moderation on oneself, but the add-role dialog below must open on one's own profile too
                if (g != null && target != null) {
                    val canNick = Perm.canModerate(g, meId, myM, Perm.MANAGE_NICKNAMES, userId, target)
                    val canTimeout = Perm.canTimeout(g, meId, myM, userId, target)
                    val canKick = Perm.canModerate(g, meId, myM, Perm.KICK_MEMBERS, userId, target)
                    val canBan = Perm.canModerate(g, meId, myM, Perm.BAN_MEMBERS, userId, target)
                    if (canNick || canTimeout || canKick || canBan) {
                        Text(s(R.string.moderation), style = MaterialTheme.typography.labelLarge, modifier = Modifier.padding(top = 20.dp, bottom = 4.dp))
                        if (Perm.timedOut(target)) Text(s(R.string.timed_out), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            if (canNick) OutlinedButton({ dialog = "nick" }) { Text(s(R.string.nickname)) }
                            if (canTimeout) OutlinedButton({ dialog = "timeout" }) { Text(s(R.string.timeout)) }
                            if (canKick) OutlinedButton({ dialog = "kick" }) { Text(s(R.string.kick), color = MaterialTheme.colorScheme.error) }
                            if (canBan) OutlinedButton({ dialog = "ban" }) { Text(s(R.string.ban), color = MaterialTheme.colorScheme.error) }
                        }
                    }
                    val path = "/guilds/${g.id}/members/$userId"
                    when (dialog) {
                        "role" -> AlertDialog(
                            onDismissRequest = { dialog = null },
                            title = { Text(s(R.string.add_role)) },
                            text = {
                                LazyColumn {
                                    items(g.roles.filter { it.id in assignable && it.id !in target.roles }.sortedByDescending { it.position }, key = { it.id }) { r ->
                                        ListItem(headlineContent = { Text(r.name) }, leadingContent = { RoleDot(r.color) }, colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                                            modifier = Modifier.clickable { dialog = null; act { Session.setMemberRole(g.id, userId, r.id, true) } })
                                    }
                                }
                            },
                            confirmButton = { TextButton({ dialog = null }) { Text(s(R.string.cancel)) } },
                        )
                        "nick" -> {
                            var nick by remember { mutableStateOf(target.nick ?: "") }
                            AlertDialog(
                                onDismissRequest = { dialog = null },
                                title = { Text(s(R.string.nickname)) },
                                text = { OutlinedTextField(nick, { nick = it.take(32) }, singleLine = true, placeholder = { Text(user?.displayName ?: "") }, modifier = Modifier.fillMaxWidth()) },
                                confirmButton = {
                                    TextButton({
                                        dialog = null
                                        act { Session.rest.request("PATCH", path, buildJsonObject { if (nick.isBlank()) put("nick", JsonNull) else put("nick", nick.trim()) }) }
                                    }) { Text(s(R.string.save)) }
                                },
                                dismissButton = { TextButton({ dialog = null }) { Text(s(R.string.cancel)) } },
                            )
                        }
                        "timeout" -> AlertDialog(
                            onDismissRequest = { dialog = null },
                            title = { Text(s(R.string.timeout)) },
                            text = {
                                Column {
                                    for ((secs, label) in TIMEOUTS) ListItem(headlineContent = { Text(s(label)) }, colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                                        modifier = Modifier.clickable {
                                            dialog = null
                                            act { Session.rest.request("PATCH", path, buildJsonObject { put("communication_disabled_until", java.time.Instant.now().plusSeconds(secs).toString()) }) }
                                        })
                                    if (Perm.timedOut(target)) ListItem(headlineContent = { Text(s(R.string.remove_timeout), color = MaterialTheme.colorScheme.primary) },
                                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                                        modifier = Modifier.clickable { dialog = null; act { Session.rest.request("PATCH", path, buildJsonObject { put("communication_disabled_until", JsonNull) }) } })
                                }
                            },
                            confirmButton = { TextButton({ dialog = null }) { Text(s(R.string.cancel)) } },
                        )
                        "kick", "ban" -> {
                            val ban = dialog == "ban"
                            val name = Sel.memberName(state, g.id, userId)
                            AlertDialog(
                                onDismissRequest = { dialog = null },
                                title = { Text(s(if (ban) R.string.ban else R.string.kick)) },
                                text = { Text(s(if (ban) R.string.ban_confirm else R.string.kick_confirm, name)) },
                                confirmButton = {
                                    TextButton({
                                        dialog = null
                                        act {
                                            if (ban) Session.rest.request("PUT", "/guilds/${g.id}/bans/$userId", buildJsonObject { put("delete_message_seconds", 0) })
                                            else Session.rest.request("DELETE", path)
                                            close()
                                        }
                                    }) { Text(s(if (ban) R.string.ban else R.string.kick), color = MaterialTheme.colorScheme.error) }
                                },
                                dismissButton = { TextButton({ dialog = null }) { Text(s(R.string.cancel)) } },
                            )
                        }
                    }
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(top = 12.dp)) }
            }
        }
    }
    if (confirmRemove) {
        AlertDialog(
            onDismissRequest = { confirmRemove = false },
            title = { Text(s(R.string.remove_friend)) },
            text = { Text(s(R.string.remove_friend_confirm, user?.displayName ?: "")) },
            confirmButton = {
                TextButton({
                    confirmRemove = false
                    scope.launch { runCatching { Session.removeRelationship(userId) } }
                }) { Text(s(R.string.remove_friend), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton({ confirmRemove = false }) { Text(s(R.string.cancel)) } },
        )
    }
}

private val TIMEOUTS = listOf(60L to R.string.timeout_60s, 300L to R.string.timeout_5m, 600L to R.string.timeout_10m, 3600L to R.string.timeout_1h, 86400L to R.string.timeout_1d, 604800L to R.string.timeout_1w)

/** A server's members, online first (pull to refresh). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MembersScreen(guildId: String) {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val nav = LocalNav.current
    val ctx = LocalContext.current
    var refreshing by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    fun load() = scope.launch { refreshing = true; try { Session.loadMembers(guildId); error = null } catch (e: Exception) { error = errorText(ctx, e) }; refreshing = false }
    LaunchedEffect(guildId) { if (guildId !in state.membersLoaded) load() }
    val members = state.members[guildId].orEmpty().values.toList()
    val (online, offline) = members.partition { Sel.presence(state, it.user?.id ?: "") != "offline" }
    val byName = compareBy<Member> { Sel.memberName(state, guildId, it.user?.id ?: "").lowercase() }
    Scaffold(topBar = {
        TopAppBar(title = { Text(s(R.string.members)) }, navigationIcon = { IconButton(nav::back) { Ic(R.drawable.ms_arrow_back, s(R.string.back)) } })
    }) { pad ->
        PullToRefreshBox(refreshing, { load() }, Modifier.padding(pad).fillMaxSize()) {
            LazyColumn(Modifier.fillMaxSize()) {
                error?.let { item { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp)) } }
                for ((label, list) in listOf(R.string.online_count to online.sortedWith(byName), R.string.offline_count to offline.sortedWith(byName))) {
                    if (list.isEmpty()) continue
                    item(key = "h$label") { Text(ctx.getString(label, list.size), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 16.dp, top = 16.dp, bottom = 4.dp).semantics { heading() }) }
                    items(list, key = { it.user?.id ?: "" }) { m -> MemberRow(state, guildId, m) { m.user?.let { nav.openProfile(it.id, guildId) } } }
                }
            }
        }
    }
}

@Composable
fun MemberRow(state: State, guildId: String, m: Member, onClick: () -> Unit) {
    val u = m.user ?: return
    val status = Sel.presence(state, u.id)
    val color = Sel.roleColor(state, guildId, u.id)?.let { Color(0xFF000000 or it.toLong()) }
    val ctx = LocalContext.current
    ListItem(
        headlineContent = {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(Sel.memberName(state, guildId, u.id), color = color ?: MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                UserTags(state.users[u.id] ?: u)
            }
        },
        supportingContent = Sel.customStatus(state, u.id)?.state?.takeIf { it.isNotBlank() }?.let { { Text(it, maxLines = 1, overflow = TextOverflow.Ellipsis) } },
        leadingContent = { Avatar(state.users[u.id] ?: u, 40.dp, status) },
        trailingContent = if (state.guilds[guildId]?.ownerId == u.id) { { Text(s(R.string.owner), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } } else null,
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.clickable(onClick = onClick).semantics(mergeDescendants = true) { stateDescription = ctx.getString(presenceLabel(status)) },
    )
}

/** Friends screen: All (grouped Online/Offline), Online, Pending (Incoming/Outgoing with badge), Blocked, Search bar, Voice Call & Confirmation dialogs. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun FriendsScreen() {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val nav = LocalNav.current
    val ctx = LocalContext.current
    var tab by rememberSaveable { mutableStateOf(0) } // 0 = All, 1 = Online, 2 = Pending, 3 = Blocked
    var query by rememberSaveable { mutableStateOf("") }
    var adding by rememberSaveable { mutableStateOf(false) }
    var grouping by rememberSaveable { mutableStateOf(false) }
    var confirmRemove by remember { mutableStateOf<User?>(null) }
    val snack = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    fun act(f: suspend () -> Unit) = scope.launch { try { f() } catch (e: Exception) { snack.showSnackbar(errorText(ctx, e)) } }

    fun userOf(r: Relationship): User = state.users[r.id] ?: r.user ?: User(r.id)
    fun matches(r: Relationship): Boolean {
        val q = query.trim().lowercase()
        if (q.isEmpty()) return true
        val u = userOf(r)
        return u.displayName.lowercase().contains(q) || u.username.lowercase().contains(q)
    }

    val rels = state.relationships.values.toList()
    val allFriends = rels.filter { it.type == 1 }.sortedBy { userOf(it).displayName.lowercase() }
    val onlineFriends = allFriends.filter { Sel.presence(state, it.id) != "offline" }
    val pendingAll = rels.filter { it.type == 3 || it.type == 4 }
    val incomingCount = pendingAll.count { it.type == 3 }
    val blockedAll = rels.filter { it.type == 2 }.sortedBy { userOf(it).displayName.lowercase() }

    val filteredFriends = allFriends.filter(::matches)
    val (filteredOnline, filteredOffline) = filteredFriends.partition { Sel.presence(state, it.id) != "offline" }
    val filteredPending = pendingAll.filter(::matches)
    val (filteredIncoming, filteredOutgoing) = filteredPending.partition { it.type == 3 }
    val filteredBlocked = blockedAll.filter(::matches)

    Scaffold(
        topBar = {
            Column(Modifier.background(MaterialTheme.colorScheme.surfaceContainerLow)) {
                TopAppBar(
                    title = {
                        Column {
                            Text(s(R.string.friends), fontWeight = FontWeight.Bold)
                            if (allFriends.isNotEmpty()) {
                                Text(
                                    ctx.getString(R.string.friends_online_summary, onlineFriends.size, allFriends.size),
                                    style = MaterialTheme.typography.labelSmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                        }
                    },
                    navigationIcon = { IconButton(nav::back) { Ic(R.drawable.ms_arrow_back, s(R.string.back)) } },
                    actions = {
                        IconButton({ grouping = true }, enabled = allFriends.isNotEmpty()) {
                            Ic(R.drawable.ms_group_add, s(R.string.new_group))
                        }
                        IconButton({ adding = true }) {
                            Ic(R.drawable.ms_person_add, s(R.string.add_friend))
                        }
                    },
                )
                PrimaryTabRow(tab, containerColor = MaterialTheme.colorScheme.surfaceContainerLow) {
                    val tabs = listOf(
                         Triple(R.string.all, allFriends.size, false),
                        Triple(R.string.online, onlineFriends.size, false),
                        Triple(R.string.pending, if (incomingCount > 0) incomingCount else pendingAll.size, incomingCount > 0),
                        Triple(R.string.blocked, blockedAll.size, false),
                    )
                    tabs.forEachIndexed { i, (labelRes, count, highlight) ->
                        Tab(
                            selected = tab == i,
                            onClick = { tab = i },
                            unselectedContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
                            text = {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                                    Text(s(labelRes), maxLines = 1, overflow = TextOverflow.Ellipsis)
                                    if (highlight) {
                                        CountBadge(count)
                                    } else if (count > 0) {
                                        Text(
                                            count.toString(),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = if (tab == i) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                }
                            },
                        )
                    }
                }
                if (rels.isNotEmpty()) {
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        placeholder = { Text(s(R.string.search_friends)) },
                        singleLine = true,
                        shape = RoundedCornerShape(14.dp),
                        trailingIcon = if (query.isNotEmpty()) {
                            { IconButton({ query = "" }) { Ic(R.drawable.ms_close, s(R.string.close)) } }
                        } else null,
                        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
                    )
                }
            }
        },
        floatingActionButton = {
            ExtendedFloatingActionButton(
                text = { Text(s(R.string.add_friend)) },
                icon = { Ic(R.drawable.ms_person_add, null) },
                onClick = { adding = true },
            )
        },
        snackbarHost = { SnackbarHost(snack) },
    ) { pad ->
        val isEmpty = when (tab) {
            0 -> filteredFriends.isEmpty()
            1 -> filteredOnline.isEmpty()
            2 -> filteredPending.isEmpty()
            else -> filteredBlocked.isEmpty()
        }
        if (isEmpty) {
            val emptyMsg = when (tab) {
                1 -> R.string.no_online_friends
                2 -> R.string.no_pending
                3 -> R.string.no_blocked
                else -> R.string.no_friends
            }
            EmptyState(R.drawable.ms_group, s(emptyMsg), modifier = Modifier.padding(pad))
        } else {
            LazyColumn(
                modifier = Modifier.padding(pad).fillMaxSize(),
                contentPadding = PaddingValues(start = 12.dp, end = 12.dp, top = 8.dp, bottom = 96.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                when (tab) {
                    0 -> {
                        if (filteredOnline.isNotEmpty()) {
                            item(key = "hdr_online") {
                                SectionHeader(ctx.getString(R.string.online_count, filteredOnline.size))
                            }
                            items(filteredOnline, key = { "on_${it.id}" }) { r ->
                                FriendCard(state, r, userOf(r), nav, ::act, onConfirmRemove = { confirmRemove = it })
                            }
                        }
                        if (filteredOffline.isNotEmpty()) {
                            item(key = "hdr_offline") {
                                SectionHeader(ctx.getString(R.string.offline_count, filteredOffline.size))
                            }
                            items(filteredOffline, key = { "off_${it.id}" }) { r ->
                                FriendCard(state, r, userOf(r), nav, ::act, onConfirmRemove = { confirmRemove = it })
                            }
                        }
                    }
                    1 -> {
                        item(key = "hdr_online_only") {
                            SectionHeader(ctx.getString(R.string.online_count, filteredOnline.size))
                        }
                        items(filteredOnline, key = { it.id }) { r ->
                            FriendCard(state, r, userOf(r), nav, ::act, onConfirmRemove = { confirmRemove = it })
                        }
                    }
                    2 -> {
                        if (filteredIncoming.isNotEmpty()) {
                            item(key = "hdr_incoming") {
                                SectionHeader(ctx.getString(R.string.incoming_count, filteredIncoming.size))
                            }
                            items(filteredIncoming, key = { "in_${it.id}" }) { r ->
                                FriendCard(state, r, userOf(r), nav, ::act, onConfirmRemove = { confirmRemove = it })
                            }
                        }
                        if (filteredOutgoing.isNotEmpty()) {
                            item(key = "hdr_outgoing") {
                                SectionHeader(ctx.getString(R.string.outgoing_count, filteredOutgoing.size))
                            }
                            items(filteredOutgoing, key = { "out_${it.id}" }) { r ->
                                FriendCard(state, r, userOf(r), nav, ::act, onConfirmRemove = { confirmRemove = it })
                            }
                        }
                    }
                    else -> {
                        items(filteredBlocked, key = { "blk_${it.id}" }) { r ->
                            FriendCard(state, r, userOf(r), nav, ::act, onConfirmRemove = { confirmRemove = it })
                        }
                    }
                }
            }
        }
    }

    if (adding) {
        AddFriendDialog(
            onDismiss = { adding = false },
            onSubmit = { username ->
                adding = false
                act {
                    Session.addFriend(username)
                    snack.showSnackbar(ctx.getString(R.string.request_sent))
                }
            },
        )
    }

    confirmRemove?.let { u ->
        AlertDialog(
            onDismissRequest = { confirmRemove = null },
            title = { Text(s(R.string.remove_friend)) },
            text = { Text(s(R.string.remove_friend_confirm, u.displayName)) },
            confirmButton = {
                TextButton({
                    val id = u.id
                    confirmRemove = null
                    act { Session.removeRelationship(id) }
                }) { Text(s(R.string.remove_friend), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = { TextButton({ confirmRemove = null }) { Text(s(R.string.cancel)) } },
        )
    }

    if (grouping) {
        NewGroupDmDialog(
            friends = allFriends,
            state = state,
            onDismiss = { grouping = false },
            onCreate = { ids ->
                grouping = false
                act {
                    val c = Session.createGroupDm(ids)
                    nav.openChannel(c.id)
                }
            },
        )
    }
}

@Composable
private fun SectionHeader(title: String) {
    Text(
        title.uppercase(),
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.Bold,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(start = 6.dp, top = 8.dp, bottom = 2.dp).semantics { heading() },
    )
}

@Composable
private fun FriendCard(
    state: State,
    r: Relationship,
    u: User,
    nav: Nav,
    act: (suspend () -> Unit) -> Unit,
    onConfirmRemove: (User) -> Unit,
) {
    val status = Sel.presence(state, u.id)
    val custom = Sel.customStatus(state, u.id)?.let { a ->
        listOfNotNull(a.emoji?.name?.takeIf { a.emoji.id == null }, a.state).joinToString(" ").takeIf { it.isNotBlank() }
    }
    val subtitle = when (r.type) {
        2 -> s(R.string.blocked)
        3 -> s(R.string.incoming_request)
        4 -> s(R.string.outgoing_request)
        else -> custom ?: s(presenceLabel(status))
    }
    Surface(
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceContainerLow,
        border = BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.45f)),
        modifier = Modifier.fillMaxWidth().clip(RoundedCornerShape(16.dp)).clickable { nav.openProfile(u.id, null) },
    ) {
        ListItem(
            headlineContent = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(u.displayName, fontWeight = FontWeight.SemiBold, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                    if (u.username.isNotBlank() && !u.username.equals(u.displayName, ignoreCase = true)) {
                        Text("@${u.username}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            },
            supportingContent = {
                Text(subtitle, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.onSurfaceVariant)
            },
            leadingContent = {
                Avatar(u, 44.dp, if (r.type == 1) status else null)
            },
            trailingContent = {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    when (r.type) {
                        1 -> {
                            Surface(
                                shape = CircleShape,
                                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                                modifier = Modifier.minimumInteractiveComponentSize().size(40.dp).clip(CircleShape).clickable {
                                    act { val c = Session.openDm(r.id); nav.openChannel(c.id) }
                                },
                            ) {
                                Box(contentAlignment = Alignment.Center) { Ic(R.drawable.ms_chat, s(R.string.message), Modifier.size(20.dp)) }
                            }
                            Surface(
                                shape = CircleShape,
                                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                                modifier = Modifier.minimumInteractiveComponentSize().size(40.dp).clip(CircleShape).clickable {
                                    act { val c = Session.openDm(r.id); nav.openVoice(c.id, start = !state.calls.containsKey(c.id)) }
                                },
                            ) {
                                Box(contentAlignment = Alignment.Center) { Ic(R.drawable.ms_call, s(R.string.start_call), Modifier.size(20.dp)) }
                            }
                            IconButton({ onConfirmRemove(u) }) {
                                Ic(R.drawable.ms_person_remove, s(R.string.remove_friend), Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
                            }
                        }
                        3 -> {
                            Surface(
                                shape = CircleShape,
                                color = MaterialTheme.colorScheme.primaryContainer,
                                modifier = Modifier.minimumInteractiveComponentSize().size(40.dp).clip(CircleShape).clickable {
                                    act { Session.acceptFriend(r.id) }
                                },
                            ) {
                                Box(contentAlignment = Alignment.Center) { Ic(R.drawable.ms_check, s(R.string.accept), Modifier.size(20.dp), tint = MaterialTheme.colorScheme.onPrimaryContainer) }
                            }
                            Surface(
                                shape = CircleShape,
                                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                                modifier = Modifier.minimumInteractiveComponentSize().size(40.dp).clip(CircleShape).clickable {
                                    act { Session.removeRelationship(r.id) }
                                },
                            ) {
                                Box(contentAlignment = Alignment.Center) { Ic(R.drawable.ms_close, s(R.string.decline), Modifier.size(20.dp), tint = MaterialTheme.colorScheme.error) }
                            }
                        }
                        4 -> {
                            OutlinedButton(
                                onClick = { act { Session.removeRelationship(r.id) } },
                                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                            ) {
                                Text(s(R.string.cancel), style = MaterialTheme.typography.labelMedium)
                            }
                        }
                        2 -> {
                            FilledTonalButton(
                                onClick = { act { Session.removeRelationship(r.id) } },
                                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 4.dp),
                            ) {
                                Text(s(R.string.unblock), style = MaterialTheme.typography.labelMedium)
                            }
                        }
                    }
                }
            },
            colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        )
    }
}

@Composable
fun AddFriendDialog(onDismiss: () -> Unit, onSubmit: (String) -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(s(R.string.add_friend), fontWeight = FontWeight.Bold) },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(10.dp)) {
                Text(s(R.string.add_friend_hint), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it.trimStart('@') },
                    label = { Text(s(R.string.username)) },
                    leadingIcon = { Ic(R.drawable.ms_alternate_email, null) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
            }
        },
        confirmButton = {
            Button(
                onClick = { onSubmit(name.trim()) },
                enabled = name.isNotBlank(),
            ) { Text(s(R.string.send_request)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(s(R.string.cancel)) }
        },
    )
}

@Composable
fun NewGroupDmDialog(
    friends: List<Relationship>,
    state: State,
    onDismiss: () -> Unit,
    onCreate: (List<String>) -> Unit,
) {
    val picked = remember { mutableStateListOf<String>() }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(s(R.string.new_group), fontWeight = FontWeight.Bold) },
        text = {
            if (friends.isEmpty()) {
                Text(s(R.string.no_friends), color = MaterialTheme.colorScheme.onSurfaceVariant)
            } else {
                LazyColumn {
                    items(friends, key = { it.id }) { r ->
                        val u = state.users[r.id] ?: r.user ?: User(r.id)
                        Row(
                            Modifier.fillMaxWidth()
                                .clip(RoundedCornerShape(10.dp))
                                .clickable { if (r.id in picked) picked.remove(r.id) else if (picked.size < 9) picked.add(r.id) }
                                .padding(vertical = 6.dp, horizontal = 4.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Checkbox(r.id in picked, null)
                            Spacer(Modifier.width(8.dp))
                            Avatar(u, 36.dp, Sel.presence(state, u.id))
                            Spacer(Modifier.width(10.dp))
                            Column(Modifier.weight(1f)) {
                                Text(u.displayName, fontWeight = FontWeight.Medium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                                if (u.username.isNotBlank()) {
                                    Text("@${u.username}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                }
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = { onCreate(picked.toList()) },
                enabled = picked.isNotEmpty(),
            ) { Text(s(R.string.create)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(s(R.string.cancel)) }
        },
    )
}
