// Server Settings > Roles: hierarchy list (drag or up/down to reorder), create, edit, delete.
import { t } from '../i18n'
import { useEffect, useState, type DragEvent } from 'react'
import { createRole, deleteRole, reorderRoles, updateRole } from '../actions'
import { ask, toast, toastError } from '../components/dialogs'
import { cls, FormError, Icon, ICONS } from '../components/ui'
import { canManageRole, grantable, has, rank, sortedRoles } from '../permissions'
import { startRoleSimulation } from '../guilds/RoleSimulator'
import { colorOf, myMember } from '../selectors'
import { useStore } from '../store'
import type { Guild, Role } from '../types'
import { Switch } from './Layout'
import { bit, PERM_GROUPS } from './permInfo'
import { dataUri } from '../api'
import { ColorField } from '../custom/AppearanceV6'
import { toHex, toInt } from '../custom/color'
import { nameProps, RoleIcon, roleColors, roleSwatch, textColor } from '../custom/render'

/** Role icon: an image (≤ 256 KB) or a Unicode emoji, per permissions.mdx `icon` / `unicode_emoji`. */
function RoleIconField({ draft, setDraft }: { draft: Role; setDraft: (r: Role) => void }) {
  const [error, setError] = useState('')
  return (
    <div className="field">
      <span className="field-label">{t('Role Icon')}</span>
      <div className="row-buttons">
        <RoleIcon role={draft} size={24} />
        <label className="secondary file-btn">
          {t('Upload Image')}
          <input type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="sr-only" aria-label={t('Role icon image')}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) dataUri(f, 256 * 1024).then((icon) => (setError(''), setDraft({ ...draft, icon, unicode_emoji: null })), (err: Error) => setError(err.message)); e.target.value = '' }} />
        </label>
        <input className="input emoji-input" aria-label={t('Or an emoji')} placeholder={t('or 🎮')} maxLength={8} value={draft.unicode_emoji ?? ''}
          onChange={(e) => setDraft({ ...draft, unicode_emoji: e.target.value.trim() || null, ...(e.target.value.trim() && { icon: null }) })} />
        {(draft.icon || draft.unicode_emoji) && <button type="button" className="link" onClick={() => setDraft({ ...draft, icon: null, unicode_emoji: null })}>{t('Remove')}</button>}
      </div>
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  )
}

const SWATCHES = [0x1abc9c, 0x2ecc71, 0x3498db, 0x9b59b6, 0xe91e63, 0xf1c40f, 0xe67e22, 0xe74c3c, 0x95a5a6, 0x607d8b]
const fail = (e: Error) => toastError(e)

export function Roles({ guild }: { guild: Guild }) {
  const s = useStore((x) => x)
  const me = s.me!
  const mine = myMember(s, guild.id)
  const myRank = rank(guild, me.id, mine)
  const roles = sortedRoles(guild)
  const [selected, setSelected] = useState(roles[0]?.id)
  const [dragging, setDragging] = useState<string | null>(null)
  const role = roles.find((r) => r.id === selected) ?? roles[0]
  const movable = (r: Role) => r.id !== guild.id && canManageRole(guild, me.id, mine, r)
  const ordered = roles.filter((r) => r.id !== guild.id) // highest first

  /** Puts `id` at index `to` (in highest-first order) and sends positions n..1. */
  const move = (id: string, to: number) => {
    const list = ordered.filter((r) => r.id !== id)
    list.splice(to, 0, ordered.find((r) => r.id === id)!)
    const changes = list.map((r, i) => ({ id: r.id, position: list.length - i })).filter((c) => roles.find((r) => r.id === c.id)!.position !== c.position)
    if (changes.some((c) => c.position >= myRank)) return toast(t('You can only move roles below your highest role.'))
    if (changes.length) reorderRoles(guild.id, changes).catch(fail)
  }
  const onDrop = (target: Role) => (e: DragEvent) => {
    e.preventDefault()
    const id = dragging
    setDragging(null)
    if (id && id !== target.id && target.id !== guild.id && movable(target)) move(id, ordered.findIndex((r) => r.id === target.id))
  }

  return (
    <>
      <h1>{t('Roles')}</h1>
      <p className="hint">{t('Use roles to group your server members and assign permissions. Members use the color of their highest role. Drag roles or use the arrows to change the hierarchy.')}</p>
      <div className="roles-layout">
        <div className="roles-list">
          <button className="primary" onClick={() => createRole(guild.id).then((r) => setSelected(r.id), fail)}>{t('Create Role')}</button>
          <ul aria-label={t('Roles, highest first')}>
            {roles.map((r) => {
              const i = ordered.indexOf(r)
              const canMove = movable(r)
              return (
                <li
                  key={r.id}
                  className={cls('role-row', r.id === role?.id && 'active', dragging === r.id && 'dragging')}
                  draggable={canMove}
                  onDragStart={(e) => (e.dataTransfer.setData('text/plain', r.id), setDragging(r.id))}
                  onDragEnd={() => setDragging(null)}
                  onDragOver={(e) => dragging && canMove && e.preventDefault()}
                  onDrop={onDrop(r)}
                >
                  <button className="role-select" aria-current={r.id === role?.id || undefined} onClick={() => setSelected(r.id)}>
                    <span className="role-dot" style={{ background: roleSwatch(r) }} aria-hidden="true" />
                    <RoleIcon role={r} size={16} />
                    <span className="ellipsis">{r.id === guild.id ? '@everyone' : r.name}</span>
                    {!canManageRole(guild, me.id, mine, r) && <Icon d={ICONS.lock} size={14} className="hint" />}
                  </button>
                  {r.id !== guild.id && (
                    <span className="role-move">
                      <button className="icon-btn tiny" aria-label={t('Move {name} up', { name: r.name })} disabled={!canMove || i === 0 || r.position + 1 >= myRank} onClick={() => move(r.id, i - 1)}><Icon d={ICONS.up} size={14} /></button>
                      <button className="icon-btn tiny" aria-label={t('Move {name} down', { name: r.name })} disabled={!canMove || i === ordered.length - 1} onClick={() => move(r.id, i + 1)}><Icon d={ICONS.down} size={14} /></button>
                    </span>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
        {role && <RoleEditor key={role.id} guild={guild} role={role} editable={canManageRole(guild, me.id, mine, role)} allowed={grantable(guild, me.id, mine)} onDeleted={() => setSelected(roles[0]?.id)} />}
      </div>
    </>
  )
}

function RoleEditor({ guild, role, editable, allowed, onDeleted }: { guild: Guild; role: Role; editable: boolean; allowed: bigint; onDeleted: () => void }) {
  const everyone = role.id === guild.id
  const [draft, setDraft] = useState(role)
  const [error, setError] = useState('')
  useEffect(() => setDraft(role), [role])
  const perms = BigInt(draft.permissions)
  const dirty = JSON.stringify(draft) !== JSON.stringify(role)
  const setBit = (b: bigint, on: boolean) => setDraft({ ...draft, permissions: String(on ? perms | b : perms & ~b) })
  const save = () => {
    setError('')
    const { name, color, hoist, mentionable, permissions } = draft
    // v6: gradient (colors per permissions.mdx) and role icon (image or Unicode emoji); unchanged icons are not re-sent
    const colors = { primary_color: color, secondary_color: color ? draft.colors?.secondary_color ?? null : null, tertiary_color: null }
    const icon = draft.icon !== role.icon || draft.unicode_emoji !== role.unicode_emoji ? { icon: draft.icon ?? null, unicode_emoji: draft.unicode_emoji ?? null } : {}
    updateRole(guild.id, role.id, everyone ? { permissions } : { name, color, colors, hoist, mentionable, permissions, ...icon }).catch((e: Error) => setError(e.message))
  }

  return (
    <div className="role-editor">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', marginBottom: '8px' }}>
        <h2 style={{ margin: 0 }}>{t('Edit Role — {name}', { name: everyone ? '@everyone' : role.name })}</h2>
        <button
          type="button"
          className="secondary small-btn"
          onClick={() => startRoleSimulation(guild.id, everyone ? [] : [role.id])}
          title={t('Preview server as this role')}
        >
          <span style={{ display: 'inline-flex', marginRight: 6, verticalAlign: '-2px' }}><Icon d={ICONS.eye} size={14} /></span>
          {t('View Server as Role')}
        </button>
      </div>
      {!editable && <p className="notice">{t('You can only edit roles below your highest role.')}</p>}
      <fieldset disabled={!editable} className="plain">
        {!everyone && (
          <>
            <div className="field">
              <label htmlFor="role-name">{t('Role Name')}</label>
              <input id="role-name" className="input" maxLength={100} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </div>
            <fieldset className="field plain">
              <legend className="field-label">{t('Role Color')}</legend>
              <div className="swatches">
                <button type="button" className={cls('swatch none', !draft.color && 'on')} aria-label={t('Default color')} aria-pressed={!draft.color} onClick={() => setDraft({ ...draft, color: 0 })} />
                {SWATCHES.map((c) => (
                  <button type="button" key={c} className={cls('swatch', draft.color === c && 'on')} style={{ background: colorOf(c) }} aria-label={t('Color {hex}', { hex: colorOf(c) ?? '' })} aria-pressed={draft.color === c} onClick={() => setDraft({ ...draft, color: c })} />
                ))}
                <label className="custom-color">
                  <span className="sr-only">{t('Custom color')}</span>
                  <input type="color" value={colorOf(draft.color) ?? '#99aab5'} onChange={(e) => setDraft({ ...draft, color: parseInt(e.target.value.slice(1), 16) })} />
                </label>
              </div>
            </fieldset>
            <Switch label={t('Gradient')} note={t('Blend the role colour into a second colour on names.')} checked={!!draft.colors?.secondary_color} disabled={!draft.color}
              onChange={(v) => setDraft({ ...draft, colors: { primary_color: draft.color, secondary_color: v ? draft.colors?.secondary_color || 0x00d4ff : null, tertiary_color: null } })} />
            {!!draft.colors?.secondary_color && !!draft.color && (
              <ColorField label={t('Second colour')} value={toHex(draft.colors.secondary_color)} onChange={(h) => setDraft({ ...draft, colors: { primary_color: draft.color, secondary_color: toInt(h), tertiary_color: null } })} />
            )}
            {!!draft.color && <p className="role-name-preview">{t('Preview')}: <span {...nameProps(11, draft.colors?.secondary_color ? 2 : 1, roleColors({ ...draft, colors: draft.colors ? { ...draft.colors, primary_color: draft.color } : undefined }).map(textColor))}>{draft.name || t('new role')}</span> <RoleIcon role={draft} /></p>}
            <RoleIconField draft={draft} setDraft={setDraft} />
            <Switch label={t('Display role members separately from online members')} checked={draft.hoist} onChange={(v) => setDraft({ ...draft, hoist: v })} />
            <Switch label={t('Allow anyone to @mention this role')} checked={draft.mentionable} onChange={(v) => setDraft({ ...draft, mentionable: v })} />
          </>
        )}
        <h3 className="perm-title">{t('Permissions')}</h3>
        {PERM_GROUPS.map((g) => (
          <section key={g.title} className="perm-group">
            <h4 className="list-heading">{t(g.title)}</h4>
            {g.perms.map((p) => (
              <Switch key={p.name} label={t(p.label)} note={t(p.note)} checked={has(perms, bit(p.name))} disabled={!has(allowed, bit(p.name))} onChange={(v) => setBit(bit(p.name), v)} />
            ))}
          </section>
        ))}
      </fieldset>
      <FormError error={error} />
      <div className="save-bar">
        {!everyone && editable && (
          <button className="danger-btn" onClick={() => void ask({ title: t('Delete Role'), body: <p>{t('Are you sure you want to delete the role {name}? This cannot be undone.', { name: role.name })}</p>, confirm: t('Delete'), danger: true }).then((ok) => void (ok && deleteRole(guild.id, role.id).then(onDeleted, fail)))}>{t('Delete Role')}</button>
        )}
        <span className="spacer" />
        <button className="link" disabled={!dirty} onClick={() => setDraft(role)}>{t('Reset')}</button>
        <button className="primary" disabled={!dirty || !editable || (!everyone && !draft.name.trim())} onClick={save}>{t('Save Changes')}</button>
      </div>
    </div>
  )
}
