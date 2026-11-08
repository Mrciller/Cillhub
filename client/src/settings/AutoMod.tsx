// Server Settings > AutoMod (auto-moderation.mdx): KEYWORD, MENTION_SPAM and MEMBER_PROFILE rules with their actions.
import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { autoModRules, deleteAutoModRule, saveAutoModRule } from '../actions'
import { ask } from '../components/dialogs'
import { cls, FormError, Icon, ICONS, Modal } from '../components/ui'
import { sortedRoles } from '../permissions'
import type { AutoModAction, AutoModRule, Guild } from '../types'
import { Switch } from './Layout'
import { useGuildChannels } from './ServerSettings'

const TRIGGERS: Record<number, [string, string]> = {
  1: ['Custom Keywords', 'Block messages that contain specific words or phrases.'],
  5: ['Mention Spam', 'Block messages with too many unique @mentions.'],
  6: ['Member Profile', 'Block members whose nicknames contain specific words from talking.'],
}
const TIMEOUTS: [number, string][] = [[60, '60 seconds'], [300, '5 minutes'], [600, '10 minutes'], [3600, '1 hour'], [86400, '1 day'], [604800, '1 week']]
const lines = (s: string) => s.split(/[\n,]/).map((x) => x.trim()).filter(Boolean)

export function AutoModPage({ guild }: { guild: Guild }) {
  const [rules, setRules] = useState<AutoModRule[] | null>(null)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState<Partial<AutoModRule> | null>(null)
  const reload = () => autoModRules(guild.id).then(setRules, (e: Error) => setError(e.message))
  useEffect(() => void reload(), [guild.id])
  const toggle = (r: AutoModRule, enabled: boolean) =>
    saveAutoModRule(guild.id, { id: r.id, enabled }).then((x) => setRules((l) => l?.map((y) => (y.id === r.id ? { ...y, ...x, enabled } : y)) ?? null), (e: Error) => setError(e.message))
  return (
    <>
      <h1>{t('AutoMod')}</h1>
      <p className="hint">{t('Rules that check messages and member profiles automatically, and block, flag or time out what matches.')}</p>
      <button className="primary" onClick={() => setEditing({ trigger_type: 1 })}>{t('Create Rule')}</button>
      <FormError error={error} />
      {rules?.length === 0 && <p className="hint top-gap">{t('No rules yet.')}</p>}
      <ul className="automod-list" aria-label={t('AutoMod rules')}>
        {rules?.map((r) => (
          <li key={r.id} className="automod-card">
            <Icon d={ICONS.shield} size={24} className="hint" />
            <div className="automod-text">
              <span className="expr-name">{r.name}</span>
              <span className="hint small">{TRIGGERS[r.trigger_type] ? t(TRIGGERS[r.trigger_type][0]) : t('Trigger {n}', { n: r.trigger_type })} · {t(r.actions.length === 1 ? '{n} action' : '{n} actions', { n: r.actions.length })}</span>
            </div>
            <button className="secondary small-btn" onClick={() => setEditing(r)} aria-label={t('Edit rule {name}', { name: r.name })}>{t('Edit')}</button>
            <input type="checkbox" role="switch" className="switch" aria-label={t('Rule {name} enabled', { name: r.name })} checked={r.enabled} onChange={(e) => toggle(r, e.target.checked)} />
          </li>
        ))}
      </ul>
      {editing && <RuleEditor guild={guild} rule={editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), void reload())} />}
    </>
  )
}

function RuleEditor({ guild, rule, onClose, onSaved }: { guild: Guild; rule: Partial<AutoModRule>; onClose: () => void; onSaved: () => void }) {
  const channels = useGuildChannels(guild.id, [0, 5, 2, 13, 15])
  const textChannels = channels.filter((c) => c.type === 0 || c.type === 5)
  const roles = sortedRoles(guild).filter((r) => r.id !== guild.id)
  const isNew = !rule.id
  const [trigger, setTrigger] = useState(rule.trigger_type ?? 1)
  const [name, setName] = useState(rule.name ?? '')
  const meta = rule.trigger_metadata ?? {}
  const [keywords, setKeywords] = useState((meta.keyword_filter ?? []).join('\n'))
  const [regex, setRegex] = useState((meta.regex_patterns ?? []).join('\n'))
  const [allow, setAllow] = useState((meta.allow_list ?? []).join('\n'))
  const [limit, setLimit] = useState(meta.mention_total_limit ?? 5)
  const find = (type: number) => rule.actions?.find((a) => a.type === type)
  const [block, setBlock] = useState(isNew || !!find(1) || !!find(4))
  const [custom, setCustom] = useState(find(1)?.metadata?.custom_message ?? '')
  const [alertChannel, setAlertChannel] = useState(find(2)?.metadata?.channel_id ?? '')
  const [timeout, setTimeoutSecs] = useState(find(3)?.metadata?.duration_seconds ?? 0)
  const [exemptRoles, setExemptRoles] = useState(rule.exempt_roles ?? [])
  const [exemptChannels, setExemptChannels] = useState(rule.exempt_channels ?? [])
  const [error, setError] = useState('')
  const profile = trigger === 6
  const toggleIn = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id])

  const save = () => {
    setError('')
    const regexes = lines(regex)
    if (regexes.length > 10) return setError(t('Use at most 10 regex patterns.'))
    if (regexes.some((p) => p.length > 260)) return setError(t('Each regex pattern can be at most 260 characters.'))
    const actions: AutoModAction[] = [
      ...(block ? [profile ? { type: 4 } : { type: 1, metadata: { custom_message: custom.trim() || undefined } }] : []),
      ...(alertChannel ? [{ type: 2, metadata: { channel_id: alertChannel } }] : []),
      ...(timeout && !profile ? [{ type: 3, metadata: { duration_seconds: timeout } }] : []),
    ]
    if (!actions.length) return setError(t('Choose at least one action.'))
    const body: Partial<AutoModRule> = {
      ...(rule.id && { id: rule.id }), name: name.trim() || t(TRIGGERS[trigger][0]), event_type: profile ? 2 : 1, trigger_type: trigger,
      trigger_metadata: trigger === 5 ? { mention_total_limit: limit } : { keyword_filter: lines(keywords), regex_patterns: regexes, allow_list: lines(allow) },
      actions, enabled: rule.enabled ?? true, exempt_roles: exemptRoles, exempt_channels: profile ? [] : exemptChannels,
    }
    saveAutoModRule(guild.id, body).then(onSaved, (e: Error) => setError(e.message))
  }
  const remove = () =>
    void ask({ title: t('Delete Rule'), body: <p>{t('Delete the rule {name}?', { name: rule.name ?? '' })}</p>, confirm: t('Delete'), danger: true })
      .then((ok) => void (ok && rule.id && deleteAutoModRule(guild.id, rule.id).then(onSaved, (e: Error) => setError(e.message))))

  return (
    <Modal title={isNew ? t('Create AutoMod Rule') : t('Edit {name}', { name: rule.name ?? '' })} onClose={onClose} className="wide-modal">
      {isNew && (
        <fieldset className="choice block">
          <legend>{t('Rule Type')}</legend>
          {Object.entries(TRIGGERS).map(([k, [label, note]]) => (
            <label key={k} className={cls('radio-card', trigger === +k && 'on')}>
              <input type="radio" name="trigger" checked={trigger === +k} onChange={() => setTrigger(+k)} />
              <span><span className="type-name">{t(label)}</span><span className="hint small type-note">{t(note)}</span></span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="field"><label htmlFor="am-name">{t('Rule Name')}</label><input id="am-name" className="input" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} placeholder={t(TRIGGERS[trigger][0])} /></div>
      {trigger === 5 ? (
        <div className="field"><label htmlFor="am-limit">{t('Mention Limit')}</label><input id="am-limit" type="number" className="input" min={1} max={50} value={limit} onChange={(e) => setLimit(+e.target.value)} /></div>
      ) : (
        <>
          <div className="field">
            <label htmlFor="am-keywords">{t('Keywords')}</label>
            <textarea id="am-keywords" className="input textarea" value={keywords} onChange={(e) => setKeywords(e.target.value)} placeholder={t('One per line or comma separated. Use * as a wildcard: cat*, *dog, *ana*')} />
          </div>
          <div className="field">
            <label htmlFor="am-regex">{t('Regex Patterns (up to 10)')}</label>
            <textarea id="am-regex" className="input textarea" value={regex} onChange={(e) => setRegex(e.target.value)} placeholder="(b|c)at" />
          </div>
          <div className="field">
            <label htmlFor="am-allow">{t('Allowed Words')}</label>
            <textarea id="am-allow" className="input textarea" value={allow} onChange={(e) => setAllow(e.target.value)} placeholder={t('Words that never trigger this rule')} />
          </div>
        </>
      )}
      <h3>{t('Actions')}</h3>
      <Switch label={profile ? t('Block member from interacting') : t('Block message')} checked={block} onChange={setBlock} />
      {block && !profile && (
        <div className="field top-gap"><label htmlFor="am-custom">{t('Custom Response')}</label><input id="am-custom" className="input" maxLength={150} value={custom} onChange={(e) => setCustom(e.target.value)} placeholder={t('This message was blocked by AutoMod.')} /></div>
      )}
      <div className="field top-gap">
        <label htmlFor="am-alert">{t('Send Alert To')}</label>
        <select id="am-alert" className="input" value={alertChannel} onChange={(e) => setAlertChannel(e.target.value)}>
          <option value="">{t("Don't send an alert")}</option>
          {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
        </select>
      </div>
      {!profile && (
        <div className="field">
          <label htmlFor="am-timeout">{t('Timeout Member')}</label>
          <select id="am-timeout" className="input" value={timeout} onChange={(e) => setTimeoutSecs(+e.target.value)}>
            <option value={0}>{t("Don't time out")}</option>
            {TIMEOUTS.map(([v, l]) => <option key={v} value={v}>{t(l)}</option>)}
          </select>
        </div>
      )}
      <details className="am-exempt">
        <summary>{t('Exemptions ({n})', { n: exemptRoles.length + exemptChannels.length })}</summary>
        <fieldset className="plain">
          <legend className="field-label">{t('Exempt Roles')}</legend>
          <div className="check-list">
            {roles.map((r) => <label key={r.id}><input type="checkbox" checked={exemptRoles.includes(r.id)} onChange={() => setExemptRoles(toggleIn(exemptRoles, r.id))} /> {r.name}</label>)}
          </div>
        </fieldset>
        {!profile && (
          <fieldset className="plain">
            <legend className="field-label">{t('Exempt Channels')}</legend>
            <div className="check-list">
              {channels.map((c) => <label key={c.id}><input type="checkbox" checked={exemptChannels.includes(c.id)} onChange={() => setExemptChannels(toggleIn(exemptChannels, c.id))} /> #{c.name}</label>)}
            </div>
          </fieldset>
        )}
      </details>
      <FormError error={error} />
      <div className="modal-actions">
        {!isNew && <button className="danger-btn" onClick={remove}>{t('Delete Rule')}</button>}
        <span className="spacer" />
        <button className="secondary" onClick={onClose}>{t('Cancel')}</button>
        <button className="primary" onClick={save}>{isNew ? t('Create Rule') : t('Save Changes')}</button>
      </div>
    </Modal>
  )
}
