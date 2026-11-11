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
  public_url: null, // origin; null = CILLCORD_PUBLIC_URL, else the request's own (federation.js publicUrl)
  smtp_host: null, smtp_port: 587, smtp_security: 'starttls', smtp_user: null, smtp_password: null, smtp_from: null,
  captcha_site_key: null, captcha_secret: null, // reCAPTCHA v2 checkbox
  // 7.10.3 legal: the operator's own details (every instance fills in its own; nothing is inherited from a hub)
  legal_operator: {}, // {name, legal_form, address, email, phone, register, representatives, purpose, authority, languages}
  min_age: 14, // sign-up asks "I am at least N years old"
  source_url: 'https://github.com/TCCiller/Cillhub', // AGPL §13: where users get the source of the running version
};
// never sent anywhere: the admin API shows only whether they are set
export const SECRET_SETTINGS = ['smtp_password', 'captcha_secret'];
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
export const mailConfigured = () => !!(setting('smtp_host') && setting('smtp_from'));
export const captchaOn = () => !!(setting('captcha_site_key') && setting('captcha_secret'));
// reset links need a configured address: the request's Host header could point them at someone else's server
export const resetAvailable = () => mailConfigured() && hooks.localLoginOpen() && !!hooks.configuredUrl();
// federation.js fills this in (it imports this module, so importing it here would be a cycle)
export const hooks = { localLoginOpen: () => true, configuredUrl: () => null };

// what everyone (also logged-out visitors) may see: GET /instance, READY.instance, INSTANCE_SETTINGS_UPDATE
export const publicInstance = () => ({
  name: setting('instance_name'), motd: setting('motd'), registration_mode: setting('registration_mode'),
  gifs_enabled: setting('gifs_enabled'), max_upload_bytes: maxUpload(), announcement: setting('announcement'),
  password_reset: resetAvailable(),
  captcha: captchaOn() ? { service: 'recaptcha', sitekey: setting('captcha_site_key') } : null,
  legal: legalInfo(),
});

// --- 7.10.3 legal documents: the newest row per doc is current; an empty text means "not provided" --------------------
export const LEGAL_DOCS = ['imprint', 'privacy', 'terms'];
const docCache = new Map();
export function legalDoc(doc) {
  if (!docCache.has(doc)) docCache.set(doc, get('SELECT * FROM legal_documents WHERE doc = ? ORDER BY id DESC LIMIT 1', doc) ?? null);
  return docCache.get(doc);
}
export const forgetLegalDocs = () => docCache.clear();
export const docProvided = doc => !!(legalDoc(doc)?.en.trim() || legalDoc(doc)?.de.trim());
// the version a sign-up accepts: the terms, else the privacy notice (null when neither is provided)
export const acceptVersion = () => (docProvided('terms') ? legalDoc('terms').id : docProvided('privacy') ? legalDoc('privacy').id : null);
// existing accounts below this version must accept again (the newest terms/privacy version saved with "require re-acceptance")
let requiredCache;
export function requiredVersion() {
  requiredCache ??= get("SELECT MAX(id) AS v FROM legal_documents WHERE doc IN ('terms', 'privacy') AND reaccept = 1").v ?? 0;
  return requiredCache;
}
export const forgetRequiredVersion = () => (requiredCache = undefined);
// the account must accept before it can use the API: a new version with re-acceptance, or made without the sign-up checks
export const legalGate = u => !u.bot && !u.system && (!!u.legal_pending || (u.terms_version ?? 0) < requiredVersion());

// public part of the operator details (what an imprint shows anyway); contact = DSA Art. 11/12 single point of contact
export function legalInfo() {
  const o = setting('legal_operator') ?? {};
  return {
    imprint: docProvided('imprint'), privacy: docProvided('privacy'), terms: docProvided('terms'), accept_version: acceptVersion(),
    operator_name: o.name || null, contact_email: o.email || null, contact_languages: o.languages || null,
    min_age: setting('min_age'), source_url: setting('source_url'),
  };
}

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
// the SMTP password and captcha secret by value first: an SMTP error may quote a short password the patterns miss
const secretValues = () => {
  try { return SECRET_SETTINGS.map(setting).filter(v => typeof v === 'string' && v.length >= 4); } catch { return []; } // database not open
};
export const scrub = text => SECRETS.reduce((t, [re, to]) => t.replace(re, to), secretValues().reduce((t, v) => t.split(v).join('[redacted]'), String(text)));
const original = console.error.bind(console);
console.error = (...args) => {
  original(...args);
  const text = args.map(a => (a instanceof Error ? `${a.name}: ${a.message}\n${(a.stack ?? '').split('\n').slice(1, 4).join('\n')}` : String(a))).join(' ');
  errors.push({ at: new Date().toISOString(), message: scrub(text).slice(0, 1000) });
  if (errors.length > 50) errors.shift();
};
export const recentErrors = () => [...errors].reverse();
export const startedAt = Date.now();
