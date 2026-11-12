import { api, ApiError, qs, upload } from './api'
import { toastError } from './components/dialogs'
import { sendOp } from './gateway'
import { bypassesSlowmode } from './permissions'
import { t } from './i18n'
import { navigate } from './router'
import { permsOf } from './selectors'
import { apply, emojiKey, getState, mergeSettings, replaceToken, setMyVotes, setState } from './store'
import * as E from './e2ee/session'
import type {
  Activity, Application, AuditLog, AuthSession, AutoModRule, Channel, ChannelCanvas, CommandIndex, CustomStatus, Draft, Emoji, FavoriteGif, Gif, Guild, GuildAnalytics, GuildOnboarding, GuildPayload, Invite, Member,
  MemberVerification, Message, MessageEdit, OnboardingPrompt, Profile, Role, ScheduledEvent, Snippet, Sound, StageInstance, Status, Sticker, ThreadMember, User, UserGuildSettings, UserSettings,
  Webhook, WelcomeScreen, GuildSnapshot, GuildTemplate, SavedMessage, ScheduledMessage, WatchSession,
} from './types'

const PAGE = 50
/** A list answer whose entries are objects with an id (or `ok`); a node answer of another shape counts as refused, like one
 *  its boundary refused (instances/registry.ts checks ids and fields, not the shape of a whole answer). */
function rows<T>(x: T[], ok = (v: any) => typeof v?.id === 'string'): T[] {
  if (Array.isArray(x) && x.every(ok)) return x
  throw new ApiError(0, null)
}
const sortById = (list: Message[]) => [...list].sort((a, b) => (a.id.length - b.id.length) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

export async function loadMessages(channelId: string, before?: string) {
  // Mark as loaded first so live MESSAGE_CREATEs during the fetch are kept and merged.
  if (!before && !getState().messages[channelId]) setState((s) => ({ messages: { ...s.messages, [channelId]: [] } }))
  const page = rows(await api<Message[]>(`/channels/${channelId}/messages?limit=${PAGE}${before ? `&before=${before}` : ''}`))
  setState((s) => {
    const list = s.messages[channelId] ?? []
    const ids = new Set(list.map((m) => m.id))
    return {
      messages: { ...s.messages, [channelId]: [...sortById(page).filter((m) => !ids.has(m.id)), ...list] },
      hasMore: { ...s.hasMore, [channelId]: page.length === PAGE },
    }
  })
}

/** Replaces the loaded window with the messages around `messageId` (search results, replies not loaded yet), then scrolls to it. */
export async function loadAround(channelId: string, messageId: string) {
  const page = sortById(rows(await api<Message[]>(`/channels/${channelId}/messages?limit=${PAGE}&around=${messageId}`)))
  const last = getState().channels[channelId]?.last_message_id
  setState((s) => ({
    messages: { ...s.messages, [channelId]: page },
    hasMore: { ...s.hasMore, [channelId]: page.length > 0 },
    hasNewer: { ...s.hasNewer, [channelId]: !!last && !page.some((m) => m.id === last) },
    jump: { channelId, messageId },
  }))
}

/** Loads the page after the newest loaded message while a jumped-to window is shown. */
export async function loadNewer(channelId: string) {
  const list = getState().messages[channelId]
  const after = list?.filter((m) => !m.pending && !m.failed).at(-1)?.id
  if (!after) return
  const page = sortById(rows(await api<Message[]>(`/channels/${channelId}/messages?limit=${PAGE}&after=${after}`)))
  setState((s) => {
    const cur = s.messages[channelId] ?? []
    const ids = new Set(cur.map((m) => m.id))
    return {
      messages: { ...s.messages, [channelId]: [...cur, ...page.filter((m) => !ids.has(m.id))] },
      hasNewer: { ...s.hasNewer, [channelId]: page.length === PAGE },
    }
  })
}

/** "Jump to Present": drops the jumped-to window and loads the latest page. */
export function jumpToPresent(channelId: string) {
  setState((s) => ({ messages: Object.fromEntries(Object.entries(s.messages).filter(([k]) => k !== channelId)), hasNewer: { ...s.hasNewer, [channelId]: false } }))
  return loadMessages(channelId)
}

/** Opens a message: scrolls to it when loaded, otherwise loads the messages around it first. Navigates to its channel when needed. */
export async function openMessage(channelId: string, messageId: string, guildId?: string) {
  let ch: Channel | undefined = getState().channels[channelId]
  if (!ch) {
    ch = await api<Channel>(`/channels/${channelId}`).catch(() => undefined)
    if (ch) apply(ch.thread_metadata ? 'THREAD_CREATE' : 'CHANNEL_CREATE', ch)
  }
  const gId = guildId ?? ch?.guild_id ?? '@me'
  const mainId = ch?.thread_metadata && ch.parent_id && location.pathname !== `/channels/${gId}/${channelId}` ? ch.parent_id : channelId
  const path = `/channels/${gId}/${mainId}`
  if (location.pathname !== path) navigate(path)
  if (ch?.thread_metadata && mainId !== channelId) setState({ panel: { kind: 'thread', channelId } })
  setState({ showNav: false })
  if (getState().messages[channelId]?.some((m) => m.id === messageId)) return setState({ jump: { channelId, messageId } })
  return loadAround(channelId, messageId).catch((e: Error) => toastError(e))
}

const nonce = () => String(Date.now()) + String(Math.floor(Math.random() * 1e6)).padStart(6, '0')

/** Starts the slowmode countdown after a send (or from a 429's retry_after). */
function startCooldown(ch: Channel, seconds?: number) {
  const rate = seconds ?? ch.rate_limit_per_user ?? 0
  if (!rate || (seconds === undefined && bypassesSlowmode(permsOf(getState(), ch.guild_id, ch)))) return
  setState((s) => ({ slowmode: { ...s.slowmode, [ch.id]: Date.now() + rate * 1000 } }))
}

export type SendExtra = { flags?: number; sticker_ids?: string[]; poll?: unknown; message_reference?: Record<string, unknown>; attachments?: Record<string, unknown>[] }

/** Posts a message: JSON, or multipart with payload_json and files[n] plus per-file `attachments` metadata (alt text, spoiler names, voice data). */
async function post(ch: Channel, payload: Record<string, unknown>, files: { file: Blob; name: string }[], onProgress?: (p: number) => void) {
  if (!payload.e2ee_envelope) await E.refusePlain(ch) // a DM this device saw encrypted never gets plain text again
  try {
    let real: Message
    if (files.length) {
      const form = new FormData()
      form.append('payload_json', JSON.stringify(payload))
      files.forEach((f, i) => form.append(`files[${i}]`, f.file, f.name))
      real = await upload<Message>(`/channels/${ch.id}/messages`, form, onProgress)
    } else real = await api<Message>(`/channels/${ch.id}/messages`, { method: 'POST', body: payload })
    startCooldown(ch)
    return real
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) startCooldown(ch, e.retryAfter || ch.rate_limit_per_user || 1)
    throw e
  }
}

const fileName = (d: Draft) => (d.spoiler && !d.file.name.startsWith('SPOILER_') ? `SPOILER_${d.file.name}` : d.file.name)

export async function sendMessage(ch: Channel, content: string, drafts: Draft[] = [], reply?: { messageId: string }) {
  const n = nonce()
  const id = `pending-${n}`
  const s = getState()
  const ref = reply ? s.messages[ch.id]?.find((m) => m.id === reply.messageId) : undefined
  const temp: Message = {
    id, nonce: n, type: reply ? 19 : 0, channel_id: ch.id, guild_id: ch.guild_id, author: s.me!, content, timestamp: new Date().toISOString(),
    edited_timestamp: null, mentions: [], attachments: [], embeds: [], pinned: false, pending: true, files: drafts,
    ...(reply && { message_reference: { message_id: reply.messageId }, referenced_message: ref ?? null }),
  }
  apply('MESSAGE_CREATE', temp)
  const payload = {
    content, nonce: n,
    ...(reply && { message_reference: { message_id: reply.messageId } }),
    ...(drafts.length && { attachments: drafts.map((d, i) => ({ id: String(i), filename: fileName(d), ...(d.description.trim() && { description: d.description.trim() }) })) }),
  }
  const progress = (p: number) => apply('MESSAGE_UPDATE', { id, channel_id: ch.id, progress: p })
  try {
    let real: Message
    for (let attempt = 0; ; attempt++) {
      try {
        const key = await E.sendKey(ch, attempt > 0) // encrypted DM: null when the conversation stays plain
        if (!key) {
          real = await post(ch, payload, drafts.map((d) => ({ file: d.file, name: fileName(d) })), progress)
          break
        }
        // names, types and sizes go inside the payload; the server gets file.bin ciphertext only
        const ups = await Promise.all(drafts.map((d, i) => E.encryptUpload(d.file, fileName(d), i)))
        const files = ups.map((u) => u.ref)
        const e2ee_envelope = await E.sealPayload(ch, key, content, files)
        real = await post(ch, {
          nonce: n, e2ee_envelope, ...(reply && { message_reference: { message_id: reply.messageId } }),
          ...(ups.length && { attachments: ups.map((_, i) => ({ id: String(i), filename: 'file.bin' })) }),
        }, ups.map((u) => ({ file: u.blob, name: 'file.bin' })), progress)
        E.remember(real, content, files)
        break
      } catch (e) {
        if (attempt === 0 && e instanceof ApiError && e.status === 409) continue // a newer key or a member left: load and try once more
        throw e
      }
    }
    apply('MESSAGE_DELETE', { id, channel_id: ch.id }) // in case the server did not echo the nonce
    apply('MESSAGE_CREATE', real) // the server marks the channel read for the author
  } catch (e) {
    // Keep the text on screen so nothing typed is lost.
    apply('MESSAGE_UPDATE', { id, channel_id: ch.id, pending: false, failed: true })
    if (!(e instanceof ApiError) || e.status) toastError(e) // the server's reason (slowmode, AutoMod, timeout…) or why it could not be encrypted
  }
}

/** Messages without an optimistic copy (stickers, polls, forwards, voice messages). */
async function sendPlain(ch: Channel, body: SendExtra & { content?: string }, files: { file: Blob; name: string }[] = []) {
  const real = await post(ch, { ...body, nonce: nonce() }, files)
  apply('MESSAGE_CREATE', real)
  return real
}

export const sendSticker = (ch: Channel, stickerId: string) => sendPlain(ch, { sticker_ids: [stickerId] })
export const sendPoll = (ch: Channel, poll: {
  question: { text: string }
  answers: { poll_media: { text: string; emoji?: { id?: string; name?: string } } }[]
  duration: number
  allow_multiselect: boolean
  anonymous?: boolean
  allowed_role_ids?: string[]
  correct_answer_id?: number | null
}) =>
  sendPlain(ch, { poll: { ...poll, layout_type: 1 } })
export const IS_VOICE_MESSAGE = 1 << 13
export const sendVoiceMessage = (ch: Channel, blob: Blob, durationSecs: number, waveform: string) => {
  const name = `voice-message.${blob.type.includes('ogg') ? 'ogg' : 'webm'}`
  return sendPlain(ch, { flags: IS_VOICE_MESSAGE, attachments: [{ id: '0', filename: name, duration_secs: durationSecs, waveform }] }, [{ file: blob, name }])
}
/** Forwarding (message_reference.type 1); the server copies the message into message_snapshots. */
export const forwardMessage = (m: Message, dest: Channel, comment?: string) =>
  sendPlain(dest, { message_reference: { type: 1, message_id: m.id, channel_id: m.channel_id, ...(m.guild_id && { guild_id: m.guild_id }) } }).then(
    async (r) => (comment?.trim() ? sendPlain(dest, { content: comment.trim() }) : r),
  )

/** Retries a failed optimistic message. */
export function resend(m: Message) {
  apply('MESSAGE_DELETE', { id: m.id, channel_id: m.channel_id })
  const ch = getState().channels[m.channel_id]
  if (ch) void sendMessage(ch, m.content, m.files, m.message_reference ? { messageId: m.message_reference.message_id } : undefined)
}

export async function editMessage(m: Message, content: string) {
  const ch = getState().channels[m.channel_id]
  await E.refusePlain(ch)
  if (m.e2ee_envelope || E.isEncrypted(ch)) { // a new envelope with the same files; the server keeps no history
    const key = await E.sendKey(ch)
    if (!key) throw new Error(t('Cannot encrypt for this conversation right now. Try again.'))
    const prev = m.e2ee_envelope ? await E.decrypt(m) : null // the files ride along inside the payload: never drop them
    if (prev && prev.state !== 'ok') throw new Error(t('This message cannot be decrypted here, so it cannot be edited.'))
    const files = prev?.state === 'ok' ? prev.files : []
    const r = await api<Message>(`/channels/${m.channel_id}/messages/${m.id}`, { method: 'PATCH', body: { e2ee_envelope: await E.sealPayload(ch, key, content, files) } })
    E.remember(r, content, files)
    return apply('MESSAGE_UPDATE', r)
  }
  return api<Message>(`/channels/${m.channel_id}/messages/${m.id}`, { method: 'PATCH', body: { content } }).then((r) => apply('MESSAGE_UPDATE', r))
}

export const SUPPRESS_EMBEDS = 1 << 2
/** Removes all embeds from a message (author or MANAGE_MESSAGES). */
export const suppressEmbeds = (m: Message) =>
  api<Message>(`/channels/${m.channel_id}/messages/${m.id}`, { method: 'PATCH', body: { flags: (m.flags ?? 0) | SUPPRESS_EMBEDS } }).then((r) =>
    apply('MESSAGE_UPDATE', r ?? { id: m.id, channel_id: m.channel_id, flags: (m.flags ?? 0) | SUPPRESS_EMBEDS, embeds: [] }),
  )

export const crosspost = (m: Message) =>
  api<Message>(`/channels/${m.channel_id}/messages/${m.id}/crosspost`, { method: 'POST' }).then((r) => apply('MESSAGE_UPDATE', r ?? { id: m.id, channel_id: m.channel_id, flags: (m.flags ?? 0) | 1 }))
export const followChannel = (channelId: string, webhookChannelId: string) =>
  api(`/channels/${channelId}/followers`, { method: 'POST', body: { webhook_channel_id: webhookChannelId } })

export async function deleteMessage(m: Message) {
  if (!m.failed) await api(`/channels/${m.channel_id}/messages/${m.id}`, { method: 'DELETE' })
  apply('MESSAGE_DELETE', { id: m.id, channel_id: m.channel_id })
}

export const sendTyping = (channelId: string) => api(`/channels/${channelId}/typing`, { method: 'POST' }).catch(() => {})

export type EmojiRef = { id: string | null; name: string; animated?: boolean }
/** Route form of an emoji: the character, or `name:id` for custom emoji. */
export const emojiRoute = (e: EmojiRef) => encodeURIComponent(e.id ? `${e.name}:${e.id}` : e.name)

export async function toggleReaction(m: Message, emoji: EmojiRef) {
  const me = getState().me!
  const mine = m.reactions?.find((r) => emojiKey(r.emoji) === emojiKey(emoji))?.me
  const ev = { user_id: me.id, channel_id: m.channel_id, message_id: m.id, guild_id: m.guild_id, emoji }
  apply(mine ? 'MESSAGE_REACTION_REMOVE' : 'MESSAGE_REACTION_ADD', ev) // optimistic; the echo is ignored
  try {
    await api(`/channels/${m.channel_id}/messages/${m.id}/reactions/${emojiRoute(emoji)}/@me`, { method: mine ? 'DELETE' : 'PUT' })
  } catch (e) {
    apply(mine ? 'MESSAGE_REACTION_ADD' : 'MESSAGE_REACTION_REMOVE', ev)
    throw e
  }
}

export const setPinned = (m: Message, pinned: boolean) =>
  api(`/channels/${m.channel_id}/pins/${m.id}`, { method: pinned ? 'PUT' : 'DELETE' }).then(() => apply('MESSAGE_UPDATE', { id: m.id, channel_id: m.channel_id, pinned }))

// Polls (user docs: PUT .../polls/:id/answers/@me; official: voters list and expire).
export async function votePoll(m: Message, answerIds: number[]) {
  const before = m.poll!
  apply('MESSAGE_UPDATE', { id: m.id, channel_id: m.channel_id, poll: setMyVotes(before, answerIds) })
  try {
    await api(`/channels/${m.channel_id}/polls/${m.id}/answers/@me`, { method: 'PUT', body: { answer_ids: answerIds } })
  } catch (e) {
    apply('MESSAGE_UPDATE', { id: m.id, channel_id: m.channel_id, poll: before })
    throw e
  }
}
export const endPoll = (m: Message) => api<Message>(`/channels/${m.channel_id}/polls/${m.id}/expire`, { method: 'POST' }).then((r) => r && apply('MESSAGE_UPDATE', r))
export const pollVoters = (m: Message, answerId: number) => api<{ users: User[] }>(`/channels/${m.channel_id}/polls/${m.id}/answers/${answerId}?limit=100`).then((r) => rows(r.users))

const acked: Record<string, string> = {}
/** Marks a channel read up to `messageId` (deduplicated per channel). */
export function ackMessage(channelId: string, messageId: string) {
  if (acked[channelId] === messageId) return
  acked[channelId] = messageId
  apply('MESSAGE_ACK', { channel_id: channelId, message_id: messageId })
  api(`/channels/${channelId}/messages/${messageId}/ack`, { method: 'POST', body: { token: null } }).catch(() => delete acked[channelId])
}

export async function loadMembers(guildId: string) {
  const list = rows(await api<Member[]>(`/guilds/${guildId}/members?limit=1000`), (m) => typeof m?.user?.id === 'string')
  setState((s) => ({
    members: { ...s.members, [guildId]: Object.fromEntries(list.map((m) => [m.user.id, m])) },
    membersLoaded: { ...s.membersLoaded, [guildId]: true },
    users: { ...s.users, ...Object.fromEntries(list.map((m) => [m.user.id, m.user])) },
  }))
}

/** After joining: the welcome screen (WELCOME_SCREEN_ENABLED) and, for pending members, the rules screening. */
export function enterGuild(g: GuildPayload, channelId?: string, joined = false) {
  apply('GUILD_CREATE', g)
  navigate(`/channels/${g.id}${channelId ? `/${channelId}` : ''}`)
  const me = getState().me
  const pending = !!g.members?.find((m) => m?.user?.id === me?.id)?.pending
  if (joined && g.features?.includes('WELCOME_SCREEN_ENABLED')) setState({ modal: { kind: 'welcome', guildId: g.id } })
  else if (joined && pending) setState({ modal: { kind: 'rules', guildId: g.id } })
}

export const createGuild = (name: string) => api<GuildPayload>('/guilds', { method: 'POST', body: { name } }).then((g) => enterGuild(g, g.system_channel_id ?? undefined))
export const joinInvite = (code: string, channelId?: string) =>
  api<GuildPayload>(`/invites/${encodeURIComponent(code)}`, { method: 'POST' }).then((g) => enterGuild(g, channelId, true))

export async function openDm(userId: string) {
  const c = await api<Channel>('/users/@me/channels', { method: 'POST', body: { recipient_id: userId } })
  apply('CHANNEL_CREATE', c)
  setState({ showNav: false })
  navigate(`/channels/@me/${c.id}`)
  return c
}

export async function createChannel(guildId: string, name: string, type: 0 | 2 | 4 | 5 | 13 | 15 | 16 = 0, parentId?: string | null) {
  const c = await api<Channel>(`/guilds/${guildId}/channels`, { method: 'POST', body: { name, type, ...(parentId && { parent_id: parentId }) } })
  apply('CHANNEL_CREATE', c)
  if (type !== 4) navigate(`/channels/${guildId}/${c.id}`)
}

export const updateChannel = (id: string, body: Partial<Channel>) =>
  api<Channel>(`/channels/${id}`, { method: 'PATCH', body }).then((c) => apply(c.thread_metadata ? 'THREAD_UPDATE' : 'CHANNEL_UPDATE', c))

export async function deleteChannel(c: Channel) {
  await api(`/channels/${c.id}`, { method: 'DELETE' })
  apply('CHANNEL_DELETE', c)
}

export async function cloneChannel(channelId: string, name?: string) {
  const c = await api<Channel>(`/channels/${channelId}/clone`, { method: 'POST', body: name ? { name } : {} })
  apply('CHANNEL_CREATE', c)
  return c
}

/** Reorders channels; applied locally first so drag and drop feels instant. */
export async function moveChannels(guildId: string, changes: { id: string; position: number; parent_id?: string | null }[]) {
  const before = changes.map((c) => getState().channels[c.id])
  changes.forEach((c) => apply('CHANNEL_UPDATE', { ...getState().channels[c.id], ...c }))
  try {
    await api(`/guilds/${guildId}/channels`, { method: 'PATCH', body: changes })
  } catch (e) {
    before.forEach((c) => c && apply('CHANNEL_UPDATE', c))
    throw e
  }
}

export const createInvite = (channelId: string) => api<Invite>(`/channels/${channelId}/invites`, { method: 'POST', body: { max_age: 86400 } })

/** `code`: the owner's 2FA or backup code, which deleting a server needs (as a transfer does) when 2FA is on. */
export async function leaveGuild(guildId: string, owner: boolean, code?: string) {
  await api(owner ? `/guilds/${guildId}` : `/users/@me/guilds/${guildId}`, { method: 'DELETE', ...(code && { body: { code } }) })
  apply('GUILD_DELETE', { id: guildId })
  navigate('/channels/@me')
}

export const patchGuild = (guildId: string, body: Record<string, unknown>) =>
  api<GuildPayload>(`/guilds/${guildId}`, { method: 'PATCH', body }).then((g) => (apply('GUILD_UPDATE', g), g))

type MemberPatch = Partial<Member> & { channel_id?: string | null }
export const patchMember = (guildId: string, userId: string, body: MemberPatch, reason?: string) =>
  api<Member>(`/guilds/${guildId}/members/${userId}`, { method: 'PATCH', body, reason }).then((m) => m && apply('GUILD_MEMBER_UPDATE', { ...m, guild_id: guildId }))
export const setMyNick = (guildId: string, nick: string | null) =>
  api<Member>(`/guilds/${guildId}/members/@me`, { method: 'PATCH', body: { nick } }).then((m) => m && apply('GUILD_MEMBER_UPDATE', { ...m, guild_id: guildId }))
export const kick = (guildId: string, userId: string, reason?: string) => api(`/guilds/${guildId}/members/${userId}`, { method: 'DELETE', reason })
export const ban = (guildId: string, userId: string, reason: string, deleteSeconds: number) =>
  api(`/guilds/${guildId}/bans/${userId}`, { method: 'PUT', body: { delete_message_seconds: deleteSeconds }, reason })
/** Timeout (`until` ISO, max 28 days) or remove it with null. */
export const timeoutMember = (guildId: string, userId: string, until: string | null, reason?: string) =>
  patchMember(guildId, userId, { communication_disabled_until: until }, reason)

export const createRole = (guildId: string) =>
  api<Role>(`/guilds/${guildId}/roles`, { method: 'POST', body: {} }).then((role) => (apply('GUILD_ROLE_CREATE', { guild_id: guildId, role }), role))
export const updateRole = (guildId: string, roleId: string, body: Partial<Role>) =>
  api<Role>(`/guilds/${guildId}/roles/${roleId}`, { method: 'PATCH', body }).then((role) => apply('GUILD_ROLE_UPDATE', { guild_id: guildId, role }))
export const deleteRole = (guildId: string, roleId: string) =>
  api(`/guilds/${guildId}/roles/${roleId}`, { method: 'DELETE' }).then(() => apply('GUILD_ROLE_DELETE', { guild_id: guildId, role_id: roleId }))
export const reorderRoles = (guildId: string, list: { id: string; position: number }[]) =>
  api<Role[]>(`/guilds/${guildId}/roles`, { method: 'PATCH', body: list }).then((roles) => roles && rows(roles).forEach((role) => apply('GUILD_ROLE_UPDATE', { guild_id: guildId, role })))

export function setStatus(status: Status) {
  const me = getState().me
  if (me) apply('PRESENCE_UPDATE', { user: { id: me.id }, status })
  void patchSettings({ status }) // stores the choice locally before its request, so sendPresence sends it
  sendPresence()
}

let afk = false
/** Op 3 with the status, the custom status as a type 4 activity and the AFK flag (CONTRACT-v4: afk after 2 min without input). */
export function sendPresence(nextAfk = afk) {
  afk = nextAfk
  const s = getState()
  // the chosen status, not the shown one: the server shows 'idle' while away and 'offline' when invisible
  const status = s.settings.status || 'online'
  sendOp(3, { status, since: afk ? Date.now() : 0, activities: myActivities(), afk })
}
export function myActivities(): Activity[] {
  const { settings: { custom_status: cs }, game } = getState()
  // The game detected by the desktop app rides along as a Playing activity (CONTRACT-v5 section 3).
  const playing: Activity[] = game ? [{ type: 0, name: game.name, timestamps: { start: game.start } }] : []
  if (!cs || (!cs.text && !cs.emoji_name && !cs.emoji_id) || (cs.expires_at && Date.parse(cs.expires_at) <= Date.now())) return playing
  const emoji = cs.emoji_id ? { id: cs.emoji_id, name: cs.emoji_name ?? '' } : cs.emoji_name ? { name: cs.emoji_name } : null
  return [{ type: 4, name: 'Custom Status', state: cs.text, ...(emoji && { emoji }) }, ...playing]
}
/** Our detected game changed: shown locally and sent in op 3. */
export function setGame(game: { name: string; start: number } | null) {
  const me = getState().me
  setState({ game })
  if (me) apply('PRESENCE_UPDATE', { user: { id: me.id }, status: getState().presences[me.id] ?? 'online', activities: myActivities() })
  sendPresence()
}
/** Custom status: persisted in settings (with expiry) and sent as a type 4 activity. */
export async function setCustomStatus(cs: CustomStatus | null) {
  const me = getState().me
  mergeSettings({ custom_status: cs })
  if (me) apply('PRESENCE_UPDATE', { user: { id: me.id }, status: getState().presences[me.id] ?? 'online', activities: myActivities() })
  sendPresence()
  await patchSettings({ custom_status: cs })
}

export const addFriend = (username: string) => api('/users/@me/relationships', { method: 'POST', body: { username } })
export const acceptFriend = (id: string) => api(`/users/@me/relationships/${id}`, { method: 'PUT', body: {} })
export const removeRelationship = (id: string) => api(`/users/@me/relationships/${id}`, { method: 'DELETE' })

// ---------- Threads (channel.mdx thread endpoints) ----------
export type ThreadCreate = { name: string; auto_archive_duration?: number; type?: 10 | 11 | 12; invitable?: boolean; rate_limit_per_user?: number; applied_tags?: string[]; message?: { content: string } }
const addThread = (t: Channel) => (apply('THREAD_CREATE', t), t)
export const startThreadFromMessage = (m: Message, name: string, autoArchive: number) =>
  api<Channel>(`/channels/${m.channel_id}/messages/${m.id}/threads`, { method: 'POST', body: { name, auto_archive_duration: autoArchive } }).then((t) => {
    apply('MESSAGE_UPDATE', { id: m.id, channel_id: m.channel_id, thread: t })
    return addThread(t)
  })
/** Standalone thread, or a forum post when `message` is given. */
export const startThread = (channelId: string, body: ThreadCreate) =>
  api<Channel & { message?: Message }>(`/channels/${channelId}/threads`, { method: 'POST', body }).then(addThread)
export const joinThread = (t: Channel) =>
  api(`/channels/${t.id}/thread-members/@me`, { method: 'PUT' }).then(() => apply('THREAD_MEMBER_UPDATE', { id: t.id, user_id: getState().me?.id, join_timestamp: new Date().toISOString(), flags: 0 }))
export const leaveThread = (t: Channel) =>
  api(`/channels/${t.id}/thread-members/@me`, { method: 'DELETE' }).then(() => apply('THREAD_UPDATE', { ...getState().channels[t.id], member: undefined }))
export const addThreadMember = (threadId: string, userId: string) => api(`/channels/${threadId}/thread-members/${userId}`, { method: 'PUT' })
export const removeThreadMember = (threadId: string, userId: string) => api(`/channels/${threadId}/thread-members/${userId}`, { method: 'DELETE' })
export const listThreadMembers = (threadId: string) => api<(ThreadMember & { member?: Member })[]>(`/channels/${threadId}/thread-members?with_member=true`)
/** Archived threads of a channel (public, or private ones you can see). Fills the store so they open like any thread. */
export async function archivedThreads(channelId: string, kind: 'public' | 'private', before?: string) {
  const r = await api<{ threads: Channel[]; members: ThreadMember[]; has_more: boolean }>(`/channels/${channelId}/threads/archived/${kind}${qs({ before, limit: 50 })}`)
  apply('THREAD_LIST_SYNC', { guild_id: getState().channels[channelId]?.guild_id, threads: rows(r.threads), members: rows(r.members) })
  return r
}

// ---------- Search (user docs) ----------
export type SearchParams = Record<string, string | string[] | number | boolean | undefined>
export type SearchResult = { total_results: number; messages: Message[][]; threads?: Channel[]; members?: ThreadMember[] }
export const searchMessages = (scope: { guildId?: string; channelId?: string }, params: SearchParams) =>
  api<SearchResult>(scope.guildId ? `/guilds/${scope.guildId}/messages/search${qs(params as never)}` : `/channels/${scope.channelId}/messages/search${qs(params as never)}`).then((r) => {
    if (r?.threads?.length) apply('THREAD_LIST_SYNC', { guild_id: scope.guildId, threads: rows(r.threads), members: rows(r.members ?? []) })
    return r
  })

// ---------- Stage (stage-instance.mdx, voice.mdx) ----------
export const createStage = (channelId: string, topic: string) =>
  api<StageInstance>('/stage-instances', { method: 'POST', body: { channel_id: channelId, topic, privacy_level: 2 } }).then((i) => apply('STAGE_INSTANCE_CREATE', i))
export const updateStage = (channelId: string, topic: string) =>
  api<StageInstance>(`/stage-instances/${channelId}`, { method: 'PATCH', body: { topic } }).then((i) => apply('STAGE_INSTANCE_UPDATE', i))
export const endStage = (channelId: string) =>
  api(`/stage-instances/${channelId}`, { method: 'DELETE' }).then(() => apply('STAGE_INSTANCE_DELETE', { channel_id: channelId }))
/** Raise or lower your hand (`request_to_speak_timestamp`), or move yourself between speakers and audience (`suppress`). */
export const setMyStageState = (guildId: string, channelId: string, body: { suppress?: boolean; request_to_speak_timestamp?: string | null }) =>
  api(`/guilds/${guildId}/voice-states/@me`, { method: 'PATCH', body: { channel_id: channelId, ...body } })
/** Moderators: invite to speak (`suppress: false`) or move to the audience (`suppress: true`). */
export const setStageSpeaker = (guildId: string, channelId: string, userId: string, speaker: boolean) =>
  api(`/guilds/${guildId}/voice-states/${userId}`, { method: 'PATCH', body: { channel_id: channelId, suppress: !speaker } })

// ---------- Scheduled events ----------
export type EventBody = Partial<Pick<ScheduledEvent, 'name' | 'description' | 'scheduled_start_time' | 'scheduled_end_time' | 'entity_type' | 'channel_id' | 'entity_metadata' | 'status' | 'privacy_level'>> & { image?: string | null }
export const loadEvents = (guildId: string) =>
  api<ScheduledEvent[]>(`/guilds/${guildId}/scheduled-events?with_user_count=true`).then((list) => setState((s) => ({
    events: { ...Object.fromEntries(Object.entries(s.events).filter(([, e]) => e.guild_id !== guildId)), ...Object.fromEntries(rows(list).map((e) => [e.id, e])) },
  })))
export const loadMyEventSubs = (guildId: string) =>
  api<{ guild_scheduled_event_id: string; response?: number }[]>(`/users/@me/scheduled-events${qs({ guild_ids: guildId })}`).then((list) =>
    setState((s) => ({ eventSubs: { ...s.eventSubs, ...Object.fromEntries(list.filter((x) => x.response !== 0).map((x) => [x.guild_scheduled_event_id, true as const])) } })),
  )
export const createEvent = (guildId: string, body: EventBody) =>
  api<ScheduledEvent>(`/guilds/${guildId}/scheduled-events`, { method: 'POST', body: { privacy_level: 2, ...body } }).then((e) => (apply('GUILD_SCHEDULED_EVENT_CREATE', e), e))
export const updateEvent = (e: ScheduledEvent, body: EventBody) =>
  api<ScheduledEvent>(`/guilds/${e.guild_id}/scheduled-events/${e.id}`, { method: 'PATCH', body }).then((x) => (apply('GUILD_SCHEDULED_EVENT_UPDATE', x), x))
export const deleteEvent = (e: ScheduledEvent) =>
  api(`/guilds/${e.guild_id}/scheduled-events/${e.id}`, { method: 'DELETE' }).then(() => apply('GUILD_SCHEDULED_EVENT_DELETE', e))
export async function setInterested(e: ScheduledEvent, on: boolean) {
  const ev = { guild_id: e.guild_id, guild_scheduled_event_id: e.id, user_id: getState().me!.id }
  apply(on ? 'GUILD_SCHEDULED_EVENT_USER_ADD' : 'GUILD_SCHEDULED_EVENT_USER_REMOVE', ev)
  try {
    await api(`/guilds/${e.guild_id}/scheduled-events/${e.id}/users/@me`, { method: on ? 'PUT' : 'DELETE' })
  } catch (err) {
    apply(on ? 'GUILD_SCHEDULED_EVENT_USER_REMOVE' : 'GUILD_SCHEDULED_EVENT_USER_ADD', ev)
    throw err
  }
}
export const eventUsers = (e: ScheduledEvent) =>
  api<{ user: User; member?: Member }[]>(`/guilds/${e.guild_id}/scheduled-events/${e.id}/users?limit=100&with_member=true`)

// ---------- Moderation and settings ----------
export const auditLog = (guildId: string, params: { user_id?: string; action_type?: number; before?: string; limit?: number }) =>
  api<AuditLog>(`/guilds/${guildId}/audit-logs${qs({ limit: 50, ...params })}`)
export const autoModRules = (guildId: string) => api<AutoModRule[]>(`/guilds/${guildId}/auto-moderation/rules`)
export const saveAutoModRule = (guildId: string, rule: Partial<AutoModRule>) =>
  rule.id
    ? api<AutoModRule>(`/guilds/${guildId}/auto-moderation/rules/${rule.id}`, { method: 'PATCH', body: rule })
    : api<AutoModRule>(`/guilds/${guildId}/auto-moderation/rules`, { method: 'POST', body: rule })
export const deleteAutoModRule = (guildId: string, id: string) => api(`/guilds/${guildId}/auto-moderation/rules/${id}`, { method: 'DELETE' })

export const guildWebhooks = (guildId: string) => api<Webhook[]>(`/guilds/${guildId}/webhooks`)
export const createWebhook = (channelId: string, name: string) => api<Webhook>(`/channels/${channelId}/webhooks`, { method: 'POST', body: { name } })
export const updateWebhook = (id: string, body: { name?: string; avatar?: string | null; channel_id?: string }) => api<Webhook>(`/webhooks/${id}`, { method: 'PATCH', body })
export const deleteWebhook = (id: string) => api(`/webhooks/${id}`, { method: 'DELETE' })

export const createEmoji = (guildId: string, name: string, image: string, roles: string[] = []) =>
  api<Emoji>(`/guilds/${guildId}/emojis`, { method: 'POST', body: { name, image, roles } })
export const updateEmoji = (guildId: string, id: string, body: { name?: string; roles?: string[] }) => api<Emoji>(`/guilds/${guildId}/emojis/${id}`, { method: 'PATCH', body })
export const deleteEmoji = (guildId: string, id: string) => api(`/guilds/${guildId}/emojis/${id}`, { method: 'DELETE' })
export function createSticker(guildId: string, file: File, name: string, tags: string, description: string) {
  const form = new FormData()
  form.append('name', name)
  form.append('tags', tags)
  form.append('description', description)
  form.append('file', file, file.name)
  return upload<Sticker>(`/guilds/${guildId}/stickers`, form)
}
export const updateSticker = (guildId: string, id: string, body: { name?: string; tags?: string; description?: string }) => api<Sticker>(`/guilds/${guildId}/stickers/${id}`, { method: 'PATCH', body })
export const deleteSticker = (guildId: string, id: string) => api(`/guilds/${guildId}/stickers/${id}`, { method: 'DELETE' })

export const loadSounds = (guildId: string) =>
  api<{ items: Sound[] }>(`/guilds/${guildId}/soundboard-sounds`)
    .then((r) => rows(r.items, (x) => typeof x?.sound_id === 'string')) // a sound's id is sound_id
    .then((items) => setState((s) => ({ sounds: { ...s.sounds, [guildId]: items } })))
export const createSound = (guildId: string, body: { name: string; sound: string; volume: number; emoji_name?: string | null; emoji_id?: string | null }) =>
  api<Sound>(`/guilds/${guildId}/soundboard-sounds`, { method: 'POST', body }).then((x) => (apply('GUILD_SOUNDBOARD_SOUND_CREATE', { ...x, guild_id: guildId }), x))
export const updateSound = (guildId: string, id: string, body: { name?: string; volume?: number; emoji_name?: string | null }) =>
  api<Sound>(`/guilds/${guildId}/soundboard-sounds/${id}`, { method: 'PATCH', body }).then((x) => (apply('GUILD_SOUNDBOARD_SOUND_UPDATE', { ...x, guild_id: guildId }), x))
export const deleteSound = (guildId: string, id: string) =>
  api(`/guilds/${guildId}/soundboard-sounds/${id}`, { method: 'DELETE' }).then(() => apply('GUILD_SOUNDBOARD_SOUND_DELETE', { guild_id: guildId, sound_id: id }))
export const sendSound = (channelId: string, sound: Sound, guildId: string) =>
  api(`/channels/${channelId}/send-soundboard-sound`, { method: 'POST', body: { sound_id: sound.sound_id, ...(sound.guild_id && sound.guild_id !== guildId && { source_guild_id: sound.guild_id }) } })

/** GIF search proxy; `null` when the server has no GIF provider (404), so the GIF tab hides. */
let gifsAvailable: boolean | undefined
export const gifsKnownMissing = () => gifsAvailable === false
export const gifsUnknown = () => gifsAvailable === undefined
export type GifCategory = { id: string; name: string; q: string }
export const DEFAULT_GIF_CATEGORIES: GifCategory[] = [
  { id: 'trending', name: 'Trending', q: '' },
  { id: 'happy', name: 'Happy', q: 'happy' },
  { id: 'sad', name: 'Sad', q: 'sad' },
  { id: 'applause', name: 'Applause', q: 'applause' },
  { id: 'dance', name: 'Dance', q: 'dance' },
  { id: 'cat', name: 'Cat', q: 'cat' },
  { id: 'anime', name: 'Anime', q: 'anime' },
  { id: 'gg', name: 'GG', q: 'gg' },
  { id: 'laugh', name: 'Laugh', q: 'laugh' },
  { id: 'excited', name: 'Excited', q: 'excited' },
  { id: 'shocked', name: 'Shocked', q: 'shocked' },
  { id: 'thumbsup', name: 'Thumbs Up', q: 'thumbs up' },
]

export async function gifCategories(): Promise<GifCategory[]> {
  try {
    const list = await api<GifCategory[]>('/gifs/categories')
    return list?.length ? list : DEFAULT_GIF_CATEGORIES
  } catch {
    return DEFAULT_GIF_CATEGORIES
  }
}

export async function gifs(q?: string): Promise<Gif[] | null> {
  if (gifsAvailable === false) return null
  try {
    const r = await api<Gif[]>(q ? `/gifs/search${qs({ q, limit: 30 })}` : `/gifs/trending${qs({ limit: 30 })}`)
    gifsAvailable = true
    return r
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return (gifsAvailable = false), null
    throw e
  }
}

/** Stars or un-stars a GIF (newest first, unique by url, at most 250): one item added or removed on the server, so devices
 * do not overwrite each other's list; synced by USER_SETTINGS_UPDATE. */
export async function toggleFavoriteGif(g: FavoriteGif) {
  const list = getState().settings.favorite_gifs ?? []
  const on = list.some((x) => x.url === g.url)
  mergeSettings({ favorite_gifs: on ? list.filter((x) => x.url !== g.url) : [g, ...list].slice(0, 250) })
  try {
    const r = await (on
      ? api<UserSettings>(`/users/@me/settings/favorite-gifs${qs({ url: g.url })}`, { method: 'DELETE' })
      : api<UserSettings>('/users/@me/settings/favorite-gifs', { method: 'PUT', body: g }))
    if (r && typeof r === 'object') mergeSettings(r)
  } catch (e) {
    if (e instanceof ApiError && e.status) toastError(e)
  }
}

export const getWelcomeScreen = (guildId: string) => api<WelcomeScreen>(`/guilds/${guildId}/welcome-screen`)
export const saveWelcomeScreen = (guildId: string, body: Partial<WelcomeScreen>) => api<WelcomeScreen>(`/guilds/${guildId}/welcome-screen`, { method: 'PATCH', body })
export const getMemberVerification = (guildId: string) => api<MemberVerification>(`/guilds/${guildId}/member-verification`)
export const saveMemberVerification = (guildId: string, body: Partial<MemberVerification> & { enabled?: boolean }) =>
  api<MemberVerification>(`/guilds/${guildId}/member-verification`, { method: 'PATCH', body })
/** Accept the rules: user docs' join request (PUT /requests/@me), or Cillhub's simple route if the server only has that one. */
export async function acceptRules(guildId: string, v: MemberVerification) {
  try {
    await api(`/guilds/${guildId}/requests/@me`, { method: 'PUT', body: { version: v.version, form_fields: v.form_fields.map((f) => ({ ...f, response: true })) } })
  } catch (e) {
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) throw e
    await api(`/guilds/${guildId}/members/@me/accept-rules`, { method: 'POST' })
  }
  const me = getState().me
  const m = me && getState().members[guildId]?.[me.id]
  if (m) apply('GUILD_MEMBER_UPDATE', { ...m, pending: false, guild_id: guildId })
}
export const getVanity = (guildId: string) => api<{ code: string | null; uses: number }>(`/guilds/${guildId}/vanity-url`)
export const saveVanity = (guildId: string, code: string | null) => api<{ code: string | null; uses: number }>(`/guilds/${guildId}/vanity-url`, { method: 'PATCH', body: { code } })

/** A forum post's starter message: its id equals the thread id (docs), fetched with `around` so no single-message route is needed. */
export const starterMessage = (threadId: string) =>
  api<Message[]>(`/channels/${threadId}/messages?limit=1&around=${threadId}`).then((l) => rows(l).find((m) => m.id === threadId) ?? l.at(-1) ?? null)

// ---------- v4: settings ----------
/** Settings are applied locally at once (theme, language) and saved to the server; USER_SETTINGS_UPDATE syncs other sessions. */
export async function patchSettings(patch: UserSettings) {
  mergeSettings(patch)
  try {
    const r = await api<UserSettings>('/users/@me/settings', { method: 'PATCH', body: patch })
    if (r && typeof r === 'object') mergeSettings(r)
  } catch (e) {
    if (e instanceof ApiError && e.status) toastError(e)
  }
}
export const loadSettings = () => api<UserSettings>('/users/@me/settings').then((r) => r && mergeSettings(r))

export async function patchGuildSettings(guildId: string, patch: Partial<Omit<UserGuildSettings, 'channel_overrides'>> & { channel_overrides?: Record<string, Partial<UserGuildSettings['channel_overrides'][number]>> }) {
  const s = getState()
  const old = s.guildSettings[guildId]
  const base: UserGuildSettings = old ?? { guild_id: guildId === '@me' ? null : guildId, message_notifications: (s.guilds[guildId] as { default_message_notifications?: number } | undefined)?.default_message_notifications ?? 0, suppress_everyone: false, suppress_roles: false, muted: false, mute_config: null, mobile_push: true, hide_muted_channels: false, channel_overrides: [] }
  const overrides = [...base.channel_overrides]
  for (const [id, o] of Object.entries(patch.channel_overrides ?? {})) {
    const i = overrides.findIndex((x) => x.channel_id === id)
    const next = { ...(overrides[i] ?? { channel_id: id, message_notifications: 3, muted: false, mute_config: null }), ...o }
    if (i >= 0) overrides[i] = next
    else overrides.push(next)
  }
  apply('USER_GUILD_SETTINGS_UPDATE', { ...base, ...patch, channel_overrides: overrides })
  try {
    const r = await api<UserGuildSettings>(`/users/@me/guilds/${guildId}/settings`, { method: 'PATCH', body: patch })
    if (r && typeof r === 'object') apply('USER_GUILD_SETTINGS_UPDATE', { ...r, guild_id: r.guild_id ?? (guildId === '@me' ? null : guildId) })
  } catch (e) {
    if (old) apply('USER_GUILD_SETTINGS_UPDATE', old)
    throw e
  }
}
/** Mute for `minutes` (null = until turned back on). */
export const muteConfig = (minutes: number | null) => ({ selected_time_window: minutes === null ? -1 : minutes * 60, end_time: minutes === null ? null : new Date(Date.now() + minutes * 60_000).toISOString() })

// ---------- v4: group DMs, calls, blocking ----------
const openChannel = (c: Channel) => (apply('CHANNEL_CREATE', c), setState({ showNav: false }), navigate(`/channels/@me/${c.id}`), c)
export const createGroupDm = (recipients: string[]) => api<Channel>('/users/@me/channels', { method: 'POST', body: { recipients } }).then(openChannel)
export const updateGroupDm = (id: string, body: { name?: string | null; icon?: string | null; owner?: string }) =>
  api<Channel>(`/channels/${id}`, { method: 'PATCH', body }).then((c) => (apply('CHANNEL_UPDATE', c), c))
export const addRecipient = (channelId: string, userId: string) => api(`/channels/${channelId}/recipients/${userId}`, { method: 'PUT', body: {} })
export const removeRecipient = (channelId: string, userId: string) => api(`/channels/${channelId}/recipients/${userId}`, { method: 'DELETE' })
export async function closePrivate(c: Channel) {
  await api(`/channels/${c.id}`, { method: 'DELETE' })
  apply('CHANNEL_DELETE', c)
  if (location.pathname.includes(c.id)) navigate('/channels/@me')
}
export const ringCall = (channelId: string, recipients?: string[]) => api(`/channels/${channelId}/call/ring`, { method: 'POST', body: { recipients: recipients ?? null } })
export const stopRinging = (channelId: string, recipients?: string[]) => api(`/channels/${channelId}/call/stop-ringing`, { method: 'POST', body: recipients ? { recipients } : {} })

export const blockUser = (id: string) => api(`/users/@me/relationships/${id}`, { method: 'PUT', body: { type: 2 } })
export const unblockUser = (id: string) => api(`/users/@me/relationships/${id}`, { method: 'DELETE' })

// ---------- v4: profiles ----------
export const getProfile = (userId: string, guildId?: string) =>
  api<Profile>(`/users/${userId}/profile${qs({ with_mutual_guilds: true, with_mutual_friends: true, with_mutual_friends_count: true, guild_id: guildId })}`)
export const getMutualFriends = (userId: string) => api<User[]>(`/users/${userId}/mutual-friends`)
export const getMutualGuilds = (userId: string) => api<{ id: string; name: string; icon: string | null; nick: string | null }[]>(`/users/${userId}/mutual-guilds`)
export const getNote = (userId: string) => api<{ note: string }>(`/users/@me/notes/${userId}`).then((r) => r?.note ?? '', () => '')
export const setNote = (userId: string, note: string) => api(`/users/@me/notes/${userId}`, { method: 'PUT', body: { note } })
/** PATCH /users/@me: profile fields, or account fields with `password` (username, email, new_password). A returned token replaces ours. */
export async function patchMe(body: Record<string, unknown>) {
  const u = await api<User & { token?: string }>('/users/@me', { method: 'PATCH', body })
  if (u?.token) replaceToken(u.token)
  const { token: _t, ...user } = u
  apply('USER_UPDATE', user)
  return user as User
}
export const patchMyMember = (guildId: string, body: { nick?: string | null; avatar?: string | null; banner?: string | null; bio?: string | null; display_name_font_id?: number | null; display_name_effect_id?: number | null; display_name_colors?: number[] | null }) =>
  api<Member>(`/guilds/${guildId}/members/@me`, { method: 'PATCH', body }).then((m) => (m && apply('GUILD_MEMBER_UPDATE', { ...m, guild_id: guildId }), m))

// ---------- v4: inbox ----------
export const recentMentions = (p: { before?: string; guild_id?: string; roles: boolean; everyone: boolean }) =>
  api<Message[]>(`/users/@me/mentions${qs({ limit: 25, ...p })}`).then((m) => rows(m))
export const deleteMention = (id: string) => api(`/users/@me/mentions/${id}`, { method: 'DELETE' })
/** "Mark all as read" (user docs: POST /read-states/ack-bulk), applied locally first. */
export async function ackBulk(channels: Channel[]) {
  const list = channels.filter((c) => c.last_message_id)
  list.forEach((c) => apply('MESSAGE_ACK', { channel_id: c.id, message_id: c.last_message_id }))
  if (list.length) await api('/read-states/ack-bulk', { method: 'POST', body: { read_states: list.map((c) => ({ channel_id: c.id, message_id: c.last_message_id })) } })
}

// ---------- v4: Web Push ----------
export const vapidKey = () => api<{ public_key?: string; key?: string } | string>('/push/vapid-public-key').then((r) => (typeof r === 'string' ? r : r.public_key ?? r.key ?? ''))
export const addPushSubscription = (sub: PushSubscriptionJSON) => api('/users/@me/push-subscriptions', { method: 'POST', body: { endpoint: sub.endpoint, keys: sub.keys } })
export const removePushSubscription = (endpoint: string) => api('/users/@me/push-subscriptions', { method: 'DELETE', body: { endpoint } })

// ---------- v4: account security ----------
export type BackupCode = { code: string; consumed: boolean }
export const enableTotp = (password: string, secret: string, code: string) =>
  api<{ token: string; backup_codes: BackupCode[] }>('/users/@me/mfa/totp/enable', { method: 'POST', body: { password, secret, code } }).then((r) => {
    if (r.token) replaceToken(r.token)
    const me = getState().me
    if (me) apply('USER_UPDATE', { ...me, mfa_enabled: true })
    return r.backup_codes ?? []
  })
export const disableTotp = (code: string) =>
  api<{ token?: string }>('/users/@me/mfa/totp/disable', { method: 'POST', body: { code } }).then((r) => {
    if (r?.token) replaceToken(r.token)
    const me = getState().me
    if (me) apply('USER_UPDATE', { ...me, mfa_enabled: false })
  })
export const backupCodes = (password: string, regenerate: boolean, code?: string) =>
  api<{ backup_codes: BackupCode[] }>('/users/@me/mfa/codes-verification', { method: 'POST', body: { password, regenerate, ...(code && { code }) } }).then((r) => r.backup_codes ?? [])
export const authSessions = () => api<{ user_sessions: AuthSession[] }>('/auth/sessions').then((r) => r.user_sessions ?? [])
export const logoutSessions = (hashes: string[]) => api('/auth/sessions/logout', { method: 'POST', body: { session_id_hashes: hashes } })
export const deleteAccount = (password: string, code?: string) => api('/users/@me/delete', { method: 'POST', body: { password, ...(code && { code }) } })
export const transferGuild = (guildId: string, ownerId: string, code?: string) => patchGuild(guildId, { owner_id: ownerId, ...(code && { code }) })

// ---------- v4: applications and OAuth2 ----------
export const listApps = () => api<Application[]>('/applications')
export const createApp = (name: string) => api<Application>('/applications', { method: 'POST', body: { name } })
export const updateApp = (id: string, body: Partial<Pick<Application, 'name' | 'description' | 'icon' | 'flags' | 'interactions_endpoint_url' | 'bot_public'>>) =>
  api<Application>(`/applications/${id}`, { method: 'PATCH', body })
/** User docs: POST /applications/:id/delete; DELETE as a fallback for servers that only have that. */
export async function deleteApp(id: string) {
  try {
    await api(`/applications/${id}/delete`, { method: 'POST' })
  } catch (e) {
    if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) throw e
    await api(`/applications/${id}`, { method: 'DELETE' })
  }
}
export const resetBotToken = (id: string) => api<{ token: string }>(`/applications/${id}/bot/reset`, { method: 'POST' }).then((r) => r.token)
export const updateBot = (id: string, body: { username?: string; avatar?: string | null }) => api<User>(`/applications/${id}/bot`, { method: 'PATCH', body })
export type AuthorizePreview = {
  application: Application; bot?: User; user: User; authorized: boolean; guilds?: (Pick<Guild, 'id' | 'name' | 'icon'> & { permissions: string })[]
  /** v7: the client is a linked node asking to sign the user in (scope identify, PKCE); `application` may be absent then. */
  node?: { node_id: string; name: string; url: string; icon?: string | null }
}
export const previewAuthorize = (query: string) => api<AuthorizePreview>(`/oauth2/authorize${query}`)
export const authorizeApp = (query: string, body: { guild_id: string; permissions: string; authorize: true }) =>
  api<{ url?: string }>(`/oauth2/authorize${query}`, { method: 'POST', body })
/** v7 node sign-in consent: the answer's `location` is the node's redirect_uri with `code` (or `error=access_denied`). */
export const authorizeNode = (query: string, authorize: boolean) => api<{ location: string }>(`/oauth2/authorize${query}`, { method: 'POST', body: { authorize } })

// ---------- v4: application commands and interactions ----------
const indexes = new Map<string, Promise<CommandIndex>>()
addEventListener('cillcord:command-index', (e) => indexes.delete(`g${(e as CustomEvent<string>).detail}`))
/** Commands available in a guild (or a DM), per user docs' application command index; cached for a minute. */
export function commandIndex(scope: { guildId?: string; channelId: string }) {
  const key = scope.guildId ? `g${scope.guildId}` : `c${scope.channelId}`
  let p = indexes.get(key)
  if (!p) {
    p = api<CommandIndex>(scope.guildId ? `/guilds/${scope.guildId}/application-command-index` : `/channels/${scope.channelId}/application-command-index`)
      .then((r) => ({ ...r, applications: rows(r.applications), application_commands: rows(r.application_commands) }))
      .catch(() => ({ applications: [], application_commands: [] }))
    indexes.set(key, p)
    setTimeout(() => indexes.delete(key), 60_000)
  }
  return p
}
/** The interactions we sent and that are still open (autocomplete too), by nonce: a node may only answer those, once
 *  for a terminal answer, within 15 minutes (instances/registry.ts). */
export const sentInteractions = new Map<string, { channelId: string; appId: string; type: number; at: number }>()
/** POST /interactions (user docs). The nonce ties the gateway's INTERACTION_* events to this request. */
export async function sendInteraction(body: { type: number; application_id: string; guild_id?: string; channel_id: string; message_id?: string; message_flags?: number; data: unknown }, track?: Omit<import('./store').PendingInteraction, 'nonce' | 'state' | 'at'>, files: File[] = []) {
  const n = nonce()
  sentInteractions.set(n, { channelId: body.channel_id, appId: body.application_id, type: body.type, at: Date.now() })
  if (sentInteractions.size > 100) sentInteractions.delete(sentInteractions.keys().next().value!)
  if (track) setState((s) => ({ interactions: { ...s.interactions, [n]: { ...track, nonce: n, state: 'sending', at: Date.now() } } }))
  const payload = { ...body, nonce: n, session_id: getState().sessionId }
  try {
    if (files.length) {
      // ATTACHMENT options: multipart with payload_json and files[n] (user docs: Create Interaction)
      const form = new FormData()
      form.append('payload_json', JSON.stringify(payload))
      files.forEach((f, i) => form.append(`files[${i}]`, f, f.name))
      await upload('/interactions', form)
    } else await api('/interactions', { method: 'POST', body: payload })
  } catch (e) {
    if (track) setState((s) => ({ interactions: { ...s.interactions, [n]: { ...s.interactions[n], state: 'failed' } } }))
    throw e
  }
  // Fallback for the 3 s rule: if neither INTERACTION_SUCCESS nor FAILURE arrived, the application did not respond.
  if (track) setTimeout(() => setState((s) => (s.interactions[n] && s.interactions[n].state !== 'failed' ? { interactions: { ...s.interactions, [n]: { ...s.interactions[n], state: 'failed' } } } : {})), 5000)
  return n
}
export const dismissInteraction = (n: string) => setState((s) => ({ interactions: Object.fromEntries(Object.entries(s.interactions).filter(([k]) => k !== n)) }))

// ---------- v5 ----------
// Watch Together (CONTRACT-v5 section 1). Results come back as WATCH_SESSION_UPDATE; a returned session is applied at once too.
const watchState = (channelId: string, w: WatchSession | undefined) => w && typeof w === 'object' && w.host_id && apply('WATCH_SESSION_UPDATE', { ...w, channel_id: w.channel_id ?? channelId })
export const startWatch = (channelId: string, videoUrl: string) =>
  api<WatchSession>(`/channels/${channelId}/watch`, { method: 'POST', body: { video_url: videoUrl } }).then((w) => watchState(channelId, w))
export type WatchAction = { action: 'play' | 'pause' | 'seek' | 'next' | 'remove'; position?: number; index?: number } | { control: 'host' | 'everyone' }
export const patchWatch = (channelId: string, body: WatchAction) =>
  api<WatchSession>(`/channels/${channelId}/watch`, { method: 'PATCH', body }).then((w) => watchState(channelId, w))
export const stopWatch = (channelId: string) => api(`/channels/${channelId}/watch`, { method: 'DELETE' }).then(() => apply('WATCH_SESSION_DELETE', { channel_id: channelId }))
/** The current session when opening a voice channel (optional on the server: 404 means none or unsupported). */
export const fetchWatch = (channelId: string) =>
  api<WatchSession>(`/channels/${channelId}/watch`).then((w) => watchState(channelId, w), () => {})

/** Voice channel status (user docs: PUT /channels/:id/voice-status); null or '' clears it. */
export const setVoiceStatus = (channelId: string, status: string | null) =>
  api(`/channels/${channelId}/voice-status`, { method: 'PUT', body: { status: status || null } }).then(() => {
    const c = getState().channels[channelId]
    apply('VOICE_CHANNEL_STATUS_UPDATE', { id: channelId, guild_id: c?.guild_id, status: status || null })
  })

// Scheduled messages ("Send later", CONTRACT-v5 section 5): created on the channel like a message, listed/edited/cancelled under /users/@me.
export const scheduledMessages = () => api<ScheduledMessage[]>('/users/@me/scheduled-messages')
export async function scheduleMessage(channelId: string, content: string, sendAt: Date) {
  await E.refusePlain(getState().channels[channelId])
  return api<ScheduledMessage>(`/channels/${channelId}/scheduled-messages`, { method: 'POST', body: { content, send_at: sendAt.toISOString() } })
}
export const editScheduled = (id: string, patch: { content?: string; send_at?: string }) =>
  api<ScheduledMessage>(`/users/@me/scheduled-messages/${id}`, { method: 'PATCH', body: patch })
export const cancelScheduled = (id: string) => api(`/users/@me/scheduled-messages/${id}`, { method: 'DELETE' })

// Message reminders and bookmarks: saved messages (user docs: /users/@me/saved-messages).
export const loadReminders = () =>
  api<{ results: SavedMessage[] }>('/users/@me/saved-messages').then((r) => {
    const all = r?.results ?? []
    const reminders = all.filter((x) => x.save_data?.due_at)
    const bookmarks = all.filter((x) => x.save_data && !x.save_data.due_at)
    setState({
      reminders: Object.fromEntries(reminders.map((x) => [`${x.save_data.channel_id}-${x.save_data.message_id}`, x])),
      bookmarks: Object.fromEntries(bookmarks.map((x) => [`${x.save_data.channel_id}-${x.save_data.message_id}`, x])),
    })
  })
export const remindMe = (m: Message, due: Date) =>
  api<SavedMessage | undefined>(`/users/@me/saved-messages/${m.channel_id}/${m.id}`, { method: 'PUT', body: { due_at: due.toISOString() } }).then((saved) =>
    apply('SAVED_MESSAGE_CREATE', saved?.save_data ? saved : { message: m, save_data: { channel_id: m.channel_id, message_id: m.id, guild_id: m.guild_id, saved_at: new Date().toISOString(), due_at: due.toISOString() } }))
export const removeReminder = (channelId: string, messageId: string) =>
  api(`/users/@me/saved-messages/${channelId}/${messageId}`, { method: 'DELETE' }).then(() => apply('SAVED_MESSAGE_DELETE', { channel_id: channelId, message_id: messageId }))
export const toggleBookmark = (m: Message) => {
  const k = `${m.channel_id}-${m.id}`
  if (getState().bookmarks[k]) return removeReminder(m.channel_id, m.id)
  return api<SavedMessage | undefined>(`/users/@me/saved-messages/${m.channel_id}/${m.id}`, { method: 'PUT', body: {} }).then((saved) =>
    apply('SAVED_MESSAGE_CREATE', saved?.save_data ? saved : { message: m, save_data: { channel_id: m.channel_id, message_id: m.id, guild_id: m.guild_id, saved_at: new Date().toISOString(), due_at: null } }))
}

/** Built-in Cillhub Bot (CONTRACT-v5 section 4): GET tells whether it is installed, PUT installs it (MANAGE_GUILD). */
export const cillcordBotStatus = (guildId: string) => api<{ installed: boolean }>(`/guilds/${guildId}/cillcord-bot`)
export const addCillcordBot = (guildId: string) => api(`/guilds/${guildId}/cillcord-bot`, { method: 'PUT' })

// Server templates (guild-template.mdx) and JSON import (Create Guild with placeholder ids).
export const guildTemplates = (guildId: string) => api<GuildTemplate[]>(`/guilds/${guildId}/templates`)
export const createTemplate = (guildId: string, name: string, description: string) =>
  api<GuildTemplate>(`/guilds/${guildId}/templates`, { method: 'POST', body: { name, description: description || null } })
export const syncTemplate = (guildId: string, code: string) => api<GuildTemplate>(`/guilds/${guildId}/templates/${code}`, { method: 'PUT' })
export const deleteTemplate = (guildId: string, code: string) => api(`/guilds/${guildId}/templates/${code}`, { method: 'DELETE' })
export const getTemplate = (code: string) => api<GuildTemplate>(`/guilds/templates/${encodeURIComponent(code)}`)
/** A template link from the other chat app, fetched and adapted by the server (routes/templates.js). */
export const getExternalTemplate = (code: string) => api<GuildTemplate>(`/guilds/templates/external/${encodeURIComponent(code)}`)
export const createFromTemplate = (code: string, name: string) =>
  api<GuildPayload>(`/guilds/templates/${encodeURIComponent(code)}`, { method: 'POST', body: { name } }).then((g) => enterGuild(g, g.system_channel_id ?? undefined))
/** "Export Server": the server's snapshot of every channel and role (also ones hidden from us), plus emoji. */
export const exportGuild = (guildId: string) => api<{ serialized_source_guild: GuildSnapshot }>(`/guilds/${guildId}/export`)
export const importGuild = (snap: GuildSnapshot, name: string) => {
  const { roles, channels, verification_level, default_message_notifications, explicit_content_filter, afk_channel_id, afk_timeout, system_channel_id, system_channel_flags, description, emojis } = snap
  return api<GuildPayload>('/guilds', {
    method: 'POST',
    // emojis and description are Cillhub additions to the Create Guild body
    body: { name, roles, channels, verification_level, default_message_notifications, explicit_content_filter, afk_channel_id, afk_timeout, system_channel_id, system_channel_flags, description, emojis },
  }).then((g) => enterGuild(g, g.system_channel_id ?? undefined))
}

// Channel Canvas (Contract v9 §5)
export const getCanvas = (channelId: string) => api<ChannelCanvas>(`/channels/${channelId}/canvas`)
export const updateCanvas = (channelId: string, content: string) =>
  api<ChannelCanvas>(`/channels/${channelId}/canvas`, { method: 'PUT', body: { content } })

// Interactive Onboarding & Analytics (Contract v9 §6, §7)
export const getOnboarding = (guildId: string) => api<GuildOnboarding>(`/guilds/${guildId}/onboarding`)
export const updateOnboarding = (guildId: string, enabled: boolean, prompts: OnboardingPrompt[]) =>
  api<GuildOnboarding>(`/guilds/${guildId}/onboarding`, { method: 'PUT', body: { enabled, prompts } })
export const respondOnboarding = (guildId: string, option_ids: string[]) =>
  api<{ success: boolean; assigned_roles: string[] }>(`/guilds/${guildId}/onboarding/respond`, { method: 'POST', body: { option_ids } })
export const getGuildAnalytics = (guildId: string, days = 30) =>
  api<GuildAnalytics>(`/guilds/${guildId}/analytics?days=${days}`)

// WebAuthn Passkeys (Contract v9 §9)
export const listPasskeys = () =>
  api<{ id: string; nickname: string; created_at: string; last_used_at: string | null }[]>('/users/@me/webauthn/credentials')
export const deletePasskey = (id: string) =>
  api<{ ok: boolean }>(`/users/@me/webauthn/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' })

// Bulk delete (Task 6.1)
export async function bulkDeleteMessages(channelId: string, ids: string[]) {
  if (ids.length === 0) return
  if (ids.length === 1) {
    await api(`/channels/${channelId}/messages/${ids[0]}`, { method: 'DELETE' })
    apply('MESSAGE_DELETE', { id: ids[0], channel_id: channelId })
    return
  }
  await api(`/channels/${channelId}/messages/bulk-delete`, { method: 'POST', body: { messages: ids } })
  apply('MESSAGE_DELETE_BULK', { ids, channel_id: channelId })
}

// Edit history (Task 6.2)
export async function fetchMessageEdits(channelId: string, messageId: string): Promise<{ edits: MessageEdit[] }> {
  return api<{ edits: MessageEdit[] }>(`/channels/${channelId}/messages/${messageId}/edits`)
}

// Data export (Task 6.7)
export async function exportMyData() {
  const data = await api<unknown>('/users/@me/export')
  const json = JSON.stringify(data, null, 2)
  const blob = new Blob([json], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `cillhub-data-export.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// Channel media, files & links gallery (Task 6.9)
export async function fetchChannelMedia(channelId: string, tab: 'media' | 'files' | 'links' = 'media', before?: string, limit = 50): Promise<{ messages: Message[] }> {
  return api<{ messages: Message[] }>(`/channels/${channelId}/media?tab=${tab}&limit=${limit}${before ? `&before=${before}` : ''}`)
}

// Guild text snippets / FAQ tags (Task 6.11)
export async function fetchSnippets(guildId: string): Promise<{ snippets: Snippet[] }> {
  return api<{ snippets: Snippet[] }>(`/guilds/${guildId}/snippets`)
}

export async function createSnippet(guildId: string, name: string, content: string): Promise<Snippet> {
  return api<Snippet>(`/guilds/${guildId}/snippets`, { method: 'POST', body: { name, content } })
}

export async function deleteSnippet(guildId: string, snippetId: string): Promise<void> {
  await api(`/guilds/${guildId}/snippets/${snippetId}`, { method: 'DELETE' })
}

// Thread notification settings & flags (Task 6.13)
export async function updateThreadMemberFlags(threadId: string, flags: number): Promise<ThreadMember> {
  const tm = await api<ThreadMember>(`/channels/${threadId}/thread-members/@me`, { method: 'PATCH', body: { flags } })
  setState((s) => {
    const ch = s.channels[threadId]
    if (!ch) return s
    return {
      channels: {
        ...s.channels,
        [threadId]: {
          ...ch,
          member: ch.member ? { ...ch.member, flags } : { flags, join_timestamp: new Date().toISOString() },
        },
      },
    }
  })
  return tm
}

// Forum thread solved status & pinning (Task 6.3)
export async function setThreadSolved(threadId: string, messageId: string | null): Promise<Channel> {
  const ch = await api<Channel>(`/channels/${threadId}`, { method: 'PATCH', body: { solved_message_id: messageId } })
  apply('CHANNEL_UPDATE', ch)
  return ch
}

export async function setThreadPinned(threadId: string, pinned: boolean, currentFlags = 0): Promise<Channel> {
  const newFlags = pinned ? (currentFlags | 2) : (currentFlags & ~2)
  const ch = await api<Channel>(`/channels/${threadId}`, { method: 'PATCH', body: { flags: newFlags } })
  apply('CHANNEL_UPDATE', ch)
  return ch
}



