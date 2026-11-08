// Custom status and bot activities: "Playing …", "Listening to …", an emoji + text bubble.
import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { CustomEmoji } from '../markdown/Markdown'
import { userActivities } from '../selectors'
import { useStore } from '../store'
import type { Activity } from '../types'

export function activityVerb(a: Activity) {
  switch (a.type) {
    case 0: return t('Playing {name}', { name: a.name })
    case 1: return t('Streaming {name}', { name: a.details || a.name })
    case 2: return t('Listening to {name}', { name: a.name })
    case 3: return t('Watching {name}', { name: a.name })
    case 5: return t('Competing in {name}', { name: a.name })
    default: return a.name
  }
}

export const StatusEmoji = ({ e }: { e?: Activity['emoji'] }) =>
  e ? (e.id ? <CustomEmoji id={e.id} name={e.name} animated={e.animated} /> : <span className="status-emoji" aria-hidden="true">{e.name}</span>) : null

/** One line under a name (member list, DMs): the custom status, else the first activity. */
export function StatusLine({ userId }: { userId: string }) {
  const list = useStore((s) => userActivities(s, userId))
  const custom = list.find((a) => a.type === 4)
  const other = list.find((a) => a.type !== 4)
  if (custom && (custom.state || custom.emoji))
    return <span className="status-line ellipsis"><StatusEmoji e={custom.emoji} />{custom.emoji && custom.emoji.id ? ' ' : ''}{custom.state}</span>
  if (other) return <span className="status-line ellipsis">{other.type === 1 ? <span className="streaming-dot" aria-hidden="true" /> : null}{activityVerb(other)}</span>
  return null
}

/** "Playing …" (or another non-custom activity) on its own line, e.g. in voice user rows. */
export function PlayingLine({ userId }: { userId: string }) {
  const a = useStore((s) => userActivities(s, userId)).find((x) => x.type !== 4)
  return a ? <span className="status-line ellipsis playing-line">{activityVerb(a)}</span> : null
}

/** "12:34 elapsed" for an activity with a start time, as on profile cards. */
function Elapsed({ start }: { start: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [])
  const s = Math.max(0, Math.floor((Date.now() - start) / 1000))
  const h = Math.floor(s / 3600)
  const text = `${h ? h + ':' : ''}${String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, '0')}:${String(s % 60).padStart(2, '0')}`
  return <p className="hint small">{t('{time} elapsed', { time: text })}</p>
}

/** Activities in a profile: the custom status bubble and cards for bot activities. */
export function ActivityBlock({ userId }: { userId: string }) {
  const list = useStore((s) => userActivities(s, userId))
  const others = list.filter((a) => a.type !== 4)
  if (!others.length) return null
  return (
    <section className="activity-cards">
      {others.map((a, i) => {
        const buttons = Array.isArray(a.buttons) ? a.buttons.map((b, bi) => {
          if (typeof b === 'string') {
            const url = a.metadata?.button_urls?.[bi] || '#'
            return { label: b, url }
          }
          return b
        }) : []

        return (
          <div key={i} className="activity-card">
            <h3 className="list-heading">{activityVerb(a)}</h3>
            {a.details && <p className="small">{a.details}</p>}
            {a.party?.size && (
              <p className="hint small">
                {t('Party ({current}/{max})', { current: a.party.size[0], max: a.party.size[1] })}
              </p>
            )}
            {a.timestamps?.start && <Elapsed start={a.timestamps.start} />}
            {a.state && <p className="hint small">{a.state}</p>}
            {a.type === 1 && a.url && /^https:\/\//.test(a.url) && (
              <a className="small link" href={a.url} target="_blank" rel="noopener noreferrer">{t('Watch')}</a>
            )}
            {buttons.length > 0 && (
              <div className="activity-actions" style={{ display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' }}>
                {buttons.map((b, bi) => (
                  <a
                    key={bi}
                    className="btn secondary small act-btn"
                    href={b.url && /^https?:\/\//.test(b.url) ? b.url : undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => {
                      if (!b.url || !/^https?:\/\//.test(b.url)) {
                        e.preventDefault()
                      }
                    }}
                  >
                    {b.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </section>
  )
}

export function CustomStatusBubble({ userId }: { userId: string }) {
  const custom = useStore((s) => userActivities(s, userId)).find((a) => a.type === 4)
  if (!custom || (!custom.state && !custom.emoji)) return null
  return <div className="status-bubble"><StatusEmoji e={custom.emoji} /> {custom.state}</div>
}
