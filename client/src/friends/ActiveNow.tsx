// "Active Now" shelf: displays live games, streams, and activities of friends
import { openDm } from '../actions'
import { Avatar, Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { activityVerb } from '../profiles/Activity'
import { userActivities } from '../selectors'
import { displayName, useStore } from '../store'
import type { Activity } from '../types'

export function ActiveNow() {
  const rels = useStore((s) => s.relationships)
  const users = useStore((s) => s.users)
  const presences = useStore((s) => s.presences)
  const store = useStore((s) => s)

  const friends = Object.values(rels).filter((r) => r.type === 1)
  const activeFriends: { id: string; activity: Activity }[] = []

  for (const f of friends) {
    const status = presences[f.id]
    if (!status || status === 'offline' || status === 'invisible') continue
    const acts = userActivities(store, f.id).filter((a) => a.type !== 4) // ignore custom status
    if (acts.length > 0) {
      activeFriends.push({ id: f.id, activity: acts[0] })
    }
  }

  if (!activeFriends.length) {
    return (
      <aside className="active-now-shelf" aria-label={t('Active Now')}>
        <h2 className="shelf-title">{t('Active Now')}</h2>
        <div className="empty-active-now">
          <p className="bold">{t("It's quiet for now…")}</p>
          <p className="hint small">{t("When friends are playing games or streaming, you'll see them here!")}</p>
        </div>
      </aside>
    )
  }

  return (
    <aside className="active-now-shelf" aria-label={t('Active Now')}>
      <h2 className="shelf-title">{t('Active Now')}</h2>
      <div className="active-cards-list">
        {activeFriends.map(({ id, activity }) => {
          const user = users[id]
          if (!user) return null
          const elapsedMins = activity.timestamps?.start
            ? Math.max(1, Math.floor((Date.now() - activity.timestamps.start) / 60000))
            : null

          return (
            <div key={id} className="active-now-card">
              <div className="card-top">
                <Avatar user={user} size={36} status={presences[id]} />
                <div className="card-user-info">
                  <span className="user-name">{displayName(user)}</span>
                  <span className="game-name">{activity.name}</span>
                </div>
              </div>
              <div className="card-body">
                <span className="act-verb">{activityVerb(activity)}</span>
                {activity.details && <span className="act-details hint small ellipsis">{activity.details}</span>}
                {elapsedMins !== null && (
                  <span className="act-time hint small">{t('{n}m elapsed', { n: elapsedMins })}</span>
                )}
              </div>
              <div className="card-actions">
                <button
                  className="btn secondary tiny"
                  onClick={() => openDm(id).catch(() => {})}
                  aria-label={t('Message {name}', { name: displayName(user) })}
                >
                  <Icon d={ICONS.chat} size={14} />
                  <span>{t('Message')}</span>
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </aside>
  )
}
