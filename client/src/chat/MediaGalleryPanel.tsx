import { useEffect, useRef, useState } from 'react'
import { fetchChannelMedia, loadAround } from '../actions'
import { cdn } from '../api'
import { Avatar, cls, Icon, ICONS, Modal } from '../components/ui'
import { t } from '../i18n'
import type { Attachment, Channel, Message } from '../types'
import { jumpTo } from './MessageList'

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function MediaGalleryPanel({
  channel,
  onClose,
}: {
  channel: Channel
  onClose: () => void
}) {
  const [tab, setTab] = useState<'media' | 'files' | 'links'>('media')
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [hasMore, setHasMore] = useState(true)
  const [lightbox, setLightbox] = useState<Attachment | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const loadPage = (cursor?: string, replace = false) => {
    if (loading) return
    setLoading(true)
    fetchChannelMedia(channel.id, tab, cursor, 30)
      .then((res) => {
        const list = res.messages ?? []
        setMessages((prev) => (replace ? list : [...prev, ...list]))
        setHasMore(list.length >= 30)
        setLoading(false)
      })
      .catch(() => {
        setLoading(false)
        setHasMore(false)
      })
  }

  useEffect(() => {
    setMessages([])
    setHasMore(true)
    loadPage(undefined, true)
  }, [channel.id, tab])

  const onScroll = () => {
    const el = containerRef.current
    if (!el || loading || !hasMore) return
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
      const lastMsg = messages.at(-1)
      if (lastMsg) loadPage(lastMsg.id)
    }
  }

  const handleJump = (messageId: string) => {
    if (!jumpTo(messageId)) {
      void loadAround(channel.id, messageId)
    }
  }

  return (
    <aside className="media-gallery-panel" style={{ width: '340px', flex: 'none', display: 'flex', flexDirection: 'column', background: 'var(--chat)', borderLeft: '1px solid var(--border)', height: '100%', boxSizing: 'border-box' }}>
      <header style={{ height: '48px', padding: '0 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', borderBottom: '1px solid var(--border)', flex: 'none' }}>
        <h2 style={{ fontSize: '15px', fontWeight: 600, margin: 0 }}>{t('Media, Files & Links')}</h2>
        <button className="icon-btn" aria-label={t('Close')} onClick={onClose}><Icon d={ICONS.close} size={18} /></button>
      </header>

      <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', flex: 'none' }}>
        <button
          className={cls('tab-btn', tab === 'media' && 'active')}
          style={{ flex: 1, padding: '10px 0', background: 'none', border: 'none', borderBottom: tab === 'media' ? '2px solid var(--accent)' : '2px solid transparent', color: tab === 'media' ? 'var(--header)' : 'var(--muted)', fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}
          onClick={() => setTab('media')}
        >
          {t('Media')}
        </button>
        <button
          className={cls('tab-btn', tab === 'files' && 'active')}
          style={{ flex: 1, padding: '10px 0', background: 'none', border: 'none', borderBottom: tab === 'files' ? '2px solid var(--accent)' : '2px solid transparent', color: tab === 'files' ? 'var(--header)' : 'var(--muted)', fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}
          onClick={() => setTab('files')}
        >
          {t('Files')}
        </button>
        <button
          className={cls('tab-btn', tab === 'links' && 'active')}
          style={{ flex: 1, padding: '10px 0', background: 'none', border: 'none', borderBottom: tab === 'links' ? '2px solid var(--accent)' : '2px solid transparent', color: tab === 'links' ? 'var(--header)' : 'var(--muted)', fontWeight: 600, fontSize: '13px', cursor: 'pointer' }}
          onClick={() => setTab('links')}
        >
          {t('Links')}
        </button>
      </div>

      <div ref={containerRef} onScroll={onScroll} style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
        {messages.length === 0 && !loading && (
          <div style={{ textAlign: 'center', padding: '40px 16px', color: 'var(--muted)', fontSize: '13px' }}>
            {tab === 'media' && t('No photos or videos have been shared here yet.')}
            {tab === 'files' && t('No files or audio have been shared here yet.')}
            {tab === 'links' && t('No links have been shared here yet.')}
          </div>
        )}

        {tab === 'media' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '6px' }}>
            {messages.flatMap((m) =>
              (m.attachments ?? [])
                .filter((a) => a.content_type?.startsWith('image/') || a.content_type?.startsWith('video/'))
                .map((a) => (
                  <div key={a.id} style={{ position: 'relative', width: '100%', paddingBottom: '100%', borderRadius: '4px', overflow: 'hidden', background: '#000', cursor: 'pointer' }} onClick={() => setLightbox(a)}>
                    {a.content_type?.startsWith('video/') ? (
                      <video src={cdn(a.url)} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }} muted preload="metadata" />
                    ) : (
                      <img src={cdn(a.url)} alt={a.filename} style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" />
                    )}
                    <button
                      className="icon-btn small-btn"
                      title={t('Jump to Message')}
                      style={{ position: 'absolute', bottom: '4px', right: '4px', background: 'rgba(0,0,0,0.6)', color: '#fff', padding: '2px', borderRadius: '4px' }}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleJump(m.id)
                      }}
                    >
                      <Icon d={ICONS.forward} size={14} />
                    </button>
                  </div>
                ))
            )}
          </div>
        )}

        {tab === 'files' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {messages.flatMap((m) =>
              (m.attachments ?? [])
                .filter((a) => !a.content_type?.startsWith('image/') && !a.content_type?.startsWith('video/'))
                .map((a) => (
                  <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px', borderRadius: '6px', background: 'var(--card)' }}>
                    <Icon d={ICONS.archive} size={24} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <a href={cdn(a.url)} download={a.filename} target="_blank" rel="noopener noreferrer" style={{ display: 'block', fontWeight: 500, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--header)', textDecoration: 'none' }}>
                        {a.filename}
                      </a>
                      <div style={{ fontSize: '11px', color: 'var(--muted)', marginTop: '2px' }}>
                        {formatBytes(a.size)} • {new Date(m.timestamp).toLocaleDateString()}
                      </div>
                    </div>
                    <button
                      className="icon-btn"
                      title={t('Jump to Message')}
                      onClick={() => handleJump(m.id)}
                    >
                      <Icon d={ICONS.forward} size={16} />
                    </button>
                  </div>
                ))
            )}
          </div>
        )}

        {tab === 'links' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {messages.map((m) => {
              const urlMatches = m.content.match(/https?:\/\/[^\s<)]+/g) ?? []
              return (
                <div key={m.id} style={{ padding: '8px', borderRadius: '6px', background: 'var(--card)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
                    <Avatar user={m.author} size={18} />
                    <span style={{ fontSize: '12px', fontWeight: 600 }}>{m.author.global_name || m.author.username}</span>
                    <span style={{ fontSize: '11px', color: 'var(--muted)', marginLeft: 'auto' }}>{new Date(m.timestamp).toLocaleDateString()}</span>
                    <button
                      className="icon-btn"
                      title={t('Jump to Message')}
                      onClick={() => handleJump(m.id)}
                      style={{ padding: '2px' }}
                    >
                      <Icon d={ICONS.forward} size={14} />
                    </button>
                  </div>
                  {urlMatches.map((u, i) => (
                    <a key={i} href={u} target="_blank" rel="noopener noreferrer" style={{ display: 'block', fontSize: '13px', color: 'var(--focus)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textDecoration: 'underline', marginTop: '2px' }}>
                      {u}
                    </a>
                  ))}
                </div>
              )
            })}
          </div>
        )}

        {loading && <p className="hint" style={{ textAlign: 'center', padding: '16px' }}>{t('Loading…')}</p>}
      </div>

      {lightbox && (
        <Modal title={lightbox.filename} onClose={() => setLightbox(null)} className="lightbox" hideTitle>
          <img src={cdn(lightbox.url)} alt={lightbox.description || lightbox.filename} style={{ maxWidth: '90vw', maxHeight: '80vh', objectFit: 'contain' }} />
          <div style={{ marginTop: '8px', textAlign: 'center' }}>
            <a href={cdn(lightbox.url)} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--focus)' }}>{t('Open in Browser')}</a>
          </div>
        </Modal>
      )}
    </aside>
  )
}
