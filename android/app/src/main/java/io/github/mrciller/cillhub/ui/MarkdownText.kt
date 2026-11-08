package io.github.mrciller.cillhub.ui

import android.text.format.DateUtils
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.ui.Alignment
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import io.github.mrciller.cillhub.Config
import io.github.mrciller.cillhub.R
import io.github.mrciller.cillhub.data.Md
import io.github.mrciller.cillhub.data.Sel
import io.github.mrciller.cillhub.data.State
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle

/** Renders the chat Markdown subset ([Md]) as Material text: links, mentions, spoilers, code, quotes, lists, custom emoji. */
@Composable
fun MarkdownText(
    content: String,
    state: State,
    guildId: String?,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyLarge,
    suffix: AnnotatedString? = null,
) {
    val doc = remember(content) { Md.parse(content) }
    val revealed = remember(content) { mutableStateListOf<Int>() }
    val nav = LocalNav.current
    val ctx = LocalContext.current
    val cs = MaterialTheme.colorScheme
    val extra = LocalExtra.current
    val base = if (doc.jumbo) style.copy(fontSize = 40.sp, lineHeight = 48.sp) else style
    val emojiSize = if (doc.jumbo) 2.4.em else 1.3.em
    val inline = HashMap<String, InlineTextContent>()
    val plainLink = TextLinkStyles(SpanStyle(textDecoration = TextDecoration.None))

    fun build(nodes: List<Md.Inline>, last: Boolean): AnnotatedString = buildAnnotatedString {
        var spoilers = 0
        fun add(list: List<Md.Inline>) {
            for (n in list) when (n) {
                is Md.Text -> append(n.text)
                is Md.Bold -> withStyle(SpanStyle(fontWeight = FontWeight.Bold)) { add(n.children) }
                is Md.Italic -> withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { add(n.children) }
                is Md.Underline -> withStyle(SpanStyle(textDecoration = TextDecoration.Underline)) { add(n.children) }
                is Md.Strike -> withStyle(SpanStyle(textDecoration = TextDecoration.LineThrough)) { add(n.children) }
                is Md.Code -> withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = cs.surfaceContainerHighest, fontSize = 0.9.em)) { append(n.text) }
                is Md.Spoiler -> {
                    val i = spoilers++
                    if (i in revealed) withStyle(SpanStyle(background = cs.surfaceContainerHighest)) { add(n.children) }
                    else withLink(LinkAnnotation.Clickable("spoiler$i", plainLink) { revealed += i }) {
                        // hidden: text drawn in its background colour until tapped
                        withStyle(SpanStyle(color = cs.onSurfaceVariant, background = cs.onSurfaceVariant)) { add(n.children) }
                    }
                }
                is Md.Link -> withLink(LinkAnnotation.Url(n.url, TextLinkStyles(SpanStyle(color = cs.primary, textDecoration = TextDecoration.Underline)))) { append(n.url) }
                is Md.MaskedLink -> withLink(LinkAnnotation.Clickable("masked", TextLinkStyles(SpanStyle(color = cs.primary, textDecoration = TextDecoration.Underline))) { nav.confirmLink(n.url) }) { add(n.children) }
                is Md.UserMention -> {
                    val name = state.users[n.id]?.let { Sel.memberName(state, guildId, n.id) } ?: ctx.getString(R.string.unknown_user)
                    withLink(LinkAnnotation.Clickable("user", plainLink) { nav.openProfile(n.id, guildId) }) {
                        withStyle(SpanStyle(color = cs.primary, background = cs.primary.copy(alpha = 0.14f), fontWeight = FontWeight.Medium)) { append("@$name") }
                    }
                }
                is Md.RoleMention -> {
                    val role = guildId?.let { state.guilds[it] }?.roles?.firstOrNull { it.id == n.id }
                    val color = role?.color?.takeIf { it != 0 }?.let { Color(0xFF000000 or it.toLong()) } ?: cs.primary
                    withStyle(SpanStyle(color = color, background = color.copy(alpha = 0.14f), fontWeight = FontWeight.Medium)) { append("@" + (role?.name ?: ctx.getString(R.string.deleted_role))) }
                }
                is Md.ChannelMention -> {
                    val ch = state.channels[n.id]
                    if (ch == null) withStyle(SpanStyle(color = cs.primary)) { append("#" + ctx.getString(R.string.unknown)) }
                    else withLink(LinkAnnotation.Clickable("channel", plainLink) { nav.openChannel(ch.id) }) {
                        withStyle(SpanStyle(color = cs.primary, background = cs.primary.copy(alpha = 0.14f), fontWeight = FontWeight.Medium)) { append("#" + (ch.name ?: "")) }
                    }
                }
                is Md.Everyone -> withStyle(SpanStyle(color = extra.mention, background = extra.mentionBg, fontWeight = FontWeight.Medium)) { append(n.text) }
                is Md.CustomEmoji -> {
                    val key = "emoji:${n.id}:${n.animated}"
                    inline[key] = InlineTextContent(Placeholder(emojiSize, emojiSize, PlaceholderVerticalAlign.Center)) {
                        AsyncImage(Config.cdn("/emojis/${n.id}.${if (n.animated) "gif" else "png"}"), ":${n.name}:", Modifier.fillMaxSize())
                    }
                    appendInlineContent(key, ":${n.name}:")
                }
                is Md.Timestamp -> withStyle(SpanStyle(background = cs.surfaceContainerHighest)) { append(timestamp(ctx, n)) }
            }
        }
        add(nodes)
        if (last && suffix != null) append(suffix)
    }

    @Composable
    fun listBlockImpl(b: Md.ListBlock, depth: Int) {
        Column(Modifier.padding(start = (4 + depth * 12).dp)) {
            b.items.forEachIndexed { i, item ->
                Row {
                    Text(if (b.ordered) "${b.start + i}." else "•", style = base, modifier = Modifier.width(20.dp))
                    Column {
                        Text(build(item.inlines, false), style = base, inlineContent = inline)
                        item.children?.let { listBlockImpl(it, depth + 1) }
                    }
                }
            }
        }
    }
    @Composable
    fun blocks(list: List<Md.Block>, top: Boolean) {
        list.forEachIndexed { idx, b ->
            val last = top && idx == list.lastIndex
            when (b) {
                is Md.Paragraph -> Text(build(b.inlines, last), style = base, inlineContent = inline)
                is Md.Heading -> Text(build(b.inlines, last), style = when (b.level) { 1 -> MaterialTheme.typography.headlineSmall; 2 -> MaterialTheme.typography.titleLarge; else -> MaterialTheme.typography.titleMedium }.copy(fontWeight = FontWeight.Bold), inlineContent = inline, modifier = Modifier.padding(vertical = 2.dp))
                is Md.Subtext -> Text(build(b.inlines, last), style = MaterialTheme.typography.bodySmall, color = cs.onSurfaceVariant, inlineContent = inline)
                is Md.CodeBlock -> CodeBlockView(b, base)
                is Md.TableBlock -> TableBlockView(b, base)
                is Md.Quote -> Row(Modifier.height(IntrinsicSize.Min).padding(vertical = 2.dp)) {
                    Box(Modifier.width(4.dp).fillMaxHeight().clip(RoundedCornerShape(2.dp)).background(cs.outline))
                    Column(Modifier.padding(start = 10.dp)) { blocks(b.blocks, false) }
                }
                is Md.ListBlock -> listBlockImpl(b, 0)
            }
        }
    }


    Column(modifier) { blocks(doc.blocks, true) }
}

@Composable
private fun CodeBlockView(b: Md.CodeBlock, base: TextStyle) {
    val cs = MaterialTheme.colorScheme
    val clipboard = androidx.compose.ui.platform.LocalClipboard.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val copied = androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    val lines = remember(b.code) { b.code.split('\n') }
    val isLong = lines.size > 25
    var expanded by remember { androidx.compose.runtime.mutableStateOf(false) }
    val isDiff = b.lang in listOf("diff", "patch") || (lines.size >= 2 && lines.any { it.startsWith("+") && !it.startsWith("+++") } && lines.any { it.startsWith("-") && !it.startsWith("---") })
    val displayLines = if (isLong && !expanded) lines.take(25) else lines

    Column(
        Modifier.fillMaxWidth().padding(vertical = 4.dp).clip(RoundedCornerShape(10.dp))
            .background(cs.surfaceContainerLow),
    ) {
        Row(
            Modifier.fillMaxWidth().background(cs.surfaceContainerHigh).padding(horizontal = 10.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                (b.lang ?: if (isDiff) "diff" else "code").uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = cs.onSurfaceVariant,
                modifier = Modifier.weight(1f),
            )
            if (isLong) {
                Surface(
                    onClick = { expanded = !expanded },
                    shape = RoundedCornerShape(6.dp),
                    color = cs.surfaceContainerHighest,
                    modifier = Modifier.padding(end = 6.dp),
                ) {
                    Text(
                        if (expanded) s(R.string.collapse) else s(R.string.expand_lines, lines.size),
                        style = MaterialTheme.typography.labelSmall,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 3.dp),
                    )
                }
            }
            Surface(
                onClick = {
                    scope.launch {
                        clipboard.setClipEntry(androidx.compose.ui.platform.ClipEntry(android.content.ClipData.newPlainText("code", b.code)))
                        copied.value = true
                        kotlinx.coroutines.delay(1600)
                        copied.value = false
                    }
                },
                shape = RoundedCornerShape(6.dp),
                color = cs.surfaceContainerHighest,
            ) {
                Row(Modifier.padding(horizontal = 8.dp, vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                    Ic(
                        if (copied.value) R.drawable.ms_check else R.drawable.ms_content_copy,
                        s(R.string.copy_text),
                        Modifier.size(14.dp),
                        tint = if (copied.value) LocalExtra.current.online else cs.onSurfaceVariant,
                    )
                }
            }
        }
        Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(10.dp)) {
            Column {
                displayLines.forEachIndexed { i, line ->
                    val diffColor = when {
                        isDiff && line.startsWith("+") && !line.startsWith("+++") -> Color(0xFF2DC770)
                        isDiff && line.startsWith("-") && !line.startsWith("---") -> Color(0xFFF23F43)
                        isDiff && line.startsWith("@@") -> Color(0xFF5865F2)
                        else -> cs.onSurface
                    }
                    val diffBg = when {
                        isDiff && line.startsWith("+") && !line.startsWith("+++") -> Color(0xFF2DC770).copy(alpha = 0.12f)
                        isDiff && line.startsWith("-") && !line.startsWith("---") -> Color(0xFFF23F43).copy(alpha = 0.12f)
                        else -> Color.Transparent
                    }
                    Row(
                        Modifier.fillMaxWidth().background(diffBg),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (lines.size >= 3) {
                            Text(
                                (i + 1).toString().padStart(lines.size.toString().length, ' '),
                                style = base.copy(
                                    fontFamily = FontFamily.Monospace,
                                    fontSize = 12.sp,
                                    color = cs.onSurfaceVariant.copy(alpha = 0.5f),
                                ),
                                modifier = Modifier.padding(end = 12.dp),
                            )
                        }
                        Text(
                            line,
                            style = base.copy(fontFamily = FontFamily.Monospace, fontSize = 13.sp, color = diffColor),
                        )
                    }
                }
                if (isLong && !expanded) {
                    Text(
                        "…",
                        style = base.copy(color = cs.onSurfaceVariant, fontSize = 14.sp),
                        modifier = Modifier.padding(top = 4.dp),
                    )
                }
            }
        }
    }
}

@Composable
private fun TableBlockView(b: Md.TableBlock, base: TextStyle) {
    val cs = MaterialTheme.colorScheme
    val clipboard = androidx.compose.ui.platform.LocalClipboard.current
    val scope = androidx.compose.runtime.rememberCoroutineScope()
    val copied = androidx.compose.runtime.remember { androidx.compose.runtime.mutableStateOf(false) }
    Column(
        Modifier.fillMaxWidth().padding(vertical = 6.dp).clip(RoundedCornerShape(8.dp))
            .border(1.dp, cs.outlineVariant, RoundedCornerShape(8.dp))
            .background(cs.surfaceContainerLow)
    ) {
        Row(
            Modifier.fillMaxWidth().background(cs.surfaceContainerHigh).padding(horizontal = 10.dp, vertical = 4.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.SpaceBetween,
        ) {
            Text(s(R.string.markdown_table), style = MaterialTheme.typography.labelSmall, color = cs.onSurfaceVariant)
            Surface(
                onClick = {
                    scope.launch {
                        clipboard.setClipEntry(androidx.compose.ui.platform.ClipEntry(android.content.ClipData.newPlainText("csv", b.rawCsv)))
                        copied.value = true
                        kotlinx.coroutines.delay(1600)
                        copied.value = false
                    }
                },
                shape = RoundedCornerShape(6.dp),
                color = cs.surfaceContainerHighest,
            ) {
                Row(Modifier.padding(horizontal = 8.dp, vertical = 3.dp), verticalAlignment = Alignment.CenterVertically) {
                    Ic(
                        if (copied.value) R.drawable.ms_check else R.drawable.ms_content_copy,
                        s(R.string.copy_csv),
                        Modifier.size(14.dp),
                        tint = if (copied.value) LocalExtra.current.online else cs.onSurfaceVariant,
                    )
                    Spacer(Modifier.width(4.dp))
                    Text(if (copied.value) s(R.string.copied) else s(R.string.copy_csv), style = MaterialTheme.typography.labelSmall)
                }
            }
        }
        Box(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState())) {
            Column(Modifier.padding(8.dp)) {
                Row(Modifier.background(cs.surfaceContainer).padding(vertical = 4.dp)) {
                    b.headers.forEachIndexed { colIdx, cell ->
                        val align = b.aligns.getOrElse(colIdx) { Md.TableAlign.LEFT }
                        Box(Modifier.widthIn(min = 80.dp, max = 220.dp).padding(horizontal = 8.dp), contentAlignment = when (align) {
                            Md.TableAlign.CENTER -> Alignment.Center
                            Md.TableAlign.RIGHT -> Alignment.CenterEnd
                            else -> Alignment.CenterStart
                        }) {
                            Text(cell.raw, style = base.copy(fontWeight = FontWeight.Bold, fontSize = 13.sp))
                        }
                    }
                }
                HorizontalDivider(color = cs.outlineVariant)
                b.rows.forEachIndexed { rowIdx, row ->
                    Row(Modifier.background(if (rowIdx % 2 == 1) cs.surfaceContainer.copy(alpha = 0.5f) else Color.Transparent).padding(vertical = 4.dp)) {
                        b.headers.indices.forEach { colIdx ->
                            val cell = row.getOrNull(colIdx)
                            val align = b.aligns.getOrElse(colIdx) { Md.TableAlign.LEFT }
                            Box(Modifier.widthIn(min = 80.dp, max = 220.dp).padding(horizontal = 8.dp), contentAlignment = when (align) {
                                Md.TableAlign.CENTER -> Alignment.Center
                                Md.TableAlign.RIGHT -> Alignment.CenterEnd
                                else -> Alignment.CenterStart
                            }) {
                                Text(cell?.raw ?: "", style = base.copy(fontSize = 13.sp))
                            }
                        }
                    }
                }
            }
        }
    }
}

private fun timestamp(ctx: android.content.Context, t: Md.Timestamp): String {
    val at = Instant.ofEpochSecond(t.unix).atZone(ZoneId.systemDefault())
    return when (t.style) {
        't' -> at.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT))
        'T' -> at.format(DateTimeFormatter.ofLocalizedTime(FormatStyle.MEDIUM))
        'd' -> at.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.SHORT))
        'D' -> at.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.LONG))
        'F' -> at.format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.FULL, FormatStyle.SHORT))
        'R' -> DateUtils.getRelativeTimeSpanString(t.unix * 1000, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS).toString()
        else -> at.format(DateTimeFormatter.ofLocalizedDateTime(FormatStyle.LONG, FormatStyle.SHORT))
    }
}
