// Module UI panels (CONTRACT-v8 §6): one sandboxed iframe component (ModuleFrame) used by the three slots: channel_panel
// (header buttons + right side panel, a sheet below 900 px), guild_sidebar (entries above the channel list, shown in the main
// area) and message_accessory (under a module's message). The iframe never gets allow-same-origin, top navigation, popups,
// forms or modals: its only way out is the bridge (bridge.tsx).
import { useEffect, useMemo, useRef, useState } from 'react'
import { cdn } from '../api'
import { cls, Icon, ICONS } from '../components/ui'
import { ResizeHandle } from '../components/ResizeHandle'
import { t, useLocale } from '../i18n'
import { setState, useStore } from '../store'
import type { Message, ModulePanel } from '../types'
import { connectBridge, postContext, type PanelContext } from './bridge'
import './modules.css'

const NONE: ModulePanel[] = []
export const usePanels = (guildId: string | undefined, slot: ModulePanel['slot']) => {
  const all = useStore((s) => (guildId ? s.guilds[guildId]?.module_panels : undefined) ?? NONE)
  return useMemo(() => all.filter((p) => p.slot === slot), [all, slot])
}
const findPanel = (list: ModulePanel[] | undefined, moduleId: string, panelId: string, slot: ModulePanel['slot']) =>
  list?.find((p) => p.module_id === moduleId && p.panel_id === panelId && p.slot === slot)

const PanelIcon = ({ p }: { p: ModulePanel }) => (p.icon ? <span className="module-icon" aria-hidden="true">{p.icon}</span> : <Icon d={ICONS.grid} size={20} />)

/** The sandboxed iframe of one panel plus its bridge. Side and main panels fill their box; accessories use the panel height or resize. */
export function ModuleFrame({ panel, guildId, channelId = null, messageId = null, onClose }: { panel: ModulePanel; guildId: string; channelId?: string | null; messageId?: string | null; onClose?: () => void }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [height, setHeight] = useState(panel.height)
  const me = useStore((s) => s.me)
  const locale = useLocale()
  const theme = useStore((s) => (s.settings.theme === 'light' ? 'light' : 'dark'))
  const context: PanelContext = useMemo(() => ({
    module_id: panel.module_id, panel_id: panel.panel_id, slot: panel.slot, guild_id: guildId, channel_id: channelId, message_id: messageId,
    user: { id: me?.id ?? '', username: me?.username ?? '', global_name: me?.global_name ?? null, avatar: me?.avatar ?? null }, locale, theme,
  }), [panel.module_id, panel.panel_id, panel.slot, guildId, channelId, messageId, me?.id, me?.username, me?.global_name, me?.avatar, locale, theme])
  const latest = useRef({ context, onClose })
  latest.current = { context, onClose }
  useEffect(() => connectBridge(frame.current!, () => latest.current.context, {
    resize: setHeight, close: onClose && (() => latest.current.onClose?.()),
  }), [!!onClose]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => void postContext(frame.current, context), [context])
  return (
    <iframe ref={frame} className="module-frame" sandbox="allow-scripts" src={cdn(panel.url)} referrerPolicy="no-referrer" title={panel.title}
      style={panel.slot === 'message_accessory' ? { height } : undefined} onLoad={() => postContext(frame.current, latest.current.context)} />
  )
}

/** Header buttons of the channel_panel panels (text, announcement and voice channels of servers with modules). */
export function ChannelPanelButtons({ guildId }: { guildId?: string }) {
  const panels = usePanels(guildId, 'channel_panel')
  const open = useStore((s) => (s.panel?.kind === 'module' ? s.panel : null))
  if (!guildId) return null
  return panels.map((p) => {
    const on = open?.guildId === guildId && open.moduleId === p.module_id && open.panelId === p.panel_id
    return (
      <button key={`${p.module_id}/${p.panel_id}`} className={cls('icon-btn', on && 'active')} aria-pressed={on} aria-label={p.title} title={p.title}
        onClick={() => setState({ panel: on ? null : { kind: 'module', guildId, moduleId: p.module_id, panelId: p.panel_id }, showNav: false })}>
        <PanelIcon p={p} />
      </button>
    )
  })
}

/** Moves focus to the heading when a panel opens and back to the opener when it closes. */
function useFocusIn() {
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null
    heading.current?.focus()
    return () => void (opener?.isConnected && opener.focus())
  }, [])
  return heading
}

/** The right-hand side panel of a channel_panel (store `panel.kind === 'module'`); `channelId` is the channel on screen. */
export function ModuleSidePanel({ guildId, moduleId, panelId, channelId }: { guildId: string; moduleId: string; panelId: string; channelId: string | null }) {
  const panel = useStore((s) => findPanel(s.guilds[guildId]?.module_panels, moduleId, panelId, 'channel_panel'))
  const heading = useFocusIn()
  const close = () => setState({ panel: null })
  useEffect(() => void (!panel && setState({ panel: null })), [panel]) // disabled, removed or crashed meanwhile
  if (!panel) return null
  return (
    <aside className="side-panel module-panel" aria-label={panel.title} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <ResizeHandle
        id="module-panel-resizer"
        side="left"
        defaultValue={360}
        min={280}
        max={760}
        storageKey="cillhub:side-panel-width"
        cssVar="--side-panel-width"
        ariaLabel={t('Resize module panel')}
      />
      <header className="panel-header">
        <PanelIcon p={panel} />
        <h2 ref={heading} tabIndex={-1} className="ellipsis">{panel.title}</h2>
        <span className="spacer" />
        <button className="icon-btn" aria-label={t('Close {name}', { name: panel.title })} title={t('Close')} onClick={close}><Icon d={ICONS.close} /></button>
      </header>
      <ModuleFrame panel={panel} guildId={guildId} channelId={channelId} onClose={close} />
    </aside>
  )
}

/** Entries of the guild_sidebar panels at the top of the channel list. */
export function ModuleSidebarEntries({ guildId }: { guildId: string }) {
  const panels = usePanels(guildId, 'guild_sidebar')
  const page = useStore((s) => s.modulePage)
  if (!panels.length) return null
  return (
    <ul className="module-entries" aria-label={t('Modules')}>
      {panels.map((p) => {
        const on = page?.guildId === guildId && page.moduleId === p.module_id && page.panelId === p.panel_id
        return (
          <li key={`${p.module_id}/${p.panel_id}`}>
            <button className="row" aria-current={on ? 'page' : undefined}
              onClick={() => setState({ modulePage: { guildId, moduleId: p.module_id, panelId: p.panel_id }, showNav: false })}>
              <PanelIcon p={p} /><span className="ellipsis">{p.title}</span>
            </button>
          </li>
        )
      })}
    </ul>
  )
}

/** A guild_sidebar panel in the main area, in place of the chat (store `modulePage`). */
export function ModuleMainPage({ guildId, moduleId, panelId, channelId }: { guildId: string; moduleId: string; panelId: string; channelId: string | null }) {
  const panel = useStore((s) => findPanel(s.guilds[guildId]?.module_panels, moduleId, panelId, 'guild_sidebar'))
  const heading = useFocusIn()
  const close = () => setState({ modulePage: null })
  useEffect(() => void (!panel && setState({ modulePage: null })), [panel])
  if (!panel) return null
  return (
    <main className="chat module-page" aria-label={panel.title} onKeyDown={(e) => e.key === 'Escape' && close()}>
      <header className="chat-header">
        <button className="icon-btn back" aria-label={t('Back to channels')} onClick={() => setState({ showNav: true })}><Icon d={ICONS.back} /></button>
        <PanelIcon p={panel} />
        <h1 ref={heading} tabIndex={-1} className="ellipsis">{panel.title}</h1>
        <span className="spacer" />
        <button className="icon-btn" aria-label={t('Close {name}', { name: panel.title })} title={t('Close')} onClick={close}><Icon d={ICONS.close} /></button>
      </header>
      <ModuleFrame panel={panel} guildId={guildId} channelId={channelId} onClose={close} />
    </main>
  )
}

/** A message_accessory panel under a module's message (`module_accessory`). */
export function MessageAccessory({ m }: { m: Message }) {
  const a = m.module_accessory
  const guildId = useStore((s) => m.guild_id ?? s.channels[m.channel_id]?.guild_id)
  const panel = useStore((s) => (a && guildId ? findPanel(s.guilds[guildId]?.module_panels, a.module_id, a.panel_id, 'message_accessory') : undefined))
  if (!panel || !guildId) return null
  return <div className="module-accessory"><ModuleFrame panel={panel} guildId={guildId} channelId={m.channel_id} messageId={m.id} /></div>
}
