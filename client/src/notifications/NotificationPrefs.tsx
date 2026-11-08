// User Settings → Notifications: desktop notifications and sounds (this browser), Web Push (this device, via the service worker).
import { useEffect, useState } from 'react'
import { FormError } from '../components/ui'
import { t } from '../i18n'
import { Switch } from '../settings/Layout'
import { disablePush, enablePush, pushState, type PushState } from './push'
import { playMessage } from './sounds'

export function NotificationPrefs() {
  const supported = 'Notification' in window
  const [desktop, setDesktop] = useState(localStorage.getItem('notif-desktop') === '1' && supported && Notification.permission === 'granted')
  const [sounds, setSounds] = useState(localStorage.getItem('notif-sounds') !== '0')
  const [push, setPush] = useState<PushState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => void pushState().then(setPush, () => setPush('unsupported')), [])
  const toggleDesktop = async (on: boolean) => {
    setError('')
    if (on && (await Notification.requestPermission()) !== 'granted') return setError(t('Your browser blocks notifications for this site. Allow them in the site settings.'))
    localStorage.setItem('notif-desktop', on ? '1' : '0')
    setDesktop(on)
  }
  const togglePush = (on: boolean) => {
    setError('')
    setBusy(true)
    ;(on ? enablePush() : disablePush()).then(() => pushState().then(setPush), (e: Error) => setError(t(e.message))).finally(() => setBusy(false))
  }
  return (
    <>
      <h1>{t('Notifications')}</h1>
      <Switch label={t('Enable Desktop Notifications')} note={supported ? t('Show a notification for new messages while Cillhub is open but you are looking elsewhere.') : t('This browser does not support notifications.')} checked={desktop} disabled={!supported} onChange={(v) => void toggleDesktop(v)} />
      <Switch label={t('Enable Push Notifications')}
        note={push === 'unsupported' ? t('Push needs the installed app or a browser with service workers (production build).') : push === 'denied' ? t('Notifications are blocked for this site.') : t('Get DMs, mentions, friend requests and calls even when Cillhub is closed. Only sent while you are not active in another session.')}
        checked={push === 'on'} disabled={busy || push === null || push === 'unsupported' || push === 'denied'} onChange={togglePush} />
      <Switch label={t('Notification Sounds')} note={t('Play a sound for new messages and calls.')} checked={sounds} onChange={(v) => (localStorage.setItem('notif-sounds', v ? '1' : '0'), setSounds(v), v && playMessage())} />
      <p className="hint small">{t('Server and channel settings (mute, @mentions only, suppress @everyone) are in each server\'s menu → Notification Settings.')}</p>
      <FormError error={error} />
    </>
  )
}
