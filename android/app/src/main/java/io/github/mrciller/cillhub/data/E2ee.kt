package io.github.mrciller.cillhub.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import io.github.mrciller.cillhub.Api
import io.github.mrciller.cillhub.Config
import io.github.mrciller.cillhub.Hub
import io.github.mrciller.cillhub.R
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.Request
import java.io.File
import java.security.KeyStore
import java.security.PrivateKey
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec
import io.github.mrciller.cillhub.data.E2eeCrypto as C

/**
 * Encrypted DMs on this device (client/src/e2ee/session.ts): the account key (PKCS8 sealed with an Android Keystore key),
 * channel keys and decrypted messages in memory, pinned contact keys and the highest epoch seen per channel in prefs.
 * DMs live on the hub only, so every call goes to Session.rest. Never logs keys or plaintext.
 */
object E2ee {
    // LOST: the server has no key for this account, but this device still holds one (kept, never deleted on the server's word)
    enum class Status { UNKNOWN, OFF, LOCKED, READY, LOST }

    @Serializable data class FileRef(val id: String, val k: String, val n: String, val name: String = "file", val type: String = "", val size: Long? = null, val w: Int? = null, val h: Int? = null)
    @Serializable data class Payload(val content: String = "", val files: List<FileRef> = emptyList())
    class SendKey(val key: ByteArray, val epoch: Int)
    // stale: members whose current wrap is a tombstone (they reset their key): the epoch is renewed before sending
    private class Keys(val epoch: Int, val keys: Map<Int, ByteArray>, @Volatile var wrapped: List<String>, val unverified: Boolean, val stale: List<String> = emptyList())
    /** A decrypt result: the payload, or null when the message cannot be opened. */
    private class Opened(val p: Payload?)
    @Serializable private data class KeysAnswer(val publicKey: String = "", val backup: String = "")
    @Serializable private data class Wrapped(val epoch: Int, val wrapped: String)
    @Serializable private data class ChannelKeys(val epoch: Int = 0, val keys: List<Wrapped> = emptyList(), val wrappedUsers: List<String> = emptyList(), val staleUsers: List<String> = emptyList())

    // the payload JSON is the web client's JSON.stringify({content, files}): every field, nulls left out
    private val pjson = Json { encodeDefaults = true; explicitNulls = false; ignoreUnknownKeys = true }
    private val app get() = Session.app

    @Volatile private var owner = ""
    @Volatile var status = Status.UNKNOWN; private set
    @Volatile private var priv: PrivateKey? = null
    @Volatile var myPub = ""; private set
    private val loading = Mutex()
    private val channels = ConcurrentHashMap<String, Keys>()
    private val pubs = ConcurrentHashMap<String, String>() // user id -> raw public key, "" = none
    private val plains = ConcurrentHashMap<String, Opened>()
    private val inflight = ConcurrentHashMap.newKeySet<String>()

    private val _version = MutableStateFlow(0)
    /** Changes whenever keys, statuses or pins change: the UI re-reads its lines. */
    val version: StateFlow<Int> = _version
    private fun changed() { _version.value++ }

    /** This device will not send here right now (no key, an unverified or changed key): the text says why. */
    class Refused(msg: String) : Exception(msg)
    private fun err(res: Int, vararg args: Any) = Refused(app.getString(res, *args))

    // --- local key storage: PKCS8 sealed with an AES-GCM key that never leaves the Keystore (as TokenStore) --------------------
    private const val ALIAS = "cillhub-e2ee-key"
    private fun prefs() = app.getSharedPreferences("e2ee", Context.MODE_PRIVATE)
    private fun keystoreKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setKeySize(256).build())
        }.generateKey()
    }
    private fun saveLocal(userId: String, pkcs8: ByteArray) {
        val c = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, keystoreKey()) }
        prefs().edit().putString("key:$userId", C.b64(c.iv + c.doFinal(pkcs8))).commit()
    }
    private fun loadLocal(userId: String): ByteArray? = prefs().getString("key:$userId", null)?.let {
        runCatching {
            val raw = C.unb64(it)
            Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, keystoreKey(), GCMParameterSpec(128, raw, 0, 12)) }.doFinal(raw, 12, raw.size - 12)
        }.getOrNull() // Keystore key gone (backup restored on a new phone): the recovery key opens it again
    }
    private fun dropLocal(userId: String) = prefs().edit().remove("key:$userId").apply()

    // --- account ------------------------------------------------------------------------------------------------------------
    private fun meId() = Session.store.value.me?.id ?: Hub.meId ?: ""
    private fun notFound(e: Throwable) = e is ApiError && e.status == 404

    /** Memory only (logout): the sealed key stays for this account, like the web client's IndexedDB. */
    fun forget() {
        status = Status.UNKNOWN; priv = null; myPub = ""
        channels.clear(); pubs.clear(); plains.clear(); inflight.clear()
        runCatching { File(app.cacheDir, "e2ee").deleteRecursively() }
        changed()
    }

    /** Loads this account's state once per sign-in. */
    suspend fun ready() {
        loading.withLock {
            // a notification reply with the app closed: no READY yet, so ask who we are
            val me = meId().ifEmpty { runCatching { Session.rest.get<User>("/users/@me").id }.getOrDefault("") }
            if (owner != me) { forget(); owner = me }
            if (owner.isEmpty() || status != Status.UNKNOWN) return
            val server = try { Session.rest.get<KeysAnswer>("/users/@me/e2ee/keys") } catch (e: Exception) { if (notFound(e)) null else throw e }
            var local = withContext(Dispatchers.IO) { loadLocal(owner) }
            if (server != null && local?.let { C.publicOf(it) } != server.publicKey) { // a reset whose answer got lost
                withContext(Dispatchers.IO) { loadLocal("$owner:next") }?.takeIf { C.publicOf(it) == server.publicKey }?.let { withContext(Dispatchers.IO) { saveLocal(owner, it) }; local = it }
            }
            when {
                server == null -> status = if (local != null) Status.LOST else Status.OFF
                local != null && C.publicOf(local) == server.publicKey -> { priv = C.importPrivate(local); myPub = server.publicKey; status = Status.READY }
                else -> status = Status.LOCKED
            }
        }
        changed()
        if (status == Status.READY) reopenAll()
    }

    private fun settle(pub: String, key: PrivateKey) {
        priv = key; myPub = pub; status = Status.READY
        channels.clear(); plains.clear(); inflight.clear()
        pubs[owner] = pub
        changed()
        reopenAll()
    }
    private fun reopenAll() = Session.store.update { Reducer.reopen(it, null) }

    /** Turns encryption on (or resets it): a new account key, its backup, and the recovery key text to show once. */
    suspend fun enable(): String {
        ready()
        val k = C.newAccountKey()
        val recovery = C.random(20)
        val backup = C.sealBackup(recovery, owner, k.pkcs8)
        // kept aside before the server knows it (never lost if the answer is), in use only once the server took it,
        // so a failed reset leaves the old key working here
        withContext(Dispatchers.IO) { saveLocal("$owner:next", k.pkcs8) }
        Session.rest.request("PUT", "/users/@me/e2ee/keys", buildJsonObject { put("public_key", k.pub); put("backup", backup) })
        withContext(Dispatchers.IO) { saveLocal(owner, k.pkcs8); dropLocal("$owner:next") }
        settle(k.pub, k.priv)
        return C.recoveryText(recovery)
    }

    /** A new device: the recovery key opens the backup; the private key must match the public key on the server. */
    suspend fun recover(text: String) {
        ready()
        val rk = C.parseRecovery(text) ?: throw err(R.string.e2ee_recovery_invalid)
        val server = Session.rest.get<KeysAnswer>("/users/@me/e2ee/keys")
        val (pkcs8, key) = try {
            val p = C.openBackup(rk, owner, server.backup)
            val k = C.importPrivate(p)
            val probe = C.newAccountKey()
            check(C.ecdh(k, C.importPublic(probe.pub)).contentEquals(C.ecdh(probe.priv, C.importPublic(server.publicKey))))
            p to k
        } catch (e: Exception) { throw err(R.string.e2ee_recovery_wrong) }
        withContext(Dispatchers.IO) { saveLocal(owner, pkcs8) }
        settle(server.publicKey, key)
    }

    // --- contacts: public keys, pins (every key accepted for a contact, newest last) ---------------------------------------------
    private fun listPref(name: String): JsonObject = runCatching { json.parseToJsonElement(prefs().getString("$name:$owner", null) ?: "{}").jsonObject }.getOrDefault(JsonObject(emptyMap()))
    private fun pins(id: String): List<String> = runCatching { listPref("pins")[id]!!.jsonArray.map { it.jsonPrimitive.content } }.getOrDefault(emptyList())
    @Synchronized private fun pin(id: String, pub: String) {
        val all = listPref("pins")
        val next = pins(id).filter { it != pub } + pub
        prefs().edit().putString("pins:$owner", JsonObject(all + (id to kotlinx.serialization.json.JsonArray(next.map { kotlinx.serialization.json.JsonPrimitive(it) }))).toString()).apply()
    }

    // --- members accepted on this device per DM (client/src/e2ee/members.ts): the server's list alone never decides who gets the key
    private fun memoryOf(id: String): E2eeMembers.Memory? = listPref("members")[id]?.let { runCatching { json.decodeFromJsonElement(E2eeMembers.Memory.serializer(), it) }.getOrNull() }
    @Synchronized private fun keepMemory(id: String, m: E2eeMembers.Memory) {
        prefs().edit().putString("members:$owner", JsonObject(listPref("members") + (id to json.encodeToJsonElement(E2eeMembers.Memory.serializer(), m))).toString()).apply()
    }
    /** The server's member list against the accepted one; stores it on first use (a 1:1 DM only with exactly one other member). */
    private fun memberCheck(ch: Channel) = E2eeMembers.check(ch.type, memoryOf(ch.id), members(ch).drop(1)).also { r -> r.next?.let { keepMemory(ch.id, it) } }
    /** Members the server lists in a group DM that this device has not accepted (nothing is wrapped for them until Accept). */
    fun addedMembers(ch: Channel): List<String> = if (isEncrypted(ch) && ch.type == 3 && memoryOf(ch.id) != null) memberCheck(ch).added else emptyList()
    /** Accepts a member added to a group DM; the next send makes a new key for everyone (theirs never opens older messages). */
    fun acceptAdded(ch: Channel, id: String) {
        memoryOf(ch.id)?.let { keepMemory(ch.id, E2eeMembers.accept(it, id, ch.e2eeEpoch)) }
        channels.clear() // wraps they made open now
        changed()
        retryFailed()
    }
    /** Refuses while the member list cannot be used to send: a 1:1 DM with other members than accepted, or unaccepted additions. */
    private fun refuseMembers(ch: Channel) {
        val r = memberCheck(ch)
        if (r.bad) throw err(R.string.e2ee_unverified)
        r.added.firstOrNull()?.let { throw err(R.string.e2ee_member_added, nameOf(ch, it)) }
    }
    /** The key to wrap for: own, else the newest key pinned here, once the answer the key-change check saw shows one (never a later answer). */
    private fun wrapPub(id: String): String? = if (id == owner) myPub.ifEmpty { null } else E2eeMembers.wrapTarget(pubs[id], pins(id))

    /** Someone's public key, fresh from the server (pinned on first sight); null when they have none. */
    private suspend fun publicKeyOf(id: String): String? {
        if (id == owner && myPub.isNotEmpty()) return myPub.also { pubs[id] = it }
        val pub = try { Session.rest.get<KeysAnswer>("/users/$id/e2ee/keys").publicKey } catch (e: Exception) { if (notFound(e)) "" else throw e }
        pubs[id] = pub
        if (pub.isNotEmpty() && pins(id).isEmpty()) pin(id, pub)
        return pub.ifEmpty { null }
    }
    /** A member whose key differs from the one accepted on this device. */
    fun keyChanged(id: String) = pubs[id].let { !it.isNullOrEmpty() && pins(id).lastOrNull().let { p -> p != null && p != it } }
    fun acceptKey(id: String) {
        pubs[id]?.takeIf { it.isNotEmpty() }?.let { pin(id, it) }
        channels.clear() // wraps made with the accepted key open now
        changed()
        retryFailed()
    }
    /** Keys changed: messages that could not be opened are tried again. */
    private fun retryFailed() {
        if (plains.entries.removeIf { it.value.p == null }) Session.scope.launch { Session.store.update { Reducer.reopen(it, null) } }
    }
    /** null = not loaded yet, "" = has no key. */
    fun publicKey(id: String): String? = pubs[id]

    // --- channels -----------------------------------------------------------------------------------------------------------
    fun isDm(ch: Channel?) = ch != null && ch.guildId == null && (ch.type == 1 || ch.type == 3)
    fun isEncrypted(ch: Channel?) = isDm(ch) && ch!!.e2eeEpoch > 0
    private fun members(ch: Channel) = listOf(owner) + ch.recipients.map { it.id }.filter { it != owner }
    private fun current(ch: Channel) = Session.store.value.channels[ch.id] ?: ch

    /** The highest epoch this device saw per channel: a channel once encrypted never gets plain text from here again. */
    fun seenEpoch(channelId: String): Int = runCatching { listPref("epochs")[channelId]!!.jsonPrimitive.content.toInt() }.getOrDefault(0)
    @Synchronized private fun see(channelId: String, epoch: Int) {
        if (epoch <= seenEpoch(channelId)) return
        prefs().edit().putString("epochs:$owner", JsonObject(listPref("epochs") + (channelId to kotlinx.serialization.json.JsonPrimitive(epoch))).toString()).apply()
    }
    /** The server shows an older key than this device saw, a 1:1 DM whose members changed, or a current key it cannot verify: nothing is sent. */
    fun unverified(ch: Channel) = isDm(ch) && (ch.e2eeEpoch < seenEpoch(ch.id) || channels[ch.id]?.unverified == true || (isEncrypted(ch) && status == Status.READY && memberCheck(ch).bad))
    /** Only a current key that failed its check may be renewed by hand (after comparing security codes). */
    fun renewable(ch: Channel) = isDm(ch) && channels[ch.id]?.unverified == true && ch.e2eeEpoch >= seenEpoch(ch.id) && !memberCheck(ch).bad && addedMembers(ch).isEmpty()
    /** A user message without encryption in a DM this device saw encrypted (sent before, or put there by the server). */
    fun plainInEncrypted(ch: Channel?, m: Message) =
        isDm(ch) && m.e2eeEnvelope == null && (m.type == 0 || m.type == 19) && !m.author.system && !m.pending && owner.isNotEmpty() && seenEpoch(ch!!.id) > 0

    private fun setEpoch(id: String, epoch: Int) = Session.store.update { s -> s.channels[id]?.let { s.copy(channels = s.channels + (id to it.copy(e2eeEpoch = epoch))) } ?: s }

    /** A channel the store may not have (a notification reply with the app closed). */
    suspend fun channel(id: String): Channel = Session.store.value.channels[id] ?: Session.rest.get<Channel>("/channels/$id").also { c ->
        Session.store.update { s -> if (s.channels.containsKey(id)) s else s.copy(channels = s.channels + (id to c)) }
    }

    /** Plain text must not go to a DM this device saw encrypted (the server turned it back). Every plain send calls it. */
    suspend fun refusePlain(ch: Channel?) {
        if (!isDm(ch)) return
        runCatching { ready() }
        if (seenEpoch(ch!!.id) > current(ch).e2eeEpoch) throw err(R.string.e2ee_unverified)
    }

    /** Opening a DM: fresh member keys; a DM whose members all have keys is encrypted right away. */
    suspend fun openChannel(ch: Channel) {
        ready()
        if (!isDm(ch)) return
        if (ch.e2eeEpoch > 0) see(ch.id, ch.e2eeEpoch)
        for (id in members(ch)) publicKeyOf(id)
        val all = members(ch).all { !pubs[it].isNullOrEmpty() } && ch.recipients.none { it.bot || it.system }
        if (status == Status.READY && all && ch.e2eeEpoch == 0 && seenEpoch(ch.id) == 0) runCatching { newEpoch(ch, 1) } // refused while a key changed
            .onFailure { android.util.Log.w("CillhubE2ee", "first key not set up: ${it.javaClass.simpleName} ${it.message}") }
        if (status == Status.READY && current(ch).e2eeEpoch > 0) runCatching { channelKeys(current(ch)) }
        changed()
    }

    private suspend fun channelKeys(ch: Channel, fresh: Boolean = false): Keys {
        val have = channels[ch.id]
        if (have != null && !fresh && have.epoch == ch.e2eeEpoch) return have
        val r = Session.rest.get<ChannelKeys>("/channels/${ch.id}/e2ee/keys")
        val keys = HashMap(have?.keys.orEmpty())
        memberCheck(ch)
        val mem = memoryOf(ch.id)
        var unverified = false
        val me = priv
        for (k in r.keys) {
            if (keys.containsKey(k.epoch) || me == null || k.wrapped.isEmpty()) continue // '' = tombstone after this account's reset: no key
            // a wrap counts only when this account or a member accepted on this device made it (older epochs: also one who left
            // since). A wrap made for an older account key (after a reset) does not open: those messages stay unreadable here.
            val by = C.wrapper(k.wrapped)
            val key = if (by != null && E2eeMembers.trusted(mem, owner, by, k.epoch == r.epoch)) runCatching { C.unwrap(me, k.wrapped, ch.id, k.epoch, owner, candidates(by)) }.getOrNull() else null
            if (key != null) keys[k.epoch] = key else if (k.epoch == r.epoch) unverified = true
        }
        val out = Keys(r.epoch, keys, r.wrappedUsers, unverified, r.staleUsers)
        channels[ch.id] = out
        if (keys.size > (have?.keys?.size ?: 0)) retryFailed()
        see(ch.id, r.epoch)
        if (r.epoch != ch.e2eeEpoch) setEpoch(ch.id, r.epoch)
        if (unverified != (have?.unverified == true)) changed()
        return out
    }

    /** Keys that may have made a wrap of [by]: own key; once a contact is pinned only pinned/accepted keys (newest first), else the server's on first sight. */
    private suspend fun candidates(by: String): List<String> {
        if (by == owner) return listOf(myPub)
        if (pins(by).isEmpty()) runCatching { publicKeyOf(by) }
        return pins(by).reversed()
    }
    /** A member whose server key is not the one accepted here: nothing is wrapped for or sent to them until the user accepts it. */
    private fun refuseChanged(ch: Channel) {
        members(ch).firstOrNull { keyChanged(it) }?.let { throw err(R.string.e2ee_key_changed_send, nameOf(ch, it)) }
    }

    private suspend fun newEpoch(ch: Channel, epoch: Int) {
        val me = priv ?: throw err(R.string.e2ee_send_locked)
        refuseMembers(ch) // stores the list on the first key of a DM
        val ids = members(ch)
        for (id in ids) if (pubs[id].isNullOrEmpty()) publicKeyOf(id) // pinned on first sight
        refuseChanged(ch)
        val key = C.random(32)
        val wraps = buildJsonObject {
            for (id in ids) put(id, C.wrap(key, wrapPub(id) ?: throw err(R.string.e2ee_member_no_key, nameOf(ch, id)), ch.id, epoch, id, owner, me))
        }
        try {
            Session.rest.request("PUT", "/channels/${ch.id}/e2ee/epoch", buildJsonObject { put("epoch", epoch); put("wraps", wraps) })
        } catch (e: ApiError) {
            if (e.status == 409) { channelKeys(ch.copy(e2eeEpoch = epoch), fresh = true); return } // someone else was first
            throw e
        }
        channels[ch.id] = Keys(epoch, channels[ch.id]?.keys.orEmpty() + (epoch to key), ids, false)
        see(ch.id, epoch)
        setEpoch(ch.id, epoch)
        changed()
    }
    fun nameOf(ch: Channel, id: String) = (ch.recipients.firstOrNull { it.id == id } ?: Session.store.value.users[id])?.displayName ?: app.getString(R.string.e2ee_a_member)

    /** The key to send with, or null when the DM stays plain. Renews the key after a member left, wraps for new members. */
    suspend fun sendKey(chIn: Channel, fresh: Boolean = false): SendKey? {
        if (!isDm(chIn)) return null
        ready()
        var ch = current(chIn)
        if (ch.e2eeEpoch == 0) {
            if (seenEpoch(ch.id) > 0) throw err(R.string.e2ee_unverified)
            if (status != Status.READY) return null
            openChannel(ch)
            ch = current(ch)
            if (ch.e2eeEpoch == 0) return null
        }
        if (status != Status.READY) throw statusError()
        var c = channelKeys(ch, fresh)
        if (c.epoch < seenEpoch(ch.id)) throw err(R.string.e2ee_unverified)
        val ids = members(ch)
        for (id in ids) runCatching { publicKeyOf(id) } // fresh server keys, so a changed one is caught before sending
        refuseChanged(ch)
        refuseMembers(ch)
        val plan = E2eeMembers.plan(c.epoch, c.unverified, c.keys.containsKey(c.epoch), c.wrapped, c.stale, ids, memoryOf(ch.id)?.renew)
        // a wrap for me that failed its check: never renewed silently (the user compares codes and renews by hand)
        if (plan == E2eeMembers.Plan.REFUSE) throw err(R.string.e2ee_unverified)
        if (plan == E2eeMembers.Plan.RENEW) {
            newEpoch(ch, c.epoch + 1)
            c = channelKeys(current(ch))
        } else {
            val lacking = ids.filter { it !in c.wrapped } // all accepted: refuseMembers let nobody else through
            if (lacking.isNotEmpty()) {
                val key = c.keys.getValue(c.epoch)
                val me = priv!!
                val wraps = buildJsonObject {
                    for (id in lacking) wrapPub(id)?.let { put(id, C.wrap(key, it, ch.id, c.epoch, id, owner, me)) }
                }
                if (wraps.isNotEmpty()) runCatching {
                    Session.rest.call<ChannelKeys>("PUT", "/channels/${ch.id}/e2ee/wraps", buildJsonObject { put("epoch", c.epoch); put("wraps", wraps) })
                }.onSuccess { c.wrapped = it.wrappedUsers }
            }
        }
        if (c.unverified) throw err(R.string.e2ee_unverified)
        val key = c.keys[c.epoch] ?: throw err(R.string.e2ee_cannot_encrypt)
        return SendKey(key, c.epoch)
    }

    private fun statusError() = err(when (status) { Status.LOCKED -> R.string.e2ee_send_locked; Status.LOST -> R.string.e2ee_lost; else -> R.string.e2ee_send_off })

    /** The user compared security codes and renews the key of a DM whose current key could not be verified. */
    suspend fun renewKey(chIn: Channel) {
        ready()
        if (status != Status.READY) throw statusError()
        val ch = current(chIn)
        if (ch.e2eeEpoch < seenEpoch(ch.id)) throw err(R.string.e2ee_unverified)
        for (id in members(ch)) runCatching { publicKeyOf(id) }
        refuseChanged(ch)
        refuseMembers(ch)
        newEpoch(ch, channelKeys(ch, fresh = true).epoch + 1)
    }

    /** Seals a payload for a channel with a send key. */
    fun seal(channelId: String, k: SendKey, content: String, files: List<FileRef> = emptyList()): Envelope =
        C.seal(k.key, channelId, owner, k.epoch, payloadJson(Payload(content, files))).envelope
    internal fun payloadJson(p: Payload) = pjson.encodeToString(Payload.serializer(), p)

    // --- reading --------------------------------------------------------------------------------------------------------------
    private fun cacheKey(id: String, env: Envelope) = "$id:${env.kc}"
    /** Remembers what we just sent, so our own message shows without a decrypt round. */
    fun remember(m: Message, content: String, files: List<FileRef>) { m.e2eeEnvelope?.let { plains[cacheKey(m.id, it)] = Opened(Payload(content, files)) } }
    fun plainOf(m: Message): Payload? = m.e2eeEnvelope?.let { plains[cacheKey(m.id, it)]?.p }

    internal fun payload(text: String): Payload? {
        val p = runCatching { pjson.decodeFromString(Payload.serializer(), text) }.getOrNull() ?: return null
        if (p.content.length > 2000 || p.files.size > 10 || p.files.any { it.id.length > 20 || it.k.length > 64 || it.n.length > 32 }) return null
        return p.copy(files = p.files.map { f -> f.copy(name = f.name.takeIf { it.length <= 256 } ?: "file", type = f.type.takeIf { it.length <= 128 } ?: "") })
    }

    /** Opens a message: the payload, null when it cannot be opened, or LOCKED when this device has no key. */
    suspend fun decrypt(m: Message): Any? {
        val env = m.e2eeEnvelope ?: return null
        plains[cacheKey(m.id, env)]?.let { return it.p }
        ready()
        if (status == Status.LOST) { plains[cacheKey(m.id, env)] = Opened(null); return null } // shown as "cannot decrypt"
        if (status != Status.READY) return Seal.LOCKED
        val r = try {
            val ch = channel(m.channelId)
            var keys = channelKeys(ch)
            if (!keys.keys.containsKey(env.e) && env.e >= keys.epoch) keys = channelKeys(ch, fresh = true) // a key that arrived after we loaded
            keys.keys[env.e]?.let { payload(C.open(it, m.channelId, m.author.id, env).first) }
        } catch (e: ApiError) {
            if (e.status == 0) return Seal.PENDING // offline: tried again on the next view
            null
        } catch (e: Exception) { null }
        plains[cacheKey(m.id, env)] = Opened(r)
        return r
    }

    /** Reducer.open: a message with an envelope as plaintext, or without text and files until it is opened. */
    fun view(m: Message): Message {
        val ref = m.referencedMessage?.let(::view)
        val withRef = if (ref === m.referencedMessage) m else m.copy(referencedMessage = ref)
        val env = m.e2eeEnvelope ?: return withRef
        if (m.seal == Seal.OPEN) return withRef
        val hit = plains[cacheKey(m.id, env)]
        return when {
            hit?.p != null -> applied(withRef, hit.p)
            hit != null -> withRef.copy(content = "", embeds = emptyList(), seal = Seal.FAIL)
            status == Status.LOCKED || status == Status.OFF -> withRef.copy(content = "", embeds = emptyList(), seal = Seal.LOCKED)
            else -> { schedule(m); withRef.copy(content = "", embeds = emptyList(), seal = Seal.PENDING) }
        }
    }
    private fun applied(m: Message, p: Payload) = m.copy(
        content = p.content, embeds = emptyList(), seal = Seal.OPEN,
        attachments = p.files.mapNotNull { f ->
            val a = f.id.takeIf { Regex("^\\d{1,2}$").matches(it) }?.let { m.attachments.getOrNull(it.toInt()) } ?: return@mapNotNull null
            a.copy(filename = f.name, contentType = f.type, size = f.size ?: a.size, width = f.w, height = f.h, key = f.k, iv = f.n)
        },
    )
    private fun schedule(m: Message) {
        if (!inflight.add(cacheKey(m.id, m.e2eeEnvelope!!))) return
        Session.scope.launch {
            val r = runCatching { decrypt(m) }
            inflight.remove(cacheKey(m.id, m.e2eeEnvelope))
            // offline: stays pending (no retry loop); the next page, event or unlock opens it
            if (r.isSuccess && r.getOrNull() != Seal.PENDING) Session.store.update { Reducer.reopen(it, setOf(m.channelId)) }
        }
    }

    /** The message keys a report reveals: the message itself and the given older ones that open here. */
    suspend fun revealKeys(list: List<Message>): List<Pair<String, String>> = list.mapNotNull { m ->
        val env = m.e2eeEnvelope ?: return@mapNotNull null
        runCatching {
            val key = channelKeys(channel(m.channelId)).keys[env.e] ?: return@mapNotNull null
            m.id to C.b64(C.open(key, m.channelId, m.author.id, env).second)
        }.getOrNull()
    }

    /** Notification text of an encrypted message: decrypted, or the plain "Encrypted message" line. */
    suspend fun notificationText(m: org.json.JSONObject): String {
        val p = runCatching { decrypt(json.decodeFromString(Message.serializer(), m.toString())) }.getOrNull() as? Payload
            ?: return app.getString(R.string.e2ee_encrypted_message)
        val copy = org.json.JSONObject(m.toString()).put("content", p.content).put("attachments", org.json.JSONArray().apply { repeat(p.files.size) { put(org.json.JSONObject()) } })
        return io.github.mrciller.cillhub.Conversations.text(copy)
    }

    // --- files ------------------------------------------------------------------------------------------------------------------
    /** A file for an encrypted message: its payload entry and the file.bin ciphertext to upload. */
    fun encryptUpload(u: Upload, index: Int): Pair<FileRef, Upload> {
        val data = u.open().use { it.readBytes() }
        val f = C.encryptFile(data)
        return FileRef(index.toString(), f.k, f.n, u.name, u.mime, data.size.toLong()) to Upload("file.bin", f.data.size.toLong(), "application/octet-stream") { f.data.inputStream() }
    }

    /** Downloads and decrypts a file into app-private cache (gone at logout); the path to show, play or share. */
    suspend fun decryptFile(a: Attachment): File = withContext(Dispatchers.IO) {
        val dir = File(app.cacheDir, "e2ee").apply { mkdirs() }
        val out = File(dir, a.id + "-" + a.filename.replace(Regex("[^A-Za-z0-9._ -]"), "_").take(100))
        if (out.exists()) return@withContext out
        val data = Api.http.newCall(Request.Builder().url(Config.cdn(a.url)).build()).execute().use { res ->
            if (!res.isSuccessful) throw err(R.string.e2ee_file_failed)
            res.body.bytes()
        }
        val plain = try { C.decryptFile(data, a.key!!, a.iv!!) } catch (e: Exception) { throw err(R.string.e2ee_file_failed) }
        File(dir, out.name + ".part").apply { writeBytes(plain); renameTo(out) }
        out
    }
}
