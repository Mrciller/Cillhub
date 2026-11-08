import { useEffect, useState } from 'react'
import { t } from '../i18n'
import { createSnippet, deleteSnippet, fetchSnippets, patchGuild } from '../actions'
import { toastError } from '../components/dialogs'
import { cdn, dataUri } from '../api'
import { FormError, GuildIcon } from '../components/ui'
import { has, P } from '../permissions'
import { usePerms } from '../selectors'
import { cmpId, useStore } from '../store'
import type { Guild, Snippet } from '../types'
import { AuditLogPage } from './AuditLog'
import { AutoModPage } from './AutoMod'
import { VanityPage, WelcomeScreenPage } from './Community'
import { EmojiPage, SoundboardPage, StickersPage } from './Expressions'
import { SettingsLayout, type TabDef } from './Layout'
import { Bans, Invites, Members } from './Members'
import { Roles } from './Roles'
import { SafetyPage } from './Safety'
import { WebhooksPage } from './Webhooks'
import { CillcordBotSection } from '../bot/CillcordBot'
import { TemplatePage } from '../templates/Templates'
import './settings-v3.css'
import { ServerCustomizePage } from '../custom/ServerCustomize'
import { useInstance } from '../admin/instance'
import { DirectoryListingPage } from '../directory/Listing'
import { nodeOf } from '../instances/registry'
import { OnboardingPage } from './OnboardingPage'
import { AnalyticsPage } from './AnalyticsPage'

export function ServerSettings({ guildId, tab: initial, onClose }: { guildId: string; tab?: string; onClose: () => void }) {
  const guild = useStore((s) => s.guilds[guildId])
  const perms = usePerms(guildId)
  const manage = has(perms, P.MANAGE_GUILD)
  const expressions = has(perms, P.MANAGE_GUILD_EXPRESSIONS) || has(perms, P.CREATE_GUILD_EXPRESSIONS)
  // v7: hub servers and servers on linked nodes (in the hub client or on the connected node itself) can be listed in the hub's directory.
  const fed = useInstance()?.federation
  const directory = manage && (fed?.role === 'hub' || fed?.mode === 'connected' || !!nodeOf(guildId))
  const tabs: TabDef[] = [
    ...(manage ? [{ id: 'overview', label: t('Overview') }] : []),
    ...(manage || has(perms, P.MANAGE_GUILD_EXPRESSIONS) ? [{ id: 'customize', label: t('Customization') }] : []),
    ...(has(perms, P.MANAGE_ROLES) ? [{ id: 'roles', label: t('Roles') }] : []),
    ...(expressions ? [{ id: 'emoji', label: t('Emoji') }, { id: 'stickers', label: t('Stickers') }, { id: 'soundboard', label: t('Soundboard') }] : []),
    ...(has(perms, P.MANAGE_WEBHOOKS) || manage ? [{ id: 'integrations', label: t('Integrations') }] : []),
    ...(manage ? [{ id: 'template', label: t('Server Template') }] : []),
    ...(manage ? [{ id: 'safety', label: t('Safety Setup'), section: t('Moderation') }, { id: 'automod', label: t('AutoMod'), section: t('Moderation') }] : []),
    ...(has(perms, P.VIEW_AUDIT_LOG) ? [{ id: 'audit', label: t('Audit Log'), section: t('Moderation') }] : []),
    ...(manage ? [{ id: 'welcome', label: t('Welcome Screen'), section: t('Community') }, { id: 'vanity', label: t('Vanity URL'), section: t('Community') }] : []),
    ...(manage ? [{ id: 'onboarding', label: t('Onboarding'), section: t('Community') }, { id: 'analytics', label: t('Analytics'), section: t('Community') }] : []),
    ...(manage ? [{ id: 'snippets', label: t('Text Snippets / FAQ'), section: t('Community') }] : []),
    ...(perms & (P.KICK_MEMBERS | P.BAN_MEMBERS | P.MANAGE_ROLES | P.MANAGE_NICKNAMES | P.MODERATE_MEMBERS) ? [{ id: 'members', label: t('Members'), section: t('User Management') }] : []),
    ...(has(perms, P.BAN_MEMBERS) ? [{ id: 'bans', label: t('Bans'), section: t('User Management') }] : []),
    ...(manage ? [{ id: 'invites', label: t('Invites'), section: t('User Management') }] : []),
    ...(directory ? [{ id: 'directory', label: t('Server Directory'), section: t('Community') }] : []),
  ]
  const [tab, setTab] = useState(initial && tabs.some((x) => x.id === initial) ? initial : tabs[0]?.id ?? '')
  if (!guild) return null
  return (
    <SettingsLayout title={guild.name} tabs={tabs} tab={tab} setTab={setTab} onClose={onClose}>
      {tab === 'overview' && <Overview guild={guild} />}
      {tab === 'customize' && <ServerCustomizePage guild={guild} />}
      {tab === 'roles' && <Roles guild={guild} />}
      {tab === 'emoji' && <EmojiPage guild={guild} />}
      {tab === 'stickers' && <StickersPage guild={guild} />}
      {tab === 'soundboard' && <SoundboardPage guild={guild} />}
      {tab === 'integrations' && (
        <>
          <h1>{t('Integrations')}</h1>
          {manage && <CillcordBotSection guild={guild} />}
          {has(perms, P.MANAGE_WEBHOOKS) && <WebhooksPage guild={guild} />}
        </>
      )}
      {tab === 'template' && <TemplatePage guild={guild} />}
      {tab === 'safety' && <SafetyPage guild={guild} />}
      {tab === 'automod' && <AutoModPage guild={guild} />}
      {tab === 'audit' && <AuditLogPage guild={guild} />}
      {tab === 'welcome' && <WelcomeScreenPage guild={guild} />}
      {tab === 'onboarding' && <OnboardingPage guild={guild} />}
      {tab === 'analytics' && <AnalyticsPage guild={guild} />}
      {tab === 'snippets' && <SnippetsPage guild={guild} />}
      {tab === 'vanity' && <VanityPage guild={guild} />}
      {tab === 'members' && <Members guild={guild} />}
      {tab === 'bans' && <Bans guild={guild} />}
      {tab === 'invites' && <Invites guild={guild} />}
      {tab === 'directory' && <DirectoryListingPage guild={guild} />}
      {!tabs.length && <p className="hint">{t("You don't have permission to change anything here.")}</p>}
    </SettingsLayout>
  )
}

const AFK_TIMEOUTS: [number, string][] = [[60, '1 minute'], [300, '5 minutes'], [900, '15 minutes'], [1800, '30 minutes'], [3600, '1 hour']]

/** Channels of a guild of the given types, in position order (shared by several settings pages). */
export function useGuildChannels(guildId: string, types: number[]) {
  const all = useStore((s) => s.channels)
  return Object.values(all).filter((c) => c.guild_id === guildId && types.includes(c.type)).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || cmpId(a.id, b.id))
}

const backendName = (b: string | null) => (b === 'cillvoice' ? 'cillvoice' : b === 'livekit' ? 'LiveKit' : t('none'))

function Overview({ guild }: { guild: Guild }) {
  const initial = { name: guild.name, description: guild.description ?? '', afk_channel_id: guild.afk_channel_id ?? '', afk_timeout: guild.afk_timeout ?? 300, system_channel_id: guild.system_channel_id ?? '', voice_backend: guild.voice_backend ?? '' }
  const [draft, setDraft] = useState(initial)
  const [icon, setIcon] = useState<string | null | undefined>(undefined) // undefined = unchanged, null = remove
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const voice = useGuildChannels(guild.id, [2])
  const voiceServers = useInstance()?.voice
  const text = useGuildChannels(guild.id, [0, 5])
  const preview = icon === undefined ? (guild.icon ? cdn(`/icons/${guild.id}/${guild.icon}`) : null) : icon
  const dirty = JSON.stringify({ ...draft, name: draft.name.trim() }) !== JSON.stringify(initial) || icon !== undefined
  const set = (patch: Partial<typeof draft>) => (setDraft({ ...draft, ...patch }), setSaved(false))
  const save = () => {
    setError('')
    patchGuild(guild.id, {
      name: draft.name.trim(), description: draft.description.trim() || null, afk_channel_id: draft.afk_channel_id || null, afk_timeout: draft.afk_timeout,
      system_channel_id: draft.system_channel_id || null, ...(icon !== undefined && { icon }),
      ...(draft.voice_backend !== initial.voice_backend && { voice_backend: (draft.voice_backend || null) as Guild['voice_backend'] }),
    }).then(() => (setIcon(undefined), setSaved(true)), (e: Error) => setError(e.message))
  }
  return (
    <>
      <h1>{t('Server Overview')}</h1>
      <div className="overview">
        <div className="icon-edit">
          <span className="rail-icon big">{preview ? <img src={preview} alt="" /> : <GuildIcon guild={{ ...guild, icon: null }} />}</span>
          <label className="secondary file-btn">
            {t('Upload Image')}
            <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) dataUri(f).then(setIcon, (err: Error) => setError(err.message)); e.target.value = '' }} />
          </label>
          {preview && <button className="link" onClick={() => setIcon(null)}>{t('Remove')}</button>}
          <p className="hint small">{t('We recommend an image of at least 512x512.')}</p>
        </div>
        <div className="field grow">
          <label htmlFor="server-name">{t('Server Name')}</label>
          <input id="server-name" className="input" maxLength={100} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label htmlFor="server-desc">{t('Server Description')}</label>
        <textarea id="server-desc" className="input textarea" maxLength={300} value={draft.description} onChange={(e) => set({ description: e.target.value })} placeholder={t('What is your server about?')} />
      </div>
      <div className="row-fields">
        <div className="field grow">
          <label htmlFor="afk-channel">{t('Inactive Channel')}</label>
          <select id="afk-channel" className="input" value={draft.afk_channel_id} onChange={(e) => set({ afk_channel_id: e.target.value })}>
            <option value="">{t('No Inactive Channel')}</option>
            {voice.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="afk-timeout">{t('Inactive Timeout')}</label>
          <select id="afk-timeout" className="input" value={draft.afk_timeout} onChange={(e) => set({ afk_timeout: +e.target.value })}>
            {AFK_TIMEOUTS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
          </select>
        </div>
      </div>
      <p className="hint small">{t('Members who are idle in voice for longer than the inactive timeout are moved to the inactive channel.')}</p>
      {voiceServers && voiceServers.configured.length > 0 && (
        <div className="field top-gap">
          <label htmlFor="voice-backend">{t('Voice Server')}</label>
          <select id="voice-backend" className="input" value={draft.voice_backend} onChange={(e) => set({ voice_backend: e.target.value })}>
            <option value="">{t('Instance default ({name})', { name: backendName(voiceServers.default) })}</option>
            {voiceServers.configured.map((b) => <option key={b} value={b}>{backendName(b)}</option>)}
          </select>
          <p className="hint small">{t('Used for new calls in this server. A call that is running keeps its voice server until everyone has left.')}</p>
        </div>
      )}
      <div className="field top-gap">
        <label htmlFor="system-channel">{t('System Messages Channel')}</label>
        <select id="system-channel" className="input" value={draft.system_channel_id} onChange={(e) => set({ system_channel_id: e.target.value })}>
          <option value="">{t('No System Messages')}</option>
          {text.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
        </select>
        <p className="hint small">{t('This is the channel we send join messages to.')}</p>
      </div>
      <FormError error={error} />
      <div className="save-bar">
        {saved && !dirty && <span className="success" role="status">{t('Saved.')}</span>}
        <button className="link" disabled={!dirty} onClick={() => (setDraft(initial), setIcon(undefined))}>{t('Reset')}</button>
        <button className="primary" disabled={!dirty || !draft.name.trim()} onClick={save}>{t('Save Changes')}</button>
      </div>
    </>
  )
}

export function SnippetsPage({ guild }: { guild: Guild }) {
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [content, setContent] = useState('')
  const [creating, setCreating] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const reload = () => {
    fetchSnippets(guild.id)
      .then((res) => {
        setSnippets(res.snippets ?? [])
        setLoading(false)
      })
      .catch((e: Error) => {
        setError(e.message)
        setLoading(false)
      })
  }

  useEffect(() => {
    reload()
  }, [guild.id])

  const handleCreate = (e: React.FormEvent) => {
    e.preventDefault()
    const cleanName = name.trim().toLowerCase().replace(/^!/, '')
    if (!/^[a-z0-9_-]{1,32}$/.test(cleanName)) {
      setError(t('Snippet name must be 1-32 alphanumeric characters, dashes, or underscores.'))
      return
    }
    if (!content.trim()) {
      setError(t('Snippet content cannot be empty.'))
      return
    }
    setSubmitting(true)
    setError('')
    createSnippet(guild.id, cleanName, content.trim())
      .then(() => {
        setName('')
        setContent('')
        setCreating(false)
        setSubmitting(false)
        reload()
      })
      .catch((err: Error) => {
        setError(err.message)
        setSubmitting(false)
      })
  }

  const handleDelete = (id: string) => {
    deleteSnippet(guild.id, id)
      .then(reload)
      .catch(toastError)
  }

  return (
    <div className="settings-page">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
        <div>
          <h1>{t('Text Snippets / FAQ Tags')}</h1>
          <p className="hint">{t('Define server shortcuts triggered by typing !name or selected from the composer.')}</p>
        </div>
        {!creating && (
          <button className="primary" onClick={() => setCreating(true)}>{t('New Snippet')}</button>
        )}
      </div>

      {creating && (
        <form onSubmit={handleCreate} style={{ background: 'var(--bg-secondary, #2b2d31)', padding: '16px', borderRadius: '8px', marginBottom: '20px' }}>
          <h3>{t('Create New Snippet')}</h3>
          <div className="field">
            <label htmlFor="snip-name">{t('Trigger Name')}</label>
            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <span style={{ fontWeight: 600, fontSize: '16px' }}>!</span>
              <input
                id="snip-name"
                className="input"
                placeholder={t('e.g. rules, ip, faq')}
                maxLength={32}
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
            <p className="hint small">{t('1-32 characters, letters, numbers, dashes, underscores.')}</p>
          </div>
          <div className="field">
            <label htmlFor="snip-content">{t('Response Content')}</label>
            <textarea
              id="snip-content"
              className="input textarea"
              rows={4}
              maxLength={2000}
              required
              placeholder={t('Markdown text or embed to send when triggered')}
              value={content}
              onChange={(e) => setContent(e.target.value)}
            />
          </div>
          {error && <FormError error={error} />}
          <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '12px' }}>
            <button type="button" className="secondary" onClick={() => setCreating(false)}>{t('Cancel')}</button>
            <button className="primary" disabled={submitting}>{t('Save Snippet')}</button>
          </div>
        </form>
      )}

      {loading ? (
        <p className="hint">{t('Loading snippets…')}</p>
      ) : snippets.length === 0 ? (
        <p className="hint">{t('No snippets defined yet. Create one to answer common questions quickly!')}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {snippets.map((snip) => (
            <div key={snip.id} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', padding: '12px', borderRadius: '6px', background: 'var(--bg-secondary, #2b2d31)', gap: '12px' }}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, color: 'var(--accent, #5865f2)', fontSize: '15px', marginBottom: '4px' }}>
                  !{snip.name}
                </div>
                <div style={{ fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', opacity: 0.9 }}>
                  {snip.content}
                </div>
              </div>
              <button
                type="button"
                className="danger-btn small-btn"
                onClick={() => handleDelete(snip.id)}
              >
                {t('Delete')}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
