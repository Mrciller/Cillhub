// User Settings → Sounds (CONTRACT-v6 section 1): set, per-sound source and volume, mute all, own uploads, entrance sound.
import { useEffect, useState } from 'react'
import { loadSounds, patchSettings } from '../actions'
import { toastError } from '../components/dialogs'
import { FormError, Icon, ICONS } from '../components/ui'
import { t } from '../i18n'
import { has, P } from '../permissions'
import { permsOf } from '../selectors'
import { Switch } from '../settings/Layout'
import { getState, useStore } from '../store'
import type { SoundKind, SoundSettings as Conf, UserSound } from '../types'
import { conf as soundConf, currentSet, deleteUserSound, KINDS, loadUserSounds, playKind, readSound, SETS, soundOf, uploadUserSound, userSounds } from './sounds'

function useUserSounds() {
  const [list, setList] = useState<UserSound[] | null>(userSounds())
  useEffect(() => void loadUserSounds().then(setList), [])
  return [list ?? [], () => setList([...(userSounds() ?? [])])] as const
}

export function SoundSettings() {
  const s = useStore((x) => x.settings)
  const guilds = useStore((x) => x.guilds)
  const allSounds = useStore((x) => x.sounds)
  const conf: Conf = soundConf()
  const set = currentSet()
  const save = (patch: Partial<Conf>) => void patchSettings({ sound_settings: { ...conf, ...patch } })
  const setKind = (k: SoundKind, patch: Partial<{ sound: string | null; volume: number }>) => save({ events: { ...conf.events, [k]: { ...soundOf(k), ...patch } } })
  // a new set replaces every event that plays a built-in tone; off and own sounds stay
  const pickSet = (id: string) => save({ events: Object.fromEntries(KINDS.map(([k]) => { const x = soundOf(k); return [k, { ...x, sound: x.sound && SETS[x.sound] ? id : x.sound }] })) })
  const [mine, refresh] = useUserSounds()
  const [name, setName] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  // Entrance sounds: soundboard sounds of servers where we may use the soundboard (CONTRACT-v6: USE_SOUNDBOARD only).
  const usable = Object.values(guilds).filter((g) => has(permsOf(getState(), g.id), P.USE_SOUNDBOARD))
  useEffect(() => usable.forEach((g) => !allSounds[g.id] && loadSounds(g.id).catch(() => {})), [usable.length])
  const entrance = s.entrance_sound ? `${s.entrance_sound.guild_id ?? 'me'}:${s.entrance_sound.sound_id}` : ''
  const upload = async () => {
    if (!file || !name.trim()) return
    setBusy(true)
    setError('')
    try {
      await uploadUserSound(name.trim().slice(0, 32), await readSound(file))
      refresh()
      setName('')
      setFile(null)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    setBusy(false)
  }
  return (
    <>
      <h1>{t('Sounds')}</h1>
      <Switch label={t('Mute all sounds')} note={t('Silences notification, call, voice and entrance sounds in this client.')} checked={conf.muted} onChange={(v) => save({ muted: v })} />
      <div className="field top-gap">
        <label htmlFor="sound-set">{t('Sound set')}</label>
        <div className="row-buttons">
          <select id="sound-set" className="input grow" value={set} onChange={(e) => pickSet(e.target.value)}>
            {Object.entries(SETS).map(([id, x]) => <option key={id} value={id}>{t(x.name)}</option>)}
          </select>
          <button className="secondary" onClick={() => playKind('mention')}>{t('Preview')}</button>
        </div>
      </div>
      <table className="sound-table">
        <caption className="sr-only">{t('Sounds')}</caption>
        <thead><tr><th scope="col">{t('Event')}</th><th scope="col">{t('Sound')}</th><th scope="col">{t('Volume')}</th><th scope="col"><span className="sr-only">{t('Preview')}</span></th></tr></thead>
        <tbody>
          {KINDS.map(([k, label]) => {
            const cur = soundOf(k)
            return (
              <tr key={k}>
                <th scope="row">{t(label)}</th>
                <td>
                  <select className="input" aria-label={t('Sound for {event}', { event: t(label) })} value={cur.sound ?? 'off'} onChange={(e) => setKind(k, { sound: e.target.value === 'off' ? null : e.target.value })}>
                    {Object.entries(SETS).map(([id, x]) => <option key={id} value={id}>{t('{set} (built-in)', { set: t(x.name) })}</option>)}
                    <option value="off">{t('Off')}</option>
                    {mine.map((u) => <option key={u.id} value={`user:${u.id}`}>{u.name}</option>)}
                  </select>
                </td>
                <td><input type="range" min={0} max={100} step={5} value={cur.volume} aria-label={t('Volume for {event}', { event: t(label) })} aria-valuetext={`${cur.volume}%`} onChange={(e) => setKind(k, { volume: +e.target.value })} /></td>
                <td><button className="icon-btn" aria-label={t('Play {event}', { event: t(label) })} onClick={() => playKind(k)}><Icon d={ICONS.speaker} size={18} /></button></td>
              </tr>
            )
          })}
        </tbody>
      </table>

      <section className="settings-section top-gap">
        <h2>{t('Your sounds')}</h2>
        <p className="hint small">{t('OGG or MP3, up to 5 seconds and 256 KB.')}</p>
        <ul className="own-sounds">
          {mine.map((u) => (
            <li key={u.id} className="row-buttons">
              <span className="grow ellipsis">{u.name}</span>
              <button className="link danger-text" onClick={() => void deleteUserSound(u.id).then(refresh, toastError)}>{t('Delete')}</button>
            </li>
          ))}
        </ul>
        <div className="row-buttons">
          <input className="input grow" aria-label={t('Sound name')} placeholder={t('Sound name')} maxLength={32} value={name} onChange={(e) => setName(e.target.value)} />
          <label className="secondary file-btn">
            {file ? file.name : t('Choose File')}
            <input type="file" accept="audio/ogg,audio/mpeg,.ogg,.mp3" className="sr-only" aria-label={t('Sound file')} onChange={(e) => (setFile(e.target.files?.[0] ?? null), (e.target.value = ''))} />
          </label>
          <button className="primary" disabled={!file || !name.trim() || busy} onClick={() => void upload()}>{t('Upload')}</button>
        </div>
        <FormError error={error} />
      </section>

      <section className="settings-section">
        <h2>{t('Entrance sound')}</h2>
        <p className="hint small">{t('Everyone in the voice channel hears it when you join (servers can turn entrance sounds off).')}</p>
        <select className="input" aria-label={t('Entrance sound')} value={entrance}
          onChange={(e) => {
            const [g, id] = e.target.value.split(':')
            void patchSettings({ entrance_sound: e.target.value ? { sound_id: id, guild_id: g === 'me' ? null : g } : null })
          }}>
          <option value="">{t('None')}</option>
          {mine.length > 0 && <optgroup label={t('Your sounds')}>{mine.map((u) => <option key={u.id} value={`me:${u.id}`}>{u.name}</option>)}</optgroup>}
          {usable.map((g) => allSounds[g.id]?.length ? (
            <optgroup key={g.id} label={g.name}>{allSounds[g.id].map((x) => <option key={x.sound_id} value={`${g.id}:${x.sound_id}`}>{x.emoji_name ? `${x.emoji_name} ` : ''}{x.name}</option>)}</optgroup>
          ) : null)}
        </select>
      </section>
    </>
  )
}
