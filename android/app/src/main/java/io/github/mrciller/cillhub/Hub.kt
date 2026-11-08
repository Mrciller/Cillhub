package io.github.mrciller.cillhub

import android.content.Context
import android.util.Log
import io.github.mrciller.cillhub.data.Session
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * What the native side knows about the account (from the gateway's READY and later events) and the
 * decisions made with it: which messages notify, which calls ring. Gateway and FCM both feed in here.
 * Everything runs on one worker thread, so REST lookups never block the gateway socket.
 */
object Hub {
    private const val TAG = "CillcordHub"
    private val worker = Executors.newSingleThreadExecutor { Thread(it, "cillcord-hub") }
    private lateinit var app: Context

    @Volatile var meId: String? = null
    @Volatile var meName: String? = null

    private val channels = HashMap<String, JSONObject>()
    private val guildNames = HashMap<String, String>()
    private val guildSettings = HashMap<String, JSONObject>()
    private val blocked = HashSet<String>()
    private val myRoles = HashMap<String, Set<String>>()

    fun init(ctx: Context) { app = ctx.applicationContext }

    fun post(block: () -> Unit) = worker.execute {
        try { block() } catch (e: Exception) { Log.w(TAG, "event failed: ${e.javaClass.simpleName} ${e.message}") }
    }

    fun onDispatch(type: String, d: JSONObject?) = post { handle(type, d ?: JSONObject()) }

    private fun putChannel(c: JSONObject, guildId: String? = null) {
        val id = c.optString("id").ifEmpty { return }
        if (guildId != null && !c.has("guild_id")) c.put("guild_id", guildId)
        channels[id] = c
    }

    private fun handle(t: String, d: JSONObject) {
        when (t) {
            "READY" -> {
                channels.clear(); guildNames.clear(); guildSettings.clear(); blocked.clear(); myRoles.clear()
                d.optJSONObject("user")?.let { meId = it.optString("id"); meName = Conversations.displayName(it) }
                d.optJSONArray("private_channels").forEach { putChannel(it) }
                d.optJSONArray("guilds").forEach { g -> addGuild(g) }
                d.optJSONObject("user_guild_settings")?.optJSONArray("entries").forEach { putSettings(it) }
                d.optJSONArray("relationships").forEach { if (it.optInt("type") == 2) blocked.add(it.optString("id")) }
            }
            "GUILD_CREATE", "GUILD_UPDATE" -> addGuild(d)
            "GUILD_DELETE" -> guildNames.remove(d.optString("id"))
            "CHANNEL_CREATE", "CHANNEL_UPDATE", "THREAD_CREATE", "THREAD_UPDATE" -> putChannel(d)
            "CHANNEL_DELETE", "THREAD_DELETE" -> { channels.remove(d.optString("id")); Notifications.read(app, d.optString("id"), null) }
            "CHANNEL_RECIPIENT_ADD", "CHANNEL_RECIPIENT_REMOVE" -> channels.remove(d.optString("channel_id")) // refetched when needed
            "USER_GUILD_SETTINGS_UPDATE" -> putSettings(d)
            "RELATIONSHIP_ADD", "RELATIONSHIP_UPDATE" -> if (d.optInt("type") == 2) blocked.add(d.optString("id")) else blocked.remove(d.optString("id"))
            "RELATIONSHIP_REMOVE" -> blocked.remove(d.optString("id"))
            "GUILD_MEMBER_UPDATE" -> if (d.optJSONObject("user")?.optString("id") == meId) myRoles[d.optString("guild_id")] = d.optJSONArray("roles").strings().toSet()
            "MESSAGE_CREATE" -> onMessage(d)
            "MESSAGE_ACK" -> Notifications.read(app, d.optString("channel_id"), d.optString("message_id").ifEmpty { null })
            "CALL_CREATE", "CALL_UPDATE" -> onCall(d)
            "CALL_DELETE" -> Calls.remoteEnded(app, d.optString("channel_id"))
        }
    }

    private fun addGuild(g: JSONObject) {
        val id = g.optString("id")
        if (g.has("name")) guildNames[id] = g.optString("name")
        g.optJSONArray("channels").forEach { putChannel(it, id) }
        g.optJSONArray("threads").forEach { putChannel(it, id) }
        val me = meId
        if (me != null) {
            g.optJSONArray("members").forEach { m ->
                if (m.optJSONObject("user")?.optString("id") == me) {
                    myRoles[id] = m.optJSONArray("roles").strings().toSet()
                }
            }
        }
    }

    private fun putSettings(s: JSONObject) {
        guildSettings[if (s.isNull("guild_id")) "@me" else s.optString("guild_id")] = s
    }

    private fun channel(id: String): JSONObject? = channels[id] ?: try {
        Api.of(app)?.channel(id)?.also { putChannel(it) }
    } catch (e: Exception) {
        null
    }

    private fun rolesIn(guildId: String): Set<String> = myRoles.getOrPut(guildId) {
        try { Api.of(app)?.member(guildId, meId ?: return emptySet())?.optJSONArray("roles").strings().toSet() } catch (e: Exception) { null } ?: emptySet()
    }

    /** MESSAGE_CREATE from the gateway: notify for DMs and mentions the user's settings allow. */
    fun onMessage(m: JSONObject) {
        val me = meId ?: return
        val channelId = m.optString("channel_id")
        val author = m.optJSONObject("author") ?: return
        if (author.optString("id") == me) return Notifications.read(app, channelId, m.optString("id")) // answered elsewhere
        if (m.optInt("type") !in setOf(0, 19, 20, 23)) return // normal, reply, slash command, context menu command
        if (!m.has("webhook_id") && author.optString("id") in blocked) return
        val ch = channel(channelId) ?: return
        val guildId = if (ch.isNull("guild_id")) null else ch.optString("guild_id").ifEmpty { null }
        val kind = NotifyRules.kind(m, me, guildId == null) { guildId?.let { rolesIn(it) } ?: emptySet() } ?: return
        val parent = if (ch.isNull("parent_id")) null else ch.optString("parent_id").ifEmpty { null }
        if (!NotifyRules.allowed(guildSettings[guildId ?: "@me"], channelId, parent, kind)) return
        if (onScreen(channelId)) return
        show(m, ch, guildId)
    }

    /** From an FCM push: the server already applied the rules; fetch the message and show it. */
    fun onPushedMessage(channelId: String, messageId: String) = post {
        val api = Api.of(app) ?: return@post
        if (meId == null) api.me().let { meId = it.optString("id"); meName = Conversations.displayName(it) }
        val ch = channel(channelId) ?: return@post
        val guildId = if (ch.isNull("guild_id")) null else ch.optString("guild_id").ifEmpty { null }
        if (guildId != null && guildId !in guildNames) try { guildNames[guildId] = api.guild(guildId).optString("name") } catch (e: Exception) { }
        if (onScreen(channelId)) return@post
        show(api.message(channelId, messageId), ch, guildId)
    }

    /** The conversation is open on screen: the app shows the message itself. */
    private fun onScreen(channelId: String) = Session.visible && Session.openChannel == channelId

    private fun show(m: JSONObject, ch: JSONObject, guildId: String?) {
        val author = m.optJSONObject("author") ?: return
        val msg = Msg(
            id = m.optString("id"), authorId = author.optString("id"), authorName = Conversations.author(m),
            avatar = if (author.isNull("avatar")) null else author.optString("avatar"),
            text = Conversations.text(m), time = timeOf(m),
        )
        Notifications.addMessage(app, ch.optString("id"), guildId, Conversations.title(ch, meId, guildId?.let { guildNames[it] }), ch.optInt("type") != 1, msg)
    }

    private fun timeOf(m: JSONObject): Long = try {
        java.time.Instant.parse(m.optString("timestamp")).toEpochMilli()
    } catch (e: Exception) {
        System.currentTimeMillis()
    }

    /** CALL_CREATE / CALL_UPDATE: ring while we are in its ringing list, stop when we leave it. */
    fun onCall(c: JSONObject) {
        val me = meId ?: return
        val channelId = c.optString("channel_id")
        val ringing = c.optJSONArray("ringing").strings()
        if (me !in ringing) return Calls.stopRinging(app, channelId)
        val ch = channel(channelId) ?: return
        ring(ch, c)
    }

    /** From an FCM push for an incoming call. */
    fun onPushedCall(channelId: String) = post {
        val api = Api.of(app) ?: return@post
        if (meId == null) api.me().let { meId = it.optString("id"); meName = Conversations.displayName(it) }
        ring(channel(channelId) ?: return@post, null)
    }

    private fun ring(ch: JSONObject, call: JSONObject?) {
        // the caller is whoever is already in the call; a push carries no voice states, so the DM's other person
        val inCall = call?.optJSONArray("voice_states")?.let { vs -> (0 until vs.length()).mapNotNull { vs.optJSONObject(it)?.optString("user_id") } }.orEmpty()
        val recips = ch.optJSONArray("recipients")
        val people = (0 until (recips?.length() ?: 0)).mapNotNull { recips?.optJSONObject(it) }.filter { it.optString("id") != meId }
        val caller = people.firstOrNull { it.optString("id") in inCall } ?: people.firstOrNull()
        val title = Conversations.title(ch, meId, null)
        Calls.ring(app, ch.optString("id"), caller?.let { Conversations.displayName(it) } ?: title, caller?.optString("id"), ch.optInt("type") == 3, title)
    }
}

fun JSONArray?.forEach(f: (JSONObject) -> Unit) {
    if (this == null) return
    for (i in 0 until length()) optJSONObject(i)?.let(f)
}

fun JSONArray?.strings(): List<String> = if (this == null) emptyList() else (0 until length()).map { optString(it) }
