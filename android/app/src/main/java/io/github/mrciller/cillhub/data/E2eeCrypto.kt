package io.github.mrciller.cillhub.data

import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.math.BigInteger
import java.security.KeyFactory
import java.security.KeyPair
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.PublicKey
import java.security.SecureRandom
import java.security.interfaces.ECPrivateKey
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.security.spec.ECParameterSpec
import java.security.spec.ECPoint
import java.security.spec.ECPublicKeySpec
import java.security.spec.PKCS8EncodedKeySpec
import java.util.Base64
import javax.crypto.Cipher
import javax.crypto.KeyAgreement
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Encrypted DMs, the primitives (client/src/e2ee/crypto.ts): P-256 ECDH, HKDF-SHA256, AES-256-GCM, SHA-256 through JCA
 * only. Every binary value is base64url without padding. Pure JVM, so the unit test checks it against the server's vectors.
 */
object E2eeCrypto {
    private val random = SecureRandom()
    fun random(n: Int) = ByteArray(n).also { random.nextBytes(it) }

    fun b64(b: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(b)
    /** Canonical base64url only, of [len] bytes when given; throws otherwise. */
    fun unb64(s: String?, len: Int? = null): ByteArray {
        require(s != null && Regex("^[A-Za-z0-9_-]*$").matches(s) && s.length % 4 != 1) { "bad base64url" }
        val out = Base64.getUrlDecoder().decode(s)
        require((len == null || out.size == len) && b64(out) == s) { "bad base64url" }
        return out
    }

    fun sha256(vararg parts: ByteArray): ByteArray = MessageDigest.getInstance("SHA-256").run { parts.forEach { update(it) }; digest() }

    private fun hmac(key: ByteArray, data: ByteArray): ByteArray = Mac.getInstance("HmacSHA256").run { init(SecretKeySpec(key, "HmacSHA256")); doFinal(data) }
    /** HKDF-SHA256 with one output block (32 bytes); salts are never empty here. */
    fun hkdf(ikm: ByteArray, salt: ByteArray, info: String): ByteArray = hmac(hmac(salt, ikm), info.toByteArray() + 1.toByte())

    private fun gcm(mode: Int, key: ByteArray, iv: ByteArray, data: ByteArray, aad: ByteArray? = null): ByteArray =
        Cipher.getInstance("AES/GCM/NoPadding").run {
            init(mode, SecretKeySpec(key, "AES"), GCMParameterSpec(128, iv))
            aad?.let { updateAAD(it) }
            doFinal(data)
        }
    fun gcmEncrypt(key: ByteArray, iv: ByteArray, data: ByteArray, aad: ByteArray? = null) = gcm(Cipher.ENCRYPT_MODE, key, iv, data, aad)
    fun gcmDecrypt(key: ByteArray, iv: ByteArray, data: ByteArray, aad: ByteArray? = null) = gcm(Cipher.DECRYPT_MODE, key, iv, data, aad)

    // --- P-256 keys: raw uncompressed points and PKCS8 by hand, the same bytes WebCrypto exports ---------------------------------
    private val P = BigInteger("ffffffff00000001000000000000000000000000ffffffffffffffffffffffff", 16)
    private val B = BigInteger("5ac635d8aa3a93e7b3ebbd55769886bc651d06b0cc53b0f63bce3c3e27d2604b", 16)
    private fun newPair(): KeyPair = KeyPairGenerator.getInstance("EC").apply { initialize(ECGenParameterSpec("secp256r1")) }.generateKeyPair()
    private val params: ECParameterSpec by lazy { (newPair().public as ECPublicKey).params }
    private fun fixed(n: BigInteger): ByteArray = n.toByteArray().let { b -> ByteArray(32).also { b.copyInto(it, 32 - minOf(32, b.size), maxOf(0, b.size - 32)) } }

    fun rawPublic(k: PublicKey): ByteArray = (k as ECPublicKey).w.let { byteArrayOf(4) + fixed(it.affineX) + fixed(it.affineY) }
    /** A raw public key that is really a point on P-256 (an invalid point would leak key bits through ECDH). */
    fun importPublic(raw: String): PublicKey {
        val b = unb64(raw, 65)
        require(b[0] == 4.toByte()) { "not an uncompressed point" }
        val x = BigInteger(1, b.copyOfRange(1, 33)); val y = BigInteger(1, b.copyOfRange(33, 65))
        require(x < P && y < P && y.modPow(BigInteger.valueOf(2), P) == x.pow(3).subtract(x.multiply(BigInteger.valueOf(3))).add(B).mod(P)) { "not on the curve" }
        return KeyFactory.getInstance("EC").generatePublic(ECPublicKeySpec(ECPoint(x, y), params))
    }
    private val PKCS8_HEAD = unb64("MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQg")
    private val PKCS8_MID = byteArrayOf(0xa1.toByte(), 0x44, 0x03, 0x42, 0x00)
    /** PKCS8 with the public key inside, as WebCrypto writes it (Firefox imports only this form). */
    fun pkcs8(priv: PrivateKey, pub: PublicKey): ByteArray = PKCS8_HEAD + fixed((priv as ECPrivateKey).s) + PKCS8_MID + rawPublic(pub)
    fun importPrivate(pkcs8: ByteArray): PrivateKey = KeyFactory.getInstance("EC").generatePrivate(PKCS8EncodedKeySpec(pkcs8))
    /** The raw public key inside a PKCS8 of the form above. */
    fun publicOf(pkcs8: ByteArray): String = b64(pkcs8.copyOfRange(pkcs8.size - 65, pkcs8.size))

    fun ecdh(priv: PrivateKey, pub: PublicKey): ByteArray = KeyAgreement.getInstance("ECDH").run { init(priv); doPhase(pub, true); generateSecret() }

    class AccountKey(val priv: PrivateKey, val pub: String, val pkcs8: ByteArray)
    fun newAccountKey(): AccountKey = newPair().let { p -> AccountKey(p.private, b64(rawPublic(p.public)), pkcs8(p.private, p.public)) }

    // --- recovery key: 20 random bytes, shown as base32 in groups of 4 ----------------------------------------------------------
    private const val BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
    fun recoveryText(key: ByteArray): String {
        var bits = 0; var value = 0; val out = StringBuilder()
        for (byte in key) {
            value = ((value shl 8) or (byte.toInt() and 255)) and 0xffff; bits += 8
            while (bits >= 5) { out.append(BASE32[(value ushr (bits - 5)) and 31]); bits -= 5 }
        }
        if (bits > 0) out.append(BASE32[(value shl (5 - bits)) and 31])
        return out.chunked(4).joinToString("-")
    }
    /** The 20 bytes from what the user typed (case, spaces and dashes do not matter), or null. */
    fun parseRecovery(text: String): ByteArray? {
        val s = text.uppercase().replace(Regex("[\\s-]"), "")
        if (!Regex("^[A-Z2-7]{32}$").matches(s)) return null
        val out = ByteArray(20); var bits = 0; var value = 0; var i = 0
        for (c in s) {
            value = ((value shl 5) or BASE32.indexOf(c)) and 0xffff; bits += 5
            if (bits >= 8) { out[i++] = (value ushr (bits - 8)).toByte(); bits -= 8 }
        }
        return out
    }
    fun backupKey(recovery: ByteArray, userId: String) = hkdf(recovery, userId.toByteArray(), "cillhub-e2ee-backup-v1")
    fun sealBackup(recovery: ByteArray, userId: String, pkcs8: ByteArray, n: ByteArray = random(12)): String =
        """{"v":1,"n":"${b64(n)}","c":"${b64(gcmEncrypt(backupKey(recovery, userId), n, pkcs8))}"}"""
    /** The PKCS8 in a backup; throws when the recovery key is wrong. */
    fun openBackup(recovery: ByteArray, userId: String, backup: String): ByteArray {
        val o = json.parseToJsonElement(backup).jsonObject
        require(o["v"]?.jsonPrimitive?.contentOrNull == "1") { "unknown backup version" }
        return gcmDecrypt(backupKey(recovery, userId), unb64(o.str("n"), 12), unb64(o.str("c")))
    }
    private fun kotlinx.serialization.json.JsonObject.str(k: String) = this[k]?.jsonPrimitive?.contentOrNull

    // --- channel key, wrapped per member (wrap v2: the wrapper's account key goes into the key, so a wrap is authenticated) -----
    private fun wrapKey(ikm: ByteArray, channelId: String, epoch: Int, userId: String, by: String) =
        hkdf(ikm, channelId.toByteArray(), "cillhub-e2ee-wrap-v2|$epoch|$userId|$by")
    /** The channel key wrapped for [userId] by [by] (an ephemeral key per wrap unless one is given, for test vectors). */
    fun wrap(channelKey: ByteArray, memberPub: String, channelId: String, epoch: Int, userId: String, by: String, byPriv: PrivateKey, eph: KeyPair = newPair(), n: ByteArray = random(12)): String {
        val member = importPublic(memberPub)
        val wk = wrapKey(ecdh(eph.private, member) + ecdh(byPriv, member), channelId, epoch, userId, by)
        return """{"by":"$by","eph":"${b64(rawPublic(eph.public))}","n":"${b64(n)}","c":"${b64(gcmEncrypt(wk, n, channelKey))}"}"""
    }
    fun wrapper(wrapped: String): String? = runCatching { json.parseToJsonElement(wrapped).jsonObject.str("by") }.getOrNull()
    /** Opens a wrap with the first of [byPubs] (the wrapper's keys known here) that fits; throws when none does. */
    fun unwrap(priv: PrivateKey, wrapped: String, channelId: String, epoch: Int, userId: String, byPubs: List<String>): ByteArray {
        val o = json.parseToJsonElement(wrapped).jsonObject
        val by = o.str("by") ?: error("no wrapper")
        val first = ecdh(priv, importPublic(o.str("eph") ?: ""))
        for (pub in byPubs.distinct()) {
            val key = runCatching { gcmDecrypt(wrapKey(first + ecdh(priv, importPublic(pub)), channelId, epoch, userId, by), unb64(o.str("n"), 12), unb64(o.str("c"))) }.getOrNull()
            if (key != null && key.size == 32) return key
        }
        error("wrap does not open")
    }

    // --- messages -----------------------------------------------------------------------------------------------------------
    fun messageKey(channelKey: ByteArray, nonce24: ByteArray) = hkdf(channelKey, nonce24, "cillhub-e2ee-msg-v1")
    private fun aad(channelId: String, authorId: String) = "$channelId|$authorId".toByteArray()
    class Sealed(val envelope: Envelope, val mk: ByteArray)
    fun seal(channelKey: ByteArray, channelId: String, authorId: String, epoch: Int, plaintext: String, nonce: ByteArray = random(24)): Sealed {
        val mk = messageKey(channelKey, nonce)
        val c = gcmEncrypt(mk, nonce.copyOf(12), plaintext.toByteArray(), aad(channelId, authorId))
        return Sealed(Envelope(1, epoch, b64(nonce), b64(c), b64(sha256(mk, nonce))), mk)
    }
    /** The plaintext and message key, after checking the key commitment (a message that fails it could not be reported). */
    fun open(channelKey: ByteArray, channelId: String, authorId: String, env: Envelope): Pair<String, ByteArray> {
        val nonce = unb64(env.n, 24)
        val mk = messageKey(channelKey, nonce)
        require(b64(sha256(mk, nonce)) == env.kc) { "key commitment does not match" }
        val bytes = gcmDecrypt(mk, nonce.copyOf(12), unb64(env.c), aad(channelId, authorId))
        val text = Charsets.UTF_8.newDecoder().decode(java.nio.ByteBuffer.wrap(bytes)).toString() // strict, like TextDecoder fatal
        return text to mk
    }

    // --- attachments: each file its own key ---------------------------------------------------------------------------------
    class EncFile(val k: String, val n: String, val data: ByteArray)
    fun encryptFile(data: ByteArray, k: ByteArray = random(32), n: ByteArray = random(12)) = EncFile(b64(k), b64(n), gcmEncrypt(k, n, data))
    fun decryptFile(data: ByteArray, k: String, n: String) = gcmDecrypt(unb64(k, 32), unb64(n, 12), data)

    /** 60 digits from SHA-256 of both raw public keys, sorted bytewise: the big-endian number mod 10^60, in groups of 5. */
    fun securityCode(a: String, b: String): String {
        val x = unb64(a, 65); val y = unb64(b, 65)
        val cmp = (0 until 65).firstOrNull { x[it] != y[it] }?.let { (x[it].toInt() and 255) - (y[it].toInt() and 255) } ?: 0
        val h = if (cmp <= 0) sha256(x, y) else sha256(y, x)
        return BigInteger(1, h).mod(BigInteger.TEN.pow(60)).toString().padStart(60, '0').chunked(5).joinToString(" ")
    }
}
