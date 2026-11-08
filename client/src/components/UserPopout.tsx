// Profile popout: banner, avatar, names, pronouns, custom status, bio, roles, mutuals, note, Message / Call and your own nickname.
import { useState } from 'react'
import { setMyNick } from '../actions'
import { relative } from '../markdown/Markdown'
import { t } from '../i18n'
import { has, P, timedOutUntil } from '../permissions'
import { ActivityBlock } from '../profiles/Activity'
import { ProfileActions, openFullProfile } from '../profiles/ProfileActions'
import { cardData, Mutuals, NoteField, ProfileCard } from '../profiles/ProfileCard'
import { useProfile } from '../profiles/useProfile'
import { permsOf } from '../selectors'
import { displayName, setState, useStore, type Popout as PopoutState } from '../store'
import { Popover } from './menu'
import { FormError, Icon, ICONS } from './ui'

export function UserPopout() {
  const popout = useStore((s) => s.popout)
  if (!popout) return null
  return <Popout key={`${popout.userId}-${popout.guildId}`} {...popout} />
}

function Popout({ userId, guildId, at }: PopoutState) {
  const s = useStore((x) => x)
  const { profile } = useProfile(userId, guildId)
  const [nick, setNick] = useState<string | null>(null)
  const [error, setError] = useState('')
  const user = s.users[userId] ?? profile?.user
  const guild = guildId ? s.guilds[guildId] : undefined
  const member = guildId ? s.members[guildId]?.[userId] : undefined
  const self = userId === s.me?.id
  const close = () => setState({ popout: null })
  if (!user) return null
  const d = cardData(user, profile, guild, member)
  const canNick = self && guild && has(permsOf(s, guildId), P.CHANGE_NICKNAME)
  const saveNick = () => {
    if (!guild || nick === null) return
    setMyNick(guild.id, nick.trim() || null).then(() => setNick(null), (e: Error) => setError(e.message))
  }
  const full = () => openFullProfile(userId, guildId)
  return (
    <Popover at={at} onClose={close} label={t('{name} profile', { name: d.name })} className="profile">
      <ProfileCard d={d} status={s.presences[userId] ?? 'offline'}>
        {timedOutUntil(member) > 0 && (
          <p className="timed-out-line"><Icon d={ICONS.clock} size={14} /> {t('Timed out until {time} ({rel})', { time: new Date(timedOutUntil(member)).toLocaleString(), rel: relative(timedOutUntil(member)) })}</p>
        )}
        <ActivityBlock userId={userId} />
        <Mutuals profile={profile} onOpen={(tab) => openFullProfile(userId, guildId, tab)} />
        {canNick && (
          nick === null ? (
            <button className="link" onClick={() => setNick(member?.nick ?? '')}>{t('Change Nickname')}</button>
          ) : (
            <form className="nick-form" onSubmit={(e) => (e.preventDefault(), saveNick())}>
              <label className="field-label" htmlFor="nick-input">{t('Server nickname')}</label>
              <input id="nick-input" className="input" maxLength={32} value={nick} onChange={(e) => setNick(e.target.value)} placeholder={displayName(user)} data-autofocus />
              <div className="modal-actions">
                <button type="button" className="secondary" onClick={() => setNick(null)}>{t('Cancel')}</button>
                <button className="primary">{t('Save')}</button>
              </div>
            </form>
          )
        )}
        {!self && <NoteField userId={userId} />}
        <FormError error={error} />
        <ProfileActions user={user} onDone={close} full={full} />
      </ProfileCard>
    </Popover>
  )
}
