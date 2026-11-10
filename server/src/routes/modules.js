// v8 modules: the admin REST API (CONTRACT-v8 §2), UI requests from panels (§6.4), and the two public paths outside
// /api: panel files (§6.3) and HTTP endpoints (§7). Admin routes go through requireAdmin and the admin audit log;
// install, update and remove also need a fresh MFA elevation.
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, renameSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { snowflake } from '../snowflake.js';
import { get, all, run, tx, isMember, userById, userObj } from '../db.js';
import { HttpError, invalid, notFound, missingAccess, bool, snowflakes, intParam, idParam, rateLimited, str } from '../errors.js';
import { channelPerms, guildPerms, P, has as hasBits } from '../permissions.js';
import { requireMfa } from '../mfa.js';
import { saveImage, removeImage } from '../files.js';
import { APP_FLAGS } from '../intents.js';
import { anonymize } from './account.js';
import { readManifest } from '../modules/manifest.js';
import { unpack, fetchGit, cleanPath, tooLarge, LIMITS } from '../modules/package.js';
import * as host from '../modules/host.js';
import {
  getModule, allModules, inScope, has, adminSettings, saveSettings, resetGuildSettings, pruneSettings, storageUsed, STORAGE_QUOTA, logs,
  deleteModuleData, hit, addLog,
} from '../modules/store.js';
import { register, unregister, enable, disable, status, syncMembership, syncCommands, syncRoles } from '../modules/registry.js';

const MAX_MODULES = 50;
const STAGE_TTL = 30 * 60 * 1000;
const iso = ms => new Date(ms).toISOString();

// --- the Module object (§2.7) ---------------------------------------------------------------------------------------
export function moduleObj(mod) {
  const m = mod.manifest;
  return {
    id: mod.id, name: m.name, version: m.version, description: m.description, author: m.author, homepage: m.homepage,
    application_id: mod.app_id, icon: userById(mod.app_id)?.avatar ?? null, source: mod.source,
    permissions: m.permissions, http_hosts: m.http_hosts, enabled: !!mod.enabled, status: status(mod), status_reason: mod.crashed ? mod.status_reason : null,
    scope: mod.scope, guild_ids: mod.guild_ids, per_server_settings: !!mod.per_server_settings,
    settings_schema: m.settings, settings: adminSettings(mod),
    commands: m.commands.map(c => ({ name: c.name, type: c.type, description: c.description })),
    panels: m.ui.panels.map(p => ({ id: p.id, slot: p.slot, title: p.title, icon: p.icon, height: p.height })),
    http_url: m.permissions.includes('http.routes') ? `/modules/${mod.id}/http/` : null,
    storage: { used_bytes: storageUsed(mod.id), quota_bytes: STORAGE_QUOTA },
    stats: host.stats(mod.id), installed_at: iso(mod.installed_at), updated_at: iso(mod.updated_at),
  };
}

function loadModule(id) {
  const mod = getModule(id);
  if (!mod) throw notFound(10090, 'Module');
  return mod;
}

// --- staging (§2.1, §2.2): in memory for 30 minutes; staged files never run ------------------------------------------
// shortcut: staged packages live in memory (at most 10, 20 MiB each); move them to disk if admins stage many at once
const staged = new Map(); // package_id -> {files, manifest, source, update_of, expires}
function sweep() {
  const now = Date.now();
  for (const [k, p] of staged) if (p.expires <= now) staged.delete(k);
  while (staged.size >= 10) staged.delete(staged.keys().next().value);
}
function stagedPackage(body) {
  const p = typeof body?.package_id === 'string' && staged.get(body.package_id);
  if (!p || p.expires <= Date.now()) throw notFound(10091, 'Module Package');
  return p;
}

const semver = v => { const [, a, b, c, pre] = /^(\d+)\.(\d+)\.(\d+)(-.*)?$/.exec(v); return [Number(a), Number(b), Number(c), pre ? 0 : 1]; };
const newer = (a, b) => { const x = semver(a), y = semver(b); for (let i = 0; i < 4; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
const diff = (from, to) => [to.filter(x => !from.includes(x)), from.filter(x => !to.includes(x))];

async function stage(ctx) {
  let files, source, moduleId = null;
  if (ctx.form) {
    const form = await ctx.form({ maxFile: LIMITS.archive });
    const file = form.get('file');
    if (!file || typeof file === 'string') throw invalid('file', 'MODULE_PACKAGE_INVALID', 'Send the archive as the file part "file".');
    if (file.size > LIMITS.archive) throw tooLarge('The archive is larger than 5 MiB.');
    moduleId = typeof form.get('module_id') === 'string' ? form.get('module_id') : null;
    files = unpack(await file.bytes());
    source = { type: 'file', filename: String(file.name ?? '').replace(/[^\w.@+-]+/g, '_').slice(-200) || null, git_url: null, git_ref: null, commit: null };
  } else {
    const body = ctx.body ?? {};
    moduleId = body.module_id ?? null;
    let { git_url: gitUrl, git_ref: gitRef = null } = body;
    if (gitUrl == null) {
      if (moduleId == null) throw invalid('file', 'MODULE_PACKAGE_INVALID', 'Send a file, a git_url, or the module_id of a module installed from Git.');
      const mod = loadModule(String(moduleId));
      if (mod.source.type !== 'git') throw invalid('module_id', 'MODULE_GIT_REFUSED', 'This module was not installed from Git; send a new file.');
      ({ git_url: gitUrl, git_ref: gitRef } = mod.source);
    }
    const { files: f, commit } = await fetchGit(gitUrl, gitRef);
    files = f;
    source = { type: 'git', filename: null, git_url: gitUrl, git_ref: gitRef ?? null, commit };
  }
  const manifest = readManifest(files);
  let update_of = null;
  const warnings = [];
  if (moduleId != null) {
    const mod = loadModule(String(moduleId));
    if (manifest.id !== mod.id) throw invalid('module_id', 'MODULE_ID_MISMATCH', `The package is module ${manifest.id}, not ${mod.id}.`);
    const [addedP, removedP] = diff(mod.manifest.permissions, manifest.permissions);
    const [addedH, removedH] = diff(mod.manifest.http_hosts, manifest.http_hosts);
    update_of = { module_id: mod.id, from_version: mod.manifest.version, added_permissions: addedP, removed_permissions: removedP, added_http_hosts: addedH, removed_http_hosts: removedH };
    if (!newer(manifest.version, mod.manifest.version)) warnings.push(`The version is not higher than the installed ${mod.manifest.version}.`);
  } else if (getModule(manifest.id)) throw invalid('id', 'MODULE_ID_TAKEN', `A module with the id ${manifest.id} is already installed.`);
  sweep();
  const packageId = randomBytes(16).toString('hex');
  const expires = Date.now() + STAGE_TTL;
  staged.set(packageId, { files, manifest, source, update_of, expires });
  const size = [...files.values()].reduce((n, b) => n + b.length, 0);
  ctx.status = 201;
  ctx.audit = { action: 'module.package', target_type: 'module', target_id: manifest.id, details: { package_id: packageId, version: manifest.version, source: source.type, update: !!update_of } };
  return {
    package_id: packageId, expires_at: iso(expires), source, manifest, permissions: manifest.permissions, http_hosts: manifest.http_hosts,
    files: files.size, size, update_of, warnings,
  };
}

// all or nothing: exactly the package's permissions and hosts, as sets
function checkApproval(approve, manifest) {
  const same = (a, b) => Array.isArray(a) && a.every(x => typeof x === 'string') && new Set(a).size === b.length && b.every(x => a.includes(x));
  if (!approve || !same(approve.permissions, manifest.permissions) || !same(approve.http_hosts ?? [], manifest.http_hosts)) {
    throw invalid('approve', 'MODULE_PERMISSIONS_NOT_APPROVED', 'Approve exactly the permissions and hosts the package declares.');
  }
}

// the package files under DATA_DIR/modules/<id>/, replaced as a whole
function writeFiles(id, files) {
  const tmp = join(host.FILES, `.${id}-${randomBytes(6).toString('hex')}`);
  for (const [p, data] of files) {
    mkdirSync(dirname(join(tmp, p)), { recursive: true });
    writeFileSync(join(tmp, p), data);
  }
  const old = join(host.FILES, `.${id}-old-${randomBytes(6).toString('hex')}`);
  try { renameSync(join(host.FILES, id), old); } catch { /* first install */ }
  renameSync(tmp, join(host.FILES, id));
  rmSync(old, { recursive: true, force: true });
}

const MIME = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', webp: 'image/webp' };
const iconUri = (manifest, files) => {
  if (!manifest.icon) return null;
  const b = files.get(manifest.icon);
  const type = b[0] === 0x89 ? 'png' : b[0] === 0xff ? 'jpeg' : 'webp';
  return `data:${MIME[type]};base64,${b.toString('base64')}`;
};
const appFlags = manifest => (manifest.permissions.includes('messages.read') ? APP_FLAGS.GATEWAY_MESSAGE_CONTENT_LIMITED : 0)
  | (manifest.permissions.includes('members.read') ? APP_FLAGS.GATEWAY_GUILD_MEMBERS_LIMITED : 0);

async function install(ctx) {
  const p = stagedPackage(ctx.body);
  const { manifest } = p;
  if (p.update_of || getModule(manifest.id)) throw invalid('id', 'MODULE_ID_TAKEN', `A module with the id ${manifest.id} is already installed.`);
  checkApproval(ctx.body.approve, manifest);
  if (get('SELECT COUNT(*) AS n FROM modules').n >= MAX_MODULES) throw invalid('package_id', 'MODULE_LIMIT_REACHED', `At most ${MAX_MODULES} modules per instance.`);
  requireMfa(ctx);
  staged.delete(ctx.body.package_id);
  mkdirSync(host.FILES, { recursive: true });
  writeFiles(manifest.id, p.files);
  const id = snowflake();
  const avatar = await saveImage(iconUri(manifest, p.files), 'icon', 'avatars', id);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  let username = manifest.id;
  for (let n = 2; get('SELECT 1 FROM users WHERE username = ?', username); n++) username = `${manifest.id}-${n}`;
  const now = Date.now();
  tx(() => {
    run('INSERT INTO users (id, email, username, global_name, avatar, password_hash, salt, bot, module) VALUES (?, ?, ?, ?, ?, ?, ?, 1, 1)',
      id, `bot-${id}@bots.invalid`, username, manifest.name, avatar, randomBytes(32).toString('hex'), randomBytes(16).toString('hex'));
    // owned by its own bot and not public: nobody manages it, installs it by OAuth or gets a token for it
    run('INSERT INTO applications (id, owner_id, name, description, flags, bot_public, public_key, private_key) VALUES (?, ?, ?, ?, ?, 0, ?, ?)',
      id, id, manifest.name.slice(0, 100), manifest.description ?? '', appFlags(manifest),
      Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex'), privateKey.export({ type: 'pkcs8', format: 'pem' }));
    run('INSERT INTO modules (id, app_id, manifest, source, installed_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', manifest.id, id, JSON.stringify(manifest), JSON.stringify(p.source), now, now);
  });
  const mod = getModule(manifest.id);
  register(mod);
  addLog(mod.id, 'system', `Installed version ${manifest.version}.`);
  ctx.status = 201;
  ctx.audit = { action: 'module.install', target_type: 'module', target_id: mod.id, details: { id: mod.id, version: manifest.version, permissions: manifest.permissions, http_hosts: manifest.http_hosts } };
  return moduleObj(mod);
}

async function upgrade(ctx) {
  const mod = loadModule(ctx.params.module_id);
  const p = stagedPackage(ctx.body);
  if (p.update_of?.module_id !== mod.id) throw invalid('package_id', 'MODULE_ID_MISMATCH', 'This package was not staged as an update of this module.');
  checkApproval(ctx.body.approve, p.manifest);
  requireMfa(ctx);
  staged.delete(ctx.body.package_id);
  const { manifest } = p;
  writeFiles(mod.id, p.files);
  const bot = userById(mod.app_id);
  const avatar = await saveImage(iconUri(manifest, p.files), 'icon', 'avatars', mod.app_id);
  tx(() => {
    run('UPDATE modules SET manifest = ?, source = ?, updated_at = ? WHERE id = ?', JSON.stringify(manifest), JSON.stringify(p.source), Date.now(), mod.id);
    run('UPDATE applications SET name = ?, description = ?, flags = ? WHERE id = ?', manifest.name.slice(0, 100), manifest.description ?? '', appFlags(manifest), mod.app_id);
    run('UPDATE users SET global_name = ?, avatar = ? WHERE id = ?', manifest.name, avatar, mod.app_id);
  });
  removeImage('avatars', mod.app_id, bot.avatar);
  pruneSettings(mod.id, mod.manifest.settings, manifest.settings);
  const fresh = getModule(mod.id);
  syncRoles(fresh);
  syncCommands(fresh);
  addLog(mod.id, 'system', `Updated from ${mod.manifest.version} to ${manifest.version}.`);
  if (fresh.enabled) host.restart(fresh);
  ctx.audit = { action: 'module.upgrade', target_type: 'module', target_id: mod.id, details: { from: mod.manifest.version, to: manifest.version, added_permissions: p.update_of.added_permissions } };
  return moduleObj(getModule(mod.id));
}

function removeModule(ctx) {
  const mod = loadModule(ctx.params.module_id);
  if (ctx.body?.confirm !== mod.id) throw invalid('confirm', 'CONFIRMATION_MISMATCH', 'Type the module id to confirm.');
  const keepData = bool(ctx.body, 'keep_data');
  requireMfa(ctx);
  host.stop(mod.id);
  unregister(mod);
  host.forget(mod.id);
  // the application first (its commands go with it), then the bot leaves every server and becomes a deleted user
  run('DELETE FROM applications WHERE id = ?', mod.app_id);
  anonymize(mod.app_id);
  deleteModuleData(mod.id, keepData);
  rmSync(join(host.FILES, mod.id), { recursive: true, force: true });
  syncMembership({ ...mod, enabled: 0, scope: 'guilds', guild_ids: [] }); // panels of its former servers update
  ctx.audit = { action: 'module.remove', target_type: 'module', target_id: mod.id, details: { keep_data: keepData } };
}

function patchModule(ctx) {
  const mod = loadModule(ctx.params.module_id);
  const body = ctx.body ?? {};
  const next = {};
  if (body.scope !== undefined) {
    if (body.scope !== 'all' && body.scope !== 'guilds') throw invalid('scope', 'BASE_TYPE_CHOICES', 'Must be all or guilds.');
    next.scope = body.scope;
  }
  if (body.guild_ids !== undefined) {
    const ids = snowflakes(body, 'guild_ids', 500);
    const missing = ids.find(g => !get('SELECT 1 FROM guilds WHERE id = ?', g));
    if (missing) throw invalid('guild_ids', 'BASE_TYPE_INVALID', `Unknown server ${missing}.`);
    next.guild_ids = JSON.stringify(ids);
  }
  if (body.per_server_settings !== undefined) next.per_server_settings = Number(bool(body, 'per_server_settings'));
  const enabled = body.enabled === undefined ? undefined : bool(body, 'enabled');
  for (const [k, v] of Object.entries(next)) run(`UPDATE modules SET ${k} = ?, updated_at = ? WHERE id = ?`, v, Date.now(), mod.id); // keys are fixed above
  // saving the server list brings the bot back where it was removed, and makes it leave servers outside the scope
  if ('scope' in next || 'guild_ids' in next) syncMembership(getModule(mod.id));
  if ('per_server_settings' in next && host.statusOf(mod.id)) host.emit(mod.id, 'SETTINGS_UPDATE', { guild_id: null });
  if (enabled === true && !mod.enabled) enable(getModule(mod.id));
  if (enabled === false && (mod.enabled || mod.crashed)) disable(getModule(mod.id));
  const onlyEnabled = enabled !== undefined && !Object.keys(next).length;
  ctx.audit = {
    action: onlyEnabled ? (enabled ? 'module.enable' : 'module.disable') : 'module.update_config', target_type: 'module', target_id: mod.id,
    details: { ...(enabled !== undefined && { enabled }), ...('scope' in next && { scope: next.scope }), ...('guild_ids' in next && { guild_ids: JSON.parse(next.guild_ids) }), ...('per_server_settings' in next && { per_server_settings: !!next.per_server_settings }) },
  };
  return moduleObj(getModule(mod.id));
}

function putSettings(ctx) {
  const mod = loadModule(ctx.params.module_id);
  const keys = saveSettings(mod, ctx.body?.values);
  if (host.statusOf(mod.id)) host.emit(mod.id, 'SETTINGS_UPDATE', { guild_id: null });
  ctx.audit = { action: 'module.settings', target_type: 'module', target_id: mod.id, details: { keys } }; // keys only: secrets never reach the audit log
  return moduleObj(getModule(mod.id));
}

function guildScope(ctx) {
  const mod = loadModule(ctx.params.module_id);
  const g = ctx.params.guild_id;
  if (!get('SELECT 1 FROM guilds WHERE id = ?', g)) throw notFound(10004, 'Guild');
  if (!inScope(mod, g)) throw invalid('guild_id', 'MODULE_SETTING_INVALID', 'The server is not in the module\'s scope.');
  return [mod, g];
}
function putGuildSettings(ctx) {
  const [mod, g] = guildScope(ctx);
  if (!mod.per_server_settings) throw invalid('per_server_settings', 'MODULE_SETTING_INVALID', 'Per-server settings are off for this module.');
  const keys = saveSettings(mod, ctx.body?.values, g);
  if (host.statusOf(mod.id)) host.emit(mod.id, 'SETTINGS_UPDATE', { guild_id: g });
  ctx.audit = { action: 'module.guild_settings', target_type: 'module', target_id: mod.id, details: { guild_id: g, keys } };
  return { guild_id: g, values: adminSettings(mod, g) };
}
function resetGuild(ctx) {
  const [mod, g] = guildScope(ctx);
  resetGuildSettings(mod.id, g);
  if (host.statusOf(mod.id)) host.emit(mod.id, 'SETTINGS_UPDATE', { guild_id: g });
  ctx.audit = { action: 'module.guild_settings_reset', target_type: 'module', target_id: mod.id, details: { guild_id: g } };
}

function restartModule(ctx) {
  const mod = loadModule(ctx.params.module_id);
  if (!mod.enabled) throw new HttpError(400, 0, mod.crashed ? 'The module was disabled after crashes; enable it again.' : 'The module is disabled.');
  addLog(mod.id, 'system', 'Restart requested by an admin.');
  host.restart(mod);
  ctx.audit = { action: 'module.restart', target_type: 'module', target_id: mod.id };
  return moduleObj(getModule(mod.id));
}

// --- UI requests from panels (§6.4) ---------------------------------------------------------------------------------
// JSON.parse accepts nesting far deeper than JSON.stringify (or the sandbox) can handle
const tooDeep = (v, d = 0) => d > 32 || (v !== null && typeof v === 'object' && Object.values(v).some(x => tooDeep(x, d + 1)));

async function uiRequest(ctx) {
  const { user } = ctx;
  const mod = getModule(ctx.params.module_id);
  if (!mod || !has(mod, 'ui')) throw notFound(10090, 'Module');
  const wait = hit(`ui-req:${mod.id}:${user.id}`, 20, 10_000);
  if (wait) throw rateLimited(wait);
  const body = ctx.body ?? {};
  if (tooDeep(body.data)) throw invalid('data', 'BASE_TYPE_INVALID', 'The data is nested too deeply.');
  const panel = mod.manifest.ui.panels.find(p => p.id === body.panel_id);
  if (!panel) throw invalid('panel_id', 'BASE_TYPE_INVALID', 'Unknown panel.');
  const g = String(body.guild_id ?? '');
  if (!mod.enabled || !inScope(mod, g) || !isMember(g, mod.app_id) || !isMember(g, user.id)) throw missingAccess();
  let ch = null;
  if (body.channel_id != null) {
    ch = get('SELECT * FROM channels WHERE id = ? AND guild_id = ?', String(body.channel_id), g);
    if (!ch) throw notFound(10003, 'Channel');
    if (!hasBits(channelPerms(ch, user.id), P.VIEW_CHANNEL) || !hasBits(channelPerms(ch, mod.app_id), P.VIEW_CHANNEL)) throw missingAccess();
  }
  let messageId = null;
  if (body.message_id != null) {
    const ok = ch && get(`SELECT 1 FROM messages m JOIN module_message_panels p ON p.message_id = m.id
                          WHERE m.id = ? AND m.channel_id = ? AND m.author_id = ? AND p.module_id = ? AND p.panel_id = ?`, String(body.message_id), ch.id, mod.app_id, mod.id, panel.id);
    if (!ok) throw notFound(10008, 'Message');
    messageId = String(body.message_id);
  }
  if (!host.isRunning(mod.id)) throw new HttpError(503, 0, 'The module is not running.');
  const roles = all('SELECT role_id FROM member_roles WHERE guild_id = ? AND user_id = ?', g, user.id).map(r => r.role_id);
  const r = await host.request(mod.id, 'UI_REQUEST', {
    panel_id: panel.id, slot: panel.slot, guild_id: g, channel_id: ch?.id ?? null, message_id: messageId, user: userObj(user),
    member: { roles, permissions: String(ch ? channelPerms(ch, user.id) : guildPerms(g, user.id)) }, data: body.data ?? null,
  }, 5000);
  if (r.timeout) throw new HttpError(504, 0, 'The module did not answer in time.');
  if (!r.ok) {
    if (r.error?.code === 'UNAVAILABLE') throw new HttpError(503, 0, 'The module is not running.');
    throw new HttpError(502, 0, String(r.error?.message ?? 'The module failed.').slice(0, 200));
  }
  if (Buffer.byteLength(JSON.stringify(r.result ?? null)) > 64 * 1024) throw new HttpError(502, 0, 'The module\'s answer is larger than 64 KiB.');
  return { data: r.result ?? null };
}

const CATALOG_MODULES = [
  {
    id: 'welcome-roles',
    name: 'Welcome Roles',
    version: '1.0.0',
    description: 'Greets new members in a channel and gives them a role.',
    author: 'Cillhub Official',
    verified: true,
    icon: null,
    permissions: ['members.read', 'messages.send', 'roles.manage'],
    http_hosts: [],
    example_path: 'welcome-roles',
  },
  {
    id: 'twitch-live',
    name: 'Twitch Live Notifier',
    version: '1.0.0',
    description: 'Broadcasts when a Twitch streamer goes live.',
    author: 'Cillhub Official',
    verified: true,
    icon: null,
    permissions: ['messages.send'],
    http_hosts: ['api.twitch.tv'],
    example_path: 'twitch-live',
  },
  {
    id: 'scrim-board',
    name: 'Scrim Board',
    version: '1.0.0',
    description: 'Interactive scrimmage queue and team management dashboard.',
    author: 'Cillhub Official',
    verified: true,
    icon: null,
    permissions: ['commands', 'storage', 'ui', 'messages.send'],
    http_hosts: [],
    example_path: 'scrim-board',
  },
  {
    id: 'cill-chess',
    name: 'Chess Arena',
    version: '1.0.0',
    description: 'Play live multiplayer Chess with full legal move validation, open matchmaking, and server ELO rankings.',
    author: 'Cillhub Official',
    verified: true,
    icon: '♟️',
    permissions: ['commands', 'storage', 'ui', 'messages.send'],
    http_hosts: [],
    example_path: 'cill-chess',
  },
  {
    id: 'word-duel',
    name: 'Word Duel',
    version: '1.0.0',
    description: 'Daily server word puzzle and real-time multiplayer 5-letter speed duels with live opponent tile progress.',
    author: 'Cillhub Official',
    verified: true,
    icon: '🔤',
    permissions: ['commands', 'storage', 'ui'],
    http_hosts: [],
    example_path: 'word-duel',
  },
  {
    id: 'trivia-royale',
    name: 'Trivia Royale',
    version: '1.0.0',
    description: 'Fast-paced multiplayer trivia rounds with speed bonuses, custom server questions, and automatic champion roles.',
    author: 'Cillhub Official',
    verified: true,
    icon: '🧠',
    permissions: ['commands', 'storage', 'ui', 'messages.send', 'roles.manage'],
    http_hosts: [],
    example_path: 'trivia-royale',
  },
  {
    id: 'lfg-party-finder',
    name: 'LFG Party Finder',
    version: '1.0.0',
    description: 'Create and join gaming squads with live voice presence indicators and automatic ready-up alerts.',
    author: 'Cillhub Official',
    verified: true,
    icon: '🎮',
    permissions: ['commands', 'storage', 'ui', 'voice.read', 'messages.send'],
    http_hosts: [],
    example_path: 'lfg-party-finder',
  },
  {
    id: 'ticket-desk',
    name: 'Support Ticket Desk',
    version: '1.0.0',
    description: 'Structured support ticket and modmail desk with staff claiming, categories, and log channel summaries.',
    author: 'Cillhub Official',
    verified: true,
    icon: '🎫',
    permissions: ['commands', 'storage', 'ui', 'messages.send'],
    http_hosts: [],
    example_path: 'ticket-desk',
  },
  {
    id: 'xp-levels',
    name: 'XP & Level Rewards',
    version: '1.0.0',
    description: 'Community activity XP and level system with voice XP rewards, milestone roles, and interactive rank cards.',
    author: 'Cillhub Official',
    verified: true,
    icon: '⭐',
    permissions: ['commands', 'storage', 'ui', 'messages.read', 'messages.send', 'voice.read', 'roles.manage', 'schedule'],
    http_hosts: [],
    example_path: 'xp-levels',
  },
  {
    id: 'jukebox-queue',
    name: 'Jukebox & Watch Queue',
    version: '1.0.0',
    description: 'Collaborative media and watch-party queue where members submit and upvote tracks.',
    author: 'Cillhub Official',
    verified: true,
    icon: '🎵',
    permissions: ['commands', 'storage', 'ui', 'messages.send'],
    http_hosts: [],
    example_path: 'jukebox-queue',
  },
  {
    id: 'cubecoders-amp',
    name: 'CubeCoders AMP Control Center',
    version: '1.0.0',
    description: 'Manage CubeCoders AMP game server instances: live CPU/RAM/TPS telemetry, player wake-on-demand, RCON console, and alerts.',
    author: 'Cillhub Official',
    verified: true,
    icon: '🖥️',
    permissions: ['commands', 'storage', 'ui', 'http.fetch', 'http.routes', 'messages.send', 'schedule'],
    http_hosts: ['amp.cillerian.org', '*.cillerian.org', 'amp.example.com'],
    example_path: 'cubecoders-amp',
  },
  {
    id: 'server-status-monitor',
    name: 'Uptime & Latency Monitor',
    version: '1.0.0',
    description: 'Monitor HTTP/HTTPS endpoints with rolling 30-sample uptime history, latency sparklines, and automatic outage alerts.',
    author: 'Cillhub Official',
    verified: true,
    icon: '📡',
    permissions: ['commands', 'storage', 'ui', 'http.fetch', 'messages.send', 'schedule'],
    http_hosts: ['*.cillerian.org', 'cillhub.cillerian.org', 'example.com'],
    example_path: 'server-status-monitor',
  },
  {
    id: 'tournament-brackets',
    name: 'Tournament Brackets',
    version: '1.0.0',
    description: 'Host single-elimination and round-robin tournaments with visual bracket trees, seeding, score reporting, and champion roles.',
    author: 'Cillhub Official',
    verified: true,
    icon: '🏆',
    permissions: ['commands', 'storage', 'ui', 'messages.send', 'roles.manage'],
    http_hosts: [],
    example_path: 'tournament-brackets',
  },
];

function getCatalog() {
  return CATALOG_MODULES;
}

function catalogInstall(ctx) {
  const moduleId = str(ctx.body ?? {}, 'module_id', 1, 64);
  const entry = CATALOG_MODULES.find(m => m.id === moduleId);
  if (!entry) throw notFound(10013, `Module ${moduleId} not found in catalog.`);

  const dir = join(new URL('../../..', import.meta.url).pathname, 'examples', 'modules', entry.example_path);
  if (!existsSync(dir)) throw notFound(10013, `Module package files not found.`);

  const files = new Map();
  function readRec(d, prefix = '') {
    for (const f of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, f.name);
      const rel = prefix ? `${prefix}/${f.name}` : f.name;
      if (f.isDirectory()) readRec(p, rel);
      else if (f.isFile()) files.set(rel, readFileSync(p));
    }
  }
  readRec(dir);
  const manifest = readManifest(files);
  if (getModule(manifest.id)) throw invalid('id', 'MODULE_ID_TAKEN', `A module with the id ${manifest.id} is already installed.`);

  sweep();
  const packageId = randomBytes(16).toString('hex');
  const expires = Date.now() + STAGE_TTL;
  const source = { type: 'catalog', filename: null, git_url: null, git_ref: null, commit: null };
  staged.set(packageId, { files, manifest, source, update_of: null, expires });
  const size = [...files.values()].reduce((n, b) => n + b.length, 0);

  ctx.status = 201;
  ctx.audit = { action: 'module.package', target_type: 'module', target_id: manifest.id, details: { package_id: packageId, version: manifest.version, source: 'catalog', update: false } };
  return {
    package_id: packageId, expires_at: iso(expires), source, manifest, permissions: manifest.permissions, http_hosts: manifest.http_hosts,
    files: files.size, size, update_of: null, warnings: [],
  };
}

const admin = { admin: true, userOnly: true };
export default [
  ['GET', '/admin/modules', () => allModules().map(moduleObj), admin],
  ['GET', '/admin/modules/catalog', getCatalog, admin],
  ['POST', '/admin/modules/install-from-catalog', catalogInstall, admin],
  ['GET', '/federation/modules', getCatalog, { open: true }],
  ['POST', '/admin/modules/packages', stage, { ...admin, multipart: true }],
  ['POST', '/admin/modules', install, admin],
  ['GET', '/admin/modules/:module_id', ctx => moduleObj(loadModule(ctx.params.module_id)), admin],
  ['PATCH', '/admin/modules/:module_id', patchModule, admin],
  ['DELETE', '/admin/modules/:module_id', removeModule, admin],
  ['PUT', '/admin/modules/:module_id/package', upgrade, admin],
  ['PUT', '/admin/modules/:module_id/settings', putSettings, admin],
  ['GET', '/admin/modules/:module_id/guilds/:guild_id/settings', ctx => { const [mod, g] = guildScope(ctx); return { guild_id: g, values: adminSettings(mod, g) }; }, admin],
  ['PUT', '/admin/modules/:module_id/guilds/:guild_id/settings', putGuildSettings, admin],
  ['DELETE', '/admin/modules/:module_id/guilds/:guild_id/settings', resetGuild, admin],
  ['GET', '/admin/modules/:module_id/logs', ctx => logs(loadModule(ctx.params.module_id).id, intParam(ctx.query, 'limit', 100, 1, 500), idParam(ctx.query, 'before')), admin],
  ['POST', '/admin/modules/:module_id/restart', restartModule, admin],
  ['POST', '/modules/:module_id/ui', uiRequest, { userOnly: true, maxBody: 64 * 1024 }],
];

// --- public paths: /modules/<id>/ui/<path> and /modules/<id>/http/<path> ------------------------------------------------
const UI_CSP = "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'";
const UI_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const MODULE_PATH = /^\/modules\/([a-z0-9-]{3,40})\/(ui|http)(\/.*)?$/;
export const isModulePath = pathname => MODULE_PATH.test(pathname);

export async function serveModulePath(req, res, url, ip) {
  const [, id, kind, rest = ''] = MODULE_PATH.exec(url.pathname);
  return kind === 'ui' ? serveUi(req, res, id, rest.slice(1)) : serveHttp(req, res, id, rest || '/', url, ip);
}

async function serveUi(req, res, id, raw) {
  const notFoundAnswer = () => { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }); res.end('Not found'); };
  if (req.method !== 'GET' && req.method !== 'HEAD') return notFoundAnswer();
  const mod = getModule(id);
  let path;
  try { path = cleanPath(decodeURIComponent(raw)); } catch { return notFoundAnswer(); }
  const type = UI_TYPES[path.slice(path.lastIndexOf('.')).toLowerCase()];
  const folders = mod?.manifest.ui.panels.map(p => p.entry.slice(0, p.entry.lastIndexOf('/') + 1)) ?? [];
  if (!mod?.enabled || !has(mod, 'ui') || !type || !folders.some(f => path.startsWith(f))) return notFoundAnswer();
  const data = await readFile(join(host.FILES, mod.id, path)).catch(() => null);
  if (!data) return notFoundAnswer();
  res.writeHead(200, {
    'Content-Type': type, 'Content-Length': data.length, 'Content-Security-Policy': UI_CSP, 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-cache', 'Referrer-Policy': 'no-referrer', 'Access-Control-Allow-Origin': '*',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
}

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'];
const DROPPED = new Set(['cookie', 'authorization', 'proxy-authorization', 'x-real-ip', 'x-forwarded-for', 'x-cillhub-mfa-authorization']);
const keptHeader = k => ['content-type', 'cache-control', 'location', 'etag', 'last-modified'].includes(k) || (k.startsWith('x-') && k !== 'x-frame-options' && k !== 'x-content-type-options');
const HTTP_SAFE = { 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" };

async function readLimited(req, max) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size <= max) chunks.push(c); } // drain past the limit so 413 can be sent
  return size > max ? null : Buffer.concat(chunks);
}

// no session, user or token is resolved here; every answer carries nosniff and the sandbox CSP
async function serveHttp(req, res, id, path, url, ip) {
  const answer = (status, body = '', headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers, ...HTTP_SAFE });
    res.end(req.method === 'HEAD' || status === 204 || status === 304 ? undefined : body);
  };
  try {
    const mod = getModule(id);
    if (!mod || !has(mod, 'http.routes')) { req.resume(); return answer(404, 'Not found'); }
    if (!HTTP_METHODS.includes(req.method)) { req.resume(); return answer(405, 'Method not allowed', { Allow: HTTP_METHODS.join(', ') }); }
    if (!host.isRunning(mod.id)) { req.resume(); return answer(503, 'The module is not running'); }
    // per IP first, so one client cannot spend the whole module budget
    const wait = hit(`http-ip:${mod.id}:${ip}`, 30, 60_000) || hit(`http:${mod.id}`, 120, 60_000);
    if (wait) { req.resume(); return answer(429, 'Too many requests', { 'Retry-After': String(Math.ceil(wait)) }); }
    const raw = await readLimited(req, 256 * 1024);
    if (!raw) return answer(413, 'Request body too large');
    let body, encoding = 'utf8';
    try { body = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { body = raw.toString('base64'); encoding = 'base64'; }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!DROPPED.has(k)) headers[k] = Array.isArray(v) ? v.join(', ') : String(v);
    const r = await host.request(mod.id, 'HTTP_REQUEST', { method: req.method, path, query: Object.fromEntries(url.searchParams), headers, body, body_encoding: encoding }, 5000);
    if (r.timeout) return answer(504, 'The module did not answer in time');
    if (!r.ok) return r.error?.code === 'UNAVAILABLE' ? answer(503, 'The module is not running') : answer(502, 'The module failed');
    const out = r.result;
    if (out == null) return answer(204);
    const status = out.status ?? 200;
    if (typeof out !== 'object' || !Number.isInteger(status) || status < 200 || status > 599 || (out.headers != null && typeof out.headers !== 'object')) {
      addLog(mod.id, 'system', 'HTTP_REQUEST: the handler returned no valid {status, headers, body}; answered 502.');
      return answer(502, 'The module failed');
    }
    const headersOut = {};
    for (const [k, v] of Object.entries(out.headers ?? {})) {
      const name = k.toLowerCase();
      if (keptHeader(name) && /^[a-z0-9-]{1,100}$/.test(name) && typeof v === 'string' && v.length <= 8192 && !/[\r\n\0]/.test(v)) headersOut[name] = v;
    }
    // no script gadget on the hub origin and no open redirect: script types become text, only same-origin paths redirect
    if (/script/i.test(headersOut['content-type'] ?? '')) headersOut['content-type'] = 'text/plain; charset=utf-8';
    if (headersOut.location && !/^\/(?![/\\])/.test(headersOut.location)) delete headersOut.location;
    let text = out.body ?? '';
    if (typeof text !== 'string') { text = JSON.stringify(text); headersOut['content-type'] ??= 'application/json'; }
    if (Buffer.byteLength(text) > 1024 * 1024) {
      addLog(mod.id, 'system', 'HTTP_REQUEST: the answer is larger than 1 MiB; answered 502.');
      return answer(502, 'The module failed');
    }
    return answer(status, text, headersOut);
  } catch (e) {
    console.error('module http endpoint failed:', e);
    if (!res.headersSent) answer(500, 'Internal error');
    else res.destroy();
  }
}
