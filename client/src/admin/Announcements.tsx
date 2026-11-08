// Announcements: a system message to everyone (banner for all connected clients, optionally a DM from "Cillhub System").
// The server keeps the current one (shown on every client until cleared); history is in the admin audit log.
import { useState, type FormEvent } from 'react'
import { ask, toast, toastError } from '../components/dialogs'
import { FormError } from '../components/ui'
import { t } from '../i18n'
import { clearAnnouncement, getSettings, sendAnnouncement } from './api'
import { useLoad, when } from './util'

export function Announcements() {
  const { data, error, reload } = useLoad(getSettings, [])
  const [content, setContent] = useState('')
  const [dm, setDm] = useState(false)
  const [sendError, setSendError] = useState('')
  const current = data?.announcement
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const text = content.trim()
    if (!text) return
    void ask({ title: t('Send announcement?'), body: <><p>{dm ? t('Every user sees a banner and gets a DM from Cillhub System.') : t('Every user sees a banner.')}</p><blockquote className="dialog-quote">{text}</blockquote></>, confirm: t('Send') })
      .then((ok) => void (ok && sendAnnouncement(text, dm).then((r) => (setContent(''), setDm(false), toast(dm ? t('Announcement sent, {n} DMs.', { n: r.dm_count }) : t('Announcement sent.')), reload()), (err: Error) => setSendError(err.message))))
  }
  const clear = () => void ask({ title: t('Remove the announcement?'), body: <p>{t('The banner disappears for everyone. DMs already sent stay.')}</p>, confirm: t('Remove'), danger: true })
    .then((ok) => void (ok && clearAnnouncement().then(() => void reload(), toastError)))
  return (
    <>
      <section className="admin-card" aria-labelledby="ann-h">
        <h2 id="ann-h">{t('Current announcement')}</h2>
        <FormError error={error} />
        {data && (current ? (
          <>
            <p className="hint small"><time dateTime={current.created_at}>{when(current.created_at)}</time></p>
            <blockquote className="dialog-quote">{current.content}</blockquote>
            <div className="admin-actions"><button className="danger-btn" onClick={clear}>{t('Remove Announcement')}</button></div>
          </>
        ) : <p className="hint">{t('None.')}</p>)}
      </section>
      <form className="admin-form" onSubmit={submit}>
        <div className="field">
          <label htmlFor="ann-text">{t('New announcement')}</label>
          <textarea id="ann-text" className="input textarea" required maxLength={2000} value={content} onChange={(e) => setContent(e.target.value)} />
        </div>
        <label className="admin-check"><input type="checkbox" checked={dm} onChange={(e) => setDm(e.target.checked)} /> {t('Also send it as a DM from Cillhub System')}</label>
        <FormError error={sendError} />
        <div className="save-bar"><button className="primary admin-btn" disabled={!content.trim()}>{t('Send Announcement')}</button></div>
      </form>
    </>
  )
}
