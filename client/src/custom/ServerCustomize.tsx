// Server Settings → Customization (CONTRACT-v6 section 3): invite splash, accent colour, welcome background, greeting
// templates, entrance sounds, server tag, and the server's own avatar decorations.
import { useEffect, useState, type CSSProperties } from 'react'
import { getWelcomeScreen, patchGuild, saveWelcomeScreen } from '../actions'
import { api, cdn, dataUri } from '../api'
import { ask, toastError } from '../components/dialogs'
import { FormError } from '../components/ui'
import { t } from '../i18n'
import { has, P } from '../permissions'
import { usePerms } from '../selectors'
import { Switch } from '../settings/Layout'
import type { Guild, GuildDecoration, GuildTag, WelcomeScreen } from '../types'
import { ColorField } from './AppearanceV6'
import { contrast, HEX, onColor } from './color'
import { BADGES, decorationUrl, TagChip, tagOf } from './render'

export const splashUrl = (g: { id: string; splash?: string | null }) => (g.splash ? (g.splash.startsWith('data:') ? g.splash : cdn(`/splashes/${g.id}/${g.splash}.png`)) : null)
/** Welcome screen background (Cillhub extra on the welcome screen object): CDN /welcome-backgrounds/<guild_id>/<hash>. */
export const welcomeBgUrl = (guildId: string, ws?: WelcomeScreen | null) => (ws?.background ? (ws.background.startsWith('data:') ? ws.background : cdn(`/welcome-backgrounds/${guildId}/${ws.background}.png`)) : null)
export const MAX_GREETINGS = 10
/** --guild-accent and a readable text colour on it (buttons and strips coloured by the server's accent, brand_color_primary). */
export const accentVars = (hex?: string | null) => (!hex || !HEX.test(hex) ? undefined : ({ '--guild-accent': hex, '--on-guild-accent': onColor(hex) } as CSSProperties))
export const TAG_RE = /^[\p{L}\p{N}]{2,4}$/u

/** undefined = unchanged, null = removed, string = new data URI. */
function ImageField({ label, current, value, onChange, onError, hint }: { label: string; current: string | null; value: string | null | undefined; onChange: (v: string | null | undefined) => void; onError: (e: string) => void; hint: string }) {
  const shown = value === undefined ? current : value
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {shown && <span className="splash-thumb" style={{ backgroundImage: `url("${shown}")` }} role="img" aria-label={t('{what} preview', { what: label })} />}
      <div className="row-buttons">
        <label className="secondary file-btn">
          {t('Upload Image')}
          <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" aria-label={label}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) dataUri(f, 4 * 1024 * 1024, /^image\/(png|jpeg|webp)$/).then(onChange, (err: Error) => onError(err.message)); e.target.value = '' }} />
        </label>
        {shown && <button className="link" onClick={() => onChange(null)}>{t('Remove')}</button>}
      </div>
      <p className="hint small">{hint}</p>
    </div>
  )
}

function Looks({ guild }: { guild: Guild }) {
  const initial = { accent: guild.brand_color_primary ?? null, greetings: guild.greeting_templates ?? [], entrance: guild.entrance_sounds_enabled !== false }
  const [ws, setWs] = useState<WelcomeScreen | null>(null)
  useEffect(() => void getWelcomeScreen(guild.id).then(setWs, () => setWs(null)), [guild.id])
  const [draft, setDraft] = useState(initial)
  const [splash, setSplash] = useState<string | null | undefined>(undefined)
  const [header, setHeader] = useState<string | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || splash !== undefined || header !== undefined
  const set = (p: Partial<typeof draft>) => (setDraft({ ...draft, ...p }), setSaved(false))
  const badGreeting = draft.greetings.find((g) => !g.trim() || g.length > 200)
  const save = () => {
    setError('')
    if (badGreeting !== undefined) return setError(t('Greetings must be 1–200 characters.'))
    // accent: discovery guild profile (brand_color_primary); welcome background: the welcome screen; the rest: the guild
    Promise.all([
      patchGuild(guild.id, { greeting_templates: draft.greetings.map((g) => g.trim()), entrance_sounds_enabled: draft.entrance, ...(splash !== undefined && { splash }) }),
      draft.accent !== initial.accent && api(`/guilds/${guild.id}/profile`, { method: 'PATCH', body: { brand_color_primary: draft.accent } }),
      header !== undefined && saveWelcomeScreen(guild.id, { background: header }).then(setWs),
    ]).then(() => (setSplash(undefined), setHeader(undefined), setSaved(true)), (e: Error) => setError(e.message))
  }
  const accentHex = draft.accent
  return (
    <section className="settings-section">
      <h2>{t('Look')}</h2>
      <ImageField label={t('Invite background')} current={splashUrl(guild)} value={splash} onChange={(v) => (setSplash(v), setSaved(false))} onError={setError} hint={t('Shown behind the invite page. 16:9, at least 1920×1080 looks best.')} />
      <div className="field">
        <label className="inline-check"><input type="checkbox" checked={draft.accent !== null} onChange={(e) => set({ accent: e.target.checked ? '#3d7bff' : null })} /> {t('Server accent colour')}</label>
        {accentHex && <ColorField label={t('Accent colour')} value={accentHex} onChange={(h) => set({ accent: h })} />}
        {accentHex && contrast(accentHex, '#ffffff') < 3 && contrast(accentHex, '#000000') < 3 && <p className="notice" role="status">{t('This colour is hard to see on both dark and light backgrounds.')}</p>}
        <p className="hint small">{t('Used for the server header and the invite page.')}</p>
      </div>
      <ImageField label={t('Welcome screen background')} current={welcomeBgUrl(guild.id, ws)} value={header} onChange={(v) => (setHeader(v), setSaved(false))} onError={setError} hint={t('Shown behind the welcome screen new members see.')} />
      <fieldset className="plain field">
        <legend className="field-label">{t('Join message greetings')}</legend>
        <p className="hint small">{t('Up to {n}. {user} becomes the new member; one is picked at random for each join.', { n: MAX_GREETINGS, user: '{user}' })}</p>
        <ul className="greetings">
          {draft.greetings.map((g, i) => (
            <li key={i} className="row-buttons">
              <input className="input grow" aria-label={t('Greeting {n}', { n: i + 1 })} maxLength={200} value={g} onChange={(e) => set({ greetings: draft.greetings.with(i, e.target.value) })} />
              <button className="link danger-text" onClick={() => set({ greetings: draft.greetings.filter((_, j) => j !== i) })}>{t('Remove')}</button>
            </li>
          ))}
        </ul>
        {draft.greetings.length < MAX_GREETINGS && <button className="secondary" onClick={() => set({ greetings: [...draft.greetings, t('Welcome, {user}! Grab a seat.', { user: '{user}' })] })}>{t('Add greeting')}</button>}
        {draft.greetings[0] && <p className="hint small greeting-preview">{t('Preview: {text}', { text: draft.greetings[0].replace(/\{user\}/g, 'Ciller') })}</p>}
      </fieldset>
      <Switch label={t('Entrance sounds')} note={t('Members with soundboard access can play a sound when they join a voice channel.')} checked={draft.entrance} onChange={(v) => set({ entrance: v })} />
      <FormError error={error} />
      <div className="save-bar">
        {saved && !dirty && <span className="success" role="status">{t('Saved.')}</span>}
        <button className="link" disabled={!dirty} onClick={() => (setDraft(initial), setSplash(undefined), setHeader(undefined))}>{t('Reset')}</button>
        <button className="primary" disabled={!dirty} onClick={save}>{t('Save Changes')}</button>
      </div>
    </section>
  )
}

function TagEditor({ guild }: { guild: Guild }) {
  const initial: GuildTag = tagOf(guild) ?? { tag: '', badge: 0, badge_color_primary: '#3d7bff', badge_color_secondary: '#00d4ff' }
  const [tag, setTag] = useState<GuildTag>(initial)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const set = (p: Partial<GuildTag>) => (setTag({ ...tag, ...p }), setSaved(false))
  const save = (next: GuildTag | null) => {
    setError('')
    if (next && !TAG_RE.test(next.tag ?? '')) return setError(t('A tag has 2 to 4 letters or numbers.'))
    const body = next ?? { tag: null, badge: 0, badge_color_primary: tag.badge_color_primary, badge_color_secondary: tag.badge_color_secondary }
    api<GuildTag>(`/guilds/${guild.id}/profile`, { method: 'PATCH', body }).then(
      () => setSaved(true), // the server sends GUILD_UPDATE with the new profile
      (e: Error) => setError(e.message),
    )
  }
  return (
    <section className="settings-section">
      <h2>{t('Server tag')}</h2>
      <p className="hint small">{t('Members can show this tag next to their name everywhere (User Settings → Profiles).')}</p>
      <div className="row-fields">
        <div className="field">
          <label htmlFor="tag-text">{t('Tag')}</label>
          <input id="tag-text" className="input tag-input" maxLength={4} value={tag.tag ?? ''} onChange={(e) => set({ tag: e.target.value.toUpperCase() })} aria-describedby="tag-rule" />
          <p id="tag-rule" className="hint small">{t('2 to 4 letters or numbers.')}</p>
        </div>
        <div className="field grow"><span className="field-label">{t('Preview')}</span>{tag.tag ? <TagChip tag={tag} /> : <span className="hint">—</span>}</div>
      </div>
      <fieldset className="plain">
        <legend className="field-label">{t('Badge')}</legend>
        <div className="badge-grid">
          {BADGES.map(([name, d], i) => (
            <label key={name} className={tag.badge === i ? 'badge-pick on' : 'badge-pick'} title={t(name)}>
              <input type="radio" name="tag-badge" className="sr-only" checked={tag.badge === i} onChange={() => set({ badge: i })} />
              <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d={d} fill={tag.badge_color_primary} /></svg>
              <span className="sr-only">{t(name)}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="color-grid">
        <ColorField label={t('Badge colour')} value={tag.badge_color_primary} onChange={(c) => set({ badge_color_primary: c })} />
        <ColorField label={t('Badge second colour')} value={tag.badge_color_secondary} onChange={(c) => set({ badge_color_secondary: c })} />
      </div>
      <FormError error={error} />
      <div className="save-bar">
        {saved && <span className="success" role="status">{t('Saved.')}</span>}
        {guild.profile?.tag && <button className="link danger-text" onClick={() => void ask({ title: t('Remove server tag?'), body: <p>{t('Members showing it will no longer have a tag.')}</p>, confirm: t('Remove'), danger: true }).then((ok) => ok && save(null))}>{t('Remove tag')}</button>}
        <button className="primary" onClick={() => save(tag)}>{t('Save Tag')}</button>
      </div>
    </section>
  )
}

function Decorations({ guild }: { guild: Guild }) {
  const [list, setList] = useState<GuildDecoration[] | null>(null)
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  useEffect(() => void api<GuildDecoration[]>(`/guilds/${guild.id}/avatar-decorations`).then((l) => setList(Array.isArray(l) ? l : []), () => setList([])), [guild.id])
  const upload = () => {
    if (!file || !name.trim()) return
    setError('')
    dataUri(file, 512 * 1024, /^image\/(png|webp|apng)$/)
      .then((image) => api<GuildDecoration>(`/guilds/${guild.id}/avatar-decorations`, { method: 'POST', body: { name: name.trim().slice(0, 32), image } }))
      .then((d) => (setList([...(list ?? []), d]), setName(''), setFile(null)), (e: Error) => setError(e.message))
  }
  return (
    <section className="settings-section">
      <h2>{t('Avatar decorations')}</h2>
      <p className="hint small">{t('Frames your members can put around their avatar. APNG or WebP with a transparent middle, square, up to 512 KB.')}</p>
      <ul className="deco-list">
        {(list ?? []).map((d) => (
          <li key={d.id} className="row-buttons">
            <img src={decorationUrl(d.asset)} alt="" width={48} height={48} />
            <span className="grow ellipsis">{d.name}</span>
            <button className="link danger-text" onClick={() => void api(`/guilds/${guild.id}/avatar-decorations/${d.id}`, { method: 'DELETE' }).then(() => setList((list ?? []).filter((x) => x.id !== d.id)), toastError)}>{t('Delete')}</button>
          </li>
        ))}
      </ul>
      <div className="row-buttons">
        <input className="input grow" aria-label={t('Decoration name')} placeholder={t('Decoration name')} maxLength={32} value={name} onChange={(e) => setName(e.target.value)} />
        <label className="secondary file-btn">
          {file ? file.name : t('Choose File')}
          <input type="file" accept="image/png,image/apng,image/webp" className="sr-only" aria-label={t('Decoration image')} onChange={(e) => (setFile(e.target.files?.[0] ?? null), (e.target.value = ''))} />
        </label>
        <button className="primary" disabled={!file || !name.trim()} onClick={upload}>{t('Upload')}</button>
      </div>
      <FormError error={error} />
    </section>
  )
}

export function ServerCustomizePage({ guild }: { guild: Guild }) {
  const perms = usePerms(guild.id)
  const manage = has(perms, P.MANAGE_GUILD)
  return (
    <>
      <h1>{t('Customization')}</h1>
      {manage && <Looks guild={guild} />}
      {manage && <TagEditor guild={guild} />}
      {has(perms, P.MANAGE_GUILD_EXPRESSIONS) && <Decorations guild={guild} />}
    </>
  )
}
