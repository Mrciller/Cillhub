// Polls (poll.mdx): vote, live result bars, multiselect, remove vote, end poll, voters popover, and the poll result system message.
import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { endPoll, openMessage, pollVoters, votePoll } from '../actions'
import { ask, toastError } from '../components/dialogs'
import { Popover, type Anchor } from '../components/menu'
import { Avatar, cls, Icon, ICONS } from '../components/ui'
import { CustomEmoji, relative } from '../markdown/Markdown'
import { displayName, useStore } from '../store'
import type { Message, PollMedia, User } from '../types'
import './polls.css'

export const PollEmoji = ({ e }: { e?: PollMedia['emoji'] }) =>
  e?.id ? <CustomEmoji id={e.id} name={e.name ?? 'emoji'} animated={e.animated} /> : e?.name ? <span className="poll-emoji" aria-hidden="true">{e.name}</span> : null

function useNow(every: number) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(t)
  }, [every])
  return now
}

function Voters({ m, answerId, label, at, onClose }: { m: Message; answerId: number; label: string; at: Anchor; onClose: () => void }) {
  const [users, setUsers] = useState<User[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => void pollVoters(m, answerId).then(setUsers, (e: Error) => setError(e.message)), [m, answerId])
  return (
    <Popover at={at} onClose={onClose} label={t('Voters for {label}', { label })} className="poll-voters">
      <h3 className="list-heading">{label}</h3>
      {error && <p className="form-error">{error}</p>}
      {!users && !error && <p className="hint">{t('Loading…')}</p>}
      {users?.length === 0 && <p className="hint">{t('No votes yet.')}</p>}
      <ul>
        {users?.map((u) => <li key={u.id} className="row"><Avatar user={u} size={24} /><span className="ellipsis">{displayName(u)}</span></li>)}
      </ul>
    </Popover>
  )
}

export function PollView({ m, canVote }: { m: Message; canVote: boolean }) {
  const poll = m.poll!
  const meId = useStore((s) => s.me?.id)
  const now = useNow(30_000)
  const counts = poll.results?.answer_counts ?? []
  const mine = counts.filter((c) => c.me_voted).map((c) => c.id)
  const ended = !!poll.results?.is_finalized || (!!poll.expiry && Date.parse(poll.expiry) <= now)
  const [picked, setPicked] = useState<number[]>([])
  const [showResults, setShowResults] = useState(false)
  const [voters, setVoters] = useState<{ id: number; label: string; at: Anchor } | null>(null)
  const total = counts.reduce((a, c) => a + c.count, 0)
  const results = ended || mine.length > 0 || showResults || !canVote
  const top = Math.max(0, ...counts.map((c) => c.count))
  const pick = (id: number) => setPicked(poll.allow_multiselect ? (picked.includes(id) ? picked.filter((x) => x !== id) : [...picked, id]) : [id])
  const vote = () => votePoll(m, picked).then(() => setPicked([]), toastError)
  const end = () =>
    void ask({ title: t('End Poll Now?'), body: <p>{t('This will end the poll for everyone and show the final results.')}</p>, confirm: t('End Now'), danger: true }).then((ok) => void (ok && endPoll(m).catch(toastError)))
  const left = poll.expiry ? Date.parse(poll.expiry) - now : 0
  const groupId = `poll-${m.id}`

  const exportCsv = () => {
    const rows: string[][] = [
      ['Question', `"${(poll.question.text || '').replace(/"/g, '""')}"`],
      ['Total Votes', String(total)],
      ['Anonymous', poll.anonymous ? 'Yes' : 'No'],
      ['Quiz', poll.is_quiz || poll.correct_answer_id != null ? 'Yes' : 'No'],
      [],
      ['Answer ID', 'Answer Text', 'Votes', 'Percentage', 'Correct Answer'],
      ...poll.answers.map((a) => {
        const count = counts.find((x) => x.id === a.answer_id)?.count ?? 0
        const pct = total ? Math.round((count / total) * 100) : 0
        const isCorrect = poll.correct_answer_id != null && a.answer_id === poll.correct_answer_id ? 'Yes' : ''
        return [
          String(a.answer_id),
          `"${(a.poll_media.text || '').replace(/"/g, '""')}"`,
          String(count),
          `${pct}%`,
          isCorrect,
        ]
      }),
    ]
    const csvContent = rows.map((r) => r.join(',')).join('\n')
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `poll-${m.id}-results.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  return (
    <section className="poll" aria-labelledby={`${groupId}-q`}>
      <h4 id={`${groupId}-q`} className="poll-q">{poll.question.text}</h4>
      <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap', margin: '4px 0' }}>
        <p className="hint small" style={{ margin: 0 }}>
          {ended ? t('Poll closed') : poll.allow_multiselect ? t('Select one or more answers') : t('Select one answer')}
        </p>
        {poll.anonymous && (
          <span style={{ fontSize: '11px', background: 'rgba(255,255,255,0.1)', padding: '1px 6px', borderRadius: '4px' }}>
            🔒 {t('Anonymous')}
          </span>
        )}
        {(poll.is_quiz || poll.correct_answer_id != null) && (
          <span style={{ fontSize: '11px', background: 'rgba(240, 178, 50, 0.2)', color: '#f0b232', padding: '1px 6px', borderRadius: '4px' }}>
            💡 {t('Quiz')}
          </span>
        )}
        {poll.allowed_role_ids && poll.allowed_role_ids.length > 0 && (
          <span style={{ fontSize: '11px', background: 'rgba(88, 101, 242, 0.2)', color: '#85b0ff', padding: '1px 6px', borderRadius: '4px' }}>
            🛡️ {t('Role-Restricted')}
          </span>
        )}
      </div>
      <div className="poll-answers" role={results ? 'list' : poll.allow_multiselect ? 'group' : 'radiogroup'} aria-labelledby={`${groupId}-q`}>
        {poll.answers.map((a) => {
          const c = counts.find((x) => x.id === a.answer_id)
          const n = c?.count ?? 0
          const pct = total ? Math.round((n / total) * 100) : 0
          const label = a.poll_media.text ?? ''
          const isCorrect = poll.correct_answer_id != null && a.answer_id === poll.correct_answer_id
          if (results)
            return (
              <div
                key={a.answer_id}
                role="listitem"
                className={cls('poll-answer result', c?.me_voted && 'mine', ended && n === top && top > 0 && 'winner')}
                style={isCorrect ? { border: '2px solid #23a55a', background: 'rgba(35, 165, 90, 0.1)' } : undefined}
              >
                <span className="poll-bar" style={{ width: `${pct}%`, background: isCorrect ? 'rgba(35, 165, 90, 0.3)' : undefined }} aria-hidden="true" />
                <PollEmoji e={a.poll_media.emoji} />
                <span className="poll-text ellipsis">{label}</span>
                {isCorrect && (
                  <span style={{ color: '#23a55a', fontWeight: 600, fontSize: '11px', marginLeft: '6px', whiteSpace: 'nowrap' }}>
                    ✓ {t('Correct')}
                  </span>
                )}
                {c?.me_voted && <Icon d={ICONS.check} size={16} className="poll-check" />}
                <button
                  className="poll-count"
                  disabled={poll.anonymous}
                  aria-label={t(n === 1 ? '{label}: {n} vote, {pct}%. Show voters' : '{label}: {n} votes, {pct}%. Show voters', { label, n, pct })}
                  onClick={poll.anonymous ? undefined : (e) => setVoters({ id: a.answer_id, label, at: { rect: e.currentTarget.getBoundingClientRect(), side: 'right' } })}
                  style={poll.anonymous ? { cursor: 'default' } : undefined}
                >
                  {n} <span className="hint">· {pct}%</span>
                </button>
              </div>
            )
          const on = picked.includes(a.answer_id)
          return (
            <button key={a.answer_id} className={cls('poll-answer', on && 'on')} role={poll.allow_multiselect ? 'checkbox' : 'radio'} aria-checked={on} onClick={() => pick(a.answer_id)}>
              <PollEmoji e={a.poll_media.emoji} />
              <span className="poll-text ellipsis">{label}</span>
              <span className={cls('poll-tick', poll.allow_multiselect && 'square')} aria-hidden="true" />
            </button>
          )
        })}
      </div>
      <div className="poll-foot">
        <span className="hint small" aria-live="polite">
          {t(total === 1 ? '{n} vote' : '{n} votes', { n: total })} · {ended ? t('Poll closed') : left > 0 ? t('{time} left', { time: relative(Date.parse(poll.expiry!)).replace(/^in /, '') }) : ''}
        </span>
        <button type="button" className="link small" onClick={exportCsv}>{t('Export CSV')}</button>
        <span className="spacer" />
        {!ended && canVote && mine.length > 0 && <button className="link small" onClick={() => votePoll(m, []).catch(toastError)}>{t('Remove Vote')}</button>}
        {!ended && canVote && !mine.length && (showResults
          ? <button className="link small" onClick={() => setShowResults(false)}>{t('Go back to vote')}</button>
          : <button className="link small" onClick={() => setShowResults(true)}>{t('Show results')}</button>)}
        {!ended && m.author.id === meId && <button className="link small" onClick={end}>{t('End Poll')}</button>}
        {!results && <button className="primary small-btn" disabled={!picked.length} onClick={vote}>{t('Vote')}</button>}
      </div>
      {voters && <Voters m={m} answerId={voters.id} label={voters.label} at={voters.at} onClose={() => setVoters(null)} />}
    </section>
  )
}

/** Type 46: "<author>'s poll <question> has closed" with the winner, from the poll_result embed fields. */
export function PollResult({ m, name }: { m: Message; name: string }) {
  const fields = Object.fromEntries((m.embeds.find((e) => e.type === 'poll_result')?.fields ?? []).map((f) => [f.name, f.value]))
  const total = Number(fields.total_votes ?? 0)
  const votes = Number(fields.victor_answer_votes ?? 0)
  const ref = m.message_reference
  return (
    <div className="poll-result">
      <Icon d={ICONS.poll} size={20} className="join-arrow" />
      <div>
        <p>{t("{name}'s poll {question} has closed.", { name, question: fields.poll_question_text ?? '' })}</p>
        <p className="hint small">
          {fields.victor_answer_text ? <>{t('Winning answer:')} <strong>{fields.victor_answer_emoji_name ? `${fields.victor_answer_emoji_name} ` : ''}{fields.victor_answer_text}</strong> ({total ? Math.round((votes / total) * 100) : 0}%)</> : t('There was no winner.')}
          {' · '}{t(total === 1 ? '{n} vote' : '{n} votes', { n: total })}
        </p>
      </div>
      {ref && <button className="secondary small-btn" onClick={() => void openMessage(ref.channel_id ?? m.channel_id, ref.message_id)}>{t('View Poll')}</button>}
    </div>
  )
}
