// Notice for the old Android app (1.x, the previous package): its updater cannot install the new app, so the hosted web
// client asks those users to install the new one. The Android shell's WebView user agent ends with "CillhubAndroid/<version>".
// Dismissing hides it until the app starts again.
import { useState } from 'react'
import { Icon, ICONS } from '../components/ui'
import { t } from '../i18n'

const KEY = 'android-moved-dismissed'
const OLD_APP = /\bCillhubAndroid\/1\./.test(navigator.userAgent)

export function AndroidMovedBanner() {
  const [hidden, setHidden] = useState(() => sessionStorage.getItem(KEY) === '1')
  if (!OLD_APP || hidden) return null
  return (
    <div className="update-banner" role="status">
      <span>{t('Cillhub moved to a new app. Install it, log in, then uninstall this old app.')}</span>
      {/* same origin: the old app hands an APK link to the system download manager, which opens the installer */}
      <a className="update-reload" href="/download/android/Cillhub.apk">{t('Download the new app')}</a>
      <button className="icon-btn update-dismiss" aria-label={t('Dismiss until the app restarts')} title={t('Dismiss')} onClick={() => (sessionStorage.setItem(KEY, '1'), setHidden(true))}>
        <Icon d={ICONS.close} size={16} />
      </button>
    </div>
  )
}
