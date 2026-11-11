// Overview: stat tiles, messages per day (single-series SVG bar chart with hover/focus tooltip and a table view), health.
import { useState } from 'react'
import { FormError } from '../components/ui'
import { t } from '../i18n'
import { getOverview, type Overview as OverviewData } from './api'
import { bytes, day, num, useLoad, when } from './util'
import { Link } from '../router'

type Status = 'ok' | 'down' | 'off'
const HEALTH: Record<Status, [string, string]> = { ok: ['✓', 'OK'], down: ['✕', 'Down'], off: ['–', 'Not configured'] }

function duration(s: number) {
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  return d ? t('{d} d {h} h', { d, h }) : t('{h} h {m} min', { h, m })
}

export function Overview() {
  const { data: s, error } = useLoad(getOverview, [])
  if (error) return <FormError error={error} />
  if (!s) return <p className="hint" aria-busy="true">{t('Loading…')}</p>
  const tiles: [string, string, string?][] = [
    [t('Users'), num(s.users.total), t('{n} online now', { n: num(s.users.online) })],
    [t('Active (24 h)'), num(s.users.active_24h), t('{n} in 7 days', { n: num(s.users.active_7d) })],
    [t('Servers'), num(s.guilds), t('{n} channels', { n: num(s.channels) })],
    [t('Messages'), num(s.messages.total)],
    [t('Voice minutes (30 days)'), num(s.voice.minutes_30d), t('{n} in voice now', { n: num(s.voice.in_voice_now) })],
    [t('Open reports'), num(s.reports_open), s.appeals_open ? t('{n} open appeals', { n: num(s.appeals_open) }) : undefined],
    [t('Uploads'), bytes(s.storage.uploads_bytes)],
    [t('Database'), bytes(s.storage.database_bytes)],
    ...(s.disk ? [[t('Disk free'), bytes(s.disk.free_bytes), t('of {total}', { total: bytes(s.disk.total_bytes) })] as [string, string, string]] : []),
    [t('Uptime'), duration(s.uptime_seconds), t('Version {v}', { v: s.version })],
  ]
  const b = s.voice.backends
  const health: [string, Status, string?][] = [
    ['LiveKit', !b.livekit.configured ? 'off' : b.livekit.reachable ? 'ok' : 'down'],
    ['cillvoice', !b.cillvoice.configured ? 'off' : b.cillvoice.running ? 'ok' : 'down', b.cillvoice.rooms !== undefined ? t('{n} rooms', { n: b.cillvoice.rooms }) : undefined],
  ]
  return (
    <>
      {s.legal_incomplete && (
        <p className="admin-warning" role="alert">
          <strong>{t('Legal pages incomplete')}</strong> · {t('Fill in the operator details, the imprint, the privacy notice and the terms of use.')}{' '}
          <Link to="/admin/settings" className="link">{t('Open Instance Settings')}</Link>
        </p>
      )}
      <ul className="admin-tiles" aria-label={t('Instance statistics')}>
        {tiles.map(([label, value, sub]) => (
          <li key={label} className="admin-tile"><span className="admin-tile-label">{label}</span><strong className="admin-tile-value">{value}</strong>{sub && <span className="hint small">{sub}</span>}</li>
        ))}
      </ul>
      <MessagesChart data={s.messages.per_day} />
      <section className="admin-card" aria-labelledby="health-h">
        <h2 id="health-h">{t('Voice health')}</h2>
        <ul className="admin-health">
          {health.map(([name, st, extra]) => (
            <li key={name} className={`health-${st}`}>
              <span aria-hidden="true" className="health-icon">{HEALTH[st][0]}</span> {name}: {t(HEALTH[st][1])}
              {extra && <span className="hint small"> · {extra}</span>}
              {b.default === name.toLowerCase() && <span className="hint small"> ({t('default for new calls')})</span>}
            </li>
          ))}
        </ul>
      </section>
      <Errors list={s.recent_errors} />
    </>
  )
}

function Errors({ list }: { list: OverviewData['recent_errors'] }) {
  return (
    <section className="admin-card" aria-labelledby="errors-h">
      <h2 id="errors-h">{t('Recent server errors')}</h2>
      {list.length === 0 ? <p className="hint">{t('No errors logged recently.')}</p> : (
        <ul className="admin-errors">{list.map((e, i) => <li key={i}><time dateTime={e.at}>{when(e.at)}</time> <code>{e.message}</code></li>)}</ul>
      )}
    </section>
  )
}

// Geometry in SVG user units; the SVG scales to the card width.
const W = 720
const H = 220
const PAD = { top: 12, right: 8, bottom: 28, left: 44 }

function MessagesChart({ data }: { data: OverviewData['messages']['per_day'] }) {
  const [hover, setHover] = useState<number | null>(null)
  const max = Math.max(1, ...data.map((d) => d.count))
  // A round top for the y axis: 1, 2 or 5 times a power of ten.
  const p = 10 ** Math.floor(Math.log10(max))
  const top = [1, 2, 5, 10].map((m) => m * p).find((v) => v >= max)!
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const slot = plotW / Math.max(1, data.length)
  const bar = Math.max(2, slot - 2) // 2-unit surface gap between bars
  const y = (v: number) => PAD.top + plotH - (v / top) * plotH
  const total = data.reduce((a, d) => a + d.count, 0)
  const h = hover === null ? null : data[hover]
  const ticks = data.length ? [0, Math.floor((data.length - 1) / 2), data.length - 1] : []
  return (
    <section className="admin-card" aria-labelledby="mpd-h">
      <h2 id="mpd-h">{t('Messages per day')}</h2>
      <p className="hint small">{t('Last {n} days, {total} messages in total.', { n: data.length, total: num(total) })}</p>
      {data.length === 0 ? <p className="hint">{t('No data yet.')}</p> : (
        <div className="admin-chart">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={t('Bar chart of messages per day; the same numbers are in the table below.')} onMouseLeave={() => setHover(null)}>
            {[0, top / 2, top].map((v) => (
              <g key={v}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(v)} y2={y(v)} className="chart-grid" />
                <text x={PAD.left - 6} y={y(v)} className="chart-label" textAnchor="end" dominantBaseline="middle">{num(v)}</text>
              </g>
            ))}
            {data.map((d, i) => {
              const x = PAD.left + i * slot + (slot - bar) / 2
              const bh = Math.max(d.count ? 2 : 0, plotH - (y(d.count) - PAD.top))
              const r = Math.min(4, bar / 2, bh)
              const yb = PAD.top + plotH
              // Rounded data end, square at the baseline.
              const path = bh ? `M${x},${yb} V${yb - bh + r} Q${x},${yb - bh} ${x + r},${yb - bh} H${x + bar - r} Q${x + bar},${yb - bh} ${x + bar},${yb - bh + r} V${yb} Z` : ''
              return (
                <g key={d.date} onMouseEnter={() => setHover(i)}>
                  <rect x={PAD.left + i * slot} y={PAD.top} width={slot} height={plotH} className="chart-hit" />
                  {path && <path d={path} className={hover === i ? 'chart-bar on' : 'chart-bar'} />}
                </g>
              )
            })}
            {ticks.map((i) => (
              <text key={i} x={PAD.left + i * slot + slot / 2} y={H - 8} className="chart-label" textAnchor={i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle'}>{day(data[i].date)}</text>
            ))}
          </svg>
          {h && hover !== null && (
            <div className="chart-tip" style={{ left: `${((PAD.left + hover * slot + slot / 2) / W) * 100}%` }} aria-hidden="true">
              <strong>{num(h.count)}</strong> {day(h.date)}
            </div>
          )}
        </div>
      )}
      {data.length > 0 && (
        <details className="admin-details">
          <summary>{t('Show as table')}</summary>
          <table className="admin-table">
            <caption className="sr-only">{t('Messages per day')}</caption>
            <thead><tr><th scope="col">{t('Date')}</th><th scope="col" className="num">{t('Messages')}</th></tr></thead>
            <tbody>{data.map((d) => <tr key={d.date}><td>{day(d.date)}</td><td className="num">{num(d.count)}</td></tr>)}</tbody>
          </table>
        </details>
      )}
    </section>
  )
}
