// Notice at the top of the app when a newer client is deployed (update.ts). In the desktop app the button installs the
// app update (download if needed, then restart) instead of reloading the page.
import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { appUpdates, type AppUpdateStatus } from '../update'
import { Icon, ICONS } from './ui'

const KEY = 'update-dismissed-until'
const HOUR = 3600_000

export function UpdateBanner() {
  const ready = useStore((s) => s.updateReady)
  const inVoice = useStore((s) => !!s.voice.channelId)
  const [until, setUntil] = useState(() => Number(localStorage.getItem(KEY) ?? 0))
  const [app, setApp] = useState<AppUpdateStatus | null>(null)
  useEffect(() => appUpdates?.onUpdateStatus(setApp), [])
  const show = ready && until <= Date.now()
  const dismiss = () => {
    const next = Date.now() + HOUR
    localStorage.setItem(KEY, String(next))
    setUntil(next)
  }
  return (
    <div className="update-banner" role="status" aria-live="polite" hidden={!show}>
      {show && (
        <>
          <span>
            {t('A new version of Cillhub is available.')}
            {inVoice && ' ' + (appUpdates ? t('Restarting will disconnect you from voice.') : t('Reloading will disconnect you from voice.'))}
            {app?.state === 'none' && ' ' + t('The app update is not published yet. Try again later.')}
            {app?.state === 'error' && ' ' + t('The update could not be downloaded. Try again later.')}
          </span>
          {appUpdates ? (
            <button className="update-reload" disabled={app?.state === 'downloading' || app?.state === 'checking'} onClick={() => void appUpdates?.installUpdate()}>
              {app?.state === 'ready' ? t('Restart to Update') : app?.state === 'downloading' ? t('Downloading… {n}%', { n: app.percent ?? 0 }) : t('Update')}
            </button>
          ) : (
            <button className="update-reload" onClick={() => location.reload()}>{t('Reload')}</button>
          )}
          <button className="icon-btn update-dismiss" aria-label={t('Dismiss for an hour')} title={t('Dismiss')} onClick={dismiss}>
            <Icon d={ICONS.close} size={16} />
          </button>
        </>
      )}
    </div>
  )
}
