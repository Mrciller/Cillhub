// Rendering of others' v6 customizations: display name styles, role colours/gradients and icons, server tags, avatar
// decorations, nameplates, profile effects and profile themes. All decorations and badges are our own SVG/CSS.
import type { CSSProperties, ReactNode } from 'react'
import { cdn } from '../api'
import { t } from '../i18n'
import { sortedRoles } from '../permissions'
import { getState, useStore } from '../store'
import type { Guild, GuildIdentity, GuildTag, Member, NameStyle, Role, User } from '../types'
import { contrast, mix, onColor, readable, toHex } from './color'
import { activeTheme } from './apply'

/** Surfaces names are drawn on in the current theme (chat and sidebar), for the AA fallback. */
const BUILTIN: Record<string, string[]> = { dark: ['#17191e', '#121418'], light: ['#fbfbfc', '#eef0f3', '#d8dce3'], ash: ['#24262d', '#1d1f25'], onyx: ['#0a0a0c', '#060607'] }
export function surfaces(): string[] {
  const s = getState().settings
  const c = activeTheme(s)
  return c ? [c.background, c.surface, ...(c.gradient ?? [])] : BUILTIN[s.theme ?? 'dark'] ?? BUILTIN.dark
}
/** A user-chosen colour as text: kept when it reaches 4.5:1 on the current surfaces, else nudged until it does. */
export const textColor = (n: number) => readable(toHex(n), surfaces())

// ---------- display name styles (user docs: font_id / effect_id / colors) ----------
/** 11 is the default font, 14 Orbitron ("Mainframe") (user docs ids); 100+ are Cillhub's bundled fonts. */
export const NAME_FONTS: [number, string][] = [[11, 'Default'], [14, 'Mainframe (Orbitron)'], [100, 'Clean (Inter)'], [101, 'Terminal (JetBrains Mono)'], [102, 'Readable (OpenDyslexic)']]
/** 1 solid, 2 gradient, 3 neon glow; 6 pulse and 7 prism are animated (still under reduced motion). */
export const NAME_EFFECTS: [number, string, number][] = [[1, 'Solid', 1], [2, 'Gradient', 2], [3, 'Neon glow', 1], [6, 'Pulse (animated)', 1], [7, 'Prism (animated)', 2]]

/** The colours a name is drawn with: the highest coloured role in a server wins, else the user's own style. */
function nameLook(user: User | undefined, member: Member | undefined, guild: Guild | undefined) {
  const style: NameStyle | null | undefined = member?.display_name_styles ?? user?.display_name_styles
  const role = guild && member ? sortedRoles(guild).find((r) => r.color && member.roles.includes(r.id)) : undefined
  const colors = role ? roleColors(role) : style?.colors?.length && style.effect_id ? style.colors.slice(0, style.effect_id === 2 || style.effect_id === 7 ? 3 : 1) : []
  const effect = style?.effect_id ?? (colors.length > 1 ? 2 : 1)
  return { font: style?.font_id ?? 11, effect: colors.length > 1 && effect === 1 ? 2 : effect, colors: colors.map(textColor) }
}
/** Swatch background for a role: its gradient when it has a secondary colour (dots keep the real colours). */
export const roleSwatch = (r: Role) => {
  const c = roleColors(r).map(toHex)
  return c.length > 1 ? `linear-gradient(135deg, ${c.join(', ')})` : c[0] ?? '#949ba4'
}
export const roleColors = (r: Role) => [r.colors?.primary_color || r.color, r.colors?.secondary_color, r.colors?.tertiary_color].filter((c): c is number => !!c)

/** Inline style + class for a styled name; `colors` are already readable. */
export function nameProps(font: number, effect: number, colors: string[]): { className: string; style?: CSSProperties } {
  const cls = `ns ns-f${font} ns-x${colors.length ? effect : 0}`
  if (!colors.length) return { className: cls }
  const style = { color: colors[0], '--ns1': colors[0], '--ns2': colors[1] ?? colors[0], '--ns3': colors[2] ?? colors[1] ?? colors[0] } as CSSProperties
  return { className: cls, style }
}

/** A user's name with their display name style, role colour/gradient, role icon and server tag. */
export function StyledName({ user, member, guild, name, tag = true, icon = true }: { user?: User; member?: Member; guild?: Guild; name: ReactNode; tag?: boolean; icon?: boolean }) {
  useStore((s) => s.settings.theme ?? s.settings.active_theme) // re-render on theme change (readable colours)
  const look = nameLook(user, member, guild)
  return (
    <>
      <span {...nameProps(look.font, look.effect, look.colors)}>{name}</span>
      {icon && guild && member && <RoleIcon role={iconRole(guild, member)} />}
      {tag && user && <ServerTag user={user} />}
    </>
  )
}

// ---------- role icons ----------
export const iconRole = (guild: Guild, member: Member) => sortedRoles(guild).find((r) => (r.icon || r.unicode_emoji) && member.roles.includes(r.id))
export const roleIconUrl = (r: Role) => (r.icon ? (r.icon.startsWith('data:') ? r.icon : cdn(`/roles/${r.id}/icons/${r.icon}.png`)) : null)
export function RoleIcon({ role, size = 18 }: { role?: Role; size?: number }) {
  if (!role) return null
  const url = roleIconUrl(role)
  return url
    ? <img className="role-icon" src={url} width={size} height={size} alt={t('Role icon: {name}', { name: role.name })} title={role.name} />
    : role.unicode_emoji ? <span className="role-icon emoji" role="img" aria-label={t('Role icon: {name}', { name: role.name })} title={role.name} style={{ fontSize: size * 0.85 }}>{role.unicode_emoji}</span> : null
}

// ---------- server tags (guild identity) ----------
/** Badge glyphs (our own 24×24 paths), index = `badge`. */
export const BADGES: [string, string][] = [
  ['Sword', 'M14.5 3H21v6.5l-9.8 9.8 1.4 1.4-1.4 1.4-2.1-2.1-3 3-1.4-1.4 3-3-2.1-2.1 1.4-1.4 1.4 1.4L14.5 3z'],
  ['Drop', 'M12 2s7 7.6 7 12.5A7 7 0 0 1 5 14.5C5 9.6 12 2 12 2z'],
  ['Skull', 'M12 2a8 8 0 0 0-8 8c0 2.8 1.4 4.7 3 5.8V19h2v2h2v-2h2v2h2v-2h2v-3.2c1.6-1.1 3-3 3-5.8a8 8 0 0 0-8-8zM9 13a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm6 0a2 2 0 1 1 0-4 2 2 0 0 1 0 4z'],
  ['Crosshair', 'M11 2h2v4.1A6 6 0 0 1 17.9 11H22v2h-4.1A6 6 0 0 1 13 17.9V22h-2v-4.1A6 6 0 0 1 6.1 13H2v-2h4.1A6 6 0 0 1 11 6.1V2zm1 6a4 4 0 1 0 0 8 4 4 0 0 0 0-8z'],
  ['Moon', 'M14 2a9 9 0 1 0 8 13A8 8 0 0 1 14 2z'],
  ['Bolt', 'M13 2 4 14h6l-1 8 9-12h-6l1-8z'],
  ['Leaf', 'M20 3S8 2 5 9c-2 4.6 0 9 0 9l1.4-1.4C9 11 14 9 14 9s-5 3-6.6 8.6C12 19 18.5 15 20 3z'],
  ['Heart', 'M12 21s-8-5.2-8-11a4.6 4.6 0 0 1 8-3 4.6 4.6 0 0 1 8 3c0 5.8-8 11-8 11z'],
  ['Flame', 'M12 2s5 5 5 10a5 5 0 0 1-10 0c0-2.4 1.2-4 2.2-5 .3 1.6 1 2.6 1.8 3C11 7 12 2 12 2z'],
  ['Crown', 'M3 7l4.5 4L12 4l4.5 7L21 7l-2 12H5L3 7z'],
]
const str = (v: unknown) => (typeof v === 'string' ? v : undefined) // a node's profile is not type-checked on the way in
/** A guild identity (guild `profile` or a user's `primary_guild`) as the tag chip draws it. */
const chipOf = (p: (Partial<Omit<GuildIdentity, 'tag'>> & { tag?: string | null }) | null | undefined): GuildTag | null =>
  p?.tag ? { tag: String(p.tag), badge: p.badge_type ?? 0, badge_color_primary: str(p.badge_color_primary) ?? '#8a93a6', badge_color_secondary: str(p.badge_color_secondary) ?? str(p.badge_color_primary) ?? '#c0c6d2' } : null
export const tagOf = (guild?: Guild): GuildTag | null => chipOf(guild?.profile)
export function TagChip({ tag, title }: { tag: GuildTag; title?: string }) {
  const [label, d] = BADGES[tag.badge] ?? BADGES[0]
  return (
    <span className="server-tag" title={title}>
      <svg viewBox="0 0 24 24" width="12" height="12" aria-label={t('{badge} badge', { badge: t(label) })} role="img">
        <defs><linearGradient id={`tg-${tag.badge_color_primary.slice(1)}-${tag.badge_color_secondary.slice(1)}`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={tag.badge_color_primary} /><stop offset="1" stopColor={tag.badge_color_secondary} /></linearGradient></defs>
        <path d={d} fill={`url(#tg-${tag.badge_color_primary.slice(1)}-${tag.badge_color_secondary.slice(1)})`} />
      </svg>
      {tag.tag}
    </span>
  )
}
/** The tag a user chose to display (primary_guild); badge colours come from the guild when we share it. */
export function ServerTag({ user }: { user: User }) {
  const pg = user.primary_guild
  const guild = useStore((s) => (pg?.identity_guild_id ? s.guilds[pg.identity_guild_id] : undefined))
  const tag = pg && pg.identity_enabled !== false ? tagOf(guild) ?? chipOf(pg) : null
  if (!tag) return null
  return <TagChip tag={tag} title={guild ? t('Server tag of {name}', { name: guild.name }) : undefined} />
}

// ---------- avatar decorations ----------
type Deco = { id: string; name: string; animated: boolean; svg: ReactNode }
const ring = (stroke: string, extra: Record<string, string | number> = {}) => <circle cx="60" cy="60" r="55" fill="none" stroke={stroke} strokeWidth="6" {...extra} />
/** Built-in frames drawn around a 100-unit avatar centred in a 120-unit box. */
export const DECORATIONS: Deco[] = [
  { id: 'cc_neon_ring', name: 'Neon Ring', animated: true, svg: <><defs><linearGradient id="dg-neon"><stop offset="0" stopColor="#00e5ff" /><stop offset="1" stopColor="#3d7bff" /></linearGradient></defs>{ring('url(#dg-neon)', { strokeDasharray: '22 10', className: 'deco-spin' })}</> },
  { id: 'cc_crosshair', name: 'Crosshair', animated: false, svg: <g stroke="#ff3d5a" strokeWidth="5" strokeLinecap="round">{ring('#ff3d5a', { strokeWidth: 3 })}<path d="M60 0v14M60 106v14M0 60h14M106 60h14" /></g> },
  { id: 'cc_ember', name: 'Ember', animated: true, svg: <><defs><linearGradient id="dg-ember" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#ff3d00" /><stop offset="1" stopColor="#ffc400" /></linearGradient></defs>{ring('url(#dg-ember)', { className: 'deco-flicker' })}</> },
  { id: 'cc_laurel', name: 'Champion', animated: false, svg: <g fill="#f5c542">{Array.from({ length: 7 }, (_, i) => <ellipse key={i} cx="60" cy="6" rx="4" ry="9" transform={`rotate(${-150 + i * 20} 60 60)`} />)}{Array.from({ length: 7 }, (_, i) => <ellipse key={`r${i}`} cx="60" cy="6" rx="4" ry="9" transform={`rotate(${150 - i * 20} 60 60)`} />)}</g> },
  { id: 'cc_glitch', name: 'Glitch', animated: true, svg: <g className="deco-glitch">{ring('#ff2bd6', { strokeWidth: 3, transform: 'translate(-2 0)' })}{ring('#00f0ff', { strokeWidth: 3, transform: 'translate(2 0)' })}</g> },
  { id: 'cc_hex', name: 'Hex Frame', animated: false, svg: <path d="M60 3l49 28v58l-49 28-49-28V31z" fill="none" stroke="#7cff4f" strokeWidth="5" strokeLinejoin="round" /> },
]
export const decorationUrl = (asset: string) => (asset.startsWith('data:') ? asset : cdn(`/avatar-decoration-presets/${asset}.png`))
/** Built-ins come back from the server as {asset: <name>, sku_id: "0"}; server uploads as {asset: <hash>, sku_id: <id>}. */
export const isBuiltin = (d: { sku_id: string }) => d.sku_id === '0' || !/^\d+$/.test(d.sku_id)
/** The frame around an avatar: a built-in SVG, or a server's uploaded APNG/WebP. */
export function Decoration({ data }: { data?: User['avatar_decoration_data'] }) {
  if (!data?.asset) return null
  const builtin = isBuiltin(data) ? DECORATIONS.find((d) => d.id === data.asset) : undefined
  if (builtin) return <svg className="deco" viewBox="0 0 120 120" aria-hidden="true">{builtin.svg}</svg>
  if (isBuiltin(data)) return null
  // shortcut: uploaded APNG/WebP decorations keep animating under reduced motion; draw a still (as MotionImg does) if asked
  return <img className="deco" src={decorationUrl(data.asset)} alt="" aria-hidden="true" draggable={false} />
}

// ---------- nameplates ----------
/** Built-in nameplates: a gradient that fades in from the right, so names on the left keep their contrast. */
export const NAMEPLATES: [string, string, string][] = [
  ['np_neon', 'Neon', '#00d4ff'], ['np_crimson', 'Crimson', '#ff2e4c'], ['np_toxic', 'Toxic', '#7cff4f'], ['np_gold', 'Gold', '#ffc23d'], ['np_violet', 'Night', '#5b6cff'], ['np_ember', 'Ember', '#ff7a1a'],
]
export function nameplateStyle(user?: User): CSSProperties | undefined {
  // built-in nameplates only: the server stores our library name as `asset` (sku_id "0")
  const color = NAMEPLATES.find((n) => n[0] === user?.collectibles?.nameplate?.asset)?.[2]
  return color ? ({ '--np': color } as CSSProperties) : undefined
}

// ---------- profile effects and themes ----------
export const EFFECTS: [string, string][] = [['fx_confetti', 'Confetti'], ['fx_embers', 'Embers'], ['fx_scanlines', 'Scanlines'], ['fx_snow', 'Snowfall']]
export function ProfileEffect({ id }: { id?: string | null }) {
  if (!id || !EFFECTS.some(([x]) => x === id)) return null
  return <div className={`pfx ${id}`} aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ '--i': i } as CSSProperties} />)}</div>
}
/** Profile theme (theme_colors): gradient card with automatically readable text. */
export function profileThemeStyle(colors?: [number, number] | null): CSSProperties | undefined {
  if (!colors) return undefined
  const [a, b] = colors.map(toHex)
  const base = onColor(mix(a, b, 0.5))
  const text = readable(base, [a, b])
  const muted = readable(mix(text, mix(a, b, 0.5), 0.3), [a, b])
  return { '--pc-bg': `linear-gradient(180deg, ${a}, ${b})`, '--pc-text': text, '--pc-muted': muted, '--pc-inner': contrast('#000000', a) > contrast('#ffffff', a) ? 'rgb(255 255 255 / .55)' : 'rgb(0 0 0 / .45)' } as CSSProperties
}
