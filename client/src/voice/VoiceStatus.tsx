// Voice channel status (CONTRACT-v5 section 6): a short line under the channel name, set from the channel menu or the voice view header.
import { setVoiceStatus } from '../actions'
import { askText, toastError } from '../components/dialogs'
import { Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { canSetVoiceStatus } from '../permissions'
import { usePerms } from '../selectors'
import { useStore } from '../store'
import type { Channel } from '../types'

/** MANAGE_CHANNELS, or connected with SEND_MESSAGES. */
export function useCanSetVoiceStatus(c: Channel) {
  const perms = usePerms(c.guild_id, c.id)
  const connected = useStore((s) => s.voice.channelId === c.id)
  return canSetVoiceStatus(perms, connected)
}

export const editVoiceStatus = (c: Channel) =>
  void askText({ title: t('Set Channel Status'), label: t('Status'), initial: c.status ?? '', maxLength: 500, allowEmpty: true, placeholder: t('What’s happening here? e.g. Scrim vs Team X'), confirm: t('Save') })
    .then((v) => void (v !== null && setVoiceStatus(c.id, v.trim() || null).catch(toastError)))

export const clearVoiceStatus = (c: Channel) => void setVoiceStatus(c.id, null).catch(toastError)

/** In the voice view header: the status, with an edit button when allowed. */
export function VoiceStatusHeader({ channel }: { channel: Channel }) {
  const allowed = useCanSetVoiceStatus(channel)
  if (!channel.status && !allowed) return null
  return (
    <div className="voice-status-head">
      {channel.status && <span className="ellipsis" title={channel.status}>{channel.status}</span>}
      {allowed && (
        <button className="link small" onClick={() => editVoiceStatus(channel)} aria-label={channel.status ? t('Edit channel status') : t('Set a channel status')}>
          {channel.status ? <Icon d={ICONS.pencil} size={14} /> : t('Set a channel status')}
        </button>
      )}
    </div>
  )
}
