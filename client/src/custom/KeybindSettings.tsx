// User Settings → Keybinds (CONTRACT-v6 section 1): record a new combo per action, with conflict detection.
import { useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { patchSettings } from '../actions'
import { cls } from '../components/ui'
import { t } from '../i18n'
import { getState, useStore } from '../store'
import { saveVoiceSettings } from '../voice/settings'
import { ACTIONS, bindings, comboLabel, comboOf, conflicts } from './keybinds'

type Pending = { id: string; combo: string; clash: string[] }

export function KeybindSettings() {
  useStore((s) => s.settings.keybinds) // re-render when bindings sync
  const [recording, setRecording] = useState<string | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [, bump] = useState(0)
  const b = bindings()
  const label = (id: string) => t(ACTIONS.find((a) => a[0] === id)?.[1] ?? id)
  const assign = (id: string, combo: string, unbind: string[] = []) => {
    const own = { ...getState().settings.keybinds }
    for (const other of unbind) other === 'push-to-talk' ? saveVoiceSettings({ pttKey: '' }) : (own[other] = null)
    if (id === 'push-to-talk') saveVoiceSettings({ pttKey: combo })
    else own[id] = combo || null
    void patchSettings({ keybinds: own })
    setPending(null)
    setRecording(null)
    bump((n) => n + 1)
  }
  const onKey = (id: string) => (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Tab') return setRecording(null)
    e.preventDefault()
    e.stopPropagation()
    const raw = comboOf(e.nativeEvent)
    if (!raw) return
    const combo = id === 'push-to-talk' ? e.code : raw // push-to-talk is one held key
    const clash = conflicts(combo, id)
    if (clash.length) return setPending({ id, combo, clash })
    assign(id, combo)
  }
  return (
    <>
      <h1>{t('Keybinds')}</h1>
      <p className="hint">{t('Select a shortcut, then press the new key combination. Global hotkeys of the desktop app stay in its own settings.')}</p>
      <div aria-live="assertive" className="keybind-live">
        {pending && (
          <div className="notice" role="alert">
            {t('{combo} is already used for {other}.', { combo: comboLabel(pending.combo), other: pending.clash.map(label).join(', ') })}
            <div className="row-buttons top-gap">
              <button className="primary" onClick={() => assign(pending.id, pending.combo, pending.clash)}>{t('Use it for {action}', { action: label(pending.id) })}</button>
              <button className="link" onClick={() => (setPending(null), setRecording(null))}>{t('Cancel')}</button>
            </div>
          </div>
        )}
      </div>
      <table className="keybind-table">
        <caption className="sr-only">{t('Keybinds')}</caption>
        <thead><tr><th scope="col">{t('Action')}</th><th scope="col">{t('Keybind')}</th><th scope="col"><span className="sr-only">{t('Clear')}</span></th></tr></thead>
        <tbody>
          {ACTIONS.map(([id, text]) => {
            const clash = b[id] ? conflicts(b[id], id) : []
            return (
              <tr key={id} className={cls(clash.length > 0 && 'clash')}>
                <th scope="row">{t(text)}</th>
                <td>
                  <button data-keybind-recorder="" className={cls('keybind-btn', recording === id && 'recording')} aria-label={t('{action}: {combo}. Press to change.', { action: t(text), combo: comboLabel(b[id]) })}
                    onClick={() => (setPending(null), setRecording(recording === id ? null : id))} onKeyDown={recording === id ? onKey(id) : undefined} onBlur={() => recording === id && !pending && setRecording(null)}>
                    {recording === id ? t('Press keys…') : <kbd className="keybind">{comboLabel(b[id])}</kbd>}
                  </button>
                  {clash.length > 0 && <span className="danger-text small"> {t('Conflicts with {other}', { other: clash.map(label).join(', ') })}</span>}
                </td>
                <td><button className="link" disabled={!b[id]} onClick={() => assign(id, '')}>{t('Clear')}</button></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div className="save-bar">
        <button className="secondary" onClick={() => (saveVoiceSettings({ pttKey: 'Backquote' }), void patchSettings({ keybinds: {} }), bump((n) => n + 1))}>{t('Reset to defaults')}</button>
      </div>
    </>
  )
}
