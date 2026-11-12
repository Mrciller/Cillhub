// Member memory of encrypted DMs: which members this device accepted per DM (kept next to the key pins). Pure rules, so
// web and Android (data/E2eeMembers.kt) can be checked the same way: scripts/e2ee-members.test.mjs.

/** ids: accepted members (without this account); left: accepted once, gone since (their old wraps still open);
 * renew: the epoch at the last Accept: that key and older ones are never wrapped for the newly accepted member;
 * dm: stored for a 1:1 DM (the server cannot turn it into a group with an Accept prompt). */
export type Memory = { ids: string[]; left?: string[]; renew?: number; dm?: true }
/** accepted: members whose wraps count now; bad: a 1:1 DM whose members are not the one other member (no Accept);
 * added: members the server lists that this device has not accepted; next: the memory to store, or null (unchanged). */
export type Check = { accepted: string[]; added: string[]; bad: boolean; next: Memory | null }

/** `others`: the server's member list of the DM without this account. type 1 = 1:1 DM, 3 = group DM. */
export function checkMembers(type: number, mem: Memory | undefined, others: string[]): Check {
  if (!mem) {
    if (type === 1 && others.length !== 1) return { accepted: [], added: [], bad: true, next: null }
    return { accepted: others, added: [], bad: false, next: type === 1 ? { ids: others, dm: true } : { ids: others } }
  }
  const accepted = mem.ids.filter((id) => others.includes(id))
  const added = others.filter((id) => !mem.ids.includes(id))
  const gone = mem.ids.filter((id) => !others.includes(id))
  if (mem.dm && type !== 1) return { accepted, added, bad: true, next: null } // a 1:1 DM the server turned into a group
  if (type === 1) return { accepted, added, bad: added.length > 0 || gone.length > 0, next: null }
  return { accepted, added, bad: false, next: gone.length ? { ...mem, ids: accepted, left: [...new Set([...(mem.left ?? []), ...gone])] } : null }
}

/** The user accepted member `id` added to a group DM at `epoch`: the next send makes a new key. */
export const acceptMember = (mem: Memory, id: string, epoch: number): Memory =>
  ({ ...mem, ids: [...mem.ids.filter((x) => x !== id), id], left: mem.left?.filter((x) => x !== id), renew: epoch })

/** May a wrap made by `by` open here? Own and accepted members always; for older epochs also members who left since. */
export const trustedMaker = (mem: Memory | undefined, owner: string, by: string, current: boolean) =>
  by === owner || !!mem?.ids.includes(by) || (!current && !!mem?.left?.includes(by))

/** After loading my wraps: no usable current key counts as unverified (a missing wrap is the same as one that failed its
 * check, since a server can leave mine out), unless my own current wrap is a tombstone after my reset (I am stale). */
export const unverifiedKey = (epoch: number, haveKey: boolean, failed: boolean, stale: string[], owner: string) =>
  failed || (epoch > 0 && !haveKey && !stale.includes(owner))

/** Before a send in an encrypted DM: 'refuse' when my wrap of the current key failed its check (never renewed silently: the user
 * compares codes and renews by hand), 'renew' for a new key (no wrap for me or a tombstone, a wrap for someone gone, a reset
 * member, or the epoch of the last Accept), else 'use'. */
export function sendPlan(c: { epoch: number; unverified: boolean; haveKey: boolean; wrapped: string[]; stale: string[] }, members: string[], renew?: number) {
  if (c.unverified) return 'refuse'
  if (!c.haveKey || c.stale.length || c.wrapped.some((id) => !members.includes(id)) || (renew !== undefined && c.epoch <= renew)) return 'renew'
  return 'use'
}
