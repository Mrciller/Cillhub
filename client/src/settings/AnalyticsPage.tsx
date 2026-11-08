import { useEffect, useState } from 'react'
import { getGuildAnalytics } from '../actions'
import { t } from '../i18n'
import type { DailyAnalytics, Guild } from '../types'

export function AnalyticsPage({ guild }: { guild: Guild }) {
  const [days, setDays] = useState(30)
  const [daily, setDaily] = useState<DailyAnalytics[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    setLoading(true)
    getGuildAnalytics(guild.id, days).then(
      (res) => {
        setDaily(res.daily)
        setLoading(false)
      },
      (err: Error) => {
        setError(err.message)
        setLoading(false)
      },
    )
  }, [guild.id, days])

  const totalMessages = daily.reduce((sum, d) => sum + (d.messages_sent || 0), 0)
  const totalJoins = daily.reduce((sum, d) => sum + (d.joins || 0), 0)
  const totalLeaves = daily.reduce((sum, d) => sum + (d.leaves || 0), 0)

  const maxVal = Math.max(10, ...daily.map((d) => Math.max(d.messages_sent || 0, (d.joins || 0) + (d.leaves || 0))))

  return (
    <div className="analytics-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1>{t('Server Analytics')}</h1>
          <p className="hint">{t('Daily aggregate metrics for member activity and engagement.')}</p>
        </div>
        <select className="input" style={{ width: 'auto' }} value={days} onChange={(e) => setDays(+e.target.value)}>
          <option value={7}>{t('Last 7 Days')}</option>
          <option value={30}>{t('Last 30 Days')}</option>
          <option value={90}>{t('Last 90 Days')}</option>
        </select>
      </div>

      {error && <p className="form-error" role="alert">{error}</p>}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '16px', margin: '20px 0' }}>
        <div style={{ padding: '16px', background: 'var(--sidebar)', borderRadius: '8px', border: '1px solid var(--border)' }}>
          <div className="hint small">{t('Messages Sent')}</div>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--header)', marginTop: '4px' }}>{totalMessages.toLocaleString()}</div>
        </div>
        <div style={{ padding: '16px', background: 'var(--sidebar)', borderRadius: '8px', border: '1px solid var(--border)' }}>
          <div className="hint small">{t('Member Joins')}</div>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--online)', marginTop: '4px' }}>+{totalJoins.toLocaleString()}</div>
        </div>
        <div style={{ padding: '16px', background: 'var(--sidebar)', borderRadius: '8px', border: '1px solid var(--border)' }}>
          <div className="hint small">{t('Member Leaves')}</div>
          <div style={{ fontSize: '24px', fontWeight: 'bold', color: 'var(--danger)', marginTop: '4px' }}>-{totalLeaves.toLocaleString()}</div>
        </div>
      </div>

      <h2>{t('Activity Trends')}</h2>
      {loading ? (
        <p className="hint">{t('Loading analytics…')}</p>
      ) : daily.length === 0 ? (
        <p className="hint" style={{ padding: '32px', textAlign: 'center', background: 'var(--sidebar)', borderRadius: '8px' }}>
          {t('No activity recorded in this period yet.')}
        </p>
      ) : (
        <div style={{ background: 'var(--sidebar)', padding: '16px', borderRadius: '8px', border: '1px solid var(--border)' }}>
          <svg viewBox="0 0 600 160" style={{ width: '100%', height: '160px', overflow: 'visible' }}>
            <line x1="0" y1="140" x2="600" y2="140" stroke="var(--border)" strokeWidth="1" />
            {daily.map((d, i) => {
              const x = (i / Math.max(1, daily.length - 1)) * 560 + 20
              const hMsg = Math.min(120, ((d.messages_sent || 0) / maxVal) * 120)
              const hJoin = Math.min(120, ((d.joins || 0) / maxVal) * 120)
              return (
                <g key={d.date}>
                  {/* Messages bar */}
                  <rect x={x - 4} y={140 - hMsg} width="4" height={hMsg} fill="var(--accent)" rx="1">
                    <title>{`${d.date}: ${d.messages_sent} messages`}</title>
                  </rect>
                  {/* Joins bar */}
                  <rect x={x + 1} y={140 - hJoin} width="4" height={hJoin} fill="var(--online)" rx="1">
                    <title>{`${d.date}: ${d.joins} joins`}</title>
                  </rect>
                  {i % Math.ceil(daily.length / 7) === 0 && (
                    <text x={x} y="155" fontSize="10" fill="var(--muted)" textAnchor="middle">
                      {d.date.slice(5)}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
          <div style={{ display: 'flex', gap: '16px', justifyContent: 'center', marginTop: '12px' }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--muted)' }}>
              <span style={{ width: '10px', height: '10px', background: 'var(--accent)', borderRadius: '2px' }} />
              {t('Messages')}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12px', color: 'var(--muted)' }}>
              <span style={{ width: '10px', height: '10px', background: 'var(--online)', borderRadius: '2px' }} />
              {t('Joins')}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
