import { memo, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { MessageAccessory } from '../modules/ModulePanel'
import { apiOrigin } from '../api'
import { clock } from '../appearance/format'
import { contextCommands, runContextCommand } from '../commands/commands'
import { MessageComponents } from '../components-ui/MessageComponents'
import { t, useLocale } from '../i18n'
import type { AppCommand } from '../types'
import { crosspost, deleteMessage, editMessage, endPoll, IS_VOICE_MESSAGE, openMessage, resend, setPinned, setThreadSolved, SUPPRESS_EMBEDS, suppressEmbeds, toggleBookmark, toggleReaction, type EmojiRef } from '../actions'
import { ask, toast, toastError } from '../components/dialogs'
import { afterRightRelease, MenuItem, MenuLabel, MenuSep, Popover, useContextMenu, type Anchor } from '../components/menu'
import { UserMenu } from '../components/UserMenu'
import { Avatar, cls, Icon, ICONS, memberAvatarUrl } from '../components/ui'
import { EmojiPicker } from '../emoji/EmojiPicker'
import { stickerUrl } from '../expressions/ExpressionPicker'
import { MotionImg, useStickerMotion } from '../appearance/MotionImg'
import { CustomEmoji, Markdown, type MdContext } from '../markdown/Markdown'
import { has, isThread, P } from '../permissions'
import { permsOf } from '../selectors'
import { PollResult, PollView } from '../polls/Poll'
import { isBlocked, roleColor } from '../selectors'
import { apply, displayName, emojiKey, getState, setState, startPurgeMode, togglePurgeSelect, useStore } from '../store'
import { BotCard, isBotCard } from '../bot/BotCard'
import '../bot/bot.css'
import { RemindMenu } from '../scheduling/Scheduling'
import { ReportDialog } from '../admin/ReportDialog'
import { ThreadChip } from '../threads/ThreadChip'
import { iconRole, RoleIcon, ServerTag, StyledName } from '../custom/render'
import type { Message, MessageSnapshot, StickerItem } from '../types'
import { Attachments, Uploading } from './Attachments'
import { EditHistoryModal } from './EditHistoryModal'
import { Embeds } from './Embeds'
import { GameInviteCard, parseGameInvite } from './GameInvite'
import { MessageLinkQuotes } from './MessageLinkQuotes'
import { ServerInviteCard } from './ServerInvite'
import { inviteCodes, onlyInvite } from './inviteLinks'
import { isEncrypted, usePlain, type Plain } from '../e2ee/session'
import { E2eeFiles } from '../e2ee/E2ee'

export function stamp(iso: string) {
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(iso).setHours(0, 0, 0, 0)) / 864e5)
  return days === 0 ? t('Today at {time}', { time: clock(iso) }) : days === 1 ? t('Yesterday at {time}', { time: clock(iso) }) : `${new Date(iso).toLocaleDateString()} ${clock(iso)}`
}
const EPHEMERAL = 1 << 6
const LOADING = 1 << 7
const CROSSPOSTED = 1 << 0
const IS_CROSSPOST = 1 << 1
const SUPPRESS_NOTIFICATIONS = 1 << 12

/** A translated sentence with a React node in place of `{name}`. */
const withName = (s: string, n: ReactNode) => {
  const [a, b = ''] = s.split('{name}')
  return <>{a}{n}{b}</>
}
const JOIN_LINES: ((n: ReactNode) => ReactNode)[] = [
  'Welcome aboard, {name}. Grab a seat.', '{name} just joined the lobby.', '{name} has entered the chat.', 'Good to see you, {name}!', '{name} spawned in.', 'Everyone say hi to {name}!',
].map((s) => (n: ReactNode) => withName(t(s), n))

/** Names in chat use the member's nickname and highest colored role (webhooks keep their own name). */
export function useAuthor(m: Message) {
  const user = useStore((s) => (m.webhook_id ? undefined : s.users[m.author.id])) ?? m.author
  const member = useStore((s) => (m.guild_id && !m.webhook_id ? s.members[m.guild_id]?.[m.author.id] : undefined))
  const guild = useStore((s) => (m.guild_id ? s.guilds[m.guild_id] : undefined))
  return { user, member, guild, name: member?.nick || displayName(user), color: roleColor(guild, member), avatar: memberAvatarUrl(m.guild_id, member) }
}

const openProfile = (m: Message, el: Element) =>
  !m.webhook_id && setState({ popout: { userId: m.author.id, guildId: m.guild_id, at: { rect: el.getBoundingClientRect(), side: 'right' } } })

/** What to show instead of an encrypted message that is not readable (never the envelope). */
const lockedText = (p: Plain) => (p.state === 'pending' ? t('Decrypting…') : p.state === 'locked' ? t('Enter your recovery key to read this.') : t('Cannot decrypt this message.'))

function ReplyPreview({ m, ctx }: { m: Message; ctx: MdContext }) {
  const raw = m.referenced_message
  const plain = usePlain(raw)
  const ref = raw && plain ? { ...raw, content: plain.state === 'ok' ? plain.content : '', attachments: plain.state === 'ok' && plain.files.length ? raw.attachments : [] } : raw
  const author = useAuthor(ref ?? m)
  if (!ref) return <div className="reply-preview"><span className="reply-spine" aria-hidden="true" /><span className="hint">{t('Original message was deleted')}</span></div>
  return (
    <div className="reply-preview">
      <span className="reply-spine" aria-hidden="true" />
      <Avatar user={author.user} size={16} />
      <span className="reply-author" style={{ color: author.color }}>@{author.name}</span>
      <button className="reply-text ellipsis" aria-label={t('Jump to replied message from {name}', { name: author.name })} onClick={() => void openMessage(ref.channel_id, ref.id)}>
        {plain && plain.state !== 'ok' ? <em>{lockedText(plain)}</em> : ref.content ? <Markdown content={ref.content.split('\n')[0]} ctx={ctx} /> : ref.embeds?.[0]?.title && !ref.attachments?.length ? <em>{ref.embeds[0].title}</em> : <em>{t('Click to see attachment')}</em>}
      </button>
    </div>
  )
}

const ReactionEmoji = ({ e }: { e: EmojiRef }) => (e.id ? <CustomEmoji id={e.id} name={e.name} animated={e.animated} /> : <span className="emoji">{e.name}</span>)

function Reactions({ m, perms }: { m: Message; perms: bigint }) {
  if (!m.reactions?.length) return null
  const canRead = has(perms, P.READ_MESSAGE_HISTORY)
  return (
    <div className="reactions">
      {m.reactions.map((r) => (
        <button
          key={emojiKey(r.emoji)}
          className={cls('reaction', r.me && 'me')}
          aria-pressed={r.me}
          aria-label={`${r.emoji.id ? `:${r.emoji.name}:` : r.emoji.name}, ${r.count} reaction${r.count === 1 ? '' : 's'}`}
          disabled={!canRead}
          onClick={() => toggleReaction(m, r.emoji).catch(toastError)}
        >
          <ReactionEmoji e={r.emoji} /> <span className="count">{r.count}</span>
        </button>
      ))}
    </div>
  )
}

function Stickers({ list }: { list?: StickerItem[] }) {
  const motion = useStickerMotion() // PNG and WebP stickers may be animated too (APNG, animated WebP)
  return list?.length ? (
    <div className="stickers">
      {list.map((s) => s.format_type === 3
        ? <span key={s.id} className="sticker-missing">[{s.name}]</span>
        : <MotionImg key={s.id} motion={motion} className="sticker" src={stickerUrl(s)} alt={t('Sticker: {name}', { name: s.name })} title={s.name} width={160} height={160} loading="lazy" />)}
    </div>
  ) : null
}

/** Forwarded message (message_reference.type 1): the snapshot with a "Forwarded" label. */
function Forwarded({ snap, ctx, from }: { snap: MessageSnapshot; ctx: MdContext; from?: { channelId?: string; messageId: string } }) {
  const s = snap.message
  const origin = useStore((st) => (from?.channelId ? st.channels[from.channelId] : undefined))
  return (
    <div className="forwarded">
      <span className="forward-spine" aria-hidden="true" />
      <div className="forward-body">
        <p className="forward-label"><Icon d={ICONS.forward} size={14} /> <em>{t('Forwarded')}</em></p>
        {s.content && <div className="content"><Markdown content={s.content} ctx={ctx} /></div>}
        <Attachments list={s.attachments ?? []} voice={!!((s.flags ?? 0) & IS_VOICE_MESSAGE)} />
        <Embeds list={s.embeds ?? []} ctx={ctx} />
        <Stickers list={s.sticker_items} />
        <p className="hint small">
          {origin && from ? <button className="link" onClick={() => void openMessage(origin.id, from.messageId)}>#{origin.name}</button> : null}
          {origin ? ' • ' : ''}{stamp(s.timestamp)}
        </p>
      </div>
    </div>
  )
}

/** A server greeting template (CONTRACT-v6 section 3): the server picks one at join time and stores it as the join
 * message's content, with `{user}` for the new member. Plain text, never markdown. */
function greeting(m: Message) {
  const text = m.content?.trim()
  return text ? (n: ReactNode) => { const [a, ...rest] = text.split('{user}'); return <>{a}{rest.map((r, i) => <span key={i}>{n}{r}</span>)}{!rest.length && <> {n}</>}</> } : null
}

function SystemJoin({ m }: { m: Message }) {
  const a = useAuthor(m)
  const line = greeting(m) ?? JOIN_LINES[(Date.parse(m.timestamp) || 0) % JOIN_LINES.length]
  return (
    <li id={`msg-${m.id}`} className="msg system" tabIndex={-1}>
      <Icon d={ICONS.arrowRight} size={16} className="join-arrow" />
      <span>
        {line(<button className="author" style={{ color: a.color }} onClick={(e) => openProfile(m, e.currentTarget)}>{a.name}</button>)}
      </span>
      <time dateTime={m.timestamp}>{stamp(m.timestamp)}</time>
    </li>
  )
}

/** Type 3 (DM/group call): "X started a call." and, once ended, how long it lasted or that you missed it. */
function SystemCall({ m }: { m: Message }) {
  const a = useAuthor(m)
  const me = useStore((s) => s.me?.id)
  const call = m.call
  const ended = call?.ended_timestamp
  const minutes = ended ? Math.max(1, Math.round((Date.parse(ended) - Date.parse(m.timestamp)) / 60000)) : 0
  const missed = !!ended && !!me && m.author.id !== me && !call?.participants.includes(me)
  const name = <button className="author" style={{ color: a.color }} onClick={(e) => openProfile(m, e.currentTarget)}>{a.name}</button>
  const text = missed ? t('You missed a call from {name}.') : ended ? t(minutes === 1 ? '{name} started a call that lasted a minute.' : '{name} started a call that lasted {n} minutes.', { n: minutes }) : t('{name} started a call.')
  return (
    <li id={`msg-${m.id}`} className="msg system" tabIndex={-1}>
      <Icon d={ICONS.phone} size={16} className="join-arrow" />
      <span>{withName(text, name)}</span>
      <time dateTime={m.timestamp}>{stamp(m.timestamp)}</time>
    </li>
  )
}

/** Type 18: "X started a thread: name". */
function SystemThread({ m }: { m: Message }) {
  const a = useAuthor(m)
  const threadId = m.message_reference?.channel_id
  return (
    <li id={`msg-${m.id}`} className="msg system" tabIndex={-1}>
      <Icon d={ICONS.thread} size={16} className="join-arrow" />
      <span>
        <button className="author" style={{ color: a.color }} onClick={(e) => openProfile(m, e.currentTarget)}>{a.name}</button> {t('started a thread:')}{' '}
        <button className="link strong" onClick={() => threadId && setState({ panel: { kind: 'thread', channelId: threadId } })}>{m.content}</button>
      </span>
      <time dateTime={m.timestamp}>{stamp(m.timestamp)}</time>
    </li>
  )
}

/** "<user> used /command" above an application's answer (interaction_metadata, or the older `interaction`). */
function InteractionLine({ m }: { m: Message }) {
  const meta = m.interaction_metadata ?? m.interaction
  const user = useStore((s) => (meta ? s.users[meta.user.id] : undefined)) ?? meta?.user
  if (!meta || !user) return null
  const name = m.interaction?.name ?? m.interaction_metadata?.name
  // only slash commands get a "/": user and message commands (message type 23, or metadata with a target) show their plain name
  const im = m.interaction_metadata
  const slash = meta.type === 2 && m.type !== 23 && !im?.target_user && !im?.target_message_id && (im?.command_type ?? 1) === 1
  return (
    <div className="interaction-line">
      <span className="reply-spine" aria-hidden="true" />
      <Avatar user={user} size={16} />
      <span>{t('{user} used {command}', { user: displayName(user), command: name ? (slash ? `/${name}` : name) : t('a command') })}</span>
    </div>
  )
}

/** "Apps" section of a context menu: message or user commands of the apps in this channel (loaded when the menu opens). */
export function AppsSection({ channelId, type, targetId }: { channelId: string; type: 2 | 3; targetId: string }) {
  const [list, setList] = useState<AppCommand[]>([])
  const channel = useStore((s) => s.channels[channelId])
  useEffect(() => {
    if (!channel) return
    let live = true
    const perms = channel.guild_id ? permsOfChannel(channel.id) : 0n
    void contextCommands(channel, type, perms).then((l) => live && setList(l))
    return () => void (live = false)
  }, [channel, type])
  if (!list.length || !channel) return null
  return (
    <>
      <MenuSep />
      <MenuLabel>{t('Apps')}</MenuLabel>
      {list.map((c) => <MenuItem key={c.id} onSelect={() => void runContextCommand(channel, c, targetId).catch(toastError)}>{c.name}</MenuItem>)}
    </>
  )
}
const permsOfChannel = (id: string) => {
  const s = getState()
  const c = s.channels[id]
  return c ? permsOf(s, c.guild_id, c) : 0n
}

/** Messages of blocked users collapse to "Blocked message" with a reveal. */
function BlockedMessage({ m, children }: { m: Message; children: ReactNode }) {
  const [shown, setShown] = useState(false)
  if (shown) return <>{children}</>
  return (
    <li id={`msg-${m.id}`} className="msg blocked" tabIndex={-1}>
      <Icon d={ICONS.block} size={16} className="join-arrow" />
      <span className="hint">{t('Blocked message')}</span> <button className="link" onClick={() => setShown(true)}>{t('Show message')}</button>
    </li>
  )
}

type ItemProps = { m: Message; head: boolean; perms: bigint; ctx: MdContext }
export const MessageItem = memo(function MessageItem(props: ItemProps) {
  useLocale() // memo would otherwise keep timestamps and system lines in the old language
  const blocked = useStore((s) => isBlocked(s, props.m.author.id) && !props.m.webhook_id)
  return blocked ? <BlockedMessage m={props.m}><Item {...props} /></BlockedMessage> : <Item {...props} />
})
function Item({ m: raw, head, perms, ctx }: ItemProps) {
  // encrypted DM: the decrypted text replaces the placeholder everywhere below (copy, quote, edit, report)
  const plain = usePlain(raw)
  const m = plain ? { ...raw, content: plain.state === 'ok' ? plain.content : '' } : raw
  const me = useStore((s) => s.me)
  const dev = useStore((s) => !!s.settings.developer_mode)
  const showEmbeds = useStore((s) => s.settings.render_embeds !== false)
  const showPreviews = useStore((s) => s.settings.inline_embed_media !== false)
  const editing = useStore((s) => s.editingId === m.id)
  const bookmarked = useStore((s) => !!s.bookmarks[`${m.channel_id}-${m.id}`])
  const myRoles = useStore((s) => (m.guild_id && s.me ? s.members[m.guild_id]?.[s.me.id]?.roles : undefined))
  const channel = useStore((s) => s.channels[m.channel_id])
  const author = useAuthor(m)
  const menu = useContextMenu()
  const [userMenu, setUserMenu] = useState<Anchor | null>(null)
  const [picker, setPicker] = useState<Anchor | null>(null)
  const [remind, setRemind] = useState<Anchor | null>(null)
  const [report, setReport] = useState(false)
  const [viewEdits, setViewEdits] = useState(false)
  const purgeMode = useStore((s) => s.purgeMode)
  const purgeSelected = useStore((s) => !!s.purgeSelected[m.id])
  const parentChannel = useStore((s) => (channel?.parent_id ? s.channels[channel.parent_id] : undefined))
  const isForumThread = (channel?.type === 11 || channel?.type === 12) && parentChannel?.type === 15
  const canManageSolution = isForumThread && (channel.owner_id === me?.id || has(perms, P.MANAGE_THREADS))
  const isSolution = isForumThread && channel.solved_message_id === m.id
  const encrypted = !!raw.e2ee_envelope || isEncrypted(channel) // no server-side forward of these
  const editButton = useRef<HTMLButtonElement>(null)
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus() // give focus back after the edit box goes away
    wasEditing.current = editing
  }, [editing])

  if (m.type === 7) return <SystemJoin m={m} />
  if (m.type === 3) return <SystemCall m={m} />
  if (m.type === 18) return <SystemThread m={m} />
  if (m.type === 46)
    return <li id={`msg-${m.id}`} className="msg system poll-result-msg" tabIndex={-1}><PollResult m={m} name={author.name} /></li>
  const mine = m.author.id === me?.id
  const invites = inviteCodes(m.content, apiOrigin())
  const inviteOnly = onlyInvite(m.content, apiOrigin())
  const sent = !m.pending && !m.failed
  const dm = !m.guild_id
  const manage = has(perms, P.MANAGE_MESSAGES)
  const canDelete = mine || manage
  const canPin = dm || manage
  const canReact = has(perms, P.ADD_REACTIONS) && has(perms, P.READ_MESSAGE_HISTORY)
  const canReply = has(perms, P.SEND_MESSAGES)
  const flags = m.flags ?? 0
  const threadable = !!channel && (channel.type === 0 || channel.type === 5) && !m.thread && has(perms, P.CREATE_PUBLIC_THREADS) && m.type !== 21
  const canPublish = channel?.type === 5 && !(flags & CROSSPOSTED) && (mine || manage) && m.type === 0 && !m.webhook_id
  // Settings: "show embeds" hides rich embeds, "show link previews" hides unfurled links (CONTRACT-v4 section 4).
  const embeds = flags & SUPPRESS_EMBEDS ? [] : m.embeds.filter((e) => (e.type === 'rich' || !e.type ? showEmbeds : showPreviews))
  const ephemeral = !!(flags & EPHEMERAL)
  const dismiss = () => apply('MESSAGE_DELETE', { id: m.id, channel_id: m.channel_id })
  const canSuppress = embeds.some((e) => e.type !== 'poll_result') && (mine || manage)
  const pollOpen = !!m.poll && !m.poll.results?.is_finalized && (!m.poll.expiry || Date.parse(m.poll.expiry) > Date.now())
  const forwarded = m.message_reference?.type === 1 ? m.message_snapshots?.[0] : undefined
  const mentioned = !mine && (!!m.mention_everyone || m.mentions.some((u) => u.id === me?.id) || !!m.mention_roles?.some((r) => myRoles?.includes(r)))
  const setEditing = (on: boolean) => setState({ editingId: on ? m.id : null })
  const reply = () => {
    setState({ replying: { channelId: m.channel_id, messageId: m.id } })
    document.querySelector<HTMLTextAreaElement>('.composer textarea')?.focus()
  }
  // Holding Shift deletes without asking.
  const remove = (e?: MouseEvent) => {
    if (m.failed || e?.shiftKey) return void deleteMessage(m).catch(toastError)
    void ask({
      title: t('Delete Message'),
      body: <><p>{t('Are you sure you want to delete this message?')}</p>{m.content && <blockquote className="dialog-quote">{m.content.slice(0, 300)}</blockquote>}<p className="hint small">{t('Tip: hold Shift when clicking delete to skip this.')}</p></>,
      confirm: t('Delete'), danger: true,
    }).then((ok) => void (ok && deleteMessage(m).catch(toastError)))
  }
  const removeEmbeds = () =>
    void ask({ title: t('Remove all embeds?'), body: <p>{t('The link previews of this message will be removed for everyone.')}</p>, confirm: t('Remove All Embeds'), danger: true })
      .then((ok) => void (ok && suppressEmbeds(m).catch(toastError)))
  const publish = () =>
    void ask({ title: t('Publish to followers?'), body: <p>{t('This message will be sent to every server following this channel.')}</p>, confirm: t('Publish') })
      .then((ok) => void (ok && crosspost(m).catch(toastError)))
  const forward = () => setState({ modal: { kind: 'forward', channelId: m.channel_id, messageId: m.id } })
  const createThread = () => setState({ modal: { kind: 'create-thread', channelId: m.channel_id, messageId: m.id } })
  const react = (el: Element) => setPicker({ rect: el.getBoundingClientRect(), side: 'left' })
  const authorMenu = (e: MouseEvent) => (e.preventDefault(), e.stopPropagation(), !m.webhook_id && afterRightRelease(() => setUserMenu({ x: e.clientX, y: e.clientY })))
  const tag = flags & IS_CROSSPOST ? t('SERVER') : m.webhook_id && !m.application_id ? t('BOT') : m.author.bot ? (m.author.module ? t('MODULE') : t('APP')) : null // interaction answers carry webhook_id = application_id but come from the app

  return (
    <li
      id={`msg-${m.id}`}
      className={cls(
        'msg',
        head && 'head',
        m.pending && 'pending',
        m.failed && 'failed',
        mentioned && 'mentioned',
        ephemeral && 'ephemeral',
        isSolution && 'is-solution',
        purgeSelected && 'purge-selected'
      )}
      tabIndex={-1}
      {...(sent && !ephemeral && !purgeMode && menu.props)}
      onClick={purgeMode ? () => togglePurgeSelect(m.id) : undefined}
    >
      {purgeMode && (
        <input
          type="checkbox"
          className="purge-checkbox"
          checked={purgeSelected}
          onChange={(e) => togglePurgeSelect(m.id, e.target.checked)}
          onClick={(e) => e.stopPropagation()}
          aria-label={t('Select message')}
          style={{ marginRight: '8px', cursor: 'pointer', alignSelf: 'center' }}
        />
      )}
      {m.message_reference && m.message_reference.type !== 1 && m.type === 19 && <ReplyPreview m={m} ctx={ctx} />}
      {(m.interaction_metadata || m.interaction) && <InteractionLine m={m} />}
      {head ? (
        <>
          <button className="avatar-btn" aria-label={`${author.name}'s profile`} tabIndex={-1} onClick={(e) => openProfile(m, e.currentTarget)} onContextMenu={authorMenu}>
            <Avatar user={author.user} src={author.avatar} size={36} />
          </button>
          <h3 className="msg-meta">
            <button className="author" onClick={(e) => openProfile(m, e.currentTarget)} onContextMenu={authorMenu}>
              <StyledName user={m.webhook_id ? undefined : author.user} member={author.member} guild={author.guild} name={author.name} tag={false} icon={false} />
            </button>
            {author.guild && author.member && <RoleIcon role={iconRole(author.guild, author.member)} />}
            {!m.webhook_id && <ServerTag user={author.user} />}
            {tag && <span className="bot-tag">{tag}</span>}
            <time dateTime={m.timestamp}>{stamp(m.timestamp)}</time>
            {Boolean(flags & SUPPRESS_NOTIFICATIONS) && <span className="silent-badge" title={t('Sent silently (no notification ping)')}>🔕 {t('(silent)')}</span>}
          </h3>
        </>
      ) : (
        <>
          <span className="sr-only">{author.name}</span>
          <time className="gutter-time" dateTime={m.timestamp}>{clock(m.timestamp)}</time>
        </>
      )}
      {plain && plain.state !== 'ok' ? (
        <div className="content e2ee-line"><Icon d={ICONS.lock} size={14} /> <span>{lockedText(plain)}</span></div>
      ) : editing ? (
        <EditBox m={m} done={() => setEditing(false)} />
      ) : flags & LOADING ? (
        <div className="content thinking" role="status"><span>{t('{name} is thinking…', { name: author.name })}</span><span className="dots" aria-hidden="true"><i /><i /><i /></span></div>
      ) : (
        m.content && !inviteOnly && (
          <div className="content">
            {isSolution && (
              <div className="solution-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '4px', background: 'color-mix(in srgb, var(--online) 20%, transparent)', color: 'var(--online)', padding: '2px 8px', borderRadius: '4px', fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>
                ✓ {t('Accepted Solution')}
              </div>
            )}
            <Markdown content={m.content} ctx={{ ...ctx, user: (id) => ctx.user(id) ?? displayName(m.mentions.find((u) => u.id === id)) }} />
            {m.edited_timestamp && (
              <button
                type="button"
                className="edited-btn link"
                style={{ fontSize: '11px', opacity: 0.6, cursor: 'pointer', background: 'none', border: 'none', padding: 0 }}
                onClick={() => setViewEdits(true)}
                title={t('View Edit History')}
              >
                {' '}{t('(edited)')}
              </button>
            )}
          </div>
        )
      )}
      <MessageLinkQuotes content={m.content} ctx={ctx} />
      {parseGameInvite(m.content) && <GameInviteCard data={parseGameInvite(m.content)!} />}
      {invites.map((code) => <ServerInviteCard key={code} code={code} mine={mine} />)}
      {forwarded && <Forwarded snap={forwarded} ctx={ctx} from={{ channelId: m.message_reference?.channel_id, messageId: m.message_reference!.message_id }} />}
      {m.poll && <PollView m={m} canVote={has(perms, P.READ_MESSAGE_HISTORY) && !!me && !m.pending} />}
      {m.pending && m.files?.length ? <Uploading m={m} /> : plain ? (plain.state === 'ok' && <E2eeFiles m={raw} files={plain.files} />) : <Attachments list={m.attachments} voice={!!(flags & IS_VOICE_MESSAGE)} />}
      <Stickers list={m.sticker_items} />
      {isBotCard(m) ? <BotCard m={m} ctx={ctx} /> : (
        <>
          <Embeds list={embeds} ctx={ctx} onRemove={canSuppress && sent ? removeEmbeds : undefined} />
          <MessageComponents m={m} />
        </>
      )}
      {m.module_accessory && <MessageAccessory m={m} />}
      <Reactions m={m} perms={perms} />
      {ephemeral && (
        <p className="ephemeral-note"><Icon d={ICONS.eye} size={14} /> {t('Only you can see this')} • <button className="link" onClick={dismiss}>{t('Dismiss message')}</button></p>
      )}
      {m.thread && <ThreadChip message={m} />}
      {m.failed && (
        <p className="send-error">
          {t('This message could not be sent.')} <button className="link" onClick={() => resend(m)}>{t('Retry')}</button>
        </p>
      )}
      {(sent || m.failed) && !editing && !ephemeral && (
        <div className="toolbar" role="group" aria-label={t('Message actions')}>
          {sent && canReact && (
            <button aria-label={t('Add Reaction')} title={t('Add Reaction')} onClick={(e) => react(e.currentTarget)}><Icon d={ICONS.smile} size={18} /></button>
          )}
          {sent && canPublish && (
            <button aria-label={t('Publish')} title={t('Publish')} onClick={publish}><Icon d={ICONS.announcement} size={18} /></button>
          )}
          {sent && canReply && (
            <button aria-label={t('Reply')} title={t('Reply')} onClick={reply}><Icon d={ICONS.reply} size={18} /></button>
          )}
          {sent && !encrypted && (
            <button aria-label={t('Forward')} title={t('Forward')} onClick={forward}><Icon d={ICONS.forward} size={18} /></button>
          )}
          {sent && (
            <button
              aria-label={bookmarked ? t('Remove Bookmark') : t('Bookmark Message')}
              title={bookmarked ? t('Remove Bookmark') : t('Bookmark Message')}
              aria-pressed={bookmarked}
              onClick={() => void toggleBookmark(m).then(() => toast(t(bookmarked ? 'Bookmark removed.' : 'Message bookmarked.')), toastError)}
            >
              <Icon d={ICONS.bookmark} size={18} />
            </button>
          )}
          {sent && threadable && !isThread(channel) && (
            <button aria-label={t('Create Thread')} title={t('Create Thread')} onClick={createThread}><Icon d={ICONS.thread} size={18} /></button>
          )}
          {sent && mine && !m.poll && m.type !== 21 && (!plain || plain.state === 'ok') && (
            <button ref={editButton} aria-label={t('Edit message')} title={t('Edit')} onClick={() => setEditing(true)}><Icon d={ICONS.pencil} size={18} /></button>
          )}
          {sent && (
            <button aria-label={t('More')} title={t('More')} aria-haspopup="menu" onClick={(e) => menu.openAt(e.currentTarget)}><Icon d={ICONS.more} size={18} /></button>
          )}
          {canDelete && (
            <button className="danger" aria-label={t('Delete message')} title={t('Delete')} onClick={remove}><Icon d={ICONS.trash} size={18} /></button>
          )}
        </div>
      )}
      {menu.at && (
        <Popover at={menu.at} onClose={menu.close} role="menu" label={t('Message actions')}>
          {canReact && <MenuItem onSelect={() => setPicker(menu.at)}>{t('Add Reaction')}</MenuItem>}
          {mine && !m.poll && m.type !== 21 && (!plain || plain.state === 'ok') && <MenuItem onSelect={() => setEditing(true)}>{t('Edit Message')}</MenuItem>}
          {canReply && <MenuItem onSelect={reply}>{t('Reply')}</MenuItem>}
          {!encrypted && <MenuItem onSelect={forward}>{t('Forward')}</MenuItem>}
          <MenuItem onSelect={() => void toggleBookmark(m).then(() => toast(t(bookmarked ? 'Bookmark removed.' : 'Message bookmarked.')), toastError)}>
            {bookmarked ? t('Remove Bookmark') : t('Bookmark Message')}
          </MenuItem>
          {threadable && <MenuItem onSelect={createThread}>{t('Create Thread')}</MenuItem>}
          {canPublish && <MenuItem onSelect={publish}>{t('Publish')}</MenuItem>}
          {canPin && <MenuItem onSelect={() => setPinned(m, !m.pinned).catch(toastError)}>{m.pinned ? t('Unpin Message') : t('Pin Message')}</MenuItem>}
          {canSuppress && <MenuItem onSelect={removeEmbeds}>{t('Remove Embeds')}</MenuItem>}
          <MenuItem onSelect={() => setRemind(menu.at)}>{t('Remind Me')}</MenuItem>
          {m.poll && mine && pollOpen && (
            <MenuItem onSelect={() => void ask({ title: t('End Poll Now?'), body: <p>{t('This will end the poll for everyone.')}</p>, confirm: t('End Now'), danger: true }).then((ok) => void (ok && endPoll(m).catch(toastError)))}>{t('End Poll Now')}</MenuItem>
          )}
          <MenuItem onSelect={() => navigator.clipboard.writeText(m.content)}>{t('Copy Text')}</MenuItem>
          <MenuItem onSelect={() => navigator.clipboard.writeText(`${apiOrigin()}/channels/${m.guild_id ?? '@me'}/${m.channel_id}/${m.id}`)}>{t('Copy Message Link')}</MenuItem>
          {dev && <MenuItem onSelect={() => navigator.clipboard.writeText(m.id)}>{t('Copy Message ID')}</MenuItem>}
          <AppsSection channelId={m.channel_id} type={3} targetId={m.id} />
          {channel?.guild_id && has(perms, P.MANAGE_MESSAGES) && !purgeMode && (
            <MenuItem onSelect={() => startPurgeMode(m.id)}>{t('Select Messages')}</MenuItem>
          )}
          {canManageSolution && (
            <MenuItem onSelect={() => void setThreadSolved(channel.id, isSolution ? null : m.id).catch(toastError)}>
              {isSolution ? t('Unmark Solution') : t('Mark as Solution')}
            </MenuItem>
          )}
          {(canDelete || !mine) && <MenuSep />}
          {!mine && !m.author.system && <MenuItem danger onSelect={() => setReport(true)}>{t('Report Message')}</MenuItem>}
          {canDelete && <MenuItem danger onSelect={() => remove()}>{t('Delete Message')}</MenuItem>}
        </Popover>
      )}
      {picker && (
        <EmojiPicker at={picker} guildId={m.guild_id} perms={perms} onClose={() => setPicker(null)}
          onPick={(_t, e) => toggleReaction(getState().messages[m.channel_id]?.find((x) => x.id === m.id) ?? m, e).catch(toastError)} />
      )}
      {report && <ReportDialog m={m} onClose={() => setReport(false)} />}
      {remind && <RemindMenu m={m} at={remind} onClose={() => setRemind(null)} />}
      {userMenu && <UserMenu userId={m.author.id} guildId={m.guild_id} channelId={m.channel_id} at={userMenu} onClose={() => setUserMenu(null)} />}
      {viewEdits && <EditHistoryModal messageId={m.id} channelId={m.channel_id} currentContent={m.content} onClose={() => setViewEdits(false)} />}
    </li>
  )
}

function EditBox({ m, done }: { m: Message; done: () => void }) {
  const [text, setText] = useState(m.content)
  const [error, setError] = useState('')
  const save = () => {
    const content = text.trim()
    if ((!content && !m.attachments.length) || content === m.content) return done()
    editMessage(m, content).then(done, (e: Error) => setError(e.message))
  }
  return (
    <div className="edit">
      <textarea
        className="edit-box"
        aria-label={t('Edit message')}
        value={text}
        maxLength={2000}
        autoFocus
        onFocus={(e) => e.currentTarget.setSelectionRange(text.length, text.length)}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            done()
          } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            save()
          }
        }}
      />
      <p className="hint small">
        {t('escape to')} <button className="link" onClick={done}>{t('cancel')}</button> · {t('enter to')} <button className="link" onClick={save}>{t('save')}</button>
      </p>
      {error && <p className="send-error" role="alert">{error}</p>}
    </div>
  )
}
