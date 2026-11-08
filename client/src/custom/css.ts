// Custom CSS (CONTRACT-v6 section 1): opt-in, own client only, sanitized; Safe mode (hold Shift while loading, or ?safe=1) turns it off.
export const MAX_CSS = 50 * 1024
const MAX_DATA_URL = 256 * 1024

/** A CSS string (escapes and all, ended by its quote or a newline as the CSS tokenizer does) or a lone backslash. */
const STRING_OR_BACKSLASH = /"(?:[^"\\\n]|\\[\s\S])*"?|'(?:[^'\\\n]|\\[\s\S])*'?|\\/g

/** Removes @import, url() other than data: images under 256 KB, expression(), behavior, -moz-binding and javascript:.
 * Every function that loads a resource is rewritten textually, even inside strings, so a string can never smuggle one in. */
export function sanitizeCss(css: string): string {
  return css
    .slice(0, MAX_CSS)
    .replace(/\/\*[\s\S]*?\*\//g, '') // comments could hide the patterns below (e.g. ex/**/pression)
    .replace(STRING_OR_BACKSLASH, (m) => (m === '\\' ? '' : m)) // escapes stay inside strings ("\201C"); outside they could spell url/expression
    .replace(/@import[^;]*;?/gi, '')
    .replace(/url\(\s*(['"]?)([\s\S]*?)\1\s*\)/gi, (all, _q, src: string) =>
      /^data:image\/(png|jpe?g|gif|webp|svg\+xml);/i.test(src.trim()) && all.length <= MAX_DATA_URL ? all : 'none')
    .replace(/expression\s*\(/gi, '(')
    .replace(/(-moz-binding|behavior)\s*:[^;}]*/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/image-set\(|-webkit-image-set\(|\bsrc\(/gi, '(') // image-set("https://…") and src("…") load without url()
    .replace(/@font-face\s*{[^}]*}/gi, '') // only with url() it would load anything; a bare one is useless
    .replace(/url\((?!\s*['"]?data:image\/)/gi, 'none(') // anything the pair match above missed (unbalanced quotes)
}

const params = new URLSearchParams(location.search)
let safe = params.get('safe') === '1'
const listeners = new Set<() => void>()
export const safeMode = () => safe
export const onSafeMode = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))
export function setSafeMode(on: boolean) {
  safe = on
  listeners.forEach((l) => l())
}
/** Shift held during the first 2 s of loading (key repeat or the first pointer event) turns Safe mode on. */
export function watchSafeKey() {
  const until = performance.now() + 2000
  const check = (e: KeyboardEvent | PointerEvent) => {
    if (performance.now() > until) return stop()
    if (e.shiftKey && !safe) setSafeMode(true)
  }
  const stop = () => (removeEventListener('keydown', check, true), removeEventListener('pointermove', check, true))
  addEventListener('keydown', check, true)
  addEventListener('pointermove', check, true)
  setTimeout(stop, 2100)
}

let el: HTMLStyleElement | null = null
/** Puts the sanitized CSS into one <style> (textContent, so it can never become HTML). */
export function applyCustomCss(css: string | undefined, enabled: boolean | undefined) {
  const on = !!enabled && !!css && !safe
  if (!on) return void el?.remove()
  el ??= Object.assign(document.createElement('style'), { id: 'cillcord-custom-css' })
  el.textContent = sanitizeCss(css)
  if (!el.isConnected) document.head.append(el)
}

if (import.meta.env.DEV) {
  const out = sanitizeCss('@import "https://x.y/a.css"; a{background:url(https://evil.example/p.png)} b{width:expression(alert(1))} c{behavior:url(x.htc)} d{background:url(data:image/png;base64,AAAA)}')
  console.assert(!/@import|evil|expression|behavior/.test(out) && out.includes('data:image/png'), 'css sanitizer')
  console.assert(sanitizeCss('a::before{content:"\\201C"}') === 'a::before{content:"\\201C"}', 'escapes kept inside strings')
  console.assert(!/url\(|\\/.test(sanitizeCss('a{background:u\\72l(https://evil.example/x)}')), 'escapes outside strings dropped')
  console.assert(!/url\("\\/.test(sanitizeCss('a{background:url("\\68ttps://evil.example/x")}')), 'escaped url in a string goes')
}
