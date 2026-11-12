// Expression picker: GIFs (only when the server has a GIF provider), Stickers and Emoji tabs.
// Emoji: this server's custom emoji first, then other servers' (USE_EXTERNAL_EMOJIS), then Unicode categories.
import { t } from '../i18n'
import { useEffect, useState, type KeyboardEvent } from 'react'
import { gifs, gifsKnownMissing, gifsUnknown, gifCategories, DEFAULT_GIF_CATEGORIES, type GifCategory, type EmojiRef } from '../actions'
import { cdn } from '../api'
import { Popover, type Anchor } from '../components/menu'
import { cls, GuildIcon } from '../components/ui'
import { EMOJI } from '../emoji/data'
import { emojiUrl } from '../markdown/Markdown'
import { canUseEmoji, has, P } from '../permissions'
import { myMember } from '../selectors'
import { FavoriteMedia, GifStar } from './GifStar'
import { getState, useStore } from '../store'
import type { FavoriteGif, Gif, Sticker } from '../types'
import { skin } from '../custom/AppearanceV6'
import { NodeGuard } from '../instances/NodeGuard'
import './expressions.css'

const tone = () => getState().settings.default_emoji_skin_tone ?? 0

export type Tab = 'gif' | 'sticker' | 'emoji'
export const stickerUrl = (s: { id: string; format_type: number }) => cdn(`/stickers/${s.id}.${s.format_type === 4 ? 'gif' : 'png'}`)

/** Arrow keys move through a grid of buttons with `cols` columns. */
function gridKeys(cols: number, sel: string) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: cols, ArrowUp: -cols }[e.key]
    if (!step || !(e.target instanceof HTMLButtonElement)) return
    const all = [...e.currentTarget.querySelectorAll<HTMLButtonElement>(sel)]
    const next = all[all.indexOf(e.target) + step]
    if (next) e.preventDefault(), next.focus()
  }
}

function EmojiTab({ guildId, perms, onPick }: { guildId?: string; perms: bigint; onPick: (text: string, ref: EmojiRef) => void }) {
  const [q, setQ] = useState('')
  const guilds = useStore((s) => s.guilds)
  const member = useStore((s) => myMember(s, guildId))
  const members = useStore((s) => s.members)
  const meId = useStore((s) => s.me?.id)
  const query = q.trim().toLowerCase().replace(/:/g, '')
  const servers = !guildId && !has(perms, P.USE_EXTERNAL_EMOJIS) ? [] : Object.values(guilds)
    .filter((g) => g.emojis?.length && (g.id === guildId || has(perms, P.USE_EXTERNAL_EMOJIS)))
    .sort((a, b) => Number(b.id === guildId) - Number(a.id === guildId))
    .map((g) => ({ g, list: (g.emojis ?? []).filter((e) => e.id && e.available !== false && canUseEmoji(e.roles, g.id === guildId ? member : members[g.id]?.[meId ?? ''], g.owner_id === meId) && (!query || e.name.toLowerCase().includes(query))) }))
    .filter((x) => x.list.length)
  const unicode = EMOJI.map((c) => ({ ...c, list: query ? c.list.filter((e) => e.keywords.includes(query)) : c.list })).filter((c) => c.list.length)
  const first = servers[0]?.list[0]
  return (
    <>
      <input className="input" type="search" aria-label={t('Search emoji')} placeholder={t('Find the perfect emoji')} value={q} onChange={(e) => setQ(e.target.value)} data-autofocus
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return
          e.preventDefault()
          if (first?.id) onPick(`<${first.animated ? 'a' : ''}:${first.name}:${first.id}>`, { id: first.id, name: first.name, animated: first.animated })
          else if (unicode[0]) onPick(skin(unicode[0].list[0].char, tone()), { id: null, name: skin(unicode[0].list[0].char, tone()) })
        }} />
      {servers.length > 0 && (
        <nav className="expr-nav" aria-label={t('Emoji sections')}>
          {servers.map(({ g }) => (
            <button key={g.id} className="expr-nav-btn rail-icon" title={g.name} aria-label={t('Jump to {name} emoji', { name: g.name })} onClick={() => document.getElementById(`emoji-sec-${g.id}`)?.scrollIntoView({ block: 'start' })}>
              <GuildIcon guild={g} />
            </button>
          ))}
        </nav>
      )}
      <div className="emoji-scroll" onKeyDown={gridKeys(8, '.emoji-btn')}>
        {servers.map(({ g, list }) => (
          <section key={g.id} id={`emoji-sec-${g.id}`}>
            <h3 className="list-heading">{g.name}</h3>
            <div className="emoji-grid">
              {list.map((e) => (
                <button key={e.id} className="emoji-btn" title={`:${e.name}:`} aria-label={e.name} onClick={() => onPick(`<${e.animated ? 'a' : ''}:${e.name}:${e.id}>`, { id: e.id, name: e.name, animated: e.animated })}>
                  <img src={emojiUrl(e.id!, e.animated)} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          </section>
        ))}
        {unicode.map((g) => (
          <section key={g.category}>
            <h3 className="list-heading">{t(g.category)}</h3>
            <div className="emoji-grid">
              {g.list.map((e) => (
                <button key={e.char} className="emoji-btn" title={`:${e.name}:`} aria-label={e.name.replace(/_/g, ' ')} onClick={() => onPick(skin(e.char, tone()), { id: null, name: skin(e.char, tone()) })}>
                  {skin(e.char, tone())}
                </button>
              ))}
            </div>
          </section>
        ))}
        {!servers.length && !unicode.length && <p className="hint">{t('No emoji match “{q}”.', { q })}</p>}
      </div>
    </>
  )
}

function StickerTab({ guildId, perms, onPick }: { guildId?: string; perms: bigint; onPick: (s: Sticker) => void }) {
  const guilds = useStore((s) => s.guilds)
  const [q, setQ] = useState('')
  const query = q.trim().toLowerCase()
  const groups = Object.values(guilds)
    .filter((g) => g.id === guildId || has(perms, P.USE_EXTERNAL_STICKERS))
    .sort((a, b) => Number(b.id === guildId) - Number(a.id === guildId))
    .map((g) => ({ g, list: (g.stickers ?? []).filter((s) => s.available !== false && (!query || s.name.toLowerCase().includes(query) || s.tags?.toLowerCase().includes(query))) }))
    .filter((x) => x.list.length)
  return (
    <>
      <input className="input" type="search" aria-label={t('Search stickers')} placeholder={t('Find the perfect sticker')} value={q} onChange={(e) => setQ(e.target.value)} data-autofocus />
      <div className="emoji-scroll" onKeyDown={gridKeys(4, '.sticker-btn')}>
        {groups.map(({ g, list }) => (
          <section key={g.id}>
            <h3 className="list-heading">{g.name}</h3>
            <div className="sticker-grid">
              {list.map((s) => (
                <button key={s.id} className="sticker-btn" title={s.name} aria-label={t('Send sticker {name}', { name: s.name })} onClick={() => onPick(s)}>
                  <img src={stickerUrl(s)} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          </section>
        ))}
        {!groups.length && <p className="hint empty-expr">{query ? t('No stickers match “{q}”.', { q }) : t('No stickers here yet. Server managers can upload them in Server Settings.')}</p>}
      </div>
    </>
  )
}

// shortcut: favorites have no title, search matches words in the GIF link only; store a title when the picker has one if this proves too weak
const linkWords = (s: string) => { try { s = decodeURIComponent(s) } catch {} return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ') }
/** Every whitespace-separated word of q appears in the favourite's url or src (decoded, lowercased, punctuation as spaces). */
const favMatches = (f: FavoriteGif, q: string) => { const hay = `${linkWords(f.url)} ${linkWords(f.src)}`; return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w)) }

function GifTab({ onPick, onMissing }: { onPick: (g: Gif) => void; onMissing: () => void }) {
  const [q, setQ] = useState('')
  const [favQ, setFavQ] = useState('') // filters favourites locally while that chip is on; q keeps the server search
  const [list, setList] = useState<Gif[] | null>(null)
  const [error, setError] = useState('')
  const [categories, setCategories] = useState<GifCategory[]>(DEFAULT_GIF_CATEGORIES)
  const [activeCategory, setActiveCategory] = useState<string>('trending')
  const favs = useStore((s) => s.settings.favorite_gifs) ?? []
  const showFavs = activeCategory === 'favorites'
  // favourites are kept as {url, src, width, height, format}; the picker's tiles and onPick speak Gif
  const shown: Gif[] | null = showFavs ? favs.filter((f) => favMatches(f, favQ)).map((f) => ({ ...f, id: f.url, title: '', preview: f.src })) : list

  useEffect(() => {
    gifCategories().then((res) => {
      if (res?.length) setCategories(res)
    })
  }, [])

  useEffect(() => {
    const t = setTimeout(() => gifs(q.trim() || undefined).then((r) => (r ? setList(r) : onMissing()), (e: Error) => setError(e.message)), q ? 300 : 0)
    return () => clearTimeout(t)
  }, [q, onMissing])

  const onSelectCategory = (cat: GifCategory) => {
    setActiveCategory(cat.id)
    setQ(cat.q)
    setFavQ('')
  }

  return (
    <>
      <input
        className="input"
        type="search"
        aria-label={showFavs ? t('Search favorites') : t('Search GIFs')}
        placeholder={showFavs ? t('Search favorites') : t('Search for GIFs')}
        value={showFavs ? favQ : q}
        onChange={(e) => {
          if (showFavs) return setFavQ(e.target.value)
          setQ(e.target.value)
          setActiveCategory('')
        }}
        data-autofocus
      />
      <div className="gif-categories" role="tablist" aria-label={t('GIF categories')}>
        {[{ id: 'favorites', name: 'Favorites', q: '' }, ...categories].map((c) => {
          const isSelected = c.id === 'favorites' ? showFavs : !showFavs && (activeCategory === c.id || (!q && c.id === 'trending') || (q.toLowerCase() === c.q.toLowerCase() && !!c.q))
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={isSelected}
              className={cls('gif-category-chip', isSelected && 'active')}
              onClick={() => onSelectCategory(c)}
            >
              {t(c.name)}
            </button>
          )
        })}
      </div>
      <div className="gif-scroll" onKeyDown={gridKeys(2, '.gif-btn')}>
        {error && !showFavs && <p className="form-error">{error}</p>}
        <div className="gif-masonry">
          {shown?.map((g) => {
            const aspect = g.width && g.height ? `${g.width} / ${g.height}` : undefined
            const fav: FavoriteGif = { url: g.url, src: g.src, width: g.width, height: g.height, format: showFavs ? (g as Gif & FavoriteGif).format : 'gif' }
            return (
              <div key={g.id} className="gif-tile">
                <button
                  className="gif-btn"
                  style={aspect ? { aspectRatio: aspect } : undefined}
                  title={g.title}
                  aria-label={t('Send GIF {name}', { name: g.title || g.id })}
                  onClick={() => onPick(g)}
                >
                  {showFavs ? <FavoriteMedia f={fav} src={cdn(g.src)} /> : <img src={cdn(g.preview || g.src)} alt={g.title || ''} loading="lazy" />}
                </button>
                <GifStar gif={fav} />
              </div>
            )
          })}
        </div>
        {shown?.length === 0 && <p className="hint">{!showFavs ? t('No GIFs found.') : favs.length ? t('No favorites match “{q}”.', { q: favQ }) : t('No favorite GIFs yet. Star a GIF to keep it here.')}</p>}
      </div>
    </>
  )
}

type Props = {
  at: Anchor; onClose: () => void; guildId?: string; perms: bigint; initial?: Tab
  onEmoji: (text: string, ref: EmojiRef) => void; onSticker?: (s: Sticker) => void; onGif?: (g: Gif) => void
}

export function ExpressionPicker({ at, onClose, guildId, perms, initial = 'emoji', onEmoji, onSticker, onGif }: Props) {
  const [noGifs, setNoGifs] = useState(gifsKnownMissing)
  // Ask once whether the server has a GIF provider, so the tab is hidden even when the picker opens on another tab.
  useEffect(() => void (onGif && gifsUnknown() && gifs().then((r) => !r && setNoGifs(true), () => {})), [onGif])
  const tabs: [Tab, string][] = [
    ...(onGif && !noGifs ? [['gif', t('GIFs')] as [Tab, string]] : []),
    ...(onSticker ? [['sticker', t('Stickers')] as [Tab, string]] : []),
    ['emoji', t('Emoji')],
  ]
  const [tab, setTab] = useState<Tab>(initial)
  const current = tabs.some(([k]) => k === tab) ? tab : 'emoji'
  const pickAndClose = <T,>(fn?: (x: T) => void) => (x: T) => (fn?.(x), onClose())
  return (
    <Popover at={at} onClose={onClose} label={tabs.length > 1 ? t('Expression picker') : t('Emoji picker')} className="emoji-picker expr-picker">
      {tabs.length > 1 && (
        <div className="expr-tabs" role="tablist" aria-label={t('Expressions')}>
          {tabs.map(([k, l]) => <button key={k} role="tab" aria-selected={current === k} className={cls('expr-tab', current === k && 'on')} onClick={() => setTab(k)}>{l}</button>)}
        </div>
      )}
      <div role="tabpanel" aria-label={tabs.find(([k]) => k === current)?.[1]} className="expr-panel" key={current}>
        {/* every server's emoji and stickers: an error here is nobody's in particular */}
        {current === 'emoji' && <NodeGuard id={null}><EmojiTab guildId={guildId} perms={perms} onPick={(text, r) => (onEmoji(text, r), onClose())} /></NodeGuard>}
        {current === 'sticker' && <NodeGuard id={null}><StickerTab guildId={guildId} perms={perms} onPick={pickAndClose(onSticker)} /></NodeGuard>}
        {current === 'gif' && <GifTab onPick={pickAndClose(onGif)} onMissing={() => (setNoGifs(true), setTab('emoji'))} />}
      </div>
    </Popover>
  )
}
