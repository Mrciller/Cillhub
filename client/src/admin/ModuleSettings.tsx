// Settings of a module (CONTRACT-v8 §5): a form generated from `settings_schema`, global values and, with
// per_server_settings on, per-server values for the keys marked per_server. Channel and role pickers read the admin server
// detail (v6) of the chosen server. Secrets are never shown: only whether one is set, a field to replace it and Clear.
import { useEffect, useId, useState, type FormEvent } from 'react'
import { ask, toast, toastError } from '../components/dialogs'
import { FormError } from '../components/ui'
import { t } from '../i18n'
import * as A from './api'
import { useSearch } from './Users'
import { useLoad } from './util'

type Pick = { id: string; name: string }

/** Search over /admin/guilds; shows the chosen server with a Change button. `allowed` limits the results (module scope). */
export function GuildPick({ label, value, onChange, allowed }: { label: string; value: Pick | null; onChange: (g: Pick | null) => void; allowed?: string[] }) {
  const id = useId()
  const [text, query, setText] = useSearch()
  const { data } = useLoad(() => (value ? Promise.resolve([]) : A.listGuilds(query)), [query, !!value])
  if (value) return (
    <p className="module-pick">{label}: <strong>{value.name}</strong> <button className="link" onClick={() => onChange(null)}>{t('Change')}</button></p>
  )
  const list = (data ?? []).filter((g) => !allowed || allowed.includes(g.id))
  return (
    <div className="module-guild-search" role="search">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="search" className="input" placeholder={t('Search by server name')} value={text} onChange={(e) => setText(e.target.value)} />
      <ul className="admin-list" aria-label={t('Servers found')}>
        {list.map((g) => <li key={g.id}><button className="link" onClick={() => onChange({ id: g.id, name: g.name })}>{g.name}</button></li>)}
        {data && !list.length && <li className="hint">{t('No servers found.')}</li>}
      </ul>
    </div>
  )
}

const isSecretSet = (v: unknown) => !!(v && typeof v === 'object' && (v as { set?: boolean }).set)

/** Global values, or one server's values; the server's own section when `per_server_settings` is on. */
export function ModuleSettings({ m, onChange }: { m: A.AdminModule; onChange: (m: A.AdminModule) => void }) {
  const [server, setServer] = useState<Pick | null>(null)
  const perServerKeys = m.settings_schema.filter((s) => s.per_server)
  const togglePerServer = (on: boolean) => void A.patchModule(m.id, { per_server_settings: on }).then((r) => (setServer(null), onChange(r), toast(t('Saved.'))), toastError)
  if (!m.settings_schema.length) return <p className="hint">{t('This module has no settings.')}</p>
  return (
    <>
      {perServerKeys.length > 0 && (
        <label className="admin-check"><input type="checkbox" checked={m.per_server_settings} onChange={(e) => togglePerServer(e.target.checked)} /> {t('Allow different values per server')}</label>
      )}
      {m.per_server_settings && (
        <GuildPick label={t('Edit values for server')} value={server} onChange={setServer} allowed={m.scope === 'guilds' ? m.guild_ids : undefined} />
      )}
      {server ? (
        <GuildValues key={server.id} m={m} server={server} schema={perServerKeys} />
      ) : (
        <section aria-labelledby="global-h">
          <h3 id="global-h">{t('Values for all servers')}</h3>
          <SettingsForm key={m.updated_at + JSON.stringify(m.settings)} schema={m.settings_schema} values={m.settings} scope={m.scope === 'guilds' ? m.guild_ids : undefined}
            save={(values) => A.putModuleSettings(m.id, values).then(onChange)} />
        </section>
      )}
    </>
  )
}

function GuildValues({ m, server, schema }: { m: A.AdminModule; server: Pick; schema: A.SettingSchema[] }) {
  const { data, error, reload } = useLoad(() => A.getGuildSettings(m.id, server.id), [m.id, server.id])
  const reset = () => void ask({ title: t('Reset {name}?', { name: server.name }), body: <p>{t('This server uses the values for all servers again.')}</p>, confirm: t('Reset'), danger: true })
    .then((ok) => ok && A.resetGuildSettings(m.id, server.id).then(() => (toast(t('Reset.')), reload()), toastError))
  return (
    <section aria-labelledby="server-values-h">
      <h3 id="server-values-h">{t('Values for {name}', { name: server.name })}</h3>
      <p className="hint small">{t('Empty fields use the value for all servers.')}</p>
      <FormError error={error} />
      {data && <SettingsForm key={JSON.stringify(data.values)} schema={schema} values={data.values} guild={server} save={(values) => A.putGuildSettings(m.id, server.id, values).then(() => void reload())} />}
      <button className="secondary admin-btn" onClick={reset}>{t('Reset this server')}</button>
    </section>
  )
}

/** The generated form. Only changed keys are sent; an emptied field is sent as null (back to the default). */
function SettingsForm({ schema, values, guild, scope, save }: { schema: A.SettingSchema[]; values: A.SettingValues; guild?: Pick; scope?: string[]; save: (v: A.SettingValues) => Promise<unknown> }) {
  const [draft, setDraft] = useState<A.SettingValues>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (key: string, v: unknown) => setDraft((d) => ({ ...d, [key]: v }))
  const submit = (e: FormEvent) => {
    e.preventDefault()
    const out: A.SettingValues = {}
    for (const s of schema) {
      if (!(s.key in draft)) continue
      const v = draft[s.key]
      if (v === undefined) continue // a secret field typed into and emptied again: unchanged
      out[s.key] = v === '' ? null : s.type === 'number' ? Number(v) : v
    }
    if (!Object.keys(out).length) return toast(t('Nothing changed.'))
    setBusy(true)
    setError('')
    save(out).then(() => (setBusy(false), setDraft({}), toast(t('Saved.'))), (err: Error) => (setBusy(false), setError(err.message)))
  }
  return (
    <form className="admin-form module-settings" onSubmit={submit}>
      {schema.map((s) => (
        <SettingField key={s.key} s={s} value={s.key in draft ? draft[s.key] : values[s.key]} changed={s.key in draft} guild={guild} scope={scope} onChange={(v) => set(s.key, v)} />
      ))}
      <FormError error={error} />
      <div className="admin-actions">
        <button type="submit" className="primary admin-btn" disabled={busy}>{t('Save Settings')}</button>
        {Object.keys(draft).length > 0 && <button type="button" className="secondary admin-btn" onClick={() => setDraft({})}>{t('Undo Changes')}</button>}
      </div>
    </form>
  )
}

function SettingField({ s, value, changed, guild, scope, onChange }: { s: A.SettingSchema; value: unknown; changed: boolean; guild?: Pick; scope?: string[]; onChange: (v: unknown) => void }) {
  const id = useId()
  const hint = s.description ? <p id={id + 'd'} className="hint small">{s.description}</p> : null
  const described = s.description ? id + 'd' : undefined
  const label = <label htmlFor={id}>{s.label}{s.required && <span aria-hidden="true"> *</span>}</label>
  const str = value === null || value === undefined ? '' : String(value)
  const common = { id, 'aria-describedby': described, 'aria-required': s.required || undefined }
  switch (s.type) {
    case 'toggle':
      return <div className="field"><label className="admin-check"><input type="checkbox" {...common} checked={value === true} onChange={(e) => onChange(e.target.checked)} /> {s.label}</label>{hint}</div>
    case 'text':
      return (
        <div className="field">{label}
          {s.multiline
            ? <textarea {...common} className="input" rows={4} maxLength={s.max_length ?? 200} placeholder={s.placeholder} value={str} onChange={(e) => onChange(e.target.value)} />
            : <input {...common} className="input" maxLength={s.max_length ?? 200} placeholder={s.placeholder} value={str} onChange={(e) => onChange(e.target.value)} />}
          {hint}
        </div>
      )
    case 'number':
      return <div className="field">{label}<input {...common} type="number" className="input" min={s.min} max={s.max} step={s.integer ? 1 : 'any'} value={str} onChange={(e) => onChange(e.target.value)} />{hint}</div>
    case 'select':
      return (
        <div className="field">{label}
          <select {...common} className="input" value={str} onChange={(e) => onChange(e.target.value)}>
            <option value="">{t('Default')}</option>
            {s.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>{hint}
        </div>
      )
    case 'user':
      return <div className="field">{label}<input {...common} className="input" inputMode="numeric" pattern="\d+" placeholder={t('User ID')} value={str} onChange={(e) => onChange(e.target.value.trim())} />{hint}</div>
    case 'channel':
    case 'role':
      return <div className="field">{label}<ChannelRolePick id={id} s={s} value={str} guild={guild} scope={scope} onChange={onChange} />{hint}</div>
    case 'secret': {
      const set = changed ? value !== null && value !== '' : isSecretSet(value)
      return (
        <div className="field">{label}
          <p className="hint small" role="status">{changed && value === null ? t('Cleared when you save.') : set ? t('A value is set') : t('No value set')}</p>
          <input {...common} type="password" className="input" autoComplete="new-password" placeholder={t('New value')} maxLength={2000}
            value={changed && typeof value === 'string' ? value : ''} onChange={(e) => onChange(e.target.value || undefined)} />
          {isSecretSet(value) || (changed && value === null) ? (
            <button type="button" className="link" onClick={() => onChange(changed && value === null ? undefined : null)}>{changed && value === null ? t('Keep the current value') : t('Clear')}</button>
          ) : null}
          {hint}
        </div>
      )
    }
  }
}

/** A channel or role of a server: the given server (per-server values), or one picked first (global values). */
function ChannelRolePick({ id, s, value, guild, scope, onChange }: { id: string; s: A.SettingSchema; value: string; guild?: Pick; scope?: string[]; onChange: (v: unknown) => void }) {
  const [picked, setPicked] = useState<Pick | null>(guild ?? null)
  useEffect(() => setPicked(guild ?? null), [guild])
  const { data } = useLoad(() => (picked ? A.getGuild(picked.id) : Promise.resolve(null)), [picked?.id])
  const options = !data ? [] : s.type === 'role'
    ? [...data.roles].filter((r) => r.id !== data.id).sort((a, b) => b.position - a.position).map((r) => ({ id: r.id, name: '@' + r.name }))
    : data.channels.filter((c) => (s.channel_types ? s.channel_types.includes(c.type) : c.type !== 4)).map((c) => ({ id: c.id, name: '#' + c.name }))
  const known = !value || options.some((o) => o.id === value)
  return (
    <>
      {!guild && <GuildPick label={t('Server')} value={picked} onChange={setPicked} allowed={scope} />}
      {!known && <p className="hint small">{t('Current value: {id}', { id: value })}</p>}
      <select id={id} className="input" value={known ? value : ''} disabled={!data} onChange={(e) => onChange(e.target.value)}>
        <option value="">{data ? t('None') : t('Choose a server first')}</option>
        {options.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
    </>
  )
}
