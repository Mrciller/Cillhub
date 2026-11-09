package io.github.mrciller.cillhub.ui

import io.github.mrciller.cillhub.data.Attachment
import io.github.mrciller.cillhub.data.Embed
import io.github.mrciller.cillhub.data.EmbedMedia
import io.github.mrciller.cillhub.data.FavoriteGif
import io.github.mrciller.cillhub.data.Message
import io.github.mrciller.cillhub.data.User
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Which messages offer "Add to favourites", and the favorite_gifs item they become. */
class GifsTest {
    private fun msg(embeds: List<Embed> = emptyList(), attachments: List<Attachment> = emptyList()) =
        Message("1", channelId = "c", author = User("u"), embeds = embeds, attachments = attachments)

    @Test fun formats() {
        assertEquals("gif", gifFormat("/external/abc/x.GIF?w=1"))
        assertEquals("mp4", gifFormat("https://media.example/x.mp4"))
        assertEquals("image", gifFormat("/external/token"))
    }

    @Test fun gifvEmbedKeepsThePageUrlAndTheProxyPath() {
        val e = Embed(type = "gifv", url = "https://gifs.example/view/1", video = EmbedMedia("https://media.example/1.mp4", "/external/v1", 320, 240),
            thumbnail = EmbedMedia("https://media.example/1.gif", "/external/t1", 320, 240))
        assertEquals("the picture, not the video", FavoriteGif("https://gifs.example/view/1", "/external/t1", 320, 240, "gif"), gifOf(msg(listOf(e))))
        assertNull("video only: nothing a tile can draw", gifOf(msg(listOf(e.copy(thumbnail = null)))))
        assertNull("the server keeps only https links", gifOf(msg(listOf(e.copy(url = "http://gifs.example/view/1")))))
    }

    @Test fun gifAttachmentAndNothingElse() {
        val a = Attachment("a", "funny.gif", contentType = "image/gif", url = "/attachments/c/a/funny.gif", width = 10, height = 20)
        assertEquals("/attachments/c/a/funny.gif", gifOf(msg(attachments = listOf(a)))?.src)
        assertNull(gifOf(msg(attachments = listOf(a.copy(filename = "p.png", contentType = "image/png")))))
        assertNull("a plain link card is no GIF", gifOf(msg(listOf(Embed(type = "article", url = "https://example.com", thumbnail = EmbedMedia("https://example.com/t.png"))))))
    }
}
