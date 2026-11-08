// Applications with bot users, bot tokens, and the OAuth2 bot install (user and official docs)
import { generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import { snowflake } from '../snowflake.js';
import { get, all, run, tx, isMember, memberIds, memberRow, memberObj, userById, userObj, roleObj } from '../db.js';
import { HttpError, str, int, invalid, notFound, missingAccess, missingPermissions } from '../errors.js';
import { P, has, guildPerms, parseBits, ALL } from '../permissions.js';
import { issueToken } from '../auth.js';
import { sendToUsers, sessionsOf, botGuildCreate, sendToSession, closeTokenSessions } from '../gateway.js';
import { saveImage, removeImage } from '../files.js';
import { audit, A } from '../audit.js';
import { requireMfa } from '../mfa.js';
import { SETTABLE_APP_FLAGS } from '../intents.js';
import { verifyEndpoint } from '../interactions.js';
import { anonymize } from './account.js';
import { isNodeClient, nodeConsentInfo, nodeConsent } from './hub.js';

const MAX_APPS = 50;

export function appObj(app) {
  const bot = userById(app.id);
  return {
    id: app.id, name: app.name, icon: app.icon, description: app.description, summary: '', type: null, flags: app.flags,
    bot_public: !!app.bot_public, bot_require_code_grant: false, verify_key: app.public_key, guild_id: null, team: null,
    owner: userObj(userById(app.owner_id)), bot: userObj(bot), interactions_endpoint_url: app.interactions_endpoint_url ?? null,
    redirect_uris: [], integration_types_config: { 0: {} }, install_params: { scopes: ['bot', 'applications.commands'], permissions: '0' },
    approximate_guild_count: all('SELECT 1 FROM members WHERE user_id = ?', app.id).length,
  };
}

const getApp = id => get('SELECT * FROM applications WHERE id = ?', id);
function ownedApp({ params, user }) {
  const app = getApp(params.id);
  if (!app) throw notFound(10002, 'Application');
  if (app.owner_id !== user.id) throw new HttpError(403, 20012, 'You are not authorized to perform this action on this application');
  return app;
}

// bot usernames come from the app name: [a-z0-9_.], unique, a random suffix when taken
function botUsername(name) {
  const base = name.toLowerCase().replace(/[^a-z0-9_.]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 27) || 'bot';
  let candidate = base;
  while (candidate.length < 2 || get('SELECT 1 FROM users WHERE username = ?', candidate)) candidate = `${base}_${randomInt(10000)}`;
  return candidate;
}

// POST /applications: the app, its bot user (same id) and an Ed25519 key pair; the bot token is in the answer once (bot.token)
async function createApp(ctx) {
  const { user, body } = ctx;
  const name = str(body ?? {}, 'name', 2, 32);
  const description = body?.description == null ? '' : str(body, 'description', 0, 400);
  if (get('SELECT COUNT(*) AS n FROM applications WHERE owner_id = ?', user.id).n >= MAX_APPS) throw new HttpError(400, 0, 'Maximum number of applications reached (50)');
  const id = snowflake();
  const icon = body?.icon == null ? null : await saveImage(body.icon, 'icon', 'app-icons', id);
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicHex = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  tx(() => {
    run('INSERT INTO users (id, email, username, global_name, password_hash, salt, bot) VALUES (?, ?, ?, ?, ?, ?, 1)',
      id, `bot-${id}@bots.invalid`, botUsername(name), name, randomBytes(32).toString('hex'), randomBytes(16).toString('hex'));
    run('INSERT INTO applications (id, owner_id, name, description, icon, public_key, private_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, user.id, name, description, icon, publicHex, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  });
  ctx.status = 201;
  const out = appObj(getApp(id));
  return { ...out, bot: { ...out.bot, token: issueToken(id) } };
}

// name, description, icon, flags (only the privileged-intent "limited" bits), bot_public, interactions_endpoint_url (verified by PING)
async function patchApp(ctx, app, byBot) {
  const body = ctx.body ?? {};
  const next = {};
  if (body.name !== undefined && !byBot) next.name = str(body, 'name', 2, 32);
  if (body.description !== undefined) next.description = body.description === null ? '' : str(body, 'description', 0, 400);
  if (body.flags !== undefined) next.flags = (app.flags & ~SETTABLE_APP_FLAGS) | (int(body, 'flags', 0, 2 ** 31) & SETTABLE_APP_FLAGS);
  if (body.bot_public !== undefined && !byBot) next.bot_public = Number(!!body.bot_public);
  if (body.interactions_endpoint_url !== undefined) {
    const url = body.interactions_endpoint_url || null;
    if (url) await verifyEndpoint(app, url);
    next.interactions_endpoint_url = url;
  }
  if (body.icon !== undefined) next.icon = await saveImage(body.icon, 'icon', 'app-icons', app.id);
  for (const [k, v] of Object.entries(next)) run(`UPDATE applications SET ${k} = ? WHERE id = ?`, v, app.id); // keys are fixed above
  if ('icon' in next && next.icon !== app.icon) removeImage('app-icons', app.id, app.icon);
  return appObj(getApp(app.id));
}

// the bot leaves every guild and becomes a deleted user; commands go with the application
export function deleteApplication(id) {
  anonymize(id);
  run('DELETE FROM applications WHERE id = ?', id);
}

function resetBotToken(ctx) {
  const app = ownedApp(ctx);
  requireMfa(ctx);
  for (const t of all('SELECT token_hash FROM tokens WHERE user_id = ?', app.id)) {
    run('DELETE FROM tokens WHERE token_hash = ?', t.token_hash);
    closeTokenSessions(t.token_hash);
  }
  return { token: issueToken(app.id) };
}

async function patchBot(ctx) {
  const app = ownedApp(ctx);
  const body = ctx.body ?? {};
  const bot = userById(app.id);
  if (body.username !== undefined) {
    const username = str(body, 'username', 2, 32);
    if (username.includes('@') || get('SELECT 1 FROM users WHERE username = ? AND id != ?', username, bot.id)) throw invalid('username', 'USERNAME_ALREADY_TAKEN', 'Username is unavailable.');
    run('UPDATE users SET username = ? WHERE id = ?', username, bot.id);
  }
  if (body.avatar !== undefined) {
    const avatar = await saveImage(body.avatar, 'avatar', 'avatars', bot.id);
    run('UPDATE users SET avatar = ? WHERE id = ?', avatar, bot.id);
    if (avatar !== bot.avatar) removeImage('avatars', bot.id, bot.avatar);
  }
  return userObj(userById(bot.id));
}

// --- OAuth2 bot install ------------------------------------------------------------------------------------------
function authorizeQuery(query) {
  const app = getApp(query.get('client_id') ?? '');
  if (!app) throw notFound(10002, 'Application');
  const scopes = (query.get('scope') ?? '').split(/[\s+]+/).filter(Boolean);
  if (!scopes.includes('bot')) throw invalid('scope', 'OAUTH2_SCOPE_INVALID', 'Only the bot scope (optionally with applications.commands) is supported.');
  if (scopes.some(s => s !== 'bot' && s !== 'applications.commands')) throw invalid('scope', 'OAUTH2_SCOPE_INVALID', 'Unsupported scope.');
  return { app, scopes };
}

// GET /oauth2/authorize: what the consent page shows, including the guilds the user may add the bot to (MANAGE_GUILD)
function previewAuthorize({ query, user }) {
  const { app } = authorizeQuery(query);
  const guilds = all('SELECT g.* FROM guilds g JOIN members m ON m.guild_id = g.id WHERE m.user_id = ?', user.id)
    .map(g => ({ id: g.id, name: g.name, icon: g.icon, mfa_level: 0, permissions: String(guildPerms(g.id, user.id)) }))
    .filter(g => has(BigInt(g.permissions), P.MANAGE_GUILD));
  const { owner, bot, ...application } = appObj(app);
  return { application, user: userObj(user), authorized: false, integration_type: 0, bot, guilds };
}

// POST /oauth2/authorize {authorize, guild_id, permissions}: adds the bot and, if permissions were asked for, a managed role
export function authorize(ctx) {
  const { app } = authorizeQuery(ctx.query);
  const { body, user } = ctx;
  if (body?.authorize !== true) return { url: '/oauth2/error?error=access_denied' };
  if (!app.bot_public && app.owner_id !== user.id) throw new HttpError(403, 50001, 'Missing Access');
  const guildId = String(body.guild_id ?? '');
  if (!get('SELECT 1 FROM guilds WHERE id = ?', guildId)) throw notFound(10004, 'Guild');
  if (!isMember(guildId, user.id)) throw missingAccess();
  const perms = guildPerms(guildId, user.id);
  if (!has(perms, P.MANAGE_GUILD)) throw missingPermissions();
  const wanted = body.permissions == null ? 0n : parseBits(body.permissions, 'permissions');
  if ((wanted & ~perms & ALL) !== 0n) throw missingPermissions(); // only what the installer has (owner and admins have all)
  if (get('SELECT 1 FROM bans WHERE guild_id = ? AND user_id = ?', guildId, app.id)) throw new HttpError(403, 40007, 'The user is banned from this guild');
  const redirect = { url: `/oauth2/authorized?guild_id=${guildId}` };
  if (isMember(guildId, app.id)) return redirect;
  addBot(guildId, app, wanted, ctx);
  return redirect;
}

// the bot joins with a managed role holding `wanted` (none when 0n); actor is who the guild audit log names (v8 modules too)
export function addBot(guildId, app, wanted, actor) {
  const roleId = snowflake();
  tx(() => {
    run('INSERT INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', guildId, app.id, new Date().toISOString());
    if (wanted) {
      run('UPDATE roles SET position = position + 1 WHERE guild_id = ? AND position >= 1', guildId);
      run('INSERT INTO roles (id, guild_id, name, position, permissions, managed, bot_id) VALUES (?, ?, ?, 1, ?, 1, ?)', roleId, guildId, app.name, String(wanted), app.id);
      run('INSERT INTO member_roles (guild_id, user_id, role_id) VALUES (?, ?, ?)', guildId, app.id, roleId);
    }
  });
  const ids = memberIds(guildId);
  if (wanted) {
    sendToUsers(ids, 'GUILD_ROLE_CREATE', { guild_id: guildId, role: roleObj(get('SELECT * FROM roles WHERE id = ?', roleId)) });
    for (const r of all('SELECT * FROM roles WHERE guild_id = ? AND position > 1', guildId)) sendToUsers(ids, 'GUILD_ROLE_UPDATE', { guild_id: guildId, role: roleObj(r) });
  }
  sendToUsers(ids.filter(id => id !== app.id), 'GUILD_MEMBER_ADD', { ...memberObj(memberRow(guildId, app.id)), guild_id: guildId });
  const g = get('SELECT * FROM guilds WHERE id = ?', guildId);
  for (const s of sessionsOf(app.id)) if (s.intents & 1) sendToSession(s, 'GUILD_CREATE', botGuildCreate(g, s));
  audit(actor, guildId, A.BOT_ADD, app.id);
}

const owner = { userOnly: true };
const bot = { botOnly: true };
export default [
  ['GET', '/applications/@me', ({ user }) => appObj(getApp(user.id)), bot],
  ['PATCH', '/applications/@me', ctx => patchApp(ctx, getApp(ctx.user.id), true), { ...bot, maxBody: 12 * 1024 * 1024 }],
  ['GET', '/oauth2/applications/@me', ({ user }) => appObj(getApp(user.id)), bot],
  ['GET', '/applications', ({ user }) => all('SELECT * FROM applications WHERE owner_id = ? ORDER BY rowid', user.id).map(appObj), owner],
  ['POST', '/applications', createApp, { ...owner, maxBody: 12 * 1024 * 1024 }],
  ['GET', '/applications/:id', ctx => appObj(ownedApp(ctx)), owner],
  ['PATCH', '/applications/:id', ctx => patchApp(ctx, ownedApp(ctx), false), { ...owner, maxBody: 12 * 1024 * 1024 }],
  ['DELETE', '/applications/:id', ctx => { const app = ownedApp(ctx); requireMfa(ctx); deleteApplication(app.id); }, owner],
  ['POST', '/applications/:id/delete', ctx => { const app = ownedApp(ctx); requireMfa(ctx); deleteApplication(app.id); }, owner],
  ['POST', '/applications/:id/bot/reset', resetBotToken, owner],
  ['PATCH', '/applications/:id/bot', patchBot, { ...owner, maxBody: 12 * 1024 * 1024 }],
  // v7: a linked node as client_id is the hub's "sign in with your Cillhub account" consent (routes/hub.js)
  ['GET', '/oauth2/authorize', ctx => (isNodeClient(ctx.query.get('client_id')) ? nodeConsentInfo(ctx) : previewAuthorize(ctx)), owner],
  ['POST', '/oauth2/authorize', ctx => (isNodeClient(ctx.query.get('client_id')) ? nodeConsent(ctx) : authorize(ctx)), owner],
];
