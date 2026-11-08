package io.github.mrciller.cillhub

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

class UpdateInfoTest {
    private val origin = "https://chat.example.org"
    private val sha = "a".repeat(64)
    private fun feed(url: String = "$origin/download/android/Cillhub-1.1.0.apk", hash: String = sha, code: Int = 2) =
        """{"versionCode":$code,"versionName":"1.1.0","url":"$url","sha256":"$hash","notes":"Fixes"}"""

    @Test fun parsesAWellFormedFeed() {
        val info = UpdateInfo.parse(feed(), origin)!!
        assertEquals(2, info.versionCode)
        assertEquals("1.1.0", info.versionName)
        assertEquals("Fixes", info.notes)
    }

    @Test fun refusesForeignOriginsBadHashesAndJunk() {
        assertNull(UpdateInfo.parse(feed(url = "https://evil.example/x.apk"), origin))
        assertNull(UpdateInfo.parse(feed(url = "http://chat.example.org/download/x.apk"), origin))
        assertNull(UpdateInfo.parse(feed(url = "$origin/download/x.exe"), origin))
        assertNull(UpdateInfo.parse(feed(hash = "abc"), origin))
        assertNull(UpdateInfo.parse(feed(code = 0), origin))
        assertNull(UpdateInfo.parse("{}", origin))
        assertNull(UpdateInfo.parse("<html>", origin))
        assertNotNull("upper-case hex is fine", UpdateInfo.parse(feed(hash = "A".repeat(64)), origin))
    }

    @Test fun verifiesTheDownloadedFile() {
        val f = File.createTempFile("apk", ".apk")
        try {
            f.writeText("hello")
            val good = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824" // sha256("hello")
            assertTrue(UpdateInfo.verify(f, good))
            assertTrue(UpdateInfo.verify(f, good.uppercase()))
            assertFalse(UpdateInfo.verify(f, "0".repeat(64)))
        } finally {
            f.delete()
        }
    }

    @Test fun thePhonesOwnAbiApkWinsOverTheUniversalOne() {
        val o = "https://chat.example.org"
        val h = { c: Char -> c.toString().repeat(64) }
        val feed = """{"versionCode":5,"versionName":"3.0.0","url":"$o/download/android/Cillhub-3.0.0.apk","sha256":"${h('a')}","notes":"",
            "abis":{"arm64-v8a":{"url":"$o/download/android/Cillhub-3.0.0-arm64-v8a.apk","sha256":"${h('b')}"},
                    "x86_64":{"url":"$o/download/android/Cillhub-3.0.0-x86_64.apk","sha256":"${h('c')}"}}}"""
        val arm = UpdateInfo.parse(feed, o, listOf("arm64-v8a", "armeabi-v7a", "armeabi"))!!
        assertEquals("$o/download/android/Cillhub-3.0.0-arm64-v8a.apk" to h('b'), arm.url to arm.sha256)
        val old = UpdateInfo.parse(feed, o, listOf("armeabi-v7a", "armeabi"))!! // not in the feed: universal
        assertEquals("$o/download/android/Cillhub-3.0.0.apk" to h('a'), old.url to old.sha256)
        assertEquals(h('a'), UpdateInfo.parse(feed, o)!!.sha256)
        assertNull("a split APK on another origin is refused", UpdateInfo.parse(feed.replace("$o/download/android/Cillhub-3.0.0-x86_64.apk", "https://evil.example/x.apk"), o, listOf("x86_64")))
    }
}
