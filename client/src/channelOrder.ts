// Reordering channels: drag and drop and the keyboard alternative in Channel Settings share these helpers.
import { moveChannels } from './actions'
import { cmpId, getState } from './store'
import type { Channel } from './types'

type Change = { id: string; position: number; parent_id?: string | null }
const voice = (c: Channel) => Number(c.type === 2 || c.type === 13)
const order = (a: Channel, b: Channel) => voice(a) - voice(b) || (a.position ?? 0) - (b.position ?? 0) || cmpId(a.id, b.id)

function siblings(guildId: string, parentId: string | null, without: string) {
  const all = Object.values(getState().channels).filter((c) => c.guild_id === guildId && c.id !== without && !c.thread_metadata)
  return parentId === '#categories'
    ? all.filter((c) => c.type === 4).sort(order)
    : all.filter((c) => c.type !== 4 && (c.parent_id ?? null) === parentId).sort(order)
}

/** Positions 0..n for `list`, returning only what changed (plus the moved channel's parent). */
function renumber(list: Channel[], moved: Channel, parentId: string | null): Change[] {
  return list.flatMap((c, position) => {
    if (c.id === moved.id) return [{ id: c.id, position, ...(moved.type !== 4 && { parent_id: parentId }) }]
    return c.position === position ? [] : [{ id: c.id, position }]
  })
}

/** Moves `id` before `beforeId` (or to the end when null) inside `parentId` (categories reorder among themselves). */
export function moveChannel(id: string, parentId: string | null, beforeId: string | null) {
  const c = getState().channels[id]
  if (!c?.guild_id) return Promise.resolve()
  const group = c.type === 4 ? '#categories' : parentId
  const list = siblings(c.guild_id, group, id)
  const i = beforeId ? list.findIndex((x) => x.id === beforeId) : -1
  list.splice(i < 0 ? list.length : i, 0, c)
  const changes = renumber(list, c, c.type === 4 ? null : parentId)
  return changes.length ? moveChannels(c.guild_id, changes) : Promise.resolve()
}

/** One step up or down among its siblings. */
export function nudgeChannel(id: string, delta: -1 | 1) {
  const c = getState().channels[id]
  if (!c?.guild_id) return Promise.resolve()
  const parent = c.type === 4 ? null : (c.parent_id ?? null)
  const list = siblings(c.guild_id, c.type === 4 ? '#categories' : parent, '')
  const i = list.findIndex((x) => x.id === id)
  const target = delta < 0 ? list[i - 1] : list[i + 2]
  if (delta < 0 && !target) return Promise.resolve()
  if (delta > 0 && i === list.length - 1) return Promise.resolve()
  return moveChannel(id, parent, target?.id ?? null)
}
