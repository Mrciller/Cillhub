import { useEffect, useRef, useState } from 'react'
import { ModuleSidebarEntries } from '../modules/ModulePanel'
import { WEB_ORIGIN } from '../api'
import { createChannel, createInvite, leaveGuild, patchGuildSettings } from '../actions'
import { t } from '../i18n'
import { EventsEntry } from '../events/Events'
import { ServerGuideSidebarEntry } from '../guilds/ServerGuide'
import { canSimulateRoles, isSimulatingRoles, startRoleSimulation, stopRoleSimulation } from '../guilds/RoleSimulator'
import { has, P } from '../permissions'
import { firstText, usePerms } from '../selectors'
import { getState, setState, useStore } from '../store'
import type { Guild } from '../types'
import { ChannelList } from './ChannelList'
import { ask, toastError } from './dialogs'
import { Field, FormError, Icon, ICONS, Modal } from './ui'
import { accentVars } from '../custom/ServerCustomize'

/** Server Settings is offered to anyone who can use one of its pages. */
export const SETTINGS_PERMS = P.MANAGE_GUILD | P.MANAGE_ROLES | P.KICK_MEMBERS | P.BAN_MEMBERS | P.VIEW_AUDIT_LOG | P.MANAGE_WEBHOOKS | P.MANAGE_GUILD_EXPRESSIONS | P.CREATE_GUILD_EXPRESSIONS | P.MODERATE_MEMBERS

export function GuildSidebar({ guild, channelId }: { guild: Guild; channelId?: string }) {
  const me = useStore((s) => s.me)
  const perms = usePerms(guild.id)
  const [inviting, setInviting] = useState(false)
  const menu = useRef<HTMLDivElement>(null)
  const owner = guild.owner_id === me?.id
  const canSim = useStore((s) => canSimulateRoles(s, guild.id))
  const isSim = useStore((s) => isSimulatingRoles(s, guild.id))
  const hideMuted = useStore((s) => !!s.guildSettings[guild.id]?.hide_muted_channels)
  const pick = (fn: () => void) => () => (menu.current?.hidePopover(), fn())
  const leave = () =>
    void ask(owner
      ? { title: t("Delete '{name}'", { name: guild.name }), body: <p>{t('Are you sure you want to delete {name}? This action cannot be undone.', { name: guild.name })}</p>, confirm: t('Delete Server'), danger: true }
      : { title: t("Leave '{name}'", { name: guild.name }), body: <p>{t("Are you sure you want to leave {name}? You won't be able to rejoin this server unless you are re-invited.", { name: guild.name })}</p>, confirm: t('Leave Server'), danger: true },
    ).then((ok) => void (ok && leaveGuild(guild.id, owner).catch(toastError)))
  const create = (type: 0 | 4) => setState({ modal: { kind: 'create-channel', guildId: guild.id, parentId: null, type } })
  const current = channelId ? getState().channels[channelId] : undefined
  const inviteChannel = current && !current.thread_metadata && current.type !== 4 ? channelId : firstText(getState(), guild.id)?.id

  return (
    <>
      <button className={accentVars(guild.brand_color_primary) ? 'sidebar-header accented' : 'sidebar-header'} style={accentVars(guild.brand_color_primary)} popoverTarget="guild-menu">
        <span className="ellipsis">{guild.name}</span>
        <Icon d={ICONS.chevron} />
      </button>
      <div id="guild-menu" popover="auto" ref={menu} className="menu">
        {has(perms, P.CREATE_INSTANT_INVITE) && <button className="accent" onClick={pick(() => setInviting(true))}>{t('Invite People')}</button>}
        {(perms & SETTINGS_PERMS) !== 0n && <button onClick={pick(() => setState({ modal: { kind: 'server', guildId: guild.id } }))}>{t('Server Settings')}</button>}
        {canSim && (
          isSim ? (
            <button className="accent" onClick={pick(() => stopRoleSimulation(guild.id))}>{t('Stop Viewing Server as Role')}</button>
          ) : (
            <button onClick={pick(() => startRoleSimulation(guild.id))}>{t('View Server as Role')}</button>
          )
        )}
        {has(perms, P.MANAGE_CHANNELS) && <button onClick={pick(() => create(0))}>{t('Create Channel')}</button>}
        {has(perms, P.MANAGE_CHANNELS) && <button onClick={pick(() => create(4))}>{t('Create Category')}</button>}
        {(has(perms, P.CREATE_EVENTS) || has(perms, P.MANAGE_EVENTS)) && <button onClick={pick(() => setState({ modal: { kind: 'events', guildId: guild.id, create: true } }))}>{t('Create Event')}</button>}
        <hr className="menu-sep" />
        <button onClick={pick(() => setState({ modal: { kind: 'notifications', guildId: guild.id } }))}>{t('Notification Settings')}</button>
        <button role="menuitemcheckbox" aria-checked={hideMuted} onClick={pick(() => void patchGuildSettings(guild.id, { hide_muted_channels: !hideMuted }).catch(toastError))}>{t('Hide Muted Channels')}{hideMuted ? ' ✓' : ''}</button>
        <hr className="menu-sep" />
        <button className="danger" onClick={pick(leave)}>{owner ? t('Delete Server') : t('Leave Server')}</button>
      </div>
      <ServerGuideSidebarEntry guild={guild} />
      <EventsEntry guild={guild} />
      <ModuleSidebarEntries guildId={guild.id} />
      <ChannelList guild={guild} channelId={channelId} />
      {inviting && inviteChannel && <InviteModal channelId={inviteChannel} onClose={() => setInviting(false)} />}
    </>
  )
}

function InviteModal({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const [link, setLink] = useState('')
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    createInvite(channelId).then((i) => setLink(`${WEB_ORIGIN}/invite/${i.code}`), (e: Error) => setError(e.message))
  }, [channelId])
  return (
    <Modal title={t('Invite friends')} onClose={onClose}>
      <Field label={t('Send this invite link to a friend')} readOnly value={link || t('Creating invite…')} onFocus={(e) => e.currentTarget.select()} />
      <p className="hint">{t('Your invite link expires in 24 hours.')}</p>
      <FormError error={error} />
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>{t('Done')}</button>
        <button className="primary" disabled={!link} onClick={() => navigator.clipboard.writeText(link).then(() => setCopied(true))}>
          {copied ? t('Copied') : t('Copy')}
        </button>
      </div>
    </Modal>
  )
}

type NewType = 0 | 2 | 4 | 5 | 13 | 15 | 16
const TYPES: [NewType, string, string | null, string][] = [
  [0, 'Text', null, 'Send messages, images, GIFs, emoji, opinions, and puns'],
  [16, 'Media', ICONS.grid, 'Share art, photos, screenshots, and clips in a visual gallery'],
  [2, 'Voice', ICONS.speaker, 'Hang out together with voice, video, and screen share'],
  [15, 'Forum', ICONS.forum, 'Create a space for organized discussions'],
  [5, 'Announcement', ICONS.announcement, 'Important updates for people in and out of the server'],
  [13, 'Stage', ICONS.stage, 'Host events with a moderated audience'],
]

export function CreateChannelModal({ guildId, parentId, type: initial, onClose }: { guildId: string; parentId: string | null; type: NewType; onClose: () => void }) {
  const [error, setError] = useState('')
  const [type, setType] = useState(initial)
  const category = type === 4
  return (
    <Modal title={category ? t('Create Category') : t('Create channel')} onClose={onClose}>
      <form onSubmit={(e) => {
        e.preventDefault()
        const name = String(new FormData(e.currentTarget).get('name')).trim()
        if (name) createChannel(guildId, name, type, parentId).then(onClose, (err: Error) => setError(err.message))
      }}>
        {!category && (
          <fieldset className="choice block">
            <legend>{t('Channel Type')}</legend>
            {TYPES.map(([ty, label, icon, note]) => (
              <label key={ty} className="type-choice">
                <input type="radio" name="type" checked={type === ty} onChange={() => setType(ty)} />
                {icon ? <Icon d={icon} size={18} /> : <span className="hash" aria-hidden="true">#</span>}
                <span><span className="type-name">{t(label)}</span><span className="hint small type-note">{t(note)}</span></span>
              </label>
            ))}
          </fieldset>
        )}
        <Field label={category ? t('Category name') : t('Channel name')} name="name" required maxLength={100} placeholder={category ? t('New Category') : type === 2 || type === 13 ? t('General') : t('new-channel')} />
        <FormError error={error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className="primary">{category ? t('Create Category') : t('Create Channel')}</button>
        </div>
      </form>
    </Modal>
  )
}
