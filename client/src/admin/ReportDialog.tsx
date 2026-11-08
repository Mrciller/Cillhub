// "Report message" from the message context menu: a reason and an optional note go to the instance admins (POST /reports).
import { useState, type FormEvent } from 'react'
import { toast } from '../components/dialogs'
import { FormError, Modal } from '../components/ui'
import { t } from '../i18n'
import type { Message } from '../types'
import { reportMessage, type ReportReason } from './api'

export const REASONS: [ReportReason, string][] = [
  ['spam', 'Spam or scam'], ['harassment', 'Harassment or bullying'], ['hate', 'Hateful content'], ['nsfw', 'Sexual or explicit content'],
  ['violence', 'Violence or threats'], ['self_harm', 'Self-harm'], ['illegal', 'Illegal content'], ['impersonation', 'Impersonation'], ['other', 'Something else'],
]
export const reasonLabel = (r: string) => t(REASONS.find(([k]) => k === r)?.[1] ?? r)

export function ReportDialog({ m, onClose }: { m: Message; onClose: () => void }) {
  const [reason, setReason] = useState<ReportReason | ''>('')
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!reason) return setError(t('Choose a reason.'))
    setBusy(true)
    reportMessage(m.channel_id, m.id, { reason, note: note.trim() || undefined }).then(
      () => (onClose(), toast(t('Thanks. The instance admins will review this message.'))),
      (err: Error) => (setError(err.message), setBusy(false)),
    )
  }
  return (
    <Modal title={t('Report Message')} onClose={onClose}>
      <form onSubmit={submit}>
        <p className="hint">{t('The admins of this Cillhub instance will see the message, its author and your report.')}</p>
        {m.content && <blockquote className="dialog-quote">{m.content.slice(0, 300)}</blockquote>}
        <fieldset className="admin-reasons">
          <legend>{t('Why are you reporting this message?')}</legend>
          {REASONS.map(([k, label]) => (
            <label key={k} className="admin-radio">
              <input type="radio" name="reason" value={k} checked={reason === k} onChange={() => (setReason(k), setError(''))} /> {t(label)}
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="report-note">{t('Note (optional)')}</label>
          <textarea id="report-note" className="input textarea" maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <FormError error={error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className="danger-btn" disabled={busy}>{t('Report')}</button>
        </div>
      </form>
    </Modal>
  )
}
