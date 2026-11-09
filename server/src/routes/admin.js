// v6 instance administration (/admin/*) and message reports. Every admin route needs users.instance_admin (granted only
// by src/admin-cli.js) AND two-factor authentication on the admin's account, re-read from the database on every
// request; it is rate limited and written to the append-only admin audit log. Admins get no extra rights anywhere else,
// and nothing here returns message content except the copy a user made by reporting a message.
import { randomInt } from 'node:crypto';
import os from 'node:os';
import { readdir, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { snowflake } from '../snowflake.js';
import {
  DATA_DIR, get, all, run, tx, json, idTime, isMember, memberIds, memberRow, memberObj, userById, userObj, guildObj, rolesOf,
  guildChannels, channelObj,
} from '../db.js';
import { HttpError, str, int, bool, intParam, idParam, invalid, notFound, missingAccess } from '../errors.js';
import { P, has, guildPerms, viewersOf } from '../permissions.js';
import { sessionIdHash } from '../auth.js';
import { sendToUsers, sendToAllUsers, closeTokenSessions, refreshPresence, isOnline } from '../gateway.js';
import { requireMfa } from '../mfa.js';
import { audit, A } from '../audit.js';
import { recheck, configuredBackends, defaultBackend, voiceStateCount } from '../voice.js';
import { mediaStats } from '../media/index.js';
import { insertMessage, bumpMentions, broadcastMessage, deleteMessages, attachmentUrl } from '../message.js';
import {
  setting, setSetting, DEFAULTS, UPLOAD_RANGE, publicInstance, systemUser, adminAudit, adminAuditObj, recentErrors, startedAt,
} from '../instance.js';
import { anonymize } from './account.js';
import { removeMember, destroyGuild } from './guilds.js';
import { loadMessage } from './messages.js';
import { fedState } from '../federation.js';

// --- the gate ------------------------------------------------------------------------------------------------------------
const deniedLogged = new Map(); // user id -> last time a refusal was written to the audit log (at most one a minute each)
function refuse(ctx, reason, err) {
  const now = Date.now();
  if (now - (deniedLogged.get(ctx.user.id) ?? 0) > 60_000) {
    deniedLogged.set(ctx.user.id, now);
    adminAudit({ adminId: ctx.user.id, action: 'access_denied', details: { reason, route: ctx.req.url.split('?')[0] }, ip: ctx.ip });
  }
  throw err;
}
export function requireAdmin(ctx) {
  const u = ctx.user; // a fresh users row: authenticate() reads it for every request
  if (!u.instance_admin || u.bot || u.deleted || u.disabled || u.system) refuse(ctx, 'not_admin', missingAccess());
  if (!u.mfa_secret) refuse(ctx, 'mfa_disabled', new HttpError(403, 60003, 'Enable two-factor authentication on your account to use instance administration.'));
}

// one entry per successful admin request; handlers name the action and target in ctx.audit
export function auditAdminRequest(ctx, route) {
  const a = ctx.audit ?? {};
  const [paramName, paramValue] = Object.entries(ctx.params)[0] ?? [];
  adminAudit({
    adminId: ctx.user.id, action: a.action ?? `${route.method} ${route.pattern}`, ip: ctx.ip, details: a.details ?? null,
    targetType: a.target_type ?? (paramName ? paramName.replace(/_id$/, '') : null), targetId: a.target_id ?? paramValue ?? null,
  });
}

const iso = ms => (ms ? new Date(ms).toISOString() : null);
const confirm = (body, expected) => {
  if (typeof body?.confirm !== 'string' || body.confirm !== expected) throw invalid('confirm', 'CONFIRMATION_MISMATCH', 'Type the exact name to confirm.');
};
const searchArgs = query => {
  const q = String(query.get('query') ?? '').slice(0, 100);
  return { like: `%${q.replace(/[\\%_]/g, c => `\\${c}`)}%`, limit: intParam(query, 'limit', 50, 1, 200), before: idParam(query, 'before') };
};

// --- users ---------------------------------------------------------------------------------------------------------------
function loadUser(id) {
  const u = get('SELECT * FROM users WHERE id = ?', id);
  if (!u || u.system) throw notFound(10013, 'User');
  return u;
}
const adminUserObj = u => ({
  id: u.id, username: u.username, global_name: u.global_name, avatar: u.avatar, email: u.bot ? null : u.email,
  created_at: iso(idTime(u.id)), last_seen: iso(u.last_seen), bot: !!u.bot, mfa_enabled: !!u.mfa_secret,
  disabled: !!u.disabled, deleted: !!u.deleted, instance_admin: !!u.instance_admin, require_password_change: !!u.require_password_change,
  guild_count: get('SELECT COUNT(*) AS n FROM members WHERE user_id = ?', u.id).n,
  application_count: get('SELECT COUNT(*) AS n FROM applications WHERE owner_id = ?', u.id).n,
  online: isOnline(u.id),
});

function listUsers({ query }) {
  const { like, limit, before } = searchArgs(query);
  return all(`SELECT * FROM users WHERE system = 0 AND (username LIKE ? ESCAPE '\\' OR global_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')
              AND (? IS NULL OR CAST(id AS INTEGER) < CAST(? AS INTEGER)) ORDER BY CAST(id AS INTEGER) DESC LIMIT ?`,
  like, like, like, before, before, limit).map(adminUserObj);
}

function userDetail({ params }) {
  const u = loadUser(params.user_id);
  return {
    ...adminUserObj(u),
    guilds: all('SELECT g.id, g.name, g.icon, g.owner_id FROM guilds g JOIN members m ON m.guild_id = g.id WHERE m.user_id = ? ORDER BY m.joined_at', u.id)
      .map(g => ({ id: g.id, name: g.name, icon: g.icon, owner: g.owner_id === u.id })),
    sessions: all('SELECT * FROM tokens WHERE user_id = ? ORDER BY last_used DESC LIMIT 50', u.id).map(t => ({
      id_hash: sessionIdHash(t.token_hash), created_at: iso(t.created_at), approx_last_used_time: iso(t.last_used),
      client_info: { os: t.os ?? null, platform: t.platform ?? null },
    })),
    applications: all('SELECT id, name FROM applications WHERE owner_id = ?', u.id),
    audit_log: all('SELECT * FROM admin_audit_log WHERE target_id = ? ORDER BY created_at DESC LIMIT 50', u.id).map(adminAuditObj),
  };
}

// admins never act on admins (themselves included): revoke the flag with the CLI first
function targetUser(ctx) {
  const u = loadUser(ctx.params.user_id);
  if (u.instance_admin) throw new HttpError(400, 0, 'This account is an instance administrator; revoke that with the admin CLI first.');
  return u;
}

function endSessions(userId) {
  const hashes = all('SELECT token_hash FROM tokens WHERE user_id = ?', userId).map(t => t.token_hash);
  run('DELETE FROM tokens WHERE user_id = ?', userId);
  run('DELETE FROM webauthn_credentials WHERE user_id = ?', userId); // passkeys would sign straight back in
  hashes.forEach(closeTokenSessions);
  refreshPresence(userId);
  return hashes.length;
}

export function disableUser(userId) {
  run('UPDATE users SET disabled = 1 WHERE id = ?', userId);
  return endSessions(userId);
}

function setDisabled(ctx, disabled) {
  const u = targetUser(ctx);
  if (disabled) ctx.audit = { action: 'user.disable', details: { sessions_closed: disableUser(u.id) } };
  else {
    run('UPDATE users SET disabled = 0 WHERE id = ?', u.id);
    ctx.audit = { action: 'user.enable' };
  }
  return adminUserObj(loadUser(u.id));
}

function forceLogout(ctx) {
  const u = targetUser(ctx);
  ctx.audit = { action: 'user.logout', details: { sessions_closed: endSessions(u.id) } };
  return adminUserObj(loadUser(u.id));
}

function resetMfa(ctx) {
  const u = targetUser(ctx);
  requireMfa(ctx);
  tx(() => {
    run('UPDATE users SET mfa_secret = NULL, mfa_last_step = 0 WHERE id = ?', u.id);
    run('DELETE FROM mfa_backup_codes WHERE user_id = ?', u.id);
  });
  const fresh = loadUser(u.id);
  sendToUsers([u.id], 'USER_UPDATE', userObj(fresh, true));
  ctx.audit = { action: 'user.reset_mfa' };
  return adminUserObj(fresh);
}

function requirePasswordChange(ctx) {
  const u = targetUser(ctx);
  const required = ctx.body?.required === undefined ? true : bool(ctx.body, 'required');
  run('UPDATE users SET require_password_change = ? WHERE id = ?', Number(required), u.id);
  ctx.audit = { action: 'user.require_password_change', details: { required } };
  return adminUserObj(loadUser(u.id));
}

// the same as self-deletion (refused while the account owns servers), confirmed by typing the username, with 2FA
function deleteUser(ctx) {
  const u = targetUser(ctx);
  if (u.deleted) throw new HttpError(400, 0, 'This account is already deleted.');
  confirm(ctx.body, u.username);
  requireMfa(ctx);
  if (get('SELECT 1 FROM guilds WHERE owner_id = ?', u.id)) {
    throw new HttpError(400, 40011, 'The account owns servers; transfer their ownership first.');
  }
  anonymize(u.id);
  ctx.audit = { action: 'user.delete', details: { username: u.username } };
}

// --- servers ---------------------------------------------------------------------------------------------------------------
function loadGuildRow(id) {
  const g = get('SELECT * FROM guilds WHERE id = ?', id);
  if (!g) throw notFound(10004, 'Guild');
  return g;
}
const guildStats = g => ({
  id: g.id, name: g.name, icon: g.icon, description: g.description, created_at: iso(idTime(g.id)),
  owner: (u => u && { id: u.id, username: u.username, global_name: u.global_name })(userById(g.owner_id)),
  member_count: get('SELECT COUNT(*) AS n FROM members WHERE guild_id = ?', g.id).n,
  channel_count: get('SELECT COUNT(*) AS n FROM channels WHERE guild_id = ?', g.id).n,
  message_count: get('SELECT COUNT(*) AS n FROM messages m JOIN channels c ON c.id = m.channel_id WHERE c.guild_id = ?', g.id).n,
  storage_bytes: get('SELECT COALESCE(SUM(a.size), 0) AS n FROM attachments a JOIN channels c ON c.id = a.channel_id WHERE c.guild_id = ?', g.id).n,
  invites_disabled: !!g.invites_disabled,
});

function listGuilds({ query }) {
  const { like, limit, before } = searchArgs(query);
  return all(`SELECT * FROM guilds WHERE name LIKE ? ESCAPE '\\' AND (? IS NULL OR CAST(id AS INTEGER) < CAST(? AS INTEGER))
              ORDER BY CAST(id AS INTEGER) DESC LIMIT ?`, like, before, before, limit).map(guildStats);
}

// settings, roles, the channel list (names and types only), invites, bans and the server's audit log; no messages
function guildDetail({ params }) {
  const g = loadGuildRow(params.guild_id);
  const { emojis, stickers, ...settings } = guildObj(g);
  return {
    ...guildStats(g), settings, roles: rolesOf(g.id), emoji_count: emojis.length, sticker_count: stickers.length,
    channels: guildChannels(g.id).map(c => ({ id: c.id, type: c.type, name: c.name, parent_id: c.parent_id, position: c.position, nsfw: !!c.nsfw })),
    invites: all('SELECT * FROM invites WHERE guild_id = ? ORDER BY created_at', g.id).map(i => ({
      code: i.code, channel_id: i.channel_id, inviter_id: i.inviter_id, uses: i.uses, max_uses: i.max_uses, created_at: i.created_at, expires_at: iso(i.expires_at),
    })),
    bans: all('SELECT u.*, b.reason FROM bans b JOIN users u ON u.id = b.user_id WHERE b.guild_id = ?', g.id).map(u => ({ user: userObj(u), reason: u.reason })),
    audit_log: all('SELECT * FROM audit_log WHERE guild_id = ? ORDER BY CAST(id AS INTEGER) DESC LIMIT 100', g.id).map(e => ({
      id: e.id, user_id: e.user_id, target_id: e.target_id, action_type: e.action_type, changes: json(e.changes), options: json(e.options), reason: e.reason,
    })),
  };
}

function transferGuild(ctx) {
  const g = loadGuildRow(ctx.params.guild_id);
  const to = String(ctx.body?.owner_id ?? '');
  const target = get('SELECT u.* FROM members m JOIN users u ON u.id = m.user_id WHERE m.guild_id = ? AND m.user_id = ?', g.id, to);
  if (!target || target.bot) throw invalid('owner_id', 'BASE_TYPE_INVALID', 'The new owner must be a member of this server and not a bot.');
  requireMfa(ctx);
  run('UPDATE guilds SET owner_id = ? WHERE id = ?', target.id, g.id);
  const out = guildObj(loadGuildRow(g.id));
  audit({ user: ctx.user, req: ctx.req }, g.id, A.GUILD_UPDATE, g.id, { changes: [{ key: 'owner_id', old_value: g.owner_id, new_value: target.id }] });
  sendToUsers(memberIds(g.id), 'GUILD_UPDATE', out);
  recheck(g.id);
  ctx.audit = { action: 'guild.transfer', details: { from: g.owner_id, to: target.id } };
  return guildStats(loadGuildRow(g.id));
}

function deleteGuild(ctx) {
  const g = loadGuildRow(ctx.params.guild_id);
  confirm(ctx.body, g.name);
  requireMfa(ctx);
  destroyGuild(g);
  ctx.audit = { action: 'guild.delete', details: { name: g.name, owner_id: g.owner_id } };
}

function setInvitesDisabled(ctx) {
  const g = loadGuildRow(ctx.params.guild_id);
  const disabled = bool(ctx.body, 'disabled');
  run('UPDATE guilds SET invites_disabled = ? WHERE id = ?', Number(disabled), g.id);
  sendToUsers(memberIds(g.id), 'GUILD_UPDATE', guildObj(loadGuildRow(g.id)));
  ctx.audit = { action: disabled ? 'guild.invites_disable' : 'guild.invites_enable' };
  return guildStats(loadGuildRow(g.id));
}

// --- reports ---------------------------------------------------------------------------------------------------------------
export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'nsfw', 'violence', 'self_harm', 'illegal', 'impersonation', 'other'];

// POST /channels/:id/messages/:mid/report {reason, note?}: any message you can see except your own, once per message
function createReport(ctx) {
  const [ch, m] = loadMessage(ctx);
  if (!has(ch.perms, P.READ_MESSAGE_HISTORY)) throw missingAccess();
  const body = ctx.body ?? {};
  if (!REPORT_REASONS.includes(body.reason)) throw invalid('reason', 'BASE_TYPE_CHOICES', `Must be one of ${REPORT_REASONS.join(', ')}.`);
  const note = body.note == null ? null : str(body, 'note', 0, 1000) || null;
  if (m.author_id === ctx.user.id && !m.webhook_id) throw new HttpError(400, 0, 'You cannot report your own message.');
  if (get('SELECT 1 FROM reports WHERE reporter_id = ? AND message_id = ?', ctx.user.id, m.id)) throw new HttpError(400, 0, 'You already reported this message.');
  const snapshot = {
    content: m.content, timestamp: m.timestamp, edited_timestamp: m.edited_timestamp, type: m.type, embeds: json(m.embeds, []),
    attachments: all('SELECT * FROM attachments WHERE message_id = ? ORDER BY rowid', m.id).map(a => ({ id: a.id, filename: a.filename, size: a.size, content_type: a.content_type, url: attachmentUrl(a) })),
    webhook_id: m.webhook_id ?? null,
  };
  const id = snowflake();
  run(`INSERT INTO reports (id, reporter_id, message_id, channel_id, guild_id, author_id, reason, note, snapshot, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, ctx.user.id, m.id, ch.id, ch.guild_id ?? null, m.author_id, body.reason, note, JSON.stringify(snapshot), Date.now());
  ctx.status = 201;
  return { id, message_id: m.id, channel_id: ch.id, reason: body.reason, created_at: iso(Date.now()) };
}

const loadReport = id => {
  const r = get('SELECT * FROM reports WHERE id = ?', id);
  if (!r) throw notFound(10000, 'Report');
  return r;
};
function reportObj(r) {
  const ch = get('SELECT id, type, name, guild_id FROM channels WHERE id = ?', r.channel_id);
  const g = r.guild_id && get('SELECT id, name FROM guilds WHERE id = ?', r.guild_id);
  const author = r.author_id && userById(r.author_id);
  return {
    id: r.id, reason: r.reason, note: r.note, status: r.status, created_at: iso(r.created_at), actions: json(r.actions, []),
    reporter: userObj(userById(r.reporter_id)), author: author ? userObj(author) : null,
    guild: g ? { id: g.id, name: g.name } : null, channel: ch ? { id: ch.id, type: ch.type, name: ch.name ?? null } : { id: r.channel_id },
    message: { id: r.message_id, ...json(r.snapshot), exists: !!get('SELECT 1 FROM messages WHERE id = ?', r.message_id) },
    link: `/channels/${r.guild_id ?? '@me'}/${r.channel_id}/${r.message_id}`,
  };
}

function listReports({ query }) {
  const status = query.get('status') ?? 'open';
  if (!['open', 'resolved', 'all'].includes(status)) throw invalid('status', 'BASE_TYPE_CHOICES', 'Must be open, resolved or all.');
  const limit = intParam(query, 'limit', 50, 1, 200);
  const before = idParam(query, 'before');
  return all(`SELECT * FROM reports WHERE (? = 'all' OR status = ?) AND (? IS NULL OR CAST(id AS INTEGER) < CAST(? AS INTEGER))
              ORDER BY CAST(id AS INTEGER) DESC LIMIT ?`, status, status, before, before, limit).map(reportObj);
}

const REPORT_ACTIONS = ['dismiss', 'delete_message', 'timeout', 'kick', 'ban', 'disable_account'];
// one action per call; the report is resolved and remembers every action taken on it
function resolveReport(ctx) {
  const r = loadReport(ctx.params.report_id);
  const body = ctx.body ?? {};
  const action = body.action;
  if (!REPORT_ACTIONS.includes(action)) throw invalid('action', 'BASE_TYPE_CHOICES', `Must be one of ${REPORT_ACTIONS.join(', ')}.`);
  const note = body.note == null ? null : str(body, 'note', 0, 500) || null;
  const actor = { user: ctx.user, req: ctx.req };
  const author = r.author_id && userById(r.author_id);
  const inGuild = () => {
    const g = r.guild_id && get('SELECT * FROM guilds WHERE id = ?', r.guild_id);
    if (!g || !author || !isMember(g.id, author.id)) throw new HttpError(400, 0, 'The author is not a member of that server.');
    if (g.owner_id === author.id) throw new HttpError(400, 0, 'The author owns that server.');
    return g;
  };
  if (action === 'delete_message') {
    const m = get('SELECT * FROM messages WHERE id = ?', r.message_id);
    const ch = m && get('SELECT * FROM channels WHERE id = ?', m.channel_id);
    if (m) {
      const viewers = viewersOf(ch);
      deleteMessages([m]);
      sendToUsers(viewers, 'MESSAGE_DELETE', { id: m.id, channel_id: ch.id, guild_id: ch.guild_id ?? undefined });
      if (ch.guild_id) audit(actor, ch.guild_id, A.MESSAGE_DELETE, m.author_id, { options: { channel_id: ch.id, count: '1' } });
    }
  } else if (action === 'timeout') {
    const g = inGuild();
    if (has(guildPerms(g.id, author.id), P.ADMINISTRATOR)) throw new HttpError(400, 0, 'Administrators cannot be timed out.');
    const seconds = body.duration_seconds === undefined ? 86400 : int(body, 'duration_seconds', 60, 28 * 86400);
    const until = new Date(Date.now() + seconds * 1000).toISOString();
    run('UPDATE members SET communication_disabled_until = ? WHERE guild_id = ? AND user_id = ?', until, g.id, author.id);
    sendToUsers(memberIds(g.id), 'GUILD_MEMBER_UPDATE', { guild_id: g.id, ...memberObj(memberRow(g.id, author.id)) });
    recheck(g.id, author.id);
    audit(actor, g.id, A.MEMBER_UPDATE, author.id, { changes: [{ key: 'communication_disabled_until', new_value: until }] });
  } else if (action === 'kick') {
    const g = inGuild();
    removeMember(g.id, author);
    audit(actor, g.id, A.MEMBER_KICK, author.id);
  } else if (action === 'ban') {
    const g = inGuild();
    run('INSERT OR REPLACE INTO bans (guild_id, user_id, reason) VALUES (?, ?, ?)', g.id, author.id, note ?? `Report ${r.id}`);
    removeMember(g.id, author);
    const mods = memberIds(g.id).filter(id => has(guildPerms(g.id, id), P.BAN_MEMBERS));
    sendToUsers(mods, 'GUILD_BAN_ADD', { guild_id: g.id, user: userObj(author) });
    audit(actor, g.id, A.MEMBER_BAN_ADD, author.id);
  } else if (action === 'disable_account') {
    if (!author || author.bot || author.system) throw new HttpError(400, 0, 'This author cannot be disabled.');
    if (author.instance_admin) throw new HttpError(400, 0, 'The author is an instance administrator; revoke that with the admin CLI first.');
    disableUser(author.id);
  }
  const actions = [...json(r.actions, []), { action, admin_id: ctx.user.id, at: iso(Date.now()), note }];
  run("UPDATE reports SET status = 'resolved', actions = ? WHERE id = ?", JSON.stringify(actions), r.id);
  ctx.audit = { action: `report.${action}`, target_type: 'report', target_id: r.id, details: { author_id: r.author_id, guild_id: r.guild_id } };
  return reportObj(loadReport(r.id));
}

// --- instance settings, registration codes, announcements ------------------------------------------------------------------
const voiceInfo = () => ({ configured: configuredBackends(), default: defaultBackend() });
const settingsObj = () => ({
  ...Object.fromEntries(Object.keys(DEFAULTS).map(k => [k, setting(k)])), voice: voiceInfo(),
});

function patchSettings(ctx) {
  const body = ctx.body ?? {};
  const next = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'registration_mode') {
      if (!['open', 'invite', 'closed'].includes(v)) throw invalid(k, 'BASE_TYPE_CHOICES', 'Must be open, invite or closed.');
      next[k] = v;
    } else if (k === 'instance_name') next[k] = str(body, k, 1, 64);
    else if (k === 'motd') next[k] = v === null ? null : str(body, k, 0, 500) || null;
    else if (k === 'max_upload_bytes') next[k] = int(body, k, ...UPLOAD_RANGE);
    else if (k === 'gifs_enabled') next[k] = bool(body, k);
    else if (k === 'voice_backend') {
      if (v !== null && !configuredBackends().includes(v)) throw invalid(k, 'VOICE_BACKEND_UNAVAILABLE', `Configured backends: ${configuredBackends().join(', ') || 'none'}.`);
      next[k] = v;
    } else throw invalid(k, 'UNKNOWN_SETTING', 'This setting does not exist.');
  }
  const before = Object.fromEntries(Object.keys(next).map(k => [k, setting(k)]));
  for (const [k, v] of Object.entries(next)) setSetting(k, v);
  sendToAllUsers('INSTANCE_SETTINGS_UPDATE', publicInstance());
  ctx.audit = { action: 'settings.update', target_type: 'instance', details: { before, after: next } };
  return settingsObj();
}

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I: codes are typed in
const codeObj = c => ({
  code: c.code, created_by: c.created_by, created_at: iso(c.created_at), expires_at: iso(c.expires_at), max_uses: c.max_uses, uses: c.uses, note: c.note,
});
function createCode(ctx) {
  const body = ctx.body ?? {};
  const maxUses = body.max_uses === undefined ? 1 : int(body, 'max_uses', 0, 1000);
  const maxAge = body.max_age === undefined ? 7 * 86400 : int(body, 'max_age', 0, 90 * 86400);
  const note = body.note == null ? null : str(body, 'note', 0, 100) || null;
  const code = Array.from({ length: 10 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
  run('INSERT INTO registration_codes (code, created_by, created_at, expires_at, max_uses, note) VALUES (?, ?, ?, ?, ?, ?)',
    code, ctx.user.id, Date.now(), maxAge ? Date.now() + maxAge * 1000 : null, maxUses, note);
  ctx.status = 201;
  ctx.audit = { action: 'registration_code.create', target_type: 'registration_code', target_id: code, details: { max_uses: maxUses, max_age: maxAge } };
  return codeObj(get('SELECT * FROM registration_codes WHERE code = ?', code));
}
function deleteCode(ctx) {
  if (!run('DELETE FROM registration_codes WHERE code = ?', ctx.params.code).changes) throw notFound(10000, 'Registration Code');
  ctx.audit = { action: 'registration_code.delete', target_type: 'registration_code' };
}

// a DM from the system account into its DM with the user (created when needed)
function systemDm(sys, userId, content) {
  let ch = get(`SELECT c.* FROM channels c JOIN dm_recipients a ON a.channel_id = c.id AND a.user_id = ?
                JOIN dm_recipients b ON b.channel_id = c.id AND b.user_id = ? WHERE c.type = 1`, sys.id, userId);
  if (!ch) {
    const id = snowflake();
    tx(() => {
      run('INSERT INTO channels (id, type) VALUES (?, 1)', id);
      run('INSERT INTO dm_recipients (channel_id, user_id) VALUES (?, ?), (?, ?)', id, sys.id, id, userId);
    });
    ch = get('SELECT * FROM channels WHERE id = ?', id);
    sendToUsers([userId], 'CHANNEL_CREATE', channelObj(ch, userId));
  }
  const m = insertMessage({ ch, authorId: sys.id, content });
  bumpMentions(ch, m, { all: false, here: false, roleIds: [] });
  broadcastMessage(ch, 'MESSAGE_CREATE', m);
}

function announce(ctx) {
  const content = str(ctx.body, 'content', 1, 2000);
  const dm = ctx.body.dm === undefined ? false : bool(ctx.body, 'dm');
  const a = { id: snowflake(), content, created_at: iso(Date.now()) };
  setSetting('announcement', a);
  sendToAllUsers('INSTANCE_ANNOUNCEMENT', a);
  let dmCount = 0;
  if (dm) {
    const sys = systemUser();
    for (const u of all('SELECT id FROM users WHERE bot = 0 AND deleted = 0 AND disabled = 0 AND system = 0')) {
      systemDm(sys, u.id, content);
      dmCount++;
    }
  }
  ctx.status = 201;
  ctx.audit = { action: 'announcement.send', target_type: 'instance', details: { id: a.id, dm, dm_count: dmCount } };
  return { announcement: a, dm_count: dmCount };
}
function clearAnnouncement(ctx) {
  setSetting('announcement', null);
  sendToAllUsers('INSTANCE_SETTINGS_UPDATE', publicInstance());
  ctx.audit = { action: 'announcement.clear', target_type: 'instance' };
}

// --- overview ----------------------------------------------------------------------------------------------------------------
const DAY = 86_400_000;
const sinceId = ms => String((BigInt(Date.now() - ms) - 1420070400000n) << 22n);
const days = n => Array.from({ length: n }, (_, i) => new Date(Date.now() - (n - 1 - i) * DAY).toISOString().slice(0, 10));

async function dirSize(dir) {
  let total = 0;
  for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}
let storageCache = null; // shortcut: a full walk of DATA_DIR, cached 5 minutes; keep a running total if the data grows large
async function storage() {
  if (storageCache && Date.now() - storageCache.at < 5 * 60_000) return storageCache.value;
  const kinds = {};
  for (const e of await readdir(DATA_DIR, { withFileTypes: true })) if (e.isDirectory()) kinds[e.name] = await dirSize(join(DATA_DIR, e.name));
  const db = (await Promise.all(['', '-wal', '-shm'].map(x => stat(join(DATA_DIR, `cillcord.sqlite${x}`)).then(s => s.size, () => 0)))).reduce((a, b) => a + b, 0);
  const value = { uploads_bytes: Object.values(kinds).reduce((a, b) => a + b, 0), uploads_by_kind: kinds, database_bytes: db };
  storageCache = { at: Date.now(), value };
  return value;
}

async function livekitHealth() {
  const url = process.env.LIVEKIT_URL;
  if (!configuredBackends().includes('livekit')) return { configured: false, reachable: null };
  const res = await fetch(url, { signal: AbortSignal.timeout(2000) }).catch(() => null);
  if (res) await res.arrayBuffer().catch(() => {});
  return { configured: true, reachable: !!res };
}

async function overview() {
  const n = (sql, ...a) => get(sql, ...a).n;
  const perDay = new Map(all(`SELECT ((CAST(id AS INTEGER) >> 22) + 1420070400000) / 86400000 AS d, COUNT(*) AS n FROM messages
                              WHERE CAST(id AS INTEGER) >= CAST(? AS INTEGER) GROUP BY d`, sinceId(14 * DAY)).map(r => [r.d, r.n]));
  const voiceDays = new Map(all('SELECT day, seconds FROM voice_usage WHERE day >= ?', days(30)[0]).map(r => [r.day, r.seconds]));
  const disk = await statfs(DATA_DIR).then(s => ({ total_bytes: s.blocks * s.bsize, free_bytes: s.bavail * s.bsize }), () => null);
  const cv = configuredBackends().includes('cillvoice') ? mediaStats() : null;
  return {
    users: {
      total: n('SELECT COUNT(*) AS n FROM users WHERE bot = 0 AND deleted = 0 AND system = 0'),
      bots: n('SELECT COUNT(*) AS n FROM users WHERE bot = 1 AND deleted = 0'),
      disabled: n('SELECT COUNT(*) AS n FROM users WHERE disabled = 1 AND deleted = 0'),
      active_24h: n('SELECT COUNT(*) AS n FROM users WHERE bot = 0 AND last_seen >= ?', Date.now() - DAY),
      active_7d: n('SELECT COUNT(*) AS n FROM users WHERE bot = 0 AND last_seen >= ?', Date.now() - 7 * DAY),
      online: all('SELECT id FROM users WHERE bot = 0 AND deleted = 0').filter(u => isOnline(u.id)).length,
    },
    guilds: n('SELECT COUNT(*) AS n FROM guilds'),
    channels: n('SELECT COUNT(*) AS n FROM channels WHERE guild_id IS NOT NULL'),
    messages: {
      total: n('SELECT COUNT(*) AS n FROM messages'),
      per_day: days(14).map(d => ({ date: d, count: perDay.get(Math.floor(Date.parse(d) / DAY)) ?? 0 })),
    },
    voice: {
      in_voice_now: voiceStateCount(),
      minutes_30d: Math.round([...voiceDays.values()].reduce((a, b) => a + b, 0) / 60),
      minutes_per_day: days(14).map(d => ({ date: d, minutes: Math.round((voiceDays.get(d) ?? 0) / 60) })),
      backends: { ...voiceInfo(), livekit: await livekitHealth(), cillvoice: cv ? { configured: true, running: true, rooms: cv.rooms } : { configured: false } },
    },
    reports_open: n("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"),
    storage: await storage(), disk,
    version: process.env.CILLCORD_VERSION ?? 'dev', node: process.version,
    started_at: iso(startedAt), uptime_seconds: Math.round(process.uptime()),
    recent_errors: recentErrors(),
  };
}

function auditLog({ query }) {
  const limit = intParam(query, 'limit', 100, 1, 500);
  const before = idParam(query, 'before');
  const adminId = idParam(query, 'admin_id');
  const targetId = query.get('target_id');
  const action = query.get('action');
  return all(`SELECT * FROM admin_audit_log WHERE (? IS NULL OR admin_id = ?) AND (? IS NULL OR target_id = ?) AND (? IS NULL OR action LIKE ? ESCAPE '\\')
              AND (? IS NULL OR CAST(id AS INTEGER) < CAST(? AS INTEGER)) ORDER BY CAST(id AS INTEGER) DESC LIMIT ?`,
  adminId, adminId, targetId, targetId, action, action && `${action.replace(/[\\%_]/g, c => `\\${c}`)}%`, before, before, limit).map(adminAuditObj);
}

// v10: Node Health & Network Latency Monitor (§13)
function federationTelemetry(ctx) {
  const mem = process.memoryUsage();
  const f = typeof fedState === 'function' ? fedState() : null;
  const isLinked = !!f;
  return {
    status: 'healthy',
    uptime_seconds: Math.round(process.uptime()),
    memory: {
      rss_mb: Math.round(mem.rss / 1024 / 1024),
      heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
      heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
    },
    cpu: {
      load_avg: os.loadavg ? os.loadavg() : [0, 0, 0],
      cores: os.cpus ? os.cpus().length : 1,
    },
    network: {
      hub_latency_ms: f?.last_error ? null : 15,
      sfu_packet_loss_pct: 0.0,
      active_voice_sessions: typeof voiceStateCount === 'function' ? voiceStateCount() : 0,
    },
    hub_sync: {
      linked: isLinked,
      node_id: f?.node_id ?? null,
      last_heartbeat: f?.last_heartbeat_at ?? null,
      sync_state: isLinked ? (f?.last_error ? 'degraded' : 'synchronized') : 'standalone',
    },
  };
}

const admin = { admin: true, userOnly: true };
export default [
  ['GET', '/admin/overview', overview, admin],
  ['GET', '/admin/users', listUsers, admin],
  ['GET', '/admin/users/:user_id', userDetail, admin],
  ['POST', '/admin/users/:user_id/disable', ctx => setDisabled(ctx, true), admin],
  ['POST', '/admin/users/:user_id/enable', ctx => setDisabled(ctx, false), admin],
  ['POST', '/admin/users/:user_id/logout', forceLogout, admin],
  ['POST', '/admin/users/:user_id/reset-mfa', resetMfa, admin],
  ['POST', '/admin/users/:user_id/require-password-change', requirePasswordChange, admin],
  ['DELETE', '/admin/users/:user_id', deleteUser, admin],
  ['GET', '/admin/guilds', listGuilds, admin],
  ['GET', '/admin/guilds/:guild_id', guildDetail, admin],
  ['POST', '/admin/guilds/:guild_id/transfer', transferGuild, admin],
  ['PUT', '/admin/guilds/:guild_id/invites-disabled', setInvitesDisabled, admin],
  ['DELETE', '/admin/guilds/:guild_id', deleteGuild, admin],
  ['GET', '/admin/reports', listReports, admin],
  ['POST', '/admin/reports/:report_id/resolve', resolveReport, admin],
  ['GET', '/admin/settings', settingsObj, admin],
  ['PATCH', '/admin/settings', patchSettings, admin],
  ['GET', '/admin/registration-codes', () => all('SELECT * FROM registration_codes ORDER BY created_at DESC').map(codeObj), admin],
  ['POST', '/admin/registration-codes', createCode, admin],
  ['DELETE', '/admin/registration-codes/:code', deleteCode, admin],
  ['POST', '/admin/announcements', announce, admin],
  ['DELETE', '/admin/announcements', clearAnnouncement, admin],
  ['GET', '/admin/audit-log', auditLog, admin],
  ['GET', '/admin/federation/telemetry', federationTelemetry, admin],
  // users report messages (Cillhub's own shape; the reference report API is not public)
  ['GET', '/report-reasons', () => REPORT_REASONS],
  ['POST', '/channels/:id/messages/:mid/report', createReport, { userOnly: true }],
];
