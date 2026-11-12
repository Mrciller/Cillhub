// "Report message" from the message context menu: a reason and an optional note go to the instance admins (POST /reports).
import { useState, type FormEvent } from 'react'
import { toast } from '../components/dialogs'
import { FormError, Modal } from '../components/ui'
import { t } from '../i18n'
import type { Message } from '../types'
import { getState } from '../store'
import { revealKeys } from '../e2ee/session'
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
  const [context, setContext] = useState(false)
  const encrypted = !!m.e2ee_envelope
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!reason) return setError(t('Choose a reason.'))
    setBusy(true)
    // encrypted DM: the message keys of this message (and, if chosen, up to 10 loaded ones before it) go to the admins
    let reveal: { id: string; mk: string }[] | undefined
    if (encrypted) {
      const list = getState().messages[m.channel_id] ?? []
      const before = context ? list.filter((x) => x.e2ee_envelope && BigInt(x.id) < BigInt(m.id) && !x.pending).slice(-10) : []
      reveal = await revealKeys([m, ...before])
      if (!reveal.some((r) => r.id === m.id)) return setError(t('This message cannot be decrypted here, so it cannot be reported with its text.')), setBusy(false)
    }
    reportMessage(m.channel_id, m.id, { reason, note: note.trim() || undefined, reveal }).then(
      () => (onClose(), toast(t('Thanks. The instance admins will review this message.'))),
      (err: Error) => (setError(err.message), setBusy(false)),
    )
  }
  return (
    <Modal title={t('Report Message')} onClose={onClose}>
      <form onSubmit={(e) => void submit(e)}>
        <p className="hint">{t('The admins of this Cillhub instance will see the message, its author and your report.')}</p>
        {m.content && <blockquote className="dialog-quote">{m.content.slice(0, 300)}</blockquote>}
        {encrypted && (
          <>
            <p className="hint">{t('This message is end-to-end encrypted. Reporting it sends its text and files to the admins, and nothing else from this conversation unless you add the messages before it.')}</p>
            <label className="admin-radio"><input type="checkbox" checked={context} onChange={(e) => setContext(e.target.checked)} /> {t('Include up to 10 messages before it')}</label>
          </>
        )}
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
