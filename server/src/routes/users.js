import { get, all, run, audienceOf, userById, userObj, guildObj, guildsOf } from '../db.js';
import { str, int, invalid, notFound } from '../errors.js';
import { sendToUsers, closeTokenSessions } from '../gateway.js';
import { saveImage, removeImage } from '../files.js';
import { hashPassword, confirmPassword, tokenHash } from '../auth.js';
import { customizationPatch } from './customization.js';
import { pushUserUpdate, publicUrl } from '../federation.js';

const passwordMismatch = () => invalid('password', 'PASSWORD_DOES_NOT_MATCH', 'Password does not match.');
const nullableStr = (body, field, max) => (body[field] === null ? null : str(body, field, 0, max) || null);

// username, email and password changes need the current password; a new password revokes every other token
async function patchMe(ctx) {
  const { user } = ctx;
  const body = ctx.body ?? {};
  const next = {};
  if (body.global_name !== undefined) next.global_name = body.global_name === null ? null : str(body, 'global_name', 1, 32);
  if (body.bio !== undefined) next.bio = nullableStr(body, 'bio', 190);
  if (body.pronouns !== undefined) next.pronouns = nullableStr(body, 'pronouns', 40);
  if (body.accent_color !== undefined) next.accent_color = body.accent_color === null ? null : int(body, 'accent_color', 0, 0xffffff);
  const sensitive = ['username', 'email', 'new_password'].filter(k => body[k] !== undefined);
  if (sensitive.length) {
    if (user.bot && sensitive.some(k => k !== 'username')) throw invalid(sensitive[0], 'BOT_FIELD', 'Bots cannot change this.');
    if (!user.bot && !(await confirmPassword(body.password, user, ctx.headers))) throw passwordMismatch();
  }
  if (body.username !== undefined) {
    next.username = str(body, 'username', 2, 32);
    if (next.username.includes('@')) throw invalid('username', 'USERNAME_INVALID_CONTAINS', 'Username cannot contain "@".');
  }
  if (body.email !== undefined) {
    next.email = str(body, 'email', 3, 254);
    if (!/^[^@\s]+@[^@\s]+$/.test(next.email)) throw invalid('email', 'EMAIL_TYPE_INVALID_EMAIL', 'Not a well formed email address.');
  }
  if (body.new_password !== undefined) Object.assign(next, await hashPassword(str(body, 'new_password', 8, 72, false)));
  if (next.hash) { next.password_hash = next.hash; delete next.hash; next.require_password_change = 0; }
  const customization = customizationPatch(body, user); // v6: name styles, decoration, nameplate, profile theme/effect/widgets
  if (customization) next.customization = customization;
  if (body.avatar !== undefined) next.avatar = await saveImage(body.avatar, 'avatar', 'avatars', user.id);
  if (body.banner !== undefined) next.banner = await saveImage(body.banner, 'banner', 'banners', user.id);
  // uniqueness after the awaits, so a concurrent change cannot slip in between check and write
  if (next.username && get('SELECT 1 FROM users WHERE username = ? AND id != ?', next.username, user.id)) throw invalid('username', 'USERNAME_ALREADY_TAKEN', 'Username is unavailable.');
  if (next.email && get('SELECT 1 FROM users WHERE email = ? AND id != ?', next.email, user.id)) throw invalid('email', 'EMAIL_ALREADY_REGISTERED', 'Email is already registered.');
  for (const [k, v] of Object.entries(next)) run(`UPDATE users SET ${k} = ? WHERE id = ?`, v, user.id); // keys are fixed above
  if ('avatar' in next && next.avatar !== user.avatar) removeImage('avatars', user.id, user.avatar);
  if ('banner' in next && next.banner !== user.banner) removeImage('banners', user.id, user.banner);
  if (next.password_hash) {
    run('DELETE FROM webauthn_credentials WHERE user_id = ?', user.id); // a passkey added with a stolen token must not outlive the reset
    const keep = tokenHash(ctx.token);
    for (const { token_hash: t } of all('SELECT token_hash FROM tokens WHERE user_id = ? AND token_hash != ?', user.id, keep)) {
      run('DELETE FROM tokens WHERE token_hash = ?', t);
      closeTokenSessions(t);
    }
  }
  const u = userById(user.id);
  sendToUsers(audienceOf(user.id), 'USER_UPDATE', id => userObj(u, id === user.id));
  pushUserUpdate(u, publicUrl(ctx.req)); // v7 hub: to the linked nodes where this user has an account
  return { ...userObj(u, true), ...(!user.bot && { token: ctx.token }) };
}

function getUser({ params }) {
  const u = userById(params.id);
  if (!u) throw notFound(10013, 'User');
  return userObj(u);
}

function putE2eeKeys(ctx) {
  const body = ctx.body ?? {};
  if (!body.public_key && !body.identity_key) throw invalid('public_key', 'BASE_TYPE_REQUIRED', 'E2EE public key is required.');
  const pub = typeof body.public_key === 'string' ? body.public_key : JSON.stringify(body);
  const now = new Date().toISOString();
  run(`INSERT INTO user_e2ee_keys (user_id, public_key, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET public_key = excluded.public_key, updated_at = excluded.updated_at`,
    ctx.user.id, pub, now, now);
  return { ok: true, user_id: ctx.user.id, updated_at: now };
}

function getE2eeKeys({ params }) {
  const row = get('SELECT * FROM user_e2ee_keys WHERE user_id = ?', params.id);
  if (!row) throw notFound(10013, 'User E2EE keys');
  let keys;
  try { keys = JSON.parse(row.public_key); } catch { keys = row.public_key; }
  return { user_id: row.user_id, public_key: row.public_key, keys, updated_at: row.updated_at };
}

// @me routes must precede /users/:id
export default [
  ['GET', '/users/@me', ({ user }) => userObj(user, true)],
  ['PATCH', '/users/@me', patchMe, { maxBody: 12 * 1024 * 1024 }],
  ['PATCH', '/users/@me/profile', patchMe, { maxBody: 12 * 1024 * 1024, userOnly: true }],
  ['GET', '/users/@me/guilds', ({ user }) => guildsOf(user.id).map(g => guildObj(g))],
  ['PUT', '/users/@me/e2ee/keys', putE2eeKeys, { userOnly: true }],
  ['GET', '/users/@me/e2ee/keys', ({ user }) => getE2eeKeys({ params: { id: user.id } }), { userOnly: true }],
  ['GET', '/users/:id/e2ee/keys', getE2eeKeys],
  ['GET', '/users/:id', getUser],
];
