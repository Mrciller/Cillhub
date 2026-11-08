// Server notification settings (user docs: user_guild_settings) and the mute / notification menu items for channels and servers.
import { patchGuildSettings, muteConfig } from '../actions'
import { toastError } from '../components/dialogs'
import { MenuItem, MenuLabel, MenuSep } from '../components/menu'
import { FormError, Modal } from '../components/ui'
import { t } from '../i18n'
import { Switch } from '../settings/Layout'
import { channelOverride, isChannelMuted, isGuildMuted } from '../selectors'
import { getState, useStore } from '../store'
import type { Channel } from '../types'
import { useState } from 'react'
import { desktopEnabled } from './notify'

/** Durations offered for muting (null = until I turn it back on). */
export const MUTE_FOR: [string, number | null][] = [
  ['For 15 Minutes', 15], ['For 1 Hour', 60], ['For 3 Hours', 180], ['For 8 Hours', 480], ['For 24 Hours', 1440], ['Until I turn it back on', null],
]
export const LEVELS: [number, string][] = [[0, 'All Messages'], [1, 'Only @mentions'], [2, 'Nothing']]
const fail = (e: Error) => toastError(e)

export function NotificationSettingsModal({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const gs = useStore((s) => s.guildSettings[guildId])
  const guild = useStore((s) => s.guilds[guildId])
  const muted = useStore((s) => isGuildMuted(s, guildId))
  const level = gs?.message_notifications ?? (guild as { default_message_notifications?: number } | undefined)?.default_message_notifications ?? 0
  const [error, setError] = useState('')
  const set = (patch: Parameters<typeof patchGuildSettings>[1]) => void patchGuildSettings(guildId, patch).catch((e: Error) => setError(e.message))
  return (
    <Modal title={t('Notification Settings')} onClose={onClose} className="notif-modal">
      <p className="hint">{guild?.name}</p>
      <div className="field">
        <label htmlFor="mute-guild">{muted ? t('Server muted') : t('Mute {name}', { name: guild?.name ?? '' })}</label>
        <select id="mute-guild" className="input" value={muted ? 'on' : ''} onChange={(e) => {
          const v = e.target.value
          set(v === '' ? { muted: false, mute_config: null } : v === 'on' ? {} : { muted: true, mute_config: muteConfig(v === 'forever' ? null : +v) })
        }}>
          <option value="">{t('Not muted')}</option>
          {muted && <option value="on">{gs?.mute_config?.end_time ? t('Muted until {time}', { time: new Date(gs.mute_config.end_time).toLocaleString() }) : t('Muted')}</option>}
          {MUTE_FOR.map(([label, min]) => <option key={label} value={min ?? 'forever'}>{t(label)}</option>)}
        </select>
        <p className="hint small">{t('Muting a server prevents unread indicators and notifications from appearing unless you are mentioned.')}</p>
      </div>
      <fieldset className="choice block">
        <legend>{t('Server Notification Settings')}</legend>
        {LEVELS.map(([v, label]) => (
          <label key={v} className="radio-card">
            <input type="radio" name="notif-level" checked={level === v} onChange={() => set({ message_notifications: v })} /> {t(label)}
          </label>
        ))}
      </fieldset>
      <Switch label={t('Suppress @everyone and @here')} checked={!!gs?.suppress_everyone} onChange={(v) => set({ suppress_everyone: v })} />
      <Switch label={t('Suppress All Role @mentions')} checked={!!gs?.suppress_roles} onChange={(v) => set({ suppress_roles: v })} />
      <Switch label={t('Mobile Push Notifications')} checked={gs?.mobile_push ?? true} onChange={(v) => set({ mobile_push: v })} />
      <Switch label={t('Hide Muted Channels')} checked={!!gs?.hide_muted_channels} onChange={(v) => set({ hide_muted_channels: v })} />
      {!desktopEnabled() && <p className="hint small">{t('Desktop notifications are off for this browser. Turn them on in User Settings → Notifications.')}</p>}
      <FormError error={error} />
      <div className="modal-actions"><button className="primary" onClick={onClose}>{t('Done')}</button></div>
    </Modal>
  )
}

/** Mute / Unmute and per-channel notification level, for a channel's (or category's or DM's) context menu. */
export function ChannelNotifyItems({ c }: { c: Channel }) {
  const s = useStore((x) => x)
  const g = c.guild_id ?? '@me'
  const o = channelOverride(s, g, c.id)
  const muted = isChannelMuted(s, c) && !!o?.muted
  const what = c.type === 4 ? t('Category') : c.type === 1 || c.type === 3 ? t('Conversation') : t('Channel')
  const set = (patch: Record<string, unknown>) => void patchGuildSettings(g, { channel_overrides: { [c.id]: patch } }).catch(fail)
  return (
    <>
      <MenuSep />
      {muted ? <MenuItem onSelect={() => set({ muted: false, mute_config: null })}>{t('Unmute {what}', { what })}</MenuItem> : (
        <>
          <MenuLabel>{t('Mute {what}', { what })}</MenuLabel>
          {MUTE_FOR.map(([label, min]) => <MenuItem key={label} onSelect={() => set({ muted: true, mute_config: muteConfig(min) })}>{t(label)}</MenuItem>)}
        </>
      )}
      {c.guild_id && (
        <>
          <MenuLabel>{t('Notification Settings')}</MenuLabel>
          <MenuItem checked={(o?.message_notifications ?? 3) === 3} onSelect={() => set({ message_notifications: 3 })}>{c.parent_id ? t('Use Category Default') : t('Use Server Default')}</MenuItem>
          {LEVELS.map(([v, label]) => <MenuItem key={v} checked={o?.message_notifications === v} onSelect={() => set({ message_notifications: v })}>{t(label)}</MenuItem>)}
        </>
      )}
    </>
  )
}

/** Mute Server items for the server's context menu. */
export function GuildNotifyItems({ guildId }: { guildId: string }) {
  const muted = useStore((s) => isGuildMuted(s, guildId))
  const set = (patch: Record<string, unknown>) => void patchGuildSettings(guildId, patch).catch(fail)
  return muted ? <MenuItem onSelect={() => set({ muted: false, mute_config: null })}>{t('Unmute Server')}</MenuItem> : (
    <>
      <MenuLabel>{t('Mute Server')}</MenuLabel>
      {MUTE_FOR.map(([label, min]) => <MenuItem key={label} onSelect={() => set({ muted: true, mute_config: muteConfig(min) })}>{t(label)}</MenuItem>)}
    </>
  )
}
export const hideMuted = (guildId: string) => !!getState().guildSettings[guildId]?.hide_muted_channels
