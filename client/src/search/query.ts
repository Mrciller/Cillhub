// Search query syntax -> search endpoint params (user docs: Search Guild Messages).
import { t } from '../i18n'
import type { SearchParams } from '../actions'
import { sidebar } from '../selectors'
import type { State } from '../store'

export const HAS = ['link', 'embed', 'file', 'image', 'video', 'sound', 'audio', 'code', 'poll', 'sticker'] as const
export const FILTERS: { key: string; hint: string }[] = [
  { key: 'from', hint: 'user' }, { key: 'mentions', hint: 'user' }, { key: 'has', hint: 'link, file, image or code' },
  { key: 'in', hint: 'channel' }, { key: 'before', hint: 'specific date or ID' }, { key: 'after', hint: 'specific date or ID' },
  { key: 'during', hint: 'specific date' }, { key: 'pinned', hint: 'true or false' },
]

const EPOCH = 1420070400000n
/** Snowflake for a time, for min_id/max_id. */
export const snowflakeAt = (ms: number) => String((BigInt(Math.max(0, Math.floor(ms))) - EPOCH) << 22n)

function dayStart(v: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v)
  return m ? new Date(+m[1], +m[2] - 1, +m[3]).getTime() : NaN
}

/** Users of the scope (guild members or DM participants) by username, nickname, display name or ID. */
export function findUser(s: State, guildId: string | undefined, name: string) {
  if (/^\d{1,19}$/.test(name)) return name
  const n = name.toLowerCase()
  const ids = guildId ? Object.keys(s.members[guildId] ?? {}) : Object.keys(s.users)
  return ids.find((id) => s.users[id]?.username.toLowerCase() === n) ?? ids.find((id) => [s.users[id]?.global_name, guildId && s.members[guildId]?.[id]?.nick].some((x) => x?.toLowerCase() === n))
}

export function parseQuery(s: State, guildId: string | undefined, q: string): { params: SearchParams; error?: string } {
  const params: Record<string, string[] | string> = {}
  const add = (k: string, v: string) => ((params[k] = [...((params[k] as string[]) ?? []), v]))
  const words: string[] = []
  let error: string | undefined
  for (const tok of q.match(/(?:[^\s"]+|"[^"]*")+/g) ?? []) {
    const m = /^(from|mentions|has|in|before|after|during|pinned):(.+)$/.exec(tok)
    if (!m) { words.push(tok.replace(/"/g, '')); continue }
    const [, key, raw] = m
    const v = raw.replace(/^"|"$/g, '').replace(/^[@#]/, '')
    if (key === 'from' || key === 'mentions') {
      const id = findUser(s, guildId, v)
      if (id) add(key === 'from' ? 'author_id' : 'mentions', id)
      else error = t('No user named {name}.', { name: v })
    } else if (key === 'has') {
      if ((HAS as readonly string[]).includes(v)) add('has', v)
      else error = t('has: takes {list}.', { list: HAS.join(', ') })
    } else if (key === 'in') {
      if (/^\d{1,19}$/.test(v) && s.channels[v]) {
        add('channel_id', v)
      } else {
        const ch = guildId ? sidebar(s, guildId).flatMap((g) => g.channels).find((c) => c.name?.toLowerCase() === v.toLowerCase()) : undefined
        if (ch) add('channel_id', ch.id)
        else error = t('No channel named {name}.', { name: v })
      }
    } else if (key === 'pinned') params.pinned = String(v === 'true')
    else {
      const day = dayStart(v)
      if (!Number.isNaN(day)) {
        if (key === 'before') params.max_id = snowflakeAt(day)
        else if (key === 'after') params.min_id = snowflakeAt(day + 864e5)
        else (params.min_id = snowflakeAt(day)), (params.max_id = snowflakeAt(day + 864e5))
      } else if (/^\d{1,19}$/.test(v)) {
        if (key === 'before') params.max_id = v
        else if (key === 'after') params.min_id = v
      } else {
        error = t('Dates look like 2026-11-03 or a message ID.')
      }
    }
  }
  if (words.length) params.content = words.join(' ')
  return { params, error }
}

if (import.meta.env.DEV) {
  const s = { members: { g: { 1: {} } }, users: { 1: { id: '1', username: 'bob' } }, channels: {}, guilds: {} } as unknown as State
  const r = parseQuery(s, 'g', 'hello from:bob has:link world')
  console.assert(r.params.content === 'hello world' && (r.params.author_id as string[])[0] === '1' && (r.params.has as string[])[0] === 'link' && !r.error, 'search parse')
  console.assert(snowflakeAt(1420070400000 + 1) === String(1n << 22n), 'snowflake at time')
}
