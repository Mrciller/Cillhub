// v7 first-run wizard (one-time, behind the setup code from install.sh), the voice self-check and the version route.
// Setup is open only while a setup code is configured (CILLCORD_SETUP_CODE or CILLCORD_SETUP_CODE_FILE, at least 8
// characters) and setup has not been completed; afterwards every /setup route except GET /setup answers 404.
import { readFileSync } from 'node:fs';
import { snowflake } from '../snowflake.js';
import { get, run } from '../db.js';
import { HttpError, str, invalid, emailField } from '../errors.js';
import { hashPassword, issueToken } from '../auth.js';
import { checkLogin, loginFailed, netOf } from '../ratelimit.js';
import { setting, setSetting, publicInstance, adminAudit } from '../instance.js';
import { configuredBackends, defaultBackend } from '../voice.js';
import { probe } from '../media/index.js';
import { ROLE, VERSION, HUB_URL, mode } from '../federation.js';
import { sameText } from '../fedcrypto.js';
import { linkToHub, fedView, updateSettings } from './node.js';
import { autoUpdate, hasUpdater } from '../updates.js';

const SETUP_CODE = (process.env.CILLCORD_SETUP_CODE
  || (process.env.CILLCORD_SETUP_CODE_FILE && (() => { try { return readFileSync(process.env.CILLCORD_SETUP_CODE_FILE, 'utf8'); } catch { return ''; } })()) || '').trim();
if (SETUP_CODE && SETUP_CODE.length < 8) console.error('setup code shorter than 8 characters; first-run setup is off');
export const setupOpen = () => SETUP_CODE.length >= 8 && !setting('setup_completed_at');
const gone = () => new HttpError(404, 0, '404: Not Found');

// wrong codes count like failed logins: 10 per IP in 15 minutes
function checkCode(ctx) {
  if (!setupOpen()) throw gone();
  const keys = [`setup:${netOf(ctx.ip)}`];
  checkLogin(keys, ctx.headers);
  if (typeof ctx.body?.setup_code !== 'string' || !sameText(ctx.body.setup_code.trim(), SETUP_CODE)) {
    loginFailed(keys);
    throw new HttpError(401, 0, 'Wrong setup code.');
  }
}

function state() {
  const admin = setting('setup_admin_id') && get('SELECT * FROM users WHERE id = ?', setting('setup_admin_id'));
  return {
    required: setupOpen(), role: ROLE, version: VERSION, hub_url: HUB_URL, mode_hint: ['standalone', 'connected'].includes(process.env.CILLCORD_MODE) ? process.env.CILLCORD_MODE : null,
    updater: hasUpdater, auto_update: autoUpdate().mode, auto_update_hour: autoUpdate().hour, // defaults from install.sh --auto-update
    ...(setupOpen() && { admin_created: !!admin, admin_mfa_enabled: !!admin?.mfa_secret }),
  };
}

// POST /setup/admin {setup_code, email, username, password} -> the first instance admin (once)
async function createAdmin(ctx) {
  checkCode(ctx);
  if (setting('setup_admin_id')) throw new HttpError(400, 0, 'The first admin already exists; sign in to continue.');
  const email = emailField(ctx.body);
  const username = str(ctx.body, 'username', 2, 32);
  if (username.includes('@')) throw invalid('username', 'USERNAME_INVALID_CONTAINS', 'Username cannot contain "@".');
  const { hash, salt } = await hashPassword(str(ctx.body, 'password', 8, 72, false));
  if (setting('setup_admin_id')) throw new HttpError(400, 0, 'The first admin already exists; sign in to continue.'); // again after the await
  if (get('SELECT 1 FROM users WHERE email = ? OR username = ?', email, username)) throw invalid('username', 'USERNAME_ALREADY_TAKEN', 'Username or email is taken.');
  const id = snowflake();
  run('INSERT INTO users (id, email, username, password_hash, salt, instance_admin) VALUES (?, ?, ?, ?, ?, 1)', id, email, username, hash, salt);
  setSetting('setup_admin_id', id);
  adminAudit({ action: 'setup.admin', targetType: 'user', targetId: id, ip: ctx.ip });
  ctx.status = 201;
  return { token: issueToken(id), user_id: id, mfa_required: true };
}

const MODES = ['standalone', 'connected'];
// POST /setup/complete {setup_code, instance_name, registration_mode, mode, hub_url?, link_code?, auto_update?, auto_update_hour?}
// as the setup admin with 2FA on
async function complete(ctx) {
  checkCode(ctx);
  if (ctx.user.id !== setting('setup_admin_id')) throw new HttpError(403, 50001, 'Only the admin created in this setup can finish it.');
  if (!ctx.user.mfa_secret) throw new HttpError(403, 60003, 'Enable two-factor authentication first.');
  const b = ctx.body;
  const name = str(b, 'instance_name', 1, 64);
  if (!['open', 'invite', 'closed'].includes(b.registration_mode)) throw invalid('registration_mode', 'BASE_TYPE_CHOICES', 'Must be open, invite or closed.');
  if (!MODES.includes(b.mode)) throw invalid('mode', 'BASE_TYPE_CHOICES', 'Must be standalone or connected.');
  if (b.mode === 'connected' && ROLE === 'hub') throw invalid('mode', 'BASE_TYPE_CHOICES', 'The hub cannot connect to a hub.');
  const linkCode = b.mode === 'connected' ? str(b, 'link_code', 1, 100) : null;
  updateSettings({ auto_update: b.auto_update, auto_update_hour: b.auto_update_hour }); // validated before anything is stored
  setSetting('instance_name', name);
  setSetting('registration_mode', b.registration_mode);
  if (linkCode && mode() !== 'connected') await linkToHub(ctx.req, linkCode, b.hub_url || undefined); // a refused link leaves setup open
  setSetting('setup_completed_at', new Date().toISOString());
  adminAudit({ adminId: ctx.user.id, action: 'setup.complete', details: { mode: b.mode, registration_mode: b.registration_mode }, ip: ctx.ip });
  return { completed: true, instance: publicInstance(), federation: fedView() };
}

// voice self-check: which backends are configured; for cillvoice the UDP port is bound and, for 60 s, answers plain STUN
// Binding requests, so the browser can gather a server-reflexive candidate against stun:<ip>:<port> (reachable = it gets one)
export async function voiceCheck() {
  const configured = configuredBackends();
  const out = { configured, default: defaultBackend(), cillvoice: null };
  if (configured.includes('cillvoice')) {
    const ip = process.env.CILLVOICE_PUBLIC_IP, port = Number(process.env.CILLVOICE_UDP_PORT);
    out.cillvoice = { public_ip: ip, udp_port: port, stun_url: `stun:${ip}:${port}`, ...await probe() };
  }
  return out;
}

export default [
  ['GET', '/server/version', () => ({ version: VERSION, role: ROLE, mode: mode(), contract: 7, setup_required: setupOpen() }), { open: true }],
  ['GET', '/setup', state, { open: true }],
  ['POST', '/setup/verify', ctx => { checkCode(ctx); }, { open: true }],
  ['POST', '/setup/admin', createAdmin, { open: true }],
  ['POST', '/setup/complete', complete, { userOnly: true }],
  ['POST', '/setup/voice-check', ctx => (checkCode(ctx), voiceCheck()), { open: true }],
  ['POST', '/admin/voice/self-check', () => voiceCheck(), { admin: true }],
];
