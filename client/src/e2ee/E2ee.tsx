// Encrypted DMs, the UI: settings page, recovery key dialogs, the DM status line, lock button, security codes and
// decrypted attachments.
import { useEffect, useState, type ReactNode } from 'react'
import { cdn } from '../api'
import { ask, askText, toast, toastError } from '../components/dialogs'
import { cls, Icon, ICONS, Modal } from '../components/ui'
import { t } from '../i18n'
import { getState, useStore } from '../store'
import type { Attachment, Channel, Message } from '../types'
import { Attachments } from '../chat/Attachments'
import * as C from './crypto'
import { acceptKey, decryptDownload, enable, isDm, isEncrypted, keyChanged, keyProblem, myPublicKey, openChannel, publicKey, recover, safeType, useE2ee, useStatus, type FileRef } from './session'

/** Shows a new recovery key once; Done needs the "saved it" tick. */
function RecoveryKeyDialog({ text, onClose }: { text: string; onClose: () => void }) {
  const [saved, setSaved] = useState(false)
  const download = () => {
    const url = URL.createObjectURL(new Blob([`${t('Cillhub recovery key for encrypted messages')}\n${text}\n`], { type: 'text/plain' }))
    const a = Object.assign(document.createElement('a'), { href: url, download: 'cillhub-recovery-key.txt' })
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
  return (
    <Modal title={t('Your recovery key')} onClose={() => saved && onClose()}>
      <p>{t('You need this key to read your encrypted messages on a new device. It is shown only now. Keep it somewhere safe, away from this account.')}</p>
      <p className="e2ee-recovery" data-testid="recovery-key"><code>{text}</code></p>
      <div className="row-buttons">
        <button type="button" className="secondary" onClick={() => void navigator.clipboard.writeText(text).then(() => toast(t('Copied.')), toastError)}>{t('Copy')}</button>
        <button type="button" className="secondary" onClick={download}>{t('Download')}</button>
      </div>
      <label className="admin-radio"><input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> {t('I saved my recovery key')}</label>
      <div className="modal-actions"><button className="primary" disabled={!saved} onClick={onClose}>{t('Done')}</button></div>
    </Modal>
  )
}

export const askRecovery = () =>
  askText({
    title: t('Enter your recovery key'), label: t('Recovery key'), confirm: t('Unlock'), placeholder: 'ABCD-EFGH-…', maxLength: 64,
    body: <p>{t('Encrypted messages on this device need the recovery key you saved when you turned them on.')}</p>,
  }).then((v) => (v ? recover(v).then(() => toast(t('Encrypted messages unlocked on this device.'))) : undefined)).catch(toastError)

/** Settings → Encrypted Messages. */
export function EncryptionSettings() {
  const status = useStatus()
  const [shown, setShown] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const start = () => (setBusy(true), void enable().then(setShown, toastError).finally(() => setBusy(false)))
  const reset = () =>
    void ask({
      title: t('Reset encryption?'), danger: true, confirm: t('Reset'),
      body: <p>{t('You get a new key and a new recovery key. Encrypted messages from before cannot be read on new devices. Your contacts see that your security key changed.')}</p>,
    }).then((ok) => ok && start())
  return (
    <>
      <h1>{t('Encrypted Messages')}</h1>
      <p>{t('Direct messages and group messages are end-to-end encrypted once everyone in the conversation has turned this on. The server and its admins cannot read them.')}</p>
      <p className="hint">{t('Limits: one key for all your devices; the web app is delivered by the server you use; who writes to whom and when stays visible to the server; server channels are not encrypted.')}</p>
      {status === 'unknown' && <p className="hint">{t('Loading…')}</p>}
      {status === 'off' && <button className="primary" disabled={busy} onClick={start}>{t('Turn on encrypted messages')}</button>}
      {status === 'ready' && (
        <>
          <p><Icon d={ICONS.lock} size={16} /> {t('Encrypted messages are on for this device.')}</p>
          <button className="danger-btn" disabled={busy} onClick={reset}>{t('Reset encryption')}</button>
        </>
      )}
      {status === 'locked' && (
        <>
          <p>{t('Encrypted messages are on for your account, but this device does not have your key yet.')}</p>
          <div className="row-buttons">
            <button className="primary" onClick={askRecovery}>{t('Enter recovery key')}</button>
            <button className="danger-btn" disabled={busy} onClick={reset}>{t('Lost your recovery key? Reset encryption')}</button>
          </div>
        </>
      )}
      {shown && <RecoveryKeyDialog text={shown} onClose={() => setShown(null)} />}
    </>
  )
}

const name = (ch: Channel, id: string) => {
  const u = ch.recipients?.find((x) => x.id === id) ?? getState().users[id]
  return u?.global_name || u?.username || id
}

/** The line under a DM header: why it is not encrypted, a missing recovery key, changed security keys. */
export function E2eeBar({ channel }: { channel: Channel }) {
  useE2ee()
  const status = useStatus()
  const me = useStore((s) => s.me?.id ?? '')
  const others = (channel.recipients ?? []).filter((u) => u.id !== me)
  const ids = others.map((u) => u.id).join()
  const [verify, setVerify] = useState<string | null>(null)
  useEffect(() => void openChannel(channel).catch(() => {}), [channel.id, channel.e2ee_epoch, ids, status]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!isDm(channel)) return null
  const bot = others.some((u) => u.bot || u.system)
  const enc = isEncrypted(channel)
  const missing = others.filter((u) => publicKey(u.id) === null)
  const changed = others.filter((u) => keyChanged(u.id))
  const problem = !bot && keyProblem(channel)
  let line: ReactNode = null
  if (problem) line = null // the warning below says it
  else if (bot) line = <>{t('Not encrypted: conversations with apps are never end-to-end encrypted.')}</>
  else if (enc && status === 'locked') line = <>{t('Enter your recovery key to read this conversation.')} <button className="link" onClick={askRecovery}>{t('Enter recovery key')}</button></>
  else if (!enc && status === 'off') line = <>{t('Not encrypted yet: turn on encrypted messages in Settings.')}</>
  else if (!enc && missing.length) line = <>{t('Not encrypted yet: {name} has not set up encrypted messages.', { name: missing.map((u) => name(channel, u.id)).join(', ') })}</>
  return (
    <>
      {line && <p className="e2ee-bar" role="status"><Icon d={ICONS.lock} size={14} className={cls(!enc && 'e2ee-open')} /> {line}</p>}
      {problem && <p className="e2ee-bar warn" role="alert">{t('The key of this conversation could not be verified.')}</p>}
      {!bot && changed.map((u) => (
        <p key={u.id} className="e2ee-bar warn" role="alert">
          {t("{name}'s security key changed.", { name: name(channel, u.id) })}{' '}
          <button className="link" onClick={() => setVerify(u.id)}>{t('Verify security code')}</button>{' · '}
          <button className="link" onClick={() => acceptKey(u.id)}>{t('Dismiss')}</button>
        </p>
      ))}
      {verify && <SecurityCode channel={channel} userId={verify} onClose={() => setVerify(null)} />}
    </>
  )
}

/** Header button of a DM: closed lock when encrypted; opens the details with the security codes. */
export function E2eeLock({ channel }: { channel: Channel }) {
  useE2ee()
  const [open, setOpen] = useState(false)
  const [code, setCode] = useState<string | null>(null)
  if (!isDm(channel)) return null
  const enc = isEncrypted(channel)
  const label = enc ? t('End-to-end encrypted') : t('Not end-to-end encrypted')
  const others = (channel.recipients ?? []).filter((u) => u.id !== getState().me?.id && !u.bot)
  return (
    <>
      <button className={cls('icon-btn', 'e2ee-lock', enc && 'on')} aria-label={label} title={label} onClick={() => setOpen(true)}>
        <Icon d={ICONS.lock} />
      </button>
      {open && (
        <Modal title={label} onClose={() => setOpen(false)}>
          <p>{enc
            ? t('Messages and files in this conversation are encrypted on your device. Only its members can read them. The server sees who writes when, not what.')
            : t('This conversation is not encrypted. It becomes encrypted once every member has turned on encrypted messages.')}</p>
          {enc && others.length > 0 && (
            <>
              <p className="hint">{t('To check that nobody is in between, compare the security code with each member in person or on a call.')}</p>
              <ul className="admin-list">
                {others.map((u) => <li key={u.id}><button className="link" onClick={() => setCode(u.id)}>{t('Verify security code with {name}', { name: u.global_name || u.username })}</button></li>)}
              </ul>
            </>
          )}
        </Modal>
      )}
      {code && <SecurityCode channel={channel} userId={code} onClose={() => setCode(null)} />}
    </>
  )
}

function SecurityCode({ channel, userId, onClose }: { channel: Channel; userId: string; onClose: () => void }) {
  const [code, setCode] = useState('')
  const theirs = publicKey(userId)
  useEffect(() => {
    const mine = myPublicKey()
    if (mine && theirs) void C.securityCode(mine, theirs).then(setCode)
  }, [theirs])
  return (
    <Modal title={t('Security code with {name}', { name: name(channel, userId) })} onClose={onClose}>
      <p>{t('Compare these 60 digits with {name}. If they match, nobody is reading along.', { name: name(channel, userId) })}</p>
      {code ? <p className="e2ee-code" data-testid="security-code"><code>{code}</code></p> : <p className="hint">{t('No security code yet: one of you has no encryption key on this device.')}</p>}
      <div className="modal-actions">
        {code && keyChanged(userId) && <button className="secondary" onClick={() => (acceptKey(userId), onClose())}>{t('Codes match')}</button>}
        <button className="primary" onClick={onClose}>{t('Close')}</button>
      </div>
    </Modal>
  )
}

/** Files of an encrypted message: fetched, decrypted, shown from blob URLs that go away with the message. */
export function E2eeFiles({ m, files }: { m: Message; files: FileRef[] }) {
  const [list, setList] = useState<Attachment[] | null>(null)
  const [failed, setFailed] = useState(false)
  const key = files.map((f) => f.k).join()
  useEffect(() => {
    let live = true
    const urls: string[] = []
    void Promise.all(files.map(async (f): Promise<Attachment | null> => {
      const a = m.attachments[Number(f.id)]
      if (!a || !/^\d{1,2}$/.test(f.id)) return null
      const url = URL.createObjectURL(await decryptDownload(cdn(a.url), f))
      urls.push(url)
      if (!live) URL.revokeObjectURL(url)
      return { id: a.id, filename: f.name, size: f.size ?? a.size, content_type: safeType(f.type), url, proxy_url: url, ...(f.w && f.h && { width: f.w, height: f.h }) } as Attachment
    })).then((l) => live && setList(l.filter((x): x is Attachment => !!x)), () => live && setFailed(true))
    return () => {
      live = false
      urls.forEach((u) => URL.revokeObjectURL(u))
    }
  }, [m.id, key]) // eslint-disable-line react-hooks/exhaustive-deps
  if (!files.length) return null
  if (failed) return <p className="hint e2ee-line">{t('Cannot decrypt this file.')}</p>
  if (!list) return <p className="hint small">{t('Decrypting {n} files…', { n: files.length })}</p>
  return <Attachments list={list} />
}
