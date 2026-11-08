// What's New: the changelog bundled with this client (changelog.json, generated from CHANGELOG.md and CHANGELOG.de.md by
// scripts/changelog.cjs). Shown in User Settings, from the status menu, and once by itself after the client version changes.
// Plain web APIs only: the same code runs on the website, in the desktop app and in the Android app.
import { useEffect } from 'react'
import { Modal } from '../components/ui'
import { getLocale, intlLocale, t } from '../i18n'
import { getState, setState } from '../store'
import data from './changelog.json'
import './whatsnew.css'

/** This client's version: the newest dated web app release in the changelog ("Unreleased" does not count). */
export const CLIENT_VERSION = data.en[0].releases.find((r) => r.date)?.version ?? 'dev'
const SEEN = 'whats-new-seen'

type Level = 2 | 3
const H = ({ level, className, children }: { level: number; className: string; children: string }) => {
  const Tag = `h${level}` as 'h2'
  return <Tag className={className}>{children}</Tag>
}
const day = (date: string) => new Intl.DateTimeFormat(intlLocale(), { dateStyle: 'long', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))

/** The whole changelog; `level` is the heading level of the product titles (releases and sections nest below). */
export function Changelog({ level }: { level: Level }) {
  return (
    <div className="changelog">
      {(getLocale() === 'de' ? data.de : data.en).map((p) => (
        <section key={p.title}>
          <H level={level} className="changelog-product">{p.title}</H>
          {p.releases.map((r) => (
            <section key={r.version}>
              <H level={level + 1} className="changelog-version">{r.date ? `${r.version} · ${day(r.date)}` : t('Unreleased')}</H>
              {r.groups.map((g) => (
                <div key={g.title}>
                  <H level={level + 2} className="changelog-group">{g.title}</H>
                  <ul>{g.items.map((x) => <li key={x}>{x}</li>)}</ul>
                </div>
              ))}
            </section>
          ))}
        </section>
      ))}
    </div>
  )
}

/** User Settings › What's New. */
export function WhatsNewPage() {
  return (
    <>
      <h1>{t("What's New")}</h1>
      <Changelog level={2} />
    </>
  )
}

export function WhatsNewModal({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={t("What's New")} onClose={onClose} className="whats-new">
      {/* first focusable element, so the dialog opens at the top and arrow keys scroll the list */}
      <div className="whats-new-list" tabIndex={0} role="region" aria-label={t('Changelog')}>
        <Changelog level={3} />
      </div>
      <div className="modal-actions">
        <button className="primary" onClick={onClose}>{t('Close')}</button>
      </div>
    </Modal>
  )
}

/** Opens What's New once after the client version changed. The first run on a device only records the version. */
export function useWhatsNewOnce(ready: boolean) {
  useEffect(() => {
    if (!ready) return
    const seen = localStorage.getItem(SEEN)
    if (seen === CLIENT_VERSION) return
    if (seen && getState().modal) return // another dialog is open (welcome screen…): try again next session
    localStorage.setItem(SEEN, CLIENT_VERSION)
    if (seen) setState({ modal: { kind: 'whats-new' } })
  }, [ready])
}
