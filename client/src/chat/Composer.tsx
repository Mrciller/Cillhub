import { useEffect, useId, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import { fetchSnippets, loadMembers, sendMessage, sendSticker, sendTyping, unblockUser } from '../actions'
import { CommandForm, CommandPicker } from '../commands/CommandUi'
import { flatten, useIndex, type Entry } from '../commands/commands'
import { t } from '../i18n'
import { toastError } from '../components/dialogs'
import { MenuItem, Popover, type Anchor } from '../components/menu'
import { cls, formatSize, Icon, ICONS, Modal } from '../components/ui'
import { ExpressionPicker, type Tab } from '../expressions/ExpressionPicker'
import { CustomEmoji } from '../markdown/Markdown'
import { bypassesSlowmode, has, P, timedOutUntil, verificationWait } from '../permissions'
import { formatGameInviteUrl } from './GameInvite'
import { PollComposer } from '../polls/PollComposer'
import { SendLaterModal } from '../scheduling/Scheduling'
import { isBlocked, memberName, myMember } from '../selectors'
import { clearDraft, getState, setDraft, setState, useStore } from '../store'
import { Switch } from '../settings/Layout'
import type { Channel, Draft } from '../types'
import { resolveMentions, setCachedSnippets, suggest } from './suggest'
import { VoiceRecorder } from './VoiceRecorder'

const TYPING_EVERY_MS = 8000
export const MAX_FILES = 10
const MAX_SIZE = 25 * 1024 * 1024

type Ac = { trigger: '@' | '#' | ':' | '!'; query: string; start: number }
type Props = { channel: Channel; label: string; perms: bigint; files: Draft[]; setFiles: (f: Draft[]) => void; addFiles: (f: File[]) => void }

const clockText = (ms: number) => {
  const s = Math.ceil(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${m}m` : m ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

/** Re-renders every second while `active`, for countdowns. */
function useTick(active: boolean) {
  const [, set] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => set((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [active])
}

function FileChip({ d, onChange, onRemove }: { d: Draft; onChange: (d: Draft) => void; onRemove: () => void }) {
  const { file } = d
  const url = useMemo(() => (file.type.startsWith('image/') ? URL.createObjectURL(file) : null), [file])
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url])
  const [editing, setEditing] = useState(false)
  return (
    <li className={cls('file-chip', file.size > MAX_SIZE && 'too-big', d.spoiler && 'spoilered')}>
      {url ? <img src={url} alt={d.description} /> : <Icon d={ICONS.file} size={40} className="file-icon" />}
      {d.spoiler && <span className="chip-spoiler" aria-hidden="true">{t('SPOILER')}</span>}
      <span className="ellipsis">{file.name}</span>
      <span className="hint small">{file.size > MAX_SIZE ? t('Too large (max 25 MB)') : formatSize(file.size)}</span>
      <span className="chip-actions">
        <button className="icon-btn" aria-label={d.spoiler ? t('Remove spoiler from {name}', { name: file.name }) : t('Spoiler {name}', { name: file.name })} aria-pressed={d.spoiler} title={t('Spoiler Attachment')} onClick={() => onChange({ ...d, spoiler: !d.spoiler })}>
          <Icon d={d.spoiler ? ICONS.eyeOff : ICONS.eye} size={16} />
        </button>
        <button className="icon-btn" aria-label={t('Edit {name}', { name: file.name })} title={t('Modify Attachment')} onClick={() => setEditing(true)}>
          <Icon d={ICONS.pencil} size={16} />
        </button>
        <button className="icon-btn chip-remove" aria-label={t('Remove {name}', { name: file.name })} title={t('Remove Attachment')} onClick={onRemove}>
          <Icon d={ICONS.trash} size={16} />
        </button>
      </span>
      {editing && <EditDraft d={d} onSave={(x) => (onChange(x), setEditing(false))} onClose={() => setEditing(false)} />}
    </li>
  )
}

function EditDraft({ d, onSave, onClose }: { d: Draft; onSave: (d: Draft) => void; onClose: () => void }) {
  const [description, setDescription] = useState(d.description)
  const [spoiler, setSpoiler] = useState(d.spoiler)
  return (
    <Modal title={d.file.name} onClose={onClose}>
      <form onSubmit={(e) => (e.preventDefault(), onSave({ ...d, description, spoiler }))}>
        <div className="field">
          <label htmlFor="alt-text">{t('Description (alt text)')}</label>
          <textarea id="alt-text" className="input textarea" maxLength={1024} value={description} autoFocus placeholder={t('Describe this file for people using screen readers')} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <Switch label={t('Mark as spoiler')} checked={spoiler} onChange={setSpoiler} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className="primary">{t('Save')}</button>
        </div>
      </form>
    </Modal>
  )
}

/** Why the user cannot type here right now, if a reason other than permissions applies (rules screening, timeout, verification level). */
function useBlock(channel: Channel) {
  const guild = useStore((s) => (channel.guild_id ? s.guilds[channel.guild_id] : undefined))
  const member = useStore((s) => myMember(s, channel.guild_id))
  const meId = useStore((s) => s.me?.id ?? '')
  const timeout = timedOutUntil(member)
  const wait = guild ? verificationWait(guild, meId, member) : 0
  useTick(!!timeout || !!wait)
  const blocked = useStore((s) => channel.type === 1 && !!channel.recipients?.[0] && isBlocked(s, channel.recipients[0].id))
  if (blocked) return { kind: 'blocked' as const, userId: channel.recipients![0].id }
  if (member?.pending) return { kind: 'rules' as const }
  if (timeout) return { kind: 'timeout' as const, left: timeout - Date.now() }
  if (wait) return { kind: 'verify' as const, left: wait, level: guild?.verification_level ?? 0 }
  return null
}

export function Composer({ channel, label, perms, files, setFiles, addFiles }: Props) {
  const [text, setText] = useState(() => getState().drafts[channel.id]?.content ?? '')
  const [ac, setAc] = useState<Ac | null>(null)
  const [sel, setSel] = useState(0)
  const [picker, setPicker] = useState<{ at: Anchor; tab: Tab } | null>(null)
  const [plus, setPlus] = useState<Anchor | null>(null)
  const [polling, setPolling] = useState(false)
  const [later, setLater] = useState<string | null>(null) // composed text waiting in the Send later dialog
  const [command, setCommand] = useState<Entry | null>(null)
  const slash = !command && /^\/[^\n]*$/.test(text) && text.split(' ').length <= 3
  const tokens = useRef<[string, string][]>([]) // inserted "@name" / ":emoji:" -> "<@id>" / "<:emoji:id>"
  const box = useRef<HTMLTextAreaElement>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const lastTyping = useRef(0)
  const listId = useId()
  const replying = useStore((s) => (s.replying?.channelId === channel.id ? s.replying : null))
  const replyName = useStore((s) => {
    const m = replying && s.messages[channel.id]?.find((x) => x.id === replying.messageId)
    return m ? memberName(s, channel.guild_id, m.author.id) : ''
  })
  const membersLoaded = useStore((s) => !channel.guild_id || !!s.membersLoaded[channel.guild_id])
  const cooldownUntil = useStore((s) => s.slowmode[channel.id] ?? 0)
  const block = useBlock(channel)
  const slow = (channel.rate_limit_per_user ?? 0) > 0 && !bypassesSlowmode(perms)
  const cooling = cooldownUntil > Date.now()
  useTick(cooling)
  const leagueLobby = useStore((s) => s.leagueLobby)
  const canSend = has(perms, P.SEND_MESSAGES) && !block
  const canAttach = canSend && has(perms, P.ATTACH_FILES)
  const canPoll = canSend && has(perms, P.SEND_POLLS)
  const canVoice = canSend && has(perms, P.SEND_VOICE_MESSAGES)
  const index = useIndex(channel, slash)
  const query = slash ? text.slice(1).toLowerCase() : ''
  const commands = slash && index && has(perms, P.USE_APPLICATION_COMMANDS) ? flatten(index, channel, perms).filter((e) => e.path.join(' ').startsWith(query) || (query.length > 1 && e.path.join(' ').includes(query))).slice(0, 12) : []
  const pickCommand = (e: Entry) => (setCommand(e), setText(''), setAc(null))
  const items = ac && !commands.length ? suggest(getState(), channel, perms, ac.trigger, ac.query) : []
  const active = items[Math.min(sel, items.length - 1)]
  const tooBig = files.some((f) => f.file.size > MAX_SIZE)
  const archived = !!channel.thread_metadata?.archived

  // Restore draft when switching channels
  useEffect(() => {
    const d = getState().drafts[channel.id]
    setText(d?.content ?? '')
    if (d?.replyToId) {
      setState({ replying: { channelId: channel.id, messageId: d.replyToId } })
    }
  }, [channel.id])

  // Sync draft when reply state changes
  useEffect(() => {
    setDraft(channel.id, text, replying?.messageId)
  }, [channel.id, replying?.messageId])

  const onTextChange = (nextText: string) => {
    setText(nextText)
    setDraft(channel.id, nextText, replying?.messageId)
  }

  // Ctrl+E and Ctrl+Shift+U (keyboard/shortcuts.ts) reach the composer of the open chat through window events.
  useEffect(() => {
    const emoji = () => {
      if (!canSend) return
      if (box.current) setPicker({ at: { rect: box.current.getBoundingClientRect(), side: 'above' }, tab: 'emoji' })
    }
    const upload = () => {
      if (!canSend || !canAttach) return
      fileInput.current?.click()
    }
    addEventListener('cillcord:emoji', emoji)
    addEventListener('cillcord:upload', upload)
    return () => (removeEventListener('cillcord:emoji', emoji), removeEventListener('cillcord:upload', upload))
  }, [canSend, canAttach])
  useEffect(() => {
    if (ac?.trigger === '@' && !membersLoaded && channel.guild_id) loadMembers(channel.guild_id).catch(() => {})
  }, [ac?.trigger, membersLoaded, channel.guild_id])

  useEffect(() => {
    if (channel.guild_id) {
      fetchSnippets(channel.guild_id).then((r) => setCachedSnippets(channel.guild_id!, r.snippets ?? [])).catch(() => {})
    }
  }, [channel.guild_id])

  const track = (value: string, caret: number) => {
    const m = /(^|\s)([@#])([^\s@#]{0,32})$/.exec(value.slice(0, caret))
      ?? /(^|\s)(:)([\w+-]{2,32})$/.exec(value.slice(0, caret))
      ?? /(^)(!)([a-z0-9_-]{0,32})$/i.exec(value.slice(0, caret))
    setAc(m ? { trigger: (m[2] ?? m[1]) as Ac['trigger'], query: m[3], start: caret - m[3].length - 1 } : null)
    setSel(0)
  }

  const insertAt = (start: number, end: number, insert: string) => {
    const el = box.current
    const next = text.slice(0, start) + insert + text.slice(end)
    onTextChange(next)
    const pos = start + insert.length
    requestAnimationFrame(() => (el?.focus(), el?.setSelectionRange(pos, pos)))
  }

  const pick = (i: number) => {
    const it = items[i]
    const el = box.current
    if (!it || !ac || !el) return
    if (it.insert !== it.syntax) tokens.current.push([it.insert, it.syntax])
    insertAt(ac.start, el.selectionStart, it.insert + ' ')
    setAc(null)
  }

  /** The text as it will be sent: inserted mentions and emoji back to their syntax. */
  const compose = () => {
    let content = text.trim()
    for (const [shown, syntax] of [...tokens.current].sort((a, b) => b[0].length - a[0].length)) content = content.split(shown).join(syntax)
    return resolveMentions(getState(), channel, content)
  }
  const clear = () => {
    setText('')
    setFiles([])
    tokens.current = []
    lastTyping.current = 0
    clearDraft(channel.id)
    setState({ replying: null })
  }
  const send = () => {
    if (cooling) return
    const content = compose()
    if ((!content && !files.length) || tooBig || content.length > 2000) return
    clear()
    void sendMessage(channel, content, files, replying ? { messageId: replying.messageId } : undefined)
  }

  const wrapSelection = (marker: string) => {
    const el = box.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const selected = text.slice(start, end)
    const next = text.slice(0, start) + marker + selected + marker + text.slice(end)
    onTextChange(next)
    requestAnimationFrame(() => {
      el.focus()
      if (selected) el.setSelectionRange(start + marker.length, end + marker.length)
      else el.setSelectionRange(start + marker.length, start + marker.length)
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return
    if ((e.ctrlKey || e.metaKey) && !e.altKey) {
      const k = e.key.toLowerCase()
      if (!e.shiftKey && k === 'b') return e.preventDefault(), wrapSelection('**')
      if (!e.shiftKey && k === 'i') return e.preventDefault(), wrapSelection('*')
      if (!e.shiftKey && k === 'u') return e.preventDefault(), wrapSelection('__')
      if (e.shiftKey && k === 'x') return e.preventDefault(), wrapSelection('~~')
    }
    if (commands.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        return setSel((i) => (Math.min(i, commands.length - 1) + (e.key === 'ArrowDown' ? 1 : -1) + commands.length) % commands.length)
      }
      if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), pickCommand(commands[Math.min(sel, commands.length - 1)])
    }
    if (ac && items.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        return setSel((i) => (Math.min(i, items.length - 1) + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length)
      }
      if (e.key === 'Enter' || e.key === 'Tab') return e.preventDefault(), pick(Math.min(sel, items.length - 1))
      if (e.key === 'Escape') return e.preventDefault(), e.stopPropagation(), setAc(null)
    }
    if (e.key === 'Enter' && !e.shiftKey) return e.preventDefault(), send()
    if (e.key === 'Escape' && replying) return e.preventDefault(), setState({ replying: null })
    if (e.key === 'ArrowUp' && !text) {
      const me = getState().me?.id
      const last = getState().messages[channel.id]?.findLast((m) => m.author.id === me && !m.pending && !m.failed && m.type !== 7 && !m.poll)
      if (last) e.preventDefault(), setState({ editingId: last.id })
    }
  }

  const onPaste = (e: ClipboardEvent) => {
    const pasted = [...e.clipboardData.files]
    if (!pasted.length || !canAttach) return
    e.preventDefault()
    addFiles(pasted)
  }

  if (block)
    return (
      <div className="composer">
        <div className="composer-blocked" role="status">
          {block.kind === 'blocked' ? (
            <>
              <Icon d={ICONS.block} size={20} />
              <span>{t('You cannot send messages to a user you have blocked.')}</span>
              <button className="secondary small-btn" onClick={() => void unblockUser(block.userId).catch(toastError)}>{t('Unblock')}</button>
            </>
          ) : block.kind === 'rules' ? (
            <>
              <Icon d={ICONS.shield} size={20} />
              <span>{t('Finish the rules screening to start talking.')}</span>
              <button className="primary small-btn" onClick={() => setState({ modal: { kind: 'rules', guildId: channel.guild_id! } })}>{t('Complete')}</button>
            </>
          ) : block.kind === 'timeout' ? (
            <>
              <Icon d={ICONS.clock} size={20} />
              <span>{t("You're timed out. You can talk again in {time}.", { time: clockText(block.left) })}</span>
            </>
          ) : (
            <>
              <Icon d={ICONS.clock} size={20} />
              <span>{block.level >= 2 ? t('This server requires members to be here for 5 minutes before talking. Wait {time}.', { time: clockText(block.left) }) : t('This server requires accounts to be 5 minutes old before talking. Wait {time}.', { time: clockText(block.left) })}</span>
            </>
          )}
        </div>
      </div>
    )

  return (
    <div className="composer">
      {commands.length > 0 && <CommandPicker entries={commands} sel={Math.min(sel, commands.length - 1)} listId={listId} onPick={pickCommand} onHover={setSel} />}
      {ac && items.length > 0 && (
        <div className="autocomplete">
          <h3 className="list-heading">
            {ac.trigger === '#' ? t('Text Channels') : ac.trigger === ':' ? t('Emoji') : t('Members')}
            {ac.query && <> {t('matching')} <strong>{ac.trigger}{ac.query}</strong></>}
          </h3>
          <ul id={listId} role="listbox" aria-label={t('Suggestions')}>
            {items.map((it, i) => (
              <li
                key={it.key}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={it === active}
                className={cls('ac-item', it === active && 'active')}
                onMouseDown={(e) => (e.preventDefault(), pick(i))}
                onMouseEnter={() => setSel(i)}
              >
                {it.kind === 'emoji' && (it.emoji?.id ? <CustomEmoji id={it.emoji.id} name={it.label.slice(1, -1)} animated={it.emoji.animated} /> : <span className="ac-emoji" aria-hidden="true">{it.emoji?.char}</span>)}
                <span className="ac-label" style={{ color: it.color }}>{it.kind === 'channel' ? `#${it.label}` : it.label}</span>
                {it.sub && <span className="hint small ellipsis">{it.sub}</span>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {replying && (
        <div className="reply-bar">
          <span>{t('Replying to')} <strong>{replyName || t('a message')}</strong></span>
          <button className="icon-btn tiny" aria-label={t('Cancel reply')} onClick={() => setState({ replying: null })}><Icon d={ICONS.close} size={16} /></button>
        </div>
      )}
      <div className={cls('composer-box', (replying || files.length > 0) && 'attached')}>
        {files.length > 0 && (
          <ul className="file-chips" aria-label={t('Attachments to send')}>
            {files.map((f, i) => (
              <FileChip key={`${f.file.name}-${i}`} d={f} onChange={(d) => setFiles(files.with(i, d))} onRemove={() => setFiles(files.filter((_, j) => j !== i))} />
            ))}
          </ul>
        )}
        {command ? <CommandForm channel={channel} entry={command} onClose={() => (setCommand(null), requestAnimationFrame(() => box.current?.focus()))} /> : (
        <div className="composer-row">
          {(canAttach || canPoll) && (
            <>
              <button className="icon-btn" aria-label={t('Upload a file or create a poll')} aria-haspopup="menu" title={t('More options')} onClick={(e) => setPlus({ rect: e.currentTarget.getBoundingClientRect(), side: 'above' })}>
                <Icon d={ICONS.addCircle} size={24} />
              </button>
              {canAttach && <input ref={fileInput} type="file" multiple hidden onChange={(e) => (addFiles([...(e.target.files ?? [])]), (e.target.value = ''))} />}
            </>
          )}
          <textarea
            ref={box}
            rows={1}
            maxLength={4000}
            value={text}
            disabled={!canSend}
            aria-label={t('Message {label}', { label })}
            aria-autocomplete="list"
            aria-controls={(ac && items.length) || commands.length ? listId : undefined}
            aria-activedescendant={commands.length ? `${listId}-${Math.min(sel, commands.length - 1)}` : ac && active ? `${listId}-${items.indexOf(active)}` : undefined}
            placeholder={!canSend ? (channel.thread_metadata?.locked ? t('This thread is locked.') : t('You do not have permission to send messages in this channel.')) : archived ? t('Message {label} (sending unarchives it)', { label }) : t('Message {label}', { label })}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            // Caret moves re-check the autocomplete (onSelect would also fire on the Escape that closed it).
            onKeyUp={(e) => ac && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key) && track(e.currentTarget.value, e.currentTarget.selectionStart)}
            onClick={(e) => ac && track(e.currentTarget.value, e.currentTarget.selectionStart)}
            onBlur={() => setAc(null)}
            onChange={(e) => {
              onTextChange(e.target.value)
              track(e.target.value, e.target.selectionStart)
              if (e.target.value && Date.now() - lastTyping.current > TYPING_EVERY_MS) {
                lastTyping.current = Date.now()
                sendTyping(channel.id)
              }
            }}
          />
          {canSend && (
            <>
              <button className="icon-btn" aria-label={t('Open GIF picker')} title={t('GIFs')} onClick={(e) => setPicker({ at: { rect: e.currentTarget.getBoundingClientRect(), side: 'above' }, tab: 'gif' })}>
                <Icon d={ICONS.gif} size={22} />
              </button>
              <button className="icon-btn" aria-label={t('Open GIF and sticker picker')} title={t('Stickers')} onClick={(e) => setPicker({ at: { rect: e.currentTarget.getBoundingClientRect(), side: 'above' }, tab: 'sticker' })}>
                <Icon d={ICONS.sticker} size={22} />
              </button>
              <button className="icon-btn" aria-label={t('Select emoji')} title={t('Select emoji')} onClick={(e) => setPicker({ at: { rect: e.currentTarget.getBoundingClientRect(), side: 'above' }, tab: 'emoji' })}>
                <Icon d={ICONS.smile} size={24} />
              </button>
              {text.trim() && !files.length && text.trim().length <= 2000 && (
                <button className="icon-btn" aria-label={t('Send later')} title={t('Send later')} onClick={() => setLater(compose())}>
                  <Icon d={ICONS.clock} size={22} />
                </button>
              )}
              {canVoice && !text && !files.length && <VoiceRecorder channel={channel} />}
            </>
          )}
        </div>
        )}
      </div>
      {slow && (
        <p className="slowmode" aria-live="polite">
          <Icon d={ICONS.clock} size={14} />
          {cooling ? <>{t('Slowmode is enabled. You can send again in')} <strong>{clockText(cooldownUntil - Date.now())}</strong>.</> : t('Slowmode is enabled: one message every {time}.', { time: clockText((channel.rate_limit_per_user ?? 0) * 1000) })}
        </p>
      )}
      {text.trim().length > 2000 && <p className="send-error" role="alert">{t('Messages can be at most 2000 characters ({n}).', { n: text.trim().length })}</p>}
      {files.length >= MAX_FILES && <p className="hint small">{t('You can attach up to {n} files.', { n: MAX_FILES })}</p>}
      {plus && (
        <Popover at={plus} onClose={() => setPlus(null)} role="menu" label={t('More options')}>
          {canAttach && <MenuItem onSelect={() => fileInput.current?.click()}>{t('Upload a File')}</MenuItem>}
          {canPoll && <MenuItem onSelect={() => setPolling(true)}>{t('Create Poll')}</MenuItem>}
          {leagueLobby && (
            <MenuItem
              onSelect={() => {
                const inviteText = `${t('Join my League of Legends party!')}\n${formatGameInviteUrl({
                  game: 'League of Legends',
                  queueName: leagueLobby.queueName,
                  queueId: leagueLobby.queueId,
                  partyId: leagueLobby.partyId,
                  hostName: leagueLobby.hostName,
                  hostPuuid: leagueLobby.hostPuuid,
                  members: leagueLobby.members,
                  maxMembers: leagueLobby.maxMembers,
                })}`
                void sendMessage(channel, inviteText).catch(toastError)
              }}
            >
              🎮 {t('Share League Lobby ({members}/{max})', { members: leagueLobby.members, max: leagueLobby.maxMembers })}
            </MenuItem>
          )}
        </Popover>
      )}
      {polling && <PollComposer channel={channel} onClose={() => setPolling(false)} />}
      {later !== null && <SendLaterModal channel={channel} content={later} onDone={clear} onClose={() => (setLater(null), box.current?.focus())} />}
      {picker && (
        <ExpressionPicker
          at={picker.at}
          initial={picker.tab}
          guildId={channel.guild_id}
          perms={perms}
          onClose={() => setPicker(null)}
          onEmoji={(raw, ref) => {
            const el = box.current
            const at = el?.selectionStart ?? text.length
            const shown = ref.id ? `:${ref.name}:` : raw
            if (ref.id) tokens.current.push([shown, raw])
            insertAt(at, el?.selectionEnd ?? at, shown)
          }}
          onSticker={(st) => void sendSticker(channel, st.id).catch(toastError)}
          onGif={(g) => void sendMessage(channel, g.url)}
        />
      )}
    </div>
  )
}
