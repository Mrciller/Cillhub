// MFA checks shared by login, sensitive actions and the MFA settings routes
import { randomBytes, createHash } from 'node:crypto';
import { get, run, tx } from './db.js';
import { HttpError } from './errors.js';
import { totpStep, unseal, backupHash } from './totp.js';
import { checkLogin, loginFailed } from './ratelimit.js';

// a TOTP code (each time step accepted once) or an unused backup code; true when it checks out.
// Wrong codes count per user across all tickets and sensitive actions: 10 in 15 minutes, then 429 (login lock).
export function verifyCode(user, code) {
  if (!user?.mfa_secret || typeof code !== 'string') return false;
  const keys = [`mfa:${user.id}`];
  checkLogin(keys);
  const ok = codeOk(user, code);
  if (!ok) loginFailed(keys);
  return ok;
}

function codeOk(user, code) {
  const clean = code.replace(/[\s-]/g, '');
  if (/^\d{6}$/.test(clean)) {
    const fresh = get('SELECT mfa_last_step FROM users WHERE id = ?', user.id);
    const step = totpStep(unseal(user.mfa_secret), clean);
    if (step === null || step <= fresh.mfa_last_step) return false;
    // the UPDATE guard makes the replay check atomic even for two requests in the same step
    return run('UPDATE users SET mfa_last_step = ? WHERE id = ? AND mfa_last_step < ?', step, user.id, step).changes === 1;
  }
  if (/^[a-z0-9]{8}$/i.test(clean)) {
    return run('UPDATE mfa_backup_codes SET consumed = 1 WHERE user_id = ? AND code_hash = ? AND consumed = 0', user.id, backupHash(user.id, clean)).changes === 1;
  }
  return false;
}

// tickets for the login flow and for elevation (sensitive actions): 5 minutes, 5 wrong codes, single use
const TICKET_TTL = 5 * 60 * 1000;
const MAX_ATTEMPTS = 5;
const tickets = new Map(); // sha256(ticket) -> { userId, purpose, expires, attempts }
const hash = t => createHash('sha256').update(String(t)).digest('hex');

export function newTicket(userId, purpose) {
  const now = Date.now();
  for (const [k, t] of tickets) if (t.expires <= now) tickets.delete(k);
  const ticket = randomBytes(24).toString('base64url');
  tickets.set(hash(ticket), { userId, purpose, expires: now + TICKET_TTL, attempts: 0 });
  return ticket;
}

// redeems a ticket with a code: the user on success; 400 60006 for an unknown/expired/used-up ticket, 400 60008 for a wrong code
export function redeemTicket(ticket, purpose, code) {
  const key = hash(ticket);
  const t = tickets.get(key);
  if (!t || t.purpose !== purpose || t.expires <= Date.now()) {
    tickets.delete(key);
    throw new HttpError(400, 60006, 'Invalid two-factor auth ticket');
  }
  const user = get('SELECT * FROM users WHERE id = ? AND deleted = 0 AND disabled = 0', t.userId);
  if (!user) {
    tickets.delete(key);
    throw new HttpError(400, 60006, 'Invalid two-factor auth ticket');
  }
  if (!verifyCode(user, code)) {
    if (++t.attempts >= MAX_ATTEMPTS) tickets.delete(key);
    throw new HttpError(400, 60008, 'Invalid two-factor code');
  }
  tickets.delete(key);
  return user;
}

// elevation tokens from POST /mfa/finish, sent back in X-Cillhub-MFA-Authorization (5 minutes)
const elevations = new Map(); // sha256(token) -> { userId, expires }

// a new password, a forced logout, a disabled account or a 2FA reset ends pending tickets and elevations too
export function dropMfaState(userId) {
  for (const map of [tickets, elevations]) for (const [k, t] of map) if (t.userId === userId) map.delete(k);
}
export function elevate(userId) {
  const token = randomBytes(32).toString('base64url');
  elevations.set(hash(token), { userId, expires: Date.now() + TICKET_TTL });
  return token;
}

// sensitive actions: with MFA on, a body `code` (TOTP or backup) or an elevation header; otherwise 401 60003 with a ticket (docs)
export function requireMfa(ctx, user = ctx.user) {
  if (!user.mfa_secret) return;
  // bot libraries send the same token as x-<their app>-mfa-authorization; accept that alias by shape
  const header = ctx.req.headers['x-cillhub-mfa-authorization']
    ?? Object.entries(ctx.req.headers).find(([k]) => /^x-[a-z]+-mfa-authorization$/.test(k))?.[1];
  const e = typeof header === 'string' && elevations.get(hash(header));
  if (e && e.userId === user.id && e.expires > Date.now()) return;
  if (ctx.body?.code != null) {
    if (verifyCode(user, String(ctx.body.code))) return;
    throw new HttpError(400, 60008, 'Invalid two-factor code'); // a wrong code is not a missing one (the client says so)
  }
  const err = new HttpError(401, 60003, 'Two factor is required for this operation');
  err.body.mfa = { ticket: newTicket(user.id, 'elevate'), methods: [{ type: 'totp', backup_codes_allowed: true }, { type: 'backup' }] };
  throw err;
}

export function setBackupCodes(userId, codes) {
  tx(() => {
    run('DELETE FROM mfa_backup_codes WHERE user_id = ?', userId);
    for (const c of codes) run('INSERT INTO mfa_backup_codes (user_id, code_hash) VALUES (?, ?)', userId, backupHash(userId, c));
  });
}
