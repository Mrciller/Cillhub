// DM and group DM calls (CONTRACT-v4 section 1): start, join, ring.
import { openDm } from '../actions'
import { callStates, getState } from '../store'
import { joinVoice } from '../voice/engine'

/** Joins the call in a DM channel; starting a new call rings the other recipients once we are in. */
export function startCall(channelId: string) {
  const s = getState()
  const others = callStates(s, channelId).filter((v) => v.user_id !== s.me?.id)
  joinVoice(null, channelId, { ring: others.length === 0 })
}
/** "Call" from a profile or the friends list: opens the DM and starts the call. */
export const callUser = (userId: string) => openDm(userId).then((c) => startCall(c.id))
