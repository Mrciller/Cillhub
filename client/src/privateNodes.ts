// Saved private nodes (Settings › Private Nodes, `<origin>/add-node#<address>` links): a plain list, synced through the hub account.
// No imports: scripts/private-nodes.test.mjs runs this file under plain node.

/** Plain {origin, name}: a later stage attaches a session per node by origin. */
export type SavedNode = { origin: string; name: string }
export const MAX_NODES = 20

/** A typed server address as an origin: https:// added when missing, http only for localhost; null when unusable.
 *  `strict` (saved nodes, add links) also refuses a path, query, fragment or user info, so what is shown and saved is
 *  exactly the host the requests go to. */
export function normalizeServerUrl(raw: string, strict = false): string | null {
  const v = raw.trim()
  if (!v) return null
  try {
    const u = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(v) ? v : `https://${v}`)
    if (strict && (u.username || u.password || u.search || u.hash || u.pathname !== '/' || /[?#]/.test(v))) return null
    const local = u.hostname === 'localhost' || u.hostname.endsWith('.localhost') || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
    return u.protocol === 'https:' || (u.protocol === 'http:' && local) ? u.origin : null
  } catch {
    return null
  }
}

/** The list with `address` added at the end, or why not. */
export function addNode(list: SavedNode[], address: string, name: string): SavedNode[] | 'invalid' | 'duplicate' | 'full' {
  const origin = normalizeServerUrl(address, true)
  if (!origin) return 'invalid'
  if (list.some((n) => n.origin === origin)) return 'duplicate'
  if (list.length >= MAX_NODES) return 'full'
  return [...list, { origin, name: cleanName(name) }]
}

/** A node-supplied name as plain short text (rendered as text only, never as markup). */
export const cleanName = (name: unknown) => (typeof name === 'string' ? name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) : '')

/** The saved list from storage, dropping anything malformed. */
export function parseNodes(json: string | null): SavedNode[] {
  try {
    const v = JSON.parse(json ?? '[]')
    if (!Array.isArray(v)) return []
    const out: SavedNode[] = []
    for (const n of v) {
      const next = n && typeof n.origin === 'string' ? addNode(out, n.origin, n.name) : null
      if (Array.isArray(next)) out.splice(0, out.length, ...next)
    }
    return out
  } catch {
    return []
  }
}

/** The one-click add link a node owner hands out: `<origin>/add-node#<node origin>`. */
export const addLink = (origin: string, node: string) => `${origin.replace(/\/+$/, '')}/add-node#${node}`

/** The node origin from an add link's fragment (`location.hash`), or null. */
export function parseAddLink(hash: string): string | null {
  let v = hash.replace(/^#/, '')
  try {
    v = decodeURIComponent(v)
  } catch {
    return null
  }
  return normalizeServerUrl(v, true)
}

/** The token a request to `url` may carry, chosen by the URL's own origin (never by routing): the hub token only for the
 *  hub origin, a node token only for that node's origin; none for any other address or an origin two nodes share. */
export function tokenFor(url: string, hub: { origin: string; token: string | null }, nodes: { url: string; token: string | null }[]): string | null {
  let origin: string
  try {
    origin = new URL(url).origin
  } catch {
    return null
  }
  if (origin === hub.origin) return hub.token
  const own = nodes.filter((n) => normalizeServerUrl(n.url, true) === origin)
  return own.length === 1 ? own[0].token : null
}

/** A background sign-in or list change that finished may be used only in the hub session it started in (`session`: the hub
 *  token as stored, shared by all tabs, so a logout or login in any tab ends it) and, for a sign-in, only while its node is
 *  still saved; otherwise its token is revoked on the node. */
export const keepSignIn = (started: string, now: string, saved: SavedNode[], origin: string) => started === now && saved.some((n) => n.origin === origin)

/** A node session to end: the node's origin, its token, which hub account it was for (`owner`: hub origin and user). */
export type PendingRevoke = { owner: string; origin: string; token: string; tries: number }

/** Ends node sessions we will not keep. Each stays in `store` until the node confirmed (2xx, or 401: already gone) or
 *  gave a final answer (any other 4xx), so a reload resumes it; no answer (0: network error or timeout), 429 and 5xx are
 *  retried, 2 s doubling, `tries` times in all. At most 50 are kept. `send` posts and resolves the status. */
export function revocations(store: { get: () => string | null; set: (v: string) => void }, send: (url: string, token: string) => Promise<number>,
  wait = (ms: number) => new Promise((r) => setTimeout(r, ms)), tries = 5) {
  const read = (): PendingRevoke[] => {
    try {
      const v = JSON.parse(store.get() ?? '[]')
      return Array.isArray(v) ? v.filter((e) => e && normalizeServerUrl(String(e.origin), true) === e.origin && typeof e.token === 'string' && Number.isInteger(e.tries)).slice(-50) : []
    } catch {
      return []
    }
  }
  const write = (list: PendingRevoke[]) => { try { store.set(JSON.stringify(list.slice(-50))) } catch { /* storage full or off */ } }
  const drop = (token: string) => write(read().filter((e) => e.token !== token))
  const running = new Set<string>()
  async function run(e: PendingRevoke): Promise<boolean> {
    if (running.has(e.token)) return true
    running.add(e.token)
    try {
      for (let i = e.tries; i < tries; i++) {
        const status = await send(`${e.origin}/api/v9/auth/logout`, e.token).catch(() => 0)
        if ((status >= 200 && status < 300) || status === 401) return drop(e.token), true
        if (status !== 0 && status !== 429 && status < 500) return drop(e.token), false
        write(read().map((x) => (x.token === e.token ? { ...x, tries: i + 1 } : x)))
        if (i < tries - 1) await wait(Math.min(60_000, 2000 * 2 ** i))
      }
      return drop(e.token), false
    } finally {
      running.delete(e.token)
    }
  }
  return {
    add: (e: Omit<PendingRevoke, 'tries'>) => (write([...read().filter((x) => x.token !== e.token), { ...e, tries: 0 }]), run({ ...e, tries: 0 })),
    resume: () => Promise.all(read().map(run)),
  }
}

/** Runs `steps` one after another, each only while the session it started in (`started`, read again with `now` right
 *  before each step) is still current; false when one was skipped. */
export async function inSession(started: string, now: () => string, steps: (() => Promise<unknown>)[]) {
  for (const step of steps) {
    if (now() !== started) return false
    await step()
  }
  return now() === started
}

/** A node's gateway address must be on the node itself: same host and port, wss for an https node (ws or wss for a local
 *  http one). */
export function gatewayOk(nodeUrl: string, gateway: string) {
  try {
    const n = new URL(nodeUrl)
    const g = new URL(gateway)
    const scheme = n.protocol === 'https:' ? g.protocol === 'wss:' : g.protocol === 'ws:' || g.protocol === 'wss:'
    return scheme && g.hostname === n.hostname && (g.port || (g.protocol === 'wss:' ? '443' : '80')) === (n.port || (n.protocol === 'https:' ? '443' : '80')) && !g.username && !g.password
  } catch {
    return false
  }
}

/** An API path whose segments cannot walk elsewhere once the URL is resolved (`..`, `.`, encoded slashes or dots, backslashes). */
export const safePath = (path: string) => !path.split('?')[0].split('/').some((seg) => seg === '.' || seg === '..' || /%2e|%2f|%5c|\\/i.test(seg))
