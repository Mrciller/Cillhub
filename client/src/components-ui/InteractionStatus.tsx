// Local lines for commands this client ran: "Sending command…" until the app answers, or "The application did not respond".
import { dismissInteraction } from '../actions'
import { Avatar, Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { displayName, useStore, type PendingInteraction } from '../store'

const NONE: PendingInteraction[] = []
let lastAll: unknown
let lastList = NONE
export function InteractionStatus({ channelId }: { channelId: string }) {
  const list = useStore((s) => {
    if (s.interactions === lastAll) return lastList
    lastAll = s.interactions
    lastList = Object.values(s.interactions).filter((i) => i.kind !== 'component')
    return lastList
  }).filter((i) => i.channelId === channelId)
  const me = useStore((s) => s.me)
  if (!list.length) return null
  return (
    <ul className="interaction-status" aria-live="polite">
      {list.map((i) => (
        <li key={i.nonce} className="msg head pending-command">
          <span className="avatar-btn"><Avatar user={me} /></span>
          <h3 className="msg-meta"><span className="author">{me ? displayName(me) : ''}</span></h3>
          <div className="content">
            <span className="hint">{i.name ? (i.kind === 'modal' ? i.name : `/${i.name}`) : ''}</span>{' '}
            {i.state === 'failed' ? (
              <span className="interaction-failed"><Icon d={ICONS.warning} size={14} /> {t('The application did not respond')} <button className="link" onClick={() => dismissInteraction(i.nonce)}>{t('Dismiss message')}</button></span>
            ) : <span className="thinking">{t('Sending command…')}<span className="dots" aria-hidden="true"><i /><i /><i /></span></span>}
          </div>
        </li>
      ))}
    </ul>
  )
}
