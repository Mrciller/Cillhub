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

    private fun hex(s: String) = s.chunked(2).map { it.toInt(16).toByte() }.toByteArray()

    @Test fun ed25519VerifiesTheRfc8032Vectors() {
        val pub1 = hex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a")
        val sig1 = hex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b")
        assertTrue(Ed25519.verify(pub1, ByteArray(0), sig1))
        assertFalse(Ed25519.verify(pub1, byteArrayOf(1), sig1))
        val pub2 = hex("3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c")
        val sig2 = hex("92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00")
        assertTrue(Ed25519.verify(pub2, byteArrayOf(0x72), sig2))
        assertFalse("the other key", Ed25519.verify(pub1, byteArrayOf(0x72), sig2))
        assertFalse("junk sizes", Ed25519.verify(pub2, byteArrayOf(0x72), sig2.copyOf(63)))
        val high = sig2.copyOf(); high[63] = (high[63].toInt() or 0x80).toByte() // S outside the group order
        assertFalse(Ed25519.verify(pub2, byteArrayOf(0x72), high))
    }

    @Test fun theFeedMustBeSignedByAPinnedKey() {
        val kp = java.security.KeyPairGenerator.getInstance("Ed25519").generateKeyPair()
        val spki = java.util.Base64.getEncoder().encodeToString(kp.public.encoded) // the pinned form, as in release-public-key.pem
        val feed = feed().toByteArray()
        val sig = java.security.Signature.getInstance("Ed25519").run { initSign(kp.private); update(feed); sign() }
        assertTrue(UpdateInfo.signed(feed, sig, listOf("MCowBQYDK2VwAyEAWIwyMJ/ZwpoIVzpQUXOHihDsavz1V5fF8ZhCA2vbBl0=", spki)))
        assertFalse("not a pinned key", UpdateInfo.signed(feed, sig))
        assertFalse("changed feed", UpdateInfo.signed(feed(code = 3).toByteArray(), sig, listOf(spki)))
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
