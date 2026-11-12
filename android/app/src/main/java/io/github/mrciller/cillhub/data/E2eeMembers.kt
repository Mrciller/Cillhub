package io.github.mrciller.cillhub.data

import kotlinx.serialization.Serializable

/**
 * Member memory of encrypted DMs, the rules of client/src/e2ee/members.ts: which members this device accepted per DM (kept in
 * the prefs with the key pins). Pure, so E2eeMembersTest checks them without a device.
 */
object E2eeMembers {
    /** ids: accepted members (without this account); left: accepted once, gone since (their old wraps still open);
     * renew: the epoch at the last Accept: that key and older ones are never wrapped for the newly accepted member. */
    @Serializable data class Memory(val ids: List<String>, val left: List<String> = emptyList(), val renew: Int? = null)
    /** bad: a 1:1 DM whose members are not the one other member (no Accept); added: listed by the server, not accepted here;
     * next: the memory to store, or null (unchanged). */
    data class Check(val accepted: List<String>, val added: List<String>, val bad: Boolean, val next: Memory?)

    /** [others]: the server's member list of the DM without this account. type 1 = 1:1 DM, 3 = group DM. */
    fun check(type: Int, mem: Memory?, others: List<String>): Check {
        if (mem == null) {
            if (type == 1 && others.size != 1) return Check(emptyList(), emptyList(), true, null)
            return Check(others, emptyList(), false, Memory(others))
        }
        val accepted = mem.ids.filter { it in others }
        val added = others.filter { it !in mem.ids }
        val gone = mem.ids.filter { it !in others }
        if (type == 1) return Check(accepted, added, added.isNotEmpty() || gone.isNotEmpty(), null)
        return Check(accepted, added, false, if (gone.isNotEmpty()) mem.copy(ids = accepted, left = (mem.left + gone).distinct()) else null)
    }

    /** The user accepted member [id] added to a group DM at [epoch]: the next send makes a new key. */
    fun accept(mem: Memory, id: String, epoch: Int) = mem.copy(ids = mem.ids.filter { it != id } + id, left = mem.left.filter { it != id }, renew = epoch)

    /** May a wrap made by [by] open here? Own and accepted members always; for older epochs also members who left since. */
    fun trusted(mem: Memory?, owner: String, by: String, current: Boolean) =
        by == owner || mem?.ids?.contains(by) == true || (!current && mem?.left?.contains(by) == true)

    enum class Plan { USE, RENEW, REFUSE }
    /** Before a send: REFUSE when my wrap of the current key failed its check (never renewed silently), RENEW for no wrap for
     * me or a tombstone, a wrap for someone gone, a reset member, or the epoch of the last Accept; else USE. */
    fun plan(epoch: Int, unverified: Boolean, haveKey: Boolean, wrapped: List<String>, stale: List<String>, members: List<String>, renew: Int?) = when {
        unverified -> Plan.REFUSE
        !haveKey || stale.isNotEmpty() || wrapped.any { it !in members } || (renew != null && epoch <= renew) -> Plan.RENEW
        else -> Plan.USE
    }

    /** The key to wrap a channel key for: the newest one pinned on this device once the server shows that member has a key at
     * all; never a later server answer (it could differ from the one the key-change check saw). */
    fun wrapTarget(server: String?, pins: List<String>): String? = if (server.isNullOrEmpty()) null else pins.lastOrNull()
}
