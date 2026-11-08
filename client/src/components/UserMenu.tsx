// Context menu for a user in a guild or DM: profile, message, nickname, roles, voice moderation, kick, ban.
import { useState } from 'react'
import { openDm, patchMember, transferGuild, unblockUser } from '../actions'
import { callUser } from '../calls/calls'
import { AppsSection } from '../chat/MessageItem'
import { t } from '../i18n'
import { confirmBlock, openFullProfile } from '../profiles/ProfileActions'
import { confirmKick } from '../moderation/kick'
import { canManageRole, canTimeout, has, outranks, P, sortedRoles, timedOutUntil } from '../permissions'
import { memberName, myMember, permsOf } from '../selectors'
import { setState, useStore } from '../store'
import { isSoundboardMuted, setUserVolume, toggleMuteSoundboard } from '../voice/engine'
import { voiceSettings } from '../voice/settings'
import { ask, askText, toastError } from './dialogs'
import { MenuItem, MenuLabel, MenuSep, Popover, type Anchor } from './menu'

const fail = (e: Error) => toastError(e)

export function UserMenu({ userId, guildId, channelId, at, onClose }: { userId: string; guildId?: string; channelId?: string; at: Anchor; onClose: () => void }) {
  const s = useStore((x) => x)
  const me = s.me!
  const guild = guildId ? s.guilds[guildId] : undefined
  const mine = myMember(s, guildId)
  const target = guildId ? s.members[guildId]?.[userId] : undefined
  const vs = guildId ? s.voiceStates[guildId]?.[userId] : undefined
  const vch = vs?.channel_id ? s.channels[vs.channel_id] : undefined
  const self = userId === me.id
  const name = memberName(s, guildId, userId)
  const gp = permsOf(s, guildId)
  const vp = vch ? permsOf(s, guildId, vch) : 0n
  const above = !!guild && outranks(guild, me.id, mine, userId, target)
  const roles = guild && target && has(gp, P.MANAGE_ROLES) ? sortedRoles(guild).filter((r) => r.id !== guild.id && !r.managed && canManageRole(guild, me.id, mine, r)) : []
  const inMyRoom = !self && !!vs && vs.channel_id === s.voice.channelId && s.voice.status === 'connected'
  const [volume, setVolume] = useState(Math.round((voiceSettings().volumes[userId] ?? 1) * 100))
  const otherVoice = guild ? Object.values(s.channels).filter((c) => c.guild_id === guild.id && c.type === 2 && c.id !== vs?.channel_id && has(permsOf(s, guild.id, c), P.VIEW_CHANNEL | P.CONNECT)) : []

  const toggleRole = (id: string) => {
    if (!guild || !target) return
    const next = target.roles.includes(id) ? target.roles.filter((r) => r !== id) : [...target.roles, id]
    patchMember(guild.id, userId, { roles: next }).catch(fail)
  }
  const nick = () =>
    void askText({ title: t('Change Nickname'), label: t('Nickname'), initial: target?.nick ?? '', placeholder: name, maxLength: 32, allowEmpty: true, body: <p className="hint">{t("Leave it empty to reset {name}'s nickname.", { name })}</p> })
      .then((v) => void (v !== null && guild && patchMember(guild.id, userId, { nick: v.trim() || null }).catch(fail)))
  const timeoutable = !!guild && canTimeout(guild, me.id, mine, userId, target)
  const blocked = s.relationships[userId]?.type === 2
  const appsChannel = channelId

  return (
    <Popover at={at} onClose={onClose} role="menu" label={t('Actions for {name}', { name })}>
      <MenuLabel>{name}</MenuLabel>
      <MenuItem onSelect={() => openFullProfile(userId, guildId)}>{t('Profile')}</MenuItem>
      {!self && !blocked && <MenuItem onSelect={() => openDm(userId).catch(fail)}>{t('Message')}</MenuItem>}
      {!self && !blocked && !s.users[userId]?.bot && <MenuItem onSelect={() => callUser(userId).catch(fail)}>{t('Call')}</MenuItem>}
      {!self && !blocked && !s.users[userId]?.bot && (
        <MenuItem onSelect={() => setState({ modal: { kind: 'invite-user', userId } })}>{t('Invite to Server')}</MenuItem>
      )}
      {inMyRoom && (
        <>
          <label className="menu-range">
            <span>{t('User Volume')} <span className="hint">{volume}%</span></span>
            <input type="range" min={0} max={300} step={5} value={volume} onChange={(e) => (setVolume(+e.target.value), setUserVolume(userId, +e.target.value / 100))} />
          </label>
          <MenuItem checked={isSoundboardMuted(userId)} onSelect={() => toggleMuteSoundboard(userId)}>
            {t('Mute Soundboard')}
          </MenuItem>
        </>
      )}
      {guild && !self && above && has(gp, P.MANAGE_NICKNAMES) && <MenuItem onSelect={nick}>{t('Change Nickname')}</MenuItem>}
      {roles.length > 0 && (
        <>
          <MenuSep />
          <MenuLabel>{t('Roles')}</MenuLabel>
          {roles.map((r) => (
            <MenuItem key={r.id} checked={!!target?.roles.includes(r.id)} onSelect={() => toggleRole(r.id)}>{r.name}</MenuItem>
          ))}
        </>
      )}
      {guild && vs && above && (has(vp, P.MUTE_MEMBERS) || has(vp, P.DEAFEN_MEMBERS) || has(vp, P.MOVE_MEMBERS)) && (
        <>
          <MenuSep />
          {has(vp, P.MUTE_MEMBERS) && <MenuItem checked={vs.mute} onSelect={() => patchMember(guild.id, userId, { mute: !vs.mute }).catch(fail)}>{t('Server Mute')}</MenuItem>}
          {has(vp, P.DEAFEN_MEMBERS) && <MenuItem checked={vs.deaf} onSelect={() => patchMember(guild.id, userId, { deaf: !vs.deaf }).catch(fail)}>{t('Server Deafen')}</MenuItem>}
          {has(vp, P.MOVE_MEMBERS) && (
            <>
              <MenuItem danger onSelect={() => patchMember(guild.id, userId, { channel_id: null }).catch(fail)}>{t('Disconnect')}</MenuItem>
              {otherVoice.map((c) => (
                <MenuItem key={c.id} onSelect={() => patchMember(guild.id, userId, { channel_id: c.id }).catch(fail)}>{t('Move to {name}', { name: c.name ?? '' })}</MenuItem>
              ))}
            </>
          )}
        </>
      )}
      {guild && above && (has(gp, P.KICK_MEMBERS) || has(gp, P.BAN_MEMBERS) || timeoutable) && (
        <>
          <MenuSep />
          {timeoutable && (timedOutUntil(target)
            ? <MenuItem onSelect={() => patchMember(guild.id, userId, { communication_disabled_until: null }).catch(fail)}>{t('Remove Timeout')}</MenuItem>
            : <MenuItem danger onSelect={() => setState({ modal: { kind: 'timeout', guildId: guild.id, userId } })}>{t('Timeout {name}', { name })}</MenuItem>)}
          {has(gp, P.KICK_MEMBERS) && (
            <MenuItem danger onSelect={() => confirmKick(guild.id, guild.name, userId, name)}>{t('Kick {name}', { name })}</MenuItem>
          )}
          {has(gp, P.BAN_MEMBERS) && <MenuItem danger onSelect={() => setState({ modal: { kind: 'ban', guildId: guild.id, userId } })}>{t('Ban {name}', { name })}</MenuItem>}
        </>
      )}
      {guild && guild.owner_id === me.id && !self && target && !s.users[userId]?.bot && (
        <MenuItem danger onSelect={() => void (me.mfa_enabled
          ? askText({ title: t('Transfer Ownership'), label: t('Authentication or backup code'), body: <p>{t('{name} becomes the owner of {server}. You cannot undo this.', { name, server: guild.name })}</p>, confirm: t('Transfer Ownership'), danger: true }).then((code) => void (code && transferGuild(guild.id, userId, code.trim()).catch(fail)))
          : ask({ title: t('Transfer Ownership'), body: <p>{t('{name} becomes the owner of {server}. You cannot undo this.', { name, server: guild.name })}</p>, confirm: t('Transfer Ownership'), danger: true }).then((ok) => void (ok && transferGuild(guild.id, userId).catch(fail)))
        ).catch(fail)}>{t('Transfer Ownership')}</MenuItem>
      )}
      {appsChannel && !self && <AppsSection channelId={appsChannel} type={2} targetId={userId} />}
      {!self && (
        <>
          <MenuSep />
          {blocked ? <MenuItem onSelect={() => void unblockUser(userId).catch(fail)}>{t('Unblock')}</MenuItem>
            : s.users[userId] && <MenuItem danger onSelect={() => confirmBlock(s.users[userId])}>{t('Block')}</MenuItem>}
        </>
      )}
      {s.settings.developer_mode && <><MenuSep /><MenuItem onSelect={() => void navigator.clipboard.writeText(userId)}>{t('Copy User ID')}</MenuItem></>}
    </Popover>
  )
}
