// Message Requests Inbox (non-friend DMs)
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Avatar, Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { navigate } from '../router'
import { displayName, useStore } from '../store'
import type { Channel, User } from '../types'

export function MessageRequests() {
  const [requests, setRequests] = useState<Channel[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  const me = useStore((s) => s.me)

  const load = () => {
    setLoading(true)
    api<Channel[]>('/users/@me/message-requests')
      .then((data) => {
        setRequests(Array.isArray(data) ? data : [])
        setLoading(false)
      })
      .catch((e: Error) => {
        setErr(e.message)
        setLoading(false)
      })
  }

  useEffect(() => {
    load()
  }, [])

  const act = async (channelId: string, status: 'accepted' | 'declined') => {
    try {
      await api(`/users/@me/message-requests/${channelId}`, {
        method: 'PUT',
        body: { status },
      })
      setRequests((prev) => prev.filter((c) => c.id !== channelId))
      if (status === 'accepted') {
        navigate(`/channels/@me/${channelId}`)
      }
    } catch (e) {
      console.error(e)
    }
  }

  if (loading) return <p className="hint small" style={{ padding: '16px' }}>{t('Loading message requests…')}</p>
  if (err) return <p className="form-error" style={{ padding: '16px' }}>{err}</p>
  if (!requests.length) {
    return (
      <div className="empty-requests" style={{ padding: '24px', textAlign: 'center' }}>
        <p className="bold">{t('No message requests')}</p>
        <p className="hint small">{t("You don't have any direct messages from non-friends waiting for review.")}</p>
      </div>
    )
  }

  return (
    <ul className="message-requests-list" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
      {requests.map((c) => {
        const other: User | undefined = (c.recipients ?? []).find((u) => u.id !== me?.id)
        if (!other) return null

        return (
          <li key={c.id} className="friend message-request-item" style={{ display: 'flex', alignItems: 'center', gap: '12px', padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
            <Avatar user={other} size={36} />
            <div className="friend-who" style={{ flex: 1, minWidth: 0 }}>
              <span className="name" style={{ fontWeight: 600 }}>{displayName(other)} <span className="hint" style={{ fontWeight: 'normal' }}>{other.username}</span></span>
              <p className="hint small" style={{ margin: '2px 0 0 0' }}>{t('Direct message request')}</p>
            </div>
            <div className="actions" style={{ display: 'flex', gap: '8px' }}>
              <button
                className="btn primary small"
                onClick={() => act(c.id, 'accepted')}
                title={t('Accept')}
              >
                <Icon d={ICONS.check} size={16} />
                <span>{t('Accept')}</span>
              </button>
              <button
                className="btn danger small"
                onClick={() => act(c.id, 'declined')}
                title={t('Decline')}
              >
                <Icon d={ICONS.close} size={16} />
                <span>{t('Decline')}</span>
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
