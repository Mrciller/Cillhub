// "Set a custom status": emoji, text (≤ 128) and when to clear it (CONTRACT-v4: 30 min, 1 h, 4 h, today, never).
import { useState } from 'react'
import { setCustomStatus, type EmojiRef } from '../actions'
import type { Anchor } from '../components/menu'
import { FormError, Icon, ICONS, Modal } from '../components/ui'
import { EmojiPicker } from '../emoji/EmojiPicker'
import { t } from '../i18n'
import { CustomEmoji } from '../markdown/Markdown'
import { displayName, useStore } from '../store'

const CLEAR: [string, () => string | null][] = [
  ['Today', () => new Date(new Date().setHours(23, 59, 59, 999)).toISOString()],
  ['4 hours', () => new Date(Date.now() + 4 * 3600e3).toISOString()],
  ['1 hour', () => new Date(Date.now() + 3600e3).toISOString()],
  ['30 minutes', () => new Date(Date.now() + 30 * 60e3).toISOString()],
  ["Don't clear", () => null],
]

export function CustomStatusModal({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me)
  const cs = useStore((s) => s.settings.custom_status)
  const [text, setText] = useState(cs?.text ?? '')
  const [emoji, setEmoji] = useState<EmojiRef | null>(cs?.emoji_id ? { id: cs.emoji_id, name: cs.emoji_name ?? '' } : cs?.emoji_name ? { id: null, name: cs.emoji_name } : null)
  const [clear, setClear] = useState(0)
  const [picker, setPicker] = useState<Anchor | null>(null)
  const [error, setError] = useState('')
  const save = () => {
    const empty = !text.trim() && !emoji
    setCustomStatus(empty ? null : { text: text.trim() || null, emoji_id: emoji?.id ?? null, emoji_name: emoji?.name ?? null, expires_at: CLEAR[clear][1]() }).then(onClose, (e: Error) => setError(e.message))
  }
  return (
    <Modal title={t('Set a custom status')} onClose={onClose} className="custom-status-modal">
      <form onSubmit={(e) => (e.preventDefault(), save())}>
        <label className="field-label" htmlFor="cs-text">{t("What's cookin', {name}?", { name: me ? displayName(me) : '' })}</label>
        <div className="cs-row">
          <button type="button" className="icon-btn cs-emoji" aria-label={emoji ? t('Change emoji') : t('Choose an emoji')} onClick={(e) => setPicker({ rect: e.currentTarget.getBoundingClientRect(), side: 'below' })}>
            {emoji ? (emoji.id ? <CustomEmoji id={emoji.id} name={emoji.name} animated={emoji.animated} /> : <span className="status-emoji">{emoji.name}</span>) : <Icon d={ICONS.smile} size={22} />}
          </button>
          <input id="cs-text" className="input" maxLength={128} value={text} placeholder={t('Support has arrived!')} autoFocus onChange={(e) => setText(e.target.value)} />
          {(text || emoji) && <button type="button" className="icon-btn" aria-label={t('Clear')} onClick={() => (setText(''), setEmoji(null))}><Icon d={ICONS.close} size={16} /></button>}
        </div>
        <div className="field">
          <label htmlFor="cs-clear">{t('Clear after')}</label>
          <select id="cs-clear" className="input" value={clear} onChange={(e) => setClear(+e.target.value)}>
            {CLEAR.map(([label], i) => <option key={label} value={i}>{t(label)}</option>)}
          </select>
        </div>
        <FormError error={error} />
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className="primary">{t('Save')}</button>
        </div>
      </form>
      {picker && <EmojiPicker at={picker} onClose={() => setPicker(null)} guildId={undefined} onPick={(_raw, ref) => (setEmoji(ref), setPicker(null))} />}
    </Modal>
  )
}
