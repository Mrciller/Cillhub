import { useEffect, useState } from 'react'
import { api } from '../api'
import { toastError } from '../components/dialogs'
import { FormError, Icon, ICONS, Modal } from '../components/ui'
import { t } from '../i18n'
import { safeUrl } from '../markdown/Markdown'
import type { UserConnection } from '../types'
import './connections.css'

export type ServiceMeta = {
  type: string
  name: string
  color: string
  icon: string
  placeholder: string
  url: (handle: string) => string
}

export const SERVICES: Record<string, ServiceMeta> = {
  github: {
    type: 'github',
    name: 'GitHub',
    color: '#24292e',
    placeholder: 'octocat',
    url: (h) => `https://github.com/${h}`,
    icon: 'M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0 0 22 12.017C22 6.484 17.522 2 12 2z',
  },
  steam: {
    type: 'steam',
    name: 'Steam',
    color: '#171a21',
    placeholder: 'gabelog',
    url: (h) => `https://steamcommunity.com/id/${h}`,
    icon: 'M12 2a10 10 0 0 0-10 10c0 4.7 3.25 8.64 7.66 9.71l2.5-3.66a3.5 3.5 0 0 1-.16-1.05l-3.32-1.39a2.5 2.5 0 1 1 2.41-3.61l3.3 1.38c.47-.24 1-.38 1.61-.38a3.5 3.5 0 1 1 0 7c-.24 0-.47-.03-.7-.08l-2.48 3.63A10 10 0 1 0 12 2zm4 11.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z',
  },
  twitch: {
    type: 'twitch',
    name: 'Twitch',
    color: '#9146ff',
    placeholder: 'streamer',
    url: (h) => `https://twitch.tv/${h}`,
    icon: 'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z',
  },
  spotify: {
    type: 'spotify',
    name: 'Spotify',
    color: '#1db954',
    placeholder: 'spotify_user',
    url: (h) => `https://open.spotify.com/user/${h}`,
    icon: 'M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zm4.586 14.424a.623.623 0 0 1-.857.207c-2.348-1.435-5.304-1.76-8.785-.964a.624.624 0 0 1-.277-1.217c3.81-.87 7.076-.496 9.712 1.117a.625.625 0 0 1 .207.857zm1.225-2.723a.78.78 0 0 1-1.073.257c-2.688-1.652-6.786-2.13-9.965-1.164a.78.78 0 1 1-.453-1.493c3.633-1.103 8.147-.57 11.234 1.327a.78.78 0 0 1 .257 1.073zm.105-2.835C14.692 8.948 9.38 8.77 6.302 9.704a.936.936 0 0 1-.55-1.79c3.535-1.074 9.404-.863 13.14 1.357a.936.936 0 0 1-1.002 1.615z',
  },
  youtube: {
    type: 'youtube',
    name: 'YouTube',
    color: '#ff0000',
    placeholder: 'channel_handle',
    url: (h) => `https://youtube.com/@${h}`,
    icon: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  },
  reddit: {
    type: 'reddit',
    name: 'Reddit',
    color: '#ff4500',
    placeholder: 'redditor',
    url: (h) => `https://reddit.com/u/${h}`,
    icon: 'M12 2C6.48 2 2 6.48 2 12c0 5.52 4.48 10 10 10s10-4.48 10-10c0-5.52-4.48-10-10-10zm5.69 11.23c.03.17.04.34.04.52 0 2.65-3.08 4.8-6.88 4.8s-6.88-2.15-6.88-4.8c0-.18.01-.35.04-.52-.51-.3-.85-.86-.85-1.5 0-.96.78-1.74 1.74-1.74.52 0 .99.23 1.31.6 1.15-.79 2.7-1.3 4.42-1.36l.84-3.96 2.76.58c.07.61.59 1.09 1.22 1.09.68 0 1.23-.55 1.23-1.23s-.55-1.23-1.23-1.23c-.56 0-1.03.37-1.18.89l-3.08-.65-.98 4.62c1.76.05 3.35.56 4.52 1.37.32-.38.79-.62 1.32-.62.96 0 1.74.78 1.74 1.74 0 .64-.34 1.2-.85 1.5z',
  },
  twitter: {
    type: 'twitter',
    name: 'Twitter / X',
    color: '#1da1f2',
    placeholder: 'handle',
    url: (h) => `https://x.com/${h}`,
    icon: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z',
  },
}

export function ConnectionsSettings() {
  const [connections, setConnections] = useState<UserConnection[]>([])
  const [loading, setLoading] = useState(true)
  const [connectingService, setConnectingService] = useState<ServiceMeta | null>(null)

  const loadConnections = () => {
    setLoading(true)
    api<UserConnection[]>('/users/@me/connections')
      .then((res) => {
        setConnections(Array.isArray(res) ? res : [])
        setLoading(false)
      })
      .catch(() => {
        setConnections([])
        setLoading(false)
      })
  }

  useEffect(() => {
    loadConnections()
  }, [])

  const toggleShowOnProfile = (conn: UserConnection) => {
    const nextVal = !conn.show_on_profile
    api<UserConnection>(`/users/@me/connections/${conn.id}`, {
      method: 'PATCH',
      body: { show_on_profile: nextVal },
    })
      .then((updated) => {
        setConnections((prev) => prev.map((c) => (c.id === conn.id ? updated : c)))
      })
      .catch(toastError)
  }

  const deleteConnection = (id: string) => {
    api(`/users/@me/connections/${id}`, { method: 'DELETE' })
      .then(() => {
        setConnections((prev) => prev.filter((c) => c.id !== id))
      })
      .catch(toastError)
  }

  return (
    <div className="connections-settings-page">
      <h1>{t('Connections')}</h1>
      <p className="hint">
        {t('Add account links to your profile. Ownership of these accounts has not been verified.')}
      </p>

      <section className="connections-grid-section">
        <h2 className="list-heading">{t('Connect an Account')}</h2>
        <div className="connect-services-grid">
          {Object.values(SERVICES).map((srv) => (
            <button
              key={srv.type}
              type="button"
              className="service-connect-btn"
              onClick={() => setConnectingService(srv)}
            >
              <div className="service-icon-box" style={{ background: srv.color }}>
                <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor">
                  <path d={srv.icon} />
                </svg>
              </div>
              <span className="service-connect-name">{srv.name}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="connected-accounts-section">
        <h2 className="list-heading">{t('Connected Accounts')}</h2>
        {loading ? (
          <p className="hint">{t('Loading connections…')}</p>
        ) : connections.length === 0 ? (
          <p className="hint">{t('No connected accounts. Click a service above to link one.')}</p>
        ) : (
          <ul className="connected-accounts-list">
            {connections.map((c) => {
              const srv = SERVICES[c.type.toLowerCase()]
              const profileUrl = safeUrl(c.metadata?.profile_url ?? '') || srv?.url(c.name) || '#'
              return (
                <li key={c.id} className="connected-account-card">
                  <div className="account-card-left">
                    <div
                      className="service-icon-box"
                      style={{ background: srv?.color ?? '#5865f2' }}
                    >
                      {srv?.icon ? (
                        <svg width={20} height={20} viewBox="0 0 24 24" fill="currentColor">
                          <path d={srv.icon} />
                        </svg>
                      ) : (
                        <Icon d={ICONS.link} size={18} />
                      )}
                    </div>
                    <div className="account-card-info">
                      <div className="account-card-title">
                        <span className="account-service-name">{srv?.name ?? c.type}</span>
                        {c.verified && (
                          <span className="verified-badge" title={t('Verified Account')}>
                            <Icon d={ICONS.check} size={12} />
                          </span>
                        )}
                      </div>
                      <a
                        href={profileUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="account-external-link"
                      >
                        {c.name}
                        <Icon d={ICONS.external} size={12} />
                      </a>
                    </div>
                  </div>

                  <div className="account-card-actions">
                    <label className="toggle-label" title={t('Display on profile')}>
                      <span className="hint small">{t('Display on profile')}</span>
                      <input
                        type="checkbox"
                        checked={c.show_on_profile}
                        onChange={() => toggleShowOnProfile(c)}
                        className="toggle-checkbox"
                      />
                    </label>

                    <button
                      className="icon-btn danger-hover"
                      aria-label={t('Disconnect {name}', { name: c.name })}
                      title={t('Disconnect')}
                      onClick={() => deleteConnection(c.id)}
                    >
                      <Icon d={ICONS.trash} size={16} />
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {connectingService && (
        <ConnectAccountModal
          service={connectingService}
          onClose={() => setConnectingService(null)}
          onConnected={(newConn) => {
            setConnections((prev) => [...prev, newConn])
            setConnectingService(null)
          }}
        />
      )}
    </div>
  )
}

function ConnectAccountModal({
  service,
  onClose,
  onConnected,
}: {
  service: ServiceMeta
  onClose: () => void
  onConnected: (c: UserConnection) => void
}) {
  const [name, setName] = useState('')
  const [showOnProfile, setShowOnProfile] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    const handle = name.trim()
    if (!handle) {
      setError(t('Account username is required'))
      return
    }
    setSaving(true)
    setError('')
    const url = service.url(handle)

    api<UserConnection>('/users/@me/connections', {
      method: 'POST',
      body: {
        type: service.type,
        name: handle,
        show_on_profile: showOnProfile,
        metadata: { profile_url: url },
      },
    })
      .then((created) => {
        onConnected(created)
      })
      .catch((err: Error) => {
        setError(err.message)
        setSaving(false)
      })
  }

  return (
    <Modal title={t('Connect {service}', { service: service.name })} onClose={onClose}>
      <form onSubmit={submit} className="connect-form">
        {error && <FormError error={error} />}

        <div className="connect-service-banner" style={{ background: service.color }}>
          <svg width={32} height={32} viewBox="0 0 24 24" fill="currentColor">
            <path d={service.icon} />
          </svg>
          <h3>{service.name}</h3>
        </div>

        <label className="field-label" htmlFor="conn-handle-input">
          {t('Username or Profile Handle')}
        </label>
        <input
          id="conn-handle-input"
          className="handle-input"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('e.g. {placeholder}', { placeholder: service.placeholder })}
          maxLength={100}
          autoFocus
        />

        <label className="display-profile-toggle">
          <input
            type="checkbox"
            checked={showOnProfile}
            onChange={(e) => setShowOnProfile(e.target.checked)}
          />
          <span>{t('Display account details on your profile')}</span>
        </label>

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="submit" className="primary" disabled={saving || !name.trim()}>
            {t('Connect Account')}
          </button>
        </div>
      </form>
    </Modal>
  )
}
