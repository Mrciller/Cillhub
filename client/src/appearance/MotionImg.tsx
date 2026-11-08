// Animated emoji and stickers follow the user's settings: always animate, animate while hovered, or never (first frame).
import { useEffect, useState, type ImgHTMLAttributes } from 'react'
import { useStore } from '../store'
import type { UserSettings } from '../types'

export type Motion = 'always' | 'hover' | 'never'
/** `animate_emoji`: true / "always", false / "hover" (the reference "off" still animates on hover), "never". */
export const emojiMotion = (v: UserSettings['animate_emoji']): Motion => (v === false || v === 'hover' ? 'hover' : v === 'never' ? 'never' : 'always')
/** `animate_stickers`: 0 always, 1 on interaction (hover), 2 never (or the names). */
export const stickerMotion = (v: UserSettings['animate_stickers']): Motion => (v === 1 || v === 'hover' ? 'hover' : v === 2 || v === 'never' ? 'never' : 'always')

// src -> its first frame as a PNG data URL ('' when it could not be drawn, then the original is shown)
const stills = new Map<string, string>()

function useStill(src: string, needed: boolean) {
  const [still, setStill] = useState(() => stills.get(src))
  useEffect(() => {
    if (!needed) return
    if (stills.has(src)) return setStill(stills.get(src))
    let live = true
    const img = new Image()
    img.crossOrigin = 'anonymous' // the CDN allows any origin, so the canvas stays readable
    img.onload = img.onerror = () => {
      try {
        const c = document.createElement('canvas')
        c.width = img.naturalWidth
        c.height = img.naturalHeight
        c.getContext('2d')!.drawImage(img, 0, 0) // a freshly decoded image draws its first frame
        stills.set(src, c.width ? c.toDataURL() : '')
      } catch {
        stills.set(src, '')
      }
      if (live) setStill(stills.get(src))
    }
    img.src = src
    return () => void (live = false)
  }, [src, needed])
  return still
}

/** An image that may be animated (GIF, APNG, animated WebP), shown according to `motion`. */
export function MotionImg({ motion, src, ...img }: { motion: Motion; src: string } & Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'>) {
  const [hover, setHover] = useState(false)
  const still = useStill(src, motion !== 'always')
  const play = motion === 'always' || (motion === 'hover' && hover) || still === ''
  return (
    <img {...img} src={play || !still ? src : still} data-motion={play ? 'playing' : 'still'}
      style={!play && still === undefined ? { ...img.style, visibility: 'hidden' } : img.style}
      onMouseEnter={motion === 'hover' ? () => setHover(true) : undefined} onMouseLeave={motion === 'hover' ? () => setHover(false) : undefined} />
  )
}

export const useEmojiMotion = () => emojiMotion(useStore((s) => s.settings.animate_emoji))
export const useStickerMotion = () => stickerMotion(useStore((s) => s.settings.animate_stickers))
