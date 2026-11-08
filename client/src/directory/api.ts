// Server directory on the hub (CONTRACT-v7 §5), following the reference user API's discovery routes and shapes (discovery.mdx in the API docs)
// with Cillhub additions: `node` on each listing, ready-to-use `icon_url`/`banner_url` (the hub's media proxy for node
// servers), `listed`/`hidden` in the discovery metadata, string-free integer categories from GET /discovery/categories.
import { api, qs } from '../api'
import type { NodeRecord } from '../instances/nodes'

export type Category = { id: number; name: string; is_primary?: boolean }
export type Listing = {
  id: string; name: string; description: string | null; icon: string | null; banner?: string | null; icon_url?: string | null; banner_url?: string | null
  keywords: string[] | null; preferred_locale: string; approximate_member_count: number; approximate_presence_count?: number; primary_category_id: number
  node: Pick<NodeRecord, 'node_id' | 'name' | 'url' | 'icon' | 'status' | 'online'> | null
}
/** Discovery metadata + Cillhub: `listed`, `hidden` (by the hub admins), `preferred_locale` (the listing's language). */
export type Metadata = { guild_id: string; listed: boolean; hidden?: boolean; hidden_reason?: string | null; primary_category_id: number; keywords: string[] | null; preferred_locale?: string | null }

// Used when the hub does not answer GET /discovery/categories (ids are the hub's; these match its defaults).
export const FALLBACK_CATEGORIES: Category[] = [
  { id: 1, name: 'Esports' }, { id: 2, name: 'Gaming' }, { id: 3, name: 'Community' }, { id: 4, name: 'Music' }, { id: 5, name: 'Education' },
  { id: 6, name: 'Science & Tech' }, { id: 7, name: 'Art' }, { id: 8, name: 'Entertainment' }, { id: 9, name: 'Other' },
]
export const LANGUAGES: [string, string][] = [['en-US', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['es-ES', 'Español'], ['it', 'Italiano'], ['nl', 'Nederlands'], ['pl', 'Polski'], ['pt-BR', 'Português'], ['tr', 'Türkçe']]

export const categories = () => api<Category[]>('/discovery/categories').catch(() => FALLBACK_CATEGORIES)
export const search = (q: { query?: string; category_id?: number; locale?: string; offset?: number }) =>
  api<{ guilds: Listing[]; total: number; limit: number; offset: number }>(`/discoverable-guilds${qs({ ...q, limit: 24 })}`)
export const report = (guildId: string, reason: string) => api(`/discoverable-guilds/${guildId}/report`, { method: 'POST', body: { reason } })
/** Join Guild (user docs): a guild payload when newly joined, 204 when already a member. */
export const joinListed = (guildId: string) => api<import('../types').GuildPayload | undefined>(`/guilds/${guildId}/members/@me`, { method: 'PUT' })

// Listing a server (Server Settings → Server Directory); for node servers these go to the node, which tells the hub.
export const getMetadata = (guildId: string) => api<Metadata>(`/guilds/${guildId}/discovery-metadata`)
export const saveMetadata = (guildId: string, body: Pick<Metadata, 'listed' | 'primary_category_id' | 'keywords' | 'preferred_locale'>) =>
  api<Metadata>(`/guilds/${guildId}/discovery-metadata`, { method: 'PATCH', body })
