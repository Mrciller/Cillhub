package io.github.mrciller.cillhub.data

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNamingStrategy

/** The v9 API's snake_case JSON; unknown fields are ignored so newer servers keep working. */
@OptIn(ExperimentalSerializationApi::class)
val json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    encodeDefaults = false
    namingStrategy = JsonNamingStrategy.SnakeCase
}

// Shapes from docs/CONTRACT.md (v1) to CONTRACT-v4.md; only the fields this app uses.

@Serializable
data class User(
    val id: String,
    val username: String = "",
    val globalName: String? = null,
    val avatar: String? = null,
    val bot: Boolean = false,
    val system: Boolean = false,
    val email: String? = null,
    val bio: String? = null,
    val pronouns: String? = null,
    val accentColor: Int? = null,
    val banner: String? = null,
    val mfaEnabled: Boolean = false,
    /** The server tag the user chose to show (v6 customization). */
    val primaryGuild: PrimaryGuild? = null,
) {
    val displayName get() = globalName?.takeIf { it.isNotBlank() } ?: username.ifBlank { "Unknown" }
}

@Serializable
data class Role(
    val id: String,
    val name: String = "",
    val color: Int = 0,
    val hoist: Boolean = false,
    val position: Int = 0,
    val permissions: String = "0",
    val mentionable: Boolean = false,
    val managed: Boolean = false,
)

@Serializable
data class PrimaryGuild(val tag: String? = null)

@Serializable
data class Overwrite(val id: String, val type: Int = 0, val allow: String = "0", val deny: String = "0")

@Serializable
data class ThreadMetadata(
    val archived: Boolean = false,
    val locked: Boolean = false,
    val autoArchiveDuration: Int = 4320,
    val archiveTimestamp: String? = null,
)

@Serializable
data class ForumTag(
    val id: String,
    val name: String = "",
    val moderated: Boolean = false,
    val emojiId: String? = null,
    val emojiName: String? = null,
)

@Serializable
data class ThreadMember(
    val id: String? = null,
    val userId: String? = null,
    val joinTimestamp: String = "",
    val flags: Int = 0,
    val member: Member? = null,
)

@Serializable
data class Channel(
    val id: String,
    val type: Int = 0,
    val guildId: String? = null,
    val name: String? = null,
    val position: Int = 0,
    val parentId: String? = null,
    val topic: String? = null,
    val recipients: List<User> = emptyList(),
    val lastMessageId: String? = null,
    val permissionOverwrites: List<Overwrite> = emptyList(),
    val rateLimitPerUser: Int = 0,
    val nsfw: Boolean = false,
    val icon: String? = null,
    val ownerId: String? = null,
    val threadMetadata: ThreadMetadata? = null,
    val userLimit: Int = 0,
    /** Voice channel status (CONTRACT-v5 section 6). */
    val status: String? = null,
    val flags: Int = 0,
    val solvedMessageId: String? = null,
    val availableTags: List<ForumTag> = emptyList(),
    val appliedTags: List<String> = emptyList(),
    val defaultForumLayout: Int = 0,
    val defaultSortOrder: Int? = null,
    val messageCount: Int = 0,
    val memberCount: Int = 0,
    val totalMessageSent: Int = 0,
    val member: ThreadMember? = null,
    val defaultAutoArchiveDuration: Int = 4320,
)

val Channel.isThread: Boolean get() = type in 10..12 || threadMetadata != null

@Serializable
data class Member(
    val user: User? = null,
    val nick: String? = null,
    val roles: List<String> = emptyList(),
    val joinedAt: String = "",
    val communicationDisabledUntil: String? = null,
    val pending: Boolean = false,
    val avatar: String? = null,
)

@Serializable
data class Activity(val type: Int = 0, val name: String = "", val state: String? = null, val emoji: EmojiRef? = null)

@Serializable
data class IdOnly(val id: String)

@Serializable
data class Presence(val user: IdOnly, val status: String = "offline", val activities: List<Activity>? = null)

@Serializable
data class Guild(
    val id: String,
    val name: String = "",
    val icon: String? = null,
    val ownerId: String = "",
    val memberCount: Int = 0,
    val roles: List<Role> = emptyList(),
    val systemChannelId: String? = null,
    val description: String? = null,
    // only in READY / GUILD_CREATE / GET /guilds/:id; the store keeps them elsewhere
    val channels: List<Channel>? = null,
    val members: List<Member>? = null,
    val presences: List<Presence>? = null,
    val threads: List<Channel>? = null,
    val voiceStates: List<VoiceState>? = null,
    val afkChannelId: String? = null,
)

/** Who is in which voice channel or DM call (guild_id null), CONTRACT-v2 section 10 and v4. */
@Serializable
data class VoiceState(
    val guildId: String? = null,
    val channelId: String? = null,
    val userId: String,
    val sessionId: String = "",
    val selfMute: Boolean = false,
    val selfDeaf: Boolean = false,
    val selfVideo: Boolean = false,
    val selfStream: Boolean = false,
    val mute: Boolean = false,
    val deaf: Boolean = false,
    val suppress: Boolean = false,
    val member: Member? = null,
)

/** A DM or group DM call (CALL_CREATE / CALL_UPDATE): who is being rung. */
@Serializable
data class CallInfo(val channelId: String, val ringing: List<String> = emptyList())

@Serializable
data class EmojiRef(val id: String? = null, val name: String = "", val animated: Boolean = false) {
    /** Custom emoji by id, Unicode emoji by the character (as the web client's emojiKey). */
    val key get() = id ?: name
}

@Serializable
data class Reaction(val emoji: EmojiRef, val count: Int = 0, val me: Boolean = false)

@Serializable
data class Attachment(
    val id: String,
    val filename: String = "file",
    val size: Long = 0,
    val contentType: String? = null,
    val url: String = "",
    val width: Int? = null,
    val height: Int? = null,
    val description: String? = null,
    @kotlinx.serialization.SerialName("duration_secs") val durationSecs: Float? = null,
    val waveform: String? = null,
) {
    val isImage get() = (contentType?.startsWith("image/") == true || filename.substringAfterLast('.').lowercase() in IMAGE_EXT) && !filename.startsWith("SPOILER_")
    val spoiler get() = filename.startsWith("SPOILER_")

    companion object { val IMAGE_EXT = setOf("png", "jpg", "jpeg", "gif", "webp") }
}

@Serializable data class EmbedMedia(val url: String? = null, val proxyUrl: String? = null, val width: Int? = null, val height: Int? = null)
@Serializable data class EmbedAuthor(val name: String = "", val url: String? = null)
@Serializable data class EmbedFooter(val text: String = "")
@Serializable data class EmbedProvider(val name: String? = null)
@Serializable data class EmbedField(val name: String = "", val value: String = "", val inline: Boolean = false)

@Serializable
data class Embed(
    val type: String? = null,
    val title: String? = null,
    val description: String? = null,
    val url: String? = null,
    val color: Int? = null,
    val author: EmbedAuthor? = null,
    val footer: EmbedFooter? = null,
    val image: EmbedMedia? = null,
    val thumbnail: EmbedMedia? = null,
    val video: EmbedMedia? = null,
    val provider: EmbedProvider? = null,
    val fields: List<EmbedField> = emptyList(),
)

@Serializable
data class MessageReference(val messageId: String? = null, val channelId: String? = null, val guildId: String? = null, val type: Int = 0)

@Serializable
data class StickerItem(val id: String, val name: String = "", val formatType: Int = 1)

@Serializable
data class PollMedia(val text: String? = null, val emoji: EmojiRef? = null)

@Serializable
data class PollAnswer(val answerId: Int, val pollMedia: PollMedia)

@Serializable
data class PollAnswerCount(val id: Int, val count: Int = 0, val meVoted: Boolean = false)

@Serializable
data class PollResults(val isFinalized: Boolean = false, val answerCounts: List<PollAnswerCount> = emptyList())

@Serializable
data class Poll(
    val question: PollMedia,
    val answers: List<PollAnswer> = emptyList(),
    val expiry: String? = null,
    val allowMultiselect: Boolean = false,
    val layoutType: Int = 0,
    val results: PollResults? = null,
    val anonymous: Boolean = false,
    val allowedRoleIds: List<String> = emptyList(),
    val correctAnswerId: Int? = null,
    val isQuiz: Boolean = false,
)

@Serializable
data class MessageEdit(val content: String, val editedAt: String)

@Serializable
data class MessageEditsResponse(val edits: List<MessageEdit> = emptyList())

@Serializable
data class Snippet(
    val id: String,
    val guildId: String,
    val name: String,
    val content: String,
    val createdBy: String,
    val createdAt: String,
)

@Serializable
data class SnippetsResponse(val snippets: List<Snippet> = emptyList())

@Serializable
data class MediaGalleryResponse(val messages: List<Message> = emptyList())

@Serializable
data class ThreadListResponse(val threads: List<Channel> = emptyList(), val members: List<ThreadMember> = emptyList(), val hasMore: Boolean = false)

@Serializable
data class RecipientReadState(val channelId: String, val userId: String, val lastMessageId: String)

@Serializable
data class Message(
    val id: String,
    val type: Int = 0,
    val channelId: String,
    val guildId: String? = null,
    val author: User,
    val content: String = "",
    val timestamp: String = "",
    val editedTimestamp: String? = null,
    val mentions: List<User> = emptyList(),
    val mentionRoles: List<String> = emptyList(),
    val mentionEveryone: Boolean = false,
    val attachments: List<Attachment> = emptyList(),
    val embeds: List<Embed> = emptyList(),
    val reactions: List<Reaction> = emptyList(),
    val pinned: Boolean = false,
    val nonce: String? = null,
    val messageReference: MessageReference? = null,
    val referencedMessage: Message? = null,
    val flags: Int = 0,
    val webhookId: String? = null,
    val stickerItems: List<StickerItem> = emptyList(),
    val poll: Poll? = null,
    val member: Member? = null,
    // local only: an optimistic copy that is still sending, or failed to send
    @Transient val pending: Boolean = false,
    @Transient val failed: Boolean = false,
)

@Serializable
data class ReadState(val id: String, val lastMessageId: String? = null, val mentionCount: Int = 0)

/** 1 friend, 2 blocked, 3 incoming request, 4 outgoing request. */
@Serializable
data class Relationship(val id: String, val type: Int, val user: User? = null)

@Serializable data class MuteConfig(val endTime: String? = null)
@Serializable data class ChannelOverride(val channelId: String, val muted: Boolean = false, val muteConfig: MuteConfig? = null, val messageNotifications: Int = 3)

@Serializable
data class UserGuildSettings(
    val guildId: String? = null,
    val muted: Boolean = false,
    val muteConfig: MuteConfig? = null,
    val messageNotifications: Int = 0,
    val suppressEveryone: Boolean = false,
    val suppressRoles: Boolean = false,
    val mobilePush: Boolean = true,
    val channelOverrides: List<ChannelOverride> = emptyList(),
)

@Serializable
data class Ready(
    val user: User,
    val sessionId: String = "",
    val guilds: List<Guild> = emptyList(),
    val privateChannels: List<Channel> = emptyList(),
    val users: List<User> = emptyList(),
    val presences: List<Presence> = emptyList(),
    val readState: List<ReadState> = emptyList(),
    val relationships: List<Relationship> = emptyList(),
    val userSettings: UserSettings? = null,
    val recipientReadStates: List<RecipientReadState> = emptyList(),
)

@Serializable
data class UserSettings(val status: String? = null, val locale: String? = null, val theme: String? = null, val favoriteGifs: List<FavoriteGif> = emptyList())

/** A saved GIF in the settings document's favorite_gifs (newest first, at most 250; url is the key). */
@Serializable
data class FavoriteGif(val url: String, val src: String, val width: Int = 0, val height: Int = 0, val format: String = "gif")

/** A GIF search result (GET /gifs/search, /gifs/trending). */
@Serializable
data class Gif(val id: String = "", val title: String = "", val url: String, val src: String, val width: Int = 0, val height: Int = 0, val preview: String? = null)

// server administration (GET /guilds/:id/invites, /bans, /audit-logs)
@Serializable data class Invite(val code: String, val channel: Channel? = null, val inviter: User? = null, val uses: Int = 0, val maxUses: Int = 0, val expiresAt: String? = null)
@Serializable data class Ban(val user: User, val reason: String? = null)
/** GET …/messages/search: each hit is a one-message list. */
@Serializable data class SearchResults(val totalResults: Int = 0, val messages: List<List<Message>> = emptyList())
/** A server emoji; [user] (who added it) only for members with an expressions permission. */
@Serializable data class GuildEmoji(val id: String, val name: String = "", val animated: Boolean = false, val user: User? = null)
@Serializable data class AuditEntry(val id: String, val userId: String? = null, val targetId: String? = null, val actionType: Int = 0, val reason: String? = null)
@Serializable data class AuditLog(val auditLogEntries: List<AuditEntry> = emptyList(), val users: List<User> = emptyList())

@Serializable data class UserProfileMeta(val bio: String = "", val pronouns: String = "", val accentColor: Int? = null, val banner: String? = null)

@Serializable
data class Profile(
    val user: User,
    val userProfile: UserProfileMeta? = null,
    val guildMember: Member? = null,
    val mutualGuilds: List<IdOnly> = emptyList(),
    val mutualFriendsCount: Int = 0,
)

/** GET /instance (v6/v7): what the login screen needs. */
@Serializable
data class InstanceInfo(val name: String? = null, val motd: String? = null, val registrationMode: String = "open", val maxUploadBytes: Long = 25L * 1024 * 1024, val setupPending: Boolean = false,
    /** 7.10: password reset by email is offered. */
    val passwordReset: Boolean = false,
    /** 7.10.3: the legal pages and sign-up checks; null on older servers (no checkboxes then). */
    val legal: LegalInfo? = null)

/** GET /instance `legal`: which pages the operator filled in, the terms version sign-up accepts, the minimum age. */
@Serializable
data class LegalInfo(val imprint: Boolean = false, val privacy: Boolean = false, val terms: Boolean = false, val acceptVersion: Long? = null, val minAge: Int = 14)

/** POST /auth/login: a token, or an MFA ticket (CONTRACT-v4 section 5). */
@Serializable
data class LoginAnswer(val token: String? = null, val userId: String? = null, val mfa: Boolean = false, val ticket: String? = null, val requiredActions: List<String> = emptyList())
