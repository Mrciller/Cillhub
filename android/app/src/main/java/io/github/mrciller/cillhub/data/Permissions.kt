package io.github.mrciller.cillhub.data

import java.math.BigInteger
import java.time.Instant

/**
 * Permission bits and the reference algorithm, ported from client/src/permissions.ts (CONTRACT-v2 section 1,
 * CONTRACT-v3 section 0). Bitfields are decimal strings on the wire; bit 49 still fits a Long.
 */
object Perm {
    private fun b(n: Int) = 1L shl n
    val CREATE_INSTANT_INVITE = b(0); val KICK_MEMBERS = b(1); val BAN_MEMBERS = b(2); val ADMINISTRATOR = b(3)
    val MANAGE_CHANNELS = b(4); val MANAGE_GUILD = b(5); val ADD_REACTIONS = b(6); val VIEW_AUDIT_LOG = b(7); val PRIORITY_SPEAKER = b(8); val STREAM = b(9)
    val VIEW_CHANNEL = b(10); val SEND_MESSAGES = b(11); val MANAGE_MESSAGES = b(13); val EMBED_LINKS = b(14); val ATTACH_FILES = b(15)
    val READ_MESSAGE_HISTORY = b(16); val MENTION_EVERYONE = b(17); val USE_EXTERNAL_EMOJIS = b(18); val CONNECT = b(20); val SPEAK = b(21)
    val MUTE_MEMBERS = b(22); val DEAFEN_MEMBERS = b(23); val MOVE_MEMBERS = b(24); val CHANGE_NICKNAME = b(26)
    val MANAGE_NICKNAMES = b(27); val MANAGE_ROLES = b(28); val MANAGE_WEBHOOKS = b(29); val MANAGE_GUILD_EXPRESSIONS = b(30)
    val USE_APPLICATION_COMMANDS = b(31); val REQUEST_TO_SPEAK = b(32); val MANAGE_EVENTS = b(33); val MANAGE_THREADS = b(34)
    val CREATE_PUBLIC_THREADS = b(35); val CREATE_PRIVATE_THREADS = b(36); val USE_EXTERNAL_STICKERS = b(37); val SEND_MESSAGES_IN_THREADS = b(38)
    val MODERATE_MEMBERS = b(40); val USE_SOUNDBOARD = b(42); val CREATE_GUILD_EXPRESSIONS = b(43); val CREATE_EVENTS = b(44)
    val USE_EXTERNAL_SOUNDS = b(45); val SEND_VOICE_MESSAGES = b(46); val SEND_POLLS = b(49)

    val ALL = listOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 40, 42, 43, 44, 45, 46, 49)
        .fold(0L) { a, n -> a or b(n) }

    /** What a DM participant may do (selectors.ts DM_PERMS). */
    val DM = VIEW_CHANNEL or SEND_MESSAGES or ATTACH_FILES or ADD_REACTIONS or READ_MESSAGE_HISTORY or EMBED_LINKS or USE_EXTERNAL_EMOJIS or
        USE_EXTERNAL_STICKERS or SEND_VOICE_MESSAGES or SEND_POLLS or CONNECT or SPEAK or STREAM or USE_APPLICATION_COMMANDS

    private val READ_ONLY = VIEW_CHANNEL or READ_MESSAGE_HISTORY
    private val THREAD_TYPES = setOf(10, 11, 12)
    private val VOICE_TYPES = setOf(2, 13)
    const val DEFAULT_EVERYONE = "70356545"

    fun has(perms: Long, bit: Long) = perms and bit == bit
    // decimal strings; anything above 63 bits is cut off (no such bit exists)
    private fun big(s: String?) = try { BigInteger(s?.ifEmpty { "0" } ?: "0").toLong() } catch (e: NumberFormatException) { 0L }
    fun isThread(c: Channel?) = c != null && c.type in THREAD_TYPES

    fun timedOut(m: Member?, now: Instant = Instant.now()) =
        m?.communicationDisabledUntil?.let { runCatching { Instant.parse(it).isAfter(now) }.getOrDefault(false) } ?: false

    /** Guild-level permissions (step 1). member may be null while members are not loaded. */
    fun base(guild: Guild, userId: String, member: Member?, now: Instant = Instant.now()): Long {
        if (guild.ownerId == userId) return ALL
        var p = big(guild.roles.firstOrNull { it.id == guild.id }?.permissions ?: DEFAULT_EVERYONE)
        for (r in guild.roles) if (member?.roles?.contains(r.id) == true) p = p or big(r.permissions)
        if (has(p, ADMINISTRATOR)) return ALL
        return if (timedOut(member, now) || member?.pending == true) p and READ_ONLY else p
    }

    /** Channel permissions (steps 2 and 3); threads use their parent's overwrites and SEND_MESSAGES_IN_THREADS. */
    fun channel(guild: Guild, userId: String, member: Member?, ch: Channel, parent: Channel? = null, now: Instant = Instant.now()): Long {
        var p = base(guild, userId, member, now)
        if (p == ALL) return ALL
        val thread = isThread(ch)
        val src = if (thread && parent != null) parent else ch
        val ows = src.permissionOverwrites
        ows.firstOrNull { it.id == guild.id }?.let { p = (p and big(it.deny).inv()) or big(it.allow) }
        var allow = 0L
        var deny = 0L
        for (o in ows) if (o.type == 0 && o.id != guild.id && member?.roles?.contains(o.id) == true) { allow = allow or big(o.allow); deny = deny or big(o.deny) }
        p = (p and deny.inv()) or allow
        ows.firstOrNull { it.type == 1 && it.id == userId }?.let { p = (p and big(it.deny).inv()) or big(it.allow) }
        if (timedOut(member, now) || member?.pending == true) p = p and READ_ONLY
        if (!has(p, VIEW_CHANNEL)) return 0L
        if (thread) {
            p = if (has(p, SEND_MESSAGES_IN_THREADS)) p or SEND_MESSAGES else p and SEND_MESSAGES.inv()
            if (ch.threadMetadata?.locked == true && !has(p, MANAGE_THREADS)) p = p and SEND_MESSAGES.inv()
        }
        if (!has(p, SEND_MESSAGES)) p = p and (MENTION_EVERYONE or ATTACH_FILES or EMBED_LINKS or SEND_VOICE_MESSAGES or SEND_POLLS).inv()
        if (src.type in VOICE_TYPES && !has(p, CONNECT))
            p = p and (SPEAK or STREAM or MUTE_MEMBERS or DEAFEN_MEMBERS or MOVE_MEMBERS or PRIORITY_SPEAKER or REQUEST_TO_SPEAK or USE_SOUNDBOARD or USE_EXTERNAL_SOUNDS).inv()
        return p
    }

    /** Highest role position; the owner ranks above everyone. */
    fun rank(guild: Guild, userId: String, member: Member?): Int =
        if (guild.ownerId == userId) Int.MAX_VALUE else guild.roles.filter { member?.roles?.contains(it.id) == true }.maxOfOrNull { it.position }?.coerceAtLeast(0) ?: 0

    fun outranks(guild: Guild, meId: String, me: Member?, targetId: String, target: Member?) =
        targetId != guild.ownerId && targetId != meId && rank(guild, meId, me) > rank(guild, targetId, target)

    // The server's checks (server/src/permissions.js requireAbove / requireRoleBelow, routes/roles.js, members.js, channels.js).

    /** Edit, delete or move a role: MANAGE_ROLES and the role strictly below the actor's highest (the owner may touch all). */
    fun canManageRole(guild: Guild, meId: String, me: Member?, role: Role) =
        has(base(guild, meId, me), MANAGE_ROLES) && role.position < rank(guild, meId, me)

    /** Give or take a role: as above, never @everyone or a managed role. */
    fun canAssignRole(guild: Guild, meId: String, me: Member?, role: Role) =
        role.id != guild.id && !role.managed && canManageRole(guild, meId, me, role)

    /** Kick, ban, timeout or rename another member: the guild permission and the target ranked strictly below. */
    fun canModerate(guild: Guild, meId: String, me: Member?, bit: Long, targetId: String, target: Member?) =
        has(base(guild, meId, me), bit) && outranks(guild, meId, me, targetId, target)

    /** Administrators cannot be timed out. */
    fun canTimeout(guild: Guild, meId: String, me: Member?, targetId: String, target: Member?) =
        canModerate(guild, meId, me, MODERATE_MEMBERS, targetId, target) && !has(base(guild, targetId, target), ADMINISTRATOR)

    /** A channel permission overwrite for a role (type 0) or member (type 1): MANAGE_ROLES in the channel and a target below the actor. */
    fun canEditOverwrite(guild: Guild, meId: String, me: Member?, channelPerms: Long, targetId: String, type: Int, target: Member? = null): Boolean {
        if (!has(channelPerms, MANAGE_ROLES)) return false
        return if (type == 0) (guild.roles.firstOrNull { it.id == targetId }?.position ?: 0) < rank(guild, meId, me)
        else outranks(guild, meId, me, targetId, target)
    }

    /** Bits an overwrite or role edit may change: what the actor holds in the channel or the guild. */
    fun grantable(guild: Guild, meId: String, me: Member?, channelPerms: Long = 0L) = channelPerms or base(guild, meId, me)

    // The server lets an actor take these from themselves, and nobody below an administrator can give them back; the app refuses.

    /** False when the guild's roles [after], or the actor's own roles [afterMe], would cost the actor MANAGE_ROLES or ADMINISTRATOR. */
    fun keepsAdmin(guild: Guild, meId: String, me: Member?, after: Guild = guild, afterMe: Member? = me) =
        base(guild, meId, me) and base(after, meId, afterMe).inv() and (MANAGE_ROLES or ADMINISTRATOR) == 0L

    /** False when [overwrites] would hide the channel from the actor or cost them MANAGE_ROLES in it. */
    fun keepsChannelAccess(guild: Guild, meId: String, me: Member?, ch: Channel, overwrites: List<Overwrite>) =
        has(channel(guild, meId, me, ch.copy(permissionOverwrites = overwrites)), VIEW_CHANNEL or MANAGE_ROLES)

    fun bits(s: String?) = big(s)
}
