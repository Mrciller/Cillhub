// Banner under the update notice for logged-in users: the latest system announcement, otherwise the message of the day.
// Dismissing hides that exact text (remembered per browser); a new announcement or a changed message shows again.
import { useState } from 'react'
import { Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { useStore } from '../store'
import { useInstance } from './instance'
import './admin.css'

const KEY = 'instance-banner-dismissed'

export function InstanceBanner() {
  const token = useStore((s) => s.token)
  return token ? <Banner /> : null
}

function Banner() {
  const info = useInstance()
  const [dismissed, setDismissed] = useState(() => localStorage.getItem(KEY) ?? '')
  const ann = info?.announcement
  const [key, label, text] = ann ? [`a:${ann.id}`, t('Announcement'), ann.content] : info?.motd ? [`m:${info.motd}`, t('Message of the day'), info.motd] : ['', '', '']
  const show = !!text && key !== dismissed
  const dismiss = () => (localStorage.setItem(KEY, key), setDismissed(key))
  return (
    <div className="instance-banner" role="status" aria-live="polite" hidden={!show}>
      {show && (
        <>
          <span><strong>{label}:</strong> {text}</span>
          <button className="icon-btn" aria-label={t('Dismiss')} title={t('Dismiss')} onClick={dismiss}><Icon d={ICONS.close} size={16} /></button>
        </>
      )}
    </div>
  )
}
