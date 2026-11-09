// Thread side panel: header actions (members, join/leave, archive, lock, tags, pin) and the thread's chat.
import { t } from '../i18n'
import { apiOrigin } from '../api'
import { useEffect, useRef, useState } from 'react'
import { deleteChannel, joinThread, leaveThread } from '../actions'
import { ChatBody } from '../chat/Chat'
import { ask, askText, toastError } from '../components/dialogs'
import { MenuItem, MenuSep, Popover, type Anchor } from '../components/menu'
import { Icon, ICONS } from '../components/ui'
import { ResizeHandle } from '../components/ResizeHandle'
import { TagPickerModal } from '../forum/Tags'
import { has, P } from '../permissions'
import { navigate } from '../router'
import { usePerms } from '../selectors'
import { setState, useStore } from '../store'
import { ThreadMembersButton } from './ThreadMembers'
import { patchThread, PINNED } from './util'
import './threads.css'

/** Right-hand panel showing one thread (store `panel.kind === 'thread'`). */
export function ThreadPanel({ channelId }: { channelId: string }) {
  const th = useStore((s) => s.channels[channelId])
  const parent = useStore((s) => (th?.parent_id ? s.channels[th.parent_id] : undefined))
  const guild = useStore((s) => (th?.guild_id ? s.guilds[th.guild_id] : undefined))
  const meId = useStore((s) => s.me?.id)
  const perms = usePerms(guild?.id, channelId)
  const [menu, setMenu] = useState<Anchor | null>(null)
  const [tags, setTags] = useState(false)
  const title = useRef<HTMLHeadingElement>(null)
  // Focus moves into the panel when it opens and back to the opener when it closes.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    title.current?.focus()
    return () => void (opener?.isConnected && opener.focus())
  }, [])
  useEffect(() => void (!th && setState({ panel: null })), [th])
  if (!th || !guild) return null
  const close = () => setState({ panel: null })
  const manage = has(perms, P.MANAGE_THREADS)
  const owner = th.owner_id === meId
  const meta = th.thread_metadata
  const post = parent?.type === 15
  const run = (p: Promise<unknown>) => void p.catch(toastError)
  const remove = () =>
    void ask({ title: post ? t('Delete Post') : t('Delete Thread'), body: <p>{t('Are you sure you want to delete {name}? This cannot be undone.', { name: th.name ?? '' })}</p>, confirm: t('Delete'), danger: true })
      .then((ok) => ok && run(deleteChannel(th).then(close)))
  const rename = () =>
    void askText({ title: post ? t('Edit Post Title') : t('Rename Thread'), label: post ? t('Post Title') : t('Thread Name'), initial: th.name ?? '', maxLength: 100 })
      .then((name) => name && run(patchThread(th, { name: name.trim() })))

  return (
    <aside className="side-panel thread-panel" aria-label={t('Thread {name}', { name: th.name ?? '' })} onKeyDown={(e) => e.key === 'Escape' && e.target === e.currentTarget && close()}>
      <ResizeHandle
        id="thread-panel-resizer"
        side="left"
        defaultValue={360}
        min={280}
        max={760}
        storageKey="cillhub:side-panel-width"
        cssVar="--side-panel-width"
        ariaLabel={t('Resize thread panel')}
      />
      <header className="panel-header">
        <Icon d={ICONS.thread} size={20} className="chan-icon" />
        <h2 ref={title} tabIndex={-1} className="ellipsis">{th.name}</h2>
        {th.type === 12 && <Icon d={ICONS.lock} size={14} className="hint" />}
        <span className="spacer" />
        <ThreadMembersButton thread={th} guild={guild} />
        {th.member ? (
          <button className="secondary small-btn" onClick={() => run(leaveThread(th))}>{t('Leave Thread')}</button>
        ) : (
          <button className="primary small-btn" onClick={() => run(joinThread(th))}>{t('Join Thread')}</button>
        )}
        <button className="icon-btn" aria-label={t('Thread options')} aria-haspopup="menu" onClick={(e) => setMenu({ rect: e.currentTarget.getBoundingClientRect(), side: 'below' })}>
          <Icon d={ICONS.more} />
        </button>
        <button className="icon-btn" aria-label={t('Close thread')} title={t('Close')} onClick={close}><Icon d={ICONS.close} /></button>
      </header>
      {meta?.archived && (
        <p className="notice thread-notice" role="status">
          {meta.locked ? t('This thread is archived and locked. Only moderators can reopen it.') : t('This thread is archived. Sending a message will unarchive it.')}
        </p>
      )}
      {!meta?.archived && meta?.locked && <p className="notice thread-notice" role="status">{t('This thread is locked. Only moderators can send messages.')}</p>}
      <ChatBody channel={th} guild={guild} />
      {menu && (
        <Popover at={menu} onClose={() => setMenu(null)} role="menu" label={t('Thread options')}>
          {(manage || owner) && <MenuItem onSelect={rename}>{post ? t('Edit Title') : t('Rename Thread')}</MenuItem>}
          {post && (manage || owner) && <MenuItem onSelect={() => setTags(true)}>{t('Edit Tags')}</MenuItem>}
          {post && manage && <MenuItem onSelect={() => run(patchThread(th, { flags: (th.flags ?? 0) ^ PINNED }))}>{(th.flags ?? 0) & PINNED ? t('Unpin Post') : t('Pin Post')}</MenuItem>}
          {(manage || (owner && !meta?.locked)) && (
            <MenuItem onSelect={() => run(patchThread(th, { archived: !meta?.archived }))}>{meta?.archived ? (post ? t('Reopen Post') : t('Unarchive Thread')) : post ? t('Close Post') : t('Archive Thread')}</MenuItem>
          )}
          {manage && <MenuItem onSelect={() => run(patchThread(th, { locked: !meta?.locked }))}>{meta?.locked ? (post ? t('Unlock Post') : t('Unlock Thread')) : post ? t('Lock Post') : t('Lock Thread')}</MenuItem>}
          <MenuItem onSelect={() => (close(), navigate(`/channels/${guild.id}/${th.id}`))}>{t('Open in Full View')}</MenuItem>
          <MenuItem onSelect={() => void navigator.clipboard.writeText(`${apiOrigin()}/channels/${guild.id}/${th.id}`)}>{t('Copy Link')}</MenuItem>
          {manage && (
            <>
              <MenuSep />
              <MenuItem danger onSelect={remove}>{post ? t('Delete Post') : t('Delete Thread')}</MenuItem>
            </>
          )}
        </Popover>
      )}
      {tags && parent && <TagPickerModal forum={parent} selected={th.applied_tags ?? []} canModerate={manage} onSave={(ids) => patchThread(th, { applied_tags: ids })} onClose={() => setTags(false)} />}
    </aside>
  )
}
