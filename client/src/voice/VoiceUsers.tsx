// Users connected to a voice channel, under its row in the channel sidebar.
import { t } from '../i18n'
import { useContextMenu } from '../components/menu'
import { UserMenu } from '../components/UserMenu'
import { Avatar, cls, Icon, ICONS } from '../components/ui'
import { memberName, permsOf } from '../selectors'
import { has, P } from '../permissions'
import { StyledName } from '../custom/render'
import { setState, useStore } from '../store'
import type { VoiceState } from '../types'
import { PlayingLine } from '../profiles/Activity'

export function VoiceIcons({ v }: { v: VoiceState }) {
  return (
    <span className="voice-icons">
      {v.self_stream && <span className="live">{t('LIVE')}</span>}
      {v.self_video && <Icon d={ICONS.camera} size={16} className="vi" />}
      {(v.mute || v.self_mute) && <span role="img" aria-label={v.mute ? t('Server muted') : t('Muted')} className={cls('vi', v.mute && 'server')}><Icon d={ICONS.micOff} size={16} /></span>}
      {(v.deaf || v.self_deaf) && <span role="img" aria-label={v.deaf ? t('Server deafened') : t('Deafened')} className={cls('vi', v.deaf && 'server')}><Icon d={ICONS.headsetOff} size={16} /></span>}
    </span>
  )
}

/** The voice user being dragged to another voice channel (ChannelList's voice rows accept the drop). */
export let draggedVoiceUser: { guildId: string; userId: string; from: string } | null = null

function VoiceUser({ guildId, v }: { guildId: string; v: VoiceState }) {
  const s = useStore((x) => x)
  const menu = useContextMenu()
  const name = memberName(s, guildId, v.user_id)
  const speaking = !!s.voice.speaking[v.user_id] && s.voice.channelId === v.channel_id
  const effect = s.voice.channelId === v.channel_id ? s.voice.effects[v.user_id] : undefined
  const from = v.channel_id ? s.channels[v.channel_id] : undefined
  // Move Members may drag people to another voice channel; the user menu's "Move to" does the same by keyboard
  const movable = !!from && has(permsOf(s, guildId, from), P.MOVE_MEMBERS)
  const drag = movable
    ? {
        draggable: true,
        onDragStart: (e: React.DragEvent) => {
          e.stopPropagation()
          draggedVoiceUser = { guildId, userId: v.user_id, from: v.channel_id! }
          e.dataTransfer.setData('application/x-cillhub-voice-user', v.user_id)
          e.dataTransfer.effectAllowed = 'move'
        },
        onDragEnd: () => void (draggedVoiceUser = null),
      }
    : {}
  return (
    <li {...menu.props} {...drag} className={cls(movable && 'movable')}>
      <button
        className="row voice-user"
        onClick={(e) => setState({ popout: { userId: v.user_id, guildId, at: { rect: e.currentTarget.getBoundingClientRect(), side: 'right' } } })}
      >
        <Avatar user={s.users[v.user_id] ?? v.member?.user} size={24} speaking={speaking} />
        <span className="voice-user-text">
          <span className="ellipsis"><StyledName user={s.users[v.user_id] ?? v.member?.user} member={s.members[guildId]?.[v.user_id]} guild={s.guilds[guildId]} name={name} tag={false} /></span>
          <PlayingLine userId={v.user_id} />
        </span>
        {speaking && <span className="sr-only">{t('speaking')}</span>}
        {effect && <span className="voice-effect" role="img" aria-label={t('played a sound {emoji}', { emoji: effect })}>{effect}</span>}
        <VoiceIcons v={v} />
      </button>
      {menu.at && <UserMenu userId={v.user_id} guildId={guildId} at={menu.at} onClose={menu.close} />}
    </li>
  )
}

export function VoiceUsers({ guildId, states }: { guildId: string; states: VoiceState[] }) {
  const s = useStore((x) => x)
  if (!states.length) return null
  const sorted = [...states].sort((a, b) => memberName(s, guildId, a.user_id).localeCompare(memberName(s, guildId, b.user_id)))
  return (
    <ul className="voice-users" aria-label={t('Connected users')}>
      {sorted.map((v) => <VoiceUser key={v.user_id} guildId={guildId} v={v} />)}
    </ul>
  )
}
