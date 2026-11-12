import { get, all, run, audienceOf, userById, userObj, guildObj, guildsOf } from '../db.js';
import { str, int, invalid, notFound, emailField } from '../errors.js';
import { sendToUsers, closeTokenSessions } from '../gateway.js';
import { saveImage, removeImage } from '../files.js';
import { hashPassword, confirmPassword, tokenHash } from '../auth.js';
import { requireMfa, dropMfaState } from '../mfa.js';
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
    if (body.email !== undefined || body.new_password !== undefined) requireMfa(ctx); // step-up: a stolen session must not take over the account
  }
  if (body.username !== undefined) {
    next.username = str(body, 'username', 2, 32);
    if (next.username.includes('@')) throw invalid('username', 'USERNAME_INVALID_CONTAINS', 'Username cannot contain "@".');
  }
  if (body.email !== undefined) {
    next.email = emailField(body);
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
  if (next.email || next.password_hash) run('DELETE FROM password_resets WHERE user_id = ?', user.id); // a pending reset link dies with the old address or password
  if ('avatar' in next && next.avatar !== user.avatar) removeImage('avatars', user.id, user.avatar);
  if ('banner' in next && next.banner !== user.banner) removeImage('banners', user.id, user.banner);
  if (next.password_hash) {
    run('DELETE FROM webauthn_credentials WHERE user_id = ?', user.id); // a passkey added with a stolen token must not outlive the reset
    run('UPDATE users SET calendar_token = NULL WHERE id = ?', user.id); // so must a copied calendar feed link
    dropMfaState(user.id);
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

// @me routes must precede /users/:id
export default [
  ['GET', '/users/@me', ({ user }) => userObj(user, true)],
  ['PATCH', '/users/@me', patchMe, { maxBody: 12 * 1024 * 1024 }],
  ['PATCH', '/users/@me/profile', patchMe, { maxBody: 12 * 1024 * 1024, userOnly: true }],
  ['GET', '/users/@me/guilds', ({ user }) => guildsOf(user.id).map(g => guildObj(g))],
  ['GET', '/users/:id', getUser],
];
