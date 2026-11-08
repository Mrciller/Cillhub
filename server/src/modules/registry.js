// How modules plug into the chat (CONTRACT-v8 §3, §4.1, §6.2): bot membership with a managed role, commands while
// enabled, the gateway events a module may receive, interactions answered by the sandbox, panels in guild objects,
// schedules, and the auto-disable after crashes. Lifecycle entry points for routes/modules.js live here too.
import { get, all, run, tx, isMember, memberIds, userById, roleObj } from '../db.js';
import { HttpError } from '../errors.js';
import { snowflake } from '../snowflake.js';
import { P } from '../permissions.js';
import { sendToUsers, moduleSinks, guildParts } from '../gateway.js';
import { localApps, interactionRecord, respond } from '../interactions.js';
import { addJob, schedule } from '../timers.js';
import { announce } from '../routes/commands.js';
import { addBot } from '../routes/applications.js';
import { removeMember, guildCreatedHooks } from '../routes/guilds.js';
import * as host from './host.js';
import { getModule, allModules, enabledModules, inScope, has, addLog, moduleLog } from './store.js';

// §3: the managed role follows the module's permissions
export function basePerms(mod) {
  let p = P.VIEW_CHANNEL;
  if (has(mod, 'messages.read')) p |= P.READ_MESSAGE_HISTORY;
  if (has(mod, 'messages.send')) p |= P.SEND_MESSAGES | P.SEND_MESSAGES_IN_THREADS | P.EMBED_LINKS | P.ATTACH_FILES | P.ADD_REACTIONS | P.USE_EXTERNAL_EMOJIS;
  if (has(mod, 'roles.manage')) p |= P.MANAGE_ROLES;
  if (has(mod, 'commands')) p |= P.USE_APPLICATION_COMMANDS;
  return p;
}

// --- panels (§6.2) ---------------------------------------------------------------------------------------------
export function panelsOf(guildId) {
  const out = [];
  for (const mod of enabledModules()) {
    if (!has(mod, 'ui') || !host.isRunning(mod.id) || !inScope(mod, guildId) || !isMember(guildId, mod.app_id)) continue;
    for (const p of mod.manifest.ui.panels) {
      out.push({ module_id: mod.id, application_id: mod.app_id, panel_id: p.id, slot: p.slot, title: p.title, icon: p.icon, height: p.height, url: `/modules/${mod.id}/ui/${p.entry}` });
    }
  }
  return out;
}
const lastPanels = new Map(); // guild id -> JSON of the list last announced
function announcePanels(moduleId) {
  const mod = getModule(moduleId);
  const guilds = new Set(mod ? all('SELECT guild_id FROM members WHERE user_id = ?', mod.app_id).map(r => r.guild_id) : []);
  for (const [g, text] of lastPanels) if (text.includes(`"module_id":${JSON.stringify(moduleId)}`)) guilds.add(g);
  for (const g of guilds) {
    const list = panelsOf(g);
    const text = JSON.stringify(list);
    if ((lastPanels.get(g) ?? '[]') === text) continue;
    lastPanels.set(g, text);
    sendToUsers(memberIds(g), 'GUILD_MODULE_PANELS_UPDATE', { guild_id: g, module_panels: list });
  }
}
guildParts.push(g => ({ module_panels: panelsOf(g.id) }));

// --- commands: the manifest's, as global commands of the module's application, while it is enabled ------------------
export function syncCommands(mod) {
  const want = mod.enabled && has(mod, 'commands') ? mod.manifest.commands : [];
  let changed = false;
  tx(() => {
    for (const c of all('SELECT id, type, name FROM application_commands WHERE application_id = ?', mod.app_id)) {
      if (!want.some(d => d.type === c.type && d.name === c.name)) { run('DELETE FROM application_commands WHERE id = ?', c.id); changed = true; }
    }
    for (const d of want) {
      const cur = get('SELECT * FROM application_commands WHERE application_id = ? AND guild_id IS NULL AND type = ? AND name = ?', mod.app_id, d.type, d.name);
      if (!cur) { const id = snowflake(); run('INSERT INTO application_commands (id, application_id, guild_id, type, name, data, version) VALUES (?, ?, NULL, ?, ?, ?, ?)', id, mod.app_id, d.type, d.name, JSON.stringify(d), id); changed = true; }
      else if (cur.data !== JSON.stringify(d)) { run('UPDATE application_commands SET data = ?, version = ? WHERE id = ?', JSON.stringify(d), snowflake(), cur.id); changed = true; }
    }
  });
  if (changed) announce({ app: mod.app_id, guildId: null });
}

// --- membership (§3) -------------------------------------------------------------------------------------------
const botActor = mod => ({ user: { id: mod.app_id } });
function join(mod, guildId) {
  if (isMember(guildId, mod.app_id) || get('SELECT 1 FROM bans WHERE guild_id = ? AND user_id = ?', guildId, mod.app_id)) return;
  addBot(guildId, get('SELECT * FROM applications WHERE id = ?', mod.app_id), basePerms(mod), botActor(mod));
  const g = get('SELECT id, name FROM guilds WHERE id = ?', guildId);
  host.emit(mod.id, 'GUILD_CREATE', { id: g.id, name: g.name });
}
// enabled: joins every server of the scope (again, after a kick); always: leaves servers outside the scope
export function syncMembership(mod) {
  const targets = mod.scope === 'all' ? all('SELECT id FROM guilds').map(r => r.id) : mod.guild_ids.filter(g => get('SELECT 1 FROM guilds WHERE id = ?', g));
  for (const { guild_id: g } of all('SELECT guild_id FROM members WHERE user_id = ?', mod.app_id)) {
    if (!targets.includes(g)) removeMember(g, userById(mod.app_id)); // the module hears GUILD_DELETE through its sink
  }
  if (mod.enabled) targets.forEach(g => join(mod, g));
  announcePanels(mod.id);
}
// after an update: the managed roles carry the new permissions
export function syncRoles(mod) {
  const perms = String(basePerms(mod));
  for (const r of all('SELECT * FROM roles WHERE bot_id = ? AND managed = 1', mod.app_id)) {
    if (r.permissions === perms) continue;
    run('UPDATE roles SET permissions = ? WHERE id = ?', perms, r.id);
    sendToUsers(memberIds(r.guild_id), 'GUILD_ROLE_UPDATE', { guild_id: r.guild_id, role: roleObj(get('SELECT * FROM roles WHERE id = ?', r.id)) });
  }
}
guildCreatedHooks.push(g => {
  for (const mod of enabledModules()) if (mod.scope === 'all') join(mod, g.id);
  for (const mod of enabledModules()) announcePanels(mod.id);
});

// --- events (§4.1) ---------------------------------------------------------------------------------------------
const EVENT_PERMS = {
  MESSAGE_CREATE: 'messages.read', MESSAGE_UPDATE: 'messages.read', MESSAGE_DELETE: 'messages.read', MESSAGE_DELETE_BULK: 'messages.read',
  MESSAGE_REACTION_ADD: 'messages.read', MESSAGE_REACTION_REMOVE: 'messages.read',
  GUILD_MEMBER_ADD: 'members.read', GUILD_MEMBER_UPDATE: 'members.read', GUILD_MEMBER_REMOVE: 'members.read',
  VOICE_STATE_UPDATE: 'voice.read',
};
function sink(moduleId) {
  return (t, d) => {
    // its bot left a server (scope narrowed, kicked, server deleted): the module is no longer enabled there
    if (t === 'GUILD_DELETE') return host.statusOf(moduleId) && typeof d?.id === 'string' && host.emit(moduleId, 'GUILD_DELETE', { id: d.id });
    const perm = EVENT_PERMS[t];
    if (!perm || !host.statusOf(moduleId) || !d?.guild_id) return;
    const mod = getModule(moduleId);
    if (!mod || !has(mod, perm) || !inScope(mod, d.guild_id)) return;
    if ((t === 'MESSAGE_CREATE' || t === 'MESSAGE_UPDATE') && d.author?.id === mod.app_id) return; // its own messages
    if (t.startsWith('GUILD_MEMBER_') && d.user?.id === mod.app_id) return;
    host.emit(moduleId, t, d);
  };
}

// interactions go to the sandbox without their token; a returned response (with a type) answers it
function interactionHandler(moduleId) {
  return payload => {
    const mod = getModule(moduleId);
    if (!mod || !has(mod, 'commands') || !host.statusOf(moduleId)) return; // no answer: the client shows the failure
    const { token, ...interaction } = payload;
    host.request(moduleId, 'INTERACTION_CREATE', interaction, 10_000).then(r => {
      if (!r.ok || r.result == null || typeof r.result !== 'object' || r.result.type == null) return;
      const rec = interactionRecord(interaction.id);
      if (!rec) return;
      try {
        respond(rec, r.result, false);
      } catch (e) {
        if (!(e instanceof HttpError)) throw e;
        moduleLog(moduleId, 'error', `The interaction response was refused: ${e.body.message}${e.body.errors ? ` ${JSON.stringify(e.body.errors).slice(0, 500)}` : ''}`);
      }
    });
  };
}

export function register(mod) {
  moduleSinks.set(mod.app_id, sink(mod.id));
  localApps.set(mod.app_id, interactionHandler(mod.id));
}
export function unregister(mod) {
  moduleSinks.delete(mod.app_id);
  localApps.delete(mod.app_id);
}

// --- schedules (§4.7): due ones fire for running modules; one that fell due while stopped fires once on start -------
addJob({
  name: 'module schedules',
  next: () => {
    const ids = host.runningIds();
    return ids.length ? get(`SELECT MIN(next_at) AS t FROM module_schedules WHERE module_id IN (${ids.map(() => '?').join(', ')})`, ...ids).t : null;
  },
  run: now => {
    for (const id of host.runningIds()) {
      const mod = getModule(id);
      for (const s of all('SELECT * FROM module_schedules WHERE module_id = ? AND next_at <= ?', id, now)) {
        if (s.interval_ms) run('UPDATE module_schedules SET next_at = ? WHERE module_id = ? AND name = ?', now + s.interval_ms, id, s.name);
        else run('DELETE FROM module_schedules WHERE module_id = ? AND name = ?', id, s.name);
        if (mod && has(mod, 'schedule')) host.emit(id, 'SCHEDULE', { name: s.name, at: s.next_at });
      }
    }
  },
});

// --- host hooks ------------------------------------------------------------------------------------------------
host.hooks.changed = id => {
  announcePanels(id);
  if (host.isRunning(id)) schedule();
};
host.hooks.readyPayload = id => {
  const mod = getModule(id);
  const guilds = all('SELECT g.id, g.name FROM guilds g JOIN members m ON m.guild_id = g.id AND m.user_id = ? ORDER BY g.rowid', mod.app_id).filter(g => inScope(mod, g.id));
  return { module: { id: mod.id, version: mod.manifest.version, application_id: mod.app_id, permissions: mod.manifest.permissions }, guilds: guilds.map(g => ({ id: g.id, name: g.name })) };
};
host.hooks.crashed = (id, reason) => {
  run('UPDATE modules SET enabled = 0, crashed = 1, status_reason = ?, updated_at = ? WHERE id = ?', reason.slice(0, 500), Date.now(), id);
  const mod = getModule(id);
  if (mod) syncCommands(mod);
  announcePanels(id);
};

// --- lifecycle -------------------------------------------------------------------------------------------------
export function enable(mod) {
  run('UPDATE modules SET enabled = 1, crashed = 0, status_reason = NULL WHERE id = ?', mod.id);
  const fresh = getModule(mod.id);
  syncMembership(fresh);
  syncCommands(fresh);
  host.start(fresh);
}
export function disable(mod) {
  run('UPDATE modules SET enabled = 0, crashed = 0, status_reason = NULL WHERE id = ?', mod.id);
  host.stop(mod.id, 'Stopped: the module was disabled.');
  syncCommands(getModule(mod.id));
}

export function status(mod) {
  if (!mod.enabled) return mod.crashed ? 'crashed' : 'disabled';
  return host.statusOf(mod.id) ?? 'starting';
}

// at server start: every module is wired up, the enabled ones run
export function startModules() {
  for (const mod of allModules()) {
    register(mod);
    if (mod.enabled) { syncMembership(mod); syncCommands(mod); host.start(mod); }
  }
  process.on('exit', host.stopAll); // on a signal the children see their stdin close and exit by themselves
}

export const systemLog = (id, msg) => addLog(id, 'system', msg);
