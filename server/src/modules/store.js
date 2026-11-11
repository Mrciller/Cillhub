// Database side of v8 modules: the module rows, settings (global and per server), the key-value storage with its quota,
// the log ring and the schedules. Module code never reaches this file; the server calls it for the module bound to a process.
import { get, all, run, tx, json } from '../db.js';
import { invalid } from '../errors.js';
import { checkValue } from './manifest.js';
import { capKey } from '../ratelimit.js';

export const STORAGE_QUOTA = 5 * 1024 * 1024;
const VALUE_MAX = 64 * 1024;
const LOG_KEEP = 1000;

// an error a module's call rejects with (§4: code, plus status/api_code, errors or retry_after)
export class ModuleError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    Object.assign(this, { code, extra });
  }
}

// --- modules ---------------------------------------------------------------------------------------------------
const parse = r => r && { ...r, manifest: json(r.manifest), source: json(r.source), guild_ids: json(r.guild_ids) };
export const getModule = id => parse(get('SELECT * FROM modules WHERE id = ?', id));
export const moduleByApp = appId => parse(get('SELECT * FROM modules WHERE app_id = ?', appId));
export const allModules = () => all('SELECT * FROM modules ORDER BY installed_at, id').map(parse);
export const enabledModules = () => all('SELECT * FROM modules WHERE enabled = 1').map(parse);
// the servers a module may act in: its scope (all, or the chosen ones)
export const inScope = (mod, guildId) => mod.scope === 'all' || mod.guild_ids.includes(guildId);
export const has = (mod, perm) => mod.manifest.permissions.includes(perm);

// --- settings --------------------------------------------------------------------------------------------------
const settingInvalid = (key, msg) => invalid(`values.${key}`, 'MODULE_SETTING_INVALID', `${key}: ${msg}`);
const stored = (moduleId, guildId) => Object.fromEntries(all('SELECT key, value FROM module_settings WHERE module_id = ? AND guild_id = ?', moduleId, guildId).map(r => [r.key, JSON.parse(r.value)]));

// what the module reads: defaults, the global values, then that server's values when per-server settings are on
export function settingsFor(mod, guildId = null) {
  const out = Object.fromEntries(mod.manifest.settings.map(s => [s.key, s.default]));
  Object.assign(out, pickKnown(mod, stored(mod.id, '')));
  if (guildId && mod.per_server_settings) {
    const own = stored(mod.id, guildId);
    for (const s of mod.manifest.settings) if (s.per_server && Object.hasOwn(own, s.key)) out[s.key] = own[s.key];
  }
  return out;
}
const pickKnown = (mod, values) => Object.fromEntries(Object.entries(values).filter(([k]) => mod.manifest.settings.some(s => s.key === k)));

// what the admin API shows: secrets only as {set}
export function adminSettings(mod, guildId = null) {
  const values = guildId ? pickKnown(mod, stored(mod.id, guildId)) : settingsFor(mod);
  for (const s of mod.manifest.settings) {
    if (s.type === 'secret' && (!guildId || Object.hasOwn(values, s.key))) values[s.key] = { set: values[s.key] != null && values[s.key] !== '' };
  }
  return values;
}

// validates and saves {key: value | null}; null resets to the default (a secret to unset). Returns the changed keys.
export function saveSettings(mod, values, guildId = null) {
  if (typeof values !== 'object' || values === null || Array.isArray(values)) throw invalid('values', 'MODULE_SETTING_INVALID', 'values must be an object.');
  const entries = Object.entries(values);
  if (entries.length > 50) throw invalid('values', 'MODULE_SETTING_INVALID', 'At most 50 values.');
  const guilds = guildId ? [guildId] : mod.scope === 'all' ? null : mod.guild_ids;
  const inGuilds = (table, id, extra = '') => {
    const row = get(`SELECT * FROM ${table} WHERE id = ? ${extra}`, id);
    return row && (!guilds || guilds.includes(row.guild_id)) ? row : null;
  };
  for (const [key, v] of entries) {
    const def = mod.manifest.settings.find(s => s.key === key);
    if (!def) throw settingInvalid(key, 'unknown setting.');
    if (guildId && !def.per_server) throw settingInvalid(key, 'is not a per-server setting.');
    if (v === null || v === '') {
      if (def.required && !guildId) throw settingInvalid(key, 'is required.');
      if (v === null) continue;
    }
    const err = checkValue(def, v);
    if (err) throw settingInvalid(key, err);
    if (def.type === 'channel') {
      const ch = inGuilds('channels', v);
      if (!ch || (def.channel_types && !def.channel_types.includes(ch.type))) throw settingInvalid(key, 'must be a fitting channel of a server of this module.');
    }
    if (def.type === 'role' && !inGuilds('roles', v)) throw settingInvalid(key, 'must be a role of a server of this module.');
    if (def.type === 'user' && !get('SELECT 1 FROM users WHERE id = ? AND deleted = 0', v)) throw settingInvalid(key, 'must be an existing user.');
  }
  tx(() => {
    for (const [key, v] of entries) {
      if (v === null) run('DELETE FROM module_settings WHERE module_id = ? AND guild_id = ? AND key = ?', mod.id, guildId ?? '', key);
      else run('INSERT INTO module_settings (module_id, guild_id, key, value) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value', mod.id, guildId ?? '', key, JSON.stringify(v));
    }
  });
  return entries.map(([k]) => k);
}

export const resetGuildSettings = (moduleId, guildId) => run('DELETE FROM module_settings WHERE module_id = ? AND guild_id = ?', moduleId, guildId);

// after an update: values stay where the key and type still exist
export function pruneSettings(moduleId, oldSchema, newSchema) {
  for (const s of oldSchema) {
    const n = newSchema.find(x => x.key === s.key);
    if (!n || n.type !== s.type) run('DELETE FROM module_settings WHERE module_id = ? AND key = ?', moduleId, s.key);
  }
}

// --- storage (§4.5) ----------------------------------------------------------------------------------------------
const storageKey = key => {
  if (typeof key !== 'string' || key.length < 1 || key.length > 200) throw new ModuleError('INVALID', 'key must be a string of 1-200 characters.');
  return key;
};
export const storageUsed = moduleId => get('SELECT COALESCE(SUM(size), 0) AS n FROM module_storage WHERE module_id = ?', moduleId).n;

export function storageGet(moduleId, key) {
  const r = get('SELECT value FROM module_storage WHERE module_id = ? AND key = ?', moduleId, storageKey(key));
  return r ? JSON.parse(r.value) : null;
}
export function storageSet(moduleId, key, value) {
  storageKey(key);
  const text = JSON.stringify(value);
  if (text === undefined) throw new ModuleError('INVALID', 'value must be JSON.');
  if (Buffer.byteLength(text) > VALUE_MAX) throw new ModuleError('TOO_LARGE', 'value is larger than 64 KiB serialized.');
  const size = Buffer.byteLength(key) + Buffer.byteLength(text);
  tx(() => {
    const others = get('SELECT COALESCE(SUM(size), 0) AS n FROM module_storage WHERE module_id = ? AND key != ?', moduleId, key).n;
    if (others + size > STORAGE_QUOTA) throw new ModuleError('QUOTA_EXCEEDED', 'The storage quota of 5 MiB is used up.');
    run('INSERT INTO module_storage (module_id, key, value, size) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET value = excluded.value, size = excluded.size', moduleId, key, text, size);
  });
  return null;
}
export function storageDelete(moduleId, key) {
  run('DELETE FROM module_storage WHERE module_id = ? AND key = ?', moduleId, storageKey(key));
  return null;
}
export function storageList(moduleId, { prefix = '', after = '', limit = 100 } = {}) {
  if (typeof prefix !== 'string' || prefix.length > 200 || typeof after !== 'string' || after.length > 200) throw new ModuleError('INVALID', 'prefix and after must be strings of at most 200 characters.');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ModuleError('INVALID', 'limit must be 1-100.');
  const rows = all(`SELECT key, value FROM module_storage WHERE module_id = ? AND key > ? AND substr(key, 1, ?) = ? ORDER BY key LIMIT ?`,
    moduleId, after, prefix.length, prefix, limit + 1);
  const items = rows.slice(0, limit).map(r => ({ key: r.key, value: JSON.parse(r.value) }));
  return { items, next: rows.length > limit ? items.at(-1).key : null };
}

// --- logs (§4.4): the latest 1000 lines per module -----------------------------------------------------------------
export const LEVELS = ['debug', 'info', 'warn', 'error', 'system'];
// admins read these, and secret settings are write-only for them: a module that prints one gets it masked
function scrubbed(moduleId, message) {
  const keys = new Set((json(get('SELECT manifest FROM modules WHERE id = ?', moduleId)?.manifest, {}).settings ?? []).filter(s => s.type === 'secret').map(s => s.key));
  const secrets = all('SELECT key, value FROM module_settings WHERE module_id = ?', moduleId)
    .filter(r => keys.has(r.key)).map(r => JSON.parse(r.value)).filter(v => typeof v === 'string' && v.length >= 4);
  return secrets.reduce((t, v) => t.split(v).join('[redacted]'), String(message));
}
export function addLog(moduleId, level, message) {
  const r = run('INSERT INTO module_logs (module_id, at, level, message) VALUES (?, ?, ?, ?)', moduleId, Date.now(), level, scrubbed(moduleId, message).slice(0, 2000));
  run('DELETE FROM module_logs WHERE module_id = ? AND id <= ?', moduleId, Number(r.lastInsertRowid) - LOG_KEEP);
}
export const logs = (moduleId, limit, before) => all(`SELECT * FROM module_logs WHERE module_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
  moduleId, before, before, limit).map(r => ({ id: String(r.id), at: new Date(r.at).toISOString(), level: r.level, message: r.message }));

// --- schedules (§4.7) -------------------------------------------------------------------------------------------
export const schedules = moduleId => all('SELECT name, next_at, interval_ms FROM module_schedules WHERE module_id = ? ORDER BY name', moduleId)
  .map(r => ({ name: r.name, next_at: r.next_at, interval_ms: r.interval_ms ?? null }));
export function setSchedule(moduleId, name, nextAt, intervalMs) {
  if (typeof name !== 'string' || name.length < 1 || name.length > 64) throw new ModuleError('INVALID', 'name must be 1-64 characters.');
  tx(() => {
    const exists = get('SELECT 1 FROM module_schedules WHERE module_id = ? AND name = ?', moduleId, name);
    if (!exists && get('SELECT COUNT(*) AS n FROM module_schedules WHERE module_id = ?', moduleId).n >= 20) throw new ModuleError('QUOTA_EXCEEDED', 'At most 20 schedules per module.');
    run('INSERT INTO module_schedules (module_id, name, next_at, interval_ms) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET next_at = excluded.next_at, interval_ms = excluded.interval_ms',
      moduleId, name, nextAt, intervalMs);
  });
  return null;
}
export const cancelSchedule = (moduleId, name) => { run('DELETE FROM module_schedules WHERE module_id = ? AND name = ?', moduleId, String(name)); return null; };

// a removal: always the code-side state; settings and storage unless they are kept
export function deleteModuleData(moduleId, keepData) {
  tx(() => {
    for (const t of ['module_logs', 'module_schedules', 'module_message_panels']) run(`DELETE FROM ${t} WHERE module_id = ?`, moduleId);
    if (!keepData) for (const t of ['module_settings', 'module_storage']) run(`DELETE FROM ${t} WHERE module_id = ?`, moduleId);
    run('DELETE FROM modules WHERE id = ?', moduleId);
  });
}

// --- sliding windows (in memory) for the module rate limits ---------------------------------------------------------
const windows = new Map();
// 0 when allowed (and counted), else the seconds until a slot frees
export function hit(key, max, ms) {
  const now = Date.now();
  key = capKey(windows, 50_000, w => !w.length || now - w.at(-1) > 3_600_000, key);
  let w = windows.get(key);
  if (!w) windows.set(key, w = []);
  while (w.length && now - w[0] >= ms) w.shift();
  if (w.length >= max) return (w[0] + ms - now) / 1000;
  w.push(now);
  return 0;
}

// module lines: 100 per 10 s, the rest dropped with one note per window
export function moduleLog(moduleId, level, message) {
  if (!hit(`log:${moduleId}`, 100, 10_000)) return addLog(moduleId, level, message);
  if (!hit(`log-note:${moduleId}`, 1, 10_000)) addLog(moduleId, 'system', 'Log limit reached (100 lines per 10 s): further lines are dropped for now.');
}
// refused actions and sandbox output, at level system, with the same cap so a refusal flood cannot flood the log
export function refusalLog(moduleId, message) {
  if (!hit(`refusal:${moduleId}`, 100, 10_000)) return addLog(moduleId, 'system', message);
  if (!hit(`refusal-note:${moduleId}`, 1, 10_000)) addLog(moduleId, 'system', 'Too many refused actions (100 per 10 s): further ones are not logged for now.');
}
