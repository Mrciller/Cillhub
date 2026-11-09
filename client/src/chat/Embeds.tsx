// Link cards, image/video embeds, YouTube click-to-play and rich webhook embeds (message.mdx embed object).
// Media only ever loads through the server's media proxy (`proxy_url`), never from third-party hosts directly.
import { t } from '../i18n'
import { useState } from 'react'
import { cdn } from '../api'
import { Icon, ICONS } from '../components/ui'
import { Markdown, type MdContext } from '../markdown/Markdown'
import { GifStar } from '../expressions/GifStar'
import type { Embed, EmbedMedia } from '../types'

/** The proxied URL of embed media, or null (root-relative URLs are our own server's, e.g. /external/<token>). */
const media = (m?: EmbedMedia) => (m?.proxy_url ? cdn(m.proxy_url) : m?.url?.startsWith('/') ? cdn(m.url) : null)
const iconOf = (o?: { icon_url?: string; proxy_icon_url?: string }) => (o?.proxy_icon_url ? cdn(o.proxy_icon_url) : o?.icon_url?.startsWith('/') ? cdn(o.icon_url) : null)
const safe = (u?: string) => (u && /^https?:\/\//.test(u) ? u : undefined)
const hex = (n?: number) => (n ? '#' + n.toString(16).padStart(6, '0') : undefined)

/** Only youtube-nocookie embed URLs may become an iframe. */
function playerUrl(e: Embed) {
  try {
    const u = new URL(e.video?.url ?? '')
    return u.protocol === 'https:' && u.hostname === 'www.youtube-nocookie.com' && u.pathname.startsWith('/embed/') ? u.href : null
  } catch {
    return null
  }
}

function fit(m: EmbedMedia | undefined, maxW: number, maxH: number) {
  if (!m?.width || !m.height) return { maxWidth: maxW, maxHeight: maxH }
  const k = Math.min(1, maxW / m.width, maxH / m.height)
  return { width: Math.round(m.width * k), height: Math.round(m.height * k) }
}

function Player({ e, thumb }: { e: Embed; thumb: string | null }) {
  const [playing, setPlaying] = useState(false)
  const src = playerUrl(e)!
  const size = fit(e.video ?? e.thumbnail, 400, 225)
  if (playing)
    return (
      <iframe className="embed-player" style={size} src={`${src}${src.includes('?') ? '&' : '?'}autoplay=1`} title={e.title ?? t('Video')}
        allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowFullScreen referrerPolicy="strict-origin-when-cross-origin"
        sandbox="allow-scripts allow-same-origin allow-presentation allow-popups" />
    )
  return (
    <button className="embed-play" style={size} aria-label={e.title ? t('Play video: {title}', { title: e.title }) : t('Play video')} onClick={() => setPlaying(true)}>
      {thumb && <img src={thumb} alt="" loading="lazy" />}
      <span className="play-badge" aria-hidden="true"><Icon d={ICONS.play} size={28} /></span>
    </button>
  )
}

function EmbedView({ e, ctx }: { e: Embed; ctx: MdContext }) {
  const image = media(e.image)
  const thumb = media(e.thumbnail)
  const video = e.video && media(e.video)
  // Plain image / gifv embeds: just the picture.
  if ((e.type === 'image' || e.type === 'gifv') && (image || thumb) && !e.title && !e.description) {
    const m = (e.image ?? e.thumbnail)!
    const img = <img className="embed-media-only" src={(image || thumb)!} alt="" loading="lazy" style={fit(m, 400, 300)} />
    // a GIF link can be starred: url = the posted link, src = our proxied copy
    const src = m.proxy_url ?? (m.url?.startsWith('/') ? m.url : undefined)
    if (!(e.type === 'gifv' || /\.gif([?#]|$)/i.test(e.url ?? '')) || !e.url?.startsWith('https://') || !src) return img
    return <span className="gif-fav">{img}<GifStar gif={{ url: e.url, src, width: m.width ?? 0, height: m.height ?? 0, format: 'gif' }} /></span>
  }
  if (e.type === 'video' && video && !playerUrl(e) && !e.title)
    return <video className="embed-media-only" src={video} controls preload="metadata" style={fit(e.video, 400, 300)} />
  const player = playerUrl(e)
  const bigThumb = player || e.type === 'video'
  const color = hex(e.color)
  return (
    <article className="embed" style={color ? { borderLeftColor: color } : undefined} aria-label={e.title ? t('Embed: {title}', { title: e.title }) : t('Embed')}>
      <div className="embed-grid">
        <div className="embed-text">
          {e.provider?.name && <div className="embed-provider">{safe(e.provider.url) ? <a href={e.provider.url} target="_blank" rel="noopener noreferrer">{e.provider.name}</a> : e.provider.name}</div>}
          {e.author?.name && (
            <div className="embed-author">
              {iconOf(e.author) && <img src={iconOf(e.author)!} alt="" />}
              {safe(e.author.url) ? <a href={e.author.url} target="_blank" rel="noopener noreferrer">{e.author.name}</a> : <span>{e.author.name}</span>}
            </div>
          )}
          {e.title && <div className="embed-title">{safe(e.url) ? <a href={e.url} target="_blank" rel="noopener noreferrer">{e.title}</a> : e.title}</div>}
          {e.description && <div className="embed-desc"><Markdown content={e.description} ctx={ctx} /></div>}
          {!!e.fields?.length && (
            <dl className="embed-fields">
              {e.fields.map((f, i) => (
                <div key={i} className={f.inline ? 'embed-field inline' : 'embed-field'}>
                  <dt><Markdown content={f.name} ctx={ctx} /></dt>
                  <dd><Markdown content={f.value} ctx={ctx} /></dd>
                </div>
              ))}
            </dl>
          )}
        </div>
        {thumb && !bigThumb && <img className="embed-thumb" src={thumb} alt="" loading="lazy" />}
      </div>
      {player ? <Player e={e} thumb={thumb} />
        : video ? <video className="embed-image" src={video} controls preload="metadata" style={fit(e.video, 400, 300)} />
        : bigThumb && thumb ? <img className="embed-image" src={thumb} alt="" loading="lazy" style={fit(e.thumbnail, 400, 300)} />
        : null}
      {image && <img className="embed-image" src={image} alt="" loading="lazy" style={fit(e.image, 400, 300)} />}
      {(e.footer?.text || e.timestamp) && (
        <div className="embed-footer">
          {iconOf(e.footer) && <img src={iconOf(e.footer)!} alt="" />}
          <span>{e.footer?.text}{e.footer?.text && e.timestamp ? ' • ' : ''}{e.timestamp && new Date(e.timestamp).toLocaleString()}</span>
        </div>
      )}
    </article>
  )
}

export function Embeds({ list, ctx, onRemove }: { list: Embed[]; ctx: MdContext; onRemove?: () => void }) {
  // Poll result notifications carry a data embed that is rendered by the poll result system message instead.
  const shown = list.filter((e) => e.type !== 'poll_result')
  if (!shown.length) return null
  return (
    <div className="embeds">
      {shown.map((e, i) => <EmbedView key={i} e={e} ctx={ctx} />)}
      {onRemove && (
        <button className="icon-btn tiny embed-remove" aria-label={t('Remove embeds')} title={t('Remove embeds')} onClick={onRemove}>
          <Icon d={ICONS.close} size={14} />
        </button>
      )}
    </div>
  )
}
