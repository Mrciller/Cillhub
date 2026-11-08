package io.github.mrciller.cillhub

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The login token the web client hands over, encrypted with an AES-256-GCM key that lives in the
 * Android Keystore (never leaves it). Stored as base64(iv || ciphertext) in private prefs.
 */
object TokenStore {
    private const val ALIAS = "cillcord-token-key"
    private const val PREFS = "token"
    @Volatile private var cached: String? = null
    @Volatile private var loaded = false

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(
            KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        )
        return gen.generateKey()
    }

    @Synchronized
    fun get(ctx: Context): String? {
        if (loaded) return cached
        val stored = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("v", null)
        cached = stored?.let {
            try {
                val raw = Base64.decode(it, Base64.NO_WRAP)
                val c = Cipher.getInstance("AES/GCM/NoPadding")
                c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
                String(c.doFinal(raw, 12, raw.size - 12), Charsets.UTF_8)
            } catch (e: Exception) {
                null // key gone (e.g. restored backup on a new device): the user logs in again
            }
        }
        loaded = true
        return cached
    }

    @Synchronized
    fun set(ctx: Context, token: String) {
        val c = Cipher.getInstance("AES/GCM/NoPadding")
        c.init(Cipher.ENCRYPT_MODE, key())
        val out = c.iv + c.doFinal(token.toByteArray(Charsets.UTF_8))
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("v", Base64.encodeToString(out, Base64.NO_WRAP)).apply()
        cached = token
        loaded = true
    }

    @Synchronized
    fun clear(ctx: Context) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().clear().apply()
        cached = null
        loaded = true
    }
}
