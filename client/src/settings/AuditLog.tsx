import { snowflakeTime } from '../threads/util'
// Server Settings > Audit Log (audit-log.mdx): filters, readable entries, change lists, paging with `before`.
import { useEffect, useState } from 'react'
import { auditLog } from '../actions'
import { Avatar, cls, FormError, Icon, ICONS } from '../components/ui'
import { stamp } from '../chat/MessageItem'
import { t } from '../i18n'
import { memberName } from '../selectors'
import { displayName, useStore } from '../store'
import type { AuditLog, AuditLogEntry, Guild, User } from '../types'

type Kind = 'guild' | 'channel' | 'user' | 'role' | 'invite' | 'webhook' | 'emoji' | 'message' | 'stage' | 'sticker' | 'event' | 'thread' | 'sound' | 'rule'
/** action_type -> [verb, kind of target] (the API reference audit log event list). */
export const ACTIONS: Record<number, [string, Kind]> = {
  1: ['updated the server', 'guild'],
  10: ['created channel', 'channel'], 11: ['updated channel', 'channel'], 12: ['deleted channel', 'channel'],
  13: ['created permission overrides on', 'channel'], 14: ['updated permission overrides on', 'channel'], 15: ['removed permission overrides on', 'channel'],
  20: ['kicked', 'user'], 21: ['pruned members', 'guild'], 22: ['banned', 'user'], 23: ['unbanned', 'user'],
  24: ['updated member', 'user'], 25: ['updated roles of', 'user'], 26: ['moved members in voice', 'channel'], 27: ['disconnected members from voice', 'guild'], 28: ['added the bot', 'user'],
  30: ['created role', 'role'], 31: ['updated role', 'role'], 32: ['deleted role', 'role'],
  40: ['created invite', 'invite'], 41: ['updated invite', 'invite'], 42: ['deleted invite', 'invite'],
  50: ['created webhook', 'webhook'], 51: ['updated webhook', 'webhook'], 52: ['deleted webhook', 'webhook'],
  60: ['created emoji', 'emoji'], 61: ['updated emoji', 'emoji'], 62: ['deleted emoji', 'emoji'],
  72: ['deleted a message by', 'user'], 73: ['bulk deleted messages in', 'channel'], 74: ['pinned a message by', 'user'], 75: ['unpinned a message by', 'user'],
  83: ['started the stage', 'stage'], 84: ['updated the stage', 'stage'], 85: ['ended the stage', 'stage'],
  90: ['created sticker', 'sticker'], 91: ['updated sticker', 'sticker'], 92: ['deleted sticker', 'sticker'],
  100: ['created event', 'event'], 101: ['updated event', 'event'], 102: ['cancelled event', 'event'],
  110: ['created thread', 'thread'], 111: ['updated thread', 'thread'], 112: ['deleted thread', 'thread'],
  130: ['added sound', 'sound'], 131: ['updated sound', 'sound'], 132: ['deleted sound', 'sound'],
  140: ['created AutoMod rule', 'rule'], 141: ['updated AutoMod rule', 'rule'], 142: ['deleted AutoMod rule', 'rule'],
  143: ['AutoMod blocked a message by', 'user'], 144: ['AutoMod flagged a message by', 'user'], 145: ['AutoMod timed out', 'user'],
}

const show = (v: unknown) => (v === undefined || v === null || v === '' ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v))

export function AuditLogPage({ guild }: { guild: Guild }) {
  const s = useStore((x) => x)
  const [userId, setUserId] = useState('')
  const [action, setAction] = useState('')
  const [log, setLog] = useState<AuditLog | null>(null)
  const [more, setMore] = useState(false)
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string | null>(null)
  const load = (before?: string) => {
    setError('')
    auditLog(guild.id, { user_id: userId || undefined, action_type: action ? +action : undefined, before }).then(
      (r) => (setMore(r.audit_log_entries.length === 50), setLog((old) => (before && old ? merge(old, r) : r))),
      (e: Error) => setError(e.message),
    )
  }
  useEffect(() => (setLog(null), load()), [guild.id, userId, action])

  const users: Record<string, User> = { ...s.users, ...Object.fromEntries((log?.users ?? []).map((u) => [u.id, u])) }
  const userName = (id: string | null) => (id ? (s.members[guild.id]?.[id] ? memberName(s, guild.id, id) : users[id] ? displayName(users[id]) : id) : t('Someone'))
  const nameFromChanges = (e: AuditLogEntry) => {
    const c = e.changes?.find((x) => x.key === 'name' || x.key === 'code' || x.key === 'topic')
    return c ? show(c.new_value ?? c.old_value) : undefined
  }
  const target = (e: AuditLogEntry): string | undefined => {
    const [, kind] = ACTIONS[e.action_type] ?? ['', 'guild']
    const id = e.target_id ?? ''
    switch (kind) {
      case 'guild': return undefined
      case 'user': return userName(id)
      case 'channel': case 'thread': case 'stage': {
        const c = s.channels[e.options?.channel_id ?? id] ?? log?.threads?.find((t) => t.id === id)
        return c ? `#${c.name}` : nameFromChanges(e) ?? id
      }
      case 'role': return guild.roles.find((r) => r.id === id)?.name ?? nameFromChanges(e) ?? id
      case 'webhook': return log?.webhooks?.find((w) => w.id === id)?.name ?? nameFromChanges(e) ?? id
      case 'emoji': return nameFromChanges(e) ?? guild.emojis?.find((x) => x.id === id)?.name ?? id
      case 'event': return log?.guild_scheduled_events?.find((x) => x.id === id)?.name ?? nameFromChanges(e) ?? id
      case 'rule': return log?.auto_moderation_rules?.find((x) => x.id === id)?.name ?? nameFromChanges(e) ?? id
      default: return nameFromChanges(e) ?? (id || undefined)
    }
  }
  const actors = Object.values(s.members[guild.id] ?? {})

  return (
    <>
      <h1>{t('Audit Log')}</h1>
      <div className="row-fields audit-filters">
        <div className="field grow">
          <label htmlFor="audit-user">{t('Filter by User')}</label>
          <select id="audit-user" className="input" value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">{t('All Users')}</option>
            {actors.map((m) => <option key={m.user.id} value={m.user.id}>{memberName(s, guild.id, m.user.id)}</option>)}
          </select>
        </div>
        <div className="field grow">
          <label htmlFor="audit-action">{t('Filter by Action')}</label>
          <select id="audit-action" className="input" value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">{t('All Actions')}</option>
            {Object.entries(ACTIONS).map(([k, [verb]]) => <option key={k} value={k}>{t(verb).replace(/^./, (c) => c.toUpperCase())}</option>)}
          </select>
        </div>
      </div>
      <FormError error={error} />
      {log === null && !error && <p className="hint">{t('Loading…')}</p>}
      {log?.audit_log_entries.length === 0 && <p className="hint">{t('No logs yet. Moderation and settings changes will show up here.')}</p>}
      <ul className="audit-list" aria-label={t('Audit log entries')}>
        {log?.audit_log_entries.map((e) => {
          const verb = ACTIONS[e.action_type] ? t(ACTIONS[e.action_type][0]) : t('performed action {n}', { n: e.action_type })
          const tgt = target(e)
          const expanded = open === e.id
          const time = new Date(snowflakeTime(e.id)).toISOString()
          return (
            <li key={e.id} className={cls('audit-entry', expanded && 'open')}>
              <button className="audit-head" aria-expanded={expanded} onClick={() => setOpen(expanded ? null : e.id)}>
                <Avatar user={e.user_id ? users[e.user_id] : null} size={32} />
                <span className="audit-text">
                  <span><strong>{userName(e.user_id)}</strong> {verb}{tgt && <> <strong>{tgt}</strong></>}</span>
                  <time className="hint small" dateTime={time}>{stamp(time)}</time>
                </span>
                {!!(e.changes?.length || e.reason) && <Icon d={ICONS.expand} size={16} className="audit-chevron" />}
              </button>
              {expanded && (
                <div className="audit-body">
                  {e.reason && <p className="audit-reason"><span className="field-label">{t('Reason')}</span>{e.reason}</p>}
                  {e.changes?.length ? (
                    <ul className="audit-changes">
                      {e.changes.map((c, i) => (
                        <li key={i}><code>{c.key}</code>: <span className="old">{show(c.old_value)}</span> → <span className="new">{show(c.new_value)}</span></li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )}
            </li>
          )
        })}
      </ul>
      {more && log && <button className="secondary" onClick={() => load(log.audit_log_entries.at(-1)?.id)}>{t('Load more')}</button>}
    </>
  )
}

function merge(a: AuditLog, b: AuditLog): AuditLog {
  return {
    ...b,
    audit_log_entries: [...a.audit_log_entries, ...b.audit_log_entries],
    users: [...a.users, ...b.users],
    webhooks: [...(a.webhooks ?? []), ...(b.webhooks ?? [])],
    threads: [...(a.threads ?? []), ...(b.threads ?? [])],
    auto_moderation_rules: [...(a.auto_moderation_rules ?? []), ...(b.auto_moderation_rules ?? [])],
    guild_scheduled_events: [...(a.guild_scheduled_events ?? []), ...(b.guild_scheduled_events ?? [])],
  }
}
