import { useEffect, useState } from 'react'
import { Link } from '../router'
import { useStore } from '../store'
import { t } from '../i18n'
import { Icon, ICONS } from '../components/ui'
import './download.css'

export function DownloadPage() {
  const token = useStore((s) => s.token)
  const [os, setOs] = useState<'windows' | 'linux' | 'android' | 'other'>('windows')
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null)
  const [installed, setInstalled] = useState(false)

  useEffect(() => {
    document.title = `${t('Download Apps')} · Cillhub`
    const p = (navigator as unknown as { userAgentData?: { platform?: string } }).userAgentData?.platform || navigator.platform || navigator.userAgent
    if (/android/i.test(navigator.userAgent)) setOs('android')
    else if (/win/i.test(p)) setOs('windows')
    else if (/linux|x11/i.test(p)) setOs('linux')
    else setOs('other')

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
  const winUrl = `${origin}/download/desktop/Cillhub-Setup-2.2.1.exe`
  const rustWinSetupUrl = `${origin}/download/desktop/Cillhub-Rust-Setup-2.2.1.exe`
  const rustWinZipUrl = `${origin}/download/desktop/Cillhub-Rust-2.2.1-windows-x64.zip`
  const appImageUrl = `${origin}/download/desktop/Cillhub-2.2.1.AppImage`
  const debUrl = `${origin}/download/desktop/cillhub_2.2.1_amd64.deb`
  const rustDebUrl = `${origin}/download/desktop/cillhub-desktop-rust_2.2.1_amd64.deb`
  const rustTarUrl = `${origin}/download/desktop/Cillhub-Rust-2.2.1-linux-x64.tar.gz`
  const apkUrl = `${origin}/download/android/Cillhub.apk`
  // Betacord is the test instance; everywhere else this page shows no channel tag
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
          <svg width="32" height="32" viewBox="0 0 100 100" aria-hidden="true">
            <rect x="4" y="4" width="92" height="92" rx="22" fill="#00d2b4" />
            <path d="M71 29.5A30 30 0 1 0 71 70.5" fill="none" stroke="#fff" strokeWidth="13.5" strokeLinecap="butt" />
          </svg>
          <strong>Cillhub {beta && <span style={{ color: '#00d2b4', fontSize: '13px', fontWeight: 600, verticalAlign: 'middle', marginLeft: '6px' }}>Betacord</span>}</strong>
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
          <div className="download-badge">
            <Icon d={ICONS.download} size={16} />
            <span>{beta ? 'Desktop 2.2.1 · Native Rust 2.2.1 (Betacord)' : 'Desktop 2.2.1 · Native Rust 2.2.1'}</span>
          </div>
          <h1>{t('Get Cillhub for Desktop & Mobile')}</h1>
          <p className="download-lead">
            {t('High-fidelity voice, spatial audio, screen sharing, and native desktop notifications with automatic background updates.')}
          </p>

          {os !== 'android' && <div style={{ marginBottom: '24px' }}>
            <button
              type="button"
              onClick={handleInstallPwa}
              className="dl-btn primary"
              style={{
                fontSize: '17px',
                padding: '14px 28px',
                background: '#00d2b4',
                color: '#070a14',
                fontWeight: 700,
                boxShadow: '0 4px 18px rgba(0, 210, 180, 0.4)',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              <span className="dl-icon">⚡</span>
              <span className="dl-labels">
                <strong>{installed ? t('Web app installed') : t('Install the web app (PWA)')}</strong>
                <span className="dl-sub" style={{ color: '#070a14', opacity: 0.85 }}>{t('Install directly from your browser with full desktop integration')}</span>
              </span>
            </button>
          </div>}

          <div className="download-buttons">
            <a href={winUrl} download="Cillhub-Setup-2.2.1.exe" className={`dl-btn ${os === 'windows' ? 'primary' : 'secondary'}`}>
              <span className="dl-icon">🪟</span>
              <span className="dl-labels">
                <strong>{t('Download for Windows')}</strong>
                <span className="dl-sub">{t('Installer · Windows 10/11 64-bit')}</span>
              </span>
            </a>

            <a href={rustWinSetupUrl} download="Cillhub-Rust-Setup-2.2.1.exe" className="dl-btn secondary" style={{ borderColor: 'rgba(235, 100, 40, 0.4)' }}>
              <span className="dl-icon">🦀</span>
              <span className="dl-labels">
                <strong>{t('Native Rust Windows (Setup Installer)')}</strong>
                <span className="dl-sub" style={{ color: '#eb6428' }}>{t('Windows App Installer · 5.3 MB')}</span>
              </span>
            </a>

            <a href={rustWinZipUrl} download="Cillhub-Rust-2.2.1-windows-x64.zip" className="dl-btn secondary" style={{ borderColor: 'rgba(235, 100, 40, 0.4)' }}>
              <span className="dl-icon">🦀</span>
              <span className="dl-labels">
                <strong>{t('Native Rust Windows (.zip)')}</strong>
                <span className="dl-sub" style={{ color: '#eb6428' }}>{t('Portable Archive · 6.5 MB')}</span>
              </span>
            </a>

            <a href={appImageUrl} download="Cillhub-2.2.1.AppImage" className={`dl-btn ${os === 'linux' ? 'primary' : 'secondary'}`}>
              <span className="dl-icon">🐧</span>
              <span className="dl-labels">
                <strong>{t('Linux AppImage')}</strong>
                <span className="dl-sub">{t('Universal 64-bit')}</span>
              </span>
            </a>

            <a href={debUrl} download="cillhub_2.2.1_amd64.deb" className="dl-btn secondary">
              <span className="dl-icon">📦</span>
              <span className="dl-labels">
                <strong>{t('Linux .deb')}</strong>
                <span className="dl-sub">{t('Debian / Ubuntu')}</span>
              </span>
            </a>

            <a href={rustDebUrl} download="cillhub-desktop-rust_2.2.1_amd64.deb" className="dl-btn secondary" style={{ borderColor: 'rgba(235, 100, 40, 0.4)' }}>
              <span className="dl-icon">🦀</span>
              <span className="dl-labels">
                <strong>{t('Native Rust Linux (.deb)')}</strong>
                <span className="dl-sub" style={{ color: '#eb6428' }}>{t('SIMD Audio DSP · 883 KB')}</span>
              </span>
            </a>

            <a href={rustTarUrl} download="Cillhub-Rust-2.2.1-linux-x64.tar.gz" className="dl-btn secondary" style={{ borderColor: 'rgba(235, 100, 40, 0.4)' }}>
              <span className="dl-icon">🦀</span>
              <span className="dl-labels">
                <strong>{t('Native Rust Linux (.tar.gz)')}</strong>
                <span className="dl-sub" style={{ color: '#eb6428' }}>{t('Standalone Portable · 1.1 MB')}</span>
              </span>
            </a>

            <a href={apkUrl} download="Cillhub.apk" className={`dl-btn ${os === 'android' ? 'primary' : 'secondary'}`}>
              <span className="dl-icon">🤖</span>
              <span className="dl-labels">
                <strong>{t('Android App (APK)')}</strong>
                <span className="dl-sub">{t('Native app 3.1.0 · Android 8.0+')}</span>
              </span>
            </a>
          </div>

          <p className="download-meta">
            {t('Desktop 2.2.1 · Native Rust 2.2.1 · Android 3.1.0 · Free & Open Source (AGPL-3.0)')}
          </p>
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
        <p>Cillhub{beta ? ' Betacord' : ''} · AGPL-3.0 · © Pascal Oraze</p>
      </footer>
    </div>
  )
}
