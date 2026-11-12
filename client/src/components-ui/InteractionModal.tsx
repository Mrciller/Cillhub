// Modals sent by applications (INTERACTION_MODAL_CREATE): text inputs in action rows or labels; submit sends a MODAL_SUBMIT (type 5).
import { useState, type FormEvent } from 'react'
import { sendInteraction } from '../actions'
import { FormError, Modal } from '../components/ui'
import { t } from '../i18n'
import { getState, type InteractionModal } from '../store'
import { instanceById, nodeOf } from '../instances/registry'
import type { Component } from '../types'
import './components-ui.css'

/** Text inputs of a modal with their surrounding label, in order (legacy action rows and type 18 labels). */
const inputs = (list: Component[]): { input: Component; label?: string; description?: string }[] =>
  list.flatMap((c) => (c.type === 4 ? [{ input: c, label: c.label }] : c.type === 1 ? inputs(c.components ?? []) : c.type === 18 && c.component ? inputs([c.component]).map((x) => ({ ...x, label: c.label, description: c.description })) : []))

export function InteractionModalView({ data, onClose }: { data: InteractionModal; onClose: () => void }) {
  const fields = inputs(data.components)
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.input.custom_id!, f.input.value ?? ''])))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    // Echo the modal's own structure back with the values filled in (user docs: modal submit component data).
    const fill = (c: Component): Component => c.type === 4 ? { type: 4, custom_id: c.custom_id, value: values[c.custom_id!] ?? '' }
      : c.type === 18 && c.component ? { type: 18, component: fill(c.component) } : { type: c.type, components: (c.components ?? []).map(fill) }
    const ch = getState().channels[data.channel_id]
    const app = data.application?.id ?? ''
    sendInteraction(
      { type: 5, application_id: app, guild_id: ch?.guild_id, channel_id: data.channel_id, data: { id: data.id, custom_id: data.custom_id, components: data.components.map(fill) } },
      { kind: 'modal', channelId: data.channel_id, appId: app, name: data.title },
    ).then(onClose, (err: Error) => (setError(err.message), setBusy(false)))
  }
  // A node's modal says where it comes from (and where typed values go).
  const node = instanceById(nodeOf(data.channel_id))
  return (
    <Modal title={data.title} onClose={onClose} className="interaction-modal">
      {node && <p className="hint small node-origin">{t('From {instance}, a separate server. What you enter goes there.', { instance: node.name })}</p>}
      {data.application?.name && <p className="hint small">{data.application.name}</p>}
      <form onSubmit={submit}>
        {fields.map(({ input: c, label, description }) => {
          const id = `im-${c.custom_id}`
          const Tag = c.style === 2 ? 'textarea' : 'input'
          return (
            <div key={c.custom_id} className="field">
              <label htmlFor={id}>{label}{c.required !== false && <span className="req" aria-hidden="true"> *</span>}</label>
              {description && <p className="hint small">{description}</p>}
              <Tag id={id} className={c.style === 2 ? 'input textarea' : 'input'} value={values[c.custom_id!]} placeholder={c.placeholder} required={c.required !== false}
                minLength={c.min_length} maxLength={c.max_length ?? 4000} onChange={(e) => setValues({ ...values, [c.custom_id!]: e.target.value })} />
            </div>
          )
        })}
        <FormError error={error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className="primary" disabled={busy}>{t('Submit')}</button>
        </div>
      </form>
    </Modal>
  )
}
