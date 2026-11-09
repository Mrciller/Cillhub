package io.github.mrciller.cillhub

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ShortcutInfo
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.PorterDuff
import android.graphics.PorterDuffXfermode
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.util.Log
import android.util.LruCache
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import okhttp3.Request

/**
 * Message notifications: one MessagingStyle notification per channel with sender Persons, a conversation
 * shortcut, inline reply and mark-as-read. Built to Android Auto's messaging requirements (semantic
 * actions, showsUserInterface=false, RemoteInput), so the car reads them aloud and takes voice replies.
 */
object Notifications {
    const val CH_MESSAGES = "messages"
    const val CH_CALLS = "calls"
    const val CH_CONNECTION = "connection"
    const val CH_UPDATES = "updates"
    const val ID_MESSAGE = 1
    const val ID_CONNECTION = 2
    const val ID_CALL = 3
    const val ID_UPDATE = 4
    const val ID_NOTICE = 5
    const val REPLY_KEY = "reply_text"
    private const val TAG = "CillcordNotify"

    val conversations = Conversations()
    private val avatars = LruCache<String, IconCompat>(64)

    fun createChannels(ctx: Context) {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_MESSAGES, ctx.getString(R.string.channel_messages), NotificationManager.IMPORTANCE_HIGH))
        nm.createNotificationChannel(NotificationChannel(CH_CALLS, ctx.getString(R.string.channel_calls), NotificationManager.IMPORTANCE_HIGH).apply {
            setSound(
                RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE),
                AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE).setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build()
            )
            enableVibration(true)
        })
        nm.createNotificationChannel(NotificationChannel(CH_CONNECTION, ctx.getString(R.string.channel_connection), NotificationManager.IMPORTANCE_MIN).apply { setShowBadge(false) })
        nm.createNotificationChannel(NotificationChannel(CH_UPDATES, ctx.getString(R.string.channel_updates), NotificationManager.IMPORTANCE_DEFAULT))
    }

    fun tag(channelId: String) = "ch:$channelId"
    private fun code(channelId: String, salt: Int) = channelId.hashCode() * 31 + salt

    fun openIntent(ctx: Context, path: String): Intent =
        Intent(ctx, MainActivity::class.java).setAction(Intent.ACTION_VIEW).putExtra(MainActivity.EXTRA_PATH, path)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)

    /** A new message from someone else; fetches the sender's avatar, so call off the main thread. */
    fun addMessage(ctx: Context, channelId: String, guildId: String?, title: String, isGroup: Boolean, msg: Msg) {
        val conv = synchronized(conversations) { conversations.add(channelId, guildId, title, isGroup, msg) } ?: return
        post(ctx, conv, alert = true)
    }

    /** Read up to this message (on this or another device): the notification goes when nothing unread is left. */
    fun read(ctx: Context, channelId: String, upTo: String?) {
        val gone = synchronized(conversations) { conversations.read(channelId, upTo) }
        if (gone) NotificationManagerCompat.from(ctx).cancel(tag(channelId), ID_MESSAGE)
        else synchronized(conversations) { conversations.get(channelId) }?.let { post(ctx, it, alert = false) }
    }

    fun clearAll(ctx: Context) {
        synchronized(conversations) { conversations.clear() }
        NotificationManagerCompat.from(ctx).cancelAll()
    }

    /** Re-shows the conversation unchanged (e.g. a failed inline reply, so the spinner stops). */
    fun repost(ctx: Context, channelId: String) {
        synchronized(conversations) { conversations.get(channelId) }?.let { post(ctx, it, alert = false) }
    }

    private fun post(ctx: Context, conv: Conversation, alert: Boolean) {
        val n = build(ctx, conv, alert)
        try {
            NotificationManagerCompat.from(ctx).notify(tag(conv.channelId), ID_MESSAGE, n)
        } catch (e: SecurityException) {
            Log.w(TAG, "notifications not allowed")
        }
    }

    fun mePerson(): Person = Person.Builder().setKey(Hub.meId ?: "me").setName(Hub.meName ?: "You").build()

    fun person(ctx: Context, id: String, name: String, avatar: String?): Person =
        Person.Builder().setKey(id).setName(name).also { b -> avatar?.let { avatarIcon(id, it) }?.let { b.setIcon(it) } }.build()

    fun build(ctx: Context, conv: Conversation, alert: Boolean): android.app.Notification {
        val msgs = synchronized(conversations) { conv.messages.toList() }
        val style = NotificationCompat.MessagingStyle(mePerson())
            .setGroupConversation(conv.isGroup)
        if (conv.isGroup) style.setConversationTitle(conv.title)
        val persons = LinkedHashMap<String, Person>()
        for (m in msgs) {
            val p = persons.getOrPut(m.authorId) { person(ctx, m.authorId, m.authorName, m.avatar) }
            style.addMessage(NotificationCompat.MessagingStyle.Message(m.text, m.time, p))
        }
        val last = msgs.lastOrNull()
        val shortcutId = "ch-${conv.channelId}"
        val open = openIntent(ctx, conv.path)
        val shortcut = ShortcutInfoCompat.Builder(ctx, shortcutId)
            .setShortLabel(conv.title.take(25)).setLongLabel(conv.title)
            .setLongLived(true)
            .setIntent(open)
            .setLocusId(LocusIdCompat(shortcutId))
            .setCategories(setOf(ShortcutInfo.SHORTCUT_CATEGORY_CONVERSATION))
            .setPersons(persons.values.toTypedArray().ifEmpty { arrayOf(mePerson()) })
            .setIcon(persons.values.firstOrNull()?.icon ?: IconCompat.createWithResource(ctx, R.mipmap.ic_launcher))
            .build()
        try { ShortcutManagerCompat.pushDynamicShortcut(ctx, shortcut) } catch (e: Exception) { Log.w(TAG, "shortcut: ${e.message}") }

        val replyPi = PendingIntent.getBroadcast(
            ctx, code(conv.channelId, 1),
            // the channel is in the data URI: the intent is mutable (RemoteInput), and a fill-in can replace extras but not a set URI
            Intent(ctx, ActionReceiver::class.java).setAction(ActionReceiver.REPLY).setData(android.net.Uri.fromParts(ActionReceiver.REPLY_SCHEME, conv.channelId, null)),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE // RemoteInput fills in the text
        )
        val reply = NotificationCompat.Action.Builder(R.drawable.ic_reply, ctx.getString(R.string.reply), replyPi)
            .addRemoteInput(RemoteInput.Builder(REPLY_KEY).setLabel(ctx.getString(R.string.reply)).build())
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .setAllowGeneratedReplies(true)
            .build()
        val readPi = PendingIntent.getBroadcast(
            ctx, code(conv.channelId, 2),
            Intent(ctx, ActionReceiver::class.java).setAction(ActionReceiver.MARK_READ)
                .putExtra(ActionReceiver.EXTRA_CHANNEL, conv.channelId).putExtra(ActionReceiver.EXTRA_MESSAGE, last?.id),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val markRead = NotificationCompat.Action.Builder(R.drawable.ic_done, ctx.getString(R.string.mark_read), readPi)
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_MARK_AS_READ)
            .setShowsUserInterface(false)
            .build()
        val content = PendingIntent.getActivity(ctx, code(conv.channelId, 3), open, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

        return NotificationCompat.Builder(ctx, CH_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_cillcord)
            .setColor(0xFF00D2EB.toInt())
            .setStyle(style)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setShortcutInfo(shortcut)
            .setLocusId(LocusIdCompat(shortcutId))
            .setContentIntent(content)
            .addAction(reply)
            .addAction(markRead)
            .setAutoCancel(true)
            .setOnlyAlertOnce(!alert)
            .setSilent(!alert)
            .setNumber(msgs.size)
            .setWhen(last?.time ?: System.currentTimeMillis())
            .setShowWhen(true)
            .build()
    }

    /** Plain notification for pushes that are not messages (friend requests, reminders). */
    fun notice(ctx: Context, title: String, body: String, path: String) {
        val content = PendingIntent.getActivity(ctx, path.hashCode(), openIntent(ctx, path), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = NotificationCompat.Builder(ctx, CH_MESSAGES).setSmallIcon(R.drawable.ic_stat_cillcord).setColor(0xFF00D2EB.toInt())
            .setContentTitle(title).setContentText(body).setContentIntent(content).setAutoCancel(true).build()
        try { NotificationManagerCompat.from(ctx).notify("notice:$path", ID_NOTICE, n) } catch (e: SecurityException) { Log.w(TAG, "notifications not allowed") }
    }

    /** The sender's avatar from the CDN, cropped round; null (letter avatar) if it cannot be fetched. */
    private fun avatarIcon(id: String, hash: String): IconCompat? {
        val key = "$id/$hash"
        avatars.get(key)?.let { return it }
        if (!Regex("^[0-9a-f]{32}$").matches(hash)) return null
        return try {
            Api.http.newCall(Request.Builder().url("${Config.APP_URL}/avatars/$id/$hash.png?size=128").build()).execute().use { res ->
                if (!res.isSuccessful) return null
                val bmp = BitmapFactory.decodeStream(res.body.byteStream()) ?: return null
                IconCompat.createWithBitmap(round(bmp)).also { avatars.put(key, it) }
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun round(src: Bitmap): Bitmap {
        val size = minOf(src.width, src.height, 256)
        val out = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888)
        val c = Canvas(out)
        val p = Paint(Paint.ANTI_ALIAS_FLAG)
        c.drawCircle(size / 2f, size / 2f, size / 2f, p)
        p.xfermode = PorterDuffXfermode(PorterDuff.Mode.SRC_IN)
        c.drawBitmap(Bitmap.createScaledBitmap(src, size, size, true), 0f, 0f, p)
        return out
    }
}
