// MFA settings and account deletion (user docs: /users/@me/mfa/*, /users/@me/delete)
import { randomBytes } from 'node:crypto';
import { DATA_DIR, get, all, run, tx, json, audienceOf, userById, userObj } from '../db.js';
import { HttpError, str, invalid } from '../errors.js';
import { confirmPassword } from '../auth.js';
import { sendToUsers, closeTokenSessions } from '../gateway.js';
import { base32Decode, totpStep, seal, newBackupCode } from '../totp.js';
import { requireMfa, setBackupCodes } from '../mfa.js';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { removeImage, removeAsset } from '../files.js';
import { removeMember } from './guilds.js';
import { leaveGroup } from './groups.js';
import { deleteApplication } from './applications.js';

async function passwordOk(ctx) {
  if (!(await confirmPassword(ctx.body?.password, ctx.user, ctx.headers))) throw invalid('password', 'PASSWORD_DOES_NOT_MATCH', 'Password does not match.');
}

const announce = userId => {
  const u = userById(userId);
  sendToUsers(audienceOf(userId), 'USER_UPDATE', id => userObj(u, id === userId));
};

const backupList = (userId, codes) => codes.map(code => ({ user_id: userId, code, consumed: false }));

// POST /users/@me/mfa/totp/enable {password, secret?, code?}: password alone answers 60005 (continue setup), then the
// client-generated base32 secret and a current code turn TOTP on and return 10 backup codes once
async function enableTotp(ctx) {
  if (ctx.user.mfa_secret) throw new HttpError(400, 60001, 'Two factor is already enabled');
  await passwordOk(ctx);
  if (ctx.body.secret == null && ctx.body.code == null) throw new HttpError(400, 60005, 'Password verified, continue the two-factor setup');
  const key = base32Decode(str(ctx.body, 'secret', 16, 64));
  if (!key || key.length < 10) throw invalid('secret', 'BASE_TYPE_BAD_VALUE', 'Must be a base32 secret of at least 80 bits.');
  const step = totpStep(key, str(ctx.body, 'code', 6, 6));
  if (step === null) throw new HttpError(400, 60008, 'Invalid two-factor code');
  const codes = Array.from({ length: 10 }, newBackupCode);
  setBackupCodes(ctx.user.id, codes);
  run('UPDATE users SET mfa_secret = ?, mfa_last_step = ? WHERE id = ?', seal(key), step, ctx.user.id);
  announce(ctx.user.id);
  return { token: ctx.token, backup_codes: backupList(ctx.user.id, codes) };
}

function disableTotp(ctx) {
  if (!ctx.user.mfa_secret) throw new HttpError(400, 60002, 'Two factor is not enabled');
  requireMfa(ctx);
  tx(() => {
    run('UPDATE users SET mfa_secret = NULL, mfa_last_step = 0 WHERE id = ?', ctx.user.id);
    run('DELETE FROM mfa_backup_codes WHERE user_id = ?', ctx.user.id);
  });
  announce(ctx.user.id);
  return { token: ctx.token };
}

// codes are stored hashed, so they can only be shown when (re)generated: {password, regenerate: true}
async function backupCodes(ctx) {
  if (!ctx.user.mfa_secret) throw new HttpError(400, 60002, 'Two factor is not enabled');
  await passwordOk(ctx);
  requireMfa(ctx);
  if (ctx.body.regenerate !== true) throw invalid('regenerate', 'BASE_TYPE_BAD_VALUE', 'Backup codes are stored hashed; regenerate to get new ones.');
  const codes = Array.from({ length: 10 }, newBackupCode);
  setBackupCodes(ctx.user.id, codes);
  return { backup_codes: backupList(ctx.user.id, codes) };
}

// the account becomes "Deleted User"; its messages stay. Refused while it owns guilds (transfer them first).
export function anonymize(userId) {
  const u = userById(userId);
  for (const g of all('SELECT guild_id FROM members WHERE user_id = ?', userId)) removeMember(g.guild_id, u);
  for (const c of all("SELECT c.id FROM channels c JOIN dm_recipients r ON r.channel_id = c.id AND r.user_id = ? WHERE c.type = 3", userId)) leaveGroup(c.id, u);
  for (const app of all('SELECT id FROM applications WHERE owner_id = ?', userId)) deleteApplication(app.id);
  const others = all('SELECT user_id, type FROM relationships WHERE other_id = ? AND type != 2', userId);
  const hashes = all('SELECT token_hash FROM tokens WHERE user_id = ?', userId).map(t => t.token_hash);
  const sounds = all('SELECT id FROM user_sounds WHERE user_id = ?', userId);
  tx(() => {
    run(`UPDATE users SET username = ?, global_name = 'Deleted User', email = ?, avatar = NULL, banner = NULL, bio = NULL, pronouns = NULL,
           accent_color = NULL, settings = '{}', customization = '{}', mfa_secret = NULL, deleted = 1, password_hash = ?, status = 'invisible' WHERE id = ?`,
    `deleted_user_${userId}`, `deleted-${userId}@users.invalid`, randomBytes(32).toString('hex'), userId);
    for (const t of ['tokens', 'notes', 'user_guild_settings', 'push_subscriptions', 'mfa_backup_codes', 'recent_mentions', 'scheduled_messages', 'saved_messages', 'bot_reminders', 'user_sounds', 'webauthn_credentials']) run(`DELETE FROM ${t} WHERE user_id = ?`, userId);
    run('DELETE FROM relationships WHERE user_id = ? OR other_id = ?', userId, userId);
    run('DELETE FROM notes WHERE target_id = ?', userId);
  });
  hashes.forEach(closeTokenSessions);
  for (const r of others) sendToUsers([r.user_id], 'RELATIONSHIP_REMOVE', { id: userId, type: r.type });
  removeImage('avatars', userId, u.avatar);
  removeImage('banners', userId, u.banner);
  sounds.forEach(s => removeAsset('user-sounds', s.id));
  rmSync(join(DATA_DIR, 'chat-backgrounds', userId), { recursive: true, force: true });
  announce(userId);
}

async function deleteAccount(ctx) {
  await passwordOk(ctx);
  requireMfa(ctx);
  if (get('SELECT 1 FROM guilds WHERE owner_id = ?', ctx.user.id)) {
    throw new HttpError(400, 40011, 'You must transfer ownership of any owned guilds before deleting your account');
  }
  anonymize(ctx.user.id);
}

function exportAccountData(ctx) {
  const userId = ctx.user.id;
  const userRow = userById(userId);
  const data = {
    exported_at: new Date().toISOString(),
    user: userObj(userRow, true),
    settings: json(get('SELECT settings FROM users WHERE id = ?', userId)?.settings, {}),
    guilds: all('SELECT g.id, g.name, m.nick, m.joined_at FROM members m JOIN guilds g ON g.id = m.guild_id WHERE m.user_id = ?', userId),
    relationships: all('SELECT other_id, type FROM relationships WHERE user_id = ?', userId),
    notes: all('SELECT target_id, note FROM notes WHERE user_id = ?', userId),
    bookmarks: all('SELECT message_id, channel_id, saved_at AS created_at, due_at FROM saved_messages WHERE user_id = ?', userId),
    messages: all('SELECT id, channel_id, content, timestamp, edited_timestamp FROM messages WHERE author_id = ? AND webhook_id IS NULL ORDER BY CAST(id AS INTEGER) DESC LIMIT 10000', userId)
      .map(r => ({ ...r, attachments: all('SELECT id, filename, size, content_type FROM attachments WHERE message_id = ?', r.id) })),
  };
  ctx.headers['Content-Type'] = 'application/json; charset=utf-8';
  ctx.headers['Content-Disposition'] = `attachment; filename="cillhub-data-export-${userId}.json"`;
  return data;
}

const user = { userOnly: true };
export default [
  ['GET', '/users/@me/export', exportAccountData, { userOnly: true, bucket: 'account-export', limit: 2, window: 3600 }],
  ['POST', '/users/@me/mfa/totp/enable', enableTotp, user],
  ['POST', '/users/@me/mfa/totp/disable', disableTotp, user],
  ['POST', '/users/@me/mfa/codes-verification', backupCodes, user],
  ['POST', '/users/@me/delete', deleteAccount, user],
];
