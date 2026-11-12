package io.github.mrciller.cillhub.ui

import android.util.Base64
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.ui.draw.clip
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.FilterChip
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.MenuAnchorType
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mrciller.cillhub.Config
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.AuditEntry
import io.github.mrciller.cillhub.data.AuditLog
import io.github.mrciller.cillhub.data.Ban
import io.github.mrciller.cillhub.data.Channel
import io.github.mrciller.cillhub.data.Guild
import io.github.mrciller.cillhub.data.GuildEmoji
import io.github.mrciller.cillhub.data.Invite
import io.github.mrciller.cillhub.data.Perm
import io.github.mrciller.cillhub.data.Role
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.State
import io.github.mrciller.cillhub.data.User
import io.github.mrciller.cillhub.data.json
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

/** Permissions in the groups the role and overwrite editors show. */
val PERM_GROUPS: List<Pair<Int, List<Pair<Long, Int>>>> = with(Perm) {
    listOf(
        R.string.perm_group_general to listOf(
            VIEW_CHANNEL to R.string.perm_view_channel, MANAGE_CHANNELS to R.string.perm_manage_channels, MANAGE_ROLES to R.string.perm_manage_roles,
            MANAGE_GUILD_EXPRESSIONS to R.string.perm_manage_expressions, VIEW_AUDIT_LOG to R.string.perm_view_audit_log, MANAGE_WEBHOOKS to R.string.perm_manage_webhooks,
            MANAGE_GUILD to R.string.perm_manage_guild, CREATE_INSTANT_INVITE to R.string.perm_create_invite, CHANGE_NICKNAME to R.string.perm_change_nickname,
            MANAGE_NICKNAMES to R.string.perm_manage_nicknames, KICK_MEMBERS to R.string.perm_kick, BAN_MEMBERS to R.string.perm_ban,
            MODERATE_MEMBERS to R.string.perm_timeout, ADMINISTRATOR to R.string.perm_administrator,
        ),
        R.string.perm_group_text to listOf(
            SEND_MESSAGES to R.string.perm_send_messages, SEND_MESSAGES_IN_THREADS to R.string.perm_send_in_threads, CREATE_PUBLIC_THREADS to R.string.perm_public_threads,
            CREATE_PRIVATE_THREADS to R.string.perm_private_threads, EMBED_LINKS to R.string.perm_embed_links, ATTACH_FILES to R.string.perm_attach_files,
            ADD_REACTIONS to R.string.perm_add_reactions, USE_EXTERNAL_EMOJIS to R.string.perm_external_emoji, MENTION_EVERYONE to R.string.perm_mention_everyone,
            MANAGE_MESSAGES to R.string.perm_manage_messages, MANAGE_THREADS to R.string.perm_manage_threads, READ_MESSAGE_HISTORY to R.string.perm_read_history,
            SEND_VOICE_MESSAGES to R.string.perm_voice_messages, SEND_POLLS to R.string.perm_polls, USE_APPLICATION_COMMANDS to R.string.perm_app_commands,
        ),
        R.string.perm_group_voice to listOf(
            CONNECT to R.string.perm_connect, SPEAK to R.string.perm_speak, STREAM to R.string.perm_stream, USE_SOUNDBOARD to R.string.perm_soundboard,
            MUTE_MEMBERS to R.string.perm_mute, DEAFEN_MEMBERS to R.string.perm_deafen, MOVE_MEMBERS to R.string.perm_move, PRIORITY_SPEAKER to R.string.perm_priority,
            REQUEST_TO_SPEAK to R.string.perm_request_to_speak,
        ),
        R.string.perm_group_events to listOf(CREATE_EVENTS to R.string.perm_create_events, MANAGE_EVENTS to R.string.perm_manage_events),
    )
}

/** Guild-wide permissions that make no sense in a channel overwrite. */
val GUILD_ONLY = with(Perm) {
    setOf(ADMINISTRATOR, MANAGE_GUILD, VIEW_AUDIT_LOG, KICK_MEMBERS, BAN_MEMBERS, MODERATE_MEMBERS, CHANGE_NICKNAME, MANAGE_NICKNAMES, MANAGE_GUILD_EXPRESSIONS)
}

private enum class Page(val label: Int, val icon: Int, val need: Long) {
    OVERVIEW(R.string.ss_overview, R.drawable.ms_info, Perm.MANAGE_GUILD),
    ROLES(R.string.roles, R.drawable.ms_group, Perm.MANAGE_ROLES),
    MEMBERS(R.string.members, R.drawable.ms_person_add, Perm.MANAGE_ROLES or Perm.KICK_MEMBERS or Perm.BAN_MEMBERS or Perm.MODERATE_MEMBERS or Perm.MANAGE_NICKNAMES),
    CHANNELS(R.string.ss_channels, R.drawable.ms_tag, Perm.MANAGE_CHANNELS),
    EMOJI(R.string.ss_emoji, R.drawable.ms_add_reaction, Perm.MANAGE_GUILD_EXPRESSIONS or Perm.CREATE_GUILD_EXPRESSIONS),
    INVITES(R.string.ss_invites, R.drawable.ms_alternate_email, Perm.MANAGE_GUILD),
    BANS(R.string.ss_bans, R.drawable.ms_gavel, Perm.BAN_MEMBERS),
    AUDIT(R.string.ss_audit_log, R.drawable.ms_history, Perm.VIEW_AUDIT_LOG),
}

/** The settings pages this user may open (any of each page's permissions); empty hides the entry points. */
private fun pages(s: State, guildId: String): List<Page> {
    val p = Sel.perms(s, guildId)
    return Page.entries.filter { p and it.need != 0L }
}

fun canOpenServerSettings(s: State, guildId: String) = pages(s, guildId).isNotEmpty()

/** Server settings on the phone: a menu of the pages the user may use; each page uses the web client's REST routes. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ServerSettingsScreen(guildId: String) {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val nav = LocalNav.current
    val g = state.guilds[guildId] ?: run { Loading(); return }
    var page by rememberSaveable { mutableStateOf<String?>(null) }
    var role by rememberSaveable { mutableStateOf<String?>(null) }
    val snack = remember { SnackbarHostState() }
    val allowed = pages(state, guildId)
    BackHandler(page != null) { if (role != null) role = null else page = null }
    val current = page?.let { Page.valueOf(it) }?.takeIf { it in allowed }
    LaunchedEffect(guildId) { if (guildId !in state.membersLoaded) runCatching { Session.loadMembers(guildId) } }
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Column { Text((current?.let { s(it.label) } ?: s(R.string.server_settings)).uppercase()); Text(g.name, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant) } },
                navigationIcon = { IconButton({ if (role != null) role = null else if (page != null) page = null else nav.back() }) { Ic(R.drawable.ms_arrow_back, s(R.string.back)) } },
            )
        },
        snackbarHost = { SnackbarHost(snack) },
    ) { pad ->
        val scope = rememberCoroutineScope()
        val ctx = LocalContext.current
        // every page reports failures the same way; changes come back through the gateway
        val act: (suspend () -> Unit) -> Unit = { f -> scope.launch { try { f() } catch (e: Exception) { snack.showSnackbar(errorText(ctx, e)) } } }
        val clock = rememberRevealClock()
        Box(Modifier.padding(pad).fillMaxSize()) {
            when (current) {
                null -> LazyColumn(contentPadding = PaddingValues(12.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    itemsIndexed(allowed) { i, p ->
                        // one bevelled tile per page, the icon on its own accent plate
                        Surface(onClick = { page = p.name }, shape = Hud, color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth().reveal(i, clock)) {
                            ListItem(
                                headlineContent = { Text(s(p.label), style = MaterialTheme.typography.titleMedium) },
                                leadingContent = {
                                    Box(Modifier.size(40.dp).clip(MaterialTheme.shapes.large).background(MaterialTheme.colorScheme.primaryContainer), contentAlignment = Alignment.Center) { Ic(p.icon, null, Modifier.size(22.dp), MaterialTheme.colorScheme.primary) }
                                },
                                trailingContent = { Ic(R.drawable.ms_chevron_right, null, tint = MaterialTheme.colorScheme.onSurfaceVariant) },
                                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                            )
                        }
                    }
                }
                Page.OVERVIEW -> Overview(g, act)
                Page.ROLES -> role?.let { id -> g.roles.firstOrNull { it.id == id }?.let { RoleEditor(state, g, it, act) { role = null } } } ?: Roles(state, g, act) { role = it }
                Page.MEMBERS -> Members(state, g)
                Page.CHANNELS -> Channels(state, g, act)
                Page.EMOJI -> Emojis(state, g, act)
                Page.INVITES -> Invites(state, g, act)
                Page.BANS -> Bans(g, act)
                Page.AUDIT -> Audit(state, g)
            }
        }
    }
}

@Composable
private fun Overview(g: Guild, act: (suspend () -> Unit) -> Unit) {
    val ctx = LocalContext.current
    var name by rememberSaveable(g.id) { mutableStateOf(g.name) }
    var description by rememberSaveable(g.id) { mutableStateOf(g.description ?: "") }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) act {
            val mime = ctx.contentResolver.getType(uri) ?: "image/png"
            val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@act
            Session.rest.request("PATCH", "/guilds/${g.id}", buildJsonObject { put("icon", "data:$mime;base64," + Base64.encodeToString(bytes, Base64.NO_WRAP)) })
        }
    }
    Column(Modifier.verticalScroll(rememberScrollState()).padding(16.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(16.dp)) {
            Picture(guildIconUrl(g), g.name, g.id, 72.dp, MaterialTheme.shapes.large)
            FilledTonalButton({ pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, shape = MaterialTheme.shapes.small) { Text(s(R.string.change_icon).uppercase()) }
            if (g.icon != null) TextButton({ act { Session.rest.request("PATCH", "/guilds/${g.id}", buildJsonObject { put("icon", JsonNull) }) } }, shape = MaterialTheme.shapes.small) { Text(s(R.string.remove).uppercase()) }
        }
        OutlinedTextField(name, { name = it.take(100) }, label = { Text(s(R.string.server_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
        OutlinedTextField(description, { description = it.take(300) }, label = { Text(s(R.string.server_description)) }, minLines = 2, modifier = Modifier.fillMaxWidth())
        Button({
            act { Session.rest.request("PATCH", "/guilds/${g.id}", buildJsonObject { put("name", name.trim()); if (description.isBlank()) put("description", JsonNull) else put("description", description.trim()) }) }
        }, enabled = name.isNotBlank() && (name != g.name || description != (g.description ?: "")), shape = MaterialTheme.shapes.small) { Text(s(R.string.save).uppercase()) }
    }
}

@Composable
private fun Roles(state: State, g: Guild, act: (suspend () -> Unit) -> Unit, edit: (String) -> Unit) {
    val me = state.me?.id ?: return
    val my = Sel.myMember(state, g.id)
    val roles = g.roles.sortedByDescending { it.position }
    val movable = roles.filter { it.id != g.id }
    val lazy = rememberLazyListState()
    var failed by remember { mutableIntStateOf(0) }
    val drag = remember(movable, failed) { DragList(movable, { it.id }, lazy) }
    fun can(r: Role) = Perm.canManageRole(g, me, my, r)
    fun swap(a: Role, b: Role) = act {
        Session.rest.request("PATCH", "/guilds/${g.id}/roles", buildJsonArray {
            add(buildJsonObject { put("id", a.id); put("position", b.position) }); add(buildJsonObject { put("id", b.id); put("position", a.position) })
        })
    }
    fun drop() {
        val order = drag.items.toList()
        if (order.map { it.id } == movable.map { it.id }) return
        // roles at or above the user's own stay where they are: the server would refuse the whole move
        if (!rolesStayPut(movable, order, ::can)) { failed++; return }
        act {
            try {
                Session.rest.request("PATCH", "/guilds/${g.id}/roles", buildJsonArray { rolePositions(order).forEach { (id, pos) -> add(buildJsonObject { put("id", id); put("position", pos) }) } })
            } catch (e: Exception) { failed++; throw e }
        }
    }
    @Composable fun row(r: Role, modifier: Modifier, handle: Modifier?) {
        val ok = can(r)
        val i = movable.indexOf(r)
        val up = movable.getOrNull(i - 1)?.takeIf { i > 0 && ok && can(it) }
        val down = movable.getOrNull(i + 1)?.takeIf { i >= 0 && ok }
        val count = state.members[g.id].orEmpty().values.count { r.id in it.roles }
        ListItem(
            headlineContent = { Text(if (r.id == g.id) "@everyone" else r.name, maxLines = 1, overflow = TextOverflow.Ellipsis) },
            supportingContent = if (r.id != g.id) { { Text(LocalContext.current.resources.getQuantityString(R.plurals.members_count, count, count)) } } else null,
            leadingContent = { RoleDot(r.color, 16.dp) },
            trailingContent = if (r.id != g.id && ok) { {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconButton({ up?.let { swap(r, it) } }, enabled = up != null) { Ic(R.drawable.ms_arrow_upward, s(R.string.move_up)) }
                    IconButton({ down?.let { swap(r, it) } }, enabled = down != null) { Ic(R.drawable.ms_arrow_downward, s(R.string.move_down)) }
                    if (handle != null) Box(handle.size(48.dp), contentAlignment = Alignment.Center) { Ic(R.drawable.ms_drag_indicator, s(R.string.drag_to_reorder)) }
                }
            } } else null,
            colors = ListItemDefaults.colors(containerColor = if (drag.dragging == r.id) MaterialTheme.colorScheme.surfaceContainerHigh else Color.Transparent),
            modifier = modifier.clickable(enabled = ok) { edit(r.id) },
        )
    }
    LazyColumn(state = lazy, contentPadding = PaddingValues(bottom = 24.dp)) {
        item {
            FilledTonalButton({
                act {
                    val r = json.parseToJsonElement(Session.rest.request("POST", "/guilds/${g.id}/roles", buildJsonObject { put("name", "new role") })).jsonObject
                    (r["id"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.let(edit)
                }
            }, Modifier.padding(16.dp), shape = MaterialTheme.shapes.small) { Ic(R.drawable.ms_add, null, Modifier.size(18.dp)); Text(s(R.string.create_role).uppercase(), Modifier.padding(start = 8.dp)) }
        }
        items(drag.items, key = { it.id }) { r -> row(r, drag.rowModifier(r.id), drag.handle(r.id) { drop() }) }
        roles.firstOrNull { it.id == g.id }?.let { e -> item(key = e.id) { row(e, Modifier, null) } }
    }
}

private val ROLE_COLORS = listOf(0, 0x0098B3, 0x2563EB, 0x7C3AED, 0xDB2777, 0xE11D48, 0xD97706, 0xF59E0B, 0x65A30D, 0x059669, 0x475569, 0x94A3B8)

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RoleEditor(state: State, g: Guild, r: Role, act: (suspend () -> Unit) -> Unit, done: () -> Unit) {
    val ctx = LocalContext.current
    val mine = Sel.perms(state, g.id)
    val meId = state.me?.id ?: ""
    val my = Sel.myMember(state, g.id)
    val everyone = r.id == g.id
    var name by rememberSaveable(r.id) { mutableStateOf(r.name) }
    var color by rememberSaveable(r.id) { mutableIntStateOf(r.color) }
    var hoist by rememberSaveable(r.id) { mutableStateOf(r.hoist) }
    var mention by rememberSaveable(r.id) { mutableStateOf(r.mentionable) }
    var perms by rememberSaveable(r.id) { mutableLongStateOf(Perm.bits(r.permissions)) }
    var confirmDelete by remember { mutableStateOf(false) }
    LazyColumn(contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
        item {
            if (!everyone) OutlinedTextField(name, { name = it.take(100) }, label = { Text(s(R.string.role_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
            if (!everyone) {
                Text(s(R.string.role_color).uppercase(), style = MaterialTheme.typography.labelMedium, modifier = Modifier.padding(top = 12.dp, bottom = 4.dp))
                FlowRow(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    for (c in ROLE_COLORS) {
                        val label = if (c == 0) ctx.getString(R.string.role_color_none) else "#%06X".format(c)
                        Box(Modifier.size(48.dp).clickable(onClickLabel = label) { color = c }.semantics { selected = color == c }, contentAlignment = Alignment.Center) {
                            Surface(shape = CircleShape, color = if (c == 0) MaterialTheme.colorScheme.surfaceContainerHighest else Color(0xFF000000 or c.toLong()),
                                border = if (color == c) BorderStroke(3.dp, MaterialTheme.colorScheme.onSurface) else BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
                                modifier = Modifier.size(34.dp)) {}
                        }
                    }
                }
                SwitchLine(s(R.string.role_hoist), hoist) { hoist = it }
                SwitchLine(s(R.string.role_mentionable), mention) { mention = it }
            }
            Row(Modifier.padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button({
                    act {
                        check(Perm.keepsAdmin(g, meId, my, after = g.copy(roles = g.roles.map { if (it.id == r.id) it.copy(permissions = perms.toString()) else it }))) { ctx.getString(R.string.self_lockout) }
                        Session.rest.request("PATCH", "/guilds/${g.id}/roles/${r.id}", buildJsonObject {
                            if (!everyone) { put("name", name.trim()); put("color", color); put("hoist", hoist); put("mentionable", mention) }
                            put("permissions", perms.toString())
                        })
                        done()
                    }
                }, enabled = everyone || name.isNotBlank(), shape = MaterialTheme.shapes.small) { Text(s(R.string.save).uppercase()) }
                if (!everyone) OutlinedButton({ confirmDelete = true }, shape = MaterialTheme.shapes.small) { Text(s(R.string.delete_role).uppercase(), color = MaterialTheme.colorScheme.error) }
            }
        }
        for ((group, bits) in PERM_GROUPS) {
            item(key = "g$group") { Text(s(group), style = MaterialTheme.typography.titleSmall, color = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 16.dp).semantics { heading() }) }
            items(bits, key = { it.first }) { (bit, label) ->
                // the server only lets a role change bits the actor holds
                SwitchLine(s(label), Perm.has(perms, bit), enabled = Perm.has(mine, bit)) { on -> perms = if (on) perms or bit else perms and bit.inv() }
            }
        }
    }
    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text(s(R.string.delete_role).uppercase()) },
        text = { Text(s(R.string.delete_role_confirm, r.name)) },
        confirmButton = {
            TextButton({
                confirmDelete = false
                act {
                    check(Perm.keepsAdmin(g, meId, my, afterMe = my?.copy(roles = my.roles - r.id))) { ctx.getString(R.string.self_lockout) }
                    Session.rest.request("DELETE", "/guilds/${g.id}/roles/${r.id}"); done()
                }
            }, shape = MaterialTheme.shapes.small) { Text(s(R.string.delete).uppercase(), color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton({ confirmDelete = false }, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) } },
    )
}

@Composable
private fun SwitchLine(label: String, on: Boolean, enabled: Boolean = true, set: (Boolean) -> Unit) =
    ListItem(
        headlineContent = { Text(label, color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant) },
        trailingContent = { Switch(on, null, enabled = enabled) },
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        modifier = Modifier.clickable(enabled = enabled, role = androidx.compose.ui.semantics.Role.Switch) { set(!on) },
    )

@Composable
private fun Members(state: State, g: Guild) {
    val nav = LocalNav.current
    var q by rememberSaveable { mutableStateOf("") }
    var role by rememberSaveable { mutableStateOf<String?>(null) }
    val list = state.members[g.id].orEmpty().values.filter { m ->
        val u = m.user ?: return@filter false
        (role == null || role in m.roles) &&
            (q.isBlank() || listOfNotNull(u.username, u.globalName, m.nick).any { it.contains(q.trim(), ignoreCase = true) })
    }.sortedBy { Sel.memberName(state, g.id, it.user!!.id).lowercase() }
    Column {
        OutlinedTextField(q, { q = it }, placeholder = { Text(s(R.string.search_members)) }, leadingIcon = { Ic(R.drawable.ms_search, null) }, singleLine = true,
            shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp))
        LazyRow(contentPadding = PaddingValues(horizontal = 16.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            items(g.roles.filter { it.id != g.id }.sortedByDescending { it.position }, key = { it.id }) { r ->
                FilterChip(role == r.id, { role = if (role == r.id) null else r.id }, label = { Text(r.name) }, leadingIcon = { RoleDot(r.color, 10.dp) })
            }
        }
        LazyColumn(Modifier.fillMaxSize()) {
            items(list, key = { it.user!!.id }) { m -> MemberRow(state, g.id, m) { nav.openProfile(m.user!!.id, g.id) } }
        }
    }
}

@Composable
private fun Channels(state: State, g: Guild, act: (suspend () -> Unit) -> Unit) {
    val groups = Sel.sidebar(state, g.id)
    val categories = groups.mapNotNull { it.category }
    var edit by remember { mutableStateOf<Channel?>(null) }
    var creating by remember { mutableStateOf(false) }
    val lazy = rememberLazyListState()
    var failed by remember { mutableIntStateOf(0) }
    val flat = groups.flatMap { listOfNotNull(it.category) + it.channels }
    // keyed on what the list shows: a new last message in some channel must not cancel a drag
    val drag = remember(flat.map { listOf(it.id, it.position, it.parentId, it.name, it.type) }, failed) { DragList(flat, { it.id }, lazy) }
    fun patch(moves: List<Channel>) = act {
        if (moves.isEmpty()) return@act
        try {
            Session.rest.request("PATCH", "/guilds/${g.id}/channels", buildJsonArray {
                moves.forEach { x -> add(buildJsonObject { put("id", x.id); put("position", x.position); if (x.type != 4) put("parent_id", x.parentId) }) }
            })
        } catch (e: Exception) { failed++; throw e }
    }
    // moves one step among its siblings and renumbers them, so equal positions sort out too
    fun move(list: List<Channel>, c: Channel, by: Int) {
        val l = list.toMutableList(); val i = l.indexOf(c); val j = i + by
        if (j !in l.indices) return
        l.removeAt(i); l.add(j, c)
        patch(l.mapIndexedNotNull { k, x -> x.takeIf { it.position != k }?.copy(position = k) })
    }
    val siblings = groups.flatMap { grp -> listOfNotNull(grp.category).map { it.id to categories } + grp.channels.map { it.id to grp.channels } }.toMap()
    LazyColumn(state = lazy, contentPadding = PaddingValues(bottom = 24.dp)) {
        item { FilledTonalButton({ creating = true }, Modifier.padding(16.dp), shape = MaterialTheme.shapes.small) { Ic(R.drawable.ms_add, null, Modifier.size(18.dp)); Text(s(R.string.create_channel).uppercase(), Modifier.padding(start = 8.dp)) } }
        items(drag.items, key = { it.id }) { c ->
            val sib = siblings[c.id].orEmpty()
            val i = sib.indexOf(c)
            // indented: below a category in the list as dragged
            val indent = c.type != 4 && drag.items.take(drag.items.indexOf(c)).any { it.type == 4 }
            ListItem(
                headlineContent = { Text(if (c.type == 4) (c.name ?: "").uppercase() else c.name ?: "", fontWeight = if (c.type == 4) FontWeight.Bold else null, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                leadingContent = if (c.type == 4) null else { { Ic(channelIcon(c), null) } },
                trailingContent = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        IconButton({ move(sib, c, -1) }, enabled = i > 0) { Ic(R.drawable.ms_arrow_upward, s(R.string.move_up)) }
                        IconButton({ move(sib, c, 1) }, enabled = i in 0 until sib.size - 1) { Ic(R.drawable.ms_arrow_downward, s(R.string.move_down)) }
                        Box(drag.handle(c.id) { moved -> if (drag.items.map { it.id } != flat.map { it.id }) patch(channelMoves(drag.items.toList(), moved)) }.size(48.dp), contentAlignment = Alignment.Center) {
                            Ic(R.drawable.ms_drag_indicator, s(R.string.drag_to_reorder))
                        }
                    }
                },
                colors = ListItemDefaults.colors(containerColor = if (drag.dragging == c.id) MaterialTheme.colorScheme.surfaceContainerHigh else Color.Transparent),
                modifier = drag.rowModifier(c.id).clickable { edit = c }.padding(start = if (indent) 16.dp else 0.dp),
            )
        }
    }
    edit?.let { c -> ChannelEditDialog(c) { edit = null } }
    if (creating) CreateChannelDialog(g, categories, act) { creating = false }
}

private val SLOWMODE = listOf(0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600)

private fun slowmodeLabel(ctx: android.content.Context, secs: Int) = when {
    secs == 0 -> ctx.getString(R.string.off)
    secs < 60 -> ctx.getString(R.string.duration_seconds, secs)
    secs < 3600 -> ctx.getString(R.string.duration_minutes, secs / 60)
    else -> ctx.getString(R.string.duration_hours, secs / 3600)
}

/** Name, topic, slowmode, age restriction, permissions and delete for one channel or category (MANAGE_CHANNELS). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelEditDialog(c: Channel, close: () -> Unit) {
    val ctx = LocalContext.current
    val nav = LocalNav.current
    val scope = rememberCoroutineScope()
    val state by Session.store.state.collectAsStateWithLifecycle()
    var name by rememberSaveable(c.id) { mutableStateOf(c.name ?: "") }
    var topic by rememberSaveable(c.id) { mutableStateOf(c.topic ?: "") }
    var slow by rememberSaveable(c.id) { mutableIntStateOf(c.rateLimitPerUser) }
    var nsfw by rememberSaveable(c.id) { mutableStateOf(c.nsfw) }
    var slowOpen by remember { mutableStateOf(false) }
    var confirmDelete by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    fun run(f: suspend () -> Unit) = scope.launch { try { f(); close() } catch (e: Exception) { error = errorText(ctx, e) } }
    val hasTopic = c.type in setOf(0, 5, 15)
    val hasSlow = c.type in setOf(0, 2, 5, 13, 15)
    AlertDialog(
        onDismissRequest = close,
        title = { Text(s(if (c.type == 4) R.string.edit_category else R.string.edit_channel).uppercase()) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedTextField(name, { name = it.take(100) }, label = { Text(s(R.string.channel_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (hasTopic) OutlinedTextField(topic, { topic = it.take(1024) }, label = { Text(s(R.string.channel_topic)) }, minLines = 2, modifier = Modifier.fillMaxWidth())
                if (hasSlow) ExposedDropdownMenuBox(slowOpen, { slowOpen = it }) {
                    OutlinedTextField(slowmodeLabel(ctx, slow), {}, readOnly = true, label = { Text(s(R.string.slowmode_label)) },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(slowOpen) }, modifier = Modifier.fillMaxWidth().menuAnchor(MenuAnchorType.PrimaryNotEditable))
                    ExposedDropdownMenu(slowOpen, { slowOpen = false }) {
                        for (v in SLOWMODE) DropdownMenuItem({ Text(slowmodeLabel(ctx, v)) }, { slow = v; slowOpen = false })
                    }
                }
                if (c.type != 4) SwitchLine(s(R.string.age_restricted), nsfw) { nsfw = it }
                if (Perm.has(Sel.perms(state, c.guildId, c), Perm.MANAGE_ROLES)) TextButton({ close(); nav.openChannelAccess(c.id) }, shape = MaterialTheme.shapes.small) { Text(s(R.string.manage_channel_access).uppercase()) }
                TextButton({ confirmDelete = true }, shape = MaterialTheme.shapes.small) { Text(s(if (c.type == 4) R.string.delete_category else R.string.delete_channel).uppercase(), color = MaterialTheme.colorScheme.error) }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton({
                run {
                    Session.rest.request("PATCH", "/channels/${c.id}", buildJsonObject {
                        put("name", name.trim())
                        if (hasTopic) { if (topic.isBlank()) put("topic", JsonNull) else put("topic", topic.trim()) }
                        if (hasSlow) put("rate_limit_per_user", slow)
                        if (c.type != 4) put("nsfw", nsfw)
                    })
                }
            }, enabled = name.isNotBlank(), shape = MaterialTheme.shapes.small) { Text(s(R.string.save).uppercase()) }
        },
        dismissButton = { TextButton(close, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) } },
    )
    if (confirmDelete) AlertDialog(
        onDismissRequest = { confirmDelete = false },
        title = { Text(s(if (c.type == 4) R.string.delete_category else R.string.delete_channel).uppercase()) },
        text = { Text(s(R.string.delete_channel_confirm, c.name ?: "")) },
        confirmButton = { TextButton({ confirmDelete = false; run { Session.rest.request("DELETE", "/channels/${c.id}") } }, shape = MaterialTheme.shapes.small) { Text(s(R.string.delete).uppercase(), color = MaterialTheme.colorScheme.error) } },
        dismissButton = { TextButton({ confirmDelete = false }, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) } },
    )
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun CreateChannelDialog(g: Guild, categories: List<Channel>, act: (suspend () -> Unit) -> Unit, close: () -> Unit) {
    var name by rememberSaveable { mutableStateOf("") }
    var type by rememberSaveable { mutableIntStateOf(0) }
    var parent by rememberSaveable { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = close,
        title = { Text(s(R.string.create_channel).uppercase()) },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(8.dp)) {
                FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    for ((t, label) in listOf(0 to R.string.text_channel, 2 to R.string.voice_channel, 5 to R.string.announcement_channel, 4 to R.string.category))
                        FilterChip(type == t, { type = t }, label = { Text(s(label)) })
                }
                OutlinedTextField(name, { name = it.take(100) }, label = { Text(s(R.string.channel_name)) }, singleLine = true, modifier = Modifier.fillMaxWidth())
                if (type != 4 && categories.isNotEmpty()) {
                    Text(s(R.string.category).uppercase(), style = MaterialTheme.typography.labelMedium)
                    FlowRow(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        FilterChip(parent == null, { parent = null }, label = { Text(s(R.string.no_category)) })
                        for (cat in categories) FilterChip(parent == cat.id, { parent = cat.id }, label = { Text(cat.name ?: "") })
                    }
                }
            }
        },
        confirmButton = {
            TextButton({
                close()
                act {
                    Session.rest.request("POST", "/guilds/${g.id}/channels", buildJsonObject {
                        put("name", name.trim()); put("type", type); if (type != 4 && parent != null) put("parent_id", parent)
                    })
                }
            }, enabled = name.isNotBlank(), shape = MaterialTheme.shapes.small) { Text(s(R.string.create).uppercase()) }
        },
        dismissButton = { TextButton(close, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) } },
    )
}

/** Loads a list once per [key] and on [reload]; null while loading. */
@Composable
private fun <T> loaded(key: Any, reload: Int, act: (suspend () -> Unit) -> Unit, load: suspend () -> T): T? {
    var v by remember(key) { mutableStateOf<T?>(null) }
    LaunchedEffect(key, reload) { act { v = load() } }
    return v
}

/** An emoji name the server takes (2-32 of A-Z, a-z, 0-9, _), made from a file name. */
fun emojiName(file: String): String =
    file.substringBeforeLast('.').replace(Regex("[^A-Za-z0-9_]+"), "_").trim('_').take(32).let { if (it.length < 2) "emoji" else it }

val EMOJI_NAME = Regex("^[A-Za-z0-9_]{2,32}$")
private const val EMOJI_MAX_BYTES = 256 * 1024

/** Server emoji: upload (PNG, JPEG, GIF, WebP up to 256 KB), rename, delete; CREATE_GUILD_EXPRESSIONS covers your own, MANAGE_GUILD_EXPRESSIONS all. */
@Composable
private fun Emojis(state: State, g: Guild, act: (suspend () -> Unit) -> Unit) {
    val ctx = LocalContext.current
    val perms = Sel.perms(state, g.id)
    val me = state.me?.id
    var reload by remember { mutableIntStateOf(0) }
    val list = loaded(g.id, reload, act) { Session.rest.get<List<GuildEmoji>>("/guilds/${g.id}/emojis") }
    var naming by remember { mutableStateOf<Pair<String, String?>?>(null) } // name, emoji id (null: the picked upload)
    var picked by remember { mutableStateOf<Pair<String, ByteArray>?>(null) } // data type, bytes
    var deleting by remember { mutableStateOf<GuildEmoji?>(null) }
    fun canEdit(e: GuildEmoji) = Perm.has(perms, Perm.MANAGE_GUILD_EXPRESSIONS) || (e.user?.id == me && Perm.has(perms, Perm.CREATE_GUILD_EXPRESSIONS))
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia()) { uri ->
        if (uri != null) act {
            val mime = ctx.contentResolver.getType(uri) ?: "image/png"
            val bytes = ctx.contentResolver.openInputStream(uri)?.use { it.readBytes() } ?: return@act
            check(bytes.size <= EMOJI_MAX_BYTES) { ctx.getString(R.string.emoji_too_big) }
            val file = ctx.contentResolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c -> if (c.moveToFirst()) c.getString(0) else null }
            picked = mime to bytes
            naming = emojiName(file ?: "emoji") to null
        }
    }
    LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
        item {
            FilledTonalButton({ pick.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly)) }, Modifier.padding(16.dp), shape = MaterialTheme.shapes.small) {
                Ic(R.drawable.ms_add, null, Modifier.size(18.dp)); Text(s(R.string.upload_emoji).uppercase(), Modifier.padding(start = 8.dp))
            }
            Text(s(R.string.emoji_hint), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 16.dp))
        }
        if (list == null) item { Loading() }
        else if (list.isEmpty()) item { Text(s(R.string.no_emoji), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp)) }
        items(list.orEmpty(), key = { it.id }) { e ->
            val ok = canEdit(e)
            ListItem(
                headlineContent = { Text(":${e.name}:") },
                supportingContent = e.user?.let { u -> { Text(s(R.string.emoji_added_by, u.displayName)) } },
                leadingContent = { coil3.compose.AsyncImage(Config.cdn("/emojis/${e.id}.${if (e.animated) "gif" else "png"}"), ":${e.name}:", Modifier.size(36.dp)) },
                trailingContent = if (ok) { {
                    Row {
                        IconButton({ naming = e.name to e.id }) { Ic(R.drawable.ms_edit, s(R.string.rename_emoji)) }
                        IconButton({ deleting = e }) { Ic(R.drawable.ms_delete, s(R.string.delete_emoji)) }
                    }
                } } else null,
                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            )
        }
    }
    naming?.let { (start, id) ->
        var name by remember(start, id) { mutableStateOf(start) }
        val close = { naming = null; picked = null }
        AlertDialog(
            onDismissRequest = close,
            title = { Text(s(if (id == null) R.string.upload_emoji else R.string.rename_emoji).uppercase()) },
            text = {
                OutlinedTextField(name, { name = it.take(32) }, label = { Text(s(R.string.emoji_name)) }, singleLine = true, isError = !EMOJI_NAME.matches(name),
                    supportingText = { Text(s(R.string.emoji_name_rule)) }, modifier = Modifier.fillMaxWidth())
            },
            confirmButton = {
                TextButton({
                    val file = picked
                    close()
                    act {
                        if (id == null && file != null) Session.rest.request("POST", "/guilds/${g.id}/emojis", buildJsonObject {
                            put("name", name); put("image", "data:${file.first};base64," + Base64.encodeToString(file.second, Base64.NO_WRAP))
                        })
                        else if (id != null) Session.rest.request("PATCH", "/guilds/${g.id}/emojis/$id", buildJsonObject { put("name", name) })
                        reload++
                    }
                }, enabled = EMOJI_NAME.matches(name), shape = MaterialTheme.shapes.small) { Text(s(if (id == null) R.string.upload else R.string.save).uppercase()) }
            },
            dismissButton = { TextButton(close, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) } },
        )
    }
    deleting?.let { e ->
        AlertDialog(
            onDismissRequest = { deleting = null },
            title = { Text(s(R.string.delete_emoji).uppercase()) },
            text = { Text(s(R.string.delete_emoji_confirm, e.name)) },
            confirmButton = { TextButton({ deleting = null; act { Session.rest.request("DELETE", "/guilds/${g.id}/emojis/${e.id}"); reload++ } }, shape = MaterialTheme.shapes.small) { Text(s(R.string.delete).uppercase(), color = MaterialTheme.colorScheme.error) } },
            dismissButton = { TextButton({ deleting = null }, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) } },
        )
    }
}

@Composable
private fun Invites(state: State, g: Guild, act: (suspend () -> Unit) -> Unit) {
    val ctx = LocalContext.current
    val clipboard = androidx.compose.ui.platform.LocalClipboard.current
    val scope = rememberCoroutineScope()
    var reload by remember { mutableIntStateOf(0) }
    val list = loaded(g.id, reload, act) { Session.rest.get<List<Invite>>("/guilds/${g.id}/invites") }
    val target = Sel.firstText(state, g.id)
    LazyColumn(contentPadding = PaddingValues(bottom = 24.dp)) {
        item {
            FilledTonalButton({ target?.let { c -> act { Session.rest.request("POST", "/channels/${c.id}/invites", buildJsonObject { put("max_age", 86400) }); reload++ } } },
                Modifier.padding(16.dp), enabled = target != null, shape = MaterialTheme.shapes.small) { Text(s(R.string.create_invite).uppercase()) }
        }
        if (list == null) item { Loading() }
        else if (list.isEmpty()) item { Text(s(R.string.no_invites), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(16.dp)) }
        items(list.orEmpty(), key = { it.code }) { inv ->
            val link = Config.APP_URL.trimEnd('/') + "/invite/" + inv.code
            ListItem(
                headlineContent = { Text(inv.code, fontWeight = FontWeight.SemiBold) },
                supportingContent = {
                    Text(listOfNotNull(inv.channel?.name?.let { "#$it" }, inv.inviter?.displayName, ctx.getString(R.string.invite_uses, inv.uses),
                        inv.expiresAt?.let { ctx.getString(R.string.invite_expires, messageTime(ctx, it)) } ?: ctx.getString(R.string.invite_never_expires)).joinToString(" · "))
                },
                trailingContent = {
                    Row {
                        IconButton({ scope.launch { clipboard.setClipEntry(androidx.compose.ui.platform.ClipEntry(android.content.ClipData.newPlainText("invite", link))) } }) {
                            Ic(R.drawable.ms_content_copy, s(R.string.copy_link))
                        }
                        IconButton({ act { Session.rest.request("DELETE", "/invites/${inv.code}"); reload++ } }) { Ic(R.drawable.ms_delete, s(R.string.revoke_invite)) }
                    }
                },
                colors = ListItemDefaults.colors(containerColor = Color.Transparent),
            )
        }
    }
}

@Composable
private fun Bans(g: Guild, act: (suspend () -> Unit) -> Unit) {
    var reload by remember { mutableIntStateOf(0) }
    val list = loaded(g.id, reload, act) { Session.rest.get<List<Ban>>("/guilds/${g.id}/bans") }
    when {
        list == null -> Loading()
        list.isEmpty() -> EmptyState(R.drawable.ms_gavel, s(R.string.no_bans))
        else -> LazyColumn {
            items(list, key = { it.user.id }) { b ->
                ListItem(
                    headlineContent = { Text(b.user.displayName) },
                    supportingContent = b.reason?.takeIf { it.isNotBlank() }?.let { { Text(it) } },
                    leadingContent = { Avatar(b.user, 40.dp) },
                    trailingContent = { TextButton({ act { Session.rest.request("DELETE", "/guilds/${g.id}/bans/${b.user.id}"); reload++ } }, shape = MaterialTheme.shapes.small) { Text(s(R.string.unban).uppercase()) } },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                )
            }
        }
    }
}

private val AUDIT_ACTIONS = mapOf(
    1 to R.string.audit_guild_update, 10 to R.string.audit_channel_create, 11 to R.string.audit_channel_update, 12 to R.string.audit_channel_delete,
    13 to R.string.audit_overwrite_create, 14 to R.string.audit_overwrite_update, 15 to R.string.audit_overwrite_delete, 20 to R.string.audit_kick,
    22 to R.string.audit_ban, 23 to R.string.audit_unban, 24 to R.string.audit_member_update, 25 to R.string.audit_member_roles, 26 to R.string.audit_member_move,
    27 to R.string.audit_member_disconnect, 30 to R.string.audit_role_create, 31 to R.string.audit_role_update, 32 to R.string.audit_role_delete,
    40 to R.string.audit_invite_create, 42 to R.string.audit_invite_delete, 72 to R.string.audit_message_delete, 73 to R.string.audit_message_bulk_delete,
    60 to R.string.audit_emoji_create, 61 to R.string.audit_emoji_update, 62 to R.string.audit_emoji_delete,
    74 to R.string.audit_message_pin, 75 to R.string.audit_message_unpin, 110 to R.string.audit_thread_create, 111 to R.string.audit_thread_update, 112 to R.string.audit_thread_delete,
)

@Composable
private fun Audit(state: State, g: Guild) {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var type by rememberSaveable { mutableStateOf<Int?>(null) }
    var actor by rememberSaveable { mutableStateOf<String?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var entries by remember { mutableStateOf<List<AuditEntry>?>(null) }
    var users by remember { mutableStateOf<Map<String, User>>(emptyMap()) }
    var more by remember { mutableStateOf(false) }
    var busy by remember { mutableStateOf(false) }
    // one page of 50 (newest first) for the chosen filters; before = the oldest entry shown
    fun load(before: String?) = scope.launch {
        if (busy) return@launch
        busy = true; error = null
        try {
            val log = Session.rest.get<AuditLog>("/guilds/${g.id}/audit-logs?limit=$AUDIT_PAGE" + (type?.let { "&action_type=$it" } ?: "") +
                (actor?.let { "&user_id=$it" } ?: "") + (before?.let { "&before=$it" } ?: ""))
            users = users + log.users.associateBy { it.id }
            entries = (if (before == null) emptyList() else entries.orEmpty()) + log.auditLogEntries
            more = log.auditLogEntries.size == AUDIT_PAGE
        } catch (e: Exception) { error = errorText(ctx, e) }
        busy = false
    }
    LaunchedEffect(g.id, type, actor) { entries = null; load(null) }
    fun name(id: String?) = id?.let { i -> users[i]?.displayName ?: state.users[i]?.displayName ?: g.roles.firstOrNull { it.id == i }?.name ?: state.channels[i]?.name?.let { "#$it" } }
    fun label(t: Int) = AUDIT_ACTIONS[t]?.let { ctx.getString(it) } ?: ctx.getString(R.string.audit_other, t)
    val list = entries
    Column {
        Row(Modifier.padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            FilterMenu(type?.let(::label) ?: s(R.string.audit_all_actions), type != null,
                listOf(null to s(R.string.audit_all_actions)) + AUDIT_ACTIONS.keys.sorted().map { it to label(it) }) { type = it }
            // who acted: everyone the log has named so far, plus the members who may change things
            val staff = remember(state.members[g.id], g) { state.members[g.id].orEmpty().filter { (id, m) -> Perm.base(g, id, m) and AUDITED_PERMS != 0L }.keys }
            val actors = (users.keys + staff + listOfNotNull(actor)).distinct().sortedBy { name(it)?.lowercase() }
            FilterMenu(actor?.let(::name) ?: s(R.string.audit_all_users), actor != null, listOf(null to s(R.string.audit_all_users)) + actors.map { it to (name(it) ?: it) }) { actor = it }
        }
        when {
            error != null && list.isNullOrEmpty() -> Text(error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
            list == null -> Loading()
            list.isEmpty() -> EmptyState(R.drawable.ms_history, s(R.string.no_audit_entries))
            else -> LazyColumn {
                items(list, key = { it.id }) { e ->
                    val time = java.time.Instant.ofEpochMilli((e.id.toLongOrNull() ?: 0L).shr(22) + 1420070400000L).toString()
                    ListItem(
                        headlineContent = { Text(listOfNotNull(name(e.userId), label(e.actionType), name(e.targetId)).joinToString(" · ")) },
                        supportingContent = { Text(listOfNotNull(messageTime(ctx, time), e.reason).joinToString(" · ")) },
                        leadingContent = { Avatar(e.userId?.let { users[it] ?: state.users[it] }, 36.dp) },
                        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
                    )
                }
                if (more) item(key = "more") {
                    Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                        if (busy) androidx.compose.material3.CircularProgressIndicator(Modifier.size(24.dp))
                        else TextButton({ load(list.last().id) }, shape = MaterialTheme.shapes.small) { Text(s(R.string.load_more).uppercase()) }
                    }
                }
            }
        }
    }
}

private const val AUDIT_PAGE = 50
private val AUDITED_PERMS = with(Perm) { ADMINISTRATOR or MANAGE_GUILD or MANAGE_ROLES or MANAGE_CHANNELS or KICK_MEMBERS or BAN_MEMBERS or MODERATE_MEMBERS or MANAGE_MESSAGES or MANAGE_GUILD_EXPRESSIONS }

/** A filter chip that opens a menu of [options]; picking one calls [pick]. */
@Composable
private fun <T> FilterMenu(label: String, active: Boolean, options: List<Pair<T, String>>, pick: (T) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box {
        FilterChip(active, { open = true }, label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) }, trailingIcon = { Ic(R.drawable.ms_expand_more, null, Modifier.size(18.dp)) })
        androidx.compose.material3.DropdownMenu(open, { open = false }, Modifier.heightIn(max = 400.dp)) {
            for ((v, text) in options) DropdownMenuItem({ Text(text) }, { open = false; pick(v) })
        }
    }
}
