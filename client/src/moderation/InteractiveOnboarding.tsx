import { useEffect, useState } from 'react'
import { getOnboarding, respondOnboarding } from '../actions'
import { Modal } from '../components/ui'
import { t } from '../i18n'
import type { Guild, GuildOnboarding } from '../types'

export function InteractiveOnboardingModal({ guild, onClose }: { guild: Guild; onClose: () => void }) {
  const [onboarding, setOnboarding] = useState<GuildOnboarding | null>(null)
  const [selected, setSelected] = useState<Record<string, string[]>>({}) // promptId -> optionIds
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    getOnboarding(guild.id).then(
      (data) => setOnboarding(data),
      (err: Error) => setError(err.message),
    )
  }, [guild.id])

  const toggleOption = (promptId: string, optionId: string, singleSelect: boolean) => {
    setSelected((prev) => {
      const current = prev[promptId] ?? []
      if (singleSelect) {
        return { ...prev, [promptId]: [optionId] }
      }
      return {
        ...prev,
        [promptId]: current.includes(optionId)
          ? current.filter((id) => id !== optionId)
          : [...current, optionId],
      }
    })
  }

  const handleSubmit = async () => {
    setSubmitting(true)
    setError('')
    try {
      const allOptionIds = Object.values(selected).flat()
      await respondOnboarding(guild.id, allOptionIds)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSubmitting(false)
    }
  }

  const prompts = onboarding?.prompts ?? []

  return (
    <Modal title={t('Welcome to {name}', { name: guild.name })} onClose={onClose} className="onboarding-modal">
      <p className="hint">{t('Answer a few questions to customize your channels and roles in this server.')}</p>

      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="onboarding-prompts-flow" style={{ display: 'grid', gap: '16px', margin: '16px 0', maxHeight: '60vh', overflowY: 'auto' }}>
        {prompts.map((p) => {
          const sel = selected[p.id] ?? []
          return (
            <div key={p.id} style={{ border: '1px solid var(--border)', borderRadius: '8px', padding: '16px', background: 'var(--sidebar)' }}>
              <h3 style={{ margin: '0 0 10px', fontSize: '15px' }}>
                {p.title}
                {p.required && <span style={{ color: 'var(--danger)', marginLeft: '4px' }}>*</span>}
              </h3>
              <div style={{ display: 'grid', gap: '8px' }}>
                {p.options.map((opt) => {
                  const active = sel.includes(opt.id)
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={`card-btn ${active ? 'primary' : 'secondary'}`}
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'flex-start',
                        textAlign: 'left',
                        padding: '10px 14px',
                        borderRadius: '6px',
                        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
                        background: active ? 'color-mix(in srgb, var(--accent) 15%, var(--chat))' : 'var(--chat)',
                      }}
                      onClick={() => toggleOption(p.id, opt.id, p.single_select)}
                    >
                      <strong style={{ color: 'var(--header)', fontSize: '14px' }}>{opt.title}</strong>
                      {opt.description && <span className="hint small" style={{ marginTop: '2px' }}>{opt.description}</span>}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
      </div>

      <div className="modal-actions">
        <button className="link" onClick={onClose}>{t('Skip')}</button>
        <button className="primary" disabled={submitting || prompts.length === 0} onClick={() => void handleSubmit()}>
          {submitting ? t('Saving…') : t('Finish & Join')}
        </button>
      </div>
    </Modal>
  )
}
