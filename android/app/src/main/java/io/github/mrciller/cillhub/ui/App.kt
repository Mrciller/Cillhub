package io.github.mrciller.cillhub.ui

import android.app.Activity
import androidx.compose.animation.AnimatedContentTransitionScope
import androidx.compose.animation.EnterTransition
import androidx.compose.animation.ExitTransition
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.NavigationRailItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.windowsizeclass.ExperimentalMaterial3WindowSizeClassApi
import androidx.compose.material3.windowsizeclass.WindowWidthSizeClass
import androidx.compose.material3.windowsizeclass.calculateWindowSizeClass
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavBackStackEntry
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.WebCallActivity
import io.github.mrciller.cillhub.data.ApiError
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.isPrivate
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.serialization.Serializable

@Serializable object ServersRoute
@Serializable object MessagesRoute
@Serializable object InboxRoute
@Serializable object YouRoute
@Serializable data class ChatRoute(val channelId: String)
@Serializable data class ForumRoute(val channelId: String)
@Serializable data class MembersRoute(val guildId: String)
@Serializable object FriendsRoute
@Serializable data class SettingsRoute(val page: String)
@Serializable data class VoiceRoute(val channelId: String, val start: Boolean = false)
@Serializable data class ChannelInfoRoute(val channelId: String)
@Serializable data class ChannelAccessRoute(val channelId: String)
@Serializable data class ServerSettingsRoute(val guildId: String)
@Serializable data class SearchRoute(val channelId: String)

/** What screens may ask of the app shell. */
interface Nav {
    val twoPane: Boolean
    fun openChannel(channelId: String)
    /** The voice screen of a voice channel, stage or DM call; [start] joins at once (a DM call rings). */
    fun openVoice(channelId: String, start: Boolean = false)
    fun openProfile(userId: String, guildId: String?)
    fun openImage(url: String, name: String)
    fun confirmLink(url: String)
    fun openMembers(guildId: String)
    fun openFriends()
    fun openSettings(page: String)
    fun openChannelInfo(channelId: String)
    fun openChannelAccess(channelId: String)
    fun openServerSettings(guildId: String)
    fun openSearch(channelId: String)
    /** The chat of [channelId], scrolled to [messageId] (loaded on the way if needed). */
    fun openMessage(channelId: String, messageId: String)
    fun back()
}

val LocalNav = staticCompositionLocalOf<Nav> { error("no Nav") }

/** Deep links from notifications and shortcuts: a channel id, "voice:<channel id>" or "settings:<page>". */
val pendingOpen = MutableStateFlow<String?>(null)

/** channel id to message id: the chat of that channel scrolls to the message once (ChatScreen consumes it). */
val pendingJump = MutableStateFlow<Pair<String, String>?>(null)

/** The activity is in picture-in-picture: only the call's video shows. */
val inPip = MutableStateFlow(false)

@Composable
fun CillhubApp() {
    val loggedIn by Session.loggedIn.collectAsStateWithLifecycle()
    val pip by inPip.collectAsStateWithLifecycle()
    if (pip) PipContent() else if (!loggedIn) AuthFlow() else MainShell()
}

private data class Tab(val route: Any, val label: Int, val icon: Int, val selectedIcon: Int)
private val TABS = listOf(
    Tab(ServersRoute, R.string.tab_servers, R.drawable.ms_home, R.drawable.ms_home_fill),
    Tab(MessagesRoute, R.string.tab_messages, R.drawable.ms_chat, R.drawable.ms_chat_fill),
    Tab(InboxRoute, R.string.tab_inbox, R.drawable.ms_inbox, R.drawable.ms_inbox_fill),
    Tab(YouRoute, R.string.tab_you, R.drawable.ms_account_circle, R.drawable.ms_account_circle_fill),
)

@OptIn(ExperimentalMaterial3WindowSizeClassApi::class)
@Composable
private fun MainShell() {
    val activity = LocalContext.current as Activity
    val width = calculateWindowSizeClass(activity).widthSizeClass
    val twoPane = width != WindowWidthSizeClass.Compact && LocalConfiguration.current.screenWidthDp >= 700
    val nav = rememberNavController()
    val state by Session.store.state.collectAsStateWithLifecycle()
    val reduce = LocalReduceMotion.current

    var guildId by rememberSaveable { mutableStateOf<String?>(null) }
    var serverChannel by rememberSaveable { mutableStateOf<String?>(null) }
    var dmChannel by rememberSaveable { mutableStateOf<String?>(null) }
    var profile by remember { mutableStateOf<Pair<String, String?>?>(null) }
    var image by remember { mutableStateOf<Pair<String, String>?>(null) }
    var link by remember { mutableStateOf<String?>(null) }
    val ctx = LocalContext.current

    val shell = remember(twoPane) {
        object : Nav {
            override val twoPane = twoPane
            override fun openChannel(channelId: String) {
                val ch = Session.store.value.channels[channelId]
                if (ch != null && ch.type in Sel.VOICE_TYPES) return openVoice(channelId)
                if (ch != null && ch.type == 15) {
                    if (ch.guildId != null) { guildId = ch.guildId; serverChannel = channelId }
                    if (twoPane) nav.tab(ServersRoute)
                    else nav.navigate(ForumRoute(channelId)) { launchSingleTop = true }
                    return
                }
                val private = ch == null || isPrivate(ch)
                if (ch?.guildId != null) { guildId = ch.guildId; serverChannel = channelId } else dmChannel = channelId
                if (twoPane && ch != null) nav.tab(if (private) MessagesRoute else ServersRoute)
                else nav.navigate(ChatRoute(channelId)) { launchSingleTop = true }
            }
            override fun openVoice(channelId: String, start: Boolean) = nav.navigate(VoiceRoute(channelId, start)) { launchSingleTop = true }
            override fun openProfile(userId: String, guildId: String?) { profile = userId to guildId }
            override fun openImage(url: String, name: String) { image = url to name }
            override fun confirmLink(url: String) { link = url }
            override fun openMembers(guildId: String) = nav.navigate(MembersRoute(guildId)) { launchSingleTop = true }
            override fun openFriends() = nav.navigate(FriendsRoute) { launchSingleTop = true }
            override fun openSettings(page: String) = nav.navigate(SettingsRoute(page)) { launchSingleTop = true }
            override fun openChannelInfo(channelId: String) = nav.navigate(ChannelInfoRoute(channelId)) { launchSingleTop = true }
            override fun openChannelAccess(channelId: String) = nav.navigate(ChannelAccessRoute(channelId)) { launchSingleTop = true }
            override fun openServerSettings(guildId: String) = nav.navigate(ServerSettingsRoute(guildId)) { launchSingleTop = true }
            override fun openSearch(channelId: String) = nav.navigate(SearchRoute(channelId)) { launchSingleTop = true }
            override fun openMessage(channelId: String, messageId: String) {
                pendingJump.value = channelId to messageId
                // back to that chat if it is under the search screen, else open it
                if (!nav.popBackStack(ChatRoute(channelId), inclusive = false)) openChannel(channelId)
            }
            override fun back() { nav.popBackStack() }
        }
    }

    val open by pendingOpen.collectAsStateWithLifecycle()
    LaunchedEffect(open, state.conn) {
        val target = open ?: return@LaunchedEffect
        if (target.startsWith("settings:")) { shell.openSettings(target.removePrefix("settings:")); pendingOpen.value = null; return@LaunchedEffect }
        if (target.startsWith("voice:")) { shell.openVoice(target.removePrefix("voice:")); pendingOpen.value = null; return@LaunchedEffect }
        // wait for READY so the channel is known (opening an unknown id still works, it loads on its own)
        if (state.channels.containsKey(target) || state.conn == io.github.mrciller.cillhub.data.Conn.READY) { shell.openChannel(target); pendingOpen.value = null }
    }

    val entry by nav.currentBackStackEntryAsState()
    // grown to two panes (rotation, unfolding, window resize): the open chat moves into the list's detail pane
    LaunchedEffect(twoPane, entry) {
        if (twoPane) {
            val r = entry?.destination?.route
            if (r?.startsWith(ChatRoute::class.qualifiedName!!) == true || r?.startsWith(ForumRoute::class.qualifiedName!!) == true) {
                nav.popBackStack()
            }
        }
    }
    val dest = entry?.destination
    val topLevel = TABS.any { t -> dest?.route == t.route::class.qualifiedName }
    val badges = remember(state) {
        mapOf(
            ServersRoute to state.guilds.keys.sumOf { Sel.guildBadge(state, it).mentions },
            MessagesRoute to Sel.privateChannels(state).sumOf { Sel.mentions(state, it.id) },
            InboxRoute to Sel.unreadChannels(state).sumOf { Sel.mentions(state, it.id) },
        )
    }

    CompositionLocalProviderNav(shell) {
        val host: @Composable (Modifier) -> Unit = { mod ->
            val popEnter: AnimatedContentTransitionScope<NavBackStackEntry>.() -> EnterTransition = { if (reduce) EnterTransition.None else if (tabSwitch()) fadeIn(tween(150)) else slideInHorizontally(tween(260, easing = FastOutSlowInEasing)) { -it / 4 } }
            val popExit: AnimatedContentTransitionScope<NavBackStackEntry>.() -> ExitTransition = { if (reduce) ExitTransition.None else if (tabSwitch()) fadeOut(tween(90)) else slideOutHorizontally(tween(260, easing = FastOutSlowInEasing)) { it } }
            NavHost(
                nav, startDestination = ServersRoute, modifier = mod,
                // page slide, no fades: push brings the new page in from the right over the old one (old moves 1/4 left),
                // pop slides the closed page off to the right over the one beneath; tab to tab is a short cross-fade.
                enterTransition = { if (reduce) EnterTransition.None else if (tabSwitch()) fadeIn(tween(150)) else slideInHorizontally(tween(280, easing = FastOutSlowInEasing)) { it } },
                exitTransition = { if (reduce) ExitTransition.None else if (tabSwitch()) fadeOut(tween(90)) else slideOutHorizontally(tween(280, easing = FastOutSlowInEasing)) { -it / 4 } },
                popEnterTransition = popEnter,
                popExitTransition = popExit,
                // the back gesture scrubs the same pair (the library default would be its own shrinking card)
                predictivePopEnterTransition = { popEnter() },
                predictivePopExitTransition = { popExit() },
            ) {
                composable<ServersRoute> {
                    ServersScreen(guildId, { guildId = it }, if (twoPane) serverChannel else null)
                }
                composable<MessagesRoute> { MessagesScreen(if (twoPane) dmChannel else null) }
                composable<InboxRoute> { InboxScreen() }
                composable<YouRoute> { YouScreen() }
                composable<ChatRoute> { ChatScreen(it.toRoute<ChatRoute>().channelId, showBack = true) }
                composable<ForumRoute> { ForumScreen(it.toRoute<ForumRoute>().channelId, showBack = true) }
                composable<MembersRoute> { MembersScreen(it.toRoute<MembersRoute>().guildId) }
                composable<FriendsRoute> { FriendsScreen() }
                composable<SettingsRoute> { SettingsScreen(it.toRoute<SettingsRoute>().page) }
                composable<ChannelInfoRoute> { ChannelInfoScreen(it.toRoute<ChannelInfoRoute>().channelId) }
                composable<ChannelAccessRoute> { ChannelAccessScreen(it.toRoute<ChannelAccessRoute>().channelId) }
                composable<SearchRoute> { SearchScreen(it.toRoute<SearchRoute>().channelId) }
                composable<ServerSettingsRoute> { ServerSettingsScreen(it.toRoute<ServerSettingsRoute>().guildId) }
                composable<VoiceRoute> { it.toRoute<VoiceRoute>().let { r -> VoiceScreen(r.channelId, r.start) } }
            }
        }
        val onVoice = dest?.route?.startsWith(VoiceRoute::class.qualifiedName!!) == true
        val bar: @Composable () -> Unit = { if (!onVoice) VoiceBar { shell.openVoice(it) } }
        if (twoPane) Row(Modifier.fillMaxSize()) {
            NavigationRail(containerColor = MaterialTheme.colorScheme.surfaceContainerLowest) {
                TABS.forEach { t ->
                    val selected = dest?.hierarchy?.any { it.route == t.route::class.qualifiedName } == true
                    NavigationRailItem(selected, { nav.tab(t.route) }, icon = { TabIcon(t, selected, badges[t.route] ?: 0) }, label = { Text(s(t.label)) },
                        colors = NavigationRailItemDefaults.colors(indicatorColor = Color.Transparent, selectedTextColor = MaterialTheme.colorScheme.onSecondaryContainer),
                        modifier = Modifier.activeLine(selected, top = false))
                }
            }
            androidx.compose.foundation.layout.Column(Modifier.weight(1f)) { host(Modifier.weight(1f)); bar() }
        } else Scaffold(
            contentWindowInsets = WindowInsets(0),
            bottomBar = {
                androidx.compose.foundation.layout.Column {
                bar()
                if (topLevel) {
                    NavigationBar(containerColor = MaterialTheme.colorScheme.surfaceContainerLowest) {
                        TABS.forEach { t ->
                            val selected = dest?.hierarchy?.any { it.route == t.route::class.qualifiedName } == true
                            NavigationBarItem(selected, { nav.tab(t.route) }, icon = { TabIcon(t, selected, badges[t.route] ?: 0) }, label = { Text(s(t.label)) },
                                colors = NavigationBarItemDefaults.colors(indicatorColor = Color.Transparent, selectedTextColor = MaterialTheme.colorScheme.onSecondaryContainer),
                                modifier = Modifier.activeLine(selected, top = true))
                        }
                    }
                }
                }
            },
        ) { pad -> host(Modifier.padding(pad).consumeWindowInsets(pad)) }

        profile?.let { (u, g) -> ProfileSheet(u, g) { profile = null } }
        image?.let { (u, n) -> ImageViewer(u, n) { image = null } }
        link?.let { url ->
            AlertDialog(
                onDismissRequest = { link = null },
                title = { Text(s(R.string.leaving_title)) },
                text = { Text(s(R.string.leaving_text, url)) },
                confirmButton = { TextButton({ openUrl(ctx, url); link = null }, shape = MaterialTheme.shapes.small) { Text(s(R.string.leaving_visit)) } },
                dismissButton = { TextButton({ link = null }, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel)) } },
            )
        }
        // the server asks to accept its terms first; this app has no accept screen, the website does
        val gate by ApiError.termsGate.collectAsStateWithLifecycle()
        gate?.takeIf { it.isNotEmpty() }?.let { msg ->
            AlertDialog(
                onDismissRequest = { ApiError.termsGate.value = "" },
                title = { Text(s(R.string.terms_gate_title)) },
                text = { Text(msg) },
                confirmButton = { TextButton({ openUrl(ctx, io.github.mrciller.cillhub.Config.APP_URL); ApiError.termsGate.value = "" }, shape = MaterialTheme.shapes.small) { Text(s(R.string.terms_gate_open)) } },
                dismissButton = { TextButton({ ApiError.termsGate.value = "" }, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel)) } },
            )
        }
    }
}

@Composable
private fun CompositionLocalProviderNav(nav: Nav, content: @Composable () -> Unit) =
    androidx.compose.runtime.CompositionLocalProvider(LocalNav provides nav, content = content)

/** The active tab: a 2dp accent line on the top edge (bottom bar) or the leading edge (rail), no pill. */
@Composable
private fun Modifier.activeLine(selected: Boolean, top: Boolean): Modifier {
    val accent = MaterialTheme.colorScheme.primary
    return drawBehind { if (selected) drawRect(accent, size = if (top) Size(size.width, 2.dp.toPx()) else Size(2.dp.toPx(), size.height)) }
}

@Composable
private fun TabIcon(t: Tab, selected: Boolean, badge: Int) {
    val label = s(t.label)
    BadgedBox(badge = { if (badge > 0) Badge(containerColor = LocalExtra.current.badge, contentColor = Color.White) { Text(if (badge > 99) "99+" else badge.toString()) } },
        modifier = Modifier.semantics { if (badge > 0) contentDescription = "$label, $badge" }) {
        Ic(if (selected) t.selectedIcon else t.icon, null)
    }
}

private fun AnimatedContentTransitionScope<NavBackStackEntry>.tabSwitch() =
    listOf(initialState, targetState).all { e -> TABS.any { e.destination.route == it.route::class.qualifiedName } }

private fun NavHostController.tab(route: Any) = navigate(route) {
    popUpTo(graph.findStartDestination().id) { saveState = true }
    launchSingleTop = true
    restoreState = true
}

private val androidx.navigation.NavDestination.hierarchy get() = generateSequence(this) { it.parent }
