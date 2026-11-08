// Full profile modal: big card, tabs About Me / Mutual Servers / Mutual Friends, note, Message and call buttons.
import { useEffect, useState } from 'react'
import { getMutualFriends } from '../actions'
import { Avatar, cls, GuildIcon, Modal } from '../components/ui'
import { t } from '../i18n'
import { navigate } from '../router'
import { displayName, setState, useStore } from '../store'
import type { User } from '../types'
import { ActivityBlock } from './Activity'
import { ProfileActions } from './ProfileActions'
import { cardData, NoteField, ProfileCard } from './ProfileCard'
import { useProfile } from './useProfile'

export function ProfileModal({ userId, guildId, tab: initial, onClose }: { userId: string; guildId?: string; tab?: string; onClose: () => void }) {
  const s = useStore((x) => x)
  const { profile } = useProfile(userId, guildId)
  const [tab, setTab] = useState(initial ?? 'about')
  const [extraFriends, setExtraFriends] = useState<User[] | null>(null)
  const user = s.users[userId] ?? profile?.user
  useEffect(() => {
    if (tab === 'friends' && (!profile?.mutual_friends || profile.mutual_friends.length === 0) && (profile?.mutual_friends_count ?? 0) > 0) {
      getMutualFriends(userId).then(setExtraFriends).catch(() => {})
    }
  }, [tab, userId, profile?.mutual_friends, profile?.mutual_friends_count])
  if (!user) return null
  const guild = guildId ? s.guilds[guildId] : undefined
  const d = cardData(user, profile, guild, guildId ? s.members[guildId]?.[userId] : undefined)
  const mutualGuilds = (profile?.mutual_guilds ?? []).filter((g) => s.guilds[g.id])
  const mutualFriends = (profile?.mutual_friends && profile.mutual_friends.length > 0) ? profile.mutual_friends : (extraFriends ?? [])
  const self = userId === s.me?.id
  const tabs: [string, string][] = [['about', t('About Me')], ...(!self ? [['servers', t('Mutual Servers')] as [string, string], ['friends', t('Mutual Friends')] as [string, string]] : [])]
  return (
    <Modal title={d.name} onClose={onClose} className="profile-modal" hideTitle>
      <ProfileCard d={d} status={s.presences[userId] ?? 'offline'} big>
        <ProfileActions user={user} onDone={onClose} />
        <div className="tabs profile-tabs" role="tablist" aria-label={t('Profile')}>
          {tabs.map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={cls('tab', tab === id && 'on')} onClick={() => setTab(id)}>
              {label}{id === 'servers' ? ` (${mutualGuilds.length})` : id === 'friends' ? ` (${profile?.mutual_friends_count ?? mutualFriends.length})` : ''}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="profile-tabpanel">
          {tab === 'about' && (
            <>
              <ActivityBlock userId={userId} />
              {!self && <NoteField userId={userId} />}
            </>
          )}
          {tab === 'servers' && (
            mutualGuilds.length ? (
              <ul className="mutual-list">
                {mutualGuilds.map((g) => (
                  <li key={g.id}><button className="row" onClick={() => (onClose(), navigate(`/channels/${g.id}`))}>
                    <span className="mini-guild"><GuildIcon guild={s.guilds[g.id]} /></span>
                    <span className="ellipsis">{s.guilds[g.id].name}</span>{g.nick && <span className="hint small">{g.nick}</span>}
                  </button></li>
                ))}
              </ul>
            ) : <p className="hint">{t('No servers in common')}</p>
          )}
          {tab === 'friends' && (
            mutualFriends.length ? (
              <ul className="mutual-list">
                {mutualFriends.map((u) => (
                  <li key={u.id}><button className="row" onClick={() => setState({ modal: { kind: 'profile', userId: u.id } })}>
                    <Avatar user={u} size={32} status={s.presences[u.id] ?? 'offline'} /><span className="ellipsis">{displayName(u)}</span><span className="hint small">{u.username}</span>
                  </button></li>
                ))}
              </ul>
            ) : <p className="hint">{profile?.mutual_friends_count ? t('{n} friends in common', { n: profile.mutual_friends_count }) : t('No friends in common')}</p>
          )}
        </div>
      </ProfileCard>
    </Modal>
  )
}
