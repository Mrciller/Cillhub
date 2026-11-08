import { useEffect, useState } from 'react'
import { getOnboarding, updateOnboarding } from '../actions'
import { Icon, ICONS } from '../components/ui'
import { Switch } from './Layout'
import { t } from '../i18n'
import { useStore } from '../store'
import type { Guild, OnboardingOption, OnboardingPrompt } from '../types'

export function OnboardingPage({ guild }: { guild: Guild }) {
  const [enabled, setEnabled] = useState(false)
  const [prompts, setPrompts] = useState<OnboardingPrompt[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState('')

  const allRoles = Object.values(useStore((s) => s.guilds[guild.id]?.roles ?? {})).filter((r) => r.name !== '@everyone' && !r.managed)

  useEffect(() => {
    getOnboarding(guild.id).then(
      (data) => {
        setEnabled(data.enabled)
        setPrompts(data.prompts)
        setLoading(false)
      },
      (err: Error) => {
        setError(err.message)
        setLoading(false)
      },
    )
  }, [guild.id])

  const addPrompt = () => {
    const newPrompt: OnboardingPrompt = {
      id: String(Date.now()),
      title: '',
      single_select: false,
      required: true,
      options: [
        { id: String(Date.now() + 1), title: '', description: '', role_ids: [], channel_ids: [] },
      ],
    }
    setPrompts([...prompts, newPrompt])
    setSaved(false)
  }

  const removePrompt = (index: number) => {
    setPrompts(prompts.filter((_, i) => i !== index))
    setSaved(false)
  }

  const addOption = (promptIndex: number) => {
    const newOpt: OnboardingOption = {
      id: String(Date.now()),
      title: '',
      description: '',
      role_ids: [],
      channel_ids: [],
    }
    const updated = [...prompts]
    updated[promptIndex].options.push(newOpt)
    setPrompts(updated)
    setSaved(false)
  }

  const removeOption = (promptIndex: number, optIndex: number) => {
    const updated = [...prompts]
    updated[promptIndex].options = updated[promptIndex].options.filter((_, i) => i !== optIndex)
    setPrompts(updated)
    setSaved(false)
  }

  const save = async () => {
    setSaving(true)
    setError('')
    try {
      await updateOnboarding(guild.id, enabled, prompts)
      setSaved(true)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  if (loading) return <p className="hint">{t('Loading onboarding configuration…')}</p>

  return (
    <div className="onboarding-page">
      <h1>{t('Interactive Server Onboarding')}</h1>
      <p className="hint">
        {t('Set up interactive questions for new members to automatically assign roles and unlock channels on join.')}
      </p>

      {error && <p className="form-error" role="alert">{error}</p>}
      {saved && <p className="form-success" role="status">{t('Onboarding settings saved successfully.')}</p>}

      <div className="card-box" style={{ margin: '16px 0', padding: '16px', background: 'var(--sidebar)', borderRadius: '8px' }}>
        <Switch
          label={t('Enable Onboarding Flow')}
          note={t('When enabled, newly joining members will be prompted to answer these questions.')}
          checked={enabled}
          onChange={(val: boolean) => { setEnabled(val); setSaved(false) }}
        />
      </div>

      <div className="prompts-list">
        {prompts.map((p, pIdx) => (
          <div key={p.id} className="prompt-card" style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '16px', marginBottom: '16px', background: 'var(--chat)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ margin: 0 }}>{t('Question {n}', { n: pIdx + 1 })}</h3>
              <button className="icon-btn danger" aria-label={t('Delete question')} onClick={() => removePrompt(pIdx)}>
                <Icon d={ICONS.trash} size={16} />
              </button>
            </div>

            <div className="field">
              <label>{t('Question Title')}</label>
              <input
                className="input"
                value={p.title}
                maxLength={100}
                placeholder={t('e.g. What games do you play?')}
                onChange={(e) => {
                  const updated = [...prompts]
                  updated[pIdx].title = e.target.value
                  setPrompts(updated)
                  setSaved(false)
                }}
              />
            </div>

            <div style={{ display: 'flex', gap: '24px', margin: '12px 0' }}>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={p.single_select}
                  onChange={(e) => {
                    const updated = [...prompts]
                    updated[pIdx].single_select = e.target.checked
                    setPrompts(updated)
                    setSaved(false)
                  }}
                />
                {t('Single selection only')}
              </label>
              <label className="inline-check">
                <input
                  type="checkbox"
                  checked={p.required}
                  onChange={(e) => {
                    const updated = [...prompts]
                    updated[pIdx].required = e.target.checked
                    setPrompts(updated)
                    setSaved(false)
                  }}
                />
                {t('Required')}
              </label>
            </div>

            <div className="options-list" style={{ marginTop: '16px' }}>
              <h4>{t('Options')}</h4>
              {p.options.map((opt, oIdx) => (
                <div key={opt.id} style={{ border: '1px dashed var(--border)', borderRadius: '6px', padding: '12px', marginBottom: '10px', background: 'var(--sidebar)' }}>
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <input
                      className="input"
                      style={{ flex: 1 }}
                      placeholder={t('Option label, e.g. Valorant')}
                      value={opt.title}
                      maxLength={100}
                      onChange={(e) => {
                        const updated = [...prompts]
                        updated[pIdx].options[oIdx].title = e.target.value
                        setPrompts(updated)
                        setSaved(false)
                      }}
                    />
                    <button className="icon-btn" aria-label={t('Remove option')} onClick={() => removeOption(pIdx, oIdx)}>
                      <Icon d={ICONS.close} size={14} />
                    </button>
                  </div>
                  <input
                    className="input"
                    style={{ marginTop: '8px', fontSize: '13px' }}
                    placeholder={t('Description (optional)')}
                    value={opt.description ?? ''}
                    maxLength={200}
                    onChange={(e) => {
                      const updated = [...prompts]
                      updated[pIdx].options[oIdx].description = e.target.value || null
                      setPrompts(updated)
                      setSaved(false)
                    }}
                  />
                  <div style={{ marginTop: '8px' }}>
                    <label className="field-label small" style={{ display: 'block', marginBottom: '4px' }}>{t('Assigned Roles:')}</label>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
                      {allRoles.map((r) => {
                        const sel = opt.role_ids.includes(r.id)
                        return (
                          <button
                            key={r.id}
                            type="button"
                            className={`small-btn ${sel ? 'primary' : 'secondary'}`}
                            style={{ fontSize: '12px', padding: '2px 8px' }}
                            onClick={() => {
                              const updated = [...prompts]
                              const currentRoles = opt.role_ids
                              updated[pIdx].options[oIdx].role_ids = sel
                                ? currentRoles.filter((id) => id !== r.id)
                                : [...currentRoles, r.id]
                              setPrompts(updated)
                              setSaved(false)
                            }}
                          >
                            {sel ? '✓ ' : '+ '}{r.name}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              ))}
              <button className="secondary small-btn" onClick={() => addOption(pIdx)} style={{ marginTop: '6px' }}>
                <Icon d={ICONS.plus} size={14} /> {t('Add Option')}
              </button>
            </div>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '24px' }}>
        <button className="secondary" onClick={addPrompt}>
          <Icon d={ICONS.plus} size={16} /> {t('Add Question')}
        </button>
        <button className="primary" disabled={saving} onClick={() => void save()}>
          {saving ? t('Saving…') : t('Save Onboarding')}
        </button>
      </div>
    </div>
  )
}
