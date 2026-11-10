// Hub: Release Channel page (CONTRACT-v7 §6). Which server version the hub offers self-hosted nodes, with release notes;
// public at GET /server/releases/latest. The signed latest.json under /download/server/ (selfhost/scripts/make-release.sh)
// is what node updaters install; this is the version the hub admins announce.
import { useState, type FormEvent } from 'react'
import { toast } from '../components/dialogs'
import { Field, FormError } from '../components/ui'
import { t } from '../i18n'
import * as A from './api'
import { askCode, useLoad, when } from './util'

export function ReleasePage() {
  const { data, error, setData } = useLoad(A.getRelease, [])
  const [saveError, setSaveError] = useState('')
  const [busy, setBusy] = useState(false)
  if (error) return <FormError error={error} />
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    setBusy(true)
    setSaveError('')
    const version = String(f.get('version')).trim(), notes = String(f.get('notes'))
    A.elevated((mfa) => A.putRelease(version, notes, mfa), () => askCode(t('Publish'), <p>{t('Confirm with your own two-factor code.')}</p>, t('Publish')))
      .then((r) => r && (setData(r), toast(t('Release published.'))), (err: Error) => setSaveError(err.message)).finally(() => setBusy(false))
  }
  return (
    <>
      <p className="hint">{t('Nodes see this version and its notes on their Updates page. The image itself comes from the signed release files under /download/server/.')}</p>
      <dl className="admin-facts" aria-live="polite">
        <dt>{t('Offered version')}</dt><dd>{data ? <strong>{data.version}</strong> : t('None yet')}</dd>
        <dt>{t('Published')}</dt><dd>{when(data?.published_at)}</dd>
      </dl>
      <form className="admin-form" onSubmit={submit} aria-labelledby="rel-h" key={data?.published_at ?? 'new'}>
        <h2 id="rel-h">{t('Offer a version')}</h2>
        <Field label={t('Version')} name="version" required pattern="\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.\-]{1,32})?" placeholder="7.0.0" defaultValue={data?.version ?? ''} />
        <div className="field">
          <label htmlFor="rel-notes">{t('Release notes')}</label>
          <textarea id="rel-notes" name="notes" className="input" rows={8} maxLength={4000} defaultValue={data?.notes ?? ''} />
        </div>
        <FormError error={saveError} />
        <button className="primary admin-btn" disabled={busy}>{t('Publish')}</button>
      </form>
    </>
  )
}
