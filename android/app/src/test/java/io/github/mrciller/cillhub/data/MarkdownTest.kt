package io.github.mrciller.cillhub.data

import io.github.mrciller.cillhub.data.Md.Bold
import io.github.mrciller.cillhub.data.Md.Code
import io.github.mrciller.cillhub.data.Md.Italic
import io.github.mrciller.cillhub.data.Md.Text
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MarkdownTest {
    private fun inl(s: String) = Md.inline(s)

    @Test fun emphasis() {
        assertEquals(listOf(Text("a "), Bold(listOf(Text("b"))), Text(" "), Italic(listOf(Text("c"))), Text(" "), Italic(listOf(Text("d")))), inl("a **b** *c* _d_"))
        assertEquals(listOf(Md.Underline(listOf(Text("u"))), Text(" "), Md.Strike(listOf(Text("s"))), Text(" "), Md.Spoiler(listOf(Text("x")))), inl("__u__ ~~s~~ ||x||"))
        assertEquals("nested", listOf(Bold(listOf(Text("a "), Italic(listOf(Text("b")))))), inl("**a *b***"))
    }

    @Test fun snakeCaseIsNotItalic() = assertEquals(listOf(Text("snake_case_name")), inl("snake_case_name"))

    @Test fun codeIsLiteral() {
        assertEquals(listOf(Text("x "), Code("**not bold**")), inl("x `**not bold**`"))
        assertEquals(listOf(Code("a`b")), inl("`` a`b ``"))
    }

    @Test fun escapes() = assertEquals(listOf(Text("*not italic*")), inl("\\*not italic\\*"))

    @Test fun links() {
        assertEquals(listOf(Text("see "), Md.Link("https://example.org/a"), Text(".")), inl("see https://example.org/a."))
        assertEquals(listOf(Md.MaskedLink("https://example.org", listOf(Text("here")))), inl("[here](https://example.org)"))
        assertEquals("only http(s) masked links", listOf(Text("[x](javascript:alert(1))")), inl("[x](javascript:alert(1))"))
        assertEquals(listOf(Md.Link("https://e.org/x")), inl("<https://e.org/x>"))
        assertEquals("no link glued to a word", listOf(Text("xhttps://e.org")), inl("xhttps://e.org"))
    }

    @Test fun mentionsAndEmoji() {
        assertEquals(listOf(Md.UserMention("123"), Text(" "), Md.RoleMention("4"), Text(" "), Md.ChannelMention("5"), Text(" "), Md.Everyone("@here")), inl("<@!123> <@&4> <#5> @here"))
        assertEquals(listOf(Md.CustomEmoji("party", "99", true)), inl("<a:party:99>"))
        assertEquals(listOf(Md.Timestamp(1700000000, 'R')), inl("<t:1700000000:R>"))
        assertEquals(listOf(Text("mail@everyone.org")), inl("mail@everyone.org"))
    }

    @Test fun blocks() {
        val doc = Md.parse("# Title\n> quoted\nplain\n- a\n  - b\n1. one\n-# small")
        val kinds = doc.blocks.map { it::class.simpleName }
        assertEquals(listOf("Heading", "Quote", "Paragraph", "ListBlock", "ListBlock", "Subtext"), kinds)
        val ul = doc.blocks[3] as Md.ListBlock
        assertFalse(ul.ordered)
        assertEquals(1, ul.items.size)
        assertEquals(1, ul.items[0].children!!.items.size)
        assertTrue((doc.blocks[4] as Md.ListBlock).ordered)
    }

    @Test fun quoteRestOfMessage() {
        val doc = Md.parse("hi\n>>> a\nb")
        assertEquals(2, doc.blocks.size)
        assertEquals(listOf(Md.Paragraph(listOf(Text("a\nb")))), (doc.blocks[1] as Md.Quote).blocks)
    }

    @Test fun codeFence() {
        val doc = Md.parse("before\n```kotlin\nval x = **1**\n```\nafter")
        assertEquals(Md.CodeBlock("kotlin", "val x = **1**"), doc.blocks[1])
        assertEquals(3, doc.blocks.size)
    }

    @Test fun jumboEmoji() {
        assertTrue(Md.parse("🔥🔥").jumbo)
        assertTrue(Md.parse("<:ok:1> 👍").jumbo)
        assertFalse(Md.parse("hi 🔥").jumbo)
        assertFalse(Md.parse("plain").jumbo)
    }

    @Test fun plainPreview() {
        assertEquals("the old new pool @Bob", Md.plain("the ~~old~~ **new** pool\n<@2>") { if (it is Md.UserMention) "@Bob" else "" })
        assertTrue("timestamp renders non-empty in plain preview", Md.plain("meet at <t:1700000000:f>").length > "meet at ".length)
    }
}
