// Popovers and context menus in the top layer (popover="auto" gives Escape and light dismiss).
import { useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { zoomFactor } from '../appearance/apply'
import { cls } from './ui'

export type Anchor = { x: number; y: number } | { rect: DOMRect; side: 'right' | 'left' | 'above' | 'below' }
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi))

function place(el: HTMLElement, at: Anchor) {
  const { width: w, height: h } = el.getBoundingClientRect()
  let x: number
  let y: number
  if ('rect' in at) {
    const r = at.rect
    if (at.side === 'right' || at.side === 'left') {
      x = at.side === 'right' ? r.right + 8 : r.left - w - 8
      if (x + w > innerWidth - 8) x = r.left - w - 8
      if (x < 8) x = r.right + 8
      y = r.top
    } else {
      x = r.left
      y = at.side === 'below' ? r.bottom + 6 : r.top - h - 6
      if (y < 8) y = r.bottom + 6
    }
  } else (x = at.x), (y = at.y)
  // With the zoom setting, measured (visual) pixels are divided back into CSS pixels.
  const z = zoomFactor()
  el.style.left = clamp(x, 8, innerWidth - w - 8) / z + 'px'
  el.style.top = clamp(y, 8, innerHeight - h - 8) / z + 'px'
}

type PopoverProps = { at: Anchor; onClose: () => void; children: ReactNode; className?: string; role?: 'dialog' | 'menu'; label: string }

export function Popover({ at, onClose, children, className, role = 'dialog', label }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => {
    const el = ref.current!
    const opener = document.activeElement as HTMLElement | null
    el.showPopover()
    const first = el.querySelector<HTMLElement>('[data-autofocus], [role^="menuitem"]:not([aria-disabled="true"]), input, textarea, select, button, [tabindex="0"]')
    ;(first ?? el).focus({ preventScroll: true })
    const onToggle = (e: Event) => (e as ToggleEvent).newState === 'closed' && close.current()
    el.addEventListener('toggle', onToggle)
    return () => {
      el.removeEventListener('toggle', onToggle)
      const inside = el.contains(document.activeElement) || document.activeElement === document.body
      if (el.matches(':popover-open')) el.hidePopover()
      if (inside) opener?.focus?.({ preventScroll: true })
    }
  }, [])
  useLayoutEffect(() => place(ref.current!, at), [at])
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (role !== 'menu' || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || (e.target as HTMLElement).tagName === 'INPUT') return
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')]
    if (!items.length) return
    e.preventDefault()
    const i = items.indexOf(document.activeElement as HTMLElement)
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
    items[next].focus()
  }
  return (
    <div ref={ref} popover="auto" role={role} aria-label={label} tabIndex={-1} className={cls('popover', role === 'menu' && 'menu ctx', className)} onKeyDown={onKeyDown}>
      {children}
    </div>
  )
}

type ItemProps = { children: ReactNode; onSelect: () => void; danger?: boolean; disabled?: boolean; checked?: boolean; hint?: string }
/** A menu item; `checked` makes it a menuitemcheckbox. Selecting closes the menu (Escape-equivalent). */
export function MenuItem({ children, onSelect, danger, disabled, checked, hint }: ItemProps) {
  const pick = (e: MouseEvent<HTMLButtonElement>) => {
    if (disabled) return
    e.currentTarget.closest<HTMLElement>('[popover]')?.hidePopover()
    onSelect()
  }
  return (
    <button
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      tabIndex={-1}
      className={cls(danger && 'danger')}
      onClick={pick}
    >
      <span className="ellipsis">{children}</span>
      {hint && <span className="menu-hint">{hint}</span>}
      {checked !== undefined && <span className={cls('check', checked && 'on')} aria-hidden="true" />}
    </button>
  )
}
export const MenuSep = () => <hr className="menu-sep" />
export const MenuLabel = ({ children }: { children: ReactNode }) => <div className="menu-label" role="presentation">{children}</div>

// On Linux and macOS contextmenu fires on pointerdown, and Chrome light-dismisses every popover="auto" on the
// pointerup that follows, so a menu opened right away closes at once. Open it after the button is released.
let rightDown = false
addEventListener('pointerdown', (e) => void (e.button === 2 && (rightDown = true)), true)
addEventListener('pointerup', (e) => void (e.button === 2 && (rightDown = false)), true)
export function afterRightRelease(fn: () => void) {
  if (rightDown) addEventListener('pointerup', () => setTimeout(fn), { once: true, capture: true })
  else fn()
}

/** Right click, Shift+F10 or the menu key opens a context menu at the pointer or at the element. */
export function useContextMenu() {
  const [at, setAt] = useState<Anchor | null>(null)
  const openAt = (el: Element, x?: number, y?: number) => setAt(x || y ? { x: x!, y: y! } : { rect: el.getBoundingClientRect(), side: 'right' })
  return {
    at,
    close: () => setAt(null),
    openAt,
    props: {
      onContextMenu: (e: MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        const el = e.currentTarget
        const { clientX: x, clientY: y } = e
        afterRightRelease(() => openAt(el, x, y))
      },
      onKeyDown: (e: KeyboardEvent) => {
        if (!((e.shiftKey && e.key === 'F10') || e.key === 'ContextMenu')) return
        e.preventDefault()
        e.stopPropagation()
        openAt(e.currentTarget)
      },
    },
  }
}
