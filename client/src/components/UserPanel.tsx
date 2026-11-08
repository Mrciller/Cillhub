import { useState } from 'react'
import { setCustomStatus, setStatus } from '../actions'
import { t } from '../i18n'
import { StatusLine } from '../profiles/Activity'
import { navigate } from '../router'
import { userActivities } from '../selectors'
import { setState, displayName, useStore } from '../store'
import type { Status } from '../types'
import { setSelfDeaf, setSelfMute } from '../voice/engine'
import { VoicePanel } from '../voice/VoicePanel'
import { toastError } from './dialogs'
import { MenuItem, MenuSep, Popover, type Anchor } from './menu'
import { Avatar, cls, Icon, ICONS, STATUS_LABEL } from './ui'

const CHOICES: [Status, string][] = [
  ['online', ''],
  ['idle', ''],
  ['dnd', 'You will not receive desktop notifications'],
  ['invisible', 'You will not appear online, but will have full access'],
]
const NONE: never[] = []
export const statusLabel = (st: Status) => t(STATUS_LABEL[st])

export function UserPanel() {
  const me = useStore((s) => s.me)
  const ready = useStore((s) => s.status === 'ready')
  const presence = useStore((s) => (s.me && s.presences[s.me.id]) || 'online')
  const mute = useStore((s) => s.voice.selfMute)
  const deaf = useStore((s) => s.voice.selfDeaf)
  const custom = useStore((s) => (s.me ? userActivities(s, s.me.id) : NONE)).some((a) => a.type === 4)
  const [picker, setPicker] = useState<Anchor | null>(null)
  return (
    <>
      <VoicePanel />
      <section className="user-panel" aria-label={t('Your account')}>
        <button
          className="who-btn"
          aria-label={t('Set status, currently {status}', { status: statusLabel(presence) })}
          aria-haspopup="menu"
          onClick={(e) => setPicker({ rect: e.currentTarget.getBoundingClientRect(), side: 'above' })}
        >
          <Avatar user={me} size={32} status={ready ? presence : 'offline'} />
          <span className="who">
            <span className="name ellipsis">{me ? displayName(me) : '…'}</span>
            <span className="hint ellipsis">{!ready ? t('Connecting…') : custom && me ? <StatusLine userId={me.id} /> : presence === 'online' ? me?.username : statusLabel(presence)}</span>
          </span>
        </button>
        <button className={cls('icon-btn', mute && 'off')} aria-label={t('Mute')} aria-pressed={mute} title={mute ? t('Unmute') : t('Mute')} onClick={() => setSelfMute(!mute)}>
          <Icon d={mute ? ICONS.micOff : ICONS.mic} />
        </button>
        <button className={cls('icon-btn', deaf && 'off')} aria-label={t('Deafen')} aria-pressed={deaf} title={deaf ? t('Undeafen') : t('Deafen')} onClick={() => setSelfDeaf(!deaf)}>
          <Icon d={deaf ? ICONS.headsetOff : ICONS.headset} />
        </button>
        <button className="icon-btn" aria-label={t('User Settings')} title={t('User Settings')} onClick={() => setState({ modal: { kind: 'user' } })}>
          <Icon d={ICONS.gear} />
        </button>
        {picker && (
          <Popover at={picker} onClose={() => setPicker(null)} role="menu" label={t('Set status')} className="status-menu">
            {CHOICES.map(([st, hint]) => (
              <MenuItem key={st} onSelect={() => setStatus(st)} hint={hint ? t(hint) : undefined}>
                <span className="status-choice">
                  <span className={`dot inline ${st === 'invisible' ? 'offline' : st}`} aria-hidden="true" />
                  {statusLabel(st)}
                  {presence === st && <span className="sr-only"> {t('(current)')}</span>}
                </span>
              </MenuItem>
            ))}
            <MenuSep />
            <MenuItem onSelect={() => setState({ modal: { kind: 'custom-status' } })}>{custom ? t('Edit Custom Status') : t('Set Custom Status')}</MenuItem>
            {custom && <MenuItem onSelect={() => void setCustomStatus(null).catch(toastError)}>{t('Clear Custom Status')}</MenuItem>}
            <MenuSep />
            <MenuItem onSelect={() => setState({ modal: { kind: 'whats-new' } })}>{t("What's New")}</MenuItem>
            {me?.instance_admin && <MenuItem onSelect={() => navigate('/admin')}>{t('Admin Dashboard')}</MenuItem>}
          </Popover>
        )}
      </section>
    </>
  )
}
