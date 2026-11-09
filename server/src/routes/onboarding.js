import { snowflake } from '../snowflake.js';
import { get, run, tx, json, memberIds, memberRow, memberObj } from '../db.js';
import { HttpError } from '../errors.js';
import { P, need, requireAssignable } from '../permissions.js';
import { sendToUsers, visibility, syncVisibility } from '../gateway.js';
import { loadGuild } from './guilds.js';

function getOnboarding(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const row = get('SELECT * FROM guild_onboarding WHERE guild_id = ?', g.id);
  return {
    guild_id: g.id,
    enabled: !!row?.enabled,
    prompts: row ? json(row.prompts, []) : [],
    default_channel_ids: row?.default_channel_ids ? json(row.default_channel_ids, []) : [],
  };
}

function putOnboarding(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user, P.MANAGE_GUILD);
  const body = ctx.body ?? {};
  const enabled = !!body.enabled;
  const rawPrompts = Array.isArray(body.prompts) ? body.prompts : [];

  const prompts = rawPrompts.map(p => ({
    id: p.id || snowflake(),
    title: String(p.title || '').slice(0, 100),
    single_select: !!p.single_select,
    required: !!p.required,
    options: (Array.isArray(p.options) ? p.options : []).map(o => ({
      id: o.id || snowflake(),
      title: String(o.title || '').slice(0, 100),
      description: o.description ? String(o.description).slice(0, 200) : null,
      role_ids: (Array.isArray(o.role_ids) ? o.role_ids : []).map(String),
      channel_ids: (Array.isArray(o.channel_ids) ? o.channel_ids : []).map(String),
    })),
  }));

  const inGuild = id => !!get('SELECT 1 FROM channels WHERE id = ? AND guild_id = ?', id, g.id);
  const defaultChannelIds = (Array.isArray(body.default_channel_ids) ? body.default_channel_ids : []).map(String).filter(inGuild);
  // answering hands these roles out, so setting them needs the same rights as assigning them directly
  for (const o of prompts.flatMap(p => p.options)) {
    o.channel_ids = o.channel_ids.filter(inGuild);
    if (o.role_ids.length) need(g.perms, P.MANAGE_ROLES);
    for (const id of o.role_ids) requireAssignable(g.id, ctx.user.id, id, 'prompts');
  }

  run(`
    INSERT INTO guild_onboarding (guild_id, enabled, prompts, default_channel_ids)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET
      enabled = excluded.enabled,
      prompts = excluded.prompts,
      default_channel_ids = excluded.default_channel_ids
  `, g.id, Number(enabled), JSON.stringify(prompts), JSON.stringify(defaultChannelIds));

  const out = { guild_id: g.id, enabled, prompts, default_channel_ids: defaultChannelIds };
  sendToUsers(memberIds(g.id), 'GUILD_ONBOARDING_UPDATE', out);
  return out;
}

function respondOnboarding(ctx) {
  const g = loadGuild(ctx.params.id, ctx.user);
  const row = get('SELECT * FROM guild_onboarding WHERE guild_id = ?', g.id);
  if (!row || !row.enabled) throw new HttpError(400, 0, 'Onboarding is not enabled for this server.');

  const body = ctx.body ?? {};
  const optionIds = new Set(Array.isArray(body.option_ids) ? body.option_ids.map(String) : []);
  const prompts = json(row.prompts, []);

  const rolesToAssign = new Set();
  for (const prompt of prompts) {
    for (const opt of prompt.options) {
      if (optionIds.has(opt.id)) {
        for (const rid of opt.role_ids) {
          const role = get('SELECT id FROM roles WHERE id = ? AND guild_id = ? AND managed = 0', rid, g.id);
          if (role) rolesToAssign.add(role.id);
        }
      }
    }
  }

  const seen = visibility(g.id, [ctx.user.id]);
  tx(() => {
    for (const roleId of rolesToAssign) {
      run('INSERT OR IGNORE INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)', g.id, ctx.user.id, roleId);
    }
  });

  const member = memberObj(memberRow(g.id, ctx.user.id));
  sendToUsers(memberIds(g.id), 'GUILD_MEMBER_UPDATE', member);
  syncVisibility(g.id, seen);
  return { success: true, assigned_roles: [...rolesToAssign] };
}

export default [
  ['GET', '/guilds/:id/onboarding', getOnboarding],
  ['PUT', '/guilds/:id/onboarding', putOnboarding],
  ['POST', '/guilds/:id/onboarding/respond', respondOnboarding],
  ['POST', '/guilds/:id/onboarding/responses', respondOnboarding],
];
