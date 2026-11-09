import { randomInt } from 'node:crypto';
import { snowflake } from '../snowflake.js';
import { get, all, run, tx, json, isMember, memberIds, memberRow, memberObj, userById, userObj, guildObj, featuresOf } from '../db.js';
import { HttpError, int, notFound, missingPermissions } from '../errors.js';
import { P, need, has, guildPerms, visibleChannels } from '../permissions.js';
import { sendToUsers, statusOf } from '../gateway.js';
import { loadChannel } from './channels.js';
import { audit, A } from '../audit.js';
import { loadGuild, guildCreate } from './guilds.js';
import { welcomeFor, gateEnabled } from './community.js';
import { getMessage, broadcastMessage } from '../message.js';
import { recordGuildMetric } from '../analytics.js';

const invitesPaused = () => new HttpError(403, 0, 'Invites to this server are disabled by the instance administrator.');
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

function inviteObj(inv) {
  const g = get('SELECT * FROM guilds WHERE id = ?', inv.guild_id);
  const ch = get('SELECT * FROM channels WHERE id = ?', inv.channel_id);
  const welcome = welcomeFor(g);
  return {
    type: 0, code: inv.code,
    guild: {
      id: g.id, name: g.name, icon: g.icon, description: g.description, features: featuresOf(g), verification_level: g.verification_level,
      vanity_url_code: g.vanity_url_code, ...(welcome && { welcome_screen: welcome }),
      banner: g.banner ?? null, splash: g.splash ?? null, brand_color_primary: json(g.profile, {}).brand_color_primary ?? null, // v6
    },
    channel: ch && { id: ch.id, name: ch.name, type: ch.type },
    inviter: inv.inviter_id ? userObj(userById(inv.inviter_id)) : null, uses: inv.uses, max_uses: inv.max_uses, max_age: inv.max_age,
    created_at: inv.created_at, expires_at: inv.expires_at === null ? null : new Date(inv.expires_at).toISOString(),
  };
}

// expired and used-up invites count as unknown; a guild's vanity code resolves like an invite to its first text channel
function findInvite(code) {
  const inv = get(`SELECT * FROM invites WHERE code = ? AND (expires_at IS NULL OR expires_at > ?)
                   AND (max_uses = 0 OR uses < max_uses)`, code, Date.now());
  if (inv) return inv;
  const g = get('SELECT * FROM guilds WHERE vanity_url_code = ? OR vanity_code = ?', code, code);
  if (!g) throw notFound(10006, 'Invite');
  const ch = get('SELECT id FROM channels WHERE guild_id = ? AND type = 0 ORDER BY id = ? DESC, position LIMIT 1', g.id, g.system_channel_id ?? '');
  return { code, guild_id: g.id, channel_id: ch?.id, inviter_id: null, uses: g.vanity_uses ?? 0, max_uses: 0, max_age: 0, created_at: null, expires_at: null, vanity: true };
}

// with_counts=true is the documented opt-in for the member count on an invite preview
function getInvite({ params, query }) {
  const inv = findInvite(params.code);
  return query.get('with_counts') === 'true' ? { ...inviteObj(inv), approximate_member_count: memberIds(inv.guild_id).length } : inviteObj(inv);
}

function createInvite(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  if (!ch.guild_id) throw new HttpError(400, 0, 'Cannot create an invite for a DM channel');
  if ([10, 11, 12].includes(ch.type)) throw new HttpError(400, 50024, 'Cannot execute action on this channel type');
  need(ch.perms, P.CREATE_INSTANT_INVITE);
  if (get('SELECT invites_disabled FROM guilds WHERE id = ?', ch.guild_id).invites_disabled) throw invitesPaused();
  const maxAge = ctx.body?.max_age === undefined ? 86400 : int(ctx.body, 'max_age', 0, 604800);
  const maxUses = ctx.body?.max_uses === undefined ? 0 : int(ctx.body, 'max_uses', 0, 100);
  const code = Array.from({ length: 8 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  run('INSERT INTO invites (code, guild_id, channel_id, inviter_id, expires_at, max_age, max_uses, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    code, ch.guild_id, ch.id, ctx.user.id, maxAge ? Date.now() + maxAge * 1000 : null, maxAge, maxUses, new Date().toISOString());
  ctx.status = 201;
  const out = inviteObj(get('SELECT * FROM invites WHERE code = ?', code));
  audit(ctx, ch.guild_id, A.INVITE_CREATE, code, { changes: [
    { key: 'code', new_value: code }, { key: 'channel_id', new_value: ch.id }, { key: 'max_age', new_value: maxAge }, { key: 'max_uses', new_value: maxUses },
  ] });
  return out;
}

function revoke(ctx) {
  const { params, user } = ctx;
  const inv = get('SELECT * FROM invites WHERE code = ?', params.code);
  if (!inv) throw notFound(10006, 'Invite');
  if (inv.inviter_id !== user.id && !has(guildPerms(inv.guild_id, user.id), P.MANAGE_GUILD)) throw missingPermissions();
  run('DELETE FROM invites WHERE code = ?', inv.code);
  audit(ctx, inv.guild_id, A.INVITE_DELETE, inv.code, { changes: [{ key: 'code', old_value: inv.code }, { key: 'channel_id', old_value: inv.channel_id }] });
  return inviteObj(inv);
}

function join({ params, user }) {
  const inv = findInvite(params.code);
  const g = get('SELECT * FROM guilds WHERE id = ?', inv.guild_id);
  if (isMember(g.id, user.id)) return guildObj(g, visibleChannels(g.id, user.id));
  return addToGuild(g, user, inv);
}

const recentJoins = new Map();

export function checkAntiRaid(g, userId) {
  const cfg = json(g.anti_raid);
  if (!cfg?.enabled) return false;
  const now = Date.now();
  let list = (recentJoins.get(g.id) || []).filter(t => now - t < 60000);
  list.push(now);
  recentJoins.set(g.id, list);

  const threshold = cfg.join_threshold_per_minute || 10;
  if (list.length >= threshold) {
    if (cfg.auto_pause_invites && !g.invites_disabled) {
      run('UPDATE guilds SET invites_disabled = 1 WHERE id = ?', g.id);
    }
    if (cfg.quarantine_role_id) {
      run('INSERT OR IGNORE INTO member_roles (guild_id, user_id, role_id) SELECT guild_id, ?, id FROM roles WHERE id = ? AND guild_id = ? AND id != guild_id', userId, cfg.quarantine_role_id, g.id);
    }
    sendToUsers(memberIds(g.id), 'GUILD_RAID_ALERT', {
      guild_id: g.id,
      joins_count: list.length,
      threshold,
      timestamp: new Date().toISOString(),
      invites_paused: !!cfg.auto_pause_invites,
    });
    return true;
  }
  return false;
}

// a new member through an invite, or (inv null) through Join Guild from the server directory (v7, routes/directory.js)
export function addToGuild(g, user, inv = null) {
  if (get('SELECT 1 FROM bans WHERE guild_id = ? AND user_id = ?', g.id, user.id)) throw new HttpError(403, 40007, 'You are banned from this guild');
  if (g.invites_disabled) throw invitesPaused();
  // v6: the join message carries one of the server's greeting templates ({user} = the new member), or '' (client default)
  const templates = json(g.greeting_templates, []);
  const greeting = templates.length ? templates[randomInt(templates.length)] : '';
  const joined_at = new Date().toISOString();
  const sys = get('SELECT * FROM channels WHERE id = ? AND type = 0', g.system_channel_id);
  const messageId = snowflake();
  tx(() => {
    // with rules screening on, a new member waits as pending until they accept
    run('INSERT INTO members (guild_id, user_id, joined_at, pending) VALUES (?, ?, ?, ?)', g.id, user.id, joined_at, Number(gateEnabled(g)));
    recordGuildMetric(g.id, 'joins', 1);
    if (inv?.vanity) run('UPDATE guilds SET vanity_uses = vanity_uses + 1 WHERE id = ?', g.id);
    else if (inv) run('UPDATE invites SET uses = uses + 1 WHERE code = ?', inv.code);
    if (sys) {
      run('INSERT INTO messages (id, channel_id, author_id, content, timestamp, type) VALUES (?, ?, ?, ?, ?, 7)', messageId, sys.id, user.id, greeting, joined_at);
      run('UPDATE channels SET last_message_id = ? WHERE id = ?', messageId, sys.id);
    }
  });
  const ids = memberIds(g.id);
  sendToUsers([user.id], 'GUILD_CREATE', guildCreate(g, user.id));
  sendToUsers(ids, 'GUILD_MEMBER_ADD', { ...memberObj(memberRow(g.id, user.id)), guild_id: g.id });
  checkAntiRaid(g, user.id);
  const status = statusOf(user.id);
  if (status !== 'offline') sendToUsers(ids, 'PRESENCE_UPDATE', { user: { id: user.id }, status, guild_id: g.id });
  if (sys) broadcastMessage(sys, 'MESSAGE_CREATE', getMessage(messageId));
  return guildObj(g, visibleChannels(g.id, user.id));
}

export default [
  ['POST', '/channels/:id/invites', createInvite],
  ['GET', '/guilds/:id/invites', ({ params, user }) => all(
    'SELECT * FROM invites WHERE guild_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY created_at',
    loadGuild(params.id, user, P.MANAGE_GUILD).id, Date.now(),
  ).map(inviteObj)],
  ['GET', '/invites/:code', getInvite, { open: true }],
  ['POST', '/invites/:code', join, { userOnly: true }],
  ['DELETE', '/invites/:code', revoke],
];
