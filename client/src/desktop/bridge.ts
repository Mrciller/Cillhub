// Desktop app bridge (CONTRACT-v5 section 3): the Electron shell's preload exposes window.cillcordDesktop.
// onGameActivity reports the detected game ({name, start} or null), sent as a Playing activity in op 3;
// onHotkey forwards the global mute/deafen shortcuts, which work while the app is not focused.
import { setGame } from '../actions'
import { getState, setState } from '../store'
import { setSelfDeaf, setSelfMute } from '../voice/engine'

type Bridge = {
  onGameActivity?: (cb: (a: { name?: unknown; start?: unknown } | null) => void) => () => void
  onHotkey?: (cb: (action: unknown) => void) => () => void
  onLeagueLobby?: (cb: (lobby: any) => void) => () => void
  getLeagueLobby?: () => Promise<any>
  sendLeagueInvite?: (target: string) => Promise<boolean>
  acceptLeagueInvite?: (invitationId?: string) => Promise<boolean>
}

export function startDesktopBridge() {
  const d = (window as { cillcordDesktop?: Bridge }).cillcordDesktop
  if (!d) return
  d.onGameActivity?.((a) => {
    // The page trusts the shell, but keeps the activity to the shape it sends on.
    const name = a && typeof a.name === 'string' ? a.name.trim().slice(0, 128) : ''
    const start = a && Number.isFinite(Number(a.start)) ? Number(a.start) : Date.now()
    const cur = getState().game
    if (!name) return void (cur && setGame(null))
    if (cur?.name !== name || cur.start !== start) setGame({ name, start })
  })
  d.onHotkey?.((action) => {
    const v = getState().voice
    if (action === 'toggle-mute') setSelfMute(!v.selfMute)
    else if (action === 'toggle-deafen') setSelfDeaf(!v.selfDeaf)
  })
  d.onLeagueLobby?.((lobby) => {
    if (!lobby || !lobby.active) {
      setState({ leagueLobby: null })
    } else {
      setState({
        leagueLobby: {
          active: true,
          partyId: String(lobby.partyId || ''),
          queueId: lobby.queueId ? Number(lobby.queueId) : undefined,
          queueName: String(lobby.queueName || 'Custom Game'),
          members: Number(lobby.members || 1),
          maxMembers: Number(lobby.maxMembers || 5),
          hostName: String(lobby.hostName || ''),
          hostPuuid: String(lobby.hostPuuid || ''),
        },
      })
    }
  })
}

export const getDesktopBridge = (): Bridge | undefined =>
  (window as { cillcordDesktop?: Bridge }).cillcordDesktop

