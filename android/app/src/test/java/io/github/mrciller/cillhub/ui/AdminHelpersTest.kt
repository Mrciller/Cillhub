package io.github.mrciller.cillhub.ui

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** Pure helpers behind the server settings pages. */
class AdminHelpersTest {
    @Test fun emojiNamesFromFiles() {
        assertEquals("party_parrot", emojiName("party parrot.gif"))
        assertEquals("ok", emojiName("--ok--.png"))
        assertEquals("emoji", emojiName("ä.png"))
        assertEquals(32, emojiName("a".repeat(40) + ".png").length)
        for (f in listOf("x.png", "Kim's cat!!.webp", "a".repeat(40))) assertTrue(f, EMOJI_NAME.matches(emojiName(f)))
    }
}
