import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { get, run } from './db.js';
import { checkLogin, loginFailed, loginSucceeded } from './ratelimit.js';

const scryptAsync = promisify(scrypt);

export async function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return { salt, hash: (await scryptAsync(password, salt, 64)).toString('hex') };
}

// hashes even without a user so unknown logins cost as much as wrong passwords
export async function checkPassword(password, user) {
  const { hash } = await hashPassword(String(password ?? ''), user?.salt);
  return !!user && !user.bot && !user.deleted && !user.system && timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(user.password_hash, 'hex'));
}

// a signed-in user re-entering the password (account settings): the login lock applies per account, so a stolen token
// cannot be used to guess the password
export async function confirmPassword(password, user, headers) {
  const keys = [`pw:${user.id}`];
  checkLogin(keys, headers);
  const attempt = loginFailed(keys); // counted before the hash, like login
  if (!(await checkPassword(password, user))) return false;
  loginSucceeded(keys, attempt);
  return true;
}

export const tokenHash = token => createHash('sha256').update(token).digest('hex');
// the public id of an auth session (id_hash in the docs); derived, so the stored token hash is never shown
export const sessionIdHash = hash => createHash('sha256').update(`session:${hash}`).digest('base64url').slice(0, 32);

export function issueToken(userId) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  run('INSERT INTO tokens (token_hash, user_id, created_at, last_used) VALUES (?, ?, ?, ?)', tokenHash(token), userId, now, now);
  run('UPDATE users SET last_seen = ? WHERE id = ?', now, userId);
  return token;
}

// approximate last use (token and user), written at most once a minute per token; disabled accounts have no valid token
export function userByToken(token) {
  if (!token) return undefined;
  const hash = tokenHash(token);
  const row = get('SELECT u.*, t.last_used AS token_last_used FROM tokens t JOIN users u ON u.id = t.user_id WHERE t.token_hash = ?', hash);
  if (!row || row.deleted || row.disabled) return undefined;
  if (Date.now() - (row.token_last_used ?? 0) > 60_000) {
    run('UPDATE tokens SET last_used = ? WHERE token_hash = ?', Date.now(), hash);
    run('UPDATE users SET last_seen = ? WHERE id = ?', Date.now(), row.id);
  }
  return row;
}

// REST auth: "Bot <token>" only for bot users, a raw or "Bearer" token only for user accounts (kept apart, per the docs)
export function authenticate(header) {
  const raw = String(header ?? '');
  const isBot = /^Bot\s+/i.test(raw);
  const token = raw.replace(/^(Bot|Bearer)\s+/i, '');
  const user = userByToken(token);
  if (!user || !!user.bot !== isBot) return { token };
  return { token, user };
}

export const revokeToken = token => run('DELETE FROM tokens WHERE token_hash = ?', tokenHash(token));
