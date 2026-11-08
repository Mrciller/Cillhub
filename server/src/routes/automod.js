import { snowflake } from '../snowflake.js';
import { get, all, run, json } from '../db.js';
import { HttpError, str, int, bool, invalid, snowflakes } from '../errors.js';
import { P, holders } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { audit, A, diff } from '../audit.js';
import { patternProblem } from '../automod.js';
import { loadGuild } from './guilds.js';

// supported trigger types: KEYWORD, MENTION_SPAM, MEMBER_PROFILE (with their event type and per-guild maximum)
const TRIGGERS = { 1: { event: 1, max: 6 }, 5: { event: 1, max: 1 }, 6: { event: 2, max: 1 } };

export const ruleObj = r => ({
  id: r.id, guild_id: r.guild_id, name: r.name, creator_id: r.creator_id, event_type: r.event_type, trigger_type: r.trigger_type,
  trigger_metadata: json(r.trigger_metadata), actions: json(r.actions), enabled: !!r.enabled,
  exempt_roles: json(r.exempt_roles), exempt_channels: json(r.exempt_channels),
});

function strings(meta, field, maxItems, maxLen) {
  const v = meta[field] ?? [];
  if (!Array.isArray(v) || v.length > maxItems || v.some(s => typeof s !== 'string' || !s.length || s.length > maxLen)) {
    throw invalid(`trigger_metadata.${field}`, 'BASE_TYPE_BAD_LENGTH', `At most ${maxItems} strings of 1-${maxLen} characters.`);
  }
  return v;
}

function metadata(type, meta = {}) {
  if (typeof meta !== 'object' || meta === null) throw invalid('trigger_metadata', 'MODEL_TYPE_CONVERT', 'Must be an object.');
  if (type === 5) {
    return { mention_total_limit: int(meta, 'mention_total_limit', 1, 50), mention_raid_protection_enabled: !!meta.mention_raid_protection_enabled };
  }
  const regex_patterns = strings(meta, 'regex_patterns', 10, 2048);
  for (const p of regex_patterns) {
    const problem = patternProblem(p);
    if (problem) throw invalid('trigger_metadata.regex_patterns', 'AUTO_MODERATION_INVALID_REGEX', problem);
  }
  return { keyword_filter: strings(meta, 'keyword_filter', 1000, 60), regex_patterns, allow_list: strings(meta, 'allow_list', 100, 60) };
}

function actions(value, guildId, trigger) {
  if (!Array.isArray(value) || !value.length || value.length > 5) throw invalid('actions', 'BASE_TYPE_BAD_LENGTH', 'Between 1 and 5 actions.');
  return value.map(a => {
    const m = a?.metadata ?? {};
    if (a?.type === 1) return { type: 1, metadata: { custom_message: m.custom_message == null ? null : str(m, 'custom_message', 0, 150) } };
    if (a?.type === 2) {
      if (!get('SELECT 1 FROM channels WHERE id = ? AND guild_id = ? AND type IN (0, 5)', String(m.channel_id), guildId)) {
        throw invalid('actions', 'AUTO_MODERATION_INVALID_CHANNEL', 'Alerts go to a text channel of this guild.');
      }
      return { type: 2, metadata: { channel_id: String(m.channel_id) } };
    }
    if (a?.type === 3 && trigger !== 6) return { type: 3, metadata: { duration_seconds: int(m, 'duration_seconds', 1, 2419200) } };
    throw invalid('actions', 'BASE_TYPE_CHOICES', 'Action type must be 1 (block), 2 (alert) or 3 (timeout).');
  });
}

function fields(body, g, current) {
  const trigger = current?.trigger_type ?? body.trigger_type;
  if (!Object.hasOwn(TRIGGERS, trigger)) throw invalid('trigger_type', 'BASE_TYPE_CHOICES', 'Supported trigger types: 1 (keyword), 5 (mention spam), 6 (member profile).');
  const out = {};
  const set = (k, fn) => { if (body[k] !== undefined || !current) out[k] = fn(); };
  set('name', () => str(body, 'name', 1, 100));
  set('event_type', () => {
    const e = body.event_type ?? TRIGGERS[trigger].event;
    if (e !== TRIGGERS[trigger].event) throw invalid('event_type', 'BASE_TYPE_CHOICES', 'Event type does not fit the trigger type.');
    return e;
  });
  set('trigger_metadata', () => JSON.stringify(metadata(trigger, body.trigger_metadata)));
  set('actions', () => JSON.stringify(actions(body.actions, g.id, trigger)));
  set('enabled', () => Number(body.enabled === undefined ? false : bool(body, 'enabled')));
  set('exempt_roles', () => JSON.stringify(body.exempt_roles == null ? [] : snowflakes(body, 'exempt_roles', 20)));
  set('exempt_channels', () => JSON.stringify(body.exempt_channels == null ? [] : snowflakes(body, 'exempt_channels', 50)));
  return out;
}

function loadRule(g, id) {
  const r = get('SELECT * FROM automod_rules WHERE id = ? AND guild_id = ?', id, g.id);
  if (!r) throw new HttpError(404, 0, 'Unknown Auto Moderation Rule');
  return r;
}

const announce = (g, t, r) => sendToUsers(holders(g.id, P.MANAGE_GUILD), t, ruleObj(r));
const KEYS = ['name', 'event_type', 'trigger_metadata', 'actions', 'enabled', 'exempt_roles', 'exempt_channels'];
const auditView = r => r && Object.fromEntries(KEYS.map(k => [k, ['trigger_metadata', 'actions', 'exempt_roles', 'exempt_channels'].includes(k) ? json(r[k]) : k === 'enabled' ? !!r[k] : r[k]]));

function create(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const body = ctx.body ?? {};
  const f = fields(body, g);
  if (get('SELECT COUNT(*) AS n FROM automod_rules WHERE guild_id = ? AND trigger_type = ?', g.id, body.trigger_type).n >= TRIGGERS[body.trigger_type].max) {
    throw new HttpError(400, 0, 'Maximum number of rules of this trigger type reached');
  }
  const id = snowflake();
  run(`INSERT INTO automod_rules (id, guild_id, name, creator_id, event_type, trigger_type, trigger_metadata, actions, enabled, exempt_roles, exempt_channels)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, g.id, f.name, ctx.user.id, f.event_type, body.trigger_type, f.trigger_metadata, f.actions,
  f.enabled, f.exempt_roles, f.exempt_channels);
  const r = loadRule(g, id);
  audit(ctx, g.id, A.AUTO_MODERATION_RULE_CREATE, id, { changes: diff({}, auditView(r)) });
  announce(g, 'AUTO_MODERATION_RULE_CREATE', r);
  return ruleObj(r);
}

function update(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const r = loadRule(g, ctx.params.rule_id);
  const f = fields(ctx.body ?? {}, g, r);
  for (const [k, v] of Object.entries(f)) run(`UPDATE automod_rules SET ${k} = ? WHERE id = ?`, v, r.id); // keys come from fields()
  const next = loadRule(g, r.id);
  audit(ctx, g.id, A.AUTO_MODERATION_RULE_UPDATE, r.id, { changes: diff(auditView(r), auditView(next)) });
  announce(g, 'AUTO_MODERATION_RULE_UPDATE', next);
  return ruleObj(next);
}

function remove(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const r = loadRule(g, ctx.params.rule_id);
  run('DELETE FROM automod_rules WHERE id = ?', r.id);
  audit(ctx, g.id, A.AUTO_MODERATION_RULE_DELETE, r.id, { changes: diff(auditView(r), {}, ['name']) });
  announce(g, 'AUTO_MODERATION_RULE_DELETE', r);
}

const base = '/guilds/:id/auto-moderation/rules';
export default [
  ['GET', base, ({ params, user }) => all('SELECT * FROM automod_rules WHERE guild_id = ? ORDER BY rowid', loadGuild(params.id, user, P.MANAGE_GUILD).id).map(ruleObj)],
  ['GET', `${base}/:rule_id`, ({ params, user }) => ruleObj(loadRule(loadGuild(params.id, user, P.MANAGE_GUILD), params.rule_id))],
  ['POST', base, create],
  ['PATCH', `${base}/:rule_id`, update],
  ['DELETE', `${base}/:rule_id`, remove],
];
