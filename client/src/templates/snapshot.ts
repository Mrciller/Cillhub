// Server snapshots (CONTRACT-v5 section 7) in guild-template.mdx's serialized_source_guild shape: roles, categories, channels,
// permission overwrites and settings with integer placeholder ids (@everyone is 0). No messages, no members.
// "Export server" downloads the server's snapshot (GET /guilds/:id/export); "Create from file" sends it back as a Create Guild body.
import { t } from '../i18n'
import type { GuildSnapshot, SnapshotChannel, SnapshotRole } from '../types'

const isInt = (v: unknown) => Number.isInteger(v)
/** Reads an export (or a bare snapshot, or a template object) back, with the checks a hand-edited file needs. Throws a readable error. */
export function parseSnapshot(text: string): GuildSnapshot {
  let data: unknown
  try { data = JSON.parse(text) } catch { throw new Error(t('This file is not valid JSON.')) }
  const snap = (data && typeof data === 'object' && 'serialized_source_guild' in data ? (data as { serialized_source_guild: unknown }).serialized_source_guild : data) as GuildSnapshot
  if (!snap || typeof snap !== 'object' || typeof snap.name !== 'string' || !Array.isArray(snap.roles) || !Array.isArray(snap.channels)) throw new Error(t('This file is not a Cillhub server export.'))
  if (snap.roles.length > 250 || snap.channels.length > 500) throw new Error(t('This export has too many roles or channels.'))
  const roleOk = (r: SnapshotRole) => r && isInt(r.id) && typeof r.name === 'string' && /^\d{1,20}$/.test(String(r.permissions))
  const chanOk = (c: SnapshotChannel) => c && isInt(c.id) && isInt(c.type) && typeof c.name === 'string' && (c.parent_id === null || c.parent_id === undefined || isInt(c.parent_id))
  if (!snap.roles.every(roleOk) || !snap.channels.every(chanOk)) throw new Error(t('This export has a broken role or channel.'))
  return snap
}
