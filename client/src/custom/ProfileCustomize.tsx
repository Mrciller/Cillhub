// User Settings → Profiles (v6): profile theme, display name style, avatar decoration, profile effect, nameplate,
// widgets and the displayed server tag. Edits a draft that the profile preview shows live; saved with the profile.
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react'
import { api } from '../api'
import { toastError } from '../components/dialogs'
import { cls } from '../components/ui'
import { t } from '../i18n'
import { apply, getState, useStore } from '../store'
import type { GuildDecoration, NameStyle, ProfileWidget, SocialPlatform, User } from '../types'
import { ColorField } from './AppearanceV6'
import { toHex, toInt } from './color'
import { DECORATIONS, decorationUrl, EFFECTS, isBuiltin, NAME_EFFECTS, NAME_FONTS, nameProps, NAMEPLATES, tagOf, TagChip, textColor } from './render'
import { MAX_WIDGETS, platformOf } from './Widgets'

export type ProfileDraft = {
  theme_colors: [number, number] | null; style: NameStyle | null; decoration: { sku_id: string; asset: string } | null
  nameplate: string | null; effect: string | null; widgets: ProfileWidget[]
}
export const draftOf = (u: User): ProfileDraft => ({
  theme_colors: u.theme_colors ?? null, style: u.display_name_styles ?? null, decoration: u.avatar_decoration_data ? { sku_id: isBuiltin(u.avatar_decoration_data) ? u.avatar_decoration_data.asset : u.avatar_decoration_data.sku_id, asset: u.avatar_decoration_data.asset } : null,
  nameplate: u.collectibles?.nameplate?.asset ?? null, effect: u.profile_effect?.id ?? null, widgets: u.widgets ?? [],
})
/** PATCH /users/@me fields (user docs names; widgets is Cillhub's). */
export const draftPatch = (d: ProfileDraft) => ({
  theme_colors: d.theme_colors, display_name_font_id: d.style?.font_id ?? null, display_name_effect_id: d.style?.effect_id ?? null, display_name_colors: d.style?.colors ?? null,
  avatar_decoration_sku_id: d.decoration?.sku_id ?? null, nameplate_sku_id: d.nameplate, profile_effect_id: d.effect, widgets: d.widgets,
})
/** The user as others would see them with the draft applied (for the preview card). */
export const previewUser = (u: User, d: ProfileDraft): User => ({
  ...u, theme_colors: d.theme_colors, display_name_styles: d.style, avatar_decoration_data: d.decoration && { ...d.decoration, expires_at: null },
  collectibles: { nameplate: d.nameplate ? { sku_id: d.nameplate, asset: d.nameplate } : null }, profile_effect: d.effect ? { id: d.effect } : null, widgets: d.widgets,
})
export const widgetsValid = (w: ProfileWidget[]) => w.every((x) => x.type !== 'socials' || (x.links.length > 0 && x.links.every((l) => !!l.platform) && new Set(x.links.map((l) => l.platform)).size === x.links.length))
/** Socials as typed (one link per line) → the server's [{platform, url}]; links that are not allowed get no platform. */
const parseLinks = (text: string) => text.split('\n').map((x) => x.trim()).filter(Boolean).slice(0, 7).map((url) => ({ platform: (platformOf(url) ?? '') as SocialPlatform, url }))

/** Font, effect and colours of a display name (also used per server). */
export function NameStyleEditor({ value, onChange, name }: { value: NameStyle | null; onChange: (v: NameStyle | null) => void; name: string }) {
  const v = value ?? { font_id: 11, effect_id: 1, colors: [] }
  const fill = (effect: number, cur: number[]) => Array.from({ length: NAME_EFFECTS.find((e) => e[0] === effect)?.[2] ?? 1 }, (_, i) => cur[i] ?? [0x00d4ff, 0xff4fa3][i] ?? 0xffffff)
  const colors = fill(v.effect_id, v.colors)
  const set = (p: Partial<NameStyle>) => onChange({ ...v, ...p, colors: fill(p.effect_id ?? v.effect_id, p.colors ?? colors) })
  const shown = nameProps(v.font_id, v.effect_id, value?.colors.length ? colors.map(textColor) : [])
  return (
    <fieldset className="plain name-style">
      <legend className="field-label">{t('Display name style')}</legend>
      <p className="name-style-preview" aria-hidden="true"><span {...shown}>{name}</span></p>
      <div className="row-fields">
        <div className="field grow">
          <label htmlFor="ns-font">{t('Font')}</label>
          <select id="ns-font" className="input" value={v.font_id} onChange={(e) => set({ font_id: +e.target.value })}>{NAME_FONTS.map(([id, l]) => <option key={id} value={id}>{t(l)}</option>)}</select>
        </div>
        <div className="field grow">
          <label htmlFor="ns-effect">{t('Effect')}</label>
          <select id="ns-effect" className="input" value={value?.colors.length ? v.effect_id : 0} onChange={(e) => (+e.target.value ? set({ effect_id: +e.target.value }) : onChange(v.font_id !== 11 ? { ...v, effect_id: 1, colors: [] } : null))}>
            <option value={0}>{t('None (role or default colour)')}</option>
            {NAME_EFFECTS.map(([id, l]) => <option key={id} value={id}>{t(l)}</option>)}
          </select>
        </div>
      </div>
      {!!value?.colors.length && <div className="color-grid">{colors.map((c, i) => <ColorField key={i} label={t('Colour {n}', { n: i + 1 })} value={toHex(c)} onChange={(h) => set({ colors: colors.with(i, toInt(h)) })} />)}</div>}
      <p className="hint small">{t('Animated effects stay still when reduced motion is on. Colours are adjusted for readability on each theme.')}</p>
    </fieldset>
  )
}

function useGuildDecorations() {
  const guilds = useStore((s) => s.guilds)
  const [list, setList] = useState<GuildDecoration[]>([])
  useEffect(() => {
    let live = true
    Promise.all(Object.keys(guilds).map((id) => api<GuildDecoration[]>(`/guilds/${id}/avatar-decorations`).then((l) => (Array.isArray(l) ? l.map((x) => ({ ...x, guild_id: id })) : []), () => [])))
      .then((all) => live && setList(all.flat()))
    return () => void (live = false)
  }, [Object.keys(guilds).join()])
  return list
}

/** Radio grid of choices with a "None" first. */
function Choices<T extends string>({ legend, value, onChange, items }: { legend: string; value: T | null; onChange: (v: T | null) => void; items: { id: T; label: string; art: ReactNode }[] }) {
  const name = legend.replace(/\W/g, '')
  return (
    <fieldset className="plain choice-grid">
      <legend className="field-label">{legend}</legend>
      <label className={cls('choice-tile', !value && 'on')}><input type="radio" name={name} checked={!value} onChange={() => onChange(null)} /><span className="choice-art none" aria-hidden="true" />{t('None')}</label>
      {items.map((i) => (
        <label key={i.id} className={cls('choice-tile', value === i.id && 'on')}>
          <input type="radio" name={name} checked={value === i.id} onChange={() => onChange(i.id)} />
          <span className="choice-art" aria-hidden="true">{i.art}</span>{i.label}
        </label>
      ))}
    </fieldset>
  )
}

function WidgetEditor({ value, onChange }: { value: ProfileWidget[]; onChange: (v: ProfileWidget[]) => void }) {
  const game = useStore((s) => s.game?.name ?? '')
  const set = (i: number, w: ProfileWidget) => onChange(value.with(i, w))
  return (
    <fieldset className="plain widgets-edit">
      <legend className="field-label">{t('Profile widgets')}</legend>
      {value.map((w, i) => (
        <div key={i} className="widget-edit">
          {w.type === 'main_game' && <div className="field"><label htmlFor={`wg-${i}`}>{t('Main game')}</label><input id={`wg-${i}`} className="input" maxLength={64} value={w.game} placeholder={game} onChange={(e) => set(i, { ...w, game: e.target.value })} /></div>}
          {w.type === 'rank' && (
            <div className="row-fields">
              <div className="field grow"><label htmlFor={`wrg-${i}`}>{t('Game')}</label><input id={`wrg-${i}`} className="input" maxLength={64} value={w.game} onChange={(e) => set(i, { ...w, game: e.target.value })} /></div>
              <div className="field grow"><label htmlFor={`wr-${i}`}>{t('Rank')}</label><input id={`wr-${i}`} className="input" maxLength={32} value={w.rank} onChange={(e) => set(i, { ...w, rank: e.target.value })} /></div>
            </div>
          )}
          {w.type === 'socials' && (
            <div className="field">
              <label htmlFor={`ws-${i}`}>{t('Social links (one per line)')}</label>
              <textarea id={`ws-${i}`} className="input textarea" rows={3} value={w.links.map((l) => l.url).join('\n')} aria-describedby={`ws-${i}-h`} onChange={(e) => set(i, { ...w, links: parseLinks(e.target.value) })} />
              <p id={`ws-${i}-h`} className="hint small">{t('https links to Twitch, YouTube, X, Instagram, TikTok, Steam or FACEIT.')}</p>
              {w.links.filter((l) => !l.platform).map((l) => <p key={l.url} className="form-error" role="alert">{t('Not an allowed link: {link}', { link: l.url })}</p>)}
              {new Set(w.links.map((l) => l.platform)).size < w.links.length && w.links.every((l) => l.platform) && <p className="form-error" role="alert">{t('One link per platform.')}</p>}
            </div>
          )}
          <button type="button" className="link danger-text" onClick={() => onChange(value.filter((_, j) => j !== i))}>{t('Remove widget')}</button>
        </div>
      ))}
      {value.length < MAX_WIDGETS && (
        <div className="row-buttons">
          {!value.some((w) => w.type === 'main_game') && <button type="button" className="secondary" onClick={() => onChange([...value, { type: 'main_game', game }])}>{t('Add main game')}</button>}
          {!value.some((w) => w.type === 'socials') && <button type="button" className="secondary" onClick={() => onChange([...value, { type: 'socials', links: [] }])}>{t('Add socials')}</button>}
          {!value.some((w) => w.type === 'rank') && <button type="button" className="secondary" onClick={() => onChange([...value, { type: 'rank', game: '', rank: '' }])}>{t('Add rank')}</button>}
        </div>
      )}
    </fieldset>
  )
}

/** Chooses which server's tag is shown next to your name (PUT /users/@me/clan, saved at once). */
function TagPicker() {
  const me = useStore((s) => s.me)!
  const guilds = useStore((s) => s.guilds)
  const withTags = Object.values(guilds).filter((g) => tagOf(g))
  const current = me.primary_guild?.identity_enabled !== false ? me.primary_guild?.identity_guild_id ?? '' : ''
  const choose = (id: string) =>
    void api<User>('/users/@me/clan', { method: 'PUT', body: { identity_guild_id: id || null, identity_enabled: !!id } })
      .then((u) => apply('USER_UPDATE', u), toastError)
  return (
    <div className="field">
      <label htmlFor="tag-pick">{t('Server tag')}</label>
      <div className="row-buttons">
        <select id="tag-pick" className="input grow" value={current} onChange={(e) => choose(e.target.value)}>
          <option value="">{t('Do not show a tag')}</option>
          {withTags.map((g) => <option key={g.id} value={g.id}>{g.profile!.tag} · {g.name}</option>)}
        </select>
        {current && tagOf(guilds[current]) && <TagChip tag={tagOf(guilds[current])!} />}
      </div>
      {!withTags.length && <p className="hint small">{t('None of your servers has a tag yet.')}</p>}
    </div>
  )
}

export function ProfileExtras({ draft, onChange, name }: { draft: ProfileDraft; onChange: (d: ProfileDraft) => void; name: string }) {
  const decos = useGuildDecorations()
  const set = (p: Partial<ProfileDraft>) => onChange({ ...draft, ...p })
  const [a, b] = draft.theme_colors ?? [0x0b0f17, 0x00d4ff]
  return (
    <div className="profile-extras">
      <fieldset className="plain">
        <legend className="field-label">{t('Profile theme')}</legend>
        <label className="inline-check"><input type="checkbox" checked={!!draft.theme_colors} onChange={(e) => set({ theme_colors: e.target.checked ? [a, b] : null })} /> {t('Use profile colours')}</label>
        {draft.theme_colors && (
          <div className="color-grid">
            <ColorField label={t('Primary')} value={toHex(a)} onChange={(h) => set({ theme_colors: [toInt(h), b] })} />
            <ColorField label={t('Accent')} value={toHex(b)} onChange={(h) => set({ theme_colors: [a, toInt(h)] })} />
          </div>
        )}
        <p className="hint small">{t('Text on your card switches to black or white automatically so it stays readable.')}</p>
      </fieldset>
      <NameStyleEditor value={draft.style} onChange={(style) => set({ style })} name={name} />
      <Choices legend={t('Avatar decoration')} value={draft.decoration?.sku_id ?? null}
        onChange={(id) => {
          const own = decos.find((d) => d.id === id)
          set({ decoration: !id ? null : own ? { sku_id: own.id, asset: own.asset } : { sku_id: id, asset: id } })
        }}
        items={[
          ...DECORATIONS.map((d) => ({ id: d.id, label: t(d.name), art: <svg viewBox="0 0 120 120" className="deco-art">{d.svg}</svg> })),
          ...decos.map((d) => ({ id: d.id, label: `${d.name} · ${getState().guilds[d.guild_id ?? '']?.name ?? ''}`, art: <img src={decorationUrl(d.asset)} alt="" className="deco-art" /> })),
        ]} />
      <Choices legend={t('Profile effect')} value={draft.effect} onChange={(effect) => set({ effect })}
        items={EFFECTS.map(([id, l]) => ({ id, label: t(l), art: <span className={`pfx-art ${id}`} /> }))} />
      <Choices legend={t('Nameplate')} value={draft.nameplate} onChange={(nameplate) => set({ nameplate })}
        items={NAMEPLATES.map(([id, l, c]) => ({ id, label: t(l), art: <span className="np-art" style={{ '--np': c } as CSSProperties} /> }))} />
      <WidgetEditor value={draft.widgets} onChange={(widgets) => set({ widgets })} />
      <TagPicker />
    </div>
  )
}

/** Per-server name style (PATCH /guilds/:id/members/@me with the same field names as the user). */
export const memberStylePatch = (style: NameStyle | null) => ({ display_name_font_id: style?.font_id ?? null, display_name_effect_id: style?.effect_id ?? null, display_name_colors: style?.colors ?? null })
