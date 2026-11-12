// Voice joins in order: a join that started before the last leave or switch is stale and must not go on (create a room,
// map identities, publish the microphone). No imports: scripts/private-nodes.test.mjs runs it under plain node.
export function joins() {
  let gen = 0
  return {
    /** A leave or a switch: every join under way is stale from now on. */
    bump: () => void gen++,
    /** Starts a join: `load` may be slow (a lazy import); resolves null when a leave or switch came in between. */
    async start<L>(load: () => Promise<L>): Promise<{ lib: L; live: () => boolean } | null> {
      const mine = ++gen
      const lib = await load()
      return mine === gen ? { lib, live: () => mine === gen } : null
    },
  }
}
