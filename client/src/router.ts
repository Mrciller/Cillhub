import { createElement, useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react'

const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
addEventListener('popstate', emit)

export function navigate(to: string, replace = false) {
  history[replace ? 'replaceState' : 'pushState'](null, '', to)
  emit()
}

const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))
export const usePath = () => useSyncExternalStore(subscribe, () => location.pathname)

export function Link({ to, onClick, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { to: string }) {
  const click = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    // Let modified clicks open a new tab as usual.
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    navigate(to)
  }
  return createElement('a', { ...rest, href: to, onClick: click })
}

export function Redirect({ to }: { to: string }) {
  useEffect(() => navigate(to, true), [to])
  return null
}

/** `next` from the query string, only if it is a same-origin path. */
export function nextPath(fallback: string) {
  const next = new URLSearchParams(location.search).get('next')
  return next && /^\/(?![/\\])/.test(next) ? next : fallback
}
