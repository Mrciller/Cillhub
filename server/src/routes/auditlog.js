import { all, json, userById, userObj, threadObj } from '../db.js';
import { invalid, intParam, idParam } from '../errors.js';
import { P } from '../permissions.js';
import { loadGuild } from './guilds.js';
import { webhookObj } from './webhooks.js';
import { ruleObj } from './automod.js';
import { eventObj } from './events.js';

const entryObj = e => ({
  id: e.id, user_id: e.user_id, target_id: e.target_id, action_type: e.action_type,
  ...(e.changes && { changes: json(e.changes) }), ...(e.options && { options: json(e.options) }), ...(e.reason && { reason: e.reason }),
});

const byIds = (sql, ids) => (ids.length ? all(`${sql} IN (SELECT value FROM json_each(?))`, JSON.stringify(ids)) : []);

function list({ params, query, user }) {
  const g = loadGuild(params.id, user, P.VIEW_AUDIT_LOG);
  const userId = idParam(query, 'user_id');
  const before = idParam(query, 'before'), after = idParam(query, 'after');
  const type = query.has('action_type') ? Number(query.get('action_type')) : null;
  if (type !== null && !Number.isInteger(type)) throw invalid('action_type', 'NUMBER_TYPE_COERCE', 'Must be an integer.');
  const limit = intParam(query, 'limit', 50, 1, 100);
  const rows = all(`SELECT * FROM audit_log WHERE guild_id = ? AND (? IS NULL OR user_id = ?) AND (? IS NULL OR action_type = ?)
                    AND (? IS NULL OR CAST(id AS INTEGER) < CAST(? AS INTEGER)) AND (? IS NULL OR CAST(id AS INTEGER) > CAST(? AS INTEGER))
                    ORDER BY CAST(id AS INTEGER) DESC LIMIT ?`, g.id, userId, userId, type, type, before, before, after, after, limit);
  const ids = [...new Set(rows.flatMap(r => [r.user_id, r.target_id]).filter(Boolean))];
  return {
    audit_log_entries: rows.map(entryObj),
    users: ids.map(id => userById(id)).filter(Boolean).map(u => userObj(u)),
    webhooks: byIds('SELECT * FROM webhooks WHERE id', ids).map(w => webhookObj(w, { withToken: false })),
    threads: byIds('SELECT * FROM channels WHERE type IN (10, 11, 12) AND id', ids).map(t => threadObj(t)),
    auto_moderation_rules: byIds('SELECT * FROM automod_rules WHERE id', ids).map(ruleObj),
    guild_scheduled_events: byIds('SELECT * FROM scheduled_events WHERE id', ids).map(e => eventObj(e, false)),
    integrations: [], application_commands: [],
  };
}

export default [['GET', '/guilds/:id/audit-logs', list]];
