import { useEffect } from 'react'
import { loadMembers } from '../actions'
import { sortedRoles, timedOutUntil } from '../permissions'
import { iconRole, nameplateStyle, RoleIcon, ServerTag, StyledName } from '../custom/render'
import { displayName, setState, useStore } from '../store'
import type { Guild, Member, Status } from '../types'
import { useContextMenu } from './menu'
import { Avatar, cls, Icon, ICONS, memberAvatarUrl } from './ui'
import { t } from '../i18n'
import { StatusLine } from '../profiles/Activity'
import { UserMenu } from './UserMenu'
import { ResizeHandle } from './ResizeHandle'

function MemberRow({ guild, m, status }: { guild: Guild; m: Member; status: Status }) {
  const user = useStore((s) => s.users[m.user.id]) ?? m.user
  const menu = useContextMenu()
  const offline = status === 'offline' || status === 'invisible'
  const name = m.nick || displayName(user)
  return (
    <li className={cls('row', offline && 'offline', user.collectibles?.nameplate && 'nameplate')} style={nameplateStyle(user)} {...menu.props}>
      <button
        className="member-btn"
        onClick={(e) => setState({ popout: { userId: m.user.id, guildId: guild.id, at: { rect: e.currentTarget.getBoundingClientRect(), side: 'left' } } })}
      >
        <Avatar user={user} src={memberAvatarUrl(guild.id, m)} size={28} status={status} />
        <span className="member-text">
          <span className="member-name">
            <span className="ellipsis">{offline ? name : <StyledName user={user} member={m} guild={guild} name={name} tag={false} icon={false} />}</span>
            <RoleIcon role={iconRole(guild, m)} size={16} />
            <ServerTag user={user} />
            {user.bot && <span className="bot-tag">{user.module ? t('MODULE') : t('APP')}</span>}
          </span>
          {!offline && <StatusLine userId={m.user.id} />}
        </span>
        {guild.owner_id === m.user.id && <span className="crown" role="img" aria-label={t('Server Owner')} title={t('Server Owner')}>♛</span>}
        {timedOutUntil(m) > 0 && <span className="timed-out" role="img" aria-label={t('Timed out')} title={t('Timed out until {time}', { time: new Date(timedOutUntil(m)).toLocaleString() })}><Icon d={ICONS.clock} size={14} /></span>}
      </button>
      {menu.at && <UserMenu userId={m.user.id} guildId={guild.id} channelId={location.pathname.split('/')[3]} at={menu.at} onClose={menu.close} />}
    </li>
  )
}

export function MemberList({ guild }: { guild: Guild }) {
  const members = useStore((s) => s.members[guild.id])
  const loaded = useStore((s) => !!s.membersLoaded[guild.id])
  const users = useStore((s) => s.users)
  const presences = useStore((s) => s.presences)
  useEffect(() => void (!loaded && loadMembers(guild.id).catch(() => {})), [guild.id, loaded])

  const status = (id: string): Status => presences[id] ?? 'offline'
  const online = (id: string) => !['offline', 'invisible'].includes(status(id))
  const name = (m: Member) => m.nick || displayName(users[m.user.id] ?? m.user)
  const all = loaded ? Object.values(members ?? {}).sort((a, b) => name(a).localeCompare(name(b))) : []
  // Hoisted roles by position, then Online, then Offline (offline members are never hoisted).
  const hoisted = sortedRoles(guild).filter((r) => r.hoist && r.id !== guild.id)
  const groupOf = (m: Member) => hoisted.find((r) => m.roles.includes(r.id))?.id ?? 'online'
  const groups: [string, string, Member[]][] = [
    ...hoisted.map((r): [string, string, Member[]] => [r.id, r.name, all.filter((m) => online(m.user.id) && groupOf(m) === r.id)]),
    ['online', t('Online'), all.filter((m) => online(m.user.id) && groupOf(m) === 'online')],
    ['offline', t('Offline'), all.filter((m) => !online(m.user.id))],
  ]

  return (
    <aside className="members" aria-label={t('Members')}>
      <ResizeHandle
        id="members-resizer"
        side="left"
        defaultValue={216}
        min={160}
        max={420}
        storageKey="cillhub:members-width"
        cssVar="--members-width"
        ariaLabel={t('Resize member list')}
      />
      {groups.map(([key, title, list]) =>
        list.length ? (
          <section key={key}>
            <h2 className="list-heading">{title} — {list.length}</h2>
            <ul>
              {list.map((m) => <MemberRow key={m.user.id} guild={guild} m={m} status={status(m.user.id)} />)}
            </ul>
          </section>
        ) : null,
      )}
    </aside>
  )
}
