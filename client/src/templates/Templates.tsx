// Server templates and backups (CONTRACT-v5 section 7): Server Settings → Server Template, and "Add a server" → from template / from file.
import { useEffect, useState, type FormEvent } from 'react'
import { WEB_ORIGIN } from '../api'
import { createFromTemplate, createTemplate, deleteTemplate, exportGuild, getExternalTemplate, getTemplate, guildTemplates, importGuild, syncTemplate } from '../actions'
import { dateTime } from '../appearance/format'
import { ask, toast, toastError } from '../components/dialogs'
import { Field, FormError } from '../components/ui'
import { t } from '../i18n'
import type { Guild, GuildSnapshot, GuildTemplate } from '../types'
import { parseSnapshot } from './snapshot'
import { STARTERS, buildSnapshot } from './starters'
import './templates.css'

export const templateLink = (code: string) => `${WEB_ORIGIN}/template/${code}`
/** A bare code or a template link (…/template/<code>). */
const codeOf = (v: string) => v.trim().split(/[/?#]/).filter(Boolean).pop() ?? ''
// a link on another host is a template link of the other chat app (fetched through the server); a code or our own link is ours
const isExternal = (v: string) => { try { return new URL(v.trim()).host !== new URL(WEB_ORIGIN).host } catch { return false } }

function download(name: string, data: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }))
  const a = Object.assign(document.createElement('a'), { href: url, download: `${name.replace(/[^\w.-]+/g, '_') || 'server'}.cillhub.json` })
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

const counts = (s: GuildSnapshot) => t('{roles} roles, {channels} channels', { roles: s.roles.length, channels: s.channels.length })

export function TemplatePage({ guild }: { guild: Guild }) {
  const [list, setList] = useState<GuildTemplate[] | null>(null)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  useEffect(() => void guildTemplates(guild.id).then(setList, (e: Error) => (setError(e.message), setList([]))), [guild.id])
  const tpl = list?.[0]
  const run = (p: Promise<unknown>) => (setError(''), p.catch((e: Error) => setError(e.message)))
  const create = (e: FormEvent) => (e.preventDefault(), void run(createTemplate(guild.id, name.trim(), description.trim()).then((x) => setList([x]))))
  const remove = (x: GuildTemplate) => void ask({ title: t('Delete Template'), body: <p>{t('Anyone with the link can no longer use it.')}</p>, confirm: t('Delete'), danger: true })
    .then((ok) => void (ok && run(deleteTemplate(guild.id, x.code).then(() => setList([])))))
  const copy = (x: GuildTemplate) => void navigator.clipboard.writeText(templateLink(x.code)).then(() => toast(t('Link copied.')), toastError)
  return (
    <>
      <h1>{t('Server Template')}</h1>
      <p className="hint">{t('A template copies roles, channels, categories, permissions and settings into a new server. Messages and members are not included.')}</p>
      {list === null ? <p className="hint" role="status">{t('Loading…')}</p> : tpl ? (
        <section className="template-card" aria-label={t('Template {name}', { name: tpl.name })}>
          <h2 className="sub-title">{tpl.name}</h2>
          {tpl.description && <p>{tpl.description}</p>}
          <div className="field">
            <label htmlFor="template-link">{t('Template Link')}</label>
            <div className="row-buttons">
              <input id="template-link" className="input grow" readOnly value={templateLink(tpl.code)} onFocus={(e) => e.target.select()} />
              <button className="primary" onClick={() => copy(tpl)}>{t('Copy')}</button>
            </div>
          </div>
          <p className="hint small">
            {t('Used {n} times', { n: tpl.usage_count ?? 0 })} · {t('Last synced {time}', { time: dateTime(tpl.updated_at) })} · {counts(tpl.serialized_source_guild)}
          </p>
          {tpl.is_dirty && <p className="notice">{t('This template has unsynced changes.')}</p>}
          <div className="row-buttons">
            <button className="secondary" onClick={() => void run(syncTemplate(guild.id, tpl.code).then((x) => (setList([x]), toast(t('Template synced.')))))}>{t('Sync Template')}</button>
            <button className="danger-btn" onClick={() => remove(tpl)}>{t('Delete Template')}</button>
          </div>
        </section>
      ) : (
        <form className="template-card" onSubmit={create}>
          <Field label={t('Template Title')} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
          <div className="field">
            <label htmlFor="template-desc">{t('Template Description')}</label>
            <textarea id="template-desc" className="input textarea" maxLength={120} value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <button className="primary" disabled={!name.trim()}>{t('Generate Template')}</button>
        </form>
      )}
      <FormError error={error} />
      <h2 className="sub-title top-gap">{t('Export Server')}</h2>
      <p className="hint">{t('Download the same snapshot as a JSON file, as a backup or to create a copy with "Create from file".')}</p>
      <button className="secondary" onClick={() => exportGuild(guild.id).then((f) => download(guild.name, f), toastError)}>{t('Export Server')}</button>
    </>
  )
}

/** "Add a server" → Create from template: a code or link, a preview, then a name. */
export function FromTemplateForm({ initialCode = '', onDone }: { initialCode?: string; onDone: () => void }) {
  const [code, setCode] = useState(initialCode)
  const [preview, setPreview] = useState<GuildTemplate | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const look = (c: string) => (isExternal(c) ? getExternalTemplate : getTemplate)(codeOf(c)).then((x) => (setPreview(x), setName(x.serialized_source_guild?.name ?? x.name)), (e: Error) => setError(e.message))
  useEffect(() => void (initialCode && look(initialCode)), [initialCode])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setError('')
    if (!preview) return void look(code)
    ;(preview.external ? importGuild(preview.serialized_source_guild, name.trim()) : createFromTemplate(preview.code, name.trim())).then(onDone, (err: Error) => setError(err.message))
  }
  return (
    <form onSubmit={submit}>
      <h3>{t('Create from template')}</h3>
      <Field label={t('Template link or code')} required value={code} placeholder={templateLink('hgM48av5Q69A')} onChange={(e) => (setCode(e.target.value), setPreview(null))} />
      <p className="hint small">{t('Template links from other chat apps work too; their channels, categories, roles and permissions are copied.')}</p>
      {preview && (
        <>
          <p className="template-preview" role="status"><strong>{preview.name}</strong>{preview.description ? ` · ${preview.description}` : ''} · {counts(preview.serialized_source_guild)}</p>
          <Field label={t('Server name')} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </>
      )}
      <button className="secondary">{preview ? t('Create Server') : t('Preview Template')}</button>
      <FormError error={error} />
    </form>
  )
}

/** "Add a server" → Start from a template: built-in layouts (starters.ts). */
export function StarterForm({ defaultName, onDone }: { defaultName: string; onDone: () => void }) {
  const [pick, setPick] = useState('')
  const [name, setName] = useState(defaultName)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const starter = STARTERS.find((s) => s.id === pick)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!starter || !name.trim()) return
    setBusy(true)
    importGuild(buildSnapshot(starter, name.trim()), name.trim()).then(onDone, (err: Error) => (setError(err.message), setBusy(false)))
  }
  return (
    <form onSubmit={submit}>
      <h3>{t('Start from a template')}</h3>
      <fieldset className="starter-list">
        <legend className="sr-only">{t('Template')}</legend>
        {STARTERS.map((s) => (
          <label key={s.id} className={`starter${pick === s.id ? ' selected' : ''}`}>
            <input type="radio" name="starter" value={s.id} checked={pick === s.id} onChange={() => setPick(s.id)} />
            <span className="starter-title">{t(s.title)}</span>
            <span className="starter-desc">{t(s.description)}</span>
          </label>
        ))}
      </fieldset>
      {starter && <Field label={t('Server name')} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />}
      <button className="primary" disabled={!starter || !name.trim() || busy}>{t('Use Template')}</button>
      <FormError error={error} />
    </form>
  )
}

/** "Add a server" → Create from file: imports an "Export server" JSON file. */
export function FromFileForm({ onDone }: { onDone: () => void }) {
  const [snap, setSnap] = useState<GuildSnapshot | null>(null)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const pick = (f?: File) => {
    setError('')
    setSnap(null)
    if (!f) return
    if (f.size > 2 * 1024 * 1024) return setError(t('Files must be {size} or smaller.', { size: '2 MB' }))
    f.text().then((txt) => { const s = parseSnapshot(txt); setSnap(s); setName(s.name) }).catch((e: Error) => setError(e.message))
  }
  return (
    <form onSubmit={(e) => (e.preventDefault(), snap && importGuild(snap, name.trim()).then(onDone, (err: Error) => setError(err.message)))}>
      <h3>{t('Create from file')}</h3>
      <div className="field">
        <label htmlFor="import-file">{t('Server export (.json)')}</label>
        <input id="import-file" type="file" accept="application/json,.json" className="input" onChange={(e) => pick(e.target.files?.[0])} />
      </div>
      {snap && (
        <>
          <p className="template-preview" role="status">{counts(snap)}</p>
          <Field label={t('Server name')} required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
        </>
      )}
      <button className="secondary" disabled={!snap || !name.trim()}>{t('Import Server')}</button>
      <FormError error={error} />
    </form>
  )
}
