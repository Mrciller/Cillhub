// Timeout a member (communication_disabled_until, at most 28 days) or remove their timeout.
import { t } from '../i18n'
import { useState } from 'react'
import { timeoutMember } from '../actions'
import { cls, FormError, Modal } from '../components/ui'
import { relative } from '../markdown/Markdown'
import { timedOutUntil } from '../permissions'
import { memberName } from '../selectors'
import { useStore } from '../store'

const DURATIONS: [number, string][] = [[60, '60 seconds'], [300, '5 minutes'], [600, '10 minutes'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week']]

export function TimeoutModal({ guildId, userId, onClose }: { guildId: string; userId: string; onClose: () => void }) {
  const name = useStore((s) => memberName(s, guildId, userId))
  const member = useStore((s) => s.members[guildId]?.[userId])
  const until = timedOutUntil(member)
  const [secs, setSecs] = useState(60)
  const [reason, setReason] = useState('')
  const [error, setError] = useState('')
  const run = (iso: string | null) => timeoutMember(guildId, userId, iso, reason.trim() || undefined).then(onClose, (e: Error) => setError(e.message))
  return (
    <Modal title={t('Timeout {name}', { name })} onClose={onClose}>
      <p className="hint">{t('Members who are timed out can still read messages, but cannot send or react to them, start threads, or join and speak in voice.')}</p>
      {until > 0 && <p className="notice top-gap" role="status">{t('Timed out until {time} ({rel}).', { time: new Date(until).toLocaleString(), rel: relative(until) })}</p>}
      <form onSubmit={(e) => (e.preventDefault(), run(new Date(Date.now() + secs * 1000).toISOString()))}>
        <fieldset className="choice duration-choice">
          <legend>{t('Duration')}</legend>
          {DURATIONS.map(([v, l]) => (
            <label key={v} className={cls('radio-card', secs === v && 'on')}>
              <input type="radio" name="duration" checked={secs === v} onChange={() => setSecs(v)} /> {t(l)}
            </label>
          ))}
        </fieldset>
        <div className="field">
          <label htmlFor="timeout-reason">{t('Reason')}</label>
          <textarea id="timeout-reason" className="input textarea" maxLength={512} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <FormError error={error} />
        <div className="modal-actions">
          {until > 0 && <button type="button" className="secondary" onClick={() => run(null)}>{t('Remove Timeout')}</button>}
          <span className="spacer" />
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className="danger-btn">{t('Timeout')}</button>
        </div>
      </form>
    </Modal>
  )
}
