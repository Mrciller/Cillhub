package io.github.mrciller.cillhub.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.Message
import io.github.mrciller.cillhub.data.SearchResults
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.net.URLEncoder

private const val SEARCH_PAGE = 25 // the server's maximum

/** Message search in one channel (GET /channels/:id/messages/search); Jump opens the message in the chat. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(channelId: String) {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val nav = LocalNav.current
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    val ch = state.channels[channelId] ?: run { Loading(); return }
    var q by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<Message>?>(null) }
    var total by remember { mutableIntStateOf(0) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    // suspending, so a newer query cancels an older one before its results land
    suspend fun search(offset: Int) {
        busy = true; error = null
        try {
            val r = Session.rest.get<SearchResults>("/channels/$channelId/messages/search?limit=$SEARCH_PAGE&offset=$offset&content=" + URLEncoder.encode(q.trim(), "UTF-8"))
            // each hit comes as a one-message list
            results = (if (offset == 0) emptyList() else results.orEmpty()) + r.messages.mapNotNull { it.firstOrNull() }
            total = r.totalResults
        } catch (e: kotlinx.coroutines.CancellationException) { throw e
        } catch (e: Exception) { error = errorText(ctx, e)
        } finally { busy = false }
    }
    LaunchedEffect(Unit) { focus.requestFocus() }
    LaunchedEffect(q) {
        if (q.isBlank()) { results = null; return@LaunchedEffect }
        delay(400) // typing settles first
        search(0)
    }
    Scaffold(topBar = {
        TopAppBar(
            title = { Text(s(R.string.search_in, Sel.channelName(state, ch))) },
            navigationIcon = { IconButton(nav::back) { Ic(R.drawable.ms_arrow_back, s(R.string.back)) } },
        )
    }) { pad ->
        Column(Modifier.padding(pad).fillMaxSize()) {
            OutlinedTextField(q, { q = it.take(1024) }, placeholder = { Text(s(R.string.search_messages)) }, leadingIcon = { Ic(R.drawable.ms_search, null) }, singleLine = true,
                shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp).focusRequester(focus))
            val list = results
            when {
                error != null && list.isNullOrEmpty() -> Text(error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
                list == null && busy -> Loading()
                list == null -> EmptyState(R.drawable.ms_search, s(R.string.search_hint))
                list.isEmpty() -> EmptyState(R.drawable.ms_search, s(R.string.search_none))
                else -> LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(12.dp)) {
                    item(key = "count") {
                        Text(ctx.resources.getQuantityString(R.plurals.search_results, total, total), style = MaterialTheme.typography.titleSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 4.dp, bottom = 8.dp))
                    }
                    items(list, key = { it.id }) { m ->
                        Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth().padding(bottom = 8.dp)) {
                            Column {
                                MessageItem(state, m, true, ch.guildId, onLongPress = {}, onReply = {}, onReact = {}, onAddReaction = {}, onJump = {}, canReply = false)
                                Row(Modifier.fillMaxWidth().padding(end = 8.dp), horizontalArrangement = androidx.compose.foundation.layout.Arrangement.End) {
                                    TextButton({ nav.openMessage(m.channelId, m.id) }, shape = MaterialTheme.shapes.small) { Text(s(R.string.jump)) }
                                }
                            }
                        }
                    }
                    if (list.size < total) item(key = "more") {
                        Box(Modifier.fillMaxWidth().padding(16.dp), contentAlignment = Alignment.Center) {
                            if (busy) CircularProgressIndicator(Modifier.size(24.dp)) else TextButton({ scope.launch { search(list.size) } }, shape = MaterialTheme.shapes.small) { Text(s(R.string.load_more)) }
                        }
                    }
                }
            }
        }
    }
}
