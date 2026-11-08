import { useMemo, useState } from 'react'
import { loadMessages } from '../actions'
import { cdn } from '../api'
import { Avatar, cls, Icon, ICONS, Modal } from '../components/ui'
import { t } from '../i18n'
import { Markdown, relative, type MdContext } from '../markdown/Markdown'
import { displayName } from '../store'
import { snowflakeTime } from '../threads/util'
import type { Attachment, Channel, Message } from '../types'
import { jumpTo } from './MessageList'
import './gallery.css'

export const isMediaAttachment = (a: Attachment) =>
  a.content_type?.startsWith('image/') ||
  a.content_type?.startsWith('video/') ||
  /\.(png|jpe?g|gif|webp|mp4|webm|mov)$/i.test(a.filename)

export type MediaItem = {
  message: Message
  attachment: Attachment
}

type Props = {
  channel: Channel
  msgs: Message[] | undefined
  ctx: MdContext
  label: string
  hasMore?: boolean
  onToggleView?: () => void
}

export function MediaGalleryGrid({ channel, msgs, ctx, label, hasMore, onToggleView }: Props) {
  const [lightbox, setLightbox] = useState<MediaItem | null>(null)
  const [zoomed, setZoomed] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)

  const mediaItems = useMemo(() => {
    if (!msgs) return []
    const items: MediaItem[] = []
    for (const m of msgs) {
      for (const a of m.attachments ?? []) {
        if (isMediaAttachment(a)) {
          items.push({ message: m, attachment: a })
        }
      }
    }
    return items
  }, [msgs])

  const isVideo = lightbox && (lightbox.attachment.content_type?.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(lightbox.attachment.filename))

  const handleLoadOlder = () => {
    if (!msgs?.[0] || loadingOlder) return
    setLoadingOlder(true)
    loadMessages(channel.id, msgs[0].id)
      .catch(() => {})
      .finally(() => setLoadingOlder(false))
  }

  return (
    <div className="media-gallery-container" role="region" aria-label={t('Media gallery for {label}', { label })}>
      <div className="media-gallery-header">
        <div className="media-gallery-title-row">
          <Icon d={ICONS.grid} size={20} />
          <h2 style={{ fontSize: '15px', fontWeight: 600, margin: 0 }}>{t('Media Gallery')}</h2>
          <span className="media-gallery-count">{t('{n} items', { n: mediaItems.length })}</span>
        </div>
        {onToggleView && (
          <div className="media-gallery-views">
            <button type="button" className="media-view-btn active">
              <Icon d={ICONS.grid} size={15} /> {t('Gallery')}
            </button>
            <button type="button" className="media-view-btn" onClick={onToggleView}>
              <Icon d={ICONS.list} size={15} /> {t('Messages')}
            </button>
          </div>
        )}
      </div>

      {mediaItems.length === 0 ? (
        <div className="media-gallery-empty">
          <div className="media-gallery-empty-icon">
            <Icon d={ICONS.grid} size={44} />
          </div>
          <h3>{t('No media in this channel yet')}</h3>
          <p className="hint">{t('Photos and videos posted here will appear in this visual gallery.')}</p>
        </div>
      ) : (
        <div className="media-gallery-masonry">
          {mediaItems.map(({ message, attachment }) => {
            const isVid = attachment.content_type?.startsWith('video/') || /\.(mp4|webm|mov)$/i.test(attachment.filename)
            const reactionCount = (message.reactions ?? []).reduce((acc, r) => acc + r.count, 0)
            const authorName = displayName(message.author)
            const altText = attachment.description || attachment.filename

            return (
              <button
                key={attachment.id}
                type="button"
                className="media-gallery-card"
                aria-label={t('Open {name} by {author}', { name: altText, author: authorName })}
                onClick={() => {
                  setZoomed(false)
                  setLightbox({ message, attachment })
                }}
              >
                {isVid ? (
                  <>
                    <video src={cdn(attachment.url)} preload="metadata" muted className="media-gallery-thumb" />
                    <div className="media-video-badge" aria-hidden="true">
                      <Icon d={ICONS.video} size={15} />
                    </div>
                  </>
                ) : (
                  <img
                    src={cdn(attachment.proxy_url ?? attachment.url)}
                    alt={altText}
                    loading="lazy"
                    className="media-gallery-thumb"
                  />
                )}

                <div className="media-gallery-overlay">
                  <div className="media-overlay-top">
                    <Avatar user={message.author} size={24} />
                    <span className="media-overlay-author ellipsis">{authorName}</span>
                  </div>

                  <div className="media-overlay-bottom">
                    {message.content && (
                      <p className="media-overlay-caption ellipsis">{message.content}</p>
                    )}
                    <div className="media-overlay-meta">
                      {reactionCount > 0 ? (
                        <span className="media-overlay-reactions">
                          ❤️ {reactionCount}
                        </span>
                      ) : <span />}
                      <span className="media-overlay-date">{relative(snowflakeTime(message.id))}</span>
                    </div>
                  </div>
                </div>
              </button>
            )
          })}
        </div>
      )}

      {hasMore && msgs?.[0] && mediaItems.length > 0 && (
        <div style={{ textAlign: 'center', padding: '16px' }}>
          <button
            type="button"
            className="secondary small-btn"
            disabled={loadingOlder}
            onClick={handleLoadOlder}
          >
            {loadingOlder ? t('Loading…') : t('Load older media')}
          </button>
        </div>
      )}

      {lightbox && (
        <Modal
          title={lightbox.attachment.description || lightbox.attachment.filename}
          onClose={() => setLightbox(null)}
          className="gallery-lightbox-modal"
          hideTitle
        >
          <div className="gallery-lightbox-media-wrapper">
            {isVideo ? (
              <video src={cdn(lightbox.attachment.url)} controls autoPlay className="gallery-lightbox-video" />
            ) : (
              <img
                src={cdn(lightbox.attachment.url)}
                alt={lightbox.attachment.description || lightbox.attachment.filename}
                className={cls('gallery-lightbox-img', zoomed && 'zoomed')}
                onClick={() => setZoomed(!zoomed)}
              />
            )}
          </div>
          <div className="gallery-lightbox-details">
            <div className="gallery-lightbox-author-row">
              <div className="gallery-lightbox-author-info">
                <Avatar user={lightbox.message.author} size={32} />
                <div>
                  <div style={{ fontWeight: 600, fontSize: '14px', color: 'var(--strong, #fff)' }}>
                    {displayName(lightbox.message.author)}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--muted, #949ba4)' }}>
                    {relative(snowflakeTime(lightbox.message.id))}
                  </div>
                </div>
              </div>
              <div className="gallery-lightbox-actions">
                {!isVideo && (
                  <button type="button" className="secondary small-btn" onClick={() => setZoomed(!zoomed)}>
                    {zoomed ? t('Fit') : t('Zoom')}
                  </button>
                )}
                <a
                  href={cdn(lightbox.attachment.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="secondary small-btn"
                  style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
                >
                  {t('Open Original')}
                </a>
                <button
                  type="button"
                  className="secondary small-btn"
                  onClick={() => {
                    const id = lightbox.message.id
                    setLightbox(null)
                    jumpTo(id)
                  }}
                >
                  {t('Jump to Message')}
                </button>
              </div>
            </div>
            {lightbox.message.content && (
              <div className="gallery-lightbox-caption">
                <Markdown content={lightbox.message.content} ctx={ctx} />
              </div>
            )}
            {lightbox.message.reactions && lightbox.message.reactions.length > 0 && (
              <div className="gallery-lightbox-reactions">
                {lightbox.message.reactions.map((r, i) => (
                  <span key={i} className="gallery-lightbox-reaction-badge">
                    {r.emoji.name} {r.count}
                  </span>
                ))}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}

