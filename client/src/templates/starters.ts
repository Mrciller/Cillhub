// Built-in starter templates for "Add a server": the same snapshot shape as an export, created through importGuild.
import { t } from '../i18n'
import type { GuildSnapshot, SnapshotChannel, SnapshotRole } from '../types'

const VIEW = 1n << 10n
const STAFF = (1n << 1n) | (1n << 2n) | (1n << 13n) | (1n << 22n) | (1n << 24n) | (1n << 40n) // kick, ban, manage messages, mute, move, timeout

type Item = [type: 0 | 2 | 15, name: string]
type Cat = { name: string; items: Item[]; staffOnly?: boolean }
type Starter = { id: string; title: string; description: string; roles?: [name: string, color: number, staff?: boolean][]; cats: Cat[] }

/** Builds a snapshot: role 0 is @everyone; channel ids follow the order; the first text channel is the system channel. */
export function buildSnapshot(s: Starter, name: string): GuildSnapshot {
  // @everyone without permissions: the server applies its default permissions
  const roles = [{ id: 0, name: '@everyone', color: 0, hoist: false, mentionable: false } as SnapshotRole]
  let staffRole: number | undefined
  for (const [rname, color, staff] of s.roles ?? []) {
    if (staff) staffRole ??= roles.length
    roles.push({ id: roles.length, name: t(rname), permissions: staff ? String(STAFF) : '0', color, hoist: true, mentionable: true })
  }
  const channels: SnapshotChannel[] = []
  for (const c of s.cats) {
    const catId = channels.length
    const overwrites = c.staffOnly && staffRole !== undefined
      ? [{ id: 0, type: 0 as const, allow: '0', deny: String(VIEW) }, { id: staffRole, type: 0 as const, allow: String(VIEW), deny: '0' }] : []
    channels.push({ id: catId, type: 4, name: t(c.name), position: catId, parent_id: null, permission_overwrites: overwrites })
    c.items.forEach(([type, cname]) => channels.push({ id: channels.length, type, name: t(cname), position: channels.length, parent_id: catId, permission_overwrites: overwrites }))
  }
  const system = channels.find((c) => c.type === 0)?.id ?? null
  return { name, description: null, verification_level: 0, default_message_notifications: 1, explicit_content_filter: 0, preferred_locale: 'en-US',
    afk_timeout: 300, afk_channel_id: null, system_channel_id: system, system_channel_flags: 0, roles, channels }
}

const voice = (n: string): Item => [2, n]
const text = (n: string): Item => [0, n]

export const STARTERS: Starter[] = [
  { id: 'gaming', title: 'Gaming', description: 'Hang out and play together.', cats: [
    { name: 'Text Channels', items: [text('general'), text('clips-and-highlights'), text('looking-for-group')] },
    { name: 'Voice Channels', items: [voice('Lobby'), voice('Gaming'), voice('AFK')] }] },
  { id: 'esports', title: 'Esports Team', description: 'Practice, scrims and match days, with staff and player roles.',
    roles: [['Staff', 0xe74c3c, true], ['Coach', 0xf1c40f], ['Player', 0x3498db], ['Sub', 0x95a5a6]], cats: [
    { name: 'Information', items: [text('announcements'), text('schedule')] },
    { name: 'Team', items: [text('general'), text('strategy'), text('vod-review'), voice('Team Comms'), voice('Scrim')] },
    { name: 'Community', items: [text('fans'), voice('Watch Party')] },
    { name: 'Staff', items: [text('staff-chat'), voice('Staff Meeting')], staffOnly: true }] },
  { id: 'friends', title: 'Friends', description: 'A small place for your group.', cats: [
    { name: 'Text Channels', items: [text('general'), text('memes'), text('plans')] },
    { name: 'Voice Channels', items: [voice('Hangout'), voice('Stream Room')] }] },
  { id: 'study', title: 'Study Group', description: 'Notes, homework help and quiet study rooms.', cats: [
    { name: 'Text Channels', items: [text('general'), text('homework-help'), text('resources')] },
    { name: 'Voice Channels', items: [voice('Study Room 1'), voice('Study Room 2')] }] },
  { id: 'community', title: 'Community', description: 'Announcements, discussion and moderators.',
    roles: [['Moderator', 0x2ecc71, true]], cats: [
    { name: 'Welcome', items: [text('rules'), text('announcements')] },
    { name: 'Discussion', items: [text('general'), text('introductions'), [15, 'ideas']] },
    { name: 'Voice Channels', items: [voice('Lounge'), voice('Events')] },
    { name: 'Moderators', items: [text('mod-chat')], staffOnly: true }] },
]
