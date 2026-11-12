// Forum channel (type 15): post list or gallery with tags, search, sort, layout, "New Post"; posts open in the thread panel.
import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { archivedThreads, starterMessage, startThread } from '../actions'
import { cdn } from '../api'
import { HeaderTitle } from '../chat/Chat'
import { MenuItem, MenuLabel, MenuSep, Popover, type Anchor } from '../components/menu'
import { cls, Field, FormError, Icon, ICONS } from '../components/ui'
import { Markdown, relative } from '../markdown/Markdown'
import { useMdContext } from '../chat/MessageList'
import { has, P } from '../permissions'
import { activeThreads, memberName, usePerms } from '../selectors'
import { cmpId, useStore } from '../store'
import { openThread, PINNED, REQUIRE_TAG, snowflakeTime } from '../threads/util'
import type { Channel, Guild, Message } from '../types'
import { TagChip, TagPicker } from './Tags'
import { headerAccent } from '../custom/channel'
import './forum.css'

// Starter messages already fetched for post previews (null = none).
const previews = new Map<string, Message | null>()

function usePreview(postId: string) {
  const [m, setM] = useState(() => previews.get(postId))
  useEffect(() => {
    if (previews.has(postId)) return
    starterMessage(postId).then((x) => (previews.set(postId, x), setM(x)), () => previews.set(postId, null))
  }, [postId])
  return m
}

function PostCard({ post, forum, guild, gallery }: { post: Channel; forum: Channel; guild: Guild; gallery: boolean }) {
  const author = useStore((s) => memberName(s, guild.id, post.owner_id ?? ''))
  const open = useStore((s) => s.panel?.kind === 'thread' && s.panel.channelId === post.id)
  const ctx = useMdContext(guild)
  const first = usePreview(post.id)
  const tags = (post.applied_tags ?? []).flatMap((id) => forum.available_tags?.filter((th) => th.id === id) ?? [])
  const image = gallery ? first?.attachments.find((a) => a.content_type?.startsWith('image/')) : undefined
  const count = post.message_count ?? 0
  return (
    <li>
      <button className={cls('post-card', open && 'open')} aria-current={open || undefined} onClick={() => openThread(post)}>
        {image && <img className="post-image" src={cdn(image.proxy_url ?? image.url)} alt={image.description ?? ''} loading="lazy" />}
        <span className="post-main">
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            {tags.length > 0 && <span className="post-tags">{tags.map((th) => <TagChip key={th.id} tag={th} />)}</span>}
            {post.solved_message_id && (
              <span className="post-solved-badge" style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', padding: '1px 6px', borderRadius: '4px', background: 'color-mix(in srgb, var(--online) 20%, transparent)', color: 'var(--online)', fontSize: '11px', fontWeight: 600 }}>
                ✓ {t('Solved')}
              </span>
            )}
          </div>
          <span className="post-title">
            {(post.flags ?? 0) & PINNED ? <Icon d={ICONS.pin} size={14} className="post-pin" /> : null}
            <h3 className="ellipsis">{post.name}</h3>
          </span>
          <span className="post-preview">
            <strong>{author}: </strong>
            {first ? <Markdown content={first.content.split('\n')[0] || (first.attachments.length ? t('Attachment') : '')} ctx={ctx} /> : <span className="hint">…</span>}
          </span>
          <span className="post-meta hint small">
            <Icon d={ICONS.thread} size={14} /> {t(count === 1 ? '{n} message' : '{n} messages', { n: count })}
            {post.last_message_id && <> · {relative(snowflakeTime(post.last_message_id))}</>}
            {post.thread_metadata?.archived && ` · ${t('Closed')}`}
          </span>
        </span>
      </button>
    </li>
  )
}

function NewPost({ forum, onDone }: { forum: Channel; onDone: () => void }) {
  const perms = usePerms(forum.guild_id, forum.id)
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const needTag = !!((forum.flags ?? 0) & REQUIRE_TAG) && !!forum.available_tags?.length
  const ok = title.trim() && text.trim() && (!needTag || tags.length)
  const submit = () => {
    setBusy(true)
    startThread(forum.id, { name: title.trim(), message: { content: text.trim() }, applied_tags: tags, auto_archive_duration: forum.default_auto_archive_duration ?? 4320 }).then(
      (th) => (onDone(), openThread(th)),
      (e: Error) => (setError(e.message), setBusy(false)),
    )
  }
  return (
    <form className="new-post" aria-label={t('New post')} onSubmit={(e) => (e.preventDefault(), ok && submit())}>
      <Field label={t('Post Title')} value={title} maxLength={100} autoFocus required onChange={(e) => setTitle(e.target.value)} />
      <div className="field">
        <label htmlFor="post-body">{t('Message')}</label>
        <textarea id="post-body" className="input textarea" maxLength={2000} required value={text} onChange={(e) => setText(e.target.value)} />
      </div>
      {!!forum.available_tags?.length && (
        <div className="field">
          <span className="field-label">{needTag ? t('Tags (required)') : t('Tags')}</span>
          <TagPicker tags={forum.available_tags} selected={tags} onChange={setTags} canModerate={has(perms, P.MANAGE_THREADS)} label={t('Tags for this post')} />
        </div>
      )}
      <FormError error={error} />
      <div className="modal-actions">
        <button type="button" className="secondary" onClick={onDone}>{t('Cancel')}</button>
        <button className="primary" disabled={busy || !ok}>{t('Post')}</button>
      </div>
    </form>
  )
}

/** Main column for a forum channel (type 15). */
export function ForumView({ channel, guild }: { channel: Channel; guild: Guild }) {
  const s = useStore((x) => x)
  const perms = usePerms(guild.id, channel.id)
  const ctx = useMdContext(guild)
  const [q, setQ] = useState('')
  const [sel, setSel] = useState<string[]>([])
  const [solvedFilter, setSolvedFilter] = useState<'all' | 'solved' | 'unsolved'>('all')
  const [sort, setSort] = useState<0 | 1>(channel.default_sort_order === 1 ? 1 : 0) // 0 latest activity, 1 creation date
  const [gallery, setGallery] = useState(channel.default_forum_layout === 2)
  const [menu, setMenu] = useState<Anchor | null>(null)
  const [composing, setComposing] = useState(false)
  const [archived, setArchived] = useState<'no' | 'loading' | 'yes'>('no')
  const query = q.trim().toLowerCase()
  const showArchived = archived === 'yes'
  const all = [
    ...activeThreads(s, channel.id),
    ...(showArchived ? Object.values(s.channels).filter((c) => c.parent_id === channel.id && c.thread_metadata?.archived) : []),
  ]
  const posts = all
    .filter((p) => {
      if (query && !p.name?.toLowerCase().includes(query)) return false
      if (sel.length && !p.applied_tags?.some((th) => sel.includes(th))) return false
      if (solvedFilter === 'solved' && !p.solved_message_id) return false
      if (solvedFilter === 'unsolved' && p.solved_message_id) return false
      return true
    })
    .sort((a, b) =>
      Number(!!((b.flags ?? 0) & PINNED)) - Number(!!((a.flags ?? 0) & PINNED)) ||
      (sort === 0 ? cmpId(b.last_message_id ?? b.id, a.last_message_id ?? a.id) : cmpId(b.id, a.id)))
  const loadArchived = () => {
    setArchived('loading')
    archivedThreads(channel.id, 'public').then(() => setArchived('yes'), () => setArchived('no'))
  }
  return (
    <main className="chat forum" aria-label={t('Forum {name}', { name: channel.name ?? '' })}>
      <header className="chat-header" {...headerAccent(channel)}>
        <HeaderTitle channel={channel} />
      </header>
      <div className="forum-body">
        <div className="forum-toolbar">
          <input className="input" type="search" aria-label={t('Search posts')} placeholder={t('Search or create a post…')} value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="icon-btn" aria-label={t('Sort and view')} aria-haspopup="menu" title={t('Sort & View')} onClick={(e) => setMenu({ rect: e.currentTarget.getBoundingClientRect(), side: 'below' })}>
            <Icon d={ICONS.sort} />
          </button>
          {has(perms, P.SEND_MESSAGES) && <button className="primary" onClick={() => setComposing(true)}>{t('New Post')}</button>}
        </div>
        <div className="forum-filter-chips" style={{ display: 'flex', gap: '6px', margin: '8px 0', alignItems: 'center' }}>
          <button
            type="button"
            className={cls('chip-btn', solvedFilter === 'all' && 'active')}
            style={{ padding: '4px 10px', borderRadius: 'var(--radius-s)', fontSize: '12px', fontWeight: 500, cursor: 'pointer', background: solvedFilter === 'all' ? 'var(--accent)' : 'var(--card)', color: solvedFilter === 'all' ? 'var(--on-accent)' : 'var(--text)', border: 'none' }}
            onClick={() => setSolvedFilter('all')}
          >
            {t('All')}
          </button>
          <button
            type="button"
            className={cls('chip-btn', solvedFilter === 'solved' && 'active')}
            style={{ padding: '4px 10px', borderRadius: 'var(--radius-s)', fontSize: '12px', fontWeight: 500, cursor: 'pointer', background: solvedFilter === 'solved' ? 'var(--online-strong)' : 'var(--card)', color: solvedFilter === 'solved' ? '#fff' : 'var(--text)', border: 'none' }}
            onClick={() => setSolvedFilter('solved')}
          >
            ✓ {t('Solved')}
          </button>
          <button
            type="button"
            className={cls('chip-btn', solvedFilter === 'unsolved' && 'active')}
            style={{ padding: '4px 10px', borderRadius: 'var(--radius-s)', fontSize: '12px', fontWeight: 500, cursor: 'pointer', background: solvedFilter === 'unsolved' ? 'var(--accent)' : 'var(--card)', color: solvedFilter === 'unsolved' ? 'var(--on-accent)' : 'var(--text)', border: 'none' }}
            onClick={() => setSolvedFilter('unsolved')}
          >
            {t('Unsolved')}
          </button>
        </div>
        {!!channel.available_tags?.length && (
          <TagPicker tags={channel.available_tags} selected={sel} onChange={setSel} canModerate label={t('Filter posts by tag')} />
        )}
        {channel.topic && (
          <section className="forum-guidelines" aria-label={t('Post guidelines')}>
            <h2 className="list-heading">{t('Post Guidelines')}</h2>
            <Markdown content={channel.topic} ctx={ctx} />
          </section>
        )}
        {composing && <NewPost forum={channel} onDone={() => setComposing(false)} />}
        <p className="sr-only" aria-live="polite">{t(posts.length === 1 ? '{n} post' : '{n} posts', { n: posts.length })}</p>
        {posts.length ? (
          <ul className={cls('posts', gallery && 'gallery')} aria-label={t('Posts')}>
            {posts.map((p) => <PostCard key={p.id} post={p} forum={channel} guild={guild} gallery={gallery} />)}
          </ul>
        ) : (
          <p className="hint forum-empty">{all.length ? t('No posts match your filters.') : t('There are no posts yet. Be the first!')}</p>
        )}
        {archived !== 'yes' && (
          <button className="link forum-more" disabled={archived === 'loading'} onClick={loadArchived}>{archived === 'loading' ? t('Loading…') : t('Show archived posts')}</button>
        )}
      </div>
      {menu && (
        <Popover at={menu} onClose={() => setMenu(null)} role="menu" label={t('Sort and view')}>
          <MenuLabel>{t('Sort By')}</MenuLabel>
          <MenuItem checked={sort === 0} onSelect={() => setSort(0)}>{t('Recent Activity')}</MenuItem>
          <MenuItem checked={sort === 1} onSelect={() => setSort(1)}>{t('Creation Date')}</MenuItem>
          <MenuSep />
          <MenuLabel>{t('View As')}</MenuLabel>
          <MenuItem checked={!gallery} onSelect={() => setGallery(false)}>{t('List')}</MenuItem>
          <MenuItem checked={gallery} onSelect={() => setGallery(true)}>{t('Gallery')}</MenuItem>
        </Popover>
      )}
    </main>
  )
}
