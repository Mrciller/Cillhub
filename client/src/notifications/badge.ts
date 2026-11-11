// Unread count in the tab title ("(3) Cillhub") and a red badge on the favicon.
import { badgeCount, unreadChannels } from '../selectors'
import { getState, subscribe } from '../store'

const BASE = 'Cillhub'
let shown = ''
let icon: HTMLImageElement | null = null

function favicon(count: number) {
  const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]')
  if (!link) return
  link.dataset.base ??= link.href
  if (!count) return void (link.href = link.dataset.base)
  const draw = () => {
    const c = document.createElement('canvas')
    c.width = c.height = 64
    const g = c.getContext('2d')
    if (!g || !icon) return
    g.drawImage(icon, 0, 0, 64, 64)
    g.fillStyle = '#e11d3c'
    g.beginPath()
    g.arc(46, 46, 18, 0, Math.PI * 2)
    g.fill()
    g.fillStyle = '#fff'
    g.font = 'bold 24px system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(count > 9 ? '9+' : String(count), 46, 47)
    link.href = c.toDataURL('image/png')
  }
  if (icon?.complete) return draw()
  icon = new Image()
  icon.onload = draw
  icon.src = link.dataset.base
}

export function startBadge() {
  const run = () => {
    const s = getState()
    if (s.status !== 'ready') return
    const n = badgeCount(s)
    const unread = n > 0 || unreadChannels(s).length > 0
    const key = `${n}-${unread}`
    if (key === shown) return
    shown = key
    document.title = n ? `(${n}) ${BASE}` : unread ? `• ${BASE}` : BASE
    favicon(n)
  }
  subscribe(run)
}
