import { t } from '../i18n'
import { useState, type ReactNode } from 'react'
import { cdn } from '../api'
import { formatSize, Icon, ICONS, Modal } from '../components/ui'
import type { Attachment, Message } from '../types'
import { VoicePlayer } from './VoicePlayer'

/** Spoiler attachments: SPOILER_ filename prefix (or the IS_SPOILER attachment flag 1 << 3). */
export const isSpoiler = (a: Attachment) => a.filename.startsWith('SPOILER_') || !!((a.flags ?? 0) & (1 << 3))
const shownName = (a: Attachment) => a.filename.replace(/^SPOILER_/, '')

function SpoilerBox({ spoiler, children }: { spoiler: boolean; children: ReactNode }) {
  const [shown, setShown] = useState(false)
  if (!spoiler || shown) return <>{children}</>
  return (
    <div className="att-spoiler">
      <div inert aria-hidden="true">{children}</div>
      <button className="spoiler-tag" onClick={() => setShown(true)} aria-label={t('Spoiler attachment, press to reveal')}>{t('SPOILER')}</button>
    </div>
  )
}

// Only types the server serves inline (CONTRACT-v2 section 6) are shown inline.
const IMAGE = /^image\/(png|jpeg|gif|webp)$/
const VIDEO = /^video\/(mp4|webm)$/

/** Fits width x height into 400 x 300 for inline images. */
function fit(a: Attachment) {
  if (!a.width || !a.height) return { maxWidth: 400, maxHeight: 300 }
  const k = Math.min(1, 400 / a.width, 300 / a.height)
  return { width: Math.round(a.width * k), height: Math.round(a.height * k) }
}

function FileCard({ a }: { a: Attachment }) {
  const url = cdn(a.url)
  return (
    <div className="file-card">
      <Icon d={ICONS.file} size={32} className="file-icon" />
      <div className="file-meta">
        <a href={url} target="_blank" rel="noopener noreferrer" download={shownName(a)} className="ellipsis">{shownName(a)}</a>
        <span className="hint small">{formatSize(a.size)}</span>
      </div>
      <a className="icon-btn" href={url} download={a.filename} target="_blank" rel="noopener noreferrer" aria-label={t('Download {name}', { name: a.filename })}>
        <Icon d={ICONS.download} />
      </a>
    </div>
  )
}

const isAudioAttachment = (a: Attachment, voice?: boolean) =>
  voice ||
  Boolean(a.waveform) ||
  Boolean(a.duration_secs) ||
  /^audio\//.test(a.content_type ?? '') ||
  /\.(mp3|wav|ogg|m4a|flac|opus)$/i.test(a.filename)

export function Attachments({ list, voice }: { list: Attachment[]; voice?: boolean }) {
  const [open, setOpen] = useState<Attachment | null>(null)
  if (!list.length) return null
  return (
    <div className="attachments">
      {list.map((a) => {
        const type = a.content_type ?? ''
        const url = cdn(a.url)
        const alt = a.description || shownName(a)
        let el: ReactNode
        if (isAudioAttachment(a, voice)) el = <VoicePlayer a={a} />
        else if (IMAGE.test(type))
          el = (
            <button className="att-image" aria-label={t('Open image {name}', { name: alt })} onClick={() => setOpen(a)}>
              <img src={url} alt={alt} title={a.description ?? undefined} style={fit(a)} loading="lazy" />
            </button>
          )
        else if (VIDEO.test(type)) el = <video className="att-video" src={url} controls preload="metadata" style={fit(a)} aria-label={alt} />
        else el = <FileCard a={a} />
        return <SpoilerBox key={a.id} spoiler={isSpoiler(a)}>{el}</SpoilerBox>
      })}
      {open && (
        <Modal title={shownName(open)} onClose={() => setOpen(null)} className="lightbox" hideTitle>
          <img src={cdn(open.url)} alt={open.description || shownName(open)} />
          <a href={cdn(open.url)} target="_blank" rel="noopener noreferrer">{t('Open in Browser')}</a>
        </Modal>
      )}
    </div>
  )
}

/** A pending message's files while they upload. */
export function Uploading({ m }: { m: Message }) {
  const pct = Math.round((m.progress ?? 0) * 100)
  const files = m.files ?? []
  return (
    <div className="file-card uploading">
      <Icon d={ICONS.file} size={32} className="file-icon" />
      <div className="file-meta">
        <span className="ellipsis">{files.length === 1 ? files[0].file.name : t('Uploading {n} files', { n: files.length })}</span>
        <progress max={100} value={pct} aria-label={t('Upload progress')}>{pct}%</progress>
      </div>
    </div>
  )
}
