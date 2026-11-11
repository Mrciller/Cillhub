package io.github.mrciller.cillhub.data

import android.content.Context
import android.util.Log
import io.github.mrciller.cillhub.Calls
import io.github.mrciller.cillhub.Config
import io.github.mrciller.cillhub.Delivery
import io.github.mrciller.cillhub.GatewayConnection
import io.github.mrciller.cillhub.GatewayService
import io.github.mrciller.cillhub.Hub
import io.github.mrciller.cillhub.Notifications
import io.github.mrciller.cillhub.Origins
import io.github.mrciller.cillhub.Prefs
import io.github.mrciller.cillhub.TokenStore
import io.github.mrciller.cillhub.voice.Voice
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject
import java.net.URLEncoder
import java.util.concurrent.ConcurrentHashMap

/**
 * The app's one connection to its server: the gateway (shared by the UI and the background service), the store
 * it feeds, and the REST actions the screens use (client/src/actions.ts). Lives as long as the process.
 */
object Session {
    private const val TAG = "CillhubSession"
    const val PAGE = 50

    lateinit var app: Context; private set
    val store = Store()
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val rest = Rest({ Config.API }, { TokenStore.get(app) })

    private val _loggedIn = MutableStateFlow(false)
    val loggedIn: StateFlow<Boolean> = _loggedIn
    private val _instance = MutableStateFlow<InstanceInfo?>(null)
    val instance: StateFlow<InstanceInfo?> = _instance

    /** An activity of the app is visible. */
    @Volatile var visible = false; private set
    /** The conversation on screen; its messages do not notify. */
    @Volatile var openChannel: String? = null
    @Volatile var connected = false; private set
    var onConnectionChange: (() -> Unit)? = null

    private lateinit var conn: GatewayConnection

    fun init(ctx: Context) {
        app = ctx.applicationContext
        Config.APP_URL = Prefs(app).serverUrl ?: Config.DEFAULT_URL
        _loggedIn.value = TokenStore.get(app) != null
        conn = GatewayConnection(
            token = { TokenStore.get(app) },
            onDispatch = ::dispatch,
            onState = { up ->
                connected = up
                if (!up) store.update { if (it.conn == Conn.READY) it.copy(conn = Conn.CONNECTING) else it }
                onConnectionChange?.invoke()
            },
            onAuthFailed = { Log.i(TAG, "token rejected"); scope.launch { forget() } },
            afk = { !visible },
        )
    }

    private fun dispatch(t: String, d: org.json.JSONObject?) {
        Hub.onDispatch(t, d)
        val obj = try { json.parseToJsonElement(d?.toString() ?: "{}").jsonObject } catch (e: Exception) { return }
        store.dispatch(t, obj)
        Voice.onDispatch(t, d ?: org.json.JSONObject()) // after the store, like the web client's voiceEvent
    }

    /** Sends a gateway op (voice state, cillvoice signalling); dropped while no session is up (READY re-sends the voice state). */
    fun op(op: Int, d: org.json.JSONObject) = conn.op(op, d)

    // ---------- connection lifetime ----------

    /** Opens the gateway (UI started, or the background service runs). */
    fun connect() {
        if (TokenStore.get(app) == null) return
        if (store.value.conn == Conn.OFFLINE) store.update { it.copy(conn = Conn.CONNECTING) }
        conn.start()
    }

    /** Closes it unless the UI or the background service still needs it. */
    fun release() {
        if (!visible && !GatewayService.running) { conn.stop(); connected = false; store.update { it.copy(conn = Conn.OFFLINE) } }
    }

    /** The network came back. */
    fun kick() = conn.kick()

    fun setVisible(v: Boolean) {
        visible = v
        if (v) { connect(); conn.send { presence(false) } } else { conn.send { presence(true) }; release() }
    }

    // ---------- server and auth ----------

    /** "Use another server": an https URL (http only in debug builds) whose /.well-known/cillhub or /api/v9/gateway answers. */
    suspend fun checkServer(input: String, allowHttp: Boolean): Pair<String, InstanceInfo> {
        val raw = input.trim().trimEnd('/').let { if ("://" in it) it else "https://$it" }
        val origin = Origins.of(raw) ?: throw ApiError(0, 0, "invalid")
        if (!origin.startsWith("https://") && !allowHttp) throw ApiError(0, 0, "https")
        val probe = Rest({ origin }, { null })
        val ok = runCatching { probe.request("GET", "/.well-known/cillhub").let { json.parseToJsonElement(it).jsonObject.containsKey("api") } }.getOrDefault(false) ||
            runCatching { probe.request("GET", "/api/v9/gateway").let { json.parseToJsonElement(it).jsonObject.containsKey("url") } }.getOrDefault(false)
        if (!ok) throw ApiError(0, 0, "not-cillhub")
        val info = runCatching { probe.get<InstanceInfo>("/api/v9/instance") }.getOrDefault(InstanceInfo())
        return origin to info
    }

    /** The server to sign in to (before login). */
    fun useServer(url: String, info: InstanceInfo?) {
        Config.APP_URL = url
        Prefs(app).serverUrl = if (Origins.of(url) == Config.DEFAULT_ORIGIN) null else url
        _instance.value = info
    }

    suspend fun loadInstance() { _instance.value = runCatching { rest.get<InstanceInfo>("/instance") }.getOrNull() ?: _instance.value }

    suspend fun login(login: String, password: String): LoginAnswer =
        rest.call("POST", "/auth/login", buildJsonObject { put("login", login); put("password", password) })

    suspend fun mfa(ticket: String, code: String, backup: Boolean): LoginAnswer =
        rest.call("POST", if (backup) "/auth/mfa/backup" else "/auth/mfa/totp", buildJsonObject { put("ticket", ticket); put("code", code) })

    /** [checked]: the sign-up boxes were ticked (7.10.3 servers; older ones ignore the two fields). */
    suspend fun register(email: String, username: String, password: String, code: String?, captcha: String? = null, checked: Boolean = false): LoginAnswer =
        rest.call("POST", "/auth/register", buildJsonObject {
            put("email", email); put("username", username); put("password", password)
            if (checked) { put("age_confirmed", true); put("terms_accepted", true) }
            if (!code.isNullOrBlank()) put("registration_code", code.trim())
            if (captcha != null) put("captcha_key", captcha)
        })

    /** Asks for a password reset mail; the server answers the same whether the address has an account. */
    suspend fun forgot(email: String, captcha: String? = null) {
        rest.request("POST", "/auth/forgot", buildJsonObject { put("login", email); if (captcha != null) put("captcha_key", captcha) })
    }

    /** A required password change (login answered required_actions: update_password), with the fresh token. */
    suspend fun forcedPassword(token: String, old: String, new: String): String {
        val r = Rest({ Config.API }, { token }).call<JsonObject>("PATCH", "/users/@me", buildJsonObject { put("password", old); put("new_password", new) })
        return (r["token"] as? kotlinx.serialization.json.JsonPrimitive)?.content ?: token
    }

    fun signedIn(token: String) {
        TokenStore.set(app, token)
        _loggedIn.value = true
        connect()
        Delivery.apply(app)
    }

    /** Log out here and on the server. */
    fun logout() {
        val token = TokenStore.get(app) ?: return
        val fcm = Prefs(app).fcmRegistered
        scope.launch {
            runCatching { Rest({ Config.API }, { token }).request("POST", "/auth/logout") }
            if (fcm != null) Delivery.unregister(app, fcm, token)
        }
        forget()
    }

    /** Local part of logging out (also when the server rejected the token). */
    fun forget() {
        TokenStore.clear(app)
        conn.stop()
        connected = false
        Voice.leave()
        Calls.current?.let { Calls.end(app, android.telecom.DisconnectCause.LOCAL) }
        Notifications.clearAll(app)
        // the in-app web client got the token in its localStorage (WebCallActivity): it must not outlive the login
        android.os.Handler(android.os.Looper.getMainLooper()).post {
            runCatching { android.webkit.WebStorage.getInstance().deleteAllData(); android.webkit.CookieManager.getInstance().removeAllCookies(null) }
        }
        store.reset()
        _loggedIn.value = false
        Delivery.apply(app)
    }

    // ---------- messages ----------

    suspend fun loadMessages(channelId: String, before: String? = null) {
        val page = rest.get<List<Message>>("/channels/$channelId/messages?limit=$PAGE" + (before?.let { "&before=$it" } ?: ""))
        store.update { Reducer.page(it, channelId, page, before, PAGE) }
    }

    private fun nonce() = (System.currentTimeMillis() * 1000 + (0..999).random()).toString()

    /** Optimistic send (store.ts / actions.ts sendMessage): a pending copy, replaced by the server's echo with the same nonce. */
    suspend fun send(ch: Channel, content: String, replyTo: Message? = null, files: List<Upload> = emptyList(), progress: (Float) -> Unit = {}) {
        val me = store.value.me ?: return
        val n = nonce()
        val temp = Message(
            id = "pending-$n", nonce = n, type = if (replyTo != null) 19 else 0, channelId = ch.id, guildId = ch.guildId, author = me, content = content,
            timestamp = java.time.Instant.now().toString(), pending = true,
            messageReference = replyTo?.let { MessageReference(it.id, ch.id) }, referencedMessage = replyTo,
        )
        store.update { Reducer.addMessage(it, temp) }
        val payload = buildJsonObject {
            put("content", content); put("nonce", n)
            replyTo?.let { putJsonObject("message_reference") { put("message_id", it.id) } }
            if (files.isNotEmpty()) putJsonArray("attachments") { files.forEachIndexed { i, f -> add(buildJsonObject { put("id", i.toString()); put("filename", f.name) }) } }
        }
        try {
            val text = if (files.isEmpty()) rest.request("POST", "/channels/${ch.id}/messages", payload, retry = false)
            else rest.multipart("/channels/${ch.id}/messages", payload, files, progress)
            val real = json.decodeFromString<Message>(text)
            store.update { s -> Reducer.addMessage(Reducer.patchList(s, ch.id) { l -> l.filter { it.id != temp.id } }, real) }
        } catch (e: ApiError) {
            // keep the text on screen so nothing typed is lost
            store.update { Reducer.patchMessage(it, ch.id, temp.id) { m -> m.copy(pending = false, failed = true) } }
            throw e
        }
    }

    fun discard(m: Message) = store.update { s -> Reducer.patchList(s, m.channelId) { l -> l.filter { it.id != m.id } } }

    suspend fun edit(m: Message, content: String) {
        val r = rest.request("PATCH", "/channels/${m.channelId}/messages/${m.id}", buildJsonObject { put("content", content) })
        store.dispatch("MESSAGE_UPDATE", json.parseToJsonElement(r).jsonObject)
    }

    suspend fun delete(m: Message) {
        if (!m.failed) rest.request("DELETE", "/channels/${m.channelId}/messages/${m.id}")
        store.update { s -> Reducer.deleteMessages(s, m.channelId, setOf(m.id)) }
    }

    private fun emojiRoute(e: EmojiRef) = URLEncoder.encode(if (e.id != null) "${e.name}:${e.id}" else e.name, "UTF-8").replace("+", "%20")

    /** Optimistic toggle; the gateway echo is ignored for our own change. */
    suspend fun toggleReaction(m: Message, emoji: EmojiRef) {
        val me = store.value.me ?: return
        val mine = m.reactions.firstOrNull { it.emoji.key == emoji.key }?.me == true
        store.update { Reducer.react(it, m.channelId, m.id, me.id, emoji, !mine) }
        try {
            rest.request(if (mine) "DELETE" else "PUT", "/channels/${m.channelId}/messages/${m.id}/reactions/${emojiRoute(emoji)}/@me")
        } catch (e: ApiError) {
            store.update { Reducer.react(it, m.channelId, m.id, me.id, emoji, mine) }
            throw e
        }
    }

    private val acked = ConcurrentHashMap<String, String>()
    /** Marks a channel read up to this message (deduplicated per channel). */
    fun ack(channelId: String, messageId: String) {
        if (acked[channelId] == messageId || messageId.startsWith("pending-")) return
        acked[channelId] = messageId
        store.update { Reducer.ack(it, channelId, messageId) }
        scope.launch {
            runCatching { rest.request("POST", "/channels/$channelId/messages/$messageId/ack", buildJsonObject { put("token", JsonNull) }) }
                .onFailure { acked.remove(channelId) }
        }
    }

    suspend fun ackBulk(channels: List<Channel>) {
        val list = channels.filter { it.lastMessageId != null }
        if (list.isEmpty()) return
        rest.request("POST", "/read-states/ack-bulk", buildJsonObject {
            putJsonArray("read_states") { list.forEach { c -> add(buildJsonObject { put("channel_id", c.id); put("message_id", c.lastMessageId) }) } }
        })
        store.update { s -> list.fold(s) { acc, c -> Reducer.ack(acc, c.id, c.lastMessageId) } }
    }

    private val typingSent = ConcurrentHashMap<String, Long>()
    /** At most every 8 s per channel (the server shows typing for 10 s). */
    fun typing(channelId: String) {
        val now = System.currentTimeMillis()
        if (now - (typingSent[channelId] ?: 0) < 8000) return
        typingSent[channelId] = now
        scope.launch { runCatching { rest.request("POST", "/channels/$channelId/typing") } }
    }

    fun sentMessage(channelId: String) { typingSent.remove(channelId) }

    // ---------- people ----------

    suspend fun loadMembers(guildId: String) {
        val list = rest.get<List<Member>>("/guilds/$guildId/members?limit=1000")
        store.update { s ->
            s.copy(
                members = s.members + (guildId to list.mapNotNull { m -> m.user?.let { it.id to m } }.toMap()),
                membersLoaded = s.membersLoaded + guildId,
                users = s.users + list.mapNotNull { it.user }.associateBy { it.id },
            )
        }
        // REST pages stop at 1000; the gateway sends the whole list in GUILD_MEMBERS_CHUNKs (the store merges them)
        if (list.size >= 1000) op(8, org.json.JSONObject().put("guild_id", guildId).put("query", "").put("limit", 0).put("presences", true))
    }

    suspend fun profile(userId: String, guildId: String?): Profile =
        rest.get("/users/$userId/profile?with_mutual_guilds=true" + (guildId?.let { "&guild_id=$it" } ?: ""))

    suspend fun openDm(userId: String): Channel {
        val c = rest.call<Channel>("POST", "/users/@me/channels", buildJsonObject { put("recipient_id", userId) })
        store.update { s -> s.copy(channels = s.channels + (c.id to (s.channels[c.id] ?: c))) }
        return c
    }

    suspend fun createGroupDm(userIds: List<String>): Channel {
        val c = rest.call<Channel>("POST", "/users/@me/channels", buildJsonObject { put("recipients", buildJsonArray { userIds.forEach { add(it) } }) })
        store.update { s -> s.copy(channels = s.channels + (c.id to c)) }
        return c
    }

    suspend fun addFriend(username: String) { rest.request("POST", "/users/@me/relationships", buildJsonObject { put("username", username.trim()) }) }
    suspend fun acceptFriend(id: String) { rest.request("PUT", "/users/@me/relationships/$id", buildJsonObject { }) }
    suspend fun blockUser(id: String) { rest.request("PUT", "/users/@me/relationships/$id", buildJsonObject { put("type", 2) }) }
    suspend fun removeRelationship(id: String) { rest.request("DELETE", "/users/@me/relationships/$id") }

    suspend fun mentions(before: String? = null): List<Message> =
        rest.get("/users/@me/mentions?limit=25" + (before?.let { "&before=$it" } ?: ""))

    // ---------- me ----------

    /** Persisted status (op 3 stores it) plus the synced setting, like the web client's setStatus. */
    fun setStatus(status: String) {
        store.dispatch("USER_SETTINGS_UPDATE", buildJsonObject { put("status", status) })
        conn.send { status(status, !visible) }
        scope.launch { runCatching { rest.request("PATCH", "/users/@me/settings", buildJsonObject { put("status", status) }) } }
    }

    suspend fun patchMe(body: JsonObject) {
        val r = rest.call<JsonObject>("PATCH", "/users/@me", body)
        (r["token"] as? kotlinx.serialization.json.JsonPrimitive)?.content?.let { TokenStore.set(app, it) } // a password change revokes the old token
        store.dispatch("USER_UPDATE", JsonObject(r - "token"))
    }

    suspend fun loadMe() {
        val r = rest.get<JsonObject>("/users/@me")
        store.dispatch("USER_UPDATE", r)
    }

    // ---------- Bulk Delete ----------
    suspend fun bulkDelete(channelId: String, ids: List<String>) {
        if (ids.isEmpty()) return
        if (ids.size == 1) {
            rest.request("DELETE", "/channels/$channelId/messages/${ids[0]}")
        } else {
            val payload = buildJsonObject {
                putJsonArray("messages") { ids.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }
            }
            rest.request("POST", "/channels/$channelId/messages/bulk-delete", payload)
        }
        store.update { Reducer.deleteMessages(it, channelId, ids.toSet()) }
    }

    // ---------- Edit History ----------
    suspend fun fetchMessageEdits(channelId: String, messageId: String): List<MessageEdit> =
        rest.get<MessageEditsResponse>("/channels/$channelId/messages/$messageId/edits").edits

    // ---------- Forums & Threads ----------
    suspend fun startForumPost(channelId: String, name: String, content: String, tags: List<String> = emptyList(), autoArchiveDuration: Int = 4320): Channel {
        val payload = buildJsonObject {
            put("name", name)
            put("auto_archive_duration", autoArchiveDuration)
            putJsonObject("message") { put("content", content) }
            if (tags.isNotEmpty()) putJsonArray("applied_tags") { tags.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }
        }
        val ch = rest.call<Channel>("POST", "/channels/$channelId/threads", payload)
        store.update { it.copy(channels = it.channels + (ch.id to ch)) }
        return ch
    }

    suspend fun loadArchivedThreads(channelId: String, type: String = "public"): List<Channel> {
        val res = rest.get<ThreadListResponse>("/channels/$channelId/threads/archived/$type")
        store.update { s -> s.copy(channels = s.channels + res.threads.associateBy { it.id }) }
        return res.threads
    }

    suspend fun setSolvedMessage(threadId: String, messageId: String?) {
        val payload = buildJsonObject {
            if (messageId != null) put("solved_message_id", messageId)
            else put("solved_message_id", JsonNull)
        }
        val ch = rest.call<Channel>("PATCH", "/channels/$threadId", payload)
        store.update { it.copy(channels = it.channels + (ch.id to ch)) }
    }

    suspend fun setThreadPinned(threadId: String, pinned: Boolean) {
        val current = store.value.channels[threadId]?.flags ?: 0
        val newFlags = if (pinned) current or 2 else current and 2.inv()
        val payload = buildJsonObject { put("flags", newFlags) }
        val ch = rest.call<Channel>("PATCH", "/channels/$threadId", payload)
        store.update { it.copy(channels = it.channels + (ch.id to ch)) }
    }

    suspend fun updateThreadNotification(threadId: String, flags: Int) {
        val payload = buildJsonObject { put("flags", flags) }
        val tm = rest.call<ThreadMember>("PATCH", "/channels/$threadId/thread-members/@me", payload)
        store.update { s ->
            s.channels[threadId]?.let { ch -> s.copy(channels = s.channels + (threadId to ch.copy(member = tm))) } ?: s
        }
    }

    // ---------- Polls ----------
    suspend fun createPoll(
        channelId: String,
        question: String,
        answers: List<String>,
        allowMultiselect: Boolean = false,
        durationHours: Int = 24,
        anonymous: Boolean = false,
        allowedRoles: List<String> = emptyList(),
        correctAnswerIndex: Int? = null,
    ) {
        val payload = buildJsonObject {
            putJsonObject("poll") {
                putJsonObject("question") { put("text", question) }
                putJsonArray("answers") {
                    answers.forEach { ans ->
                        add(buildJsonObject { putJsonObject("poll_media") { put("text", ans) } })
                    }
                }
                put("allow_multiselect", allowMultiselect)
                put("duration", durationHours)
                if (anonymous) put("anonymous", true)
                if (allowedRoles.isNotEmpty()) putJsonArray("allowed_role_ids") { allowedRoles.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }
                if (correctAnswerIndex != null) put("correct_answer_id", correctAnswerIndex + 1)
            }
        }
        val text = rest.request("POST", "/channels/$channelId/messages", payload)
        val msg = json.decodeFromString<Message>(text)
        store.update { Reducer.addMessage(it, msg) }
    }

    suspend fun votePoll(m: Message, answerIds: List<Int>) {
        val before = m.poll ?: return
        // optimistic vote update
        val updatedCounts = (before.results?.answerCounts.orEmpty()).map {
            it.copy(
                count = if (it.id in answerIds && !it.meVoted) it.count + 1 else if (it.id !in answerIds && it.meVoted) maxOf(0, it.count - 1) else it.count,
                meVoted = it.id in answerIds
            )
        }
        val nextPoll = before.copy(results = (before.results ?: PollResults()).copy(answerCounts = updatedCounts))
        store.update { Reducer.patchMessage(it, m.channelId, m.id) { cur -> cur.copy(poll = nextPoll) } }
        try {
            val payload = buildJsonObject {
                putJsonArray("answer_ids") { answerIds.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) } }
            }
            rest.request("PUT", "/channels/${m.channelId}/polls/${m.id}/answers/@me", payload)
        } catch (e: Exception) {
            store.update { Reducer.patchMessage(it, m.channelId, m.id) { cur -> cur.copy(poll = before) } }
            throw e
        }
    }

    suspend fun expirePoll(m: Message) {
        val text = rest.request("POST", "/channels/${m.channelId}/polls/${m.id}/expire")
        val updated = json.decodeFromString<Message>(text)
        store.update { Reducer.patchMessage(it, m.channelId, m.id) { updated } }
    }

    // ---------- Media Gallery ----------
    suspend fun loadChannelMedia(channelId: String, tab: String = "media", before: String? = null, limit: Int = 50): List<Message> {
        val q = buildString {
            append("?tab=").append(tab)
            append("&limit=").append(limit)
            if (before != null) append("&before=").append(before)
        }
        return rest.get<MediaGalleryResponse>("/channels/$channelId/media$q").messages
    }

    // ---------- Snippets ----------
    suspend fun loadSnippets(guildId: String): List<Snippet> {
        val res = rest.get<SnippetsResponse>("/guilds/$guildId/snippets")
        store.update { it.copy(snippets = it.snippets + (guildId to res.snippets)) }
        return res.snippets
    }

    // ---------- Clone Channel ----------
    suspend fun cloneChannel(channelId: String, name: String? = null): Channel {
        val payload = buildJsonObject { if (!name.isNullOrBlank()) put("name", name.trim()) }
        val ch = rest.call<Channel>("POST", "/channels/$channelId/clone", payload)
        store.update { it.copy(channels = it.channels + (ch.id to ch)) }
        return ch
    }

    // ---------- Download My Data Export ----------
    suspend fun exportMyData(): String = rest.request("GET", "/users/@me/export")

    // ---------- Privacy Settings ----------
    suspend fun setDmReadReceipts(enabled: Boolean) {
        val payload = buildJsonObject {
            putJsonObject("privacy") { put("dm_read_receipts", enabled) }
        }
        rest.request("PATCH", "/users/@me/settings", payload)
    }

    // ---------- GIFs ----------
    suspend fun gifs(query: String): List<Gif> =
        rest.get(if (query.isBlank()) "/gifs/trending?limit=30" else "/gifs/search?limit=30&q=" + URLEncoder.encode(query.trim(), "UTF-8"))

    /** Adds (newest first) or removes one favourite; optimistic, the settings echo confirms it, a failure puts the old list back. */
    suspend fun toggleFavoriteGif(g: FavoriteGif) {
        val before = store.value.favoriteGifs
        val remove = before.any { it.url == g.url }
        store.update { it.copy(favoriteGifs = if (remove) before.filter { f -> f.url != g.url } else (listOf(g) + before).take(250)) }
        try {
            if (remove) rest.request("DELETE", "/users/@me/settings/favorite-gifs?url=" + URLEncoder.encode(g.url, "UTF-8"))
            // every field explicitly: the shared json config leaves defaults out
            else rest.request("PUT", "/users/@me/settings/favorite-gifs", buildJsonObject { put("url", g.url); put("src", g.src); put("width", g.width); put("height", g.height); put("format", g.format) })
        } catch (e: ApiError) {
            store.update { it.copy(favoriteGifs = before) }
            throw e
        }
    }

    // ---------- server administration (the gateway echoes every change into the store) ----------
    suspend fun setMemberRole(guildId: String, userId: String, roleId: String, add: Boolean) {
        rest.request(if (add) "PUT" else "DELETE", "/guilds/$guildId/members/$userId/roles/$roleId")
    }

    // ---------- Draft Persistence ----------
    fun saveDraft(channelId: String, text: String) {
        val trimmed = text.trim()
        val next = if (trimmed.isEmpty()) store.value.drafts - channelId else store.value.drafts + (channelId to text)
        store.update { it.copy(drafts = next) }
        val sp = app.getSharedPreferences("drafts", Context.MODE_PRIVATE)
        if (trimmed.isEmpty()) sp.edit().remove(channelId).apply()
        else sp.edit().putString(channelId, text).apply()
    }

    fun getDraft(channelId: String): String {
        return store.value.drafts[channelId] ?: app.getSharedPreferences("drafts", Context.MODE_PRIVATE).getString(channelId, "") ?: ""
    }

    fun clearDraft(channelId: String) = saveDraft(channelId, "")
}
