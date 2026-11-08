// Server Settings → Server Directory (CONTRACT-v7 §5): list the server publicly with description, category, tags and
// language. The description is the guild's own field (PATCH /guilds/:id); the rest is discovery metadata.
import { useEffect, useState, type FormEvent } from 'react'
import { patchGuild } from '../actions'
import { ApiError } from '../api'
import { toast } from '../components/dialogs'
import { FormError } from '../components/ui'
import { t } from '../i18n'
import type { Guild } from '../types'
import { categories, FALLBACK_CATEGORIES, getMetadata, LANGUAGES, saveMetadata, type Category, type Metadata } from './api'

export function DirectoryListingPage({ guild }: { guild: Guild }) {
  const [meta, setMeta] = useState<Metadata | null>(null)
  const [cats, setCats] = useState<Category[]>(FALLBACK_CATEGORIES)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void categories().then(setCats)
    // 404: never listed yet.
    getMetadata(guild.id).then(setMeta, (e: ApiError) => (e.status === 404 ? setMeta({ guild_id: guild.id, listed: false, primary_category_id: 0, keywords: [] }) : setError(e.message)))
  }, [guild.id])
  if (!meta) return <><FormError error={error} />{!error && <p className="hint">{t('Loading…')}</p>}</>
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    const f = new FormData(e.currentTarget)
    const keywords = String(f.get('keywords')).split(',').map((k) => k.trim()).filter(Boolean)
    if (keywords.length > 5 || keywords.some((k) => k.length > 30)) return setError(t('Use at most 5 tags of up to 30 characters.'))
    const description = String(f.get('description')).trim()
    const preferred_locale = String(f.get('locale'))
    setBusy(true)
    setError('')
    const guildPatch = description !== (guild.description ?? '') ? patchGuild(guild.id, { description: description || null }) : Promise.resolve()
    guildPatch
      .then(() => saveMetadata(guild.id, { listed: f.get('listed') === 'on', primary_category_id: Number(f.get('category')), keywords, preferred_locale }))
      .then((m) => (setMeta(m), toast(t('Saved.'))), (err: Error) => setError(err.message))
      .finally(() => setBusy(false))
  }
  return (
    <form onSubmit={submit} className="listing-form">
      <p className="hint">{t('Listed servers appear in the hub\'s server directory, where anyone with an account there can find and join them.')}</p>
      {meta.hidden && <p className="form-error" role="alert">{t('The hub admins removed this server from the directory. Contact them if you think this is a mistake.')}{meta.hidden_reason && ` ${t('Reason: {reason}', { reason: meta.hidden_reason })}`}</p>}
      <label className="check-row"><input type="checkbox" name="listed" defaultChecked={meta.listed} /> <span>{t('List this server in the server directory')}</span></label>
      <div className="field">
        <label htmlFor="dir-desc">{t('Description')}</label>
        <textarea id="dir-desc" name="description" className="input" maxLength={300} rows={3} defaultValue={guild.description ?? ''} />
      </div>
      <div className="field">
        <label htmlFor="dir-cat">{t('Category')}</label>
        <select id="dir-cat" name="category" className="input" defaultValue={meta.primary_category_id || cats[0]?.id}>
          {cats.map((c) => <option key={c.id} value={c.id}>{t(c.name)}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="dir-tags">{t('Tags (comma-separated, up to 5)')}</label>
        <input id="dir-tags" name="keywords" className="input" defaultValue={(meta.keywords ?? []).join(', ')} maxLength={160} />
      </div>
      <div className="field">
        <label htmlFor="dir-locale">{t('Language')}</label>
        <select id="dir-locale" name="locale" className="input" defaultValue={meta.preferred_locale ?? 'en-US'}>
          {LANGUAGES.map(([v, n]) => <option key={v} value={v}>{n}</option>)}
        </select>
      </div>
      <FormError error={error} />
      <button className="primary" disabled={busy}>{t('Save Changes')}</button>
    </form>
  )
}
