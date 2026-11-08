package io.github.mrciller.cillhub.data

import java.net.URI
import java.util.regex.Matcher
import java.util.regex.Pattern

/**
 * The chat Markdown subset of the web client (client/src/markdown/Markdown.tsx), parsed into a small tree the UI
 * renders as styled text (never HTML). Same rules, same order, same block handling.
 */
object Md {
    sealed interface Inline
    data class Text(val text: String) : Inline
    data class Bold(val children: List<Inline>) : Inline
    data class Italic(val children: List<Inline>) : Inline
    data class Underline(val children: List<Inline>) : Inline
    data class Strike(val children: List<Inline>) : Inline
    data class Spoiler(val children: List<Inline>) : Inline
    data class Code(val text: String) : Inline
    /** A bare or <wrapped> URL. */
    data class Link(val url: String) : Inline
    /** [text](url): the app confirms before leaving. */
    data class MaskedLink(val url: String, val children: List<Inline>) : Inline
    data class UserMention(val id: String) : Inline
    data class RoleMention(val id: String) : Inline
    data class ChannelMention(val id: String) : Inline
    data class Everyone(val text: String) : Inline
    data class CustomEmoji(val name: String, val id: String, val animated: Boolean) : Inline
    data class Timestamp(val unix: Long, val style: Char) : Inline

    sealed interface Block
    data class Paragraph(val inlines: List<Inline>) : Block
    data class Heading(val level: Int, val inlines: List<Inline>) : Block
    data class Subtext(val inlines: List<Inline>) : Block
    data class ListItem(val inlines: List<Inline>, val children: ListBlock?)
    data class ListBlock(val ordered: Boolean, val start: Int, val items: List<ListItem>) : Block
    data class Quote(val blocks: List<Block>) : Block
    data class CodeBlock(val lang: String?, val code: String) : Block

    enum class TableAlign { LEFT, CENTER, RIGHT, NONE }
    data class TableCell(val inlines: List<Inline>, val raw: String)
    data class TableBlock(val headers: List<TableCell>, val aligns: List<TableAlign>, val rows: List<List<TableCell>>, val rawCsv: String) : Block

    data class Doc(val blocks: List<Block>, val jumbo: Boolean)

    fun safeUrl(u: String): String? = try {
        val uri = URI(u)
        if ((uri.scheme == "http" || uri.scheme == "https") && !uri.host.isNullOrEmpty()) u else null
    } catch (e: Exception) {
        null
    }

    private val wordChar = Regex("[\\p{L}\\p{N}]")
    private fun wordBefore(src: String, i: Int) = i > 0 && wordChar.matches(src[i - 1].toString())

    private class Rule(regex: String, val ok: ((String, Int) -> Boolean)? = null, val render: (Matcher, Int) -> Inline?) {
        val pattern: Pattern = Pattern.compile(regex)
    }

    private val RULES = listOf(
        Rule("\\\\([^\\p{L}\\p{N}\\s])") { m, _ -> Text(m.group(1)) },
        Rule("(`+)([\\s\\S]*?[^`])\\1(?!`)") { m, _ -> Code(m.group(2).let { if (it.length >= 2 && it.startsWith(' ') && it.endsWith(' ')) it.substring(1, it.length - 1) else it }) },
        Rule("<(https?://[^\\s>]+)>") { m, _ -> safeUrl(m.group(1))?.let { Link(it) } ?: Text(m.group(0)) },
        Rule("\\[([^\\[\\]\\n]+)\\]\\(<?(https?://[^\\s)>]+)>?\\)") { m, d -> safeUrl(m.group(2))?.let { MaskedLink(it, inline(m.group(1), d + 1)) } ?: Text(m.group(0)) },
        Rule("<(a?):(\\w{2,32}):(\\d+)>") { m, _ -> CustomEmoji(m.group(2), m.group(3), m.group(1).isNotEmpty()) },
        Rule("<t:(-?\\d{1,13})(?::([tTdDfFR]))?>") { m, _ -> Timestamp(m.group(1).toLong(), m.group(2)?.first() ?: 'f') },
        Rule("https?://[^\\s<]+[^<.,:;\"')\\]\\s]", ok = { s, i -> !wordBefore(s, i) }) { m, _ -> safeUrl(m.group(0))?.let { Link(it) } ?: Text(m.group(0)) },
        Rule("<@!?(\\d+)>") { m, _ -> UserMention(m.group(1)) },
        Rule("<@&(\\d+)>") { m, _ -> RoleMention(m.group(1)) },
        Rule("<#(\\d+)>") { m, _ -> ChannelMention(m.group(1)) },
        Rule("@(everyone|here)(?![\\p{L}\\p{N}])", ok = { s, i -> !wordBefore(s, i) }) { m, _ -> Everyone(m.group(0)) },
        Rule("\\|\\|([\\s\\S]+?)\\|\\|") { m, d -> Spoiler(inline(m.group(1), d + 1)) },
        Rule("\\*\\*([\\s\\S]+?)\\*\\*(?!\\*)") { m, d -> Bold(inline(m.group(1), d + 1)) },
        Rule("__([\\s\\S]+?)__(?!_)") { m, d -> Underline(inline(m.group(1), d + 1)) },
        Rule("\\*(?=\\S)([\\s\\S]*?\\S)\\*(?!\\*)") { m, d -> Italic(inline(m.group(1), d + 1)) },
        Rule("_([^_]+?)_(?![\\p{L}\\p{N}_])", ok = { s, i -> !wordBefore(s, i) }) { m, d -> Italic(inline(m.group(1), d + 1)) },
        Rule("~~([\\s\\S]+?)~~") { m, d -> Strike(inline(m.group(1), d + 1)) },
    )
    private const val STARTERS = "\\`<h@|*_~["

    fun inline(src: String, depth: Int = 0): List<Inline> {
        if (depth > 8) return listOf(Text(src))
        val out = ArrayList<Inline>()
        val buf = StringBuilder()
        // adjacent plain text merges, so an escaped character does not split a run
        fun text(t: String) { if (out.lastOrNull() is Text) out[out.size - 1] = Text((out.last() as Text).text + t) else out += Text(t) }
        var i = 0
        scan@ while (i < src.length) {
            if (src[i] in STARTERS) for (rule in RULES) {
                val m = rule.pattern.matcher(src).useTransparentBounds(true).useAnchoringBounds(false).region(i, src.length)
                if (m.lookingAt() && (rule.ok == null || rule.ok.invoke(src, i))) {
                    val node = rule.render(m, depth) ?: continue
                    if (buf.isNotEmpty()) { text(buf.toString()); buf.clear() }
                    if (node is Text) text(node.text) else out += node
                    i = m.end()
                    continue@scan
                }
            }
            buf.append(src[i++])
        }
        if (buf.isNotEmpty()) text(buf.toString())
        return out
    }

    private data class Line(val kind: String, val text: String, val depth: Int, val n: Int = 1)
    private val H = Regex("^(#{1,3}) (.+)$")
    private val SUB = Regex("^-# (.+)$")
    private val UL = Regex("^( *)[-*] (.+)$")
    private val OL = Regex("^( *)(\\d{1,9})\\. (.+)$")

    private fun classify(line: String): Line {
        H.find(line)?.let { return Line("h${it.groupValues[1].length}", it.groupValues[2], 0) }
        SUB.find(line)?.let { return Line("sub", it.groupValues[1], 0) }
        UL.find(line)?.let { return Line("ul", it.groupValues[2], minOf(2, it.groupValues[1].length shr 1)) }
        OL.find(line)?.let { return Line("ol", it.groupValues[3], minOf(2, it.groupValues[1].length shr 1), it.groupValues[2].toInt()) }
        return Line("text", line, 0)
    }

    private fun list(items: List<Line>): ListBlock {
        val out = ArrayList<ListItem>()
        var i = 0
        while (i < items.size) {
            val it = items[i]
            val kids = ArrayList<Line>()
            while (i + 1 < items.size && items[i + 1].depth > it.depth) kids += items[++i]
            out += ListItem(inline(it.text), if (kids.isEmpty()) null else list(kids))
            i++
        }
        return ListBlock(items[0].kind == "ol", items[0].n, out)
    }

    private val TABLE_DELIM = Regex("^\\s*\\|?(?:\\s*:?-{3,}:?\\s*\\|)+\\s*:?-{3,}:?\\s*\\|?\\s*$")

    private fun splitTableRow(row: String): List<String> {
        val trimmed = row.trim()
        val s = if (trimmed.startsWith('|')) trimmed.substring(1) else trimmed
        val e = if (s.endsWith('|') && !s.endsWith("\\|")) s.substring(0, s.length - 1) else s
        return e.split(Regex("(?<!\\\\)\\|")).map { it.replace("\\|", "|").trim() }
    }

    private fun parseTable(lines: List<String>, startIdx: Int): Pair<TableBlock, Int>? {
        val headerLine = lines[startIdx]
        val delimLine = lines[startIdx + 1]
        val delimCols = splitTableRow(delimLine)
        if (delimCols.isEmpty()) return null
        val aligns = delimCols.map { col ->
            val c = col.trim()
            val left = c.startsWith(':')
            val right = c.endsWith(':')
            when {
                left && right -> TableAlign.CENTER
                left -> TableAlign.LEFT
                right -> TableAlign.RIGHT
                else -> TableAlign.LEFT
            }
        }
        val headerRaw = splitTableRow(headerLine)
        val headers = headerRaw.map { TableCell(inline(it), it) }
        val rows = mutableListOf<List<TableCell>>()
        var idx = startIdx + 2
        while (idx < lines.size && rows.size < 50) {
            val r = lines[idx]
            if ('|' !in r || r.isBlank()) break
            val cols = splitTableRow(r)
            rows += cols.take(20).map { TableCell(inline(it), it) }
            idx++
        }
        fun escapeCsv(s: String) = if ("," in s || "\"" in s || "\n" in s) "\"" + s.replace("\"", "\"\"") + "\"" else s
        val csv = buildString {
            appendLine(headers.joinToString(",") { escapeCsv(it.raw) })
            rows.forEach { r ->
                appendLine(r.joinToString(",") { escapeCsv(it.raw) })
            }
        }.trimEnd()
        return TableBlock(headers, aligns, rows, csv) to idx
    }

    private fun blocks(src: String, quoted: Boolean = false): List<Block> {
        val out = ArrayList<Block>()
        val lines = src.split('\n')
        val text = ArrayList<String>()
        var quote = ArrayList<String>()
        val items = ArrayList<Line>()
        fun flushText() { if (text.isNotEmpty()) { out += Paragraph(inline(text.joinToString("\n"))); text.clear() } }
        fun flushQuote() { if (quote.isNotEmpty()) { out += Quote(blocks(quote.joinToString("\n"), true)); quote = ArrayList() } }
        fun flushList() { if (items.isNotEmpty()) { out += list(items.toList()); items.clear() } }
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            if (!quoted && '|' in line && i + 1 < lines.size && TABLE_DELIM.matches(lines[i + 1])) {
                flushText(); flushQuote(); flushList()
                val table = parseTable(lines, i)
                if (table != null) {
                    out += table.first
                    i = table.second
                    continue
                }
            }
            if (!quoted && line.startsWith(">>> ")) {
                flushText(); flushQuote(); flushList()
                quote = ArrayList(listOf(line.substring(4)) + lines.subList(i + 1, lines.size))
                break
            }
            if (!quoted && (line.startsWith("> ") || line == ">")) {
                flushText(); flushList()
                quote += if (line.length >= 2) line.substring(2) else ""
                i++; continue
            }
            flushQuote()
            val c = classify(line)
            when (c.kind) {
                "ul", "ol" -> {
                    flushText()
                    if (items.isNotEmpty() && items[0].kind != c.kind && c.depth == 0) flushList()
                    items += c
                }
                "text" -> { flushList(); text += line }
                else -> {
                    flushText(); flushList()
                    out += if (c.kind == "sub") Subtext(inline(c.text)) else Heading(c.kind.substring(1).toInt(), inline(c.text))
                }
            }
            i++
        }
        flushText(); flushQuote(); flushList()
        return out
    }

    private val FENCE = Regex("```(?:([\\w+#.-]+)\\n)?\\n?([\\s\\S]*?)```")
    private val CUSTOM = Regex("<a?:\\w{2,32}:\\d+>")

    fun parse(content: String): Doc {
        val out = ArrayList<Block>()
        var last = 0
        for (m in FENCE.findAll(content)) {
            out += blocks(content.substring(last, m.range.first))
            out += CodeBlock(m.groups[1]?.value, m.groupValues[2].removeSuffix("\n"))
            last = m.range.last + 1
            if (last < content.length && content[last] == '\n') last++ // the block already ends the line
        }
        out += blocks(content.substring(last))
        // drop the empty paragraph a leading/trailing fence leaves
        val cleaned = out.filterNot { it is Paragraph && it.inlines.all { n -> n is Text && n.text.isEmpty() } }
        val customs = CUSTOM.findAll(content).count()
        val plain = content.replace(CUSTOM, "")
        val count = emojiCount(plain) + customs
        return Doc(cleaned, count in 1..27 && (plain.isBlank() || emojiOnly(plain)))
    }

    /** One-line plain text (reply previews): formatting dropped, mentions and emoji as their names. */
    fun plain(content: String, name: (Inline) -> String = { "" }): String {
        fun flat(list: List<Inline>): String = list.joinToString("") { n ->
            when (n) {
                is Text -> n.text; is Code -> n.text; is Link -> n.url
                is Bold -> flat(n.children); is Italic -> flat(n.children); is Underline -> flat(n.children); is Strike -> flat(n.children)
                is Spoiler -> "▒".repeat(minOf(8, flat(n.children).length)); is MaskedLink -> flat(n.children)
                is CustomEmoji -> ":${n.name}:"; is Everyone -> n.text
                is Timestamp -> name(n).ifEmpty {
                    runCatching {
                        java.time.Instant.ofEpochSecond(n.unix).atZone(java.time.ZoneId.systemDefault())
                            .format(java.time.format.DateTimeFormatter.ofLocalizedDateTime(java.time.format.FormatStyle.SHORT))
                    }.getOrDefault("<t:${n.unix}>")
                }
                else -> name(n)
            }
        }
        return flat(inline(content.replace('\n', ' ')))
    }

    // shortcut: emoji detection by code point ranges instead of Unicode's Extended_Pictographic property, good enough for the jumbo rule
    private fun isPictographic(cp: Int) = cp in 0x1F000..0x1FAFF || cp in 0x2600..0x27BF || cp in 0x2300..0x23FF || cp in 0x2B00..0x2BFF ||
        cp == 0x00A9 || cp == 0x00AE || cp == 0x203C || cp == 0x2049 || cp == 0x2122 || cp == 0x2139 || cp in 0x2194..0x21AA || cp == 0x3030 || cp == 0x303D || cp == 0x3297 || cp == 0x3299
    private fun isJoiner(cp: Int) = cp == 0x200D || cp == 0xFE0F || cp in 0x1F3FB..0x1F3FF || cp in 0x1F1E6..0x1F1FF || cp in 0xE0020..0xE007F || cp == 0x20E3

    private fun emojiCount(s: String) = s.codePoints().filter { isPictographic(it) && it !in 0x1F1E6..0x1F1FF && it !in 0x1F3FB..0x1F3FF }.count().toInt() +
        s.codePoints().filter { it in 0x1F1E6..0x1F1FF }.count().toInt() / 2

    private fun emojiOnly(s: String) = s.codePoints().allMatch { isPictographic(it) || isJoiner(it) || Character.isWhitespace(it) }
}
