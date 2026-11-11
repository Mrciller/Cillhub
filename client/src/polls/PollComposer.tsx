// "Create a Poll" dialog from the composer's + menu (poll create structure: question ≤300, ≤10 answers ≤55, duration in hours).
import { t } from '../i18n'
import { useState } from 'react'
import { sendPoll } from '../actions'
import { FormError, Icon, ICONS, Modal, cls } from '../components/ui'
import { Switch } from '../settings/Layout'
import { useStore } from '../store'
import type { Channel } from '../types'

const DURATIONS: [number, string][] = [[1, '1 hour'], [4, '4 hours'], [8, '8 hours'], [24, '24 hours'], [72, '3 days'], [168, '1 week'], [336, '2 weeks']]

export function PollComposer({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const guild = useStore((s) => (channel.guild_id ? s.guilds[channel.guild_id] : undefined))
  const [question, setQuestion] = useState('')
  const [answers, setAnswers] = useState(['', ''])
  const [duration, setDuration] = useState(24)
  const [multi, setMulti] = useState(false)
  const [anonymous, setAnonymous] = useState(false)
  const [isQuiz, setIsQuiz] = useState(false)
  const [correctAnswerIdx, setCorrectAnswerIdx] = useState<number | null>(null)
  const [allowedRoles, setAllowedRoles] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const filledWithIndices = answers.map((text, idx) => ({ text: text.trim(), idx })).filter((x) => Boolean(x.text))
  const filled = filledWithIndices.map((x) => x.text)

  const submit = () => {
    setBusy(true)
    let correctId: number | null = null
    if (isQuiz && correctAnswerIdx !== null) {
      const matchIdx = filledWithIndices.findIndex((x) => x.idx === correctAnswerIdx)
      if (matchIdx !== -1) {
        correctId = matchIdx + 1 // 1-based answer_id
      }
    }

    sendPoll(channel, {
      question: { text: question.trim() },
      answers: filled.map((text) => ({ poll_media: { text } })),
      duration,
      allow_multiselect: multi,
      anonymous,
      allowed_role_ids: allowedRoles.length ? allowedRoles : undefined,
      correct_answer_id: correctId,
    }).then(onClose, (e: Error) => (setError(e.message), setBusy(false)))
  }

  const toggleRole = (roleId: string) => {
    setAllowedRoles((prev) => (prev.includes(roleId) ? prev.filter((r) => r !== roleId) : [...prev, roleId]))
  }

  return (
    <Modal title={t('Create a Poll')} onClose={onClose} className="poll-modal">
      <form onSubmit={(e) => (e.preventDefault(), submit())}>
        <div className="field">
          <label htmlFor="poll-q">{t('Question')}</label>
          <input id="poll-q" className="input" maxLength={300} required value={question} onChange={(e) => setQuestion(e.target.value)} placeholder={t('What question do you want to ask?')} autoFocus />
        </div>
        <fieldset className="plain field">
          <legend className="field-label">{t('Answers')}</legend>
          {answers.map((a, i) => (
            <div key={i} className="poll-answer-input" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {isQuiz && (
                <button
                  type="button"
                  className={cls('icon-btn', correctAnswerIdx === i && 'active')}
                  style={{ color: correctAnswerIdx === i ? 'var(--online)' : undefined, flexShrink: 0 }}
                  title={correctAnswerIdx === i ? t('Correct answer') : t('Mark as correct answer')}
                  onClick={() => setCorrectAnswerIdx(correctAnswerIdx === i ? null : i)}
                >
                  <Icon d={ICONS.check} size={18} />
                </button>
              )}
              <input className="input" maxLength={55} aria-label={t('Answer {n}', { n: i + 1 })} placeholder={t('Type your answer')} value={a} onChange={(e) => setAnswers(answers.with(i, e.target.value))} />
              {answers.length > 2 && (
                <button type="button" className="icon-btn" aria-label={t('Remove answer {n}', { n: i + 1 })} onClick={() => setAnswers(answers.filter((_, j) => j !== i))}><Icon d={ICONS.trash} size={18} /></button>
              )}
            </div>
          ))}
          {answers.length < 10 && <button type="button" className="secondary small-btn" onClick={() => setAnswers([...answers, ''])}>{t('+ Add another answer')}</button>}
        </fieldset>
        <div className="field">
          <label htmlFor="poll-d">{t('Duration')}</label>
          <select id="poll-d" className="input" value={duration} onChange={(e) => setDuration(+e.target.value)}>
            {DURATIONS.map(([h, l]) => <option key={h} value={h}>{t(l)}</option>)}
          </select>
        </div>
        <Switch label={t('Allow Multiple Answers')} checked={multi} onChange={setMulti} />
        <Switch label={t('Anonymous Poll (hide voter identities)')} checked={anonymous} onChange={setAnonymous} />
        <Switch label={t('Quiz Mode (mark a correct answer)')} checked={isQuiz} onChange={setIsQuiz} />

        {guild && guild.roles?.length > 1 && (
          <div className="field" style={{ marginTop: '12px' }}>
            <span className="field-label">{t('Restrict Voting to Roles (Optional)')}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
              {guild.roles.filter((r) => r.id !== guild.id).map((r) => {
                const active = allowedRoles.includes(r.id)
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={cls('chip-btn', active && 'active')}
                    style={{ padding: '3px 8px', borderRadius: '12px', fontSize: '12px', background: active ? 'var(--accent)' : 'var(--card)', color: active ? 'var(--on-accent)' : 'var(--text)', border: 'none', cursor: 'pointer' }}
                    onClick={() => toggleRole(r.id)}
                  >
                    @{r.name}
                  </button>
                )
              })}
            </div>
          </div>
        )}

        <FormError error={error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" disabled={busy || !question.trim() || filled.length < 1}>{t('Post')}</button>
        </div>
      </form>
    </Modal>
  )
}
