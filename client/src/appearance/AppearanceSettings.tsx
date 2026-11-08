// User Settings → Appearance, Accessibility, Language, Advanced. Every change is synced through PATCH /users/@me/settings.
import { useEffect, useState } from 'react'
import { deviceZoom, onZoomChange, setDeviceZoom } from './apply'
import { patchSettings } from '../actions'
import { clock } from '../appearance/format'
import { cls } from '../components/ui'
import { t } from '../i18n'
import { navigate } from '../router'
import { Switch } from '../settings/Layout'
import { setState, useStore } from '../store'
import type { UserSettings } from '../types'
import { emojiMotion, stickerMotion } from './MotionImg'
import { ChatSection, CustomCssSection, ThemeSection } from '../custom/AppearanceV6'

const set = (p: UserSettings) => void patchSettings(p)
const THEMES: [NonNullable<UserSettings['theme']>, string, string][] = [['light', 'Light', '#ffffff'], ['ash', 'Ash', '#38393f'], ['dark', 'Dark', '#313338'], ['onyx', 'Onyx', '#121214']]

function Range({ id, label, value, min, max, step, unit, ticks, onChange, onDoubleClick, title }: { id: string; label: string; value: number; min: number; max: number; step: number; unit: string; ticks: number[]; onChange: (v: number) => void; onDoubleClick?: () => void; title?: string }) {
  return (
    <div className="field range-field">
      <label htmlFor={id}>{label} <span className="hint">{value}{unit}</span></label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} aria-valuetext={`${value}${unit}`} onChange={(e) => onChange(+e.target.value)} onDoubleClick={onDoubleClick} title={title} />
      <div className="range-ticks" aria-hidden="true">{ticks.map((x) => <span key={x}>{x}{unit}</span>)}</div>
    </div>
  )
}

export function Appearance() {
  const s = useStore((x) => x.settings)
  const [zoom, setZoom] = useState(deviceZoom)
  const theme = s.theme ?? 'dark'

  useEffect(() => {
    return onZoomChange((z) => setZoom(z))
  }, [])

  const density: 'cozy' | 'compact' | 'ultra' =
    !s.message_display_compact ? 'cozy' : (zoom === 90 ? 'ultra' : 'compact')

  return (
    <>
      <h1>{t('Appearance')}</h1>
      <div className="theme-preview">
        <div className="msg head" aria-hidden="true"><strong>{t('Cillhub')}</strong> <span className="hint small">{clock(Date.now())}</span><div>{t('Waiting for the patch to drop? Pick a look you like.')}</div></div>
      </div>
      <fieldset className="choice block settings-section">
        <legend>{t('Theme')}</legend>
        <div className="theme-swatches">
          {THEMES.map(([id, label, color]) => (
            <label key={id} className="theme-swatch">
              <input type="radio" name="theme" checked={theme === id && !s.active_theme} onChange={() => set({ theme: id, active_theme: null })} />
              <span className="chip" style={{ background: color }} />
              {t(label)}
            </label>
          ))}
        </div>
      </fieldset>
      <ThemeSection />
      <fieldset className="choice block settings-section">
        <legend>{t('Display Density')}</legend>
        <label className={cls('radio-card', density === 'cozy' && 'on')}>
          <input
            type="radio"
            name="density"
            checked={density === 'cozy'}
            onChange={() => {
              set({ message_display_compact: false })
              if (deviceZoom() === 90) setDeviceZoom(100)
            }}
          />
          <div>
            <div><strong>{t('Cozy')}</strong></div>
            <div className="hint small">{t('Standard, comfortable spacing')}</div>
          </div>
        </label>
        <label className={cls('radio-card', density === 'compact' && 'on')}>
          <input
            type="radio"
            name="density"
            checked={density === 'compact'}
            onChange={() => {
              set({ message_display_compact: true })
              if (deviceZoom() === 90) setDeviceZoom(100)
            }}
          />
          <div>
            <div><strong>{t('Compact')}</strong></div>
            <div className="hint small">{t('Fits more messages, channels, and members on screen; activates data-compact')}</div>
          </div>
        </label>
        <label className={cls('radio-card', density === 'ultra' && 'on')}>
          <input
            type="radio"
            name="density"
            checked={density === 'ultra'}
            onChange={() => {
              set({ message_display_compact: true })
              setDeviceZoom(90)
            }}
          />
          <div>
            <div><strong>{t('Ultra-Compact')}</strong></div>
            <div className="hint small">{t('Space-saving mode for laptops/smaller screens (sets compact display and 90% zoom)')}</div>
          </div>
        </label>
      </fieldset>
      <Range id="font-scale" label={t('Chat Font Scaling')} value={s.font_size ?? 16} min={12} max={24} step={1} unit="px" ticks={[12, 14, 15, 16, 18, 20, 24]} onChange={(v) => set({ font_size: v })} />
      <Range
        id="zoom"
        label={t('Zoom Level')}
        value={zoom}
        min={50}
        max={200}
        step={10}
        unit="%"
        ticks={[50, 100, 150, 200]}
        onChange={(v) => {
          setDeviceZoom(v)
          setZoom(v)
        }}
        onDoubleClick={() => {
          setDeviceZoom(100)
          setZoom(100)
        }}
        title={t('Double-click to reset to 100%')}
      />
      <p className="hint small">{t('Zoom is saved on this device only. Use Ctrl+- / Ctrl++ / Ctrl+0 to adjust.')}</p>
      <div className="field">
        <label htmlFor="hour-cycle">{t('Timestamps')}</label>
        <select id="hour-cycle" className="input" value={s.timestamp_hour_cycle ?? 'auto'} onChange={(e) => set({ timestamp_hour_cycle: e.target.value as UserSettings['timestamp_hour_cycle'] })}>
          <option value="auto">{t('Follow the language')}</option>
          <option value="h12">{t('12-hour (3:45 PM)')}</option>
          <option value="h23">{t('24-hour (15:45)')}</option>
        </select>
      </div>
      <ChatSection />
      <CustomCssSection />
    </>
  )
}

export function Accessibility() {
  const s = useStore((x) => x.settings)
  return (
    <>
      <h1>{t('Accessibility')}</h1>
      <Range id="saturation" label={t('Saturation')} value={s.saturation ?? 100} min={0} max={100} step={5} unit="%" ticks={[0, 25, 50, 75, 100]} onChange={(v) => set({ saturation: v })} />
      <fieldset className="choice block settings-section">
        <legend>{t('Reduced Motion')}</legend>
        {([['auto', 'Sync with computer'], ['on', 'Always reduce motion'], ['off', 'Never reduce motion']] as const).map(([v, label]) => (
          <label key={v} className={cls('radio-card', (s.reduced_motion ?? 'auto') === v && 'on')}><input type="radio" name="motion" checked={(s.reduced_motion ?? 'auto') === v} onChange={() => set({ reduced_motion: v })} /> {t(label)}</label>
        ))}
      </fieldset>
      <section className="settings-section">
        <h2>{t('Text & Images')}</h2>
        <Switch label={t('Show embeds')} note={t('Rich embeds from apps and webhooks.')} checked={s.render_embeds !== false} onChange={(v) => set({ render_embeds: v })} />
        <Switch label={t('Show link previews')} note={t('Previews of websites and videos posted in chat.')} checked={s.inline_embed_media !== false} onChange={(v) => set({ inline_embed_media: v })} />
        <Switch label={t('Play animated emoji')} note={t('When off, animated emoji move only while you hover them.')} checked={emojiMotion(s.animate_emoji) === 'always'} onChange={(v) => set({ animate_emoji: v })} />
        <div className="field">
          <label htmlFor="stickers">{t('Sticker Animation')}</label>
          <select id="stickers" className="input" value={{ always: 0, hover: 1, never: 2 }[stickerMotion(s.animate_stickers)]} onChange={(e) => set({ animate_stickers: +e.target.value as 0 | 1 | 2 })}>
            <option value={0}>{t('Always animate')}</option>
            <option value={1}>{t('Animate on interaction')}</option>
            <option value={2}>{t('Never animate')}</option>
          </select>
        </div>
      </section>
    </>
  )
}

export function Language() {
  const locale = useStore((x) => x.settings.locale ?? (document.documentElement.lang === 'de' ? 'de' : 'en-US'))
  return (
    <>
      <h1>{t('Language')}</h1>
      <fieldset className="choice block">
        <legend>{t('Select a language')}</legend>
        {([['en-US', 'English, US'], ['de', 'Deutsch']] as const).map(([id, label]) => (
          <label key={id} className={cls('radio-card', locale === id && 'on')} lang={id === 'de' ? 'de' : 'en'}>
            <input type="radio" name="locale" checked={locale === id} onChange={() => set({ locale: id })} /> {label}
          </label>
        ))}
      </fieldset>
    </>
  )
}

export function Advanced() {
  const dev = useStore((x) => !!x.settings.developer_mode)
  return (
    <>
      <h1>{t('Advanced')}</h1>
      <Switch label={t('Developer Mode')} note={t('Adds "Copy ID" to context menus, for bots and integrations.')} checked={dev} onChange={(v) => set({ developer_mode: v })} />
      <section className="settings-section">
        <h2>{t('Applications')}</h2>
        <p className="hint small">{t('Create bots and manage their tokens, intents and invite links.')}</p>
        <button className="secondary" onClick={() => (setState({ modal: null }), navigate('/developers/applications'))}>{t('Developer Portal')}</button>
      </section>
      <section className="settings-section">
        <h2>{t('Keyboard')}</h2>
        <button className="secondary" onClick={() => setState({ modal: { kind: 'shortcuts' } })}>{t('Keyboard Shortcuts')}</button>
      </section>
    </>
  )
}
