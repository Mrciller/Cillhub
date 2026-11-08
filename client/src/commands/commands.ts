// Application commands for the composer and context menus (user docs: application command index), and running them.
import { useEffect, useState } from 'react'
import { commandIndex, sendInteraction } from '../actions'
import { has } from '../permissions'
import type { AppCommand, Channel, CommandIndex, CommandOption } from '../types'

export type Entry = { cmd: AppCommand; path: string[]; options: CommandOption[]; description: string; app: string }
export type Values = Record<string, string | number | boolean | File>

/** Commands the user may run here: default_member_permissions and DM availability (contexts / dm_permission). */
function usable(c: AppCommand, channel: Channel, perms: bigint) {
  if (!channel.guild_id) {
    if (c.contexts ? !c.contexts.some((x) => x === 1 || x === 2) : c.dm_permission === false) return false
  } else if (c.contexts && !c.contexts.includes(0)) return false
  if (channel.guild_id && c.default_member_permissions != null) {
    const need = BigInt(c.default_member_permissions)
    if (need === 0n || !has(perms, need)) return false
  }
  return true
}

/** CHAT_INPUT commands flattened for the picker: `/cmd`, `/cmd sub`, `/cmd group sub`. */
export function flatten(index: CommandIndex, channel: Channel, perms: bigint): Entry[] {
  const apps = Object.fromEntries(index.applications.map((a) => [a.id, a.name]))
  const out: Entry[] = []
  for (const c of index.application_commands) {
    if ((c.type ?? 1) !== 1 || !usable(c, channel, perms)) continue
    const app = apps[c.application_id] ?? ''
    const subs = (c.options ?? []).filter((o) => o.type === 1 || o.type === 2)
    if (!subs.length) { out.push({ cmd: c, path: [c.name], options: c.options ?? [], description: c.description, app }); continue }
    for (const s of subs)
      if (s.type === 1) out.push({ cmd: c, path: [c.name, s.name], options: s.options ?? [], description: s.description, app })
      else for (const x of s.options ?? []) out.push({ cmd: c, path: [c.name, s.name, x.name], options: x.options ?? [], description: x.description, app })
  }
  return out.sort((a, b) => a.path.join(' ').localeCompare(b.path.join(' ')))
}

/** Loads the index once `enabled` (the user typed "/"). */
export function useIndex(channel: Channel, enabled = true) {
  const [index, setIndex] = useState<CommandIndex | null>(null)
  useEffect(() => {
    if (!enabled) return
    let live = true
    void commandIndex({ guildId: channel.guild_id, channelId: channel.id }).then((i) => live && setIndex(i))
    return () => void (live = false)
  }, [channel.guild_id, channel.id, enabled])
  return index
}

const cast = (o: CommandOption, v: string | number | boolean) => (o.type === 4 ? Math.trunc(Number(v)) : o.type === 10 ? Number(v) : o.type === 5 ? v === true || v === 'true' : String(v))

/** Files chosen for ATTACHMENT (11) options, in option order: files[n] of the request. */
const filesOf = (e: Entry, values: Values) => e.options.flatMap((o) => (o.type === 11 && values[o.name] instanceof File ? [values[o.name] as File] : []))

/** Interaction data: options nested under the subcommand path. `focused` marks the option being autocompleted (which
 *  never carries attachments). An ATTACHMENT option's value is the id of its entry in `attachments` = its files[n]. */
export function commandData(e: Entry, values: Values, focused?: string) {
  const files = focused ? [] : filesOf(e, values)
  let options: unknown[] = e.options.filter((o) => values[o.name] !== undefined && values[o.name] !== '' && (o.type !== 11 || !focused))
    .map((o) => ({ type: o.type, name: o.name, value: o.type === 11 ? files.indexOf(values[o.name] as File) : cast(o, values[o.name] as string | number | boolean), ...(o.name === focused && { focused: true }) }))
  if (e.path.length === 2) options = [{ type: 1, name: e.path[1], options }]
  if (e.path.length === 3) options = [{ type: 2, name: e.path[1], options: [{ type: 1, name: e.path[2], options }] }]
  return { id: e.cmd.id, type: 1, name: e.cmd.name, version: e.cmd.version, options, ...(files.length > 0 && { attachments: files.map((f, i) => ({ id: String(i), filename: f.name })) }) }
}

export function runCommand(channel: Channel, e: Entry, values: Values) {
  return sendInteraction(
    { type: 2, application_id: e.cmd.application_id, guild_id: channel.guild_id, channel_id: channel.id, data: commandData(e, values) },
    { kind: 'command', channelId: channel.id, appId: e.cmd.application_id, name: e.path.join(' ') },
    filesOf(e, values),
  )
}
/** Autocomplete (type 4): the answer comes back as APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE with our nonce. */
export const autocomplete = (channel: Channel, e: Entry, values: Values, focused: string) =>
  sendInteraction({ type: 4, application_id: e.cmd.application_id, guild_id: channel.guild_id, channel_id: channel.id, data: commandData(e, values, focused) })

/** USER (2) and MESSAGE (3) context commands for the "Apps" menu section. */
export async function contextCommands(channel: Channel, type: 2 | 3, perms: bigint) {
  const index = await commandIndex({ guildId: channel.guild_id, channelId: channel.id })
  return index.application_commands.filter((c) => c.type === type && usable(c, channel, perms))
}
export const runContextCommand = (channel: Channel, c: AppCommand, targetId: string) =>
  sendInteraction(
    { type: 2, application_id: c.application_id, guild_id: channel.guild_id, channel_id: channel.id, data: { id: c.id, type: c.type, name: c.name, version: c.version, target_id: targetId } },
    { kind: 'command', channelId: channel.id, appId: c.application_id, name: c.name },
  )
