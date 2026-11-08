import { useState } from 'react'
import { t } from '../i18n'
import { Icon, ICONS } from '../components/ui'
import { toast, toastError } from '../components/dialogs'
import { getDesktopBridge } from '../desktop/bridge'

export type GameInviteData = {
  game: 'League of Legends' | string
  queueName: string
  queueId?: number
  partyId: string
  hostName: string
  hostPuuid?: string
  members: number
  maxMembers: number
}

export const GAME_INVITE_PREFIX = 'cillhub://game-invite?'

export function parseGameInvite(content: string): GameInviteData | null {
  if (!content) return null
  const idx = content.indexOf(GAME_INVITE_PREFIX)
  if (idx === -1) return null
  const queryStr = content.slice(idx + GAME_INVITE_PREFIX.length).split(/\s+/)[0]
  try {
    const params = new URLSearchParams(queryStr)
    const game = params.get('game')
    const partyId = params.get('partyId')
    if (!game || !partyId) return null
    return {
      game,
      partyId,
      queueName: params.get('queueName') || 'Custom Game',
      queueId: params.get('queueId') ? Number(params.get('queueId')) : undefined,
      hostName: params.get('hostName') || 'Host',
      hostPuuid: params.get('hostPuuid') || undefined,
      members: Number(params.get('members') || 1),
      maxMembers: Number(params.get('maxMembers') || 5),
    }
  } catch {
    return null
  }
}

export function formatGameInviteUrl(data: GameInviteData): string {
  const p = new URLSearchParams()
  p.set('game', data.game)
  p.set('partyId', data.partyId)
  p.set('queueName', data.queueName)
  if (data.queueId) p.set('queueId', String(data.queueId))
  p.set('hostName', data.hostName)
  if (data.hostPuuid) p.set('hostPuuid', data.hostPuuid)
  p.set('members', String(data.members))
  p.set('maxMembers', String(data.maxMembers))
  return `${GAME_INVITE_PREFIX}${p.toString()}`
}

export function GameInviteCard({ data }: { data: GameInviteData }) {
  const [joining, setJoining] = useState(false)
  const d = getDesktopBridge()

  const handleJoin = async () => {
    if (!d || typeof d.acceptLeagueInvite !== 'function') {
      toast(t('To join directly, open the Cillhub Desktop app with League running.'))
      return
    }
    setJoining(true)
    try {
      await d.acceptLeagueInvite()
      toast(t('Joining {game} lobby...', { game: data.game }))
    } catch (err: any) {
      toastError(err?.message || t('Could not join lobby. Ensure League of Legends is running.'))
    } finally {
      setJoining(false)
    }
  }

  return (
    <article
      className="game-invite-card"
      style={{
        marginTop: 6,
        marginBottom: 6,
        maxWidth: 420,
        borderRadius: 8,
        border: '1px solid var(--border)',
        borderLeft: '4px solid #0ac8b9',
        background: 'var(--panel)',
        padding: '12px 16px',
        boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 20 }}>🎮</span>
          <strong style={{ fontSize: 14, color: 'var(--strong)' }}>{data.game}</strong>
        </div>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            background: 'rgba(10, 200, 185, 0.15)',
            color: '#0ac8b9',
            padding: '2px 8px',
            borderRadius: 12,
            border: '1px solid rgba(10, 200, 185, 0.3)',
          }}
        >
          {t('Open Party')}
        </span>
      </div>

      <div style={{ fontSize: 13, color: 'var(--text)', marginBottom: 4 }}>
        <strong>{data.queueName}</strong>
      </div>

      <div style={{ fontSize: 12, color: 'var(--muted)', display: 'flex', gap: 16, marginBottom: 12 }}>
        <span>{t('Host: {name}', { name: data.hostName })}</span>
        <span>{t('Party: {members}/{max}', { members: data.members, max: data.maxMembers })}</span>
      </div>

      <button
        type="button"
        className="primary small"
        disabled={joining}
        onClick={handleJoin}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          background: '#0ac8b9',
          color: '#000',
          fontWeight: 600,
        }}
      >
        <Icon d={ICONS.play} size={16} />
        {joining ? t('Joining...') : t('Join Party')}
      </button>
    </article>
  )
}
