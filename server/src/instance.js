// Instance-wide settings (v6 admin), the "Cillhub System" account, the admin audit log and the recent-error buffer
import { randomBytes, createHmac } from 'node:crypto';
import { snowflake } from './snowflake.js';
import { get, all, run, json } from './db.js';

const MIB = 1024 * 1024;
export const DEFAULTS = {
  registration_mode: 'open', // open | invite | closed
  instance_name: 'Cillhub',
  motd: null,
  max_upload_bytes: 25 * MIB,
  gifs_enabled: true,
  voice_backend: null, // null = VOICE_BACKEND from the environment
  announcement: null, // {id, content, created_at}
};
export const UPLOAD_RANGE = [1 * MIB, 100 * MIB];

const cache = new Map();
export function setting(key) {
  if (!cache.has(key)) cache.set(key, json(get('SELECT value FROM instance_settings WHERE key = ?', key)?.value, DEFAULTS[key] ?? null));
  return cache.get(key);
}
export function setSetting(key, value) {
  run('INSERT INTO instance_settings (key, value) VALUES (?, ?) ON CONFLICT DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  cache.set(key, value);
}

export const maxUpload = () => setting('max_upload_bytes');

// what everyone (also logged-out visitors) may see: GET /instance, READY.instance, INSTANCE_SETTINGS_UPDATE
export const publicInstance = () => ({
  name: setting('instance_name'), motd: setting('motd'), registration_mode: setting('registration_mode'),
  gifs_enabled: setting('gifs_enabled'), max_upload_bytes: maxUpload(), announcement: setting('announcement'),
});

// the account announcements are DMed from; created on first use, cannot log in (random password, system flag)
export function systemUser() {
  const id = setting('system_user_id');
  const u = id && get('SELECT * FROM users WHERE id = ?', id);
  if (u) return u;
  const nid = snowflake();
  let name = 'cillhub-system';
  for (let i = 2; get('SELECT 1 FROM users WHERE username = ?', name); i++) name = `cillhub-system-${i}`;
  run(`INSERT INTO users (id, email, username, global_name, password_hash, salt, system) VALUES (?, ?, ?, 'Cillhub System', ?, ?, 1)`,
    nid, `system-${nid}@users.invalid`, name, randomBytes(64).toString('hex'), randomBytes(16).toString('hex'));
  setSetting('system_user_id', nid);
  return get('SELECT * FROM users WHERE id = ?', nid);
}

// IPs are stored only as a keyed hash (the key never leaves the database)
function ipHash(ip) {
  if (!ip) return null;
  let key = setting('audit_ip_key');
  if (!key) setSetting('audit_ip_key', key = randomBytes(32).toString('hex'));
  return createHmac('sha256', key).update(String(ip)).digest('hex').slice(0, 32);
}

export function adminAudit({ adminId = null, action, targetType = null, targetId = null, details = null, ip = null }) {
  run(`INSERT INTO admin_audit_log (id, admin_id, action, target_type, target_id, details, ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, snowflake(), adminId, action, targetType, targetId,
  details == null ? null : JSON.stringify(details), ipHash(ip), Date.now());
}

export const adminAuditObj = r => ({
  id: r.id, admin_id: r.admin_id, action: r.action, target_type: r.target_type, target_id: r.target_id,
  details: json(r.details), ip_hash: r.ip_hash, created_at: new Date(r.created_at).toISOString(),
});
export const instanceAdmins = () => all('SELECT id FROM users WHERE instance_admin = 1 AND deleted = 0').map(r => r.id);

// --- recent server errors for the dashboard: console.error is mirrored into a ring buffer, secrets scrubbed ------------
const errors = [];
const SECRETS = [
  [/(authorization|bearer|bot|token|secret|password|key|ticket|code)(["'\s:=]+)[^\s"',}]+/gi, '$1$2[redacted]'],
  [/[A-Za-z0-9_-]{32,}/g, '[redacted]'], // tokens, hashes, keys
  [/https?:\/\/[^\s"']+/g, '[url]'], // push endpoints and webhook URLs are capabilities
];
export const scrub = text => SECRETS.reduce((t, [re, to]) => t.replace(re, to), String(text));
const original = console.error.bind(console);
console.error = (...args) => {
  original(...args);
  const text = args.map(a => (a instanceof Error ? `${a.name}: ${a.message}\n${(a.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(a))).join(' ');
  errors.push({ at: new Date().toISOString(), message: scrub(text).slice(0, 1000) });
  if (errors.length > 50) errors.shift();
};
export const recentErrors = () => [...errors].reverse();
export const startedAt = Date.now();
