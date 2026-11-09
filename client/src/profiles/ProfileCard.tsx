// The profile card shared by the popout, the full profile modal and the live preview in Settings → Profiles.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { getNote, setNote } from '../actions'
import { shortDate } from '../appearance/format'
import { useMdContext } from '../chat/MessageList'
import { Avatar, avatarUrl, bannerUrl, cls, memberAvatarUrl, memberBannerUrl, Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { Markdown, safeUrl } from '../markdown/Markdown'
import { sortedRoles } from '../permissions'
import { displayName, useStore } from '../store'
import type { Guild, Member, Profile, Status, User, UserConnection } from '../types'
import { SERVICES } from '../settings/ConnectionsSettings'
import { CustomStatusBubble } from './Activity'
import './profiles.css'
import { ProfileEffect, profileThemeStyle, RoleIcon, roleSwatch, StyledName } from '../custom/render'
import { Widgets } from '../custom/Widgets'

const hex = (n?: number | null) => (n || n === 0 ? '#' + n.toString(16).padStart(6, '0') : undefined)

/** What a card shows; the settings preview passes unsaved values. */
export type CardData = { user: User; name: string; pronouns?: string; bio?: string; banner?: string | null; accent?: number | null; avatar?: string | null; member?: Member; guild?: Guild; connected_accounts?: UserConnection[] }

/** Merges the store's user, the fetched profile and the server profile (server profile fields win). */
export function cardData(user: User, profile: Profile | undefined, guild: Guild | undefined, member: Member | undefined): CardData {
  const up = profile?.user_profile
  const gp = profile?.guild_member_profile
  const m = member ?? profile?.guild_member
  const u: User = { ...profile?.user, ...user }
  // v6: theme colours and the profile effect come in user_profile (user docs shape)
  if (up?.theme_colors !== undefined) u.theme_colors = up.theme_colors
  if (up?.profile_effect !== undefined) u.profile_effect = up.profile_effect
  if (up?.widgets) u.widgets = up.widgets
  return {
    user: u, guild, member: m,
    name: m?.nick || displayName(u),
    pronouns: gp?.pronouns || up?.pronouns || u.pronouns || '',
    bio: m?.bio || gp?.bio || up?.bio || profile?.user.bio || u.bio || '',
    banner: memberBannerUrl(guild?.id, m) ?? (gp?.banner && guild ? memberBannerUrl(guild.id, { ...m!, banner: gp.banner }) : null) ?? bannerUrl(up?.banner ? { ...u, banner: up.banner } : u),
    accent: up?.accent_color ?? u.accent_color ?? null,
    avatar: memberAvatarUrl(guild?.id, m) ?? avatarUrl(u),
    connected_accounts: profile?.connected_accounts ?? [],
  }
}

export function ProfileCard({ d, status, big, children, badges }: { d: CardData; status?: Status; big?: boolean; children?: ReactNode; badges?: ReactNode }) {
  const ctx = useMdContext(d.guild)
  const roles = d.guild && d.member ? sortedRoles(d.guild).filter((r) => d.member!.roles.includes(r.id)) : []
  const accent = hex(d.accent)
  return (
    <div className={cls('pcard', big && 'big', d.user.theme_colors && 'themed')} style={{ ...(accent && ({ '--accent-color': accent } as CSSProperties)), ...profileThemeStyle(d.user.theme_colors) }}>
      <ProfileEffect id={d.user.profile_effect?.id} />
      <div className="pcard-banner" style={d.banner ? { backgroundImage: `url("${d.banner}")` } : { background: accent ?? (d.user.theme_colors ? hex(d.user.theme_colors[0]) : 'var(--accent)') }} />
      <div className="pcard-head">
        <div className="pcard-avatar"><Avatar user={d.user} src={d.avatar} size={big ? 120 : 80} status={status} /></div>
        <CustomStatusBubble userId={d.user.id} />
      </div>
      <div className="pcard-body">
        <h2 className="profile-name"><StyledName user={d.user} member={d.member} guild={d.guild} name={d.name} /> {d.user.bot && <span className="bot-tag">{d.user.module ? t('MODULE') : t('APP')}</span>}</h2>
        <p className="hint">{d.user.username}{d.pronouns ? <> · <span className="pronouns">{d.pronouns}</span></> : null}</p>
        {badges}
        {d.bio && (
          <section className="pcard-section">
            <h3 className="list-heading">{t('About Me')}</h3>
            <div className="pcard-bio"><Markdown content={d.bio} ctx={ctx} /></div>
          </section>
        )}
        {d.member?.joined_at && d.guild && (
          <section className="pcard-section">
            <h3 className="list-heading">{t('Member Since')}</h3>
            <p className="small">{shortDate(d.member.joined_at)}</p>
          </section>
        )}
        {roles.length > 0 && (
          <section className="pcard-section">
            <h3 className="list-heading">{t('Roles')}</h3>
            <ul className="role-chips">
              {roles.map((r) => <li key={r.id} className="role-chip"><span className="role-dot" style={{ background: roleSwatch(r) }} aria-hidden="true" /><RoleIcon role={r} size={14} />{r.name}</li>)}
            </ul>
          </section>
        )}
        {d.connected_accounts && d.connected_accounts.length > 0 && (
          <section className="pcard-section">
            <h3 className="list-heading">{t('Connected Accounts')}</h3>
            <ul className="connected-accounts-badges">
              {d.connected_accounts.map((c) => {
                const srv = SERVICES[c.type.toLowerCase()]
                const url = safeUrl(c.metadata?.profile_url ?? '') || srv?.url(c.name) || '#'
                return (
                  <li key={c.id || `${c.type}-${c.name}`} className="conn-badge-item">
                    <a
                      href={url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="conn-badge-link"
                      title={c.name}
                    >
                      <div className="conn-badge-icon" style={{ background: srv?.color ?? '#5865f2' }}>
                        {srv?.icon ? (
                          <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
                            <path d={srv.icon} />
                          </svg>
                        ) : (
                          <Icon d={ICONS.link} size={14} />
                        )}
                      </div>
                      <span className="conn-badge-name ellipsis">{c.name}</span>
                      {c.verified && (
                        <span className="conn-badge-check" title={t('Verified')}>
                          <Icon d={ICONS.check} size={10} />
                        </span>
                      )}
                      <Icon d={ICONS.external} size={12} className="conn-external-icon" />
                    </a>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
        {big && <Widgets list={d.user.widgets} />}
        {children}
      </div>
    </div>
  )
}

/** Private note about a user (GET/PUT /users/@me/notes/:id), saved when the field loses focus. */
export function NoteField({ userId }: { userId: string }) {
  const [note, setValue] = useState<string | null>(null)
  const saved = useRef('')
  const [error, setError] = useState('')
  useEffect(() => void getNote(userId).then((n) => ((saved.current = n), setValue(n))), [userId])
  const save = () => {
    if (note === null || note === saved.current) return
    setNote(userId, note).then(() => ((saved.current = note), setError('')), (e: Error) => setError(e.message))
  }
  return (
    <section className="pcard-section">
      <label className="list-heading" htmlFor={`note-${userId}`}>{t('Note')}</label>
      <textarea id={`note-${userId}`} className="note-field" rows={2} maxLength={256} placeholder={t('Click to add a note')} value={note ?? ''} disabled={note === null}
        onChange={(e) => setValue(e.target.value)} onBlur={save} onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && (e.preventDefault(), e.currentTarget.blur())} />
      {error && <p className="form-error" role="alert">{error}</p>}
    </section>
  )
}

/** "3 Mutual Servers · 2 Mutual Friends". */
export function Mutuals({ profile, onOpen }: { profile?: Profile; onOpen?: (tab: 'servers' | 'friends') => void }) {
  const guilds = useStore((s) => s.guilds)
  if (!profile) return null
  const servers = (profile.mutual_guilds ?? []).filter((g) => guilds[g.id]).length
  const friends = profile.mutual_friends_count ?? profile.mutual_friends?.length ?? 0
  if (!servers && !friends) return null
  return (
    <div className="mutuals-box">
      <p className="mutuals small">
        {servers > 0 && <button className="link" onClick={() => onOpen?.('servers')}>{t(servers === 1 ? '{n} Mutual Server' : '{n} Mutual Servers', { n: servers })}</button>}
        {servers > 0 && friends > 0 && ' · '}
        {friends > 0 && <button className="link" onClick={() => onOpen?.('friends')}>{t(friends === 1 ? '{n} Mutual Friend' : '{n} Mutual Friends', { n: friends })}</button>}
      </p>
      {profile.mutual_friends && profile.mutual_friends.length > 0 && (
        <div className="mutual-avatars-row" onClick={() => onOpen?.('friends')} role="button" tabIndex={0}>
          <div className="avatar-stack">
            {profile.mutual_friends.slice(0, 3).map((u) => (
              <span key={u.id} className="mini-avatar" title={displayName(u)}>
                <Avatar user={u} size={20} />
              </span>
            ))}
          </div>
          <span className="hint small">
            {profile.mutual_friends.slice(0, 2).map((u) => displayName(u)).join(', ')}
            {profile.mutual_friends.length > 2 ? t(' and {n} more', { n: profile.mutual_friends.length - 2 }) : ''}
          </span>
        </div>
      )}
    </div>
  )
}
