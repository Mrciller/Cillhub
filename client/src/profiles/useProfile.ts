import { useEffect, useState } from 'react'
import { getProfile } from '../actions'
import type { Profile } from '../types'

const cache = new Map<string, Profile>()
/** GET /users/:id/profile (with mutuals), cached per user and server; refetched whenever a profile opens. */
export function useProfile(userId: string, guildId?: string) {
  const key = `${userId}:${guildId ?? ''}`
  const [profile, setProfile] = useState(() => cache.get(key))
  const [error, setError] = useState(false)
  useEffect(() => {
    let live = true
    setProfile(cache.get(key))
    getProfile(userId, guildId).then(
      (p) => live && (cache.set(key, p), setProfile(p)),
      () => live && setError(true),
    )
    return () => void (live = false)
  }, [key, userId, guildId])
  return { profile, error }
}
export const forgetProfile = (userId: string) => [...cache.keys()].filter((k) => k.startsWith(userId + ':')).forEach((k) => cache.delete(k))
