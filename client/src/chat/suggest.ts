// Mention autocomplete sources for the composer: @users, @roles, @everyone/@here and #channels.
import { t } from '../i18n'
import { EMOJI } from '../emoji/data'
import { canUseEmoji, has, P } from '../permissions'
import { myMember, sidebar, textColorOf } from '../selectors'
import { displayName, type State } from '../store'
import type { Channel, Snippet } from '../types'

const snippetCache: Record<string, Snippet[]> = {}
export function setCachedSnippets(guildId: string, snippets: Snippet[]) {
  snippetCache[guildId] = snippets
}
export function getCachedSnippets(guildId: string): Snippet[] {
  return snippetCache[guildId] ?? []
}

export type Suggestion = {
  key: string; label: string; sub?: string; color?: string; insert: string; syntax: string; kind: 'user' | 'role' | 'special' | 'channel' | 'emoji'
  emoji?: { id: string | null; char?: string; animated?: boolean }
}

/** `:name` autocomplete: custom emoji (this server, others with USE_EXTERNAL_EMOJIS) then Unicode, from 2 characters. */
function emojiSuggestions(s: State, channel: Channel, perms: bigint, q: string): Suggestion[] {
  if (q.length < 2) return []
  const out: Suggestion[] = []
  const gid = channel.guild_id
  for (const g of Object.values(s.guilds)) {
    if (g.id !== gid && !has(perms, P.USE_EXTERNAL_EMOJIS)) continue
    const mine = g.id === gid ? myMember(s, gid) : s.me ? s.members[g.id]?.[s.me.id] : undefined
    for (const e of g.emojis ?? [])
      if (e.id && e.available !== false && e.name.toLowerCase().includes(q) && canUseEmoji(e.roles, mine, g.owner_id === s.me?.id))
        out.push({ key: e.id, label: `:${e.name}:`, sub: g.id === gid ? undefined : g.name, insert: `:${e.name}:`, syntax: `<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`, kind: 'emoji', emoji: { id: e.id, animated: e.animated } })
  }
  for (const c of EMOJI)
    for (const e of c.list)
      if (e.keywords.split(' ').some((k) => k.startsWith(q))) out.push({ key: e.char, label: `:${e.name}:`, insert: e.char, syntax: e.char, kind: 'emoji', emoji: { id: null, char: e.char } })
  return out.slice(0, 10)
}

/** `@username` typed without picking from the autocomplete becomes `<@id>` when exactly one member (or DM participant) matches. */
export function resolveMentions(s: State, channel: Channel, content: string) {
  const gid = channel.guild_id
  const ids = gid ? Object.keys(s.members[gid] ?? {}) : [...(channel.recipients ?? []).map((u) => u.id), s.me?.id ?? '']
  // Code spans and blocks are left alone; existing <...> tokens never match because of the lookbehind.
  return content.split(/(```[\s\S]*?```|`[^`]*`)/).map((part, i) => i % 2 ? part : part.replace(/(?<![\w<])@([\p{L}\p{N}_.]{2,32})/gu, (all, name: string) => {
    if (name === 'everyone' || name === 'here') return all
    const n = name.toLowerCase()
    const hits = ids.filter((id) => s.users[id]?.username.toLowerCase() === n)
    return hits.length === 1 ? `<@${hits[0]}>` : all
  })).join('')
}

export function suggest(s: State, channel: Channel, perms: bigint, trigger: '@' | '#' | ':' | '!', query: string): Suggestion[] {
  const q = query.toLowerCase()
  if (trigger === ':') return emojiSuggestions(s, channel, perms, q)
  const hit = (...xs: (string | null | undefined)[]) => xs.some((x) => x?.toLowerCase().startsWith(q))
  const out: Suggestion[] = []
  const gid = channel.guild_id
  if (trigger === '!') {
    if (!gid) return []
    const snips = getCachedSnippets(gid)
    for (const snip of snips) {
      if (hit(snip.name, snip.content)) {
        out.push({
          key: snip.id,
          label: `!${snip.name}`,
          sub: snip.content.slice(0, 60),
          insert: `!${snip.name}`,
          syntax: `!${snip.name}`,
          kind: 'special',
        })
      }
    }
    return out.slice(0, 10)
  }
  if (trigger === '#') {
    if (!gid) return []
    for (const g of sidebar(s, gid))
      for (const c of g.channels)
        if ((c.type === 0 || c.type === 5 || c.type === 15) && hit(c.name)) out.push({ key: c.id, label: c.name ?? '', sub: g.category?.name, insert: `#${c.name}`, syntax: `<#${c.id}>`, kind: 'channel' })
    return out.slice(0, 10)
  }
  const ids = gid ? Object.keys(s.members[gid] ?? {}) : [...(channel.recipients ?? []).map((u) => u.id), s.me?.id ?? '']
  for (const id of ids) {
    const u = s.users[id]
    const nick = gid ? s.members[gid]?.[id]?.nick : null
    if (u && hit(u.username, u.global_name, nick)) out.push({ key: id, label: nick || displayName(u), sub: u.username, insert: `@${u.username}`, syntax: `<@${id}>`, kind: 'user' })
  }
  out.sort((a, b) => a.label.localeCompare(b.label))
  const guild = gid ? s.guilds[gid] : undefined
  const everyone = has(perms, P.MENTION_EVERYONE)
  if (guild) {
    for (const r of guild.roles)
      if (r.id !== guild.id && (r.mentionable || everyone) && hit(r.name)) out.push({ key: r.id, label: r.name, sub: t('Role'), color: textColorOf(r.color), insert: `@${r.name}`, syntax: `<@&${r.id}>`, kind: 'role' })
    if (everyone)
      for (const [name, sub] of [['everyone', t('Notify everyone who can see this channel.')], ['here', t('Notify everyone online who can see this channel.')]])
        if (hit(name)) out.push({ key: name, label: `@${name}`, sub, insert: `@${name}`, syntax: `@${name}`, kind: 'special' })
  }
  if (hit('silent')) {
    out.push({
      key: 'silent',
      label: '@silent',
      sub: t('Send without notification pings or sounds.'),
      insert: '@silent',
      syntax: '@silent',
      kind: 'special',
    })
  }
  return out.slice(0, 10)
}

if (import.meta.env.DEV) {
  const u = (id: string, username: string) => ({ id, username, discriminator: '0', global_name: null, avatar: null })
  const s = { members: { g: { 1: {}, 2: {}, 3: {} } }, users: { 1: u('1', 'bob'), 2: u('2', 'Bobby'), 3: u('3', 'bobby') } } as unknown as State
  const ch = { id: 'c', type: 0, guild_id: 'g', last_message_id: null } as Channel
  console.assert(resolveMentions(s, ch, 'hi @Bob and @bobby, mail a@bob `@bob` <@1>') === 'hi <@1> and @bobby, mail a@bob `@bob` <@1>', 'mention resolution')
}
