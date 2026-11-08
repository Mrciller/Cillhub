// Server rail order and folders, stored as the `guild_folders` setting (a single server is a folder with id null).
import { patchSettings } from '../actions'
import type { State } from '../store'
import type { GuildFolder } from '../types'

const single = (id: string): GuildFolder => ({ id: null, name: null, color: null, guild_ids: [id] })

/** The rail as folders: servers missing from the setting (newly joined) come first. */
export function railLayout(s: State): GuildFolder[] {
  const placed = new Set<string>()
  const out: GuildFolder[] = []
  for (const f of s.settings.guild_folders ?? []) {
    const ids = f.guild_ids.filter((id) => s.guilds[id] && !placed.has(id))
    ids.forEach((id) => placed.add(id))
    if (!ids.length) continue
    if (f.id === null) out.push(...ids.map(single))
    else out.push({ ...f, guild_ids: ids })
  }
  return [...Object.keys(s.guilds).filter((id) => !placed.has(id)).map(single), ...out]
}

const without = (l: GuildFolder[], gid: string) => l.map((f) => ({ ...f, guild_ids: f.guild_ids.filter((x) => x !== gid) })).filter((f) => f.guild_ids.length)
const newId = () => Math.floor(Math.random() * 2 ** 31)

/** Dropping a server onto another makes a folder of the two (or adds it to the target's folder). */
export function dropOnto(l: GuildFolder[], drag: string, target: string) {
  if (drag === target) return l
  return without(l, drag).map((f) =>
    f.guild_ids.includes(target)
      ? f.id === null ? { id: newId(), name: null, color: null, guild_ids: [target, drag] } : { ...f, guild_ids: [...f.guild_ids, drag] }
      : f)
}
export const dropIntoFolder = (l: GuildFolder[], drag: string, folderId: number) =>
  without(l, drag).map((f) => (f.id === folderId ? { ...f, guild_ids: [...f.guild_ids, drag] } : f))

/** Moves a server in front of another server (inside its folder when `inside`), or to the end when `before` is null. */
export function dropBefore(l: GuildFolder[], drag: string, before: string | null, inside = false) {
  if (drag === before) return l
  const next = without(l, drag)
  if (before === null) return [...next, single(drag)]
  const i = next.findIndex((f) => f.guild_ids.includes(before))
  if (i < 0) return [...next, single(drag)]
  if (inside && next[i].id !== null) return next.with(i, { ...next[i], guild_ids: next[i].guild_ids.toSpliced(next[i].guild_ids.indexOf(before), 0, drag) })
  return next.toSpliced(i, 0, single(drag))
}
/** Moves a whole folder in front of the entry holding `before` (null = to the end). */
export function moveFolder(l: GuildFolder[], folderId: number, before: string | null) {
  const f = l.find((x) => x.id === folderId)
  if (!f || (before && f.guild_ids.includes(before))) return l
  const rest = l.filter((x) => x !== f)
  const i = before === null ? -1 : rest.findIndex((x) => x.guild_ids.includes(before))
  return i < 0 ? [...rest, f] : rest.toSpliced(i, 0, f)
}

/** Keyboard reordering: one step up or down within the folder, or among the top-level entries. */
export function moveBy(l: GuildFolder[], gid: string, delta: -1 | 1) {
  const i = l.findIndex((f) => f.guild_ids.includes(gid))
  const f = l[i]
  if (f.id !== null) {
    const j = f.guild_ids.indexOf(gid)
    const k = j + delta
    if (k < 0 || k >= f.guild_ids.length) return l
    const ids = [...f.guild_ids]
    ;[ids[j], ids[k]] = [ids[k], ids[j]]
    return l.with(i, { ...f, guild_ids: ids })
  }
  const k = i + delta
  if (k < 0 || k >= l.length) return l
  const next = [...l]
  ;[next[i], next[k]] = [next[k], next[i]]
  return next
}
export const removeFromFolder = (l: GuildFolder[], gid: string) => {
  const i = l.findIndex((f) => f.guild_ids.includes(gid))
  return l[i]?.id === null ? l : without(l, gid).toSpliced(i + (l[i].guild_ids.length > 1 ? 1 : 0), 0, single(gid))
}
export const newFolder = (l: GuildFolder[], gid: string) => {
  const i = l.findIndex((f) => f.guild_ids.includes(gid))
  return l.with(i, { id: newId(), name: null, color: null, guild_ids: [gid] })
}

/** Saves the layout (also as the flat `guild_positions` for the guild order). */
export const saveLayout = (l: GuildFolder[]) => patchSettings({ guild_folders: l, guild_positions: l.flatMap((f) => f.guild_ids) })

if (import.meta.env.DEV) {
  const l: GuildFolder[] = ['a', 'b', 'c'].map(single)
  const f = dropOnto(l, 'c', 'a')
  console.assert(f.length === 2 && f[0].id !== null && f[0].guild_ids.join() === 'a,c', 'drop onto makes a folder')
  console.assert(dropBefore(f, 'b', 'a', true)[0].guild_ids.join() === 'b,a,c', 'drop into folder before')
  console.assert(removeFromFolder(f, 'c').map((x) => x.guild_ids.join()).join('|') === 'a|c|b', 'remove from folder')
  console.assert(moveBy(l, 'b', -1).map((x) => x.guild_ids[0]).join() === 'b,a,c', 'move up')
}
