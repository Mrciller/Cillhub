// Updates page (CONTRACT-v7 §1/§6) for the instance's updater sidecar (selfhost/updater.mjs): current version, the hub's
// signed release (version, notes) from the last check, update (database backup first, migrate, restart, automatic rollback
// when the new version does not come up) and manual rollback to the previous image; both ask for the admin's 2FA code.
// While the updater works the page polls; the server is briefly down during the swap. Automatic updates (off / patch and
// security / all, in a maintenance hour) and whether the hub may ask for an update are set here too.
import { useEffect } from 'react'
import { toast, toastError } from '../components/dialogs'
import { FormError } from '../components/ui'
import { t } from '../i18n'
import * as A from './api'
import { askCode, bytes, useLoad, when } from './util'

const STATE: Record<NonNullable<A.Updates['state']>, string> = {
  idle: 'Idle', updating: 'Updating…', rolling_back: 'Rolling back…', done: 'Finished', failed: 'The last operation failed',
}

export function UpdatesPage() {
  const { data: u, error, reload, setData } = useLoad(A.getUpdates, [])
  const running = u?.state === 'updating' || u?.state === 'rolling_back'
  // The server is down for a moment while the updater swaps the container: keep polling quietly.
  useEffect(() => {
    if (!running) return
    const id = setInterval(() => void A.getUpdates().then(setData, () => {}), 3000)
    return () => clearInterval(id)
  }, [running, setData])
  if (error && !u) return <FormError error={error} />
  if (!u) return <p className="hint" aria-busy="true">{t('Loading…')}</p>
  const latest = u.last_check?.update_available ? u.last_check.latest : undefined
  const update = () => latest && void askCode(t('Update to {v}?', { v: latest.version }), <p>{t('The database is backed up first. Cillhub restarts, which drops calls for a few seconds. If the new version does not start, the previous one comes back automatically.')}</p>, t('Update Now'))
    .then((code) => void (code && A.applyUpdate(latest.version, code).then((s) => setData({ ...u, ...s }), toastError)))
  const rollback = () => u.previous && void askCode(t('Roll back to {v}?', { v: u.previous.version }), <p>{t('Cillhub restarts with the previous image and restores the database backup taken before the update. Messages sent since then are lost.')}</p>, t('Roll Back'))
    .then((code) => void (code && A.rollbackUpdate(code).then((s) => setData({ ...u, ...s }), toastError)))
  const check = () => void A.checkUpdates().then((c) => (setData({ ...u, last_check: c }), toast(c.update_available && c.latest ? t('Version {v} is available.', { v: c.latest.version }) : t('Cillhub is up to date.'))), toastError)
  return (
    <>
      {!u.updater && <p className="hint">{t('No updater runs next to this instance, so it is updated by hand on the server. Installations made with install.sh have one.')}</p>}
      {u.updater && u.reachable === false && <p className="form-error" role="alert">{t('The updater is not reachable: {error}', { error: u.error ?? '' })}</p>}
      <dl className="admin-facts">
        <dt>{t('Current version')}</dt><dd>{u.current_version}</dd>
        <dt>{t('Available')}</dt><dd>{latest ? <strong>{latest.version}</strong> : u.last_check?.error ? t('Check failed: {error}', { error: u.last_check.error }) : u.last_check ? t('Up to date') : '—'}{latest?.size ? ` · ${bytes(latest.size)}` : ''}</dd>
        <dt>{t('Last checked')}</dt><dd>{when(u.last_check?.at)}</dd>
        <dt>{t('Previous version')}</dt><dd>{u.previous?.version ?? '—'}</dd>
        <dt>{t('Last backup')}</dt><dd>{u.backup ?? '—'}</dd>
      </dl>
      <div role="status" aria-live="polite">
        {u.state && u.state !== 'idle' && (
          <p className={u.state === 'failed' ? 'form-error' : 'admin-progress'}>
            {t(STATE[u.state])}{u.target_version && ` · ${u.target_version}`}{u.step && ` · ${u.step}`}{u.state === 'failed' && u.error && `: ${u.error}`}
            {u.state === 'failed' && u.rolled_back && ` ${t('The previous version was restored.')}`}
          </p>
        )}
      </div>
      {u.logs && <details><summary>{t('Log of the failed start')}</summary><pre className="admin-notes">{u.logs}</pre></details>}
      <div className="admin-actions">
        <button className="primary admin-btn" disabled={!latest || !u.last_check?.can_update || running} onClick={update}>{latest ? t('Update to {v}', { v: latest.version }) : t('Update Now')}</button>
        <button className="secondary admin-btn" disabled={!u.updater || running} onClick={check}>{t('Check Now')}</button>
        <button className="secondary admin-btn" disabled={!u.previous || running} onClick={rollback}>{t('Roll Back')}</button>
        <button className="link" onClick={() => void reload()}>{t('Refresh')}</button>
      </div>
      {latest?.notes && (
        <section aria-labelledby="notes-h">
          <h2 id="notes-h">{t('Release notes for {v}', { v: latest.version })}</h2>
          <div className="admin-notes">{latest.notes}</div>
        </section>
      )}
      <label className="admin-check"><input type="checkbox" checked={u.auto_check} onChange={(e) => void A.patchUpdates({ auto_check: e.target.checked }).then(setData, toastError)} /> {t('Check the hub for updates once a day')}</label>
      <section aria-labelledby="auto-h">
        <h2 id="auto-h">{t('Automatic updates')}</h2>
        {u.updater ? (
          <AutoUpdateFields mode={u.auto_update} hour={u.auto_update_hour} onChange={(patch) => void A.patchUpdates(patch).then((r) => (setData(r), toast(t('Saved.'))), toastError)} />
        ) : <p className="hint">{t('Automatic updates need the updater.')}</p>}
        {u.last_auto && <p className="hint small">{t('Last automatic run {when}: {decision}', { when: when(u.last_auto.at), decision: u.last_auto.decision ?? '—' })}</p>}
        <label className="admin-check"><input type="checkbox" checked={u.remote_update} onChange={(e) => void A.patchUpdates({ remote_update: e.target.checked }).then(setData, toastError)} /> {t('Let the network hub ask this server to update now')}</label>
        <p className="hint small">{t('Updates only ever come from signed releases; a request from the hub starts the same update as the button above.')}</p>
      </section>
    </>
  )
}

const localHour = (h: number) => new Date(Date.UTC(2000, 0, 1, h)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

/** off / patch and security / all, plus the maintenance hour (UTC); shared with the setup wizard. */
export function AutoUpdateFields({ mode, hour, onChange }: { mode: A.AutoUpdateMode; hour: number; onChange: (p: { auto_update?: A.AutoUpdateMode; auto_update_hour?: number }) => void }) {
  return (
    <>
      <fieldset className="choice block">
        <legend>{t('Install updates automatically')}</legend>
        {([['off', 'Off: I update by hand'], ['patch', 'Security and patch releases only (recommended)'], ['all', 'All releases']] as const).map(([v, label]) => (
          <label key={v}><input type="radio" name="auto_update" value={v} checked={mode === v} onChange={() => onChange({ auto_update: v })} /> {t(label)}</label>
        ))}
      </fieldset>
      <div className="field">
        <label htmlFor="auto-update-hour">{t('Maintenance window')}</label>
        <select id="auto-update-hour" className="input" value={hour} disabled={mode === 'off'} onChange={(e) => onChange({ auto_update_hour: Number(e.target.value) })}>
          {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{t('{h}:00 UTC ({local} your time)', { h: String(h).padStart(2, '0'), local: localHour(h) })}</option>)}
        </select>
      </div>
      <p className="hint small">{t('The database is backed up first; if the new version does not start, the previous one comes back automatically. Calls drop for a few seconds.')}</p>
    </>
  )
}
