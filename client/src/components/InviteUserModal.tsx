import { useState } from 'react'
import { createInvite, openDm, sendMessage } from '../actions'
import { apiOrigin } from '../api'
import { t } from '../i18n'
import { has, P } from '../permissions'
import { permsOf } from '../selectors'
import { displayName, useStore } from '../store'
import type { Guild } from '../types'
import { Avatar, cls, FormError, GuildIcon, Modal } from './ui'

export function InviteUserModal({ userId, onClose }: { userId: string; onClose: () => void }) {
  const s = useStore((x) => x)
  const me = s.me!
  const target = s.users[userId]
  const [filter, setFilter] = useState('')
  const [sent, setSent] = useState<Record<string, boolean>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [error, setError] = useState('')

  const eligibleGuilds = Object.values(s.guilds).filter((g) => {
    const gp = permsOf(s, g.id)
    return g.owner_id === me.id || has(gp, P.CREATE_INSTANT_INVITE)
  })

  const q = filter.trim().toLowerCase()
  const list = q ? eligibleGuilds.filter((g) => g.name.toLowerCase().includes(q)) : eligibleGuilds

  const handleInvite = async (g: Guild) => {
    setError('')
    setLoading((prev) => ({ ...prev, [g.id]: true }))
    try {
      const ch = Object.values(s.channels).find(
        (c) =>
          c.guild_id === g.id &&
          (c.type === 0 || c.type === 5) &&
          (g.owner_id === me.id || has(permsOf(s, g.id, c), P.CREATE_INSTANT_INVITE))
      )
      if (!ch) throw new Error(t('No channel in {server} where you can create invites.', { server: g.name }))
      const inv = await createInvite(ch.id)
      const url = `${apiOrigin()}/invite/${inv.code}`
      await navigator.clipboard.writeText(url).catch(() => {})
      const dm = await openDm(userId)
      await sendMessage(dm, url)
      setSent((prev) => ({ ...prev, [g.id]: true }))
    } catch (e: any) {
      setError(e.message || t('Failed to create or send invite.'))
    } finally {
      setLoading((prev) => ({ ...prev, [g.id]: false }))
    }
  }

  const name = target ? displayName(target) : t('User')

  return (
    <Modal title={t('Invite to Server')} onClose={onClose}>
      {target && (
        <div className="invite-user-target">
          <Avatar user={target} size={40} />
          <div className="invite-user-info">
            <span className="invite-user-name">{name}</span>
            <span className="hint small">{target.username}</span>
          </div>
        </div>
      )}
      {eligibleGuilds.length > 5 && (
        <input
          className="input search"
          placeholder={t('Search servers…')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          aria-label={t('Search servers')}
        />
      )}
      <FormError error={error} />
      <div className="invite-guilds-list" role="list">
        {list.length === 0 ? (
          <p className="hint empty-hint">
            {eligibleGuilds.length === 0
              ? t('You do not have permission to invite users to any servers.')
              : t('No matching servers found.')}
          </p>
        ) : (
          list.map((g) => {
            const isSent = !!sent[g.id]
            const isLoading = !!loading[g.id]
            return (
              <div key={g.id} className="invite-guild-item" role="listitem">
                <div className="guild-icon-wrap">
                  <GuildIcon guild={g} />
                </div>
                <span className="guild-name ellipsis">{g.name}</span>
                <button
                  className={cls('small-btn', isSent ? 'secondary sent-btn' : 'primary')}
                  disabled={isSent || isLoading}
                  onClick={() => handleInvite(g)}
                >
                  {isLoading ? t('Sending…') : isSent ? t('Sent ✓') : t('Invite')}
                </button>
              </div>
            )
          })
        )}
      </div>
      <div className="modal-actions">
        <button className="primary" onClick={onClose}>{t('Done')}</button>
      </div>
    </Modal>
  )
}
