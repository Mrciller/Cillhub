// The postMessage bridge between the app and a module panel (CONTRACT-v8 §6.4). The panel runs in an opaque-origin iframe
// (sandbox="allow-scripts"), so its messages arrive with origin "null": they are trusted only when they come from that
// iframe's own window, fit in 64 KiB and have the request shape. Nothing sent to a panel ever carries a token.
import { api, ApiError } from '../api'
import { ask } from '../components/dialogs'
import { t } from '../i18n'
import type { ModulePanel } from '../types'
import { onModuleUiEvent, type UiEvent } from './events'

export const MAX_MESSAGE = 64 * 1024
export type PanelContext = {
  module_id: string; panel_id: string; slot: ModulePanel['slot']; guild_id: string; channel_id: string | null; message_id: string | null
  user: { id: string; username: string; global_name: string | null; avatar: string | null }; locale: 'en-US' | 'de'; theme: 'dark' | 'light'
}
export type BridgeRequest = { cillhub: 1; type: 'request'; id: string; action: string; data?: unknown }
type Reply = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } }

/** The panel's message when it is a request of the contract's shape within 64 KiB (measured as JSON), else null. */
export function parseRequest(raw: unknown): BridgeRequest | null {
  let size = Infinity
  try { size = JSON.stringify(raw)?.length ?? Infinity } catch { /* cyclic or BigInt: not JSON, refused */ }
  if (size > MAX_MESSAGE || !raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const m = raw as Record<string, unknown>
  return m.cillhub === 1 && m.type === 'request' && typeof m.id === 'string' && m.id.length <= 64 && typeof m.action === 'string' ? (m as BridgeRequest) : null
}

/** Error code for a failed UI request, from the HTTP status of POST /modules/:id/ui. */
export const uiErrorCode = (status: number) =>
  status === 503 ? 'UNAVAILABLE' : status === 504 ? 'TIMEOUT' : status === 502 ? 'MODULE_ERROR' : status === 429 ? 'RATE_LIMITED' : 'ERROR'

export const clampHeight = (h: number) => Math.min(800, Math.max(40, Math.round(h)))

const fail = (code: string, message: string): Reply => ({ ok: false, error: { code, message } })

/** Starts the bridge for one panel iframe; returns the cleanup. `context()` is read at every use, so it is always current. */
export function connectBridge(frame: HTMLIFrameElement, context: () => PanelContext, on: { resize: (h: number) => void; close?: () => void }) {
  const post = (msg: object) => frame.contentWindow?.postMessage({ cillhub: 1, ...msg }, '*') // the sandboxed frame's origin is "null", so no narrower target exists
  const handle = async (req: BridgeRequest): Promise<Reply> => {
    const data = req.data as Record<string, unknown> | undefined
    switch (req.action) {
      case 'ready':
        postContext(frame, context())
        return { ok: true, data: null }
      case 'request': {
        const c = context()
        try {
          const r = await api<{ data?: unknown }>(`/modules/${encodeURIComponent(c.module_id)}/ui`, {
            method: 'POST', body: { panel_id: c.panel_id, guild_id: c.guild_id, ...(c.channel_id && { channel_id: c.channel_id }), ...(c.message_id && { message_id: c.message_id }), data: req.data ?? null },
          })
          return { ok: true, data: r?.data ?? null }
        } catch (e) {
          return fail(uiErrorCode(e instanceof ApiError ? e.status : 0), e instanceof Error ? e.message : String(e))
        }
      }
      case 'resize':
        if (typeof data?.height !== 'number' || !Number.isFinite(data.height)) return fail('ERROR', 'data.height must be a number')
        on.resize(clampHeight(data.height))
        return { ok: true, data: null }
      case 'close':
        if (!on.close) return fail('ERROR', 'This panel cannot be closed')
        on.close()
        return { ok: true, data: null }
      case 'open_url': {
        let url: URL | null = null
        try { url = typeof data?.url === 'string' ? new URL(data.url) : null } catch { /* not a URL */ }
        if (url?.protocol !== 'https:') return fail('ERROR', 'Only https:// links can be opened')
        const href = url.href
        void ask({
          title: t('Leaving Cillhub'),
          body: <><p>{t('This link is taking you to the following website')}</p><p className="leave-url">{href}</p><p className="hint">{t('Are you sure you want to go there?')}</p></>,
          confirm: t('Visit Site'),
        }).then((ok) => ok && window.open(href, '_blank', 'noopener,noreferrer'))
        return { ok: true, data: null }
      }
      default:
        return fail('UNKNOWN_ACTION', `Unknown action: ${req.action.slice(0, 64)}`)
    }
  }
  const onMessage = (e: MessageEvent) => {
    if (!frame.contentWindow || e.source !== frame.contentWindow) return
    const req = parseRequest(e.data)
    if (req) void handle(req).then((reply) => post({ type: 'response', id: req.id, ...reply }))
  }
  const onEvent = (e: UiEvent) => {
    const c = context()
    if (e.module_id === c.module_id && e.guild_id === c.guild_id) post({ type: 'event', data: e.data })
  }
  window.addEventListener('message', onMessage)
  const off = onModuleUiEvent(onEvent)
  return () => (window.removeEventListener('message', onMessage), off())
}

export const postContext = (frame: HTMLIFrameElement | null, context: PanelContext) => frame?.contentWindow?.postMessage({ cillhub: 1, type: 'context', context }, '*')
