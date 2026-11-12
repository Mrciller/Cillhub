// Server Settings > Safety Setup: verification level, automatic spam slow mode and rules screening (membership screening with TERMS rules).
import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { getMemberVerification, patchGuild, saveMemberVerification } from '../actions'
import { cls, FormError, Icon, ICONS } from '../components/ui'
import type { Guild } from '../types'
import { Switch } from './Layout'
import { useGuildChannels } from './ServerSettings'

const LEVELS: [number, string, string][] = [
  [0, 'None', 'Unrestricted'],
  [1, 'Low', 'Members must have an account older than 5 minutes.'],
  [2, 'Medium', 'Members must also be in this server for longer than 5 minutes.'],
]
const MAX_RULES = 16
const GATE = 'MEMBER_VERIFICATION_GATE_ENABLED'

export function SafetyPage({ guild }: { guild: Guild }) {
  const [error, setError] = useState('')
  const setLevel = (verification_level: number) => patchGuild(guild.id, { verification_level }).catch((e: Error) => setError(e.message))
  return (
    <>
      <h1>{t('Safety Setup')}</h1>
      <h2 className="sub-title">{t('Verification Level')}</h2>
      <p className="hint">{t('Members must meet these criteria before they can send messages or start conversations. Members with a role skip it.')}</p>
      <fieldset className="choice block">
        <legend className="sr-only">{t('Verification Level')}</legend>
        {LEVELS.map(([v, label, note]) => (
          <label key={v} className={cls('radio-card', (guild.verification_level ?? 0) === v && 'on')}>
            <input type="radio" name="verification" checked={(guild.verification_level ?? 0) === v} onChange={() => setLevel(v)} />
            <span><span className="type-name">{t(label)}</span><span className="hint small type-note">{t(note)}</span></span>
          </label>
        ))}
      </fieldset>
      <h2 className="sub-title">{t('Spam Protection')}</h2>
      <Switch
        label={t('Automatic spam slow mode')}
        note={t('When one member floods a channel, only they get a 10 second slowmode for 10 minutes. When many members do, the channel gets a 10 second slowmode for 5 minutes. Moderators are not affected.')}
        checked={guild.auto_spam_slowmode_enabled !== false}
        onChange={(v) => patchGuild(guild.id, { auto_spam_slowmode_enabled: v }).catch((e: Error) => setError(e.message))}
      />
      <FormError error={error} />
      <RulesScreening guild={guild} />
    </>
  )
}

function RulesScreening({ guild }: { guild: Guild }) {
  const text = useGuildChannels(guild.id, [0, 5])
  const [rules, setRules] = useState<string[] | null>(null)
  const [description, setDescription] = useState('')
  const [enabled, setEnabled] = useState(!!guild.features?.includes(GATE))
  const [channel, setChannel] = useState(guild.rules_channel_id ?? '')
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  useEffect(() => {
    getMemberVerification(guild.id).then(
      (v) => (setRules(v.form_fields.find((f) => f.field_type === 'TERMS')?.values ?? []), setDescription(v.description ?? '')),
      () => setRules([]), // none configured yet
    )
  }, [guild.id])
  if (!rules) return <p className="hint">{t('Loading rules…')}</p>
  const list = rules.length ? rules : ['']
  const edit = (i: number, v: string) => (setRules(list.map((r, j) => (j === i ? v : r))), setSaved(false))
  const clean = list.map((r) => r.trim()).filter(Boolean)
  const save = async () => {
    setError('')
    if (enabled && !clean.length) return setError(t('Add at least one rule before turning on rules screening.'))
    try {
      await saveMemberVerification(guild.id, {
        enabled, description: description.trim() || null,
        form_fields: clean.length ? [{ field_type: 'TERMS', label: 'Read and agree to the server rules', values: clean, required: true }] : [],
      })
      if ((guild.rules_channel_id ?? '') !== channel) await patchGuild(guild.id, { rules_channel_id: channel || null })
      setSaved(true)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <section aria-labelledby="rules-title">
      <h2 className="sub-title" id="rules-title">{t('Rules Screening')}</h2>
      <p className="hint">{t('New members see these rules and must agree to them before they can talk, react or join voice.')}</p>
      <Switch label={t('Require new members to agree to the rules')} checked={enabled} onChange={(v) => (setEnabled(v), setSaved(false))} />
      <div className="field top-gap">
        <label htmlFor="rules-channel">{t('Rules Channel')}</label>
        <select id="rules-channel" className="input" value={channel} onChange={(e) => (setChannel(e.target.value), setSaved(false))}>
          <option value="">{t('No rules channel')}</option>
          {text.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="rules-desc">{t('Description')}</label>
        <textarea id="rules-desc" className="input textarea" maxLength={300} value={description} onChange={(e) => (setDescription(e.target.value), setSaved(false))} placeholder={t('Welcome! Please read our rules.')} />
      </div>
      <fieldset className="plain">
        <legend className="field-label">{t('Server Rules')}</legend>
        <ol className="rules-edit">
          {list.map((r, i) => (
            <li key={i}>
              <span className="rule-n" aria-hidden="true">{i + 1}</span>
              <input className="input" aria-label={t('Rule {n}', { n: i + 1 })} maxLength={300} value={r} onChange={(e) => edit(i, e.target.value)} placeholder={t('Be respectful')} />
              <button className="icon-btn" aria-label={t('Remove rule {n}', { n: i + 1 })} onClick={() => (setRules(list.filter((_, j) => j !== i)), setSaved(false))}><Icon d={ICONS.trash} size={16} /></button>
            </li>
          ))}
        </ol>
        {list.length < MAX_RULES && <button className="secondary small-btn" onClick={() => setRules([...list, ''])}>{t('Add a rule')}</button>}
      </fieldset>
      <FormError error={error} />
      <div className="save-bar">
        {saved && <span className="success" role="status">{t('Saved.')}</span>}
        <button className="primary" onClick={save}>{t('Save Changes')}</button>
      </div>
    </section>
  )
}
