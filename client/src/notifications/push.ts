// Web Push (CONTRACT-v4): subscribe this browser with the server's VAPID key through the app's service worker.
import { addPushSubscription, removePushSubscription, vapidKey } from '../actions'

const b64 = (s: string) => {
  const raw = atob((s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(raw, (c) => c.charCodeAt(0))
}
const registration = async () => ('serviceWorker' in navigator && 'PushManager' in window ? (await navigator.serviceWorker.getRegistration()) ?? null : null)

export type PushState = 'unsupported' | 'denied' | 'on' | 'off'
export async function pushState(): Promise<PushState> {
  const reg = await registration()
  if (!reg) return 'unsupported'
  if (Notification.permission === 'denied') return 'denied'
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off'
}

export async function enablePush() {
  const reg = await registration()
  if (!reg) throw new Error('Push notifications need the installed app or a browser with service workers.')
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notifications are blocked for this site.')
  const key = await vapidKey()
  const sub = (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64(key) }))
  await addPushSubscription(sub.toJSON())
}

export async function disablePush() {
  const sub = await (await registration())?.pushManager.getSubscription()
  if (!sub) return
  await removePushSubscription(sub.endpoint).catch(() => {})
  await sub.unsubscribe()
}
