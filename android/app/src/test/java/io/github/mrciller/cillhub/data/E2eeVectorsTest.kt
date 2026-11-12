package io.github.mrciller.cillhub.data

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.security.KeyPair
import io.github.mrciller.cillhub.data.E2eeCrypto as C

/** Encrypted DMs: every value of server/test/fixtures/e2ee-vectors.json (copied into test resources), byte for byte. */
class E2eeVectorsTest {
    private val v = json.parseToJsonElement(javaClass.classLoader!!.getResource("e2ee-vectors.json")!!.readText()).jsonObject
    private fun JsonObject.o(k: String) = this[k]!!.jsonObject
    private fun JsonObject.s(k: String) = this[k]!!.jsonPrimitive.content
    private fun person(p: JsonObject) = C.importPrivate(C.unb64(p.s("pkcs8")))

    @Test fun accountKeys() {
        for (name in listOf("alex", "sam")) {
            val p = v.o(name)
            val priv = person(p)
            assertEquals(p.s("public_key"), C.publicOf(C.unb64(p.s("pkcs8"))))
            // PKCS8 written by hand from d and the public key: the same bytes WebCrypto exports
            assertEquals(p.s("pkcs8"), C.b64(C.pkcs8(priv, C.importPublic(p.s("public_key")))))
            assertEquals(p.s("d"), C.b64(C.unb64(p.s("pkcs8")).copyOfRange(36, 68)))
        }
    }

    @Test fun recoveryAndBackup() {
        val r = v.o("recovery")
        val key = C.unb64(r.s("key"), 20)
        assertEquals(r.s("display"), C.recoveryText(key))
        assertArrayEquals(key, C.parseRecovery(r.s("display").lowercase().replace("-", " ")))
        assertNull(C.parseRecovery("ABCD-EFGH"))
        assertEquals(r.s("bk"), C.b64(C.backupKey(key, r.s("user_id"))))
        val backup = C.sealBackup(key, r.s("user_id"), C.unb64(v.o("alex").s("pkcs8")), C.unb64(r.s("nonce"), 12))
        assertEquals(r.s("backup_json"), backup)
        assertEquals(v.o("alex").s("pkcs8"), C.b64(C.openBackup(key, r.s("user_id"), backup)))
        assertTrue(runCatching { C.openBackup(C.random(20), r.s("user_id"), backup) }.isFailure)
    }

    @Test fun wrapV2() {
        val w = v.o("wrap")
        val ch = v.o("channel")
        val by = w.o("wrapper")
        val eph = KeyPair(C.importPublic(w.o("ephemeral").s("public_key")), person(w.o("ephemeral")))
        val sam = v.o("sam")
        assertEquals(w.s("shared_eph"), C.b64(C.ecdh(eph.private, C.importPublic(sam.s("public_key")))))
        assertEquals(w.s("shared_by"), C.b64(C.ecdh(person(by), C.importPublic(sam.s("public_key")))))
        assertEquals(w.s("wk"), C.b64(C.hkdf(C.unb64(w.s("ikm")), ch.s("id").toByteArray(), w.s("info"))))
        val wrapped = C.wrap(C.unb64(ch.s("key"), 32), sam.s("public_key"), ch.s("id"), ch["epoch"]!!.jsonPrimitive.int, w.s("user_id"), by.s("user_id"), person(by), eph, C.unb64(w.s("nonce"), 12))
        assertEquals(w.s("wrapped_json"), wrapped)
        assertEquals(by.s("user_id"), C.wrapper(wrapped))
        // Sam opens it with the wrapper's key; a wrong candidate first does not matter, a wrong key alone fails
        val opened = C.unwrap(person(sam), wrapped, ch.s("id"), 1, w.s("user_id"), listOf(sam.s("public_key"), by.s("public_key")))
        assertEquals(ch.s("key"), C.b64(opened))
        assertTrue(runCatching { C.unwrap(person(sam), wrapped, ch.s("id"), 1, w.s("user_id"), listOf(sam.s("public_key"))) }.isFailure)
        assertTrue(runCatching { C.unwrap(person(sam), wrapped, ch.s("id"), 2, w.s("user_id"), listOf(by.s("public_key"))) }.isFailure)
    }

    @Test fun messageEnvelope() {
        val m = v.o("message")
        val ch = v.o("channel")
        val key = C.unb64(ch.s("key"), 32)
        val nonce = C.unb64(m.s("nonce24"), 24)
        assertEquals(m.s("mk"), C.b64(C.messageKey(key, nonce)))
        // the payload JSON is the same string the web client writes
        val payload = E2ee.payload(m.s("plaintext_json"))!!
        assertEquals(m.s("plaintext_json"), E2ee.payloadJson(payload))
        val sealed = C.seal(key, ch.s("id"), m.s("author_id"), 1, m.s("plaintext_json"), nonce)
        val env = json.decodeFromJsonElement(Envelope.serializer(), m.o("envelope"))
        assertEquals(env, sealed.envelope)
        assertEquals(m.s("kc"), sealed.envelope.kc)
        assertEquals(m.o("envelope").toString(), json.encodeToJsonElement(Envelope.serializer(), sealed.envelope).toString())
        val (text, mk) = C.open(key, ch.s("id"), m.s("author_id"), env)
        assertEquals(m.s("plaintext_json"), text)
        assertEquals(m.s("mk"), C.b64(mk))
        // a wrong commitment, author (AAD) or key never opens
        assertTrue(runCatching { C.open(key, ch.s("id"), m.s("author_id"), env.copy(kc = C.b64(C.random(32)))) }.isFailure)
        assertTrue(runCatching { C.open(key, ch.s("id"), v.o("sam").s("user_id"), env) }.isFailure)
        assertTrue(runCatching { C.open(C.random(32), ch.s("id"), m.s("author_id"), env) }.isFailure)
    }

    @Test fun attachment() {
        val a = v.o("attachment")
        val f = C.encryptFile(C.unb64(a.s("plaintext")), C.unb64(a.s("key"), 32), C.unb64(a.s("iv"), 12))
        assertEquals(a.s("ciphertext"), C.b64(f.data))
        assertEquals(a.s("plaintext"), C.b64(C.decryptFile(f.data, a.s("key"), a.s("iv"))))
    }

    @Test fun securityCode() {
        val code = v.o("security_code").s("code")
        assertEquals(code, C.securityCode(v.o("alex").s("public_key"), v.o("sam").s("public_key")))
        assertEquals(code, C.securityCode(v.o("sam").s("public_key"), v.o("alex").s("public_key")))
    }

    @Test fun rejectsBadInput() {
        assertTrue(runCatching { C.unb64("abc=") }.isFailure)
        assertTrue(runCatching { C.unb64("AAA", 3) }.isFailure)
        // a point that is not on the curve (invalid-curve attack) is refused
        val pub = C.unb64(v.o("sam").s("public_key")).also { it[64] = (it[64] + 1).toByte() }
        assertTrue(runCatching { C.importPublic(C.b64(pub)) }.isFailure)
        // a fresh key pair round-trips through PKCS8 and wraps for itself (a wrap whose wrapper is the member)
        val k = C.newAccountKey()
        assertEquals(k.pub, C.publicOf(k.pkcs8))
        val ck = C.random(32)
        val w = C.wrap(ck, k.pub, "1", 3, "2", "2", k.priv)
        assertArrayEquals(ck, C.unwrap(C.importPrivate(k.pkcs8), w, "1", 3, "2", listOf(k.pub)))
    }
}
