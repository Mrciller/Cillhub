// Public instance info (name, message of the day, registration mode, current announcement) for the login page and the
// banner. Loaded once from GET /instance; INSTANCE_SETTINGS_UPDATE and INSTANCE_ANNOUNCEMENT keep it current.
import { useEffect, useSyncExternalStore } from 'react'
import { getInstance, type Announcement, type PublicInstance } from './api'

const FALLBACK: PublicInstance = { name: 'Cillhub', motd: null, registration_mode: 'open', announcement: null }
let info: PublicInstance | null = null
let loading = false
const listeners = new Set<() => void>()
const set = (next: PublicInstance) => ((info = next), listeners.forEach((l) => l()))
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))

function load() {
  if (info || loading) return
  loading = true
  // An older server without /instance: behave like an open instance without a message.
  getInstance().then(set, () => set(FALLBACK)).finally(() => (loading = false))
}

/** null until loaded. */
export function useInstance() {
  useEffect(load, [])
  return useSyncExternalStore(subscribe, () => info)
}

/** Gateway dispatches (store.apply forwards them). */
export function instanceEvent(t: string, d: unknown) {
  const base = info ?? FALLBACK
  if (t === 'INSTANCE_SETTINGS_UPDATE') set({ ...base, ...(d as Partial<PublicInstance>) })
  if (t === 'INSTANCE_ANNOUNCEMENT') set({ ...base, announcement: d as Announcement })
}
