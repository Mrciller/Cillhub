// Role Hierarchy Simulator ("View Server as Role")
// Allows guild administrators to preview their server as any role or combination of roles.
import { useState, useRef } from 'react'
import { t } from '../i18n'
import { getState, setState, useStore, type State } from '../store'
import type { Guild } from '../types'
import { sortedRoles, basePerms, has, P } from '../permissions'
import { colorOf } from '../selectors'
import { Icon, ICONS, cls } from '../components/ui'
import { Popover } from '../components/menu'
import './role-simulator.css'

/** Checks whether the user can start role simulation in the guild */
export function canSimulateRoles(s: State, guildId: string): boolean {
  const g = s.guilds[guildId]
  if (!g || !s.me) return false
  if (g.owner_id === s.me.id) return true
  // If simulation is active, user can always continue/stop it
  if (s.simulatedRoles?.[guildId] !== undefined) return true
  const realMember = s.members[guildId]?.[s.me.id]
  const realPerms = basePerms(g, s.me.id, realMember)
  return has(realPerms, P.ADMINISTRATOR) || has(realPerms, P.MANAGE_ROLES) || has(realPerms, P.MANAGE_GUILD)
}

/** Check if simulation is currently active for this guild */
export function isSimulatingRoles(s: State, guildId: string): boolean {
  return s.simulatedRoles?.[guildId] !== undefined
}

/** Starts role simulation with the specified role(s) or defaults to @everyone ([]) */
export function startRoleSimulation(guildId: string, initialRoleIds?: string[]) {
  const current = getState().simulatedRoles?.[guildId]
  const roles = initialRoleIds ?? (current ?? [])
  setState({
    simulatedRoles: {
      ...getState().simulatedRoles,
      [guildId]: roles,
    },
    modal: null, // close server settings if open so user sees simulated server immediately
  })
}

/** Stops role simulation and restores the member's natural roles and permissions */
export function stopRoleSimulation(guildId: string) {
  const copy = { ...getState().simulatedRoles }
  delete copy[guildId]
  setState({ simulatedRoles: copy })
}

/** Sets the exact list of role IDs being simulated */
export function setSimulatedRoles(guildId: string, roleIds: string[]) {
  setState({
    simulatedRoles: {
      ...getState().simulatedRoles,
      [guildId]: roleIds,
    },
  })
}

/** Toggles a role on or off in the simulated roles list */
export function toggleSimulatedRole(guildId: string, roleId: string) {
  const current = getState().simulatedRoles?.[guildId] ?? []
  const next = current.includes(roleId) ? current.filter((id) => id !== roleId) : [...current, roleId]
  setSimulatedRoles(guildId, next)
}

/**
 * Top banner displayed when role simulation is active for a server.
 * Features amber warning bar, multi-role pill selector, dropdown role picker, and stop viewing action.
 */
export function RoleSimulatorBanner({ guild }: { guild: Guild }) {
  const activeRoleIds = useStore((s) => s.simulatedRoles?.[guild.id])
  const [pickerOpen, setPickerOpen] = useState(false)
  const addBtnRef = useRef<HTMLButtonElement>(null)

  if (activeRoleIds === undefined) return null

  const allRoles = sortedRoles(guild)
  const nonEveryoneRoles = allRoles.filter((r) => r.id !== guild.id)
  const isEveryoneOnly = activeRoleIds.length === 0

  // Title formatting
  let bannerLabel = t('Viewing Server as: @everyone')
  if (activeRoleIds.length === 1) {
    const single = allRoles.find((r) => r.id === activeRoleIds[0])
    bannerLabel = t('Viewing Server as: @{name}', { name: single?.name || 'Role' })
  } else if (activeRoleIds.length > 1) {
    bannerLabel = t('Viewing Server as: {n} roles', { n: activeRoleIds.length })
  }

  return (
    <div className="role-simulator-banner" role="status" aria-label={bannerLabel}>
      <div className="role-sim-left">
        <div className="role-sim-badge">
          <Icon d={ICONS.eye} size={18} />
          <span>{bannerLabel}</span>
        </div>

        <div className="role-sim-pills" role="toolbar" aria-label={t('Simulated roles')}>
          {/* @everyone pill */}
          <button
            type="button"
            className={cls('role-sim-pill', isEveryoneOnly && 'active')}
            onClick={() => setSimulatedRoles(guild.id, [])}
            title={t('View server with only @everyone permissions')}
          >
            <span className="role-sim-color-dot" style={{ background: '#99aab5' }} />
            <span>@everyone</span>
          </button>

          {/* Active simulated role pills */}
          {activeRoleIds.map((roleId) => {
            const r = allRoles.find((x) => x.id === roleId)
            if (!r) return null
            const dotColor = colorOf(r.color) || '#b9bbbe'
            return (
              <span key={r.id} className="role-sim-pill active">
                <span className="role-sim-color-dot" style={{ background: dotColor }} />
                <span>@{r.name}</span>
                <button
                  type="button"
                  className="role-sim-pill-remove"
                  onClick={() => toggleSimulatedRole(guild.id, r.id)}
                  aria-label={t('Remove @{name} from simulated roles', { name: r.name })}
                  title={t('Remove role')}
                >
                  ×
                </button>
              </span>
            )
          })}

          {/* Add / Toggle more roles button */}
          {nonEveryoneRoles.length > 0 && (
            <button
              ref={addBtnRef}
              type="button"
              className="role-sim-add-btn"
              onClick={() => setPickerOpen(!pickerOpen)}
              aria-label={t('Select roles to simulate')}
              title={t('Add or remove roles to view as')}
            >
              <span>+</span>
              <span>{t('Select Roles')}</span>
            </button>
          )}
        </div>
      </div>

      <div className="role-sim-actions">
        <button
          type="button"
          className="role-sim-stop-btn"
          onClick={() => stopRoleSimulation(guild.id)}
          title={t('Exit role simulation and restore normal permissions')}
        >
          {t('Stop Viewing')}
        </button>
      </div>

      {pickerOpen && addBtnRef.current && (
        <Popover
          at={{ rect: addBtnRef.current.getBoundingClientRect(), side: 'below' }}
          onClose={() => setPickerOpen(false)}
          label={t('Toggle simulated roles')}
        >
          <div className="role-sim-popover" role="menu" aria-label={t('Toggle simulated roles')}>
            <div style={{ padding: '4px 8px 8px', fontSize: '11px', fontWeight: 700, color: 'var(--muted)', textTransform: 'uppercase' }}>
              {t('Toggle Roles')}
            </div>
            {nonEveryoneRoles.map((r) => {
              const isSelected = activeRoleIds.includes(r.id)
              const dotColor = colorOf(r.color) || '#b9bbbe'
              return (
                <button
                  key={r.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={isSelected}
                  className={cls('role-sim-popover-item', isSelected && 'checked')}
                  onClick={() => toggleSimulatedRole(guild.id, r.id)}
                >
                  <span className="role-sim-item-left">
                    <span className="role-sim-color-dot" style={{ background: dotColor }} />
                    <span className="ellipsis">{r.name}</span>
                  </span>
                  <span>{isSelected ? '✓' : ''}</span>
                </button>
              )
            })}
          </div>
        </Popover>
      )}
    </div>
  )
}
