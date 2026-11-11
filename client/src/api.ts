import { DEFAULT_HUB_URL } from './hub'
import { t } from './i18n'
import { admitRest, instanceById, instances, outbound, outboundPath, route, tokenOf } from './instances/registry'
import { cleanName, normalizeServerUrl, parseNodes, safePath, tokenFor, type SavedNode } from './privateNodes'

export { normalizeServerUrl }

export const SERVER_TARGET_KEY = 'cillhub_server_target'
export const CUSTOM_NODE_KEY = 'cillhub_custom_node_url'

export function getServerTarget(): 'hub' | 'private' {
  try {
    return (localStorage.getItem(SERVER_TARGET_KEY) as 'hub' | 'private') || 'hub'
  } catch {
    return 'hub'
  }
}

export function getCustomNodeUrl(): string {
  try {
    return localStorage.getItem(CUSTOM_NODE_KEY) || ''
  } catch {
    return ''
  }
}

export const ORIGIN = import.meta.env.VITE_API_BASE ?? ''

/** The server this client talks to (the login page's Main Hub / Private Node choice): REST, media, voice, and every link people share. */
export function apiOrigin(): string {
  const custom = getServerTarget() === 'private' && normalizeServerUrl(getCustomNodeUrl())
  return custom || hubOrigin()
}

/** The Main Hub choice: the build's API base, else the server that served this page. */
export function hubOrigin(): string {
  if (ORIGIN) return ORIGIN.replace(/\/+$/, '')
  if (typeof window !== 'undefined' && /^https?:\/\//.test(window.location?.origin ?? '')) return window.location.origin
  return DEFAULT_HUB_URL
}

/** Saves the choice; a private address is stored normalised (false when it is not usable, nothing is saved then). */
export function setServerTarget(target: 'hub' | 'private', customUrl?: string): boolean {
  const url = customUrl === undefined ? undefined : normalizeServerUrl(customUrl)
  if (url === null) return false
  try {
    localStorage.setItem(SERVER_TARGET_KEY, target)
    if (url !== undefined) localStorage.setItem(CUSTOM_NODE_KEY, url)
  } catch {}
  return true
}

export const NODES_KEY = 'cillhub_private_nodes'
const local = (key: string) => { try { return localStorage.getItem(key) } catch { return null } }

/** This device's saved private nodes (Settings › Private Nodes). */
export const savedNodes = (): SavedNode[] => parseNodes(local(NODES_KEY))
export const saveNodes = (list: SavedNode[]) => { try { localStorage.setItem(NODES_KEY, JSON.stringify(list)) } catch {} }

/** Whether a server answers as Cillhub, and its name (GET /instance: no credentials, no redirects, 5 s). */
export async function testNode(origin: string): Promise<{ name: string }> {
  const res = await fetch(`${origin}/api/v9/instance`, { credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(5000) })
  const data = res.ok ? await res.json().catch(() => null) : null
  if (!data || typeof data !== 'object') throw new Error('Not answering as Cillhub')
  return { name: cleanName((data as { name?: unknown }).name) }
}

/** Root-relative CDN paths (avatars, icons, attachments) resolved against the API origin, or the node's origin for node ids (v7). */
export const cdn = (path: string) => {
  if (/^https?:\/\//.test(path) || path.startsWith('data:')) return path
  if (!safePath(path)) return '' // an id that walks out of its segment never becomes a request
  const node = instanceById(route(path))
  return node ? node.url + outboundPath(node.id, path) : apiOrigin() + path
}

type FieldErrors = Record<string, { _errors?: { code: string; message: string }[] }>

/** The first field message of a 50035 "Invalid Form Body" answer, e.g. "Stickers are at most 320x320.". */
function firstFieldError(errors: unknown): string | undefined {
  if (!errors || typeof errors !== 'object') return undefined
  const own = (errors as { _errors?: { message?: string }[] })._errors?.[0]?.message
  if (own) return own
  for (const v of Object.values(errors)) {
    const m = firstFieldError(v)
    if (m) return m
  }
  return undefined
}

export class ApiError extends Error {
  status: number
  code: number
  errors: FieldErrors
  /** Seconds to wait, from a 429 (slowmode) answer. */
  retryAfter: number
  /** The elevation ticket of a 401 60003 answer (trade it with a code at POST /mfa/finish). */
  ticket?: string
  /** The whole answer body (e.g. `moderation` on a disabled login). */
  body: Record<string, unknown> | null
  constructor(status: number, body: { code?: number; message?: string; errors?: FieldErrors; retry_after?: number; mfa?: { ticket?: string } } | null) {
    // Show the field's reason instead of the bare "Invalid Form Body".
    super((body?.code === 50035 && firstFieldError(body.errors)) || body?.message || (status ? t('Request failed ({status})', { status }) : t("Can't reach the server.")))
    this.status = status
    this.code = body?.code ?? 0
    this.errors = body?.errors ?? {}
    this.retryAfter = body?.retry_after ?? 0
    this.ticket = body?.mfa?.ticket
    this.body = body as Record<string, unknown> | null
  }
}

// By the address the request really goes to, so a routing slip can never hand one server another's token.
const auth = (url: string): Record<string, string> => {
  const token = tokenFor(url, { origin: apiOrigin(), token: localStorage.getItem('token') }, instances().map((i) => ({ url: i.url, token: tokenOf(i.id) })))
  return token ? { Authorization: token } : {}
}

/** Where a call goes: the hub (this origin), or a linked node (v7) chosen by `instance` or by the node-owned ids in the path/body. */
function target(path: string, body: unknown, instance?: string) {
  // Ids from servers end up in paths; one that walks out of its segment never leaves the client.
  if (!safePath(path)) throw new ApiError(0, { message: t('Request failed ({status})', { status: 0 }) })
  const node = instance ?? route(path, body)
  const info = instanceById(node)
  if (node && !info) throw new ApiError(0, null) // a node id of a node we no longer have: never to the hub
  const base = apiOrigin() + '/api/v9'
  return info ? { node: info.id, url: info.url + '/api/v9' + outboundPath(info.id, path), body: outbound(info.id, body) } : { node: undefined, url: base + path, body }
}

/** `reason` goes into the X-Audit-Log-Reason header (URL-encoded). `instance` sends the call to a linked node (v7). */
export async function api<T = unknown>(path: string, init: { method?: string; body?: unknown; reason?: string; instance?: string; headers?: Record<string, string> } = {}): Promise<T> {
  const to = target(path, init.body, init.instance)
  const headers = { ...init.headers, ...auth(to.url) }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'
  if (init.reason) headers['X-Audit-Log-Reason'] = encodeURIComponent(init.reason)
  let res: Response
  const sent = Date.now()
  try {
    // A node's redirect is not followed: the token was meant for that node only.
    res = await fetch(to.url, { method: init.method ?? 'GET', headers, body: to.body === undefined ? undefined : JSON.stringify(to.body), ...(to.node && { redirect: 'error' as const }) })
  } catch {
    throw new ApiError(0, null)
  }
  if (!to.node) clockSample(res.headers.get('Date'), sent, Date.now())
  if (res.status === 204) return undefined as T
  const data = to.node ? await nodeJson(res) : await res.json().catch(() => null)
  // A 200 that is not JSON means something other than the API answered (e.g. an SPA fallback).
  if (!res.ok || data === null) throw new ApiError(res.ok ? 0 : res.status, data)
  return (to.node ? admitted(to.node, data) : data) as T
}

// A node answer: at most 8 MB, then the node boundary (shape, ids, users); a refused one is an error, never applied.
const NODE_ANSWER_BYTES = 8 * 1024 * 1024
async function nodeJson(res: Response) {
  if (Number(res.headers.get('Content-Length') ?? 0) > NODE_ANSWER_BYTES) return null
  // Counted while it streams in: a node cannot make us buffer more than the limit.
  const reader = res.body?.getReader()
  if (!reader) return null
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > NODE_ANSWER_BYTES) return void reader.cancel().catch(() => {}), null
      chunks.push(value)
    }
    return JSON.parse(await new Blob(chunks as BlobPart[]).text())
  } catch {
    return null
  }
}
function admitted(node: string, data: unknown) {
  const d = admitRest(node, data)
  if (d === null) throw new ApiError(0, { message: t('{name} sent an invalid answer.', { name: instanceById(node)?.name ?? '' }) })
  return d
}

// Server clock offset (Watch Together sync) from the Date header. The header has 1 s resolution, so each answer bounds the
// offset to [D - received, D + 1000 - sent]; intersecting the bounds of many answers narrows it well below a second.
let lo = -Infinity
let hi = Infinity
function clockSample(date: string | null, sent: number, received: number) {
  const d = date ? Date.parse(date) : NaN
  if (Number.isNaN(d)) return
  const l = d - received
  const h = d + 1000 - sent
  if (l > hi || h < lo) (lo = l), (hi = h) // the clock jumped: start over
  else (lo = Math.max(lo, l)), (hi = Math.min(hi, h))
}
/** Milliseconds to add to Date.now() to get the server's time (0 until an answer carried a Date header). */
export const serverOffset = () => (Number.isFinite(lo) && Number.isFinite(hi) ? (lo + hi) / 2 : 0)

/** Multipart POST with upload progress (fetch has no upload progress events). */
export function upload<T>(path: string, form: FormData, onProgress: (fraction: number) => void = () => {}): Promise<T> {
  const to = target(path, undefined)
  // A node upload never follows a redirect (XHR would re-send the files elsewhere): fetch, without progress steps.
  if (to.node) {
    return fetch(to.url, { method: 'POST', headers: auth(to.url), body: form, redirect: 'error' }).then(async (res) => {
      if (res.status === 204) return undefined as T
      const data = await nodeJson(res)
      if (!res.ok || data === null) throw new ApiError(res.ok ? 0 : res.status, data)
      onProgress(1)
      return admitted(to.node!, data) as T
    }, () => { throw new ApiError(0, null) })
  }
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', to.url)
    for (const [k, v] of Object.entries(auth(to.url))) xhr.setRequestHeader(k, v)
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total)
    xhr.onerror = () => reject(new ApiError(0, null))
    xhr.onload = () => {
      let data = null
      try { data = JSON.parse(xhr.responseText) } catch { /* not JSON */ }
      if (xhr.status === 204) resolve(undefined as T)
      else if (xhr.status >= 200 && xhr.status < 300 && data) resolve(data as T)
      else reject(new ApiError(xhr.status, data))
    }
    xhr.send(form)
  })
}

/** Query string from params; arrays repeat the key like the search endpoint expects (`has=link&has=file`). */
export function qs(params: Record<string, string | number | boolean | (string | number)[] | undefined | null>) {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params))
    if (Array.isArray(v)) v.forEach((x) => q.append(k, String(x)))
    else if (v !== undefined && v !== null && v !== '') q.append(k, String(v))
  const s = q.toString()
  return s ? `?${s}` : ''
}

/** Reads a file as a data URI for avatar and icon uploads (contract: at most 8 MiB decoded). */
export function dataUri(file: File, maxBytes = 8 * 1024 * 1024, types = /^image\/(png|jpeg|gif|webp)$/): Promise<string> {
  if (file.size > maxBytes) return Promise.reject(new Error(t('Files must be {size} or smaller.', { size: formatLimit(maxBytes) })))
  if (!types.test(file.type)) return Promise.reject(new Error(types.source.includes('image') ? t('Use a PNG, JPEG, GIF or WebP image.') : t('That file type is not supported.')))
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error(t('Could not read the file.')))
    r.readAsDataURL(file)
  })
}

const formatLimit = (n: number) => (n >= 1024 * 1024 ? `${n / 1024 / 1024} MB` : `${n / 1024} KB`)
