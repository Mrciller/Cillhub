// 7.10.3 legal: REST calls and shapes, matching server/src/routes/legal.js.
import { api } from '../api'

export type LegalDocId = 'imprint' | 'privacy' | 'terms'
/** GET /instance → legal (no login). */
export type LegalInfo = {
  imprint: boolean; privacy: boolean; terms: boolean; accept_version: number | null
  operator_name: string | null; contact_email: string | null; contact_languages: string | null; min_age: number; source_url: string | null
}
export type LegalDoc = { doc: LegalDocId; version: number | null; en: string; de: string; hash: string | null; updated_at: string | null }
export type LegalStatus = { required: boolean; needs_age: boolean; accept_version: number | null; accepted_version: number | null; accepted_at: string | null; min_age: number }
export type Operator = Partial<Record<'name' | 'legal_form' | 'address' | 'email' | 'phone' | 'register' | 'representatives' | 'purpose' | 'authority' | 'languages', string>>
export type Features = {
  captcha: boolean; mail: boolean; push: boolean; fcm: boolean; gif_provider: 'giphy' | 'tenor' | null; voice: string[]; watch_together: boolean; link_previews: boolean
  federation: { role: 'hub' | 'node'; mode: string; sign_in: string | null }; module_hosts: string[]
}
export type AdminLegal = {
  documents: Record<LegalDocId, (Omit<LegalDoc, 'doc'>) | null>
  versions: { id: number; doc: LegalDocId; hash: string; reaccept: boolean; created_by: string | null; created_at: string }[]
  features: Features
}
export type NoticeCategory = 'child_abuse' | 'terrorism' | 'hate_speech' | 'violence' | 'privacy' | 'intellectual_property' | 'fraud' | 'other_illegal'
export type NoticeStatus = { id: string; category: NoticeCategory; status: 'open' | 'resolved'; created_at: string; resolved_at: string | null; decision: string | null }
export type Decision = {
  id: string; action: string; category: string; ground: 'terms' | 'illegal'; reason: string; created_at: string; appeal_until: string
  appeal: { status: 'open' | 'upheld' | 'reversed'; text: string; at: string; decision: string | null; decided_at: string | null } | null
}
export type Statement = { category: string; ground: 'terms' | 'illegal'; reason: string }

export const getDoc = (doc: LegalDocId) => api<LegalDoc>(`/legal/${doc}`)
export const getLicenses = () => api<{ license: string | null; notice: string | null; source_url: string | null }>('/legal/licenses')
export const legalStatus = () => api<LegalStatus>('/legal/status')
export const acceptTerms = (version: number | null, age_confirmed?: boolean) => api<LegalStatus>('/legal/accept', { method: 'POST', body: { version, age_confirmed } })
export const sendNotice = (body: Record<string, unknown>) => api<{ id: string; code: string; status_url: string; receipt_mailed: boolean }>('/legal/notices', { method: 'POST', body })
export const noticeStatus = (code: string) => api<NoticeStatus>('/legal/notices/status', { method: 'POST', body: { code } })
export const lookupAppeal = (code: string) => api<Decision>('/legal/appeals/lookup', { method: 'POST', body: { code } })
export const fileAppeal = (code: string, text: string) => api<Decision>('/legal/appeals', { method: 'POST', body: { code, text } })

export const getAdminLegal = () => api<AdminLegal>('/admin/legal')
export const putDoc = (doc: LegalDocId, body: { en: string; de: string; reaccept?: boolean }) =>
  api<LegalDoc & { created: boolean }>(`/admin/legal/${doc}`, { method: 'PUT', body })

/** The text in the reader's language, else the other one. */
export const pick = (d: { en: string; de: string }, lang: 'de' | 'en') => (lang === 'de' ? d.de.trim() || d.en : d.en.trim() || d.de)
