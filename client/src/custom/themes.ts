// Custom colour themes (CONTRACT-v6 section 1): presets, palette derivation with WCAG AA fallbacks, share codes.
import type { CustomTheme } from '../types'
import { AA, contrast, HEX, luminance, mix, onColor, readable } from './color'

const p = (id: string, name: string, background: string, surface: string, accent: string, text: string, gradient: [string, string] | null = null): CustomTheme =>
  ({ id: `preset:${id}`, name, background, surface, accent, text, gradient })
/** Built-in presets; esports-style dark ones first. */
export const PRESETS: CustomTheme[] = [
  p('neon-strike', 'Neon Strike', '#0b0f17', '#151b27', '#00d4ff', '#e6f1ff'),
  p('crimson-ops', 'Crimson Ops', '#120a0c', '#1e1215', '#ff2e4c', '#f4e4e6'),
  p('toxic', 'Toxic', '#0b120b', '#142014', '#7cff4f', '#e3f5df'),
  p('gold-rush', 'Gold Rush', '#14110a', '#211c10', '#ffc23d', '#f7efdc'),
  p('ice-hud', 'Ice HUD', '#0a1418', '#122127', '#5ee7df', '#dff6f5', ['#0a1418', '#10283a']),
  p('ember', 'Ember', '#160c08', '#24140d', '#ff7a1a', '#fbe9df', ['#160c08', '#2b0f0a']),
  p('midnight-blue', 'Midnight Blue', '#0d1424', '#162036', '#3d7bff', '#e2e9f8', ['#0d1424', '#14254a']),
  p('stealth', 'Stealth', '#0a0a0a', '#161616', '#9aa0a6', '#e8e8e8'),
  p('forest', 'Forest', '#0f1a14', '#18271e', '#3ccf7a', '#e1f0e6'),
  p('synthwave', 'Synthwave', '#130f1f', '#1f1830', '#ff4fa3', '#f3e6f4', ['#130f1f', '#2a1036']),
  p('arctic', 'Arctic (light)', '#f4f8fb', '#e3ebf2', '#0b63c5', '#14202b'),
  p('paper', 'Paper (light)', '#fbf8f2', '#efe9dd', '#b4441c', '#2a241c'),
]
export const MAX_THEMES = 10
export const isLight = (t: CustomTheme) => luminance(t.background) > 0.4

/** Background colour after `layer` (alpha) is put over each gradient stop: what text actually sits on. */
const over = (t: CustomTheme, color: string, alpha: number) => (t.gradient ? t.gradient.map((g) => mix(g, color, alpha)) : [])

/** CSS custom properties for a theme. Text colours are pushed to WCAG AA on every surface they appear on. */
export function themeVars(t: CustomTheme): Record<string, string> {
  const light = isLight(t)
  const dim = (f: number) => mix(t.background, '#000000', light ? f / 3 : f)
  const sidebar = dim(0.18)
  const rail = dim(0.38)
  const panel = dim(0.28)
  const surfaces = [t.background, t.surface, sidebar, panel, rail, ...over(t, t.background, 0.78), ...over(t, sidebar, 0.86)]
  const text = readable(t.text, surfaces)
  const strong = readable(mix(text, onColor(t.background), 0.5), surfaces)
  const muted = readable(mix(text, t.background, 0.4), surfaces)
  const alpha = (hex: string, a: number) => `rgb(${parseInt(hex.slice(1, 3), 16)} ${parseInt(hex.slice(3, 5), 16)} ${parseInt(hex.slice(5, 7), 16)} / ${a})`
  return {
    '--chat': t.gradient ? alpha(t.background, 0.78) : t.background,
    '--sidebar': t.gradient ? alpha(sidebar, 0.86) : sidebar,
    '--rail': t.gradient ? alpha(rail, 0.92) : rail,
    '--panel': panel, '--dot-bg': sidebar, '--card': t.surface, '--input': t.surface,
    '--menu': light ? mix(t.background, '#ffffff', 0.6) : dim(0.5),
    '--hover': mix(t.surface, text, 0.08), '--selected': mix(t.surface, text, 0.16), '--border': mix(t.surface, text, 0.2), '--scroll-thumb': dim(0.45),
    '--accent': t.accent, '--accent-hover': mix(t.accent, '#000000', 0.15), '--on-accent': onColor(t.accent),
    '--text': text, '--header': strong, '--strong': strong, '--muted': muted, '--interactive': readable(mix(text, t.background, 0.25), surfaces),
    '--app-bg': t.gradient ? `linear-gradient(135deg, ${t.gradient[0]}, ${t.gradient[1]})` : t.background,
  }
}

export type ContrastIssue = { what: string; ratio: number; need: number }
/** What the chosen colours break before the automatic fallback (shown as a warning in the editor). */
export function contrastIssues(t: CustomTheme): ContrastIssue[] {
  const out: ContrastIssue[] = []
  for (const [what, bg] of [['Text on background', t.background], ['Text on surfaces', t.surface], ...(t.gradient ?? []).map((g, i) => [`Text on gradient stop ${i + 1}`, g])] as [string, string][]) {
    const ratio = contrast(t.text, bg)
    if (ratio < AA) out.push({ what, ratio, need: AA })
  }
  const ui = contrast(t.accent, t.background)
  if (ui < 3) out.push({ what: 'Accent on background', ratio: ui, need: 3 })
  return out
}

/** Server-side rules mirrored for a friendly message: hex colours only, name 1–32 characters. */
export const validTheme = (t: Partial<CustomTheme>): t is CustomTheme =>
  !!t.name && t.name.length <= 32 && [t.background, t.surface, t.accent, t.text].every((c) => typeof c === 'string' && HEX.test(c)) &&
  (t.gradient === null || (Array.isArray(t.gradient) && t.gradient.length === 2 && t.gradient.every((c) => HEX.test(c))))

const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))
/** Short share code: CT1.<24 or 36 hex digits>.<name in base64url>. */
export const encodeTheme = (t: CustomTheme) =>
  `CT1.${[t.background, t.surface, t.accent, t.text, ...(t.gradient ?? [])].map((c) => c.slice(1).toLowerCase()).join('')}.${b64(t.name)}`
export function decodeTheme(code: string): Omit<CustomTheme, 'id'> | null {
  const m = /^CT1\.([0-9a-f]{24}(?:[0-9a-f]{12})?)\.([A-Za-z0-9_-]{1,64})$/i.exec(code.trim())
  if (!m) return null
  const c = m[1].match(/.{6}/g)!.map((x) => `#${x.toLowerCase()}`)
  let name: string
  try { name = unb64(m[2]).slice(0, 32) } catch { return null }
  const t = { name, background: c[0], surface: c[1], accent: c[2], text: c[3], gradient: c.length === 6 ? [c[4], c[5]] as [string, string] : null }
  return validTheme({ ...t, id: 'x' }) ? t : null
}

if (import.meta.env.DEV) {
  const t = PRESETS[4]
  const back = decodeTheme(encodeTheme(t))
  console.assert(!!back && back.name === t.name && back.gradient?.[1] === t.gradient?.[1], 'theme code round-trips')
  console.assert(decodeTheme('CT1.zz.x') === null, 'bad code rejected')
  const bad = { ...PRESETS[0], text: '#10141c' }
  console.assert(contrastIssues(bad).length > 0 && contrast(themeVars(bad)['--text'], bad.background) >= AA, 'unreadable text falls back')
}
