import { updateChannel } from '../actions'
import { apply, getState, setState } from '../store'
import type { Channel } from '../types'

/** Creation time of a snowflake id (ms). */
// node ids carry their node's prefix (`<node>~<snowflake>`, instances/registry.ts)
export const snowflakeTime = (id: string) => { const b = id.slice(id.indexOf('~') + 1); return /^\d+$/.test(b) ? Number(BigInt(b) >> 22n) + 1420070400000 : Date.now() }

/** The thread PATCH takes archived/locked/invitable/applied_tags/flags at the top level. */
export const patchThread = (t: Channel, body: Record<string, unknown>) => updateChannel(t.id, body as Partial<Channel>)

export const PINNED = 1 << 1
export const REQUIRE_TAG = 1 << 4
export const ARCHIVE_DURATIONS: [number, string][] = [[60, '1 Hour'], [1440, '24 Hours'], [4320, '3 Days'], [10080, '1 Week']]

/** Opens a thread in the side panel; a thread not in the store yet (e.g. archived, from a message) is added first. */
export function openThread(t: Channel) {
  if (!getState().channels[t.id]) apply('THREAD_CREATE', t)
  setState({ panel: { kind: 'thread', channelId: t.id }, showNav: false })
}
