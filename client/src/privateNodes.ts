// Saved private nodes (Settings › Private Nodes, `<origin>/add-node#<address>` links): a plain per-device list.
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
