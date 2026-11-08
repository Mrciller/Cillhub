// Devices: the account's login sessions (GET /auth/sessions), log out one or all others.
import { useEffect, useState } from 'react'
import { authSessions, logoutSessions } from '../actions'
import { relative } from '../markdown/Markdown'
import { toastError } from '../components/dialogs'
import { Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import type { AuthSession } from '../types'

export function Sessions() {
  const [list, setList] = useState<AuthSession[] | null>(null)
  const load = () => void authSessions().then(setList, (e: Error) => (toastError(e), setList([])))
  useEffect(load, [])
  const out = (hashes: string[]) => void logoutSessions(hashes).then(load, toastError)
  const current = list?.find((x) => x.current)
  const others = list?.filter((x) => !x.current) ?? []
  const row = (x: AuthSession) => (
    <li key={x.id_hash} className="session">
      <Icon d={ICONS.screen} size={28} />
      <div className="session-text">
        <strong>{[x.client_info.os, x.client_info.platform].filter(Boolean).join(' · ') || t('Unknown device')}</strong>
        <span className="hint small">{x.current ? t('This device') : t('Last used {when}', { when: relative(Date.parse(x.approx_last_used_time)) })}</span>
      </div>
      {!x.current && <button className="icon-btn" aria-label={t('Log out this device')} title={t('Log out')} onClick={() => out([x.id_hash])}><Icon d={ICONS.close} size={18} /></button>}
    </li>
  )
  return (
    <>
      <h1>{t('Devices')}</h1>
      <p className="hint">{t('Here are all the devices that are currently logged in with your account. Log out of any you do not recognise.')}</p>
      {list === null ? <p className="hint" role="status">{t('Loading…')}</p> : (
        <>
          <h2 className="list-heading">{t('Current Device')}</h2>
          <ul className="sessions">{current ? row(current) : <li className="hint">{t('Unknown')}</li>}</ul>
          <h2 className="list-heading">{t('Other Devices')}</h2>
          {others.length ? <ul className="sessions">{others.map(row)}</ul> : <p className="hint">{t('No other devices are logged in.')}</p>}
          {others.length > 0 && <button className="danger-btn" onClick={() => out(others.map((x) => x.id_hash))}>{t('Log Out All Known Devices')}</button>}
        </>
      )}
    </>
  )
}
