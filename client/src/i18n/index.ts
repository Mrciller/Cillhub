// Tiny i18n: UI strings are written in English and looked up in the German dictionary when the locale is `de`.
// `t('Message {name}', { name })` interpolates `{name}`; a missing translation falls back to the English text.
import { useSyncExternalStore } from 'react'
import { de } from './de'

export type Locale = 'en-US' | 'de'
const DICTS: Record<Locale, Record<string, string>> = { 'en-US': {}, de }

const stored = localStorage.getItem('locale')
let locale: Locale = stored === 'de' || stored === 'en-US' ? stored : navigator.language?.toLowerCase().startsWith('de') ? 'de' : 'en-US'
const listeners = new Set<() => void>()
document.documentElement.lang = locale === 'de' ? 'de' : 'en'

export const getLocale = () => locale
export function setLocale(next: Locale) {
  if (next === locale || !DICTS[next]) return
  locale = next
  localStorage.setItem('locale', next)
  document.documentElement.lang = next === 'de' ? 'de' : 'en'
  listeners.forEach((l) => l())
}
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))
/** Re-renders the caller when the language changes (App uses it, so the whole tree follows). */
export const useLocale = () => useSyncExternalStore(subscribe, () => locale)

export function t(key: string, vars?: Record<string, string | number>) {
  const s = DICTS[locale][key] ?? key
  return vars ? s.replace(/\{(\w+)\}/g, (all, k: string) => (k in vars ? String(vars[k]) : all)) : s
}

/** Plural helper: `tn(n, '{n} member', '{n} members')`. */
export const tn = (n: number, one: string, other: string, vars: Record<string, string | number> = {}) => t(n === 1 ? one : other, { n, ...vars })

/** BCP 47 tag for Intl formatting. */
export const intlLocale = () => (locale === 'de' ? 'de-DE' : 'en-US')
