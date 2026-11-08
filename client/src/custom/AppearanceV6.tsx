// User Settings → Appearance (v6): theme editor with presets and share codes, chat look, custom CSS with Safe mode.
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { patchSettings } from '../actions'
import { api, dataUri } from '../api'
import { toast } from '../components/dialogs'
import { cls, FormError } from '../components/ui'
import { t } from '../i18n'
import { Switch } from '../settings/Layout'
import { useStore } from '../store'
import type { ChatFont, CustomTheme, UserSettings } from '../types'
import { activeTheme, chatBackgroundUrl, FONT_STACKS, previewTheme } from './apply'
import { HEX } from './color'
import { MAX_CSS, onSafeMode, safeMode, sanitizeCss, setSafeMode } from './css'
import { contrastIssues, decodeTheme, encodeTheme, MAX_THEMES, PRESETS, themeVars, validTheme } from './themes'

const set = (p: UserSettings) => void patchSettings(p)
const newId = () => `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** A colour picker with a hex text field (both labelled; the text field accepts #rrggbb only). */
export function ColorField({ label, value, onChange }: { label: string; value: string; onChange: (hex: string) => void }) {
  const id = useId()
  const [text, setText] = useState(value)
  useEffect(() => setText(value), [value])
  return (
    <div className="field color-field">
      <label htmlFor={`${id}-hex`}>{label}</label>
      <div className="row-buttons">
        <input type="color" aria-label={t('{label} picker', { label })} value={value} onChange={(e) => onChange(e.target.value)} />
        <input id={`${id}-hex`} className="input hex-input" value={text} maxLength={7} spellCheck={false} aria-invalid={!HEX.test(text) || undefined}
          onChange={(e) => (setText(e.target.value), HEX.test(e.target.value) && onChange(e.target.value.toLowerCase()))} />
      </div>
    </div>
  )
}

function ThemeCard({ theme, on, onPick }: { theme: CustomTheme; on: boolean; onPick: () => void }) {
  const v = themeVars(theme)
  return (
    <label className={cls('theme-card', on && 'on')}>
      <input type="radio" name="custom-theme" checked={on} onChange={onPick} />
      <span className="theme-card-art" aria-hidden="true" style={{ background: v['--app-bg'] }}>
        <i style={{ background: v['--sidebar'] }} /><b style={{ background: v['--accent'] }} /><em style={{ color: v['--text'] }}>Aa</em>
      </span>
      <span className="theme-card-name">{t(theme.name)}</span>
    </label>
  )
}

export function ThemeSection() {
  const s = useStore((x) => x.settings)
  const own = s.custom_themes ?? []
  const active = s.active_theme ?? null
  const [draft, setDraft] = useState<CustomTheme | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  useEffect(() => () => previewTheme(null), [])
  const edit = (t: CustomTheme | null) => (setDraft(t), previewTheme(t), setError(''))
  const start = () => edit({ ...(activeTheme(s) ?? PRESETS[0]), id: newId(), name: t('My theme') })
  const save = () => {
    if (!draft || !validTheme(draft)) return setError(t('Use #rrggbb colours and a name of 1–32 characters.'))
    const exists = own.some((x) => x.id === draft.id)
    if (!exists && own.length >= MAX_THEMES) return setError(t('You can save up to {n} themes.', { n: MAX_THEMES }))
    set({ custom_themes: exists ? own.map((x) => (x.id === draft.id ? draft : x)) : [...own, draft], active_theme: draft.id })
    edit(null)
  }
  const remove = (id: string) => (set({ custom_themes: own.filter((x) => x.id !== id), ...(active === id && { active_theme: null }) }), edit(null))
  const importCode = () => {
    const th = decodeTheme(code)
    if (!th) return setError(t('That is not a valid theme code.'))
    if (own.length >= MAX_THEMES) return setError(t('You can save up to {n} themes.', { n: MAX_THEMES }))
    const theme = { ...th, id: newId() }
    set({ custom_themes: [...own, theme], active_theme: theme.id })
    setCode('')
    setError('')
    toast(t('Imported the theme {name}.', { name: theme.name }))
  }
  const share = (th: CustomTheme) => void navigator.clipboard?.writeText(encodeTheme(th)).then(() => toast(t('Theme code copied.')), () => toast(encodeTheme(th)))
  const issues = draft ? contrastIssues(draft) : []
  const vars = draft ? themeVars(draft) : null
  return (
    <section className="settings-section" aria-labelledby="ct-title">
      <h2 id="ct-title">{t('Custom Themes')}</h2>
      <fieldset className="theme-grid plain">
        <legend className="sr-only">{t('Theme')}</legend>
        <label className={cls('theme-card', !active && 'on')}>
          <input type="radio" name="custom-theme" checked={!active} onChange={() => set({ active_theme: null })} />
          <span className="theme-card-art builtin" aria-hidden="true" />
          <span className="theme-card-name">{t('Built-in theme')}</span>
        </label>
        {PRESETS.map((p) => <ThemeCard key={p.id} theme={p} on={active === p.id} onPick={() => set({ active_theme: p.id })} />)}
        {own.map((p) => <ThemeCard key={p.id} theme={p} on={active === p.id} onPick={() => set({ active_theme: p.id })} />)}
      </fieldset>
      {own.length > 0 && (
        <ul className="own-themes" aria-label={t('Your themes')}>
          {own.map((th) => (
            <li key={th.id} className="row-buttons">
              <span className="grow ellipsis">{th.name}</span>
              <button className="link" onClick={() => edit(th)}>{t('Edit')}</button>
              <button className="link" onClick={() => share(th)}>{t('Share')}</button>
              <button className="link danger-text" onClick={() => remove(th.id)}>{t('Delete')}</button>
            </li>
          ))}
        </ul>
      )}
      {!draft && (
        <div className="row-buttons top-gap">
          <button className="primary" onClick={start} disabled={own.length >= MAX_THEMES}>{t('Create Theme')}</button>
          <input className="input grow theme-code" aria-label={t('Theme code')} placeholder={t('Paste a theme code (CT1.…)')} value={code} onChange={(e) => setCode(e.target.value)} />
          <button className="secondary" disabled={!code.trim()} onClick={importCode}>{t('Import')}</button>
        </div>
      )}
      {draft && vars && (
        <div className="theme-editor" role="group" aria-label={t('Theme editor')}>
          <div className="field"><label htmlFor="ct-name">{t('Theme name')}</label><input id="ct-name" className="input" maxLength={32} value={draft.name} onChange={(e) => edit({ ...draft, name: e.target.value })} /></div>
          <div className="color-grid">
            <ColorField label={t('Background')} value={draft.background} onChange={(c) => edit({ ...draft, background: c })} />
            <ColorField label={t('Surface')} value={draft.surface} onChange={(c) => edit({ ...draft, surface: c })} />
            <ColorField label={t('Accent')} value={draft.accent} onChange={(c) => edit({ ...draft, accent: c })} />
            <ColorField label={t('Text')} value={draft.text} onChange={(c) => edit({ ...draft, text: c })} />
          </div>
          <Switch label={t('Gradient background')} note={t('Two colours blended behind the app.')} checked={!!draft.gradient} onChange={(v) => edit({ ...draft, gradient: v ? [draft.background, draft.accent] : null })} />
          {draft.gradient && (
            <div className="color-grid">
              <ColorField label={t('Gradient start')} value={draft.gradient[0]} onChange={(c) => edit({ ...draft, gradient: [c, draft.gradient![1]] })} />
              <ColorField label={t('Gradient end')} value={draft.gradient[1]} onChange={(c) => edit({ ...draft, gradient: [draft.gradient![0], c] })} />
            </div>
          )}
          <div className="theme-live" style={{ background: vars['--app-bg'] }} aria-label={t('Preview')} role="img">
            <div style={{ background: vars['--chat'], color: vars['--text'] }}>
              <strong style={{ color: vars['--header'] }}>{t('Cillhub')}</strong> <span style={{ color: vars['--muted'] }}>{t('Today at 20:15')}</span>
              <p>{t('GG! Same lobby tonight?')}</p>
              <span className="theme-live-btn" style={{ background: vars['--accent'], color: vars['--on-accent'] }}>{t('Join')}</span>
            </div>
          </div>
          <div aria-live="polite">
            {issues.length > 0 && (
              <div className="notice contrast-warning" role="status">
                <strong>{t('Low contrast')}</strong>
                <ul>{issues.map((i) => <li key={i.what}>{t('{what}: {ratio}:1 (needs {need}:1)', { what: t(i.what), ratio: i.ratio.toFixed(2), need: i.need })}</li>)}</ul>
                <p className="small">{t('Cillhub uses {color} for text instead so everything stays readable.', { color: vars['--text'] })}</p>
              </div>
            )}
          </div>
          <FormError error={error} />
          <div className="save-bar">
            <button className="link" onClick={() => edit(null)}>{t('Cancel')}</button>
            <button className="secondary" onClick={() => share(draft)}>{t('Copy Code')}</button>
            <button className="primary" onClick={save}>{t('Save Theme')}</button>
          </div>
        </div>
      )}
      {!draft && <FormError error={error} />}
    </section>
  )
}

const FONTS: [ChatFont, string][] = [['system', 'System default'], ['inter', 'Inter'], ['jetbrains-mono', 'JetBrains Mono'], ['opendyslexic', 'OpenDyslexic']]
/** Skin tone order: none, light … dark (Fitzpatrick modifiers U+1F3FB–U+1F3FF). */
export const TONES = ['', '\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}']
const TONE_NAMES = ['No skin tone', 'Light skin tone', 'Medium-light skin tone', 'Medium skin tone', 'Medium-dark skin tone', 'Dark skin tone']
/** Applies the default skin tone to an emoji that supports one. */
export function skin(char: string, tone = 0) {
  if (!tone || !TONES[tone]) return char
  const [first, ...rest] = Array.from(char)
  return /\p{Emoji_Modifier_Base}/u.test(first) ? first + TONES[tone] + rest.filter((c) => c !== '️').join('') : char
}

export function ChatSection() {
  const s = useStore((x) => x.settings)
  const [error, setError] = useState('')
  const bg = chatBackgroundUrl(s.chat_background)
  return (
    <section className="settings-section" aria-labelledby="chat-look">
      <h2 id="chat-look">{t('Chat')}</h2>
      <fieldset className="choice block font-choice">
        <legend>{t('Chat font')}</legend>
        {FONTS.map(([id, label]) => (
          <label key={id} className={cls('radio-card', (s.chat_font ?? 'system') === id && 'on')} style={{ fontFamily: FONT_STACKS[id] }}>
            <input type="radio" name="chat-font" checked={(s.chat_font ?? 'system') === id} onChange={() => set({ chat_font: id })} /> {t(label)} <span className="hint small">{t('The quick brown fox')}</span>
          </label>
        ))}
      </fieldset>
      <div className="field range-field">
        <label htmlFor="chat-lh">{t('Line height')} <span className="hint">{(s.chat_line_height ?? 1.375).toFixed(2)}</span></label>
        <input id="chat-lh" type="range" min={1.2} max={2} step={0.05} value={s.chat_line_height ?? 1.375} onChange={(e) => set({ chat_line_height: +e.target.value })} />
      </div>
      <div className="field range-field">
        <label htmlFor="msg-space">{t('Space between message groups')} <span className="hint">{s.message_spacing ?? 16}px</span></label>
        <input id="msg-space" type="range" min={0} max={24} step={2} value={s.message_spacing ?? 16} onChange={(e) => set({ message_spacing: +e.target.value })} />
      </div>
      <Switch label={t('Show avatars')} checked={s.show_avatars !== false} onChange={(v) => set({ show_avatars: v })} />
      <Switch label={t('Show timestamps')} note={t('Times stay available to screen readers.')} checked={s.show_timestamps !== false} onChange={(v) => set({ show_timestamps: v })} />
      <fieldset className="choice block">
        <legend>{t('Default skin tone')}</legend>
        <div className="row-buttons tones">
          {TONES.map((_, i) => (
            <label key={i} className={cls('tone', (s.default_emoji_skin_tone ?? 0) === i && 'on')} title={t(TONE_NAMES[i])}>
              <input type="radio" name="skin-tone" className="sr-only" checked={(s.default_emoji_skin_tone ?? 0) === i} onChange={() => set({ default_emoji_skin_tone: i })} />
              <span aria-hidden="true">{skin('👋', i)}</span><span className="sr-only">{t(TONE_NAMES[i])}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <span className="field-label">{t('Chat background')}</span>
        <div className="row-buttons">
          {bg && <span className="chat-bg-thumb" style={{ backgroundImage: `url("${bg}")` }} aria-hidden="true" />}
          <label className="secondary file-btn">
            {t('Upload Image')}
            <input type="file" accept="image/png,image/jpeg,image/webp" className="sr-only"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) dataUri(f, 2 * 1024 * 1024, /^image\/(png|jpeg|webp)$/).then((image) => api('/users/@me/chat-background', { method: 'PUT', body: { image } })).then(() => setError(''), (err: Error) => setError(err.message)); e.target.value = '' }} />
          </label>
          {bg && <button className="link" onClick={() => void api('/users/@me/chat-background', { method: 'DELETE' }).catch((err: Error) => setError(err.message))}>{t('Remove')}</button>}
        </div>
        <FormError error={error} />
      </div>
      {bg && (
        <div className="field range-field">
          <label htmlFor="bg-op">{t('Background visibility')} <span className="hint">{s.chat_background_opacity ?? 30}%</span></label>
          <input id="bg-op" type="range" min={5} max={60} step={5} value={s.chat_background_opacity ?? 30} onChange={(e) => set({ chat_background_opacity: +e.target.value })} />
          <p className="hint small">{t('Kept dim so messages stay readable.')}</p>
        </div>
      )}
    </section>
  )
}

const useSafe = () => useSyncExternalStore(onSafeMode, safeMode)
export function CustomCssSection() {
  const s = useStore((x) => x.settings)
  const safe = useSafe()
  const [css, setCss] = useState(s.custom_css ?? '')
  const bytes = new TextEncoder().encode(css).length
  const removed = css && sanitizeCss(css) !== css.replace(/\/\*[\s\S]*?\*\//g, '')
  return (
    <section className="settings-section" aria-labelledby="css-title">
      <h2 id="css-title">{t('Custom CSS (advanced)')}</h2>
      <p className="notice">{t('Only for your own client. Bad CSS can hide parts of the app: hold Shift while Cillhub loads, or open it with ?safe=1, to start without it. @import, external url() and scripts are removed.')}</p>
      {safe && (
        <p className="notice" role="status">{t('Safe mode is on: custom CSS is off for this visit.')} <button className="link" onClick={() => setSafeMode(false)}>{t('Leave safe mode')}</button></p>
      )}
      <Switch label={t('Enable custom CSS')} checked={!!s.custom_css_enabled} onChange={(v) => set({ custom_css_enabled: v })} />
      <div className="field">
        <label htmlFor="custom-css">{t('Your CSS')}</label>
        <textarea id="custom-css" className="input textarea code-input" rows={8} spellCheck={false} value={css} onChange={(e) => setCss(e.target.value)} aria-describedby="css-size" />
        <p id="css-size" className={cls('hint small', bytes > MAX_CSS && 'danger-text')}>{t('{used} of {max} KB', { used: (bytes / 1024).toFixed(1), max: MAX_CSS / 1024 })}{removed ? ` · ${t('Some rules will be removed for safety.')}` : ''}</p>
      </div>
      <div className="save-bar">
        <button className="link" disabled={css === (s.custom_css ?? '')} onClick={() => setCss(s.custom_css ?? '')}>{t('Reset')}</button>
        <button className="primary" disabled={bytes > MAX_CSS || css === (s.custom_css ?? '')} onClick={() => set({ custom_css: css })}>{t('Save CSS')}</button>
      </div>
    </section>
  )
}
