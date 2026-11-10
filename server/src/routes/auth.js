import { createHash, randomBytes } from 'node:crypto';
import { snowflake } from '../snowflake.js';
import { get, all, run } from '../db.js';
import { hashPassword, checkPassword, issueToken, revokeToken, tokenHash, sessionIdHash } from '../auth.js';
import { HttpError, str, invalid, unauthorized } from '../errors.js';
import { closeTokenSessions } from '../gateway.js';
import { checkLogin, loginFailed, loginSucceeded, limit, netOf } from '../ratelimit.js';
import { newTicket, redeemTicket, requireMfa, elevate } from '../mfa.js';
import { settingsOf } from '../userdata.js';
import { setting, resetAvailable } from '../instance.js';
import { sendMail, mailError } from '../mail.js';
import { requireCaptcha } from '../captcha.js';
import { endSessions } from './admin.js';
import { localLoginOpen, configuredUrl } from '../federation.js';
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
  if (setting('registration_mode') === 'closed') registrationCode({}); // says "closed" before asking for a captcha
  await requireCaptcha(ctx); // before the hash and before any answer about taken names
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

// --- password reset by email ---------------------------------------------------------------------------------------------
// POST /auth/forgot {login: email}: always 204 and the same work whether the account exists, so it tells nobody which
// addresses have accounts; the mail goes out in the background. Only the token's SHA-256 is stored, 30 minutes.
const RESET_MS = 30 * 60_000;
const resetHash = token => createHash('sha256').update(token).digest('hex');
const RESET_MAIL = {
  'en-US': (name, link) => ({
    subject: `Reset your password on ${name}`,
    text: `Someone asked to reset the password of your account on ${name}.\n\nTo choose a new password, open this link:\n${link}\n\n`
      + 'The link works for 30 minutes and only once.\n\nIf you did not ask for this, ignore this mail; your password stays as it is.\n',
  }),
  de: (name, link) => ({
    subject: `Passwort für ${name} zurücksetzen`,
    text: `Jemand möchte das Passwort deines Kontos auf ${name} zurücksetzen.\n\nÜber diesen Link wählst du ein neues Passwort:\n${link}\n\n`
      + 'Der Link gilt 30 Minuten und nur einmal.\n\nWenn du das nicht angefordert hast, ignoriere diese Mail; dein Passwort bleibt, wie es ist.\n',
  }),
};
async function forgot(ctx) {
  if (!resetAvailable()) throw new HttpError(400, 0, 'Password reset by email is not available on this instance.');
  limit('AUTH', 'forgot-ip', {}, netOf(ctx.ip), ctx.headers);
  await requireCaptcha(ctx);
  const email = str(ctx.body, 'login', 3, 254);
  run('DELETE FROM password_resets WHERE expires_at <= ?', Date.now());
  try { limit('AUTH', 'forgot-email', {}, email.toLowerCase(), {}); } catch { return; } // silent: a 429 would say the address is known
  const user = get(`SELECT * FROM users WHERE email = ? AND disabled = 0 AND deleted = 0 AND bot = 0 AND system = 0 AND home IS NULL`, email);
  if (!user) return;
  const token = randomBytes(32).toString('base64url');
  run('DELETE FROM password_resets WHERE user_id = ?', user.id);
  run('INSERT INTO password_resets (token_hash, user_id, expires_at) VALUES (?, ?, ?)', resetHash(token), user.id, Date.now() + RESET_MS);
  const mail = (RESET_MAIL[settingsOf(user.id).locale] ?? RESET_MAIL['en-US'])(setting('instance_name'), `${configuredUrl()}/reset?token=${token}`);
  sendMail({ to: user.email, ...mail }).catch(e => console.error(`password reset mail failed: ${mailError(e)}`));
}

// POST /auth/reset {token, password}: single use; ends every session and passkey of the account. It hands out no token,
// so the user signs in again and two-factor authentication still applies.
async function reset(ctx) {
  limit('AUTH', 'reset-ip', {}, netOf(ctx.ip), ctx.headers);
  const token = str(ctx.body, 'token', 1, 200, false);
  const password = str(ctx.body, 'password', 8, 72, false);
  const row = get(`SELECT r.user_id FROM password_resets r JOIN users u ON u.id = r.user_id
                   WHERE r.token_hash = ? AND r.expires_at > ? AND u.disabled = 0 AND u.deleted = 0`, resetHash(token), Date.now());
  if (!row) throw new HttpError(400, 0, 'This link is invalid or has expired.');
  run('DELETE FROM password_resets WHERE user_id = ?', row.user_id); // used up before the await, so it works once
  const { hash, salt } = await hashPassword(password);
  run('UPDATE users SET password_hash = ?, salt = ?, require_password_change = 0 WHERE id = ?', hash, salt, row.user_id);
  endSessions(row.user_id);
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
  const ip = netOf(ctx.ip);
  const keys = [`login:${login.toLowerCase()}:${ip}`, `ip:${ip}`, `acct:${login.toLowerCase()}`];
  checkLogin(keys, ctx.headers);
  const attempt = loginFailed(keys); // counted before the hash so parallel requests see each other; taken back on success
  const user = get(`SELECT * FROM users WHERE ${login.includes('@') ? 'email' : 'username'} = ?`, login);
  if (!(await checkPassword(password, user))) throw unauthorized();
  loginSucceeded(keys, attempt);
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
  ['POST', '/auth/forgot', forgot, { open: true }],
  ['POST', '/auth/reset', reset, { open: true }],
  ['POST', '/auth/mfa/totp', mfaLogin, { open: true }],
  ['POST', '/auth/mfa/backup', mfaLogin, { open: true }],
  ['POST', '/auth/logout', logout, user],
  ['GET', '/auth/sessions', sessions, user],
  ['GET', '/auth/sessions/detailed', detailedSessions, user],
  ['POST', '/auth/sessions/logout', logoutSessions, user],
  ['POST', '/auth/sessions/revoke-all-others', revokeAllOthers, user],
  ['POST', '/mfa/finish', mfaFinish, user],
];
