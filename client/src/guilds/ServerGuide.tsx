import { useEffect, useState } from 'react'
import { api } from '../api'
import { t } from '../i18n'
import { navigate } from '../router'
import { setState, useStore } from '../store'
import type { Guild, GuildGuide } from '../types'
import { cls, GuildIcon, Icon, ICONS } from '../components/ui'
import './guide.css'

export function ServerGuideSidebarEntry({ guild }: { guild: Guild }) {
  const guideGuildId = useStore((s) => s.guideGuildId)
  const [guide, setGuide] = useState<GuildGuide | null>(guild.guide ?? null)

  useEffect(() => {
    if (guild.guide !== undefined) {
      setGuide(guild.guide)
    } else {
      api<GuildGuide>(`/guilds/${guild.id}/guide`)
        .then((g) => {
          setGuide(g)
          setState((s) => ({
            guilds: {
              ...s.guilds,
              [guild.id]: { ...s.guilds[guild.id], guide: g },
            },
          }))
        })
        .catch(() => setGuide(null))
    }
  }, [guild.id, guild.guide])

  if (!guide || !guide.enabled) return null

  const active = guideGuildId === guild.id

  return (
    <div className="server-guide-entry">
      <button
        className={cls('row server-guide-row', active && 'active')}
        aria-current={active ? 'page' : undefined}
        onClick={() => setState({ guideGuildId: guild.id, showNav: false, modulePage: null })}
      >
        <Icon d={ICONS.compass} size={18} />
        <span className="ellipsis">{t('Server Guide')}</span>
      </button>
    </div>
  )
}

export function ServerGuide({ guild, onClose }: { guild: Guild; onClose?: () => void }) {
  const [guide, setGuide] = useState<GuildGuide | null>(guild.guide ?? null)
  const [loading, setLoading] = useState(!guild.guide)
  const channels = useStore((s) => s.channels)

  const storageKey = `cillhub:guide-completed:${guild.id}`
  const [completed, setCompleted] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? '[]')
    } catch {
      return []
    }
  })

  useEffect(() => {
    if (!guild.guide) {
      setLoading(true)
      api<GuildGuide>(`/guilds/${guild.id}/guide`)
        .then((g) => {
          setGuide(g)
          setLoading(false)
        })
        .catch(() => setLoading(false))
    } else {
      setGuide(guild.guide)
    }
  }, [guild.id, guild.guide])

  const toggleAction = (actionId: string) => {
    const next = completed.includes(actionId)
      ? completed.filter((id) => id !== actionId)
      : [...completed, actionId]
    setCompleted(next)
    try {
      localStorage.setItem(storageKey, JSON.stringify(next))
    } catch {}
  }

  const jumpToChannel = (channelId: string) => {
    setState({ guideGuildId: null, showNav: false })
    navigate(`/channels/${guild.id}/${channelId}`)
  }

  if (loading) {
    return (
      <main className="server-guide-page loading">
        <p className="hint">{t('Loading Server Guide…')}</p>
      </main>
    )
  }

  const actions = guide?.new_member_actions ?? []
  const resources = guide?.resource_pages ?? []
  const totalActions = actions.length
  const completedCount = actions.filter((a) => completed.includes(a.id)).length
  const progressPercent = totalActions > 0 ? Math.round((completedCount / totalActions) * 100) : 0

  return (
    <main className="server-guide-page">
      <header className="guide-header">
        <div className="guide-header-main">
          <div className="guide-guild-badge">
            <GuildIcon guild={guild} />
          </div>
          <div>
            <h1>{t('Welcome to {name}', { name: guild.name })}</h1>
            <p className="hint small">{t('Complete these get-started tasks and explore server resources.')}</p>
          </div>
        </div>
        {onClose && (
          <button className="icon-btn" aria-label={t('Close Guide')} onClick={onClose}>
            <Icon d={ICONS.close} size={20} />
          </button>
        )}
      </header>

      {guide?.welcome_message && (
        <section className="guide-welcome-card" aria-label={t('Welcome Message')}>
          <div className="guide-welcome-icon">
            <Icon d={ICONS.smile} size={24} />
          </div>
          <div className="guide-welcome-content">
            <h3>{t('From the Server Team')}</h3>
            <p className="guide-welcome-text">{guide.welcome_message}</p>
          </div>
        </section>
      )}

      {actions.length > 0 && (
        <section className="guide-section" aria-label={t('Get Started Checklist')}>
          <div className="guide-section-head">
            <div>
              <h2>{t('To-Do List')}</h2>
              <span className="hint small">
                {t('{done} of {total} completed ({pct}%)', {
                  done: completedCount,
                  total: totalActions,
                  pct: progressPercent,
                })}
              </span>
            </div>
            <div className="guide-progress-bar-bg" role="progressbar" aria-valuenow={progressPercent} aria-valuemin={0} aria-valuemax={100}>
              <div className="guide-progress-bar-fill" style={{ width: `${progressPercent}%` }} />
            </div>
          </div>

          <ul className="guide-action-list">
            {actions.map((action) => {
              const isDone = completed.includes(action.id)
              const ch = action.channel_id ? channels[action.channel_id] : undefined
              return (
                <li key={action.id} className={cls('guide-action-item', isDone && 'completed')}>
                  <label className="guide-checkbox-label">
                    <input
                      type="checkbox"
                      checked={isDone}
                      onChange={() => toggleAction(action.id)}
                      className="guide-checkbox"
                    />
                    <span className="guide-custom-checkbox" aria-hidden="true">
                      {isDone && <Icon d={ICONS.check} size={14} />}
                    </span>
                  </label>
                  <div className="guide-action-body">
                    <h3 className={cls('guide-action-title', isDone && 'strike')}>{action.title}</h3>
                    {action.description && <p className="hint small">{action.description}</p>}
                  </div>
                  {action.channel_id && (
                    <button
                      className="secondary small-btn guide-jump-btn"
                      onClick={() => jumpToChannel(action.channel_id)}
                      title={ch ? `#${ch.name}` : t('Go to channel')}
                    >
                      <Icon d={ICONS.arrowRight} size={14} />
                      <span>{ch ? `#${ch.name}` : t('Visit')}</span>
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {resources.length > 0 && (
        <section className="guide-section" aria-label={t('Resource Pages')}>
          <div className="guide-section-head">
            <h2>{t('Resource Pages')}</h2>
            <span className="hint small">{t('Essential guides, rules, and server information')}</span>
          </div>

          <div className="guide-resource-grid">
            {resources.map((res) => {
              const ch = res.channel_id ? channels[res.channel_id] : undefined
              return (
                <div key={res.id} className="guide-resource-card">
                  <div className="guide-resource-head">
                    <div className="guide-resource-icon">
                      <Icon d={ICONS.tag} size={20} />
                    </div>
                    <h3 className="guide-resource-title">{res.title}</h3>
                  </div>
                  {res.description && <p className="hint small guide-resource-desc">{res.description}</p>}
                  {res.channel_id && (
                    <div className="guide-resource-footer">
                      <button
                        className="primary small-btn"
                        onClick={() => jumpToChannel(res.channel_id)}
                      >
                        {ch ? `#${ch.name}` : t('Read Page')}
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </section>
      )}
    </main>
  )
}
