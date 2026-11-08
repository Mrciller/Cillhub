import { useEffect, useState, type DragEvent, type FormEvent, type ReactNode } from 'react'
import { ackBulk, createGuild, joinInvite, patchGuildSettings } from '../actions'
import { FromFileForm, FromTemplateForm, StarterForm } from '../templates/Templates'
import { t } from '../i18n'
import { GuildNotifyItems } from '../notifications/NotificationSettings'
import { Link } from '../router'
import { guildBadge, mentionCount, privateName, unreadChannels } from '../selectors'
import { displayName, getState, setState, useStore } from '../store'
import type { GuildFolder } from '../types'
import { toastError } from './dialogs'
import { MenuItem, MenuSep, Popover, useContextMenu, type Anchor } from './menu'
import { dropBefore, dropIntoFolder, dropOnto, moveBy, moveFolder, newFolder, railLayout, removeFromFolder, saveLayout } from './railOrder'
import { Avatar, channelIconUrl, cls, Field, FormError, GuildIcon, Icon, ICONS, Modal } from './ui'
import { useInstance } from '../admin/instance'
import { AddFromInstance, confirmDisconnect, InstanceList, NodeMarker, STATUS_TEXT, useNode } from '../instances/InstanceUI'

const toNav = () => setState({ showNav: true })
const DRAG = 'application/x-cillcord-guild'
const FOLDER_DRAG = 'application/x-cillcord-folder'
type Drop = { id: string; where: 'before' | 'onto' } | { folder: number } | null
const hex = (n: number | null) => (n === null ? undefined : '#' + n.toString(16).padStart(6, '0'))

function RailItem({ to, label, active, unread, mentions = 0, children, extra }: { to: string; label: string; active: boolean; unread?: boolean; mentions?: number; children: ReactNode; extra?: object }) {
  const full = label + (mentions ? t(mentions === 1 ? ', {n} mention' : ', {n} mentions', { n: mentions }) : unread ? t(', unread') : '')
  return (
    <div className={cls('rail-item', unread && 'unread')}>
      <Link to={to} className="rail-icon" aria-label={full} title={label} aria-current={active ? 'page' : undefined} onClick={toNav} {...extra}>
        {children}
      </Link>
      {mentions > 0 && <span className="badge rail-badge" aria-hidden="true">{mentions > 99 ? '99+' : mentions}</span>}
    </div>
  )
}

const markGuildRead = (guildId: string) => void ackBulk(unreadChannels(getState()).filter((c) => c.guild_id === guildId)).catch(toastError)

function GuildMenu({ guildId, at, onClose }: { guildId: string; at: Anchor; onClose: () => void }) {
  const s = useStore((x) => x)
  const layout = railLayout(s)
  const folder = layout.find((f) => f.guild_ids.includes(guildId))
  const hideMuted = !!s.guildSettings[guildId]?.hide_muted_channels
  const node = useNode(guildId)
  const save = (l: GuildFolder[]) => void saveLayout(l)
  return (
    <Popover at={at} onClose={onClose} role="menu" label={s.guilds[guildId]?.name ?? ''}>
      <MenuItem disabled={!guildBadge(s, guildId).unread && !guildBadge(s, guildId).mentions} onSelect={() => markGuildRead(guildId)}>{t('Mark As Read')}</MenuItem>
      <MenuSep />
      <GuildNotifyItems guildId={guildId} />
      <MenuItem onSelect={() => setState({ modal: { kind: 'notifications', guildId } })}>{t('Notification Settings')}</MenuItem>
      <MenuItem checked={hideMuted} onSelect={() => void patchGuildSettings(guildId, { hide_muted_channels: !hideMuted }).catch(toastError)}>{t('Hide Muted Channels')}</MenuItem>
      <MenuSep />
      <MenuItem onSelect={() => save(moveBy(layout, guildId, -1))}>{t('Move Up')}</MenuItem>
      <MenuItem onSelect={() => save(moveBy(layout, guildId, 1))}>{t('Move Down')}</MenuItem>
      {folder?.id !== null ? <MenuItem onSelect={() => save(removeFromFolder(layout, guildId))}>{t('Remove from Folder')}</MenuItem>
        : <MenuItem onSelect={() => { const l = newFolder(layout, guildId); save(l); setState({ modal: { kind: 'folder', folderId: l.find((f) => f.guild_ids.includes(guildId))!.id! } }) }}>{t('Create Folder')}</MenuItem>}
      {layout.filter((f) => f.id !== null && f !== folder).map((f) => (
        <MenuItem key={f.id} onSelect={() => save(dropIntoFolder(layout, guildId, f.id!))}>{t('Move to {name}', { name: folderName(s, f) })}</MenuItem>
      ))}
      {node && <><MenuSep /><MenuItem danger onSelect={() => confirmDisconnect(node)}>{t('Disconnect from {name}', { name: node.name })}</MenuItem></>}
      {s.settings.developer_mode && <><MenuSep /><MenuItem onSelect={() => void navigator.clipboard.writeText(guildId)}>{t('Copy Server ID')}</MenuItem></>}
    </Popover>
  )
}

const folderName = (s: ReturnType<typeof getState>, f: GuildFolder) => f.name || f.guild_ids.map((id) => s.guilds[id]?.name).filter(Boolean).join(', ')

function GuildEntry({ id, active, drop, setDrop, inside }: { id: string; active: boolean; drop: Drop; setDrop: (d: Drop) => void; inside?: boolean }) {
  const s = useStore((x) => x)
  const g = s.guilds[id]
  const menu = useContextMenu()
  const b = guildBadge(s, id)
  const node = useNode(id)
  const dnd = {
    draggable: true,
    onDragStart: (e: DragEvent) => (e.dataTransfer.setData(DRAG, id), (e.dataTransfer.effectAllowed = 'move')),
    onDragEnd: () => setDrop(null),
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG) && !e.dataTransfer.types.includes(FOLDER_DRAG)) return
      e.preventDefault()
      const r = e.currentTarget.getBoundingClientRect()
      // Upper quarter: insert above; the icon itself: combine into a folder (servers only).
      const where = e.clientY - r.top < r.height / 4 || e.dataTransfer.types.includes(FOLDER_DRAG) ? 'before' : 'onto'
      if (drop && 'id' in drop && drop.id === id && drop.where === where) return
      setDrop({ id, where })
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault()
      setDrop(null)
      const l = railLayout(getState())
      const folder = e.dataTransfer.getData(FOLDER_DRAG)
      if (folder) return void saveLayout(moveFolder(l, +folder, inside ? l.find((f) => f.guild_ids.includes(id))!.guild_ids[0] : id))
      const drag = e.dataTransfer.getData(DRAG)
      if (!drag || drag === id) return
      const where = e.clientY - e.currentTarget.getBoundingClientRect().top < e.currentTarget.getBoundingClientRect().height / 4 ? 'before' : 'onto'
      void saveLayout(where === 'onto' ? dropOnto(l, drag, id) : dropBefore(l, drag, id, inside))
    },
  }
  if (!g) return null
  return (
    <li className={cls('rail-entry', drop && 'id' in drop && drop.id === id && `drop-${drop.where}`, node && node.status !== 'ready' && 'node-down')} {...dnd} {...menu.props}>
      <RailItem to={`/channels/${g.id}`} label={node ? t('{server} on {instance} ({status})', { server: g.name, instance: node.name, status: t(STATUS_TEXT[node.status]) }) : g.name}
        active={active} unread={b.unread} mentions={b.mentions}>
        <GuildIcon guild={g} />
      </RailItem>
      {node && <NodeMarker node={node} />}
      {menu.at && <GuildMenu guildId={id} at={menu.at} onClose={menu.close} />}
    </li>
  )
}

const OPEN_KEY = 'expanded-folders'
function FolderEntry({ f, guildId, drop, setDrop }: { f: GuildFolder; guildId: string; drop: Drop; setDrop: (d: Drop) => void }) {
  const s = useStore((x) => x)
  const menu = useContextMenu()
  const [open, setOpen] = useState(() => (JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]') as number[]).includes(f.id!))
  const toggle = () => {
    const list = (JSON.parse(localStorage.getItem(OPEN_KEY) ?? '[]') as number[]).filter((x) => x !== f.id)
    localStorage.setItem(OPEN_KEY, JSON.stringify(open ? list : [...list, f.id]))
    setOpen(!open)
  }
  const badges = f.guild_ids.map((id) => guildBadge(s, id))
  const mentions = badges.reduce((n, b) => n + b.mentions, 0)
  const unread = badges.some((b) => b.unread)
  const name = folderName(s, f)
  const color = hex(f.color)
  const target = !!drop && 'folder' in drop && drop.folder === f.id
  return (
    <li className={cls('rail-folder', open && 'open')} style={color ? ({ '--folder': color } as React.CSSProperties) : undefined}>
      <div className={cls('rail-item', unread && !open && 'unread', target && 'drop-onto')} {...menu.props}
        draggable onDragStart={(e) => e.dataTransfer.setData(FOLDER_DRAG, String(f.id))}
        onDragOver={(e) => e.dataTransfer.types.includes(DRAG) && (e.preventDefault(), !target && setDrop({ folder: f.id! }))}
        onDragLeave={() => target && setDrop(null)}
        onDrop={(e) => {
          e.preventDefault()
          setDrop(null)
          const drag = e.dataTransfer.getData(DRAG)
          if (drag) void saveLayout(dropIntoFolder(railLayout(getState()), drag, f.id!))
        }}>
        <button className="rail-icon folder-icon" aria-expanded={open} aria-label={t('Folder {name}', { name }) + (mentions ? t(mentions === 1 ? ', {n} mention' : ', {n} mentions', { n: mentions }) : unread && !open ? t(', unread') : '')} title={name} onClick={toggle}>
          {open ? <Icon d={ICONS.folder} size={24} /> : (
            <span className="folder-minis" aria-hidden="true">{f.guild_ids.slice(0, 4).map((id) => <span key={id} className="folder-mini">{s.guilds[id] && <GuildIcon guild={s.guilds[id]} />}</span>)}</span>
          )}
        </button>
        {mentions > 0 && !open && <span className="badge rail-badge" aria-hidden="true">{mentions > 99 ? '99+' : mentions}</span>}
      </div>
      {open && (
        <ul className="folder-guilds" aria-label={name}>
          {f.guild_ids.map((id) => <GuildEntry key={id} id={id} active={id === guildId} drop={drop} setDrop={setDrop} inside />)}
        </ul>
      )}
      {menu.at && (
        <Popover at={menu.at} onClose={menu.close} role="menu" label={name}>
          <MenuItem onSelect={() => f.guild_ids.forEach(markGuildRead)}>{t('Mark Folder As Read')}</MenuItem>
          <MenuItem onSelect={() => setState({ modal: { kind: 'folder', folderId: f.id! } })}>{t('Folder Settings')}</MenuItem>
        </Popover>
      )}
    </li>
  )
}

export function GuildRail({ guildId }: { guildId: string }) {
  const state = useStore((s) => s) // badges derive from channels, read states and permissions
  // A template link (/template/<code>, App.tsx) opens "Add a server" with the code filled in.
  const [templateCode] = useState(() => sessionStorage.getItem('template-code') ?? '')
  useEffect(() => sessionStorage.removeItem('template-code'), [])
  const [adding, setAdding] = useState(!!templateCode)
  const [drop, setDrop] = useState<Drop>(null)
  const hub = useInstance()?.federation?.role === 'hub'
  // DMs with unread mentions sit above the separator.
  const dms = Object.values(state.channels).filter((c) => (c.type === 1 || c.type === 3) && mentionCount(state, c.id) > 0)
  const layout = railLayout(state)
  return (
    <nav className="rail" aria-label={t('Servers')}>
      <RailItem to="/channels/@me" label={t('Direct Messages')} active={guildId === '@me'}>
        <Icon d={ICONS.home} size={26} />
      </RailItem>
      {dms.map((c) => (
        <RailItem key={c.id} to={`/channels/@me/${c.id}`} label={privateName(state, c)} active={false} mentions={mentionCount(state, c.id)}>
          <Avatar user={c.recipients?.[0]} src={c.type === 3 ? channelIconUrl(c) : undefined} size={48} />
        </RailItem>
      ))}
      <hr className="rail-sep" />
      <ul onDragLeave={(e) => e.currentTarget === e.target && setDrop(null)}>
        {layout.map((f) => f.id === null
          ? <GuildEntry key={f.guild_ids[0]} id={f.guild_ids[0]} active={f.guild_ids[0] === guildId} drop={drop} setDrop={setDrop} />
          : <FolderEntry key={f.id} f={f} guildId={guildId} drop={drop} setDrop={setDrop} />)}
      </ul>
      <div className="rail-item">
        <button className="rail-icon rail-add" aria-label={t('Add a server')} title={t('Add a server')} onClick={() => setAdding(true)}>
          <Icon d={ICONS.plus} size={24} />
        </button>
      </div>
      {hub && (
        <div className="rail-item">
          <Link to="/directory" className="rail-icon rail-add" aria-label={t('Explore servers')} title={t('Explore servers')}><Icon d={ICONS.compass} size={24} /></Link>
        </div>
      )}
      {!('cillcordDesktop' in window) && !('CillcordAndroid' in window) && (
        <div className="rail-item">
          <Link to="/download" className="rail-icon download-apps" aria-label={t('Download Apps')} title={t('Download Apps')}>
            <Icon d={ICONS.download} size={24} />
          </Link>
        </div>
      )}
      {adding && <AddServerModal templateCode={templateCode} hub={hub} onClose={() => setAdding(false)} />}
    </nav>
  )
}

const COLORS = [0x22e1ff, 0xff3d85, 0xffb547, 0x2fd37f, 0x7b3bff, 0xff5c63, 0x0b7f9e, 0x97a3c4, 0x3d4a6b]
/** Folder name and colour (folder settings). */
export function FolderModal({ folderId, onClose }: { folderId: number; onClose: () => void }) {
  const s = useStore((x) => x)
  const layout = railLayout(s)
  const f = layout.find((x) => x.id === folderId)
  const [name, setName] = useState(f?.name ?? '')
  const [color, setColor] = useState<number | null>(f?.color ?? null)
  if (!f) return null
  const save = (e: FormEvent) => {
    e.preventDefault()
    void saveLayout(layout.map((x) => (x.id === folderId ? { ...x, name: name.trim() || null, color } : x)))
    onClose()
  }
  return (
    <Modal title={t('Folder Settings')} onClose={onClose}>
      <form onSubmit={save}>
        <Field label={t('Folder Name')} value={name} maxLength={100} placeholder={folderName(s, f)} onChange={(e) => setName(e.target.value)} autoFocus />
        <fieldset className="choice">
          <legend>{t('Folder Color')}</legend>
          <div className="swatches">
            {COLORS.map((c) => <button key={c} type="button" className={cls('swatch', color === c && 'on')} style={{ background: hex(c) }} aria-label={hex(c)} aria-pressed={color === c} onClick={() => setColor(c)} />)}
            <input type="color" aria-label={t('Custom color')} value={hex(color) ?? '#22e1ff'} onChange={(e) => setColor(parseInt(e.target.value.slice(1), 16))} />
          </div>
        </fieldset>
        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>{t('Cancel')}</button>
          <button className="primary">{t('Done')}</button>
        </div>
      </form>
    </Modal>
  )
}

function AddServerModal({ templateCode, hub, onClose }: { templateCode?: string; hub: boolean; onClose: () => void }) {
  const me = useStore((s) => s.me)
  const [error, setError] = useState('')
  const value = (e: FormEvent<HTMLFormElement>, name: string) => (e.preventDefault(), String(new FormData(e.currentTarget).get(name)).trim())
  const run = (p: Promise<unknown>) => p.then(onClose, (err: Error) => setError(err.message))

  return (
    <Modal title={t('Add a server')} onClose={onClose}>
      <form onSubmit={(e) => { const name = value(e, 'name'); if (name) run(createGuild(name)) }}>
        <h3>{t('Create a server')}</h3>
        <Field label={t('Server name')} name="name" required maxLength={100} defaultValue={me ? t("{name}'s server", { name: displayName(me) }) : ''} />
        <button className="primary">{t('Create')}</button>
      </form>
      <StarterForm defaultName={me ? t("{name}'s server", { name: displayName(me) }) : ''} onDone={onClose} />
      <form onSubmit={(e) => {
        // Accept a bare code or a full invite link.
        const code = value(e, 'code').split('/').filter(Boolean).pop()
        if (code) run(joinInvite(code))
      }}>
        <h3>{t('Join a server')}</h3>
        <Field label={t('Invite link or code')} name="code" required placeholder="https://…/invite/hTKzmak" />
        <button className="secondary">{t('Join server')}</button>
      </form>
      {hub && <AddFromInstance onDone={onClose} />}
      <InstanceList />
      {hub && <p className="hint small"><Link to="/directory" onClick={onClose}>{t('Or explore public servers in the server directory.')}</Link></p>}
      <FromTemplateForm initialCode={templateCode} onDone={onClose} />
      <FromFileForm onDone={onClose} />
      <FormError error={error} />
    </Modal>
  )
}

