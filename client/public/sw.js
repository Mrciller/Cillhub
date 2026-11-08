// Cillhub service worker: installable app shell. Navigations are network-first with an offline page;
// only hashed /assets/ files are cached (cache-first, they never change). API, gateway, voice and user media are never cached.
const VERSION = 'cillcord-v4'
const OFFLINE = '/offline.html'
const NEVER = /^\/(api|gateway|livekit|attachments|avatars|icons|emojis|stickers|soundboard-sounds|external|guild-events)(\/|$)/

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll([OFFLINE, '/icon-192.png'])).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  if (url.origin !== location.origin || NEVER.test(url.pathname)) return
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match(OFFLINE)))
    return
  }
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(VERSION).then((c) => c.put(req, copy))
        }
        return res
      })),
    )
  }
})

// Web Push (CONTRACT-v4): the server sends a minimal payload { title, body, url, tag }.
self.addEventListener('push', (e) => {
  let data = {}
  try { data = e.data ? e.data.json() : {} } catch { data = { body: e.data && e.data.text() } }
  const url = typeof data.url === 'string' && data.url.startsWith('/') ? data.url : '/channels/@me'
  e.waitUntil(self.registration.showNotification(data.title || 'Cillhub', {
    body: data.body || '', tag: data.tag || undefined, renotify: !!data.tag, icon: '/icon-192.png', badge: '/icon-192.png', data: { url },
  }))
})

// Clicking a notification focuses an open Cillhub window on the right channel, or opens one.
self.addEventListener('notificationclick', (e) => {
  e.notification.close()
  const url = (e.notification.data && e.notification.data.url) || '/channels/@me'
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    const win = list.find((c) => new URL(c.url).origin === location.origin)
    if (win) return win.focus().then((w) => (w || win).postMessage({ type: 'navigate', url }))
    return self.clients.openWindow(url)
  }))
})
