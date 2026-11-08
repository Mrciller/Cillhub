// Instance administration (CONTRACT-v6 §0): REST calls and shapes for the admin dashboard, the public instance info and
// message reports, matching server/src/routes/admin.js and server/src/instance.js. All admin routes are under /api/v9/admin
// and need instance_admin + 2FA (403 60003 without 2FA). Destructive ones also want a fresh 2FA `code` (401 60003 without).
import { api, ApiError, qs, upload } from '../api'
import type { Role, User } from '../types'

export type Registration = 'open' | 'invite' | 'closed'
export type Announcement = { id: string; content: string; created_at: string }
/** GET /instance (no auth), READY.instance and INSTANCE_SETTINGS_UPDATE. */
export type PublicInstance = {
  name: string; motd: string | null; registration_mode: Registration; gifs_enabled?: boolean; max_upload_bytes?: number; announcement: Announcement | null
  /** v7: true until the first-run wizard is finished (only /setup works then). */
  setup_pending?: boolean
  /** Voice servers this instance has; servers can pick one of them (Server Settings, Overview). */
  voice?: { configured: string[]; default: string | null }
  /** v7: `hub` = the owner's instance (server directory, node admin); `node` = a self-hosted instance (standalone or connected). */
  federation?: { role: 'hub' | 'node'; mode: 'standalone' | 'connected' | null; hub_url: string | null }
}
export type InstanceSettings = {
  registration_mode: Registration; instance_name: string; motd: string | null; max_upload_bytes: number; gifs_enabled: boolean
  voice_backend: 'livekit' | 'cillvoice' | null; announcement: Announcement | null; voice: { configured: string[]; default: string | null }
}

export type Overview = {
  users: { total: number; bots: number; disabled: number; active_24h: number; active_7d: number; online: number }
  guilds: number; channels: number
  messages: { total: number; per_day: { date: string; count: number }[] } // oldest first, YYYY-MM-DD
  voice: {
    in_voice_now: number; minutes_30d: number
    backends: { configured: string[]; default: string | null; livekit: { configured: boolean; reachable: boolean | null }; cillvoice: { configured: boolean; running?: boolean; rooms?: number } }
  }
  reports_open: number
  storage: { uploads_bytes: number; database_bytes: number }
  disk: { total_bytes: number; free_bytes: number } | null
  version: string; uptime_seconds: number
  recent_errors: { at: string; message: string }[]
}

export type AdminUser = {
  id: string; username: string; global_name: string | null; avatar: string | null; email: string | null; created_at: string; last_seen: string | null
  bot: boolean; mfa_enabled: boolean; disabled: boolean; deleted: boolean; instance_admin: boolean; require_password_change: boolean
  guild_count: number; application_count: number; online: boolean
}
export type AuditEntry = { id: string; admin_id: string | null; action: string; target_type: string | null; target_id: string | null; details: Record<string, unknown> | null; created_at: string }
export type AdminUserDetail = AdminUser & {
  guilds: { id: string; name: string; icon: string | null; owner: boolean }[]
  sessions: { id_hash: string; created_at: string | null; approx_last_used_time: string | null; client_info: { os: string | null; platform: string | null } }[]
  applications: { id: string; name: string }[]
  audit_log: AuditEntry[]
}
export type AdminGuild = {
  id: string; name: string; icon: string | null; description: string | null; created_at: string; owner: Pick<User, 'id' | 'username' | 'global_name'> | null
  member_count: number; channel_count: number; message_count: number; storage_bytes: number; invites_disabled: boolean
}
export type AdminGuildDetail = AdminGuild & {
  settings: { verification_level?: number; features?: string[] }
  roles: Role[]; emoji_count: number; sticker_count: number
  channels: { id: string; type: number; name: string; parent_id: string | null; position: number; nsfw: boolean }[] // no content
  invites: { code: string; channel_id: string; inviter_id: string | null; uses: number; max_uses: number; created_at: string; expires_at: string | null }[]
  bans: { user: User; reason: string | null }[]
  audit_log: { id: string; user_id: string | null; target_id: string | null; action_type: number; reason?: string | null }[]
}
export type ReportReason = 'spam' | 'harassment' | 'hate' | 'nsfw' | 'violence' | 'self_harm' | 'illegal' | 'impersonation' | 'other'
export type ReportAction = 'dismiss' | 'delete_message' | 'timeout' | 'kick' | 'ban' | 'disable_account'
export type Report = {
  id: string; status: 'open' | 'resolved'; reason: ReportReason; note: string | null; created_at: string
  actions: { action: ReportAction; admin_id: string; at: string; note: string | null }[]
  reporter: User; author: User | null; guild: { id: string; name: string } | null; channel: { id: string; type?: number; name?: string | null }
  /** A copy taken when the report was made; `exists` is false once the original is deleted. */
  message: { id: string; content: string; timestamp: string; attachments?: { filename: string }[]; exists: boolean }
  link: string
}
export type RegistrationCode = { code: string; created_by: string; created_at: string; expires_at: string | null; max_uses: number; uses: number; note: string | null }

// 403 60003: this admin has no 2FA (the dashboard shows the explanation screen). 401 60003 is the per-action code prompt.
const mfaListeners = new Set<() => void>()
export const onMfaRequired = (l: () => void) => (mfaListeners.add(l), () => void mfaListeners.delete(l))
const watch = <T>(p: Promise<T>) => p.catch((e: unknown) => {
  if (e instanceof ApiError && e.status === 403 && e.code === 60003) mfaListeners.forEach((l) => l())
  throw e
})
const admin = <T>(path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => watch(api<T>('/admin' + path, init))
const post = <T = AdminUser>(path: string, body: unknown = {}) => admin<T>(path, { method: 'POST', body })

export const getOverview = () => admin<Overview>('/overview')

export const listUsers = (query: string, before?: string) => admin<AdminUser[]>(`/users${qs({ query, limit: 50, before })}`)
export const getUser = (id: string) => admin<AdminUserDetail>(`/users/${id}`)
export const disableUser = (id: string) => post(`/users/${id}/disable`)
export const enableUser = (id: string) => post(`/users/${id}/enable`)
export const logoutUser = (id: string) => post(`/users/${id}/logout`)
export const resetUserMfa = (id: string, code: string) => post(`/users/${id}/reset-mfa`, { code })
export const requirePasswordChange = (id: string) => post(`/users/${id}/require-password-change`, { required: true })
export const deleteUser = (id: string, confirm: string, code: string) => admin<void>(`/users/${id}`, { method: 'DELETE', body: { confirm, code } })

export const listGuilds = (query: string, before?: string) => admin<AdminGuild[]>(`/guilds${qs({ query, limit: 50, before })}`)
export const getGuild = (id: string) => admin<AdminGuildDetail>(`/guilds/${id}`)
export const transferGuild = (id: string, owner_id: string, code: string) => post<AdminGuild>(`/guilds/${id}/transfer`, { owner_id, code })
export const setInvitesDisabled = (id: string, disabled: boolean) => admin<AdminGuild>(`/guilds/${id}/invites-disabled`, { method: 'PUT', body: { disabled } })
export const deleteGuild = (id: string, confirm: string, code: string) => admin<void>(`/guilds/${id}`, { method: 'DELETE', body: { confirm, code } })

export const listReports = (status: Report['status']) => admin<Report[]>(`/reports${qs({ status })}`)
export const resolveReport = (id: string, action: ReportAction, duration_seconds?: number) => post<Report>(`/reports/${id}/resolve`, { action, duration_seconds })

export const getSettings = () => admin<InstanceSettings>('/settings')
export const saveSettings = (patch: Partial<Pick<InstanceSettings, 'registration_mode' | 'instance_name' | 'motd' | 'max_upload_bytes' | 'gifs_enabled' | 'voice_backend'>>) =>
  admin<InstanceSettings>('/settings', { method: 'PATCH', body: patch })
export const listCodes = () => admin<RegistrationCode[]>('/registration-codes')
/** max_uses 0 = unlimited, max_age in seconds (0 = never expires). */
export const createCode = (max_uses: number, max_age: number) => post<RegistrationCode>('/registration-codes', { max_uses, max_age })
export const deleteCode = (code: string) => admin<void>(`/registration-codes/${encodeURIComponent(code)}`, { method: 'DELETE' })

export const sendAnnouncement = (content: string, dm: boolean) => post<{ announcement: Announcement; dm_count: number }>('/announcements', { content, dm })
export const clearAnnouncement = () => admin<void>('/announcements', { method: 'DELETE' })

export const auditLog = (f: { action?: string; admin_id?: string; target_id?: string; before?: string }) => admin<AuditEntry[]>(`/audit-log${qs({ ...f, limit: 100 })}`)

// Public / every user
export const getInstance = () => api<PublicInstance>('/instance')
export const reportMessage = (channelId: string, messageId: string, body: { reason: ReportReason; note?: string }) =>
  api<{ id: string }>(`/channels/${channelId}/messages/${messageId}/report`, { method: 'POST', body })

// ---------- v7 (CONTRACT-v7 §2, §5, §6): hub Nodes, link codes, release channel + directory moderation; node Federation + Updates ----------
// Shapes and routes as in server/README.md → Deviations → v7.
export type NodeState = 'active' | 'suspended' | 'banned' | 'unlinked'
/** The node directory record (§2) plus admin-only fields. */
export type AdminNode = {
  node_id: string; name: string; url: string; description: string | null; icon: string | null; version: string | null; mode: 'connected' | 'standalone'
  public_servers_count: number; member_count: number; online: boolean; last_seen: string | null; status: NodeState
  sign_in: 'local' | 'hub' | 'both' | null; status_reason: string | null; linked_at: string | null; users_count: number; servers_count: number
  /** The node's last update report (heartbeat), null before its first report. */
  update: NodeUpdateReport | null
}
export type AutoUpdateMode = 'off' | 'patch' | 'all'
export type LastAuto = { at: string | null; version: string | null; decision: string | null }
export type NodeUpdateReport = {
  updater: boolean; auto_update: AutoUpdateMode | null; auto_update_hour: number | null; remote_update: boolean; latest_version: string | null
  last_result: { action: 'update' | 'rollback' | null; version: string | null; state: Updates['state'] | null; rolled_back: boolean | null; error: string | null; at: string | null } | null
  last_auto: LastAuto | null; reported_at: string
}
/** `code` is only in the answer that created it. */
export type LinkCode = {
  id: string; code?: string; created_by: string | null; created_at: string; expires_at: string; used_at: string | null; node_id: string | null
  note: string | null; status: 'valid' | 'used' | 'expired'
}
export type DirectoryEntry = {
  guild: import('../directory/api').Listing; hidden: boolean; hidden_reason?: string | null
  reports: { id: string; reason: string; note?: string | null; reporter_id: string; created_at: string }[]
}
export type Federation = {
  role: 'node'; mode: 'standalone' | 'connected'; hub_url: string | null; node_id: string | null; hub_name: string | null
  hub_status: 'linked' | 'unlinked' | 'suspended' | 'banned' | 'unreachable'; last_heartbeat: string | null; last_error: string | null
  sign_in: 'local' | 'hub' | 'both'; update_check: boolean
}
export type HubFederation = { role: 'hub'; url: string; public_key: string; user_link_codes: boolean; release: Release | null; nodes: Partial<Record<NodeState, number>> }
export type Release = { version: string; notes: string; published_at: string }
/** The updater sidecar's state (selfhost/README.md → Updater) merged with the server's view. */
export type Updates = {
  updater: boolean; reachable?: boolean; error?: string | null; current_version: string; auto_check: boolean
  auto_update: AutoUpdateMode; auto_update_hour: number; remote_update: boolean; last_auto: LastAuto | null
  last_check: { at: string; latest?: { version: string; notes: string; size?: number; min_upgrade_from?: string | null }; update_available?: boolean; can_update?: boolean; error: string | null } | null
  state?: 'idle' | 'updating' | 'rolling_back' | 'done' | 'failed'; action?: 'update' | 'rollback' | null; target_version?: string | null; step?: string | null
  rolled_back?: boolean; logs?: string | null; started_at?: string | null; finished_at?: string | null
  previous?: { image: string; version: string } | null; backup?: string | null
}

export const listNodes = (status?: string) => admin<AdminNode[]>(`/federation/nodes${qs({ status })}`)
export const suspendNode = (id: string, reason: string) => post<AdminNode>(`/federation/nodes/${id}/suspend`, { reason })
export const unsuspendNode = (id: string) => post<AdminNode>(`/federation/nodes/${id}/unsuspend`)
export const banNode = (id: string, reason: string, code: string) => post<AdminNode>(`/federation/nodes/${id}/ban`, { reason, code })
export const unlinkNode = (id: string, code: string) => post<AdminNode>(`/federation/nodes/${id}/unlink`, { code })
/** A signed update request to the node; `result` is the node's answer (202 accepted, 403 turned off there, …). */
export const requestNodeUpdate = (id: string, code: string) =>
  post<{ node: AdminNode; result: { status: number; accepted: boolean; message: string | null } }>(`/federation/nodes/${id}/update`, { code })
export const listLinkCodes = () => admin<LinkCode[]>('/federation/link-codes')
export const createLinkCode = (note?: string) => post<LinkCode>('/federation/link-codes', { note })
export const deleteLinkCode = (id: string) => admin<void>(`/federation/link-codes/${id}`, { method: 'DELETE' })
export const getHubFederation = () => admin<HubFederation>('/federation')
export const setUserLinkCodes = (user_link_codes: boolean) => admin<HubFederation>('/federation', { method: 'PATCH', body: { user_link_codes } })
// GET /admin/federation/release answers a bare null when nothing is offered yet; the federation view carries it as a field
export const getRelease = () => getHubFederation().then((f) => f.release)
export const putRelease = (version: string, notes: string) => admin<Release>('/federation/release', { method: 'PUT', body: { version, notes } })

export const listDirectory = (query: string, filter: 'all' | 'reported' | 'hidden') => admin<DirectoryEntry[]>(`/directory${qs({ query, filter })}`)
export const setListingHidden = (guildId: string, hidden: boolean, reason?: string) => admin<DirectoryEntry>(`/directory/${guildId}`, { method: 'PATCH', body: { hidden, reason } })
export const dismissListingReports = (guildId: string) => admin<void>(`/directory/${guildId}/reports`, { method: 'DELETE' })

export const getFederation = () => admin<Federation>('/federation')
export const patchFederation = (patch: Partial<Pick<Federation, 'sign_in' | 'update_check'>>) => admin<Federation>('/federation', { method: 'PATCH', body: patch })
export const linkHub = (hub_url: string, link_code: string) => post<Federation>('/federation/link', { hub_url, link_code })
export const unlinkHub = (code: string) => post<Federation>('/federation/unlink', { code })

export const getUpdates = () => admin<Updates>('/updates')
export const checkUpdates = () => post<NonNullable<Updates['last_check']>>('/updates/check')
export const applyUpdate = (version: string, code: string) => post<Updates>('/updates/apply', { version, code })
export const rollbackUpdate = (code: string) => post<Updates>('/updates/rollback', { code })
export const patchUpdates = (patch: Partial<Pick<Updates, 'auto_check' | 'auto_update' | 'auto_update_hour' | 'remote_update'>>) =>
  admin<Updates>('/updates', { method: 'PATCH', body: patch })

// ---------- v8 (CONTRACT-v8 §2): modules ----------
export type ModuleStatus = 'disabled' | 'starting' | 'running' | 'restarting' | 'crashed'
export type PanelSlot = 'channel_panel' | 'guild_sidebar' | 'message_accessory'
export type SettingType = 'text' | 'number' | 'toggle' | 'select' | 'channel' | 'role' | 'user' | 'secret'
/** One entry of a manifest's `settings` (§5). */
export type SettingSchema = {
  key: string; type: SettingType; label: string; description?: string; required?: boolean; default?: unknown; per_server?: boolean
  max_length?: number; multiline?: boolean; placeholder?: string; min?: number; max?: number; integer?: boolean
  options?: { value: string; label: string }[]; channel_types?: number[]
}
/** Setting values as the admin API returns them: a secret is `{set: boolean}`, never its value. */
export type SettingValues = Record<string, unknown>
export type ModuleSource = { type: 'file' | 'git'; filename: string | null; git_url: string | null; git_ref: string | null; commit: string | null }
export type ModuleCommand = { name: string; type?: number; description?: string }
export type AdminModule = {
  id: string; name: string; version: string; description: string | null; author: string | null; homepage: string | null
  application_id: string; icon: string | null; source: ModuleSource; permissions: string[]; http_hosts: string[]
  enabled: boolean; status: ModuleStatus; status_reason: string | null; scope: 'all' | 'guilds'; guild_ids: string[]; per_server_settings: boolean
  settings_schema: SettingSchema[]; settings: SettingValues; commands: ModuleCommand[]; panels: { id: string; slot: PanelSlot; title: string }[]
  http_url: string | null; storage: { used_bytes: number; quota_bytes: number }
  stats: { started_at: string | null; events: number; errors: number; crashes: number; restarts: number; last_error: string | null; last_error_at: string | null }
  installed_at: string; updated_at: string
}
/** The validated manifest of a staged package (§1); only the fields the review shows. */
export type Manifest = {
  id: string; name: string; version: string; description?: string; author?: string; homepage?: string
  commands?: ModuleCommand[]; settings?: SettingSchema[]; ui?: { panels?: { id: string; slot: PanelSlot; title: string }[] }
}
export type ModulePackage = {
  package_id: string; expires_at: string; source: ModuleSource; manifest: Manifest; permissions: string[]; http_hosts: string[]; files: number; size: number
  update_of: { module_id: string; from_version: string; added_permissions: string[]; removed_permissions: string[]; added_http_hosts: string[]; removed_http_hosts: string[] } | null
  warnings: string[]
}
export type ModuleLog = { id: string; at: string; level: 'debug' | 'info' | 'warn' | 'error' | 'system'; message: string }
export type Approval = { permissions: string[]; http_hosts: string[] }

const MODS = '/modules'
const mod = (id: string) => `${MODS}/${encodeURIComponent(id)}`
/** The fresh 2FA elevation of install, update and remove (§2), sent as X-Cillhub-MFA-Authorization. */
const elevation = (token?: string) => (token ? { 'X-Cillhub-MFA-Authorization': token } : undefined)

export const listModules = () => admin<AdminModule[]>(MODS)
export const getModule = (id: string) => admin<AdminModule>(mod(id))
/** Stages an uploaded .zip/.tgz (optionally as an update of `moduleId`); nothing is installed yet. */
export function stageFile(file: File, moduleId?: string) {
  const form = new FormData()
  form.append('file', file)
  if (moduleId) form.append('module_id', moduleId)
  return watch(upload<ModulePackage>('/admin' + MODS + '/packages', form))
}
export const stageGit = (git_url: string, git_ref?: string) => post<ModulePackage>(MODS + '/packages', { git_url, ...(git_ref && { git_ref }) })
/** Fetches an update from the module's stored Git source. */
export const stageGitUpdate = (module_id: string) => post<ModulePackage>(MODS + '/packages', { module_id })
export const installModule = (package_id: string, approve: Approval, mfa?: string) => admin<AdminModule>(MODS, { method: 'POST', body: { package_id, approve }, headers: elevation(mfa) })
export const updateModulePackage = (id: string, package_id: string, approve: Approval, mfa?: string) =>
  admin<AdminModule>(mod(id) + '/package', { method: 'PUT', body: { package_id, approve }, headers: elevation(mfa) })

export type CatalogModule = {
  id: string; name: string; version: string; description?: string; author?: string; verified: boolean; permissions: string[]; http_hosts: string[]
}
export const getModuleCatalog = () => admin<CatalogModule[]>('/modules/catalog')
export const installFromCatalog = (module_id: string) => post<ModulePackage>(MODS + '/install-from-catalog', { module_id })
export const removeModule = (id: string, keep_data: boolean, mfa?: string) => admin<void>(mod(id), { method: 'DELETE', body: { confirm: id, keep_data }, headers: elevation(mfa) })
export const patchModule = (id: string, patch: Partial<Pick<AdminModule, 'enabled' | 'scope' | 'guild_ids' | 'per_server_settings'>>) => admin<AdminModule>(mod(id), { method: 'PATCH', body: patch })
export const restartModule = (id: string) => post<AdminModule>(mod(id) + '/restart')
export const putModuleSettings = (id: string, values: SettingValues) => admin<AdminModule>(mod(id) + '/settings', { method: 'PUT', body: { values } })
export const getGuildSettings = (id: string, guildId: string) => admin<{ guild_id: string; values: SettingValues }>(`${mod(id)}/guilds/${guildId}/settings`)
export const putGuildSettings = (id: string, guildId: string, values: SettingValues) =>
  admin<{ guild_id: string; values: SettingValues }>(`${mod(id)}/guilds/${guildId}/settings`, { method: 'PUT', body: { values } })
export const resetGuildSettings = (id: string, guildId: string) => admin<void>(`${mod(id)}/guilds/${guildId}/settings`, { method: 'DELETE' })
export const moduleLogs = (id: string, before?: string) => admin<ModuleLog[]>(`${mod(id)}/logs${qs({ limit: 200, before })}`)

/**
 * Runs an install/update/remove call; when the server asks for 2FA (401 60003 with a ticket) it asks for the code, trades it
 * for an elevation token at POST /mfa/finish and repeats the call with it. Resolves null when the admin cancels.
 */
export async function elevated<T>(call: (mfa?: string) => Promise<T>, ask: () => Promise<string | null>): Promise<T | null> {
  try {
    return await call()
  } catch (e) {
    if (!(e instanceof ApiError && e.status === 401 && e.code === 60003 && e.ticket)) throw e
    const code = await ask()
    if (!code) return null
    const { token } = await api<{ token: string }>('/mfa/finish', { method: 'POST', body: { ticket: e.ticket, mfa_type: /^\d{6}$/.test(code) ? 'totp' : 'backup', data: code } })
    return call(token)
  }
}
