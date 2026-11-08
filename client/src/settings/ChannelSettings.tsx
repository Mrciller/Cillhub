// Channel Settings: Overview (name, topic, limits, slowmode, NSFW, forum and thread options, position) and Permissions (overwrites).
import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { deleteChannel, loadMembers, updateChannel } from '../actions'
import { api } from '../api'
import { nudgeChannel } from '../channelOrder'
import { ask, toastError } from '../components/dialogs'
import { cls, FormError, Icon, ICONS } from '../components/ui'
import { grantable, has, isThread, outranks, P, rank, sortedRoles } from '../permissions'
import { navigate } from '../router'
import { colorOf, memberName, myMember, permsOf } from '../selectors'
import { cmpId, getState, useStore } from '../store'
import type { Channel, ForumTag, Overwrite } from '../types'
import { SettingsLayout, Switch } from './Layout'
import './settings-v3.css'
import { ColorField } from '../custom/AppearanceV6'
import { toHex, toInt } from '../custom/color'
import { bit, PERM_GROUPS } from './permInfo'

const fail = (e: Error) => toastError(e)
const KIND: Record<number, string> = { 0: 'Text Channel', 1: 'DM', 2: 'Voice Channel', 4: 'Category', 5: 'Announcement Channel', 10: 'Thread', 11: 'Thread', 12: 'Private Thread', 13: 'Stage Channel', 15: 'Forum Channel' }
const TEXTISH = [0, 5, 15, 16]

export function ChannelSettings({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const channel = useStore((s) => s.channels[channelId])
  const perms = useStore((s) => (channel ? permsOf(s, channel.guild_id, channel) : 0n))
  const meId = useStore((s) => s.me?.id)
  const thread = isThread(channel)
  const manage = thread ? has(perms, P.MANAGE_THREADS) : has(perms, P.MANAGE_CHANNELS)
  const [tab, setTab] = useState(manage || thread ? 'overview' : 'permissions')
  useEffect(() => void (!channel && onClose()), [channel, onClose])
  if (!channel?.guild_id) return null
  const tabs = [
    { id: 'overview', label: t('Overview') },
    ...(has(perms, P.MANAGE_ROLES) && !thread ? [{ id: 'permissions', label: t('Permissions') }] : []),
  ]
  const what = t(thread ? 'Thread' : channel.type === 4 ? 'Category' : 'Channel')
  const remove = () =>
    void ask({ title: t('Delete {what}', { what }), body: <p>{t('Are you sure you want to delete {name}? This cannot be undone.', { name: `${channel.type === 0 ? '#' : ''}${channel.name}` })}</p>, confirm: t('Delete {what}', { what }), danger: true })
      .then((ok) => void (ok && deleteChannel(channel).then(() => (onClose(), navigate(`/channels/${channel.guild_id}`)), fail)))
  return (
    <SettingsLayout
      title={`${channel.type === 0 ? '#' : ''}${channel.name} · ${t(KIND[channel.type])}`}
      tabs={tabs}
      tab={tab}
      setTab={setTab}
      onClose={onClose}
      footer={manage && <button className="settings-tab danger" onClick={remove}>{t('Delete {what}', { what })}</button>}
    >
      {tab === 'overview' && <Overview channel={channel} canEdit={manage || (thread && channel.owner_id === meId)} canModerate={manage} />}
      {tab === 'permissions' && <Permissions channel={channel} />}
    </SettingsLayout>
  )
}

const SLOWMODE: [number, string][] = [
  [0, 'Off'], [5, '5s'], [10, '10s'], [15, '15s'], [30, '30s'], [60, '1m'], [120, '2m'], [300, '5m'], [600, '10m'], [900, '15m'], [1800, '30m'], [3600, '1h'], [7200, '2h'], [21600, '6h'],
]
const ARCHIVE: [number, string][] = [[60, '1 Hour'], [1440, '24 Hours'], [4320, '3 Days'], [10080, '1 Week']]
const TTL_OPTIONS: [number, string][] = [
  [0, 'Off (Keep Forever)'],
  [3600, '1 Hour'],
  [21600, '6 Hours'],
  [86400, '24 Hours'],
  [604800, '7 Days'],
  [2592000, '30 Days'],
]
const REQUIRE_TAG = 1 << 4
type Draft = {
  name: string; topic: string; user_limit: number; rate_limit_per_user: number; nsfw: boolean; type: number; default_auto_archive_duration: number
  available_tags: ForumTag[]; default_sort_order: number; default_forum_layout: number; flags: number; reaction: string; archived: boolean; locked: boolean
  icon_emoji: string; theme_color: number | null // v6
  message_ttl: number; quality_mode: 'speech' | 'hifi' // v9
}
const draftOf = (c: Channel): Draft => ({
  name: c.name ?? '', topic: c.topic ?? '', user_limit: c.user_limit ?? 0, rate_limit_per_user: c.rate_limit_per_user ?? 0, nsfw: !!c.nsfw, type: c.type,
  default_auto_archive_duration: c.default_auto_archive_duration ?? 1440, available_tags: c.available_tags ?? [], default_sort_order: c.default_sort_order ?? 0,
  default_forum_layout: c.default_forum_layout ?? 1, flags: c.flags ?? 0, reaction: c.default_reaction_emoji?.emoji_name ?? '',
  archived: !!c.thread_metadata?.archived, locked: !!c.thread_metadata?.locked, icon_emoji: c.icon_emoji?.name ?? '', theme_color: c.theme_color ?? null,
  message_ttl: c.message_ttl ?? 0, quality_mode: c.quality_mode ?? 'speech',
})

/** Only the fields this channel kind has and that changed, in the Modify Channel shape. */
function patchOf(c: Channel, d: Draft): Partial<Channel> & Record<string, unknown> {
  const o = draftOf(c)
  const out: Record<string, unknown> = {}
  const changed = (k: keyof Draft) => JSON.stringify(o[k]) !== JSON.stringify(d[k])
  const thread = isThread(c)
  if (changed('name')) out.name = d.name.trim()
  if ((TEXTISH.includes(c.type)) && changed('topic')) out.topic = d.topic.trim() || null
  if ((c.type === 2 || c.type === 13) && changed('user_limit')) out.user_limit = d.user_limit
  if ((c.type === 2 || c.type === 13) && changed('quality_mode')) out.quality_mode = d.quality_mode
  if (c.type !== 4 && c.type !== 13 && changed('rate_limit_per_user')) out.rate_limit_per_user = d.rate_limit_per_user
  if (c.type !== 4 && changed('message_ttl')) out.message_ttl = d.message_ttl
  if (!thread && c.type !== 4 && changed('nsfw')) out.nsfw = d.nsfw
  if ((c.type === 0 || c.type === 5) && changed('type')) out.type = d.type
  if (TEXTISH.includes(c.type) && changed('default_auto_archive_duration')) out.default_auto_archive_duration = d.default_auto_archive_duration
  if (c.type === 15 || c.type === 16) {
    if (changed('available_tags')) out.available_tags = d.available_tags.filter((t) => t.name.trim()).map(({ id, ...t }) => ({ ...(id && { id }), ...t, name: t.name.trim() }))
    if (changed('default_sort_order')) out.default_sort_order = d.default_sort_order
    if (changed('default_forum_layout')) out.default_forum_layout = d.default_forum_layout
    if (changed('flags')) out.flags = d.flags
    if (changed('reaction')) out.default_reaction_emoji = d.reaction.trim() ? { emoji_id: null, emoji_name: d.reaction.trim() } : null
  }
  // v6 (channel docs icon_emoji / theme_color): emoji instead of # and the header accent strip
  if (!thread && c.type !== 4) {
    if (changed('icon_emoji')) out.icon_emoji = d.icon_emoji.trim() ? { id: null, name: d.icon_emoji.trim() } : null
    if (changed('theme_color')) out.theme_color = d.theme_color
  }
  if (thread) {
    if (changed('archived')) out.archived = d.archived
    if (changed('locked')) out.locked = d.locked
  }
  return out
}

function Overview({ channel, canEdit, canModerate }: { channel: Channel; canEdit: boolean; canModerate: boolean }) {
  const categories = useStore((s) => s.channels)
  const [draft, setDraft] = useState(() => draftOf(channel))
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const set = (p: Partial<Draft>) => (setDraft({ ...draft, ...p }), setSaved(false))
  const thread = isThread(channel)
  const cats = Object.values(categories).filter((c) => c.guild_id === channel.guild_id && c.type === 4).sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || cmpId(a.id, b.id))
  const patch = patchOf(channel, draft)
  const dirty = Object.keys(patch).length > 0
  const save = () => {
    setError('')
    updateChannel(channel.id, patch).then(() => (setDraft(draftOf(getState().channels[channel.id] ?? channel)), setSaved(true)), (e: Error) => setError(e.message))
  }
  const nudge = (d: -1 | 1) => nudgeChannel(channel.id, d).catch((e: Error) => setError(e.message))
  const tagSet = (i: number, p: Partial<ForumTag>) => set({ available_tags: draft.available_tags.map((t, j) => (j === i ? { ...t, ...p } : t)) })
  return (
    <>
      <h1>{t('Overview')}</h1>
      <fieldset disabled={!canEdit} className="plain">
        <div className="field">
          <label htmlFor="ch-name">{channel.type === 4 ? t('Category Name') : thread ? t('Thread Name') : t('Channel Name')}</label>
          <input id="ch-name" className="input" maxLength={100} value={draft.name} onChange={(e) => set({ name: e.target.value })} />
        </div>
        {!thread && channel.type !== 4 && (
          <div className="row-fields">
            <div className="field">
              <label htmlFor="ch-emoji">{t('Channel icon')}</label>
              <input id="ch-emoji" className="input emoji-input" maxLength={8} placeholder="#" value={draft.icon_emoji} onChange={(e) => set({ icon_emoji: e.target.value })} aria-describedby="ch-emoji-h" />
              <p id="ch-emoji-h" className="hint small">{t('An emoji shown instead of # in the channel list.')}</p>
            </div>
            <div className="field grow">
              <label className="inline-check"><input type="checkbox" checked={draft.theme_color !== null} onChange={(e) => set({ theme_color: e.target.checked ? 0x3d7bff : null })} /> {t('Channel accent colour')}</label>
              {draft.theme_color !== null && <ColorField label={t('Accent colour')} value={toHex(draft.theme_color)} onChange={(h) => set({ theme_color: toInt(h) })} />}
            </div>
          </div>
        )}
        {TEXTISH.includes(channel.type) && (
          <div className="field">
            <label htmlFor="ch-topic">{channel.type === 15 ? t('Post Guidelines') : t('Channel Topic')}</label>
            <textarea id="ch-topic" className="input textarea" maxLength={channel.type === 15 ? 4096 : 1024} value={draft.topic} onChange={(e) => set({ topic: e.target.value })} placeholder={t('Let everyone know how to use this channel!')} />
          </div>
        )}
        {(channel.type === 2 || channel.type === 13) && (
          <>
            <div className="field">
              <label htmlFor="ch-limit">{t('User Limit')} <span className="hint">{draft.user_limit ? t('{n} users', { n: draft.user_limit }) : t('∞ (no limit)')}</span></label>
              <input id="ch-limit" type="range" min={0} max={99} value={draft.user_limit} onChange={(e) => set({ user_limit: +e.target.value })} aria-valuetext={draft.user_limit ? t('{n} users', { n: draft.user_limit }) : t('No limit')} />
            </div>
            <div className="field">
              <label htmlFor="ch-quality">{t('Audio Quality Mode')}</label>
              <select id="ch-quality" className="input" value={draft.quality_mode} onChange={(e) => set({ quality_mode: e.target.value as 'speech' | 'hifi' })}>
                <option value="speech">{t('Speech (Optimized, noise suppression on)')}</option>
                <option value="hifi">{t('Hi-Fi / Music Mode (Stereo, processing disabled)')}</option>
              </select>
              <p className="hint small">{t('Hi-Fi mode disables RNNoise and auto-gain to allow pristine stereo capture of instruments and music.')}</p>
            </div>
          </>
        )}
        {channel.type !== 4 && channel.type !== 13 && (
          <>
            <div className="field">
              <label htmlFor="ch-slow">{t('Slowmode')}</label>
              <select id="ch-slow" className="input" value={draft.rate_limit_per_user} onChange={(e) => set({ rate_limit_per_user: +e.target.value })}>
                {SLOWMODE.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
              </select>
              <p className="hint small">{channel.type === 15 ? t('Members can send one message or create one post per this interval, unless they can manage messages or the channel.') : t('Members can send one message per this interval, unless they can manage messages or the channel.')}</p>
            </div>
            <div className="field">
              <label htmlFor="ch-ttl">{t('Disappearing Messages (TTL)')}</label>
              <select id="ch-ttl" className="input" value={draft.message_ttl} onChange={(e) => set({ message_ttl: +e.target.value })}>
                {TTL_OPTIONS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
              </select>
              <p className="hint small">{t('Messages sent in this channel automatically disappear after the selected duration.')}</p>
            </div>
          </>
        )}
        {!thread && channel.type !== 4 && (
          <Switch label={t('Age-Restricted Channel')} note={t('Members have to confirm they are over the legal age before they can view this channel.')} checked={draft.nsfw} disabled={!canEdit} onChange={(v) => set({ nsfw: v })} />
        )}
        {(channel.type === 0 || channel.type === 5) && (
          <Switch label={t('Announcement Channel')} note={t('Members can follow announcement channels to get its published messages in their own servers.')} checked={draft.type === 5} disabled={!canEdit} onChange={(v) => set({ type: v ? 5 : 0 })} />
        )}
        {TEXTISH.includes(channel.type) && (
          <div className="field top-gap">
            <label htmlFor="ch-archive">{t('Hide After Inactivity')}</label>
            <select id="ch-archive" className="input" value={draft.default_auto_archive_duration} onChange={(e) => set({ default_auto_archive_duration: +e.target.value })}>
              {ARCHIVE.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
            </select>
            <p className="hint small">{channel.type === 15 ? t('New threads and posts stop showing in the channel list after this long without activity.') : t('New threads stop showing in the channel list after this long without activity.')}</p>
          </div>
        )}
        {(channel.type === 15 || channel.type === 16) && (
          <section aria-labelledby="forum-opts">
            <h2 className="sub-title" id="forum-opts">{t('Forum Settings')}</h2>
            <fieldset className="plain">
              <legend className="field-label">{t('Tags ({n}/20)', { n: draft.available_tags.length })}</legend>
              <ul className="tag-edit">
                {draft.available_tags.map((tag, i) => (
                  <li key={tag.id || `new-${i}`}>
                    <input className="input emoji-input" aria-label={t('Emoji for tag {n}', { n: i + 1 })} maxLength={8} value={tag.emoji_name ?? ''} placeholder="🏷️" onChange={(e) => tagSet(i, { emoji_name: e.target.value || null, emoji_id: null })} />
                    <input className="input grow" aria-label={t('Tag {n} name', { n: i + 1 })} maxLength={20} value={tag.name} onChange={(e) => tagSet(i, { name: e.target.value })} />
                    <label className="small-check"><input type="checkbox" checked={tag.moderated} onChange={(e) => tagSet(i, { moderated: e.target.checked })} /> {t('Mods only')}</label>
                    <button className="icon-btn" aria-label={t('Remove tag {name}', { name: tag.name || i + 1 })} onClick={() => set({ available_tags: draft.available_tags.filter((_, j) => j !== i) })}><Icon d={ICONS.trash} size={16} /></button>
                  </li>
                ))}
              </ul>
              {draft.available_tags.length < 20 && (
                <button className="secondary small-btn" onClick={() => set({ available_tags: [...draft.available_tags, { id: '', name: '', moderated: false, emoji_id: null, emoji_name: null }] })}>{t('Add Tag')}</button>
              )}
            </fieldset>
            <Switch label={t('Require people to select tags when posting')} checked={!!(draft.flags & REQUIRE_TAG)} disabled={!canEdit} onChange={(v) => set({ flags: v ? draft.flags | REQUIRE_TAG : draft.flags & ~REQUIRE_TAG })} />
            <div className="row-fields top-gap">
              <div className="field grow">
                <label htmlFor="ch-sort">{t('Default Sort Order')}</label>
                <select id="ch-sort" className="input" value={draft.default_sort_order} onChange={(e) => set({ default_sort_order: +e.target.value })}>
                  <option value={0}>{t('Recent Activity')}</option>
                  <option value={1}>{t('Creation Time')}</option>
                </select>
              </div>
              <div className="field grow">
                <label htmlFor="ch-layout">{t('Default Layout')}</label>
                <select id="ch-layout" className="input" value={draft.default_forum_layout} onChange={(e) => set({ default_forum_layout: +e.target.value })}>
                  <option value={1}>{t('List View')}</option>
                  <option value={2}>{t('Gallery View')}</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="ch-react">{t('Default Reaction')}</label>
                <input id="ch-react" className="input emoji-input" maxLength={8} value={draft.reaction} onChange={(e) => set({ reaction: e.target.value })} placeholder="👍" />
              </div>
            </div>
          </section>
        )}
        {thread && (
          <fieldset className="plain" disabled={!canModerate}>
            <Switch label={t('Archived')} note={t('Archived threads are hidden from the channel list. Sending a message unarchives an unlocked thread.')} checked={draft.archived} disabled={!canModerate} onChange={(v) => set({ archived: v })} />
            <Switch label={t('Locked')} note={t('Only members who can manage threads can unarchive a locked thread or post in it.')} checked={draft.locked} disabled={!canModerate} onChange={(v) => set({ locked: v })} />
          </fieldset>
        )}
        <FormError error={error} />
        <div className="save-bar">
          {saved && !dirty && <span className="success" role="status">{t('Saved.')}</span>}
          <button className="link" disabled={!dirty} onClick={() => setDraft(draftOf(channel))}>{t('Reset')}</button>
          <button className="primary" disabled={!dirty || !draft.name.trim()} onClick={save}>{t('Save Changes')}</button>
        </div>
        {!thread && (
          <>
            <h2 className="sub-title">{t('Position')}</h2>
            <p className="hint">{t('The keyboard alternative to dragging in the channel list.')}</p>
            {channel.type !== 4 && (
              <div className="field">
                <label htmlFor="ch-parent">{t('Category')}</label>
                <select id="ch-parent" className="input" value={channel.parent_id ?? ''} onChange={(e) => updateChannel(channel.id, { parent_id: e.target.value || null }).catch((err: Error) => setError(err.message))}>
                  <option value="">{t('No category')}</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            )}
            <div className="row-buttons">
              <button className="secondary" onClick={() => nudge(-1)}><Icon d={ICONS.up} size={16} /> {t('Move Up')}</button>
              <button className="secondary" onClick={() => nudge(1)}><Icon d={ICONS.down} size={16} /> {t('Move Down')}</button>
            </div>
          </>
        )}
      </fieldset>
    </>
  )
}

type Tri = 'deny' | 'neutral' | 'allow'
const state = (o: Overwrite, b: bigint): Tri => (BigInt(o.deny) & b ? 'deny' : BigInt(o.allow) & b ? 'allow' : 'neutral')

function Permissions({ channel }: { channel: Channel }) {
  const s = useStore((x) => x)
  const guild = s.guilds[channel.guild_id!]
  const me = s.me!
  const mine = myMember(s, guild.id)
  const myRank = rank(guild, me.id, mine)
  const allowed = grantable(guild, me.id, mine)
  const saved = channel.permission_overwrites ?? []
  const [list, setList] = useState<Overwrite[]>(() => (saved.some((o) => o.id === guild.id) ? saved : [{ id: guild.id, type: 0, allow: '0', deny: '0' }, ...saved]))
  const [sel, setSel] = useState(list[0]?.id)
  const [error, setError] = useState('')
  const membersLoaded = s.membersLoaded[guild.id]
  useEffect(() => void (!membersLoaded && loadMembers(guild.id).catch(() => {})), [guild.id, membersLoaded])

  const roleOf = (id: string) => guild.roles.find((r) => r.id === id)
  const label = (o: Overwrite) => (o.id === guild.id ? '@everyone' : o.type === 0 ? roleOf(o.id)?.name ?? t('Deleted role') : memberName(s, guild.id, o.id))
  const editable = (o: Overwrite) =>
    o.type === 0 ? (roleOf(o.id)?.position ?? 0) < myRank : outranks(guild, me.id, mine, o.id, s.members[guild.id]?.[o.id])
  const current = list.find((o) => o.id === sel)
  const original = current && saved.find((o) => o.id === current.id)
  const dirty = !!current && (!original || original.allow !== current.allow || original.deny !== current.deny)
  const relevant = PERM_GROUPS.map((g) => ({ ...g, perms: g.perms.filter((p) => channel.type === 4 ? p.text || p.voice : channel.type === 2 || channel.type === 13 ? p.voice : p.text) })).filter((g) => g.perms.length)

  const set = (b: bigint, v: Tri) => {
    if (!current) return
    const allow = (BigInt(current.allow) & ~b) | (v === 'allow' ? b : 0n)
    const deny = (BigInt(current.deny) & ~b) | (v === 'deny' ? b : 0n)
    setList(list.map((o) => (o === current ? { ...o, allow: String(allow), deny: String(deny) } : o)))
  }
  const save = () => {
    if (!current) return
    setError('')
    api(`/channels/${channel.id}/permissions/${current.id}`, { method: 'PUT', body: { type: current.type, allow: current.allow, deny: current.deny } }).catch((e: Error) => setError(e.message))
  }
  const remove = () => {
    if (!current) return
    const done = () => (setList(list.filter((o) => o !== current)), setSel(list[0]?.id))
    if (!original) return done()
    api(`/channels/${channel.id}/permissions/${current.id}`, { method: 'DELETE' }).then(done, (e: Error) => setError(e.message))
  }
  const add = (value: string) => {
    const [type, id] = value.split(':')
    if (!id || list.some((o) => o.id === id)) return
    setList([...list, { id, type: type === 'role' ? 0 : 1, allow: '0', deny: '0' }])
    setSel(id)
  }
  const roleChoices = sortedRoles(guild).filter((r) => r.id !== guild.id && !list.some((o) => o.id === r.id) && r.position < myRank)
  const memberChoices = Object.values(s.members[guild.id] ?? {}).filter((m) => !list.some((o) => o.id === m.user.id) && outranks(guild, me.id, mine, m.user.id, m))

  return (
    <>
      <h1>{t('Channel Permissions')}</h1>
      <p className="hint">{t('Use permissions to customise who can do what in this channel.')}</p>
      <div className="roles-layout">
        <div className="roles-list">
          <select className="input" aria-label={t('Add a role or member')} value="" onChange={(e) => add(e.target.value)}>
            <option value="">{t('Add role or member…')}</option>
            {roleChoices.length > 0 && <optgroup label={t('Roles')}>{roleChoices.map((r) => <option key={r.id} value={`role:${r.id}`}>{r.name}</option>)}</optgroup>}
            {memberChoices.length > 0 && <optgroup label={t('Members')}>{memberChoices.map((m) => <option key={m.user.id} value={`member:${m.user.id}`}>{memberName(s, guild.id, m.user.id)}</option>)}</optgroup>}
          </select>
          <ul aria-label={t('Roles and members with overwrites')}>
            {list.map((o) => (
              <li key={o.id} className={cls('role-row', o.id === sel && 'active')}>
                <button className="role-select" aria-current={o.id === sel || undefined} onClick={() => setSel(o.id)}>
                  {o.type === 0 ? <span className="role-dot" style={{ background: colorOf(roleOf(o.id)?.color ?? 0) ?? '#949ba4' }} aria-hidden="true" /> : <Icon d={ICONS.people} size={14} />}
                  <span className="ellipsis">{label(o)}</span>
                  {!editable(o) && <Icon d={ICONS.lock} size={14} className="hint" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
        {current && (
          <div className="role-editor">
            <h2>{label(current)}</h2>
            {!editable(current) && <p className="notice">{t('You can only change overwrites for roles and members below your highest role.')}</p>}
            <fieldset disabled={!editable(current)} className="plain">
              {relevant.map((g) => (
                <section key={g.title} className="perm-group">
                  <h3 className="list-heading">{t(g.title.replace(' Server', ''))}</h3>
                  {g.perms.map((p) => {
                    const b = bit(p.name)
                    const v = state(current, b)
                    return (
                      <div key={p.name} className={cls('tri-row', !has(allowed, b) && 'disabled')} role="radiogroup" aria-label={t(p.label)}>
                        <div className="switch-text"><span className="label">{t(p.label)}</span><p className="hint small">{t(p.note)}</p></div>
                        <div className="tri">
                          {(['deny', 'neutral', 'allow'] as Tri[]).map((x) => (
                            <label key={x} className={cls('tri-opt', x, v === x && 'on')} title={x === 'deny' ? t('Deny') : x === 'allow' ? t('Allow') : t('Neutral (inherit)')}>
                              <input type="radio" name={`${current.id}-${p.name}`} className="sr-only" checked={v === x} disabled={!has(allowed, b)} onChange={() => set(b, x)} />
                              <span aria-hidden="true">{x === 'deny' ? '✕' : x === 'allow' ? '✓' : '/'}</span>
                              <span className="sr-only">{x === 'deny' ? t('Deny') : x === 'allow' ? t('Allow') : t('Neutral')}</span>
                            </label>
                          ))}
                        </div>
                      </div>
                    )
                  })}
                </section>
              ))}
            </fieldset>
            <FormError error={error} />
            <div className="save-bar">
              {current.id !== guild.id && editable(current) && <button className="danger-btn" onClick={remove}>{t('Remove')}</button>}
              <span className="spacer" />
              <button className="link" disabled={!dirty} onClick={() => setList(list.map((o) => (o === current ? original ?? { ...o, allow: '0', deny: '0' } : o)))}>{t('Reset')}</button>
              <button className="primary" disabled={!dirty || !editable(current)} onClick={save}>{t('Save Changes')}</button>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
