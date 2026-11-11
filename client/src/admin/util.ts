// Small helpers shared by the admin pages.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { askStatement, askText } from '../components/dialogs'
import { DECISION_CATEGORIES } from '../legal/LegalPages'
import { intlLocale, t } from '../i18n'

/** Loads on mount and whenever `deps` change; `reload()` refetches. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(fn, deps) // eslint-disable-line react-hooks/exhaustive-deps
  const latest = useRef(0)
  const current = useRef(load)
  current.current = load
  // Only the newest request may set the data, and a reload from an older render (an action's callback) loads with the
  // current filters, so a slow answer for an old filter never overwrites a newer one.
  const reload = useCallback(() => {
    const n = ++latest.current
    setError('')
    return current.current().then((d) => n === latest.current && setData(d), (e: Error) => n === latest.current && setError(e.message))
  }, [load]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void reload(), [reload])
  return { data, error, reload, setData }
}

export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString(intlLocale(), { dateStyle: 'medium', timeStyle: 'short' }) : '—')
export const day = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString(intlLocale(), { day: 'numeric', month: 'short' })
export const num = (n: number) => n.toLocaleString(intlLocale())
export function bytes(n: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  while (n >= 1024 && i < units.length - 1) (n /= 1024), i++
  return `${n.toLocaleString(intlLocale(), { maximumFractionDigits: i ? 1 : 0 })} ${units[i]}`
}

/** Destructive admin actions need a fresh 2FA code (TOTP or backup); resolves the code, or null when cancelled. */
export const askCode = (title: string, body: ReactNode, confirm: string) =>
  askText({ title, body, confirm, danger: true, label: t('Authentication or backup code') }).then((c) => c?.replace(/[\s-]/g, '') || null)

/** 7.11: the statement of reasons for a moderation action (category, legal ground, explanation); null when cancelled. */
export const askReasons = (title: string, confirm: string, body?: ReactNode, initial?: string) =>
  askStatement({ title, confirm, body, initial, categories: DECISION_CATEGORIES.map(([k, label]) => [k, t(label)]) })
