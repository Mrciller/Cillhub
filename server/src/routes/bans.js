import { get, all, run, isMember, memberIds, userById, userObj } from '../db.js';
import { str, int, notFound } from '../errors.js';
import { P, has, guildPerms, viewersOf, requireAbove } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { audit, A } from '../audit.js';
import { loadGuild, removeMember } from './guilds.js';
import { deleteMessages } from '../message.js';

const moderators = guildId => memberIds(guildId).filter(id => has(guildPerms(guildId, id), P.BAN_MEMBERS));

function ban(ctx) {
  const { params, body, user } = ctx;
  const g = loadGuild(params.id, user, P.BAN_MEMBERS);
  const target = userById(params.user_id);
  if (!target) throw notFound(10013, 'User');
  requireAbove(g.id, user.id, target.id);
  const reason = body?.reason == null ? null : str(body, 'reason', 0, 512) || null;
  const seconds = body?.delete_message_seconds === undefined ? 0 : int(body, 'delete_message_seconds', 0, 604800);
  run('INSERT OR REPLACE INTO bans (guild_id, user_id, reason) VALUES (?, ?, ?)', g.id, target.id, reason);
  if (isMember(g.id, target.id)) removeMember(g.id, target);
  if (seconds) {
    const since = new Date(Date.now() - seconds * 1000).toISOString();
    const rows = all(`SELECT m.* FROM messages m JOIN channels c ON c.id = m.channel_id
                      WHERE c.guild_id = ? AND m.author_id = ? AND m.timestamp > ?`, g.id, target.id, since);
    deleteMessages(rows);
    for (const channelId of new Set(rows.map(m => m.channel_id))) {
      const ch = get('SELECT * FROM channels WHERE id = ?', channelId);
      const ids = rows.filter(m => m.channel_id === channelId).map(m => m.id);
      sendToUsers(viewersOf(ch), 'MESSAGE_DELETE_BULK', { ids, channel_id: channelId, guild_id: g.id });
    }
  }
  sendToUsers(moderators(g.id), 'GUILD_BAN_ADD', { guild_id: g.id, user: userObj(target) });
  audit(ctx, g.id, A.MEMBER_BAN_ADD, target.id);
}

function unban(ctx) {
  const { params, user } = ctx;
  const g = loadGuild(params.id, user, P.BAN_MEMBERS);
  if (!run('DELETE FROM bans WHERE guild_id = ? AND user_id = ?', g.id, params.user_id).changes) throw notFound(10026, 'Ban');
  sendToUsers(moderators(g.id), 'GUILD_BAN_REMOVE', { guild_id: g.id, user: userObj(userById(params.user_id)) });
  audit(ctx, g.id, A.MEMBER_BAN_REMOVE, params.user_id);
}

export default [
  ['GET', '/guilds/:id/bans', ({ params, user }) => all(
    'SELECT u.*, b.reason FROM bans b JOIN users u ON u.id = b.user_id WHERE b.guild_id = ?', loadGuild(params.id, user, P.BAN_MEMBERS).id,
  ).map(u => ({ user: userObj(u), reason: u.reason }))],
  ['PUT', '/guilds/:id/bans/:user_id', ban],
  ['DELETE', '/guilds/:id/bans/:user_id', unban],
];
