// Full-screen settings dialog with a vertical tab list.
import { t } from '../i18n'
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { cls, Icon, ICONS } from '../components/ui'

export type TabDef = { id: string; label: string; section?: string }

type Props = { title: string; tabs: TabDef[]; tab: string; setTab: (id: string) => void; onClose: () => void; children: ReactNode; footer?: ReactNode }

export function SettingsLayout({ title, tabs, tab, setTab, onClose, children, footer }: Props) {
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    ref.current?.showModal()
    return () => opener?.focus?.()
  }, [])
  // Arrow keys move between tabs (vertical tablist pattern).
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === tab)
    const next = e.key === 'ArrowDown' ? i + 1 : e.key === 'ArrowUp' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : -2
    if (next === -2 || !tabs[next]) return
    e.preventDefault()
    setTab(tabs[next].id)
    requestAnimationFrame(() => document.getElementById(`${id}-tab-${tabs[next].id}`)?.focus())
  }
  let section = ''
  return (
    <dialog ref={ref} className="settings" aria-labelledby={`${id}-title`} onClose={onClose}>
      <div className="settings-nav">
        <div className="settings-nav-inner">
          <h2 id={`${id}-title`} className="list-heading">{title}</h2>
          <div role="tablist" aria-orientation="vertical" aria-labelledby={`${id}-title`} onKeyDown={onKeyDown}>
            {tabs.map((t) => {
              // a first section named like the dialog ("User Settings") is not repeated under the title
              const head = t.section && t.section !== section ? ((section = t.section), t.section === title ? null : <h3 className="list-heading" key={`s-${t.section}`}>{t.section}</h3>) : null
              return [
                head,
                <button
                  key={t.id}
                  id={`${id}-tab-${t.id}`}
                  role="tab"
                  aria-selected={t.id === tab}
                  aria-controls={`${id}-panel`}
                  tabIndex={t.id === tab ? 0 : -1}
                  className={cls('settings-tab', t.id === tab && 'active')}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>,
              ]
            })}
          </div>
          {footer && <div className="settings-footer">{footer}</div>}
        </div>
      </div>
      <div className="settings-main">
        <section id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-tab-${tab}`} className="settings-content">
          {children}
        </section>
        <div className="settings-close">
          <button className="close-x" aria-label={t('Close settings')} onClick={onClose}><Icon d={ICONS.close} size={18} /></button>
          <span aria-hidden="true">ESC</span>
        </div>
      </div>
    </dialog>
  )
}

/** Checkbox styled as a toggle switch. */
export function Switch({ label, note, checked, disabled, onChange }: { label: string; note?: string; checked: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  const id = useId()
  return (
    <div className={cls('switch-row', disabled && 'disabled')}>
      <div className="switch-text">
        <label htmlFor={id}>{label}</label>
        {note && <p className="hint small" id={`${id}-note`}>{note}</p>}
      </div>
      <input id={id} type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} aria-describedby={note ? `${id}-note` : undefined} onChange={(e) => onChange(e.target.checked)} />
    </div>
  )
}
