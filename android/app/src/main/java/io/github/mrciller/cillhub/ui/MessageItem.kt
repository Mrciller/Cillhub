package io.github.mrciller.cillhub.ui

import android.app.DownloadManager
import android.content.ClipData
import android.content.Intent
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.PlaybackParams
import android.net.Uri
import android.os.Environment
import android.text.format.Formatter
import android.widget.Toast
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.sizeIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.SwipeToDismissBox
import androidx.compose.material3.SwipeToDismissBoxValue
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberSwipeToDismissBoxState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import io.github.mrciller.cillhub.Config
import io.github.mrciller.cillhub.Origins
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.Attachment
import io.github.mrciller.cillhub.data.Channel
import io.github.mrciller.cillhub.data.isThread
import io.github.mrciller.cillhub.data.Embed
import io.github.mrciller.cillhub.data.EmojiRef
import io.github.mrciller.cillhub.data.Message
import io.github.mrciller.cillhub.data.MessageEdit
import io.github.mrciller.cillhub.data.Perm
import io.github.mrciller.cillhub.data.Poll
import io.github.mrciller.cillhub.data.Reaction
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.Session
import io.github.mrciller.cillhub.data.State
import io.github.mrciller.cillhub.data.User
import io.github.mrciller.cillhub.data.FavoriteGif
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

enum class DiffType { UNCHANGED, ADDED, REMOVED }
data class DiffWord(val text: String, val type: DiffType)

fun diffWords(oldText: String, newText: String): List<DiffWord> {
    val oldWords = oldText.split(Regex("(?<=\\s)|(?=\\s)"))
    val newWords = newText.split(Regex("(?<=\\s)|(?=\\s)"))
    val n = oldWords.size
    val m = newWords.size
    val dp = Array(n + 1) { IntArray(m + 1) }
    for (i in 0 until n) {
        for (j in 0 until m) {
            dp[i + 1][j + 1] = if (oldWords[i] == newWords[j]) dp[i][j] + 1 else maxOf(dp[i + 1][j], dp[i][j + 1])
        }
    }
    val diff = mutableListOf<DiffWord>()
    var i = n
    var j = m
    while (i > 0 || j > 0) {
        if (i > 0 && j > 0 && oldWords[i - 1] == newWords[j - 1]) {
            diff.add(DiffWord(oldWords[i - 1], DiffType.UNCHANGED))
            i--; j--
        } else if (j > 0 && (i == 0 || dp[i][j - 1] >= dp[i - 1][j])) {
            diff.add(DiffWord(newWords[j - 1], DiffType.ADDED))
            j--
        } else if (i > 0) {
            diff.add(DiffWord(oldWords[i - 1], DiffType.REMOVED))
            i--
        }
    }
    return diff.reversed()
}

val QUICK_REACTIONS = listOf("👍", "❤️", "😂", "😮", "😢", "🔥")

@OptIn(ExperimentalFoundationApi::class, ExperimentalMaterial3Api::class)
@Composable
fun MessageItem(
    state: State, m: Message, header: Boolean, guildId: String?,
    onLongPress: () -> Unit, onReply: () -> Unit, onReact: (EmojiRef) -> Unit, onAddReaction: () -> Unit, onJump: (String) -> Unit, canReply: Boolean,
) {
    val nav = LocalNav.current
    val ctx = LocalContext.current
    val name = if (m.webhookId != null) m.author.displayName else Sel.memberName(state, guildId, m.author.id)
    val roleColor = Sel.roleColor(state, guildId, m.author.id)?.let { Color(0xFF000000 or it.toLong()) }
    val mentionsMe = remember(m, state.me) { io.github.mrciller.cillhub.data.Reducer.mentionsMe(state, m) && guildId != null }
    val blocked = Sel.isBlocked(state, m.author.id) && m.webhookId == null
    var showBlocked by rememberSaveable(m.id) { mutableStateOf(false) }
    var showEdits by rememberSaveable(m.id) { mutableStateOf(false) }

    if (m.type == 7) { // member joined
        Row(Modifier.fillMaxWidth().padding(start = 24.dp, end = 16.dp, top = 6.dp, bottom = 6.dp), verticalAlignment = Alignment.CenterVertically) {
            Ic(R.drawable.ms_arrow_back, null, Modifier.size(18.dp).alpha(0.8f).rotate(180f), LocalExtra.current.online)
            Spacer(Modifier.width(16.dp))
            Text(s(R.string.joined_server, name), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.weight(1f))
            Text(shortTime(m.timestamp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        return
    }

    val swipe = rememberSwipeToDismissBoxState()
    val a11yReply = s(R.string.reply)
    val a11yMore = s(R.string.message_actions)
    val timeText = messageTime(ctx, m.timestamp)
    LaunchedEffectSwipe(swipe) { if (canReply && !m.pending && !m.failed) onReply() }

    SwipeToDismissBox(
        swipe, enableDismissFromEndToStart = false, enableDismissFromStartToEnd = canReply && !m.pending && !m.failed,
        backgroundContent = {
            Box(Modifier.fillMaxWidth().fillMaxHeight().padding(start = 20.dp), contentAlignment = Alignment.CenterStart) {
                if (swipe.dismissDirection == SwipeToDismissBoxValue.StartToEnd) Ic(R.drawable.ms_reply, null, tint = MaterialTheme.colorScheme.primary)
            }
        },
    ) {
        val bar = LocalExtra.current.mention
        Column(
            Modifier.fillMaxWidth()
                .background(if (mentionsMe) LocalExtra.current.mentionBg else MaterialTheme.colorScheme.surfaceContainer)
                // a mention of us: tinted row with a bar on the leading edge
                .drawBehind { if (mentionsMe) drawRect(bar, size = androidx.compose.ui.geometry.Size(3.dp.toPx(), size.height)) }
                .combinedClickable(onClick = { if (m.failed) onLongPress() }, onLongClick = onLongPress, onLongClickLabel = a11yMore)
                .padding(start = 16.dp, end = 16.dp, top = if (header) 10.dp else 1.dp, bottom = 1.dp)
                .alpha(if (m.pending) 0.6f else 1f)
                .semantics(mergeDescendants = true) {
                    if (!header) contentDescription = "$name, $timeText"
                    customActions = listOfNotNull(
                        if (canReply) CustomAccessibilityAction(a11yReply) { onReply(); true } else null,
                        CustomAccessibilityAction(a11yMore) { onLongPress(); true },
                    )
                },
        ) {
        if (m.type == 19 && m.messageReference != null) ReplyPreview(state, m.referencedMessage, guildId) { m.referencedMessage?.let { onJump(it.id) } }
        Row {
            if (header) Box(Modifier.size(40.dp).clip(androidx.compose.foundation.shape.CircleShape).clickable(onClickLabel = s(R.string.view_profile)) { nav.openProfile(m.author.id, guildId) }) { Avatar(m.author.let { state.users[it.id] ?: it }, 40.dp) }
            else Spacer(Modifier.width(40.dp))
            Spacer(Modifier.width(12.dp))
            Column(Modifier.weight(1f)) {
                if (header) Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(name, fontWeight = FontWeight.SemiBold, color = roleColor ?: MaterialTheme.colorScheme.onSurface, maxLines = 1, overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false).clickable(onClickLabel = s(R.string.view_profile)) { nav.openProfile(m.author.id, guildId) })
                    UserTags(state.users[m.author.id] ?: m.author, app = m.author.bot || m.webhookId != null)
                    Spacer(Modifier.width(8.dp))
                    Text(timeText, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1)
                }
                if (blocked && !showBlocked) {
                    Text(s(R.string.blocked_message), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.clickable { showBlocked = true }.padding(vertical = 4.dp))
                    return@Column
                }
                if (state.channels[m.channelId]?.solvedMessageId == m.id) {
                    Surface(
                        color = MaterialTheme.colorScheme.primaryContainer,
                        shape = MaterialTheme.shapes.small,
                        modifier = Modifier.padding(bottom = 4.dp),
                    ) {
                        Row(
                            Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Ic(R.drawable.ms_check, null, Modifier.size(14.dp), MaterialTheme.colorScheme.onPrimaryContainer)
                            Spacer(Modifier.width(4.dp))
                            Text(s(R.string.accepted_solution), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onPrimaryContainer)
                        }
                    }
                }
                // a bare GIF or image link shows only its embed
                val bareMedia = m.embeds.singleOrNull()?.let { it.url == m.content.trim() && it.type in setOf("gifv", "image") } == true
                if (m.content.isNotEmpty() && !bareMedia) MarkdownText(m.content, state, guildId)
                if (m.editedTimestamp != null) {
                    Text(
                        "(${s(R.string.edited)})",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.primary,
                        modifier = Modifier.clickable(onClickLabel = s(R.string.edit_history)) { showEdits = true }.padding(vertical = 2.dp),
                    )
                }
                for (a in m.attachments) AttachmentView(a)
                for (e in m.embeds) EmbedView(e, state, guildId)
                for (st in m.stickerItems) AsyncImage(Config.cdn("/stickers/${st.id}.png"), st.name, Modifier.padding(top = 4.dp).size(160.dp))
                if (m.poll != null) PollCard(m.channelId, m, m.poll)
                if (m.failed) Text(s(R.string.not_sent), color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
                if (m.reactions.isNotEmpty()) {
                    val perms = Sel.perms(state, guildId, state.channels[m.channelId])
                    Reactions(m.reactions, onReact, onAddReaction, canAdd = Sel.canAddReaction(perms), canToggleOthers = Perm.has(perms, Perm.READ_MESSAGE_HISTORY))
                }
            }
        }
        }
    }
    if (showEdits) {
        EditHistorySheet(m.channelId, m.id) { showEdits = false }
    }
}

/** Swiping a message to the right replies to it; the row springs back. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun LaunchedEffectSwipe(state: androidx.compose.material3.SwipeToDismissBoxState, onSwiped: () -> Unit) {
    val haptic = androidx.compose.ui.platform.LocalHapticFeedback.current
    androidx.compose.runtime.LaunchedEffect(state.currentValue) {
        if (state.currentValue == SwipeToDismissBoxValue.StartToEnd) {
            haptic.performHapticFeedback(androidx.compose.ui.hapticfeedback.HapticFeedbackType.GestureThresholdActivate)
            onSwiped()
            state.reset()
        }
    }
}

/** The APP tag of bots and webhooks, and the server tag a user chose to show. */
@Composable
fun UserTags(u: User?, app: Boolean = u?.bot == true) {
    @Composable fun chip(text: String, bg: Color, fg: Color) = Surface(color = bg, shape = MaterialTheme.shapes.extraSmall, modifier = Modifier.padding(start = 6.dp)) {
        Text(text, color = fg, fontSize = 10.sp, fontWeight = FontWeight.Bold, maxLines = 1, modifier = Modifier.padding(horizontal = 4.dp))
    }
    if (app) chip(s(R.string.app_tag), MaterialTheme.colorScheme.primary, MaterialTheme.colorScheme.onPrimary)
    u?.primaryGuild?.tag?.takeIf { it.isNotBlank() }?.let { chip(it, MaterialTheme.colorScheme.surfaceContainerHighest, MaterialTheme.colorScheme.onSurfaceVariant) }
}

/** The replied-to message above a reply, joined to the avatar by a curved line. */
@Composable
private fun ReplyPreview(state: State, ref: Message?, guildId: String?, onClick: () -> Unit) {
    val line = MaterialTheme.colorScheme.outline
    Row(Modifier.heightIn(min = 22.dp).padding(bottom = 2.dp).clickable(onClickLabel = s(R.string.jump_to_reply), onClick = onClick), verticalAlignment = Alignment.CenterVertically) {
        Box(Modifier.width(52.dp).height(22.dp).drawBehind {
            val x = 20.dp.toPx(); val y = size.height / 2; val r = 6.dp.toPx(); val w = 2.dp.toPx()
            val path = androidx.compose.ui.graphics.Path().apply {
                moveTo(x, size.height + 2.dp.toPx()); lineTo(x, y + r); quadraticTo(x, y, x + r, y); lineTo(size.width - 6.dp.toPx(), y)
            }
            drawPath(path, line, style = androidx.compose.ui.graphics.drawscope.Stroke(w))
        })
        if (ref == null) Text(s(R.string.original_deleted), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        else {
            Avatar(state.users[ref.author.id] ?: ref.author, 16.dp)
            Spacer(Modifier.width(4.dp))
            Text("@" + Sel.memberName(state, guildId, ref.author.id), style = MaterialTheme.typography.bodySmall, fontWeight = FontWeight.SemiBold, maxLines = 1,
                color = Sel.roleColor(state, guildId, ref.author.id)?.let { Color(0xFF000000 or it.toLong()) } ?: MaterialTheme.colorScheme.onSurface)
            Spacer(Modifier.width(6.dp))
            Text(io.github.mrciller.cillhub.data.Md.plain(ref.content) { n -> if (n is io.github.mrciller.cillhub.data.Md.UserMention) "@" + Sel.memberName(state, guildId, n.id) else "" }.ifBlank { s(R.string.attachment) }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun AttachmentView(a: Attachment) {
    val nav = LocalNav.current
    val ctx = LocalContext.current
    val url = Config.cdn(a.url)
    val isAudio = a.contentType?.startsWith("audio/") == true || a.filename.substringAfterLast('.').lowercase() in listOf("mp3", "wav", "ogg", "m4a", "flac", "opus", "aac")
    if (isAudio) {
        AudioPlayerView(url = url, durationSecs = a.durationSecs, filename = a.filename)
        return
    }
    var reveal by rememberSaveable(a.id) { mutableStateOf(!a.spoiler) }
    val image = a.contentType?.startsWith("image/") == true || a.filename.substringAfterLast('.').lowercase() in Attachment.IMAGE_EXT
    if (image) {
        val ratio = if ((a.width ?: 0) > 0 && (a.height ?: 0) > 0) a.width!!.toFloat() / a.height!! else 4f / 3
        Box(
            Modifier.padding(top = 4.dp).widthIn(max = 320.dp).heightIn(max = 320.dp).aspectRatio(ratio.coerceIn(0.4f, 3f), matchHeightConstraintsFirst = ratio < 1f)
                .clip(MaterialTheme.shapes.medium).background(MaterialTheme.colorScheme.surfaceContainerHighest)
                .clickable(onClickLabel = s(if (reveal) R.string.view_image else R.string.reveal_spoiler)) { if (reveal) nav.openImage(url, a.filename) else reveal = true },
        ) {
            if (reveal) AsyncImage(url, a.description ?: a.filename, Modifier.matchParentSize(), contentScale = ContentScale.Crop)
            else Text(s(R.string.spoiler), Modifier.align(Alignment.Center), fontWeight = FontWeight.Bold)
        }
    } else Surface(
        onClick = { download(ctx, url, a.filename) },
        color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.padding(top = 4.dp).widthIn(max = 360.dp).fillMaxWidth(),
    ) {
        Row(Modifier.padding(12.dp), verticalAlignment = Alignment.CenterVertically) {
            Ic(R.drawable.ms_description, null, Modifier.size(32.dp), MaterialTheme.colorScheme.primary)
            Column(Modifier.weight(1f).padding(horizontal = 12.dp)) {
                Text(a.filename, maxLines = 1, overflow = TextOverflow.Ellipsis, color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Medium)
                Text(Formatter.formatShortFileSize(ctx, a.size), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Ic(R.drawable.ms_download, s(R.string.download))
        }
    }
}

private fun Modifier.matchParentSize() = this.then(Modifier.fillMaxWidth().fillMaxHeight())

/** Files from the server go to Downloads through the system download manager; anything else opens in the browser. */
fun download(ctx: android.content.Context, url: String, name: String) {
    if (Origins.of(url) != Config.ORIGIN) { openUrl(ctx, url); return }
    try {
        val req = DownloadManager.Request(Uri.parse(url)).setTitle(name)
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name.replace('/', '_'))
        ctx.getSystemService(DownloadManager::class.java).enqueue(req)
        Toast.makeText(ctx, ctx.getString(R.string.downloading, name), Toast.LENGTH_SHORT).show()
    } catch (e: Exception) {
        openUrl(ctx, url)
    }
}

/** Embed media only through the server's proxy (or its own root-relative URL), never from the third-party host directly. */
private fun proxied(m: io.github.mrciller.cillhub.data.EmbedMedia?): String? =
    (m?.proxyUrl ?: m?.url?.takeIf { it.startsWith("/") && !it.startsWith("//") })?.let(Config::cdn)

@Composable
private fun EmbedView(e: Embed, state: State, guildId: String?) {
    val nav = LocalNav.current
    val ctx = LocalContext.current
    if (e.type == "image" && e.thumbnail?.url != null && e.title == null) { // a bare image link
        val u = proxied(e.thumbnail) ?: return
        AsyncImage(u, null, Modifier.padding(top = 4.dp).widthIn(max = 320.dp).heightIn(max = 320.dp).clip(MaterialTheme.shapes.medium).clickable { nav.openImage(u, "image") })
        return
    }
    val bar = e.color?.let { Color(0xFF000000 or it.toLong()) } ?: MaterialTheme.colorScheme.outline
    Row(Modifier.padding(top = 4.dp).widthIn(max = 420.dp).height(IntrinsicSize.Min).clip(MaterialTheme.shapes.small).background(MaterialTheme.colorScheme.surfaceContainerHigh)) {
        Box(Modifier.width(4.dp).fillMaxHeight().background(bar))
        Column(Modifier.weight(1f).padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            e.provider?.name?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            e.author?.name?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.labelLarge) }
            e.title?.let { t -> Text(t, fontWeight = FontWeight.SemiBold, color = if (e.url != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                modifier = if (e.url != null) Modifier.clickable(onClickLabel = s(R.string.open_link)) { io.github.mrciller.cillhub.data.Md.safeUrl(e.url)?.let { openUrl(ctx, it) } } else Modifier) }
            e.description?.takeIf { it.isNotBlank() }?.let { MarkdownText(it, state, guildId, style = MaterialTheme.typography.bodyMedium) }
            for (f in e.fields) Column {
                Text(f.name, style = MaterialTheme.typography.labelLarge)
                MarkdownText(f.value, state, guildId, style = MaterialTheme.typography.bodyMedium)
            }
            val img = e.image ?: e.thumbnail?.takeIf { e.type == "video" || e.type == "article" && e.image == null }
            proxied(img)?.let { full ->
                AsyncImage(full, null, Modifier.fillMaxWidth().heightIn(max = 240.dp).clip(MaterialTheme.shapes.small).clickable { nav.openImage(full, "image") }, contentScale = ContentScale.Fit)
            }
            e.footer?.text?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant) }
        }
        if (e.image == null && e.type != "video" && e.type != "article") proxied(e.thumbnail)?.let { u ->
            AsyncImage(u, null, Modifier.padding(12.dp).size(72.dp).clip(MaterialTheme.shapes.small), contentScale = ContentScale.Crop)
        }
    }
}

@Composable
fun EmojiGlyph(e: EmojiRef, size: androidx.compose.ui.unit.Dp = 20.dp) {
    if (e.id != null) AsyncImage(Config.cdn("/emojis/${e.id}.${if (e.animated) "gif" else "png"}"), ":${e.name}:", Modifier.size(size))
    else Text(e.name, fontSize = (size.value * 0.8f).sp)
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Reactions(list: List<Reaction>, onReact: (EmojiRef) -> Unit, onAdd: () -> Unit, canAdd: Boolean = true, canToggleOthers: Boolean = true) {
    val ctx = LocalContext.current
    FlowRow(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for (r in list) {
            val desc = ctx.resources.getQuantityString(R.plurals.reactions, r.count, r.emoji.name, r.count) + if (r.me) ", " + ctx.getString(R.string.you_reacted) else ""
            FilterChip(
                selected = r.me, onClick = { if (r.me || canToggleOthers) onReact(r.emoji) },
                enabled = r.me || canToggleOthers,
                label = { Text(r.count.toString(), fontWeight = FontWeight.SemiBold) },
                leadingIcon = { EmojiGlyph(r.emoji, 18.dp) },
                shape = MaterialTheme.shapes.small,
                modifier = Modifier.semantics(mergeDescendants = true) { contentDescription = desc },
                colors = FilterChipDefaults.filterChipColors(selectedContainerColor = MaterialTheme.colorScheme.primaryContainer, selectedLabelColor = MaterialTheme.colorScheme.onPrimaryContainer),
            )
        }
        if (canAdd) FilterChip(false, onAdd, shape = MaterialTheme.shapes.small, label = { Ic(R.drawable.ms_add_reaction, s(R.string.add_reaction), Modifier.size(18.dp)) })
    }
}

/** Long-press: quick reactions and the message actions in a bottom sheet. */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalLayoutApi::class)
@Composable
fun MessageActions(
    state: State,
    m: Message,
    ch: Channel,
    perms: Long,
    vm: ChatViewModel,
    onClose: () -> Unit,
    onPickReaction: () -> Unit,
    onDelete: () -> Unit,
    onShowEdits: (() -> Unit)? = null,
) {
    val mine = m.author.id == state.me?.id
    val clipboard = LocalClipboard.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val canReact = Sel.canAddReaction(perms)
    val isThread = ch.isThread || ch.type == 11 || ch.parentId != null
    val canSolve = isThread && (ch.ownerId == state.me?.id || Perm.has(perms, Perm.MANAGE_THREADS))

    ModalBottomSheet(onDismissRequest = onClose, containerColor = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.padding(bottom = 16.dp)) {
            if (!m.pending && !m.failed && canReact) Row(Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 8.dp), horizontalArrangement = Arrangement.SpaceBetween) {
                for (e in QUICK_REACTIONS) Surface(onClick = { vm.react(m, EmojiRef(name = e)); onClose() }, shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerHighest, modifier = Modifier.size(48.dp)) {
                    Box(contentAlignment = Alignment.Center) { Text(e, fontSize = 22.sp, modifier = Modifier.semantics { contentDescription = e }) }
                }
                Surface(onClick = { onClose(); onPickReaction() }, shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceContainerHighest, modifier = Modifier.size(48.dp)) {
                    Box(contentAlignment = Alignment.Center) { Ic(R.drawable.ms_add_reaction, s(R.string.add_reaction)) }
                }
            }
            @Composable fun action(icon: Int, label: Int, color: Color = MaterialTheme.colorScheme.onSurface, f: () -> Unit) =
                ListItem(headlineContent = { Text(s(label), color = color) }, leadingContent = { Ic(icon, null, tint = color) },
                    colors = ListItemDefaults.colors(containerColor = Color.Transparent), modifier = Modifier.clickable { f(); onClose() })
            if (m.failed) {
                action(R.drawable.ms_refresh, R.string.try_again) { vm.retry(m) }
                action(R.drawable.ms_delete, R.string.delete, MaterialTheme.colorScheme.error) { io.github.mrciller.cillhub.data.Session.discard(m) }
                return@Column
            }
            if (m.pending) return@Column
            if (canSolve) {
                if (ch.solvedMessageId == m.id) {
                    action(R.drawable.ms_check, R.string.unmark_solution) {
                        scope.launch { runCatching { Session.setSolvedMessage(ch.id, null) } }
                    }
                } else {
                    action(R.drawable.ms_check, R.string.mark_as_solution) {
                        scope.launch { runCatching { Session.setSolvedMessage(ch.id, m.id) } }
                    }
                }
            }
            if (Perm.has(perms, Perm.SEND_MESSAGES)) action(R.drawable.ms_reply, R.string.reply) { vm.replyTo = m; vm.editing = null }
            if (mine && m.type in setOf(0, 19)) action(R.drawable.ms_edit, R.string.edit) { vm.startEdit(m) }
            if (m.editedTimestamp != null && onShowEdits != null) action(R.drawable.ms_history, R.string.edit_history) { onShowEdits() }
            gifOf(m)?.let { gif ->
                val fav = state.favoriteGifs.any { it.url == gif.url }
                action(if (fav) R.drawable.ms_star_fill else R.drawable.ms_star, if (fav) R.string.gif_unfavorite else R.string.gif_favorite) { vm.favorite(gif) }
            }
            if (m.content.isNotEmpty()) action(R.drawable.ms_content_copy, R.string.copy_text) { scope.launch { clipboard.setClipEntry(ClipEntry(ClipData.newPlainText("message", m.content))) } }
            if (mine || Perm.has(perms, Perm.MANAGE_MESSAGES)) action(R.drawable.ms_delete, R.string.delete, MaterialTheme.colorScheme.error) { onDelete() }
        }
    }
}

/** Any emoji from the keyboard (the system emoji keyboard is the picker in this phase). */
@Composable
fun ReactionPicker(close: () -> Unit, pick: (EmojiRef) -> Unit) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = close,
        title = { Text(s(R.string.add_reaction).uppercase()) },
        text = {
            Column {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    for (e in QUICK_REACTIONS) TextButton({ pick(EmojiRef(name = e)) }, Modifier.sizeIn(minWidth = 48.dp, minHeight = 48.dp), shape = MaterialTheme.shapes.small) { Text(e, fontSize = 22.sp) }
                }
                OutlinedTextField(text, { text = it.trim() }, label = { Text(s(R.string.emoji_from_keyboard)) }, singleLine = true, modifier = Modifier.fillMaxWidth().padding(top = 8.dp))
            }
        },
        confirmButton = { TextButton({ pick(EmojiRef(name = text)) }, enabled = text.isNotEmpty() && text.length <= 16, shape = MaterialTheme.shapes.small) { Text(s(R.string.react).uppercase()) } },
        dismissButton = { TextButton(close, shape = MaterialTheme.shapes.small) { Text(s(R.string.cancel).uppercase()) } },
    )
}

/**
 * Native Compose Audio & Voice Message Player (Task 6.15):
 * Interactive MediaPlayer with scrubber and speed toggle (0.5x..2x).
 */
@Composable
fun AudioPlayerView(url: String, durationSecs: Float? = null, filename: String? = null) {
    val ctx = LocalContext.current
    var isPlaying by remember { mutableStateOf(false) }
    var currentPos by remember { mutableStateOf(0) }
    var totalDur by remember { mutableStateOf((durationSecs?.times(1000))?.toInt() ?: 0) }
    var speedIndex by remember { mutableStateOf(2) } // 0: 0.5x, 1: 0.75x, 2: 1x, 3: 1.25x, 4: 1.5x, 5: 2x
    val speeds = listOf(0.5f, 0.75f, 1.0f, 1.25f, 1.5f, 2.0f)
    val speedLabels = listOf("0.5x", "0.75x", "1x", "1.25x", "1.5x", "2x")
    var player by remember { mutableStateOf<MediaPlayer?>(null) }

    DisposableEffect(url) {
        val mp = MediaPlayer().apply {
            setAudioAttributes(
                AudioAttributes.Builder()
                    .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                    .setUsage(AudioAttributes.USAGE_MEDIA)
                    .build()
            )
            try {
                setDataSource(url)
                prepareAsync()
            } catch (e: Exception) {}
            setOnPreparedListener {
                if (totalDur == 0) totalDur = duration
                if (speedIndex != 2) {
                    try {
                        playbackParams = PlaybackParams().apply { speed = speeds[speedIndex] }
                    } catch (e: Exception) {}
                }
            }
            setOnCompletionListener {
                isPlaying = false
                currentPos = 0
            }
        }
        player = mp
        onDispose {
            runCatching {
                mp.stop()
                mp.release()
            }
            player = null
        }
    }

    LaunchedEffect(isPlaying) {
        while (isPlaying) {
            player?.let { mp ->
                if (mp.isPlaying) {
                    currentPos = mp.currentPosition
                    if (totalDur == 0 && mp.duration > 0) totalDur = mp.duration
                }
            }
            delay(100)
        }
    }

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.large,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.padding(top = 4.dp).widthIn(max = 360.dp).fillMaxWidth(),
    ) {
        Column(Modifier.padding(12.dp)) {
            if (!filename.isNullOrBlank()) {
                Text(
                    filename,
                    style = MaterialTheme.typography.labelMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.padding(bottom = 6.dp),
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                IconButton(
                    onClick = {
                        player?.let { mp ->
                            if (isPlaying) {
                                mp.pause()
                                isPlaying = false
                            } else {
                                mp.start()
                                isPlaying = true
                            }
                        }
                    },
                    modifier = Modifier.size(40.dp).background(MaterialTheme.colorScheme.primaryContainer, androidx.compose.foundation.shape.CircleShape),
                ) {
                    Ic(
                        if (isPlaying) R.drawable.ms_pause else R.drawable.ms_play_arrow,
                        s(if (isPlaying) R.string.pause else R.string.play),
                        tint = MaterialTheme.colorScheme.onPrimaryContainer,
                    )
                }

                Spacer(Modifier.width(8.dp))

                Column(Modifier.weight(1f)) {
                    val progress = if (totalDur > 0) (currentPos.toFloat() / totalDur).coerceIn(0f, 1f) else 0f
                    Slider(
                        value = progress,
                        onValueChange = { frac ->
                            val seekTo = (frac * totalDur).toInt()
                            currentPos = seekTo
                            player?.seekTo(seekTo)
                        },
                        modifier = Modifier.fillMaxWidth().height(24.dp),
                    )
                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                        Text(formatDurationMs(currentPos), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(formatDurationMs(totalDur), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }

                Spacer(Modifier.width(8.dp))

                FilterChip(
                    selected = false,
                    onClick = {
                        speedIndex = (speedIndex + 1) % speeds.size
                        player?.let { mp ->
                            try {
                                mp.playbackParams = PlaybackParams().apply { speed = speeds[speedIndex] }
                            } catch (e: Exception) {}
                        }
                    },
                    label = { Text(speedLabels[speedIndex], fontWeight = FontWeight.Bold, fontSize = 11.sp) },
                    modifier = Modifier.height(32.dp),
                )
            }
        }
    }
}

private fun formatDurationMs(ms: Int): String {
    val totalSec = ms / 1000
    val m = totalSec / 60
    val s = totalSec % 60
    return "%d:%02d".format(m, s)
}

/**
 * Native Poll Card (Tasks 6.6 & 6.16):
 * Interactive voting, vote bars, Quiz mode reveal, anonymous/role-restricted badges, and CSV export.
 */
@Composable
fun PollCard(channelId: String, message: Message, poll: Poll) {
    val state by Session.store.state.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val ctx = LocalContext.current
    var busy by remember { mutableStateOf(false) }

    val results = poll.results
    val isFinalized = results?.isFinalized == true
    val totalVotes = results?.answerCounts?.sumOf { it.count } ?: 0
    val counts = remember(results) { results?.answerCounts?.associate { it.id to it.count }.orEmpty() }
    val myVotes = remember(results) { results?.answerCounts?.filter { it.meVoted }?.map { it.id }?.toSet().orEmpty() }
    val isAuthor = message.author.id == state.me?.id
    val showQuizCorrect = poll.isQuiz == true && (isFinalized || myVotes.isNotEmpty() || isAuthor)

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.large,
        border = androidx.compose.foundation.BorderStroke(1.dp, MaterialTheme.colorScheme.outlineVariant),
        modifier = Modifier.padding(top = 4.dp).widthIn(max = 440.dp).fillMaxWidth(),
    ) {
        Column(Modifier.padding(14.dp)) {
            // Badges row
            Row(
                Modifier.fillMaxWidth().padding(bottom = 6.dp),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                if (poll.isQuiz == true) {
                    Surface(color = MaterialTheme.colorScheme.tertiaryContainer, shape = MaterialTheme.shapes.small) {
                        Text(s(R.string.poll_quiz), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Bold, color = MaterialTheme.colorScheme.onTertiaryContainer, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
                    }
                }
                if (poll.anonymous == true) {
                    Surface(color = MaterialTheme.colorScheme.secondaryContainer, shape = MaterialTheme.shapes.small) {
                        Text(s(R.string.poll_anonymous), style = MaterialTheme.typography.labelSmall, fontWeight = FontWeight.Medium, color = MaterialTheme.colorScheme.onSecondaryContainer, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
                    }
                }
                if (!poll.allowedRoleIds.isNullOrEmpty()) {
                    Surface(color = MaterialTheme.colorScheme.surfaceContainerHighest, shape = MaterialTheme.shapes.small) {
                        Text(s(R.string.poll_role_restricted), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp))
                    }
                }
                Spacer(Modifier.weight(1f))
                if (isFinalized) {
                    Text(s(R.string.poll_closed), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error, fontWeight = FontWeight.Bold)
                }
            }

            // Question
            Text(poll.question.text ?: "", fontWeight = FontWeight.Bold, style = MaterialTheme.typography.titleMedium, modifier = Modifier.padding(bottom = 10.dp))

            // Answers
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                for (ans in poll.answers) {
                    val count = counts[ans.answerId] ?: 0
                    val pct = if (totalVotes > 0) count.toFloat() / totalVotes else 0f
                    val voted = myVotes.contains(ans.answerId)
                    val isCorrect = ans.answerId == poll.correctAnswerId

                    val borderColor = when {
                        showQuizCorrect && isCorrect -> LocalExtra.current.online
                        voted -> MaterialTheme.colorScheme.primary
                        else -> MaterialTheme.colorScheme.outlineVariant
                    }

                    Surface(
                        onClick = {
                            if (!isFinalized && !busy) {
                                scope.launch {
                                    busy = true
                                    try {
                                        Session.votePoll(message, listOf(ans.answerId))
                                    } catch (e: Exception) {
                                        Toast.makeText(ctx, errorText(ctx, e), Toast.LENGTH_SHORT).show()
                                    } finally {
                                        busy = false
                                    }
                                }
                            }
                        },
                        shape = MaterialTheme.shapes.medium,
                        border = androidx.compose.foundation.BorderStroke(if (voted || (showQuizCorrect && isCorrect)) 2.dp else 1.dp, borderColor),
                        color = MaterialTheme.colorScheme.surfaceContainerLow,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Box(Modifier.fillMaxWidth()) {
                            // Progress bar fill
                            if (totalVotes > 0 || isFinalized) {
                                Box(
                                    Modifier
                                        .fillMaxWidth(pct)
                                        .matchParentSize()
                                        .background(if (showQuizCorrect && isCorrect) LocalExtra.current.online.copy(alpha = 0.2f) else MaterialTheme.colorScheme.primary.copy(alpha = 0.15f)),
                                )
                            }
                            Row(
                                Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 10.dp),
                                verticalAlignment = Alignment.CenterVertically,
                            ) {
                                if (ans.pollMedia.emoji != null) {
                                    EmojiGlyph(ans.pollMedia.emoji, 20.dp)
                                    Spacer(Modifier.width(8.dp))
                                }
                                Text(
                                    ans.pollMedia.text ?: "",
                                    style = MaterialTheme.typography.bodyMedium,
                                    fontWeight = if (voted) FontWeight.Bold else FontWeight.Normal,
                                    modifier = Modifier.weight(1f),
                                )
                                if (showQuizCorrect && isCorrect) {
                                    Text("✓ " + s(R.string.poll_correct_answer), color = LocalExtra.current.online, fontWeight = FontWeight.Bold, style = MaterialTheme.typography.labelSmall, modifier = Modifier.padding(end = 6.dp))
                                }
                                if (voted) {
                                    Text("✓", color = MaterialTheme.colorScheme.primary, fontWeight = FontWeight.Bold, modifier = Modifier.padding(end = 6.dp))
                                }
                                if (totalVotes > 0 || isFinalized) {
                                    Text(
                                        "${(pct * 100).toInt()}% ($count)",
                                        style = MaterialTheme.typography.labelMedium,
                                        fontWeight = FontWeight.SemiBold,
                                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                                    )
                                }
                            }
                        }
                    }
                }
            }

            // Footer
            Row(
                Modifier.fillMaxWidth().padding(top = 10.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    ctx.resources.getQuantityString(R.plurals.poll_total_votes, totalVotes, totalVotes),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )

                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    // Export CSV
                    TextButton(
                        onClick = {
                            val csv = buildString {
                                append("Answer,Votes,Percentage\n")
                                for (ans in poll.answers) {
                                    val count = counts[ans.answerId] ?: 0
                                    val pct = if (totalVotes > 0) (count * 100) / totalVotes else 0
                                    append("\"${(ans.pollMedia.text ?: "").replace("\"", "\"\"")}\",$count,$pct%\n")
                                }
                            }
                            val intent = Intent(Intent.ACTION_SEND).apply {
                                type = "text/csv"
                                putExtra(Intent.EXTRA_TEXT, csv)
                                putExtra(Intent.EXTRA_SUBJECT, poll.question.text ?: "")
                            }
                            ctx.startActivity(Intent.createChooser(intent, ctx.getString(R.string.share_poll_results)))
                        },
                        shape = MaterialTheme.shapes.small,
                    ) {
                        Text(s(R.string.poll_export_csv).uppercase(), style = MaterialTheme.typography.labelSmall)
                    }

                    // End Poll (if author and not finalized)
                    if (isAuthor && !isFinalized) {
                        TextButton(
                            onClick = {
                                scope.launch {
                                    busy = true
                                    try {
                                        Session.expirePoll(message)
                                    } catch (e: Exception) {
                                        Toast.makeText(ctx, errorText(ctx, e), Toast.LENGTH_SHORT).show()
                                    } finally {
                                        busy = false
                                    }
                                }
                            },
                            enabled = !busy, shape = MaterialTheme.shapes.small,
                        ) {
                            Text(s(R.string.poll_end).uppercase(), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.error)
                        }
                    }
                }
            }
        }
    }
}

/**
 * Edit History Bottom Sheet (Task 6.2):
 * Displays message revisions with word-level diffs.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun EditHistorySheet(channelId: String, messageId: String, onClose: () -> Unit) {
    var edits by remember { mutableStateOf<List<MessageEdit>?>(null) }
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    val ctx = LocalContext.current

    LaunchedEffect(channelId, messageId) {
        loading = true
        error = null
        try {
            edits = Session.fetchMessageEdits(channelId, messageId)
        } catch (e: Exception) {
            error = errorText(ctx, e)
        } finally {
            loading = false
        }
    }

    ModalBottomSheet(onDismissRequest = onClose, containerColor = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.padding(horizontal = 16.dp, vertical = 8.dp).fillMaxWidth().padding(bottom = 24.dp)) {
            Text(s(R.string.edit_history), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold, modifier = Modifier.padding(bottom = 12.dp))

            when {
                loading -> Box(Modifier.fillMaxWidth().height(120.dp), contentAlignment = Alignment.Center) { androidx.compose.material3.CircularProgressIndicator() }
                error != null -> Text(error!!, color = MaterialTheme.colorScheme.error, modifier = Modifier.padding(8.dp))
                edits.isNullOrEmpty() -> Text(s(R.string.no_edit_history), color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(8.dp))
                else -> {
                    val list = edits!!
                    LazyColumn(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                        itemsIndexed(list) { index, edit ->
                            val prevContent = if (index + 1 < list.size) list[index + 1].content else ""
                            Surface(
                                shape = MaterialTheme.shapes.medium,
                                color = MaterialTheme.colorScheme.surfaceContainerHigh,
                                modifier = Modifier.fillMaxWidth(),
                            ) {
                                Column(Modifier.padding(12.dp)) {
                                    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                                        Text(
                                            if (index == list.size - 1) s(R.string.original_version) else s(R.string.edit_revision, list.size - index),
                                            style = MaterialTheme.typography.labelMedium,
                                            fontWeight = FontWeight.Bold,
                                            color = MaterialTheme.colorScheme.primary,
                                        )
                                        Text(
                                            messageTime(ctx, edit.editedAt),
                                            style = MaterialTheme.typography.labelSmall,
                                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                                        )
                                    }
                                    Spacer(Modifier.height(8.dp))
                                    if (prevContent.isNotBlank()) {
                                        val diff = remember(edit.content, prevContent) { diffWords(prevContent, edit.content) }
                                        DiffTextView(diff)
                                    } else {
                                        Text(edit.content, style = MaterialTheme.typography.bodyMedium)
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun DiffTextView(diff: List<DiffWord>) {
    val text = buildAnnotatedString {
        for (w in diff) {
            when (w.type) {
                DiffType.UNCHANGED -> append(w.text)
                DiffType.ADDED -> withStyle(SpanStyle(color = LocalExtra.current.online, background = LocalExtra.current.online.copy(alpha = 0.2f), fontWeight = FontWeight.Medium)) {
                    append(w.text)
                }
                DiffType.REMOVED -> withStyle(SpanStyle(color = MaterialTheme.colorScheme.error, background = MaterialTheme.colorScheme.error.copy(alpha = 0.2f), textDecoration = TextDecoration.LineThrough)) {
                    append(w.text)
                }
            }
        }
    }
    Text(text, style = MaterialTheme.typography.bodyMedium)
}
