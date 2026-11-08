import { useEffect, useState } from 'react'
import { fetchMessageEdits } from '../actions'
import { Modal } from '../components/ui'
import { t } from '../i18n'
import type { MessageEdit } from '../types'

type DiffPart = { type: 'same' | 'add' | 'del'; text: string }

function computeWordDiff(beforeText: string, afterText: string): DiffPart[] {
  const a = beforeText.split(/(\s+|[^\s\w]+|\w+)/).filter(Boolean)
  const b = afterText.split(/(\s+|[^\s\w]+|\w+)/).filter(Boolean)

  const n = a.length
  const m = b.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < m; j++) {
      if (a[i] === b[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1])
      }
    }
  }

  const parts: DiffPart[] = []
  let i = n
  let j = m

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      parts.push({ type: 'same', text: a[i - 1] })
      i--
      j--
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      parts.push({ type: 'add', text: b[j - 1] })
      j--
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      parts.push({ type: 'del', text: a[i - 1] })
      i--
    }
  }

  return parts.reverse()
}

export function EditHistoryModal({
  messageId,
  channelId,
  currentContent,
  onClose,
}: {
  messageId: string
  channelId: string
  currentContent: string
  onClose: () => void
}) {
  const [edits, setEdits] = useState<MessageEdit[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetchMessageEdits(channelId, messageId)
      .then((res) => {
        setEdits(res.edits ?? [])
        setLoading(false)
      })
      .catch((err) => {
        setError(err.message || t('Failed to load edit history.'))
        setLoading(false)
      })
  }, [channelId, messageId])

  return (
    <Modal title={t('Message Edit History')} onClose={onClose}>
      <div className="edit-history-body" style={{ maxHeight: '60vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' }}>
        {loading && <p className="hint">{t('Loading revisions…')}</p>}
        {error && <p className="form-error">{error}</p>}
        {!loading && !error && edits && edits.length === 0 && (
          <p className="hint">{t('No prior revision history recorded for this message.')}</p>
        )}
        {!loading && !error && edits && edits.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {edits.map((edit, idx) => {
              const nextContent = idx + 1 < edits.length ? edits[idx + 1].content : currentContent
              const diff = computeWordDiff(edit.content, nextContent)
              return (
                <div key={idx} className="edit-history-card" style={{ background: 'var(--bg-secondary, #2b2d31)', padding: '12px', borderRadius: '6px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '12px', opacity: 0.7 }}>
                    <span>{t('Revision {n}', { n: idx + 1 })}</span>
                    <span>{new Date(edit.edited_at).toLocaleString()}</span>
                  </div>
                  <div style={{ fontSize: '14px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {diff.map((part, pIdx) => {
                      if (part.type === 'del') {
                        return <del key={pIdx} className="diff-del">{part.text}</del>
                      }
                      if (part.type === 'add') {
                        return <ins key={pIdx} className="diff-add">{part.text}</ins>
                      }
                      return <span key={pIdx}>{part.text}</span>
                    })}
                  </div>
                </div>
              )
            })}
            <div className="edit-history-card" style={{ background: 'var(--bg-secondary, #2b2d31)', padding: '12px', borderRadius: '6px', borderLeft: '3px solid var(--accent, #5865f2)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px', fontSize: '12px', fontWeight: 600 }}>
                <span>{t('Current Version')}</span>
              </div>
              <div style={{ fontSize: '14px', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                {currentContent}
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="modal-actions" style={{ marginTop: '16px', display: 'flex', justifyContent: 'flex-end' }}>
        <button type="button" className="primary" onClick={onClose}>{t('Close')}</button>
      </div>
    </Modal>
  )
}
