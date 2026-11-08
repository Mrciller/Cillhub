// Application commands (official docs: global and guild, bulk overwrite) and the user-side command index (user docs)
import { snowflake } from '../snowflake.js';
import { get, all, run, tx, json, isMember, memberIds, userById, userObj } from '../db.js';
import { HttpError, invalid, notFound, missingAccess } from '../errors.js';
import { P, has, guildPerms, channelPerms, parseBits } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { loadChannel } from './channels.js';

const NAME = /^[-_'\p{L}\p{N}\p{sc=Deva}\p{sc=Thai}]{1,32}$/u;
const LIMITS = { 1: 100, 2: 15, 3: 15 }; // per type and scope
const fail = (path, msg) => { throw invalid(path, 'APPLICATION_COMMAND_INVALID', msg); };
const isStr = (v, min, max) => typeof v === 'string' && v.length >= min && v.length <= max;
const localizations = (v, path, max) => {
  if (v == null) return null;
  if (typeof v !== 'object' || Array.isArray(v) || !Object.entries(v).every(([k, s]) => /^[a-zA-Z-]{2,6}$/.test(k) && isStr(s, 1, max))) fail(path, 'Bad localizations.');
  return v;
};
const chatName = (v, path) => (typeof v === 'string' && NAME.test(v) && v === v.toLowerCase() ? v : fail(path, 'Must be 1-32 lowercase letters, numbers, - or _.'));

function choice(c, type, path) {
  if (!isStr(c?.name, 1, 100)) fail(`${path}.name`, '1-100 characters.');
  const ok = type === 3 ? isStr(c.value, 0, 100) : type === 4 ? Number.isSafeInteger(c.value) : typeof c.value === 'number' && Number.isFinite(c.value);
  if (!ok) fail(`${path}.value`, 'Value does not match the option type.');
  return { name: c.name, value: c.value, ...(c.name_localizations && { name_localizations: localizations(c.name_localizations, `${path}.name_localizations`, 100) }) };
}

// options per docs: subcommand groups hold subcommands, subcommands hold parameters; required before optional
function options(list, path, level) {
  if (list == null) return [];
  if (!Array.isArray(list) || list.length > 25) fail(path, 'At most 25 options.');
  const names = new Set();
  let optionalSeen = false;
  const out = list.map((o, i) => {
    const p = `${path}.${i}`;
    if (!Number.isInteger(o?.type) || o.type < 1 || o.type > 11) fail(`${p}.type`, 'Unknown option type.');
    if (names.has(o.name)) fail(`${p}.name`, 'Option names must be unique.');
    names.add(chatName(o.name, `${p}.name`));
    if (!isStr(o.description, 1, 100)) fail(`${p}.description`, '1-100 characters.');
    const r = { type: o.type, name: o.name, description: o.description };
    for (const k of ['name_localizations', 'description_localizations']) if (o[k] != null) r[k] = localizations(o[k], `${p}.${k}`, k[0] === 'n' ? 32 : 100);
    if (o.type === 1 || o.type === 2) {
      if (o.type === 2 && level > 0) fail(`${p}.type`, 'Groups only at the top level.');
      if (o.type === 1 && level > 1) fail(`${p}.type`, 'Too deeply nested.');
      r.options = options(o.options, `${p}.options`, level + 1);
      if (o.type === 2 && r.options.some(x => x.type !== 1)) fail(`${p}.options`, 'Groups hold subcommands only.');
      if (o.type === 1 && r.options.some(x => x.type <= 2)) fail(`${p}.options`, 'Subcommands hold parameters only.');
      return r;
    }
    if (o.required) { if (optionalSeen) fail(`${p}.required`, 'Required options come first.'); r.required = true; } else optionalSeen = true;
    if (o.choices != null) {
      if (![3, 4, 10].includes(o.type) || !Array.isArray(o.choices) || o.choices.length > 25) fail(`${p}.choices`, 'Up to 25 choices for string, integer and number options.');
      r.choices = o.choices.map((c, j) => choice(c, o.type, `${p}.choices.${j}`));
    }
    if (o.autocomplete) {
      if (![3, 4, 10].includes(o.type) || r.choices?.length) fail(`${p}.autocomplete`, 'Autocomplete needs a string, integer or number option without choices.');
      r.autocomplete = true;
    }
    for (const k of ['min_value', 'max_value']) {
      if (o[k] == null) continue;
      if (![4, 10].includes(o.type) || typeof o[k] !== 'number' || (o.type === 4 && !Number.isSafeInteger(o[k]))) fail(`${p}.${k}`, 'Only for integer and number options.');
      r[k] = o[k];
    }
    for (const [k, min] of [['min_length', 0], ['max_length', 1]]) {
      if (o[k] == null) continue;
      if (o.type !== 3 || !Number.isInteger(o[k]) || o[k] < min || o[k] > 6000) fail(`${p}.${k}`, 'Only for string options, up to 6000.');
      r[k] = o[k];
    }
    if (o.channel_types != null) {
      if (o.type !== 7 || !Array.isArray(o.channel_types) || !o.channel_types.every(Number.isInteger)) fail(`${p}.channel_types`, 'Only for channel options.');
      r.channel_types = o.channel_types;
    }
    return r;
  });
  if (out.some(o => o.type <= 2) && out.some(o => o.type > 2)) fail(path, 'Subcommands cannot be mixed with parameters.');
  return out;
}

// the stored fields of a command; type 1 slash, 2 user, 3 message
export function validateCommand(b, global) {
  const type = b?.type ?? 1;
  if (![1, 2, 3].includes(type)) fail('type', 'Only CHAT_INPUT, USER and MESSAGE commands.');
  const name = type === 1 ? chatName(b.name, 'name') : isStr(b.name, 1, 32) ? b.name : fail('name', '1-32 characters.');
  if (type === 1 && !isStr(b.description, 1, 100)) fail('description', '1-100 characters.');
  if (type !== 1 && b.description && b.description !== '') fail('description', 'Context menu commands have no description.');
  if (type !== 1 && b.options?.length) fail('options', 'Only slash commands take options.');
  const out = {
    type, name, description: type === 1 ? b.description : '', options: type === 1 ? options(b.options, 'options', 0) : undefined,
    name_localizations: localizations(b.name_localizations, 'name_localizations', 32),
    description_localizations: localizations(b.description_localizations, 'description_localizations', 100),
    default_member_permissions: b.default_member_permissions == null ? null : String(parseBits(b.default_member_permissions, 'default_member_permissions')),
    nsfw: !!b.nsfw,
  };
  if (global) {
    out.dm_permission = b.dm_permission !== false;
    out.contexts = b.contexts == null ? null : Array.isArray(b.contexts) && b.contexts.every(c => [0, 1, 2].includes(c)) ? [...new Set(b.contexts)] : fail('contexts', 'Values 0, 1 or 2.');
    out.integration_types = b.integration_types == null ? [0] : Array.isArray(b.integration_types) && b.integration_types.every(c => c === 0 || c === 1) ? [...new Set(b.integration_types)] : fail('integration_types', 'Values 0 or 1.');
  }
  return out;
}

export const commandObj = c => ({
  id: c.id, application_id: c.application_id, ...(c.guild_id && { guild_id: c.guild_id }), version: c.version, ...json(c.data),
});

// --- bot routes -----------------------------------------------------------------------------------------------------
function scope(ctx) {
  if (ctx.params.app !== ctx.user.id) throw new HttpError(403, 20012, 'You are not authorized to perform this action on this application');
  const guildId = ctx.params.guild ?? null;
  if (guildId && !isMember(guildId, ctx.user.id)) throw missingAccess();
  return { app: ctx.user.id, guildId };
}
const listOf = ({ app, guildId }) => all('SELECT * FROM application_commands WHERE application_id = ? AND guild_id IS ? ORDER BY rowid', app, guildId);

// users' clients refresh their command index when this arrives
export function announce({ app, guildId }) {
  const guilds = guildId ? [guildId] : all('SELECT guild_id FROM members WHERE user_id = ?', app).map(r => r.guild_id);
  for (const g of guilds) {
    const counts = Object.fromEntries([1, 2, 3].map(t => [t, get('SELECT COUNT(*) AS n FROM application_commands WHERE guild_id IS ? AND type = ? AND application_id IN (SELECT user_id FROM members WHERE guild_id = ?)', g, t, g).n]));
    sendToUsers(memberIds(g).filter(id => id !== app), 'GUILD_APPLICATION_COMMAND_INDEX_UPDATE', { guild_id: g, application_command_counts: counts, version: snowflake() });
  }
}

function upsert(s, data) {
  const existing = get('SELECT * FROM application_commands WHERE application_id = ? AND guild_id IS ? AND type = ? AND name = ?', s.app, s.guildId, data.type, data.name);
  if (existing) {
    run('UPDATE application_commands SET data = ?, version = ? WHERE id = ?', JSON.stringify(data), snowflake(), existing.id);
    return [false, existing.id];
  }
  if (get('SELECT COUNT(*) AS n FROM application_commands WHERE application_id = ? AND guild_id IS ? AND type = ?', s.app, s.guildId, data.type).n >= LIMITS[data.type]) {
    throw new HttpError(400, 30032, 'Maximum number of application commands reached');
  }
  const id = snowflake();
  run('INSERT INTO application_commands (id, application_id, guild_id, type, name, data, version) VALUES (?, ?, ?, ?, ?, ?, ?)', id, s.app, s.guildId, data.type, data.name, JSON.stringify(data), id);
  return [true, id];
}
const byId = (s, id) => {
  const c = get('SELECT * FROM application_commands WHERE id = ? AND application_id = ? AND guild_id IS ?', id, s.app, s.guildId);
  if (!c) throw notFound(10063, 'application command');
  return c;
};

function create(ctx) {
  const s = scope(ctx);
  const [fresh, id] = upsert(s, validateCommand(ctx.body ?? {}, !s.guildId));
  ctx.status = fresh ? 201 : 200;
  announce(s);
  return commandObj(byId(s, id));
}

function edit(ctx) {
  const s = scope(ctx);
  const c = byId(s, ctx.params.cmd);
  const data = validateCommand({ ...json(c.data), ...ctx.body, type: c.type }, !s.guildId);
  const clash = get('SELECT 1 FROM application_commands WHERE application_id = ? AND guild_id IS ? AND type = ? AND name = ? AND id != ?', s.app, s.guildId, data.type, data.name, c.id);
  if (clash) throw new HttpError(400, 40041, 'An application command with that name already exists');
  run('UPDATE application_commands SET name = ?, data = ?, version = ? WHERE id = ?', data.name, JSON.stringify(data), snowflake(), c.id);
  announce(s);
  return commandObj(byId(s, c.id));
}

function remove(ctx) {
  const s = scope(ctx);
  run('DELETE FROM application_commands WHERE id = ?', byId(s, ctx.params.cmd).id);
  announce(s);
}

// PUT: the list becomes the full set; commands keep their ids by (type, name)
function bulk(ctx) {
  const s = scope(ctx);
  if (!Array.isArray(ctx.body)) throw invalid('_root', 'BASE_TYPE_ARRAY', 'Must be an array.');
  const datas = ctx.body.map(b => validateCommand(b ?? {}, !s.guildId));
  const keys = datas.map(d => `${d.type}:${d.name}`);
  if (new Set(keys).size !== keys.length) throw new HttpError(400, 40041, 'An application command with that name already exists');
  for (const t of [1, 2, 3]) if (datas.filter(d => d.type === t).length > LIMITS[t]) throw new HttpError(400, 30032, 'Maximum number of application commands reached');
  tx(() => {
    for (const c of listOf(s)) if (!keys.includes(`${c.type}:${c.name}`)) run('DELETE FROM application_commands WHERE id = ?', c.id);
    datas.forEach(d => upsert(s, d));
  });
  announce(s);
  return listOf(s).map(commandObj);
}

// --- what a user may run where -------------------------------------------------------------------------------------
// default_member_permissions: null = everyone, "0" = administrators only, else the member needs those bits
const permitted = (c, perms) => {
  const need = json(c.data).default_member_permissions;
  return need == null || has(perms, P.ADMINISTRATOR) || (need !== '0' && has(perms, BigInt(need)));
};

// the commands a user can see in a channel (or guild-wide when ch is a guild), with their application rows
export function commandsFor(user, { guildId, ch }) {
  if (!guildId) {
    if (ch?.type !== 1) return [];
    const bot = all('SELECT user_id FROM dm_recipients WHERE channel_id = ? AND user_id != ?', ch.id, user.id).map(r => userById(r.user_id)).find(u => u?.bot);
    if (!bot) return [];
    return all('SELECT * FROM application_commands WHERE application_id = ? AND guild_id IS NULL', bot.id).filter(c => {
      const d = json(c.data);
      return d.contexts ? d.contexts.includes(1) : d.dm_permission !== false;
    });
  }
  const perms = ch ? channelPerms(ch, user.id) : guildPerms(guildId, user.id);
  if (!has(perms, P.USE_APPLICATION_COMMANDS)) return [];
  return all(`SELECT c.* FROM application_commands c JOIN members m ON m.user_id = c.application_id AND m.guild_id = ?
              WHERE c.guild_id IS NULL OR c.guild_id = ? ORDER BY c.rowid`, guildId, guildId)
    .filter(c => (c.guild_id || !json(c.data).contexts || json(c.data).contexts.includes(0)) && permitted(c, perms));
}

function index(user, where) {
  const cmds = commandsFor(user, where);
  const apps = [...new Set(cmds.map(c => c.application_id))].map(id => get('SELECT * FROM applications WHERE id = ?', id)).filter(Boolean);
  return {
    applications: apps.map(a => ({ id: a.id, name: a.name, description: a.description, icon: a.icon, bot_id: a.id, bot: userObj(userById(a.id)), flags: String(a.flags) })),
    application_commands: cmds.map(commandObj),
    version: cmds.reduce((v, c) => (BigInt(c.version) > BigInt(v) ? c.version : v), '0'),
  };
}

const base = '/applications/:app/commands';
const guildBase = '/applications/:app/guilds/:guild/commands';
const bot = { botOnly: true };
export default [
  ['GET', base, ctx => listOf(scope(ctx)).map(commandObj), bot],
  ['POST', base, create, bot],
  ['PUT', base, bulk, bot],
  ['GET', `${base}/:cmd`, ctx => commandObj(byId(scope(ctx), ctx.params.cmd)), bot],
  ['PATCH', `${base}/:cmd`, edit, bot],
  ['DELETE', `${base}/:cmd`, remove, bot],
  ['GET', `${guildBase}/permissions`, ctx => { scope(ctx); return []; }, bot],
  ['GET', guildBase, ctx => listOf(scope(ctx)).map(commandObj), bot],
  ['POST', guildBase, create, bot],
  ['PUT', guildBase, bulk, bot],
  ['GET', `${guildBase}/:cmd/permissions`, ctx => { byId(scope(ctx), ctx.params.cmd); throw notFound(10066, 'application command permissions'); }, bot],
  ['GET', `${guildBase}/:cmd`, ctx => commandObj(byId(scope(ctx), ctx.params.cmd)), bot],
  ['PATCH', `${guildBase}/:cmd`, edit, bot],
  ['DELETE', `${guildBase}/:cmd`, remove, bot],
  ['GET', '/guilds/:id/application-command-index', ({ params, user }) => {
    if (!isMember(params.id, user.id)) throw missingAccess();
    return index(user, { guildId: params.id });
  }, { userOnly: true }],
  ['GET', '/channels/:id/application-command-index', ({ params, user }) => {
    const ch = loadChannel(params.id, user);
    return index(user, { guildId: ch.guild_id, ch });
  }, { userOnly: true }],
  ['GET', '/users/@me/application-command-index', () => ({ applications: [], application_commands: [], version: '0' }), { userOnly: true }],
];
