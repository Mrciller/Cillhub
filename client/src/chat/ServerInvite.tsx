// A server invite link of this hub, shown as a card under the message: server, member count and Join.
import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { api, type ApiError } from '../api'
import { joinInvite } from '../actions'
import { navigate } from '../router'
import { useStore } from '../store'
import { GuildIcon } from '../components/ui'
import type { Invite } from '../types'

type Lookup = { invite: Invite } | { error: string; invalid: boolean }
type Entry = { at: number; ttl: number; p: Promise<Lookup>; value?: Lookup }

// each code is looked up once; failures (also "invalid") are kept for a short time only
const cache = new Map<string, Entry>()
let running = 0
const waiting: (() => void)[] = []
// two lookups at a time, so a history page full of invites does not fire them all at once
function slot<T>(f: () => Promise<T>) {
  return new Promise<void>((go) => (running < 2 ? (running++, go()) : waiting.push(go))).then(f).finally(() => {
    const next = waiting.shift()
    if (next) next()
    else running--
  })
}

function lookup(code: string): Entry {
  const hit = cache.get(code)
  if (hit && Date.now() - hit.at < hit.ttl) return hit
  const entry = { at: Date.now(), ttl: 5 * 60_000 } as Entry
  entry.p = slot(() => api<Invite>(`/invites/${encodeURIComponent(code)}?with_counts=true`)).then(
    (invite): Lookup => ({ invite }),
    (e: ApiError): Lookup => ((entry.ttl = 30_000), { error: e.message, invalid: e.code === 10006 || e.status === 404 }),
  ).then((v) => (entry.value = v))
  cache.set(code, entry)
  return entry
}

export function ServerInviteCard({ code, mine }: { code: string; mine: boolean }) {
  const [res, setRes] = useState(() => cache.get(code)?.value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let live = true
    lookup(code).p.then((v) => live && setRes(v))
    return () => void (live = false)
  }, [code])
  const invite = res && 'invite' in res ? res.invite : null
  const member = useStore((s) => !!invite && !!s.guilds[invite.guild.id])
  const label = <p className="invite-card-label">{mine ? t('You sent an invite to join a server') : t("You've been invited to join a server")}</p>

  if (!res) {
    return (
      <article className="invite-card" aria-busy="true" aria-label={t('Loading invite…')}>
        {label}
        <div className="invite-card-row">
          <div className="invite-card-icon skeleton" />
          <div className="invite-card-text"><span className="skeleton-line wide" /><span className="skeleton-line" /></div>
        </div>
      </article>
    )
  }
  if (!invite) {
    const bad = 'invalid' in res && res.invalid
    return (
      <article className="invite-card muted">
        {label}
        <div className="invite-card-row">
          <div className="invite-card-icon" aria-hidden="true">?</div>
          <div className="invite-card-text">
            <strong>{t('Invite invalid')}</strong>
            <span>{bad ? t('This invite has expired or was revoked.') : 'error' in res && res.error}</span>
          </div>
        </div>
      </article>
    )
  }

  const count = invite.approximate_member_count ?? invite.guild.member_count
  const join = () => {
    if (member) return navigate(`/channels/${invite.guild.id}`)
    setBusy(true)
    setError('')
    joinInvite(code, invite.channel?.id)
      .then(() => cache.delete(code)) // the member count changed
      .catch((e: Error) => setError(e.message))
      .finally(() => setBusy(false))
  }
  return (
    <article className="invite-card">
      {label}
      <div className="invite-card-row">
        <div className="invite-card-icon" aria-hidden="true"><GuildIcon guild={invite.guild} /></div>
        <div className="invite-card-text">
          <strong title={invite.guild.name}>{invite.guild.name}</strong>
          {count != null && <span>{t(count === 1 ? '{n} Member' : '{n} Members', { n: count })}</span>}
        </div>
        <button type="button" className={member ? 'secondary' : 'primary'} disabled={busy} onClick={join}>{member ? t('Joined') : t('Join')}</button>
      </div>
      {error && <p className="invite-card-error" role="alert">{error}</p>}
    </article>
  )
}
