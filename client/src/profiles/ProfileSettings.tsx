// User Settings → Profiles: the global profile and per-server profiles, with a live preview card (CONTRACT-v4 section 2).
import { useState, type ReactNode } from 'react'
import { patchMe, patchMyMember } from '../actions'
import { dataUri } from '../api'
import { avatarUrl, bannerUrl, cls, FormError, memberAvatarUrl, memberBannerUrl } from '../components/ui'
import { t } from '../i18n'
import { displayName, useStore } from '../store'
import { ProfileCard } from './ProfileCard'
import { forgetProfile } from './useProfile'
import './profiles.css'
import { draftOf, draftPatch, memberStylePatch, NameStyleEditor, previewUser, ProfileExtras, widgetsValid, type ProfileDraft } from '../custom/ProfileCustomize'
import type { NameStyle } from '../types'

/** An image picker: undefined = unchanged, null = removed, string = new data URI. */
function ImagePick({ label, value, current, onChange, onError }: { label: string; value: string | null | undefined; current: string | null; onChange: (v: string | null | undefined) => void; onError: (e: string) => void }) {
  const shown = value === undefined ? current : value
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      <div className="row-buttons">
        <label className="primary file-btn">
          {t('Change {what}', { what: label })}
          <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="sr-only"
            onChange={(e) => { const f = e.target.files?.[0]; if (f) dataUri(f).then(onChange, (err: Error) => onError(err.message)); e.target.value = '' }} />
        </label>
        {shown && <button type="button" className="link" onClick={() => onChange(null)}>{t('Remove {what}', { what: label })}</button>}
        {value !== undefined && <button type="button" className="link" onClick={() => onChange(undefined)}>{t('Reset')}</button>}
      </div>
    </div>
  )
}

function Layout({ form, preview }: { form: ReactNode; preview: ReactNode }) {
  return <div className="profile-settings"><div className="profile-form">{form}</div><div className="profile-preview"><h2 className="list-heading">{t('Preview')}</h2>{preview}</div></div>
}

function UserProfile() {
  const me = useStore((s) => s.me)!
  const [name, setName] = useState(me.global_name ?? '')
  const [pronouns, setPronouns] = useState(me.pronouns ?? '')
  const [bio, setBio] = useState(me.bio ?? '')
  const [accent, setAccent] = useState<number | null>(me.accent_color ?? null)
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined)
  const [banner, setBanner] = useState<string | null | undefined>(undefined)
  const [extras, setExtras] = useState<ProfileDraft>(() => draftOf(me))
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const extrasDirty = JSON.stringify(extras) !== JSON.stringify(draftOf(me))
  const dirty = extrasDirty || name !== (me.global_name ?? '') || pronouns !== (me.pronouns ?? '') || bio !== (me.bio ?? '') || accent !== (me.accent_color ?? null) || avatar !== undefined || banner !== undefined
  const save = () => {
    setError('')
    if (!widgetsValid(extras.widgets)) return setError(t('Fix the social links first.'))
    patchMe({ global_name: name.trim() || null, pronouns, bio, accent_color: accent, ...(avatar !== undefined && { avatar }), ...(banner !== undefined && { banner }), ...(extrasDirty && draftPatch(extras)) }).then(
      (u) => (forgetProfile(me.id), setAvatar(undefined), setBanner(undefined), setExtras(draftOf({ ...previewUser(me, extras), ...u })), setSaved(true)),
      (e: Error) => setError(e.message),
    )
  }
  const reset = () => (setExtras(draftOf(me)), setName(me.global_name ?? ''), setPronouns(me.pronouns ?? ''), setBio(me.bio ?? ''), setAccent(me.accent_color ?? null), setAvatar(undefined), setBanner(undefined))
  const edit = <T,>(f: (v: T) => void) => (v: T) => (f(v), setSaved(false))
  return (
    <Layout
      form={
        <>
          <div className="field"><label htmlFor="p-name">{t('Display Name')}</label><input id="p-name" className="input" maxLength={32} value={name} placeholder={me.username} onChange={(e) => edit(setName)(e.target.value)} /></div>
          <div className="field"><label htmlFor="p-pronouns">{t('Pronouns')}</label><input id="p-pronouns" className="input" maxLength={40} value={pronouns} placeholder={t('Add your pronouns')} onChange={(e) => edit(setPronouns)(e.target.value)} /></div>
          <ImagePick label={t('Avatar')} value={avatar} current={avatarUrl(me)} onChange={edit(setAvatar)} onError={setError} />
          <ImagePick label={t('Banner')} value={banner} current={bannerUrl(me)} onChange={edit(setBanner)} onError={setError} />
          <div className="field">
            <label htmlFor="p-accent">{t('Banner Color')}</label>
            <div className="row-buttons">
              <input id="p-accent" type="color" value={'#' + (accent ?? 0x22e1ff).toString(16).padStart(6, '0')} onChange={(e) => edit(setAccent)(parseInt(e.target.value.slice(1), 16))} />
              {accent !== null && <button type="button" className="link" onClick={() => edit(setAccent)(null)}>{t('Reset')}</button>}
            </div>
          </div>
          <div className="field">
            <label htmlFor="p-bio">{t('About Me')}</label>
            <textarea id="p-bio" className="input textarea" maxLength={190} rows={4} value={bio} onChange={(e) => edit(setBio)(e.target.value)} aria-describedby="p-bio-n" />
            <p id="p-bio-n" className="hint small">{t('You can use markdown and links if you like.')} {190 - bio.length}</p>
          </div>
          <ProfileExtras draft={extras} onChange={edit(setExtras)} name={name.trim() || displayName(me)} />
          <FormError error={error} />
          <div className="save-bar">
            {saved && !dirty && <span className="success" role="status">{t('Saved.')}</span>}
            <button className="link" disabled={!dirty} onClick={reset}>{t('Reset')}</button>
            <button className="primary" disabled={!dirty} onClick={save}>{t('Save Changes')}</button>
          </div>
        </>
      }
      preview={<ProfileCard big d={{ user: previewUser(me, extras), name: name.trim() || displayName(me), pronouns, bio, accent, avatar: avatar === undefined ? avatarUrl(me) : avatar, banner: banner === undefined ? bannerUrl(me) : banner }} status="online" />}
    />
  )
}

function ServerProfile() {
  const s = useStore((x) => x)
  const me = s.me!
  const guilds = Object.values(s.guilds)
  const [gid, setGid] = useState(guilds[0]?.id ?? '')
  const member = gid ? s.members[gid]?.[me.id] : undefined
  const [nick, setNick] = useState<string | undefined>(undefined)
  const [bio, setBio] = useState<string | undefined>(undefined)
  const [avatar, setAvatar] = useState<string | null | undefined>(undefined)
  const [banner, setBanner] = useState<string | null | undefined>(undefined)
  const [style, setStyle] = useState<NameStyle | null | undefined>(undefined)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  if (!guilds.length) return <p className="hint">{t('Join a server to set a server profile.')}</p>
  const reset = () => (setNick(undefined), setBio(undefined), setAvatar(undefined), setBanner(undefined), setStyle(undefined))
  const dirty = nick !== undefined || bio !== undefined || avatar !== undefined || banner !== undefined || style !== undefined
  const save = () => {
    setError('')
    patchMyMember(gid, { ...(nick !== undefined && { nick: nick.trim() || null }), ...(bio !== undefined && { bio }), ...(avatar !== undefined && { avatar }), ...(banner !== undefined && { banner }), ...(style !== undefined && memberStylePatch(style)) })
      .then(() => (forgetProfile(me.id), reset(), setSaved(true)), (e: Error) => setError(e.message))
  }
  const guild = s.guilds[gid]
  const shownNick = nick ?? member?.nick ?? ''
  const shownBio = bio ?? member?.bio ?? me.bio ?? ''
  return (
    <Layout
      form={
        <>
          <div className="field">
            <label htmlFor="sp-guild">{t('Choose a server')}</label>
            <select id="sp-guild" className="input" value={gid} onChange={(e) => (setGid(e.target.value), reset(), setSaved(false))}>
              {guilds.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
          <div className="field"><label htmlFor="sp-nick">{t('Server Nickname')}</label><input id="sp-nick" className="input" maxLength={32} value={shownNick} placeholder={displayName(me)} onChange={(e) => (setNick(e.target.value), setSaved(false))} /></div>
          <ImagePick label={t('Server Avatar')} value={avatar} current={memberAvatarUrl(gid, member)} onChange={(v) => (setAvatar(v), setSaved(false))} onError={setError} />
          <ImagePick label={t('Server Banner')} value={banner} current={memberBannerUrl(gid, member)} onChange={(v) => (setBanner(v), setSaved(false))} onError={setError} />
          <NameStyleEditor value={style === undefined ? member?.display_name_styles ?? null : style} onChange={(v) => (setStyle(v), setSaved(false))} name={shownNick.trim() || displayName(me)} />
          <div className="field"><label htmlFor="sp-bio">{t('Server About Me')}</label><textarea id="sp-bio" className="input textarea" maxLength={190} rows={4} value={bio ?? member?.bio ?? ''} onChange={(e) => (setBio(e.target.value), setSaved(false))} /></div>
          <FormError error={error} />
          <div className="save-bar">
            {saved && !dirty && <span className="success" role="status">{t('Saved.')}</span>}
            <button className="link" disabled={!dirty} onClick={reset}>{t('Reset')}</button>
            <button className="primary" disabled={!dirty} onClick={save}>{t('Save Changes')}</button>
          </div>
        </>
      }
      preview={<ProfileCard d={{
        user: me, guild, member: member && style !== undefined ? { ...member, display_name_styles: style } : member, name: shownNick.trim() || displayName(me), pronouns: me.pronouns, bio: shownBio, accent: me.accent_color,
        avatar: avatar === undefined ? memberAvatarUrl(gid, member) ?? avatarUrl(me) : avatar ?? avatarUrl(me),
        banner: banner === undefined ? memberBannerUrl(gid, member) ?? bannerUrl(me) : banner ?? bannerUrl(me),
      }} status="online" />}
    />
  )
}

export function ProfileSettings() {
  const [tab, setTab] = useState<'user' | 'server'>('user')
  return (
    <>
      <h1>{t('Profiles')}</h1>
      <div className="tabs sub-tabs" role="tablist" aria-label={t('Profiles')}>
        <button role="tab" aria-selected={tab === 'user'} className={cls('tab', tab === 'user' && 'on')} onClick={() => setTab('user')}>{t('User Profile')}</button>
        <button role="tab" aria-selected={tab === 'server'} className={cls('tab', tab === 'server' && 'on')} onClick={() => setTab('server')}>{t('Server Profiles')}</button>
      </div>
      <div role="tabpanel">{tab === 'user' ? <UserProfile /> : <ServerProfile />}</div>
    </>
  )
}
