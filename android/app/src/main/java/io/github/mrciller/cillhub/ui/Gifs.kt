package io.github.mrciller.cillhub.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
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
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import io.github.mrciller.cillhub.Config
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.FavoriteGif
import io.github.mrciller.cillhub.data.Message
import io.github.mrciller.cillhub.data.Session
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** favorite_gifs' format from the media URL. */
fun gifFormat(src: String) = when (src.substringBefore('?').substringAfterLast('.').lowercase()) {
    "gif" -> "gif"; "mp4" -> "mp4"; "webm" -> "webm"; else -> "image"
}

/** The GIF a message shows (a GIF link's embed, or a .gif attachment), as a favourite; null when it has none. */
fun gifOf(m: Message): FavoriteGif? {
    for (e in m.embeds) {
        // a picture, as the web client stars it: tiles are drawn as images; the server keeps only https links
        val media = e.image ?: e.thumbnail ?: continue
        val src = media.proxyUrl ?: media.url ?: continue
        val page = (e.url ?: media.url)?.takeIf { it.startsWith("https://") } ?: continue
        if (e.type == "gifv" || (e.type == "image" && gifFormat(media.url ?: src) == "gif"))
            return FavoriteGif(page, src, media.width ?: 0, media.height ?: 0, gifFormat(media.url ?: src))
    }
    val a = m.attachments.firstOrNull { it.contentType == "image/gif" || it.filename.lowercase().endsWith(".gif") } ?: return null
    return Config.cdn(a.url).let { FavoriteGif(it, a.url, a.width ?: 0, a.height ?: 0, "gif") }
}

/** GIF picker: trending or search results from the server's GIF route, and the favourites (star on every tile). */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun GifPicker(close: () -> Unit, send: (String) -> Unit) {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var tab by rememberSaveable { mutableStateOf(0) }
    var query by rememberSaveable { mutableStateOf("") }
    var results by remember { mutableStateOf<List<FavoriteGif>?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    LaunchedEffect(query) {
        delay(350) // typing settles before a search
        error = null
        try { results = Session.gifs(query).map { FavoriteGif(it.url, it.src, it.width, it.height, gifFormat(it.url)) } }
        catch (e: Exception) { error = errorText(ctx, e) }
    }
    ModalBottomSheet(close) {
        Column(Modifier.fillMaxWidth().height(560.dp).padding(horizontal = 12.dp)) {
            PrimaryTabRow(tab, containerColor = Color.Transparent) {
                Tab(tab == 0, { tab = 0 }, text = { Text(s(R.string.gifs)) })
                Tab(tab == 1, { tab = 1 }, text = { Text(s(R.string.gif_favorites)) })
            }
            if (tab == 0) OutlinedTextField(query, { query = it }, placeholder = { Text(s(R.string.gif_search)) }, singleLine = true,
                leadingIcon = { Ic(R.drawable.ms_search, null) }, shape = MaterialTheme.shapes.medium, modifier = Modifier.fillMaxWidth().padding(vertical = 8.dp))
            val list = if (tab == 1) state.favoriteGifs else results
            when {
                tab == 0 && error != null -> Text(error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(16.dp))
                list == null -> Loading()
                list.isEmpty() -> EmptyState(R.drawable.ms_gif, s(if (tab == 1) R.string.gif_no_favorites else R.string.gif_none))
                else -> LazyVerticalGrid(GridCells.Adaptive(150.dp), Modifier.fillMaxSize().padding(top = 8.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    items(list, key = { it.url }) { g ->
                        val fav = state.favoriteGifs.any { it.url == g.url }
                        Box(Modifier.fillMaxWidth().aspectRatio(if (g.width > 0 && g.height > 0) (g.width.toFloat() / g.height).coerceIn(0.5f, 2.5f) else 1f)
                            .clip(MaterialTheme.shapes.medium).background(MaterialTheme.colorScheme.surfaceContainerHighest)
                            .clickable(onClickLabel = s(R.string.gif_send)) { send(g.url); close() }) {
                            AsyncImage(Config.cdn(g.src), s(R.string.gif), Modifier.fillMaxSize(), contentScale = ContentScale.Crop)
                            IconButton({ scope.launch { runCatching { Session.toggleFavoriteGif(g) } } }, Modifier.align(Alignment.TopEnd)) {
                                Box(Modifier.clip(CircleShape).background(Color.Black.copy(alpha = 0.45f)).padding(4.dp)) {
                                    Ic(if (fav) R.drawable.ms_star_fill else R.drawable.ms_star, s(if (fav) R.string.gif_unfavorite else R.string.gif_favorite),
                                        tint = if (fav) LocalExtra.current.idle else Color.White)
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}
