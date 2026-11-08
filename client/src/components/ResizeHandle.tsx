import { useCallback, useEffect, useRef, useState } from 'react'
import { cls } from './ui'
import './resize.css'

export interface ResizeHandleProps {
  id: string
  side: 'left' | 'right'
  min?: number
  max?: number
  defaultValue: number
  storageKey: string
  cssVar: string
  ariaLabel: string
  className?: string
  onResize?: (width: number) => void
}

function getStoredWidth(key: string, def: number, min: number, max: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const val = Number(raw)
      if (!Number.isNaN(val) && val >= min && val <= max) return val
    }
  } catch {}
  return def
}

export function ResizeHandle({
  id,
  side,
  min = 160,
  max = 600,
  defaultValue,
  storageKey,
  cssVar,
  ariaLabel,
  className,
  onResize,
}: ResizeHandleProps) {
  const [width, setWidth] = useState(() => getStoredWidth(storageKey, defaultValue, min, max))
  const [isDragging, setIsDragging] = useState(false)
  const isDraggingRef = useRef(false)
  const currentWidthRef = useRef(width)
  currentWidthRef.current = width
  const startXRef = useRef(0)
  const startWidthRef = useRef(width)

  const applyWidth = useCallback(
    (w: number, save: boolean) => {
      const clamped = Math.round(Math.max(min, Math.min(max, w)))
      setWidth(clamped)
      currentWidthRef.current = clamped
      document.documentElement.style.setProperty(cssVar, `${clamped}px`)
      document.documentElement.setAttribute('data-sidebar-resized', '1')
      if (save) {
        try {
          localStorage.setItem(storageKey, String(clamped))
        } catch {}
      }
      onResize?.(clamped)
    },
    [min, max, cssVar, storageKey, onResize],
  )

  useEffect(() => {
    document.documentElement.style.setProperty(cssVar, `${width}px`)
  }, [cssVar, width])

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {}
    isDraggingRef.current = true
    setIsDragging(true)
    startXRef.current = e.clientX
    startWidthRef.current = currentWidthRef.current
    document.body.classList.add('resizing')
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    e.preventDefault()
    const delta = e.clientX - startXRef.current
    const newWidth = side === 'right' ? startWidthRef.current + delta : startWidthRef.current - delta
    applyWidth(newWidth, false)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!isDraggingRef.current) return
    isDraggingRef.current = false
    setIsDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {}
    document.body.classList.remove('resizing')
    applyWidth(currentWidthRef.current, true)
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    try {
      localStorage.removeItem(storageKey)
    } catch {}
    document.documentElement.removeAttribute('data-sidebar-resized')
    applyWidth(defaultValue, true)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 40 : 10
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      const delta = side === 'right' ? -step : step
      applyWidth(currentWidthRef.current + delta, true)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      const delta = side === 'right' ? step : -step
      applyWidth(currentWidthRef.current + delta, true)
    } else if (e.key === 'Home') {
      e.preventDefault()
      applyWidth(min, true)
    } else if (e.key === 'End') {
      e.preventDefault()
      applyWidth(max, true)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      applyWidth(defaultValue, true)
    }
  }

  return (
    <div
      id={id}
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={ariaLabel}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      className={cls('resize-handle', `resize-handle-${side}`, isDragging && 'active', className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    />
  )
}
