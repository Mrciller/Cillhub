import { useEffect, useState } from 'react'
import { Link } from '../router'
import { useStore } from '../store'
import { t } from '../i18n'
import { Icon, ICONS } from '../components/ui'
import './download.css'
import { LegalLinks } from '../legal/LegalPages'

export function DownloadPage() {
  const token = useStore((s) => s.token)
  const android = /android/i.test(navigator.userAgent)
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    document.title = `${t('Download Apps')} · Cillhub`
    const promptHandler = (e: Event) => {
      e.preventDefault()
      setDeferredPrompt(e)
    }
    const installedHandler = () => {
      setInstalled(true)
      setDeferredPrompt(null)
    }
    window.addEventListener('beforeinstallprompt', promptHandler)
    window.addEventListener('appinstalled', installedHandler)
    return () => {
      window.removeEventListener('beforeinstallprompt', promptHandler)
      window.removeEventListener('appinstalled', installedHandler)
    }
  }, [])

  const origin = typeof window !== 'undefined' && window.location.origin ? window.location.origin : 'https://cillhub.cillerian.org'
  // signed desktop and Android builds live on the hub only; self-hosted instances link there
  const appsUrl = 'https://cillhub.cillerian.org/download/'
  // the test instance's host shows a Beta tag; everywhere else this page shows no channel tag
  const beta = typeof window !== 'undefined' && /(^|\.)betacord\./.test(window.location.hostname)

  const handleInstallPwa = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt()
      const { outcome } = await deferredPrompt.userChoice
      if (outcome === 'accepted') setInstalled(true)
      setDeferredPrompt(null)
    } else {
      alert(t('To install Cillhub, click the Install icon in your browser address bar or menu (Install / Add to Home Screen).'))
    }
  }

  return (
    <div className="download-page">
      <header className="download-nav">
        <div className="download-brand">
          <svg width="32" height="32" viewBox="0 0 512 512" aria-hidden="true">
            <path fill="#0b0c0f" d="M31 0H440L512 72V481A31 31 0 0 1 481 512H31A31 31 0 0 1 0 481V31A31 31 0 0 1 31 0Z" />
            <path fill="#ff6a1f" d="M192 96L384 96L384 192L248 192L224 216L224 296L248 320L384 320L384 416L192 416L128 352L128 160Z" />
          </svg>
          <strong>Cillhub {beta && <span className="download-beta">Beta</span>}</strong>
        </div>
        <div className="download-nav-actions">
          {token ? (
            <Link to="/channels/@me" className="dl-btn secondary" style={{ minWidth: 'auto', padding: '8px 16px' }}>
              {t('Back to Chat')}
            </Link>
          ) : (
            <Link to="/login" className="dl-btn secondary" style={{ minWidth: 'auto', padding: '8px 16px' }}>
              {t('Open in browser')}
            </Link>
          )}
        </div>
      </header>

      <main className="download-content">
        <div className="download-hero">
          <h1>{t('Get Cillhub for Desktop & Mobile')}</h1>
          <p className="download-lead">
            {t('High-fidelity voice, spatial audio, screen sharing, and native desktop notifications with automatic background updates.')}
          </p>

          <div className="download-buttons">
            <a href={appsUrl} className="dl-btn primary">
              <span className="dl-icon"><Icon d={ICONS.download} size={22} /></span>
              <span className="dl-labels">
                <strong>{t('Desktop and Android apps')}</strong>
                <span className="dl-sub">{t('Windows, Linux and Android · signed builds')}</span>
              </span>
            </a>
            {!android && <button type="button" onClick={handleInstallPwa} className="dl-btn secondary">
              <span className="dl-icon"><Icon d={ICONS.screen} size={22} /></span>
              <span className="dl-labels">
                <strong>{installed ? t('Web app installed') : t('Install the web app (PWA)')}</strong>
                <span className="dl-sub">{t('Install directly from your browser with full desktop integration')}</span>
              </span>
            </button>}
          </div>
        </div>

        <div className="download-grid">
          <div className="download-card">
            <h3>{t('Windows SmartScreen Note')}</h3>
            <p>
              {t('If Windows displays a SmartScreen notification during installation, click "More info" and select "Run anyway". The app installs cleanly to your local user directory.')}
            </p>
          </div>

          <div className="download-card">
            <h3>{t('Linux Quick Install')}</h3>
            <p>
              {t('Make the AppImage executable: chmod +x Cillhub-*.AppImage. On Debian or Ubuntu, install the .deb package: sudo apt install ./cillhub_*.deb.')}
            </p>
          </div>

          <div className="download-card">
            <h3>{t('Android Installation')}</h3>
            <p>
              {t('Download Cillhub.apk directly on your device. Android will prompt once to permit installation from your browser. The app delivers calls and messages in the background.')}
            </p>
          </div>

          <div className="download-card">
            <h3>{t('Self-Host Your Own Node')}</h3>
            <p>
              {t('Run Cillhub with Docker on any Linux host. Voice and WebRTC SFU work immediately out of the box:')}
            </p>
            <pre><code>curl -fsSLO {origin}/download/server/install.sh{'\n'}sh install.sh</code></pre>
          </div>
        </div>
      </main>

      <footer className="download-footer">
        <p>Cillhub · AGPL-3.0 · © Pascal Oraze</p>
        <LegalLinks />
      </footer>
    </div>
  )
}
