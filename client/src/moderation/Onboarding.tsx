// New-member onboarding: the welcome screen and rules screening (member verification with TERMS rules).
import { t } from '../i18n'
import { useEffect, useState } from 'react'
import { acceptRules, getMemberVerification, getWelcomeScreen } from '../actions'
import { FormError, GuildIcon, Modal } from '../components/ui'
import { CustomEmoji } from '../markdown/Markdown'
import { navigate } from '../router'
import { myMember } from '../selectors'
import { getState, setState, useStore } from '../store'
import type { MemberVerification, WelcomeScreen } from '../types'
import { accentVars, welcomeBgUrl } from '../custom/ServerCustomize'
import { toHex } from '../custom/color'
import '../settings/settings-v3.css'

export function WelcomeModal({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const guild = useStore((s) => s.guilds[guildId])
  const channels = useStore((s) => s.channels)
  const [ws, setWs] = useState<WelcomeScreen | null>(null)
  const [error, setError] = useState('')
  useEffect(() => void getWelcomeScreen(guildId).then(setWs, (e: Error) => setError(e.message)), [guildId])
  // Pending members go on to the rules screening after the welcome.
  const close = () => (myMember(getState(), guildId)?.pending ? setState({ modal: { kind: 'rules', guildId } }) : onClose())
  if (!guild) return null
  const accent = ws?.accent_color != null ? toHex(ws.accent_color) : guild.brand_color_primary
  return (
    <Modal title={t('Welcome to {name}!', { name: guild.name })} onClose={close} className="welcome-modal">
      {/* v6: the welcome screen's background and accent colour (falling back to the server accent) */}
      {(welcomeBgUrl(guildId, ws) || accent) && <div className="welcome-hero" aria-hidden="true" style={{ backgroundImage: welcomeBgUrl(guildId, ws) ? `url("${welcomeBgUrl(guildId, ws)}")` : undefined, ...accentVars(accent) }} />}
      <div className="welcome-icon rail-icon big" aria-hidden="true"><GuildIcon guild={guild} /></div>
      {(ws?.description || guild.description) && <p className="welcome-desc">{ws?.description || guild.description}</p>}
      {ws && ws.welcome_channels.length > 0 && <h3 className="list-heading">{t('Here are some channels to start with')}</h3>}
      <ul className="welcome-channels">
        {ws?.welcome_channels.filter((w) => channels[w.channel_id]).map((w) => (
          <li key={w.channel_id}>
            <button className="welcome-channel" onClick={() => (navigate(`/channels/${guildId}/${w.channel_id}`), close())}>
              <span className="welcome-emoji" aria-hidden="true">{w.emoji_id ? <CustomEmoji id={w.emoji_id} name={w.emoji_name ?? 'emoji'} /> : w.emoji_name ?? '#'}</span>
              <span className="welcome-text"><span>{w.description || channels[w.channel_id].name}</span><span className="hint small">#{channels[w.channel_id].name}</span></span>
            </button>
          </li>
        ))}
      </ul>
      <FormError error={error} />
      <div className="modal-actions"><button className="primary accent-btn" style={accentVars(accent)} onClick={close}>{t('Continue')}</button></div>
    </Modal>
  )
}

export function RulesModal({ guildId, onClose }: { guildId: string; onClose: () => void }) {
  const guild = useStore((s) => s.guilds[guildId])
  const [v, setV] = useState<MemberVerification | null>(null)
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => void getMemberVerification(guildId).then(setV, (e: Error) => setError(e.message)), [guildId])
  const rules = v?.form_fields.filter((f) => f.field_type === 'TERMS').flatMap((f) => f.values ?? []) ?? []
  const submit = () => {
    if (!v) return
    setBusy(true)
    setError('')
    acceptRules(guildId, v).then(onClose, (e: Error) => (setError(e.message), setBusy(false)))
  }
  return (
    <Modal title={t('{name} Rules', { name: guild?.name ?? t('Server') })} onClose={onClose} className="rules-modal">
      <p className="hint">{t('Before you can talk here, read and agree to the rules.')}</p>
      {v?.description && <p className="rules-desc">{v.description}</p>}
      {!v && !error && <p className="hint">{t('Loading rules…')}</p>}
      {rules.length > 0 && <ol className="rules-list">{rules.map((r, i) => <li key={i}>{r}</li>)}</ol>}
      {v && (
        <label className="agree">
          <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} /> {t('I have read and agree to the rules')}
        </label>
      )}
      <FormError error={error} />
      <div className="modal-actions">
        <button className="secondary" onClick={onClose}>{t('Not Now')}</button>
        <button className="primary" disabled={!agreed || busy || !v} onClick={submit}>{t('Submit')}</button>
      </div>
    </Modal>
  )
}
