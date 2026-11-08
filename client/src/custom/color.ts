// Colour helpers for v6 customization: hex <-> int, WCAG 2.x relative luminance and contrast, readable fallbacks.
export const HEX = /^#[0-9a-f]{6}$/i
export const toHex = (n: number) => '#' + (n & 0xffffff).toString(16).padStart(6, '0')
export const toInt = (hex: string) => parseInt(hex.slice(1), 16)

const channel = (v: number) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)
export function luminance(hex: string) {
  const n = toInt(hex)
  return 0.2126 * channel(((n >> 16) & 255) / 255) + 0.7152 * channel(((n >> 8) & 255) / 255) + 0.0722 * channel((n & 255) / 255)
}
export function contrast(a: string, b: string) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
/** Linear mix of two colours: f = 0 gives a, 1 gives b. */
export function mix(a: string, b: string, f: number) {
  const [x, y] = [toInt(a), toInt(b)]
  const c = (s: number) => Math.round(((x >> s) & 255) * (1 - f) + ((y >> s) & 255) * f) << s
  return toHex(c(16) | c(8) | c(0))
}
export const AA = 4.5
/** Black or white, whichever reads better on `bg`. */
export const onColor = (bg: string) => (contrast('#ffffff', bg) >= contrast('#000000', bg) ? '#ffffff' : '#000000')
/** `fg` if it reaches `ratio` on every background, else `fg` pushed towards black/white until it does (or black/white). */
export function readable(fg: string, bgs: string[], ratio = AA) {
  const ok = (c: string) => bgs.every((b) => contrast(c, b) >= ratio)
  if (ok(fg)) return fg
  const target = onColor(bgs[0])
  for (let f = 0.1; f < 1; f += 0.1) if (ok(mix(fg, target, f))) return mix(fg, target, f)
  return target
}

if (import.meta.env.DEV) {
  console.assert(Math.abs(contrast('#ffffff', '#000000') - 21) < 0.01, 'contrast white/black is 21')
  console.assert(contrast(readable('#777777', ['#808080']), '#808080') >= AA, 'readable reaches AA')
  console.assert(mix('#000000', '#ffffff', 0.5) === '#808080', 'mix midpoint')
}
