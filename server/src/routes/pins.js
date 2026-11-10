import { get, all, run } from '../db.js';
import { HttpError, notFound } from '../errors.js';
import { P, need, viewersOf } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { audit, A } from '../audit.js';
import { loadChannel } from './channels.js';
import { requireUnarchived, forViewer } from './messages.js';
import { messageObj, getMessage, broadcastMessage } from '../message.js';

function load({ params, user }) {
  const ch = loadChannel(params.id, user);
  if (ch.guild_id) need(ch.perms, P.MANAGE_MESSAGES); // in a DM either participant may pin
  const m = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', params.mid, ch.id);
  if (!m) throw notFound(10008, 'Message');
  return [ch, m];
}

function announce(ch, m) {
  broadcastMessage(ch, 'MESSAGE_UPDATE', getMessage(m.id));
  const last = get('SELECT MAX(pinned_at) AS t FROM messages WHERE channel_id = ?', ch.id).t;
  sendToUsers(viewersOf(ch), 'CHANNEL_PINS_UPDATE', { channel_id: ch.id, guild_id: ch.guild_id ?? undefined, last_pin_timestamp: last });
}

const auditPin = (ctx, ch, m, action) => ch.guild_id && audit(ctx, ch.guild_id, action, m.webhook_id ?? m.author_id, { options: { channel_id: ch.id, message_id: m.id } });

function pin(ctx) {
  const [ch, m] = load(ctx);
  requireUnarchived(ch);
  if (m.pinned_at) return;
  if (get('SELECT COUNT(*) AS n FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL', ch.id).n >= 50) {
    throw new HttpError(400, 30003, 'Maximum number of pins reached (50)');
  }
  run('UPDATE messages SET pinned_at = ? WHERE id = ?', new Date().toISOString(), m.id);
  announce(ch, m);
  auditPin(ctx, ch, m, A.MESSAGE_PIN);
}

function unpin(ctx) {
  const [ch, m] = load(ctx);
  if (!m.pinned_at) return;
  run('UPDATE messages SET pinned_at = NULL WHERE id = ?', m.id);
  announce(ch, m);
  auditPin(ctx, ch, m, A.MESSAGE_UNPIN);
}

function list({ params, user }) {
  const ch = loadChannel(params.id, user);
  need(ch.perms, P.READ_MESSAGE_HISTORY);
  return all('SELECT * FROM messages WHERE channel_id = ? AND pinned_at IS NOT NULL ORDER BY pinned_at DESC', ch.id).map(m => forViewer(messageObj(m, ch, user.id), user));
}

export default [
  ['GET', '/channels/:id/pins', list],
  ['PUT', '/channels/:id/pins/:mid', pin],
  ['DELETE', '/channels/:id/pins/:mid', unpin],
];
