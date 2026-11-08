// Search results panel: paging (25 per page), sort, results grouped by channel, jump to any result (loads around it if needed).
import { t } from '../i18n'
import { useEffect, useMemo, useState } from 'react'
import { openMessage, searchMessages, type SearchResult } from '../actions'
import { ApiError } from '../api'
import { useMdContext } from '../chat/MessageList'
import { stamp } from '../chat/MessageItem'
import { Avatar, cls, Icon, ICONS } from '../components/ui'
import { ResizeHandle } from '../components/ResizeHandle'
import { Markdown } from '../markdown/Markdown'
import { displayName, getState, setState, useStore } from '../store'
import { parseQuery } from './query'
import './search.css'

const PER_PAGE = 25
type Sort = 'newest' | 'oldest' | 'relevance'

export function SearchPanel({ guildId, channelId, query }: { guildId?: string; channelId?: string; query: string }) {
  const guild = useStore((s) => (guildId ? s.guilds[guildId] : undefined))
  const channels = useStore((s) => s.channels)
  const ctx = useMdContext(guild)
  const [page, setPage] = useState(0)
  const [sort, setSort] = useState<Sort>('newest')
  const [result, setResult] = useState<SearchResult | null>(null)
  const [error, setError] = useState('')
  const parsed = useMemo(() => parseQuery(getState(), guildId, query), [guildId, query])

  useEffect(() => {
    if (parsed.error) return setError(parsed.error)
    let cancelled = false
    let timer = 0
    const load = () => {
      setError('')
      searchMessages({ guildId, channelId }, {
        ...parsed.params, offset: page * PER_PAGE, limit: PER_PAGE,
        ...(sort === 'relevance' ? { sort_by: 'relevance' } : { sort_by: 'timestamp', sort_order: sort === 'newest' ? 'desc' : 'asc' }),
      }).then(
        (r) => {
          if (cancelled) return
          // 202 "index not yet available" comes back without results and with retry_after.
          const wait = (r as SearchResult & { retry_after?: number }).retry_after
          if (!r.messages && wait !== undefined) timer = setTimeout(load, Math.max(1, wait) * 1000)
          else setResult(r)
        },
        (e: ApiError) => !cancelled && setError(e.message),
      )
    }
    setResult(null)
    load()
    return () => ((cancelled = true), clearTimeout(timer))
  }, [guildId, channelId, parsed, page, sort])

  const total = result?.total_results ?? 0
  const pages = Math.max(1, Math.ceil(Math.min(total, 10000) / PER_PAGE))
  const hits = (result?.messages ?? []).map((group) => group.find((m) => (m as { hit?: boolean }).hit) ?? group[0]).filter(Boolean)
  const close = () => setState({ panel: null })

  return (
    <aside className="side-panel search-panel" aria-label={t('Search results')}>
      <ResizeHandle
        id="search-panel-resizer"
        side="left"
        defaultValue={360}
        min={280}
        max={760}
        storageKey="cillhub:side-panel-width"
        cssVar="--side-panel-width"
        ariaLabel={t('Resize search panel')}
      />
      <header className="panel-header">
        <Icon d={ICONS.search} size={20} />
        <h2 className="ellipsis" aria-live="polite">{result ? t(total === 1 ? '{n} Result' : '{n} Results', { n: total.toLocaleString() }) : error ? t('Search') : t('Searching…')}</h2>
        <span className="spacer" />
        <label className="sr-only" htmlFor="search-sort">{t('Sort results')}</label>
        <select id="search-sort" className="input small-select" value={sort} onChange={(e) => (setSort(e.target.value as Sort), setPage(0))}>
          <option value="newest">{t('Newest')}</option>
          <option value="oldest">{t('Oldest')}</option>
          <option value="relevance">{t('Most relevant')}</option>
        </select>
        <button className="icon-btn" aria-label={t('Close search')} title={t('Close')} onClick={close}><Icon d={ICONS.close} size={18} /></button>
      </header>
      <div className="panel-body">
        <p className="hint small search-query">“{query}”</p>
        {error && <p className="form-error" role="alert">{error}</p>}
        {result && !hits.length && <p className="hint empty-state">{t('No results. Try a different search or fewer filters.')}</p>}
        <ol className="search-results" aria-label={t('Results')}>
          {hits.map((m, i) => {
            const ch = channels[m.channel_id] ?? result?.threads?.find((x) => x.id === m.channel_id)
            const showChannel = i === 0 || hits[i - 1].channel_id !== m.channel_id
            return (
              <li key={m.id} className="search-hit">
                {showChannel && guildId && <h3 className="list-heading">#{ch?.name ?? t('unknown')}</h3>}
                <div className="hit-card">
                  <Avatar user={m.author} size={32} />
                  <div className="hit-body">
                    <div className="msg-meta"><span className="author">{displayName(m.author)}</span><time dateTime={m.timestamp}>{stamp(m.timestamp)}</time></div>
                    {m.content ? <div className="content"><Markdown content={m.content} ctx={ctx} /></div> : <p className="hint small">{m.attachments.length ? t(m.attachments.length === 1 ? '{n} attachment' : '{n} attachments', { n: m.attachments.length }) : m.poll ? t('Poll') : m.sticker_items?.length ? t('Sticker') : t('Embed')}</p>}
                  </div>
                  <button className="secondary small-btn hit-jump" aria-label={t('Jump to message from {name}', { name: displayName(m.author) })} onClick={() => void openMessage(m.channel_id, m.id, guildId)}>{t('Jump')}</button>
                </div>
              </li>
            )
          })}
        </ol>
      </div>
      {total > PER_PAGE && (
        <nav className="pager" aria-label={t('Result pages')}>
          <button className="secondary small-btn" disabled={page === 0} onClick={() => setPage(page - 1)}>{t('Back')}</button>
          {Array.from({ length: pages }, (_, i) => i).filter((i) => Math.abs(i - page) <= 2 || i === 0 || i === pages - 1).map((i, k, arr) => (
            <span key={i}>
              {k > 0 && arr[k - 1] !== i - 1 && <span className="hint">…</span>}
              <button className={cls('page-btn', i === page && 'on')} aria-current={i === page ? 'page' : undefined} onClick={() => setPage(i)}>{i + 1}</button>
            </span>
          ))}
          <button className="secondary small-btn" disabled={page >= pages - 1} onClick={() => setPage(page + 1)}>{t('Next')}</button>
        </nav>
      )}
    </aside>
  )
}
