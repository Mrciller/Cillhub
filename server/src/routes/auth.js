import { createHash } from 'node:crypto';
import { snowflake } from '../snowflake.js';
import { get, all, run } from '../db.js';
import { hashPassword, checkPassword, issueToken, revokeToken, tokenHash, sessionIdHash } from '../auth.js';
import { HttpError, str, invalid, unauthorized } from '../errors.js';
import { closeTokenSessions } from '../gateway.js';
import { checkLogin, loginFailed, loginSucceeded } from '../ratelimit.js';
import { newTicket, redeemTicket, requireMfa, elevate } from '../mfa.js';
import { settingsOf } from '../userdata.js';
import { setting } from '../instance.js';
import { localLoginOpen } from '../federation.js';
import { setupOpen } from './setup.js';

// v6 registration modes: open, invite (an admin-issued registration_code is needed) or closed
function registrationCode(body) {
  const mode = setting('registration_mode');
  if (mode === 'closed') throw new HttpError(403, 0, 'Registration is closed on this instance.');
  if (mode !== 'invite') return null;
  const code = typeof body.registration_code === 'string' ? body.registration_code.trim() : '';
  const row = code && get(`SELECT * FROM registration_codes WHERE code = ? AND (expires_at IS NULL OR expires_at > ?)
                           AND (max_uses = 0 OR uses < max_uses)`, code, Date.now());
  if (!row) throw invalid('registration_code', 'REGISTRATION_CODE_INVALID', 'A valid registration code is required.');
  return row.code;
}

const hubOnlyLogin = () => new HttpError(403, 0, 'This instance only allows sign-in with the hub.');

async function register(ctx) {
  if (setupOpen()) throw new HttpError(403, 0, 'This instance is not set up yet.');
  if (!localLoginOpen()) throw hubOnlyLogin(); // v7: a connected node whose admin chose hub sign-in only
  registrationCode(ctx.body ?? {});
  const email = str(ctx.body, 'email', 3, 254);
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw invalid('email', 'EMAIL_TYPE_INVALID_EMAIL', 'Not a well formed email address.');
  const username = str(ctx.body, 'username', 2, 32);
  if (username.includes('@')) throw invalid('username', 'USERNAME_INVALID_CONTAINS', 'Username cannot contain "@".');
  const password = str(ctx.body, 'password', 8, 72, false);
  const { hash, salt } = await hashPassword(password);
  // uniqueness is checked after the await so check and insert cannot interleave with another request
  if (get('SELECT 1 FROM users WHERE email = ?', email)) throw invalid('email', 'EMAIL_ALREADY_REGISTERED', 'Email is already registered.');
  if (get('SELECT 1 FROM users WHERE username = ?', username)) throw invalid('username', 'USERNAME_ALREADY_TAKEN', 'Username is unavailable.');
  const code = registrationCode(ctx.body); // again after the await: a single-use code cannot be spent twice
  const id = snowflake();
  run('INSERT INTO users (id, email, username, password_hash, salt) VALUES (?, ?, ?, ?, ?)', id, email, username, hash, salt);
  if (code) run('UPDATE registration_codes SET uses = uses + 1 WHERE code = ?', code);
  ctx.status = 201;
  return { token: issueToken(id) };
}

const loginSettings = userId => { const s = settingsOf(userId); return { locale: s.locale, theme: s.theme }; };
// login response tail: settings, and required_actions (docs) when an admin asked for a new password
const loginTail = user => ({ user_settings: loginSettings(user.id), ...(user.require_password_change && { required_actions: ['update_password'] }) });
const disabled = () => new HttpError(400, 20013, 'This account has been disabled.');

// from the 3rd failure in a row an account+IP pair waits longer each time (1 s doubling to 60 s); 10 failures per account+IP or per IP in
// 15 minutes lock that pair / that IP out (429 with retry_after), so a stranger cannot lock an account for everyone;
// MFA answers with a ticket (docs)
async function login(ctx) {
  const { body } = ctx;
  const login = str(body, 'login', 1, 254);
  const password = str(body, 'password', 1, 72, false);
  // IPv6: one /64 is one attacker
  const ip = ctx.ip.includes(':') && !ctx.ip.startsWith('::ffff:') ? ctx.ip.split(':').slice(0, 4).join(':') : ctx.ip;
  const keys = [`login:${login.toLowerCase()}:${ip}`, `ip:${ip}`, `acct:${login.toLowerCase()}`];
  checkLogin(keys, ctx.headers);
  const user = get(`SELECT * FROM users WHERE ${login.includes('@') ? 'email' : 'username'} = ?`, login);
  if (!(await checkPassword(password, user))) {
    loginFailed(keys);
    throw unauthorized();
  }
  loginSucceeded(keys);
  if (user.disabled) throw disabled();
  if (!localLoginOpen() && !user.instance_admin) throw hubOnlyLogin(); // admins keep local sign-in, so they cannot lock themselves out
  if (user.mfa_secret) {
    return { user_id: user.id, mfa: true, ticket: newTicket(user.id, 'login'), totp: true, backup: true, sms: false, webauthn: null };
  }
  return { token: issueToken(user.id), user_id: user.id, ...loginTail(user) };
}

// /auth/mfa/totp and /auth/mfa/backup: the ticket from login plus a TOTP or backup code
function mfaLogin(ctx) {
  const user = redeemTicket(str(ctx.body, 'ticket', 1, 200, false), 'login', str(ctx.body, 'code', 6, 16));
  if (user.disabled) throw disabled();
  return { token: issueToken(user.id), ...loginTail(user) };
}

function logout({ token }) {
  revokeToken(token);
  closeTokenSessions(tokenHash(token));
}

// one auth session per token: client info from the gateway IDENTIFY, last use updated at most once a minute
function sessions({ user, token }) {
  const current = tokenHash(token);
  return {
    user_sessions: all('SELECT * FROM tokens WHERE user_id = ? ORDER BY last_used DESC LIMIT 50', user.id).map(t => ({
      id_hash: sessionIdHash(t.token_hash), approx_last_used_time: new Date(t.last_used ?? t.created_at ?? Date.now()).toISOString(),
      client_info: { os: t.os ?? null, platform: t.platform ?? null, location: null }, current: t.token_hash === current,
    })),
  };
}

function logoutSessions(ctx) {
  const hashes = ctx.body?.session_id_hashes;
  if (!Array.isArray(hashes) || !hashes.length || hashes.length > 64 || !hashes.every(h => typeof h === 'string')) {
    throw invalid('session_id_hashes', 'BASE_TYPE_BAD_LENGTH', 'Must be a list of 1 to 64 session id hashes.');
  }
  requireMfa(ctx);
  for (const t of all('SELECT token_hash FROM tokens WHERE user_id = ?', ctx.user.id)) {
    if (!hashes.includes(sessionIdHash(t.token_hash))) continue;
    run('DELETE FROM tokens WHERE token_hash = ?', t.token_hash);
    closeTokenSessions(t.token_hash);
  }
}

// v10: Granular session audit & device management
function detailedSessions({ user, token }) {
  const current = tokenHash(token);
  return {
    user_sessions: all('SELECT * FROM tokens WHERE user_id = ? ORDER BY last_used DESC LIMIT 50', user.id).map(t => {
      const ipHash = createHash('sha256').update(`ip:${t.token_hash}`).digest('hex').slice(0, 16);
      return {
        id_hash: sessionIdHash(t.token_hash),
        created_at: new Date(t.created_at ?? t.last_used ?? Date.now()).toISOString(),
        approx_last_used_time: new Date(t.last_used ?? t.created_at ?? Date.now()).toISOString(),
        client_info: {
          os: t.os ?? 'Unknown OS',
          platform: t.platform ?? 'Unknown Client',
          user_agent: t.platform ? `${t.platform} on ${t.os ?? 'generic'}` : 'Cillhub Client',
          ip_hash: ipHash,
          location: null,
        },
        current: t.token_hash === current,
      };
    }),
  };
}

function revokeAllOthers({ user, token }) {
  const current = tokenHash(token);
  const others = all('SELECT token_hash FROM tokens WHERE user_id = ? AND token_hash != ?', user.id, current);
  for (const t of others) {
    run('DELETE FROM tokens WHERE token_hash = ?', t.token_hash);
    closeTokenSessions(t.token_hash);
  }
  return { revoked_count: others.length };
}

// POST /mfa/finish: trades an elevation ticket and a code for a 5-minute X-Cillhub-MFA-Authorization token
function mfaFinish(ctx) {
  const type = ctx.body?.mfa_type;
  if (type !== 'totp' && type !== 'backup') throw invalid('mfa_type', 'BASE_TYPE_CHOICES', 'Must be totp or backup.');
  const user = redeemTicket(str(ctx.body, 'ticket', 1, 200, false), 'elevate', str(ctx.body, 'data', 6, 16));
  if (user.id !== ctx.user.id) throw new HttpError(400, 60006, 'Invalid two-factor auth ticket');
  return { token: elevate(user.id) };
}

const user = { userOnly: true };
export default [
  ['POST', '/auth/register', register, { open: true }],
  ['POST', '/auth/login', login, { open: true }],
  ['POST', '/auth/mfa/totp', mfaLogin, { open: true }],
  ['POST', '/auth/mfa/backup', mfaLogin, { open: true }],
  ['POST', '/auth/logout', logout, user],
  ['GET', '/auth/sessions', sessions, user],
  ['GET', '/auth/sessions/detailed', detailedSessions, user],
  ['POST', '/auth/sessions/logout', logoutSessions, user],
  ['POST', '/auth/sessions/revoke-all-others', revokeAllOthers, user],
  ['POST', '/mfa/finish', mfaFinish, user],
];
