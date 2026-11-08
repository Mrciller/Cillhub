// In-app replacements for confirm(), prompt() and alert(): promise-returning dialogs and a toast region.
import { t } from '../i18n'
import { useState, useSyncExternalStore, type ReactNode } from 'react'
import { cls, Modal } from './ui'

type Ask = { id: number; kind: 'confirm'; title: string; body?: ReactNode; confirm: string; danger?: boolean; resolve: (ok: boolean) => void }
type AskText = {
  id: number; kind: 'text'; title: string; label: string; body?: ReactNode; initial: string; confirm: string; placeholder?: string; maxLength?: number
  allowEmpty?: boolean; multiline?: boolean; danger?: boolean; resolve: (v: string | null) => void
}
type Dialog = Ask | AskText
type Toast = { id: number; text: string }

let dialogs: Dialog[] = []
let toasts: Toast[] = []
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((l) => l())
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l))
let seq = 0
const close = (d: Dialog) => ((dialogs = dialogs.filter((x) => x !== d)), emit())

/** Confirmation dialog; resolves true when confirmed. */
export const ask = (o: { title: string; body?: ReactNode; confirm?: string; danger?: boolean }) =>
  new Promise<boolean>((resolve) => ((dialogs = [...dialogs, { id: ++seq, kind: 'confirm', confirm: t('Confirm'), ...o, resolve }]), emit()))

/** Text prompt dialog (nickname, reasons…); resolves the text, or null when cancelled. */
export const askText = (o: { title: string; label: string; body?: ReactNode; initial?: string; confirm?: string; placeholder?: string; maxLength?: number; allowEmpty?: boolean; multiline?: boolean; danger?: boolean }) =>
  new Promise<string | null>((resolve) => ((dialogs = [...dialogs, { id: ++seq, kind: 'text', initial: '', confirm: t('Save'), ...o, resolve }]), emit()))

let toastId = 0
/** A short message in the bottom toast region (role="alert"); replaces alert() for errors without a form. */
export function toast(text: string) {
  const t = { id: ++toastId, text }
  toasts = [...toasts.slice(-2), t]
  emit()
  setTimeout(() => ((toasts = toasts.filter((x) => x !== t)), emit()), 6000)
}
export const toastError = (e: unknown) => toast(e instanceof Error ? e.message : String(e))

function TextDialog({ d }: { d: AskText }) {
  const [v, setV] = useState(d.initial)
  const done = (value: string | null) => (close(d), d.resolve(value))
  const Input = d.multiline ? 'textarea' : 'input'
  return (
    <Modal title={d.title} onClose={() => done(null)}>
      <form onSubmit={(e) => (e.preventDefault(), (d.allowEmpty || v.trim()) && done(v))}>
        {d.body && <div className="dialog-body">{d.body}</div>}
        <div className="field">
          <label htmlFor="ask-text">{d.label}</label>
          <Input id="ask-text" className={cls('input', d.multiline && 'textarea')} value={v} maxLength={d.maxLength} placeholder={d.placeholder} autoFocus onChange={(e) => setV(e.target.value)} />
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={() => done(null)}>{t('Cancel')}</button>
          <button className={d.danger ? 'danger-btn' : 'primary'} disabled={!d.allowEmpty && !v.trim()}>{d.confirm}</button>
        </div>
      </form>
    </Modal>
  )
}

function ConfirmDialog({ d }: { d: Ask }) {
  const done = (ok: boolean) => (close(d), d.resolve(ok))
  return (
    <Modal title={d.title} onClose={() => done(false)}>
      {d.body && <div className="dialog-body">{d.body}</div>}
      <div className="modal-actions">
        <button className="secondary" onClick={() => done(false)}>{t('Cancel')}</button>
        <button className={d.danger ? 'danger-btn' : 'primary'} autoFocus onClick={() => done(true)}>{d.confirm}</button>
      </div>
    </Modal>
  )
}

export function DialogHost() {
  useSyncExternalStore(subscribe, () => dialogs)
  const list = useSyncExternalStore(subscribe, () => toasts)
  const d = dialogs[0]
  return (
    <>
      {d?.kind === 'confirm' && <ConfirmDialog key={d.id} d={d} />}
      {d?.kind === 'text' && <TextDialog key={d.id} d={d} />}
      <div className="toasts" role="alert" aria-live="assertive">
        {list.map((t) => <p key={t.id} className="toast">{t.text}</p>)}
      </div>
    </>
  )
}
