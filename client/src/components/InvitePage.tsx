import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { joinInvite } from '../actions'
import { api, ApiError } from '../api'
import { navigate } from '../router'
import { displayName, useStore } from '../store'
import type { Invite } from '../types'
import { FormError, GuildIcon, initials } from './ui'
import { accentVars, splashUrl } from '../custom/ServerCustomize'

export function InvitePage({ code }: { code: string }) {
  const token = useStore((s) => s.token)
  const [invite, setInvite] = useState<Invite | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    // with_counts is the API's way to get member counts on an invite; fall back to the guild's member_count.
    api<Invite>(`/invites/${encodeURIComponent(code)}?with_counts=true`).then(setInvite, (e: ApiError) =>
      setError(e.code === 10006 || e.status === 404 ? t('This invite is invalid or has expired.') : e.message),
    )
  }, [code])

  const count = invite?.approximate_member_count ?? invite?.guild.member_count
  const join = () => {
    if (!token) return navigate(`/login?next=${encodeURIComponent(location.pathname)}`)
    setBusy(true)
    joinInvite(code, invite?.channel.id).catch((e: Error) => (setError(e.message), setBusy(false)))
  }

  return (
    <div className={invite && splashUrl(invite.guild) ? 'auth-bg splashed' : 'auth-bg'} style={invite && splashUrl(invite.guild) ? { backgroundImage: `url("${splashUrl(invite.guild)}")` } : undefined}>
      <main className="auth-card invite" style={accentVars(invite?.guild.brand_color_primary)}>
        {invite ? (
          <>
            <div className="rail-icon big" aria-hidden="true">{invite.guild.icon ? <GuildIcon guild={invite.guild} /> : initials(invite.guild.name, 3)}</div>
            <p className="sub">{invite.inviter ? t('{name} invited you to join', { name: displayName(invite.inviter) }) : t("You've been invited to join")}</p>
            <h1>{invite.guild.name}</h1>
            {count != null && <p className="hint">{t(count === 1 ? '{n} Member' : '{n} Members', { n: count })}</p>}
            {invite.guild.description && <p className="hint invite-desc">{invite.guild.description}</p>}
            <button className="primary wide accent-btn" disabled={busy} onClick={join}>{token ? t('Join') : t('Log in to join')}</button>
          </>
        ) : (
          <h1>{error ? t('Invite invalid') : t('Loading invite…')}</h1>
        )}
        <FormError error={error} />
      </main>
    </div>
  )
}
