// Recent mentions inbox and bulk acks (user docs)
import { get, all, run } from '../db.js';
import { invalid, intParam, idParam } from '../errors.js';
import { P, has, channelPerms } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { messageObj, getChannel } from '../message.js';
import { addJob } from '../timers.js';

const WEEK = 7 * 24 * 3600 * 1000;

// mentions of the last 7 days, newest first, only from channels the user can still read
function mentions({ query, user }) {
  const limit = intParam(query, 'limit', 25, 1, 100);
  const before = idParam(query, 'before');
  const guildId = idParam(query, 'guild_id');
  const kinds = ['user', ...(query.get('roles') === 'false' ? [] : ['role']), ...(query.get('everyone') === 'false' ? [] : ['everyone'])];
  const rows = all(`SELECT r.message_id, r.channel_id FROM recent_mentions r WHERE r.user_id = ? AND r.created_at > ?
                      AND (? IS NULL OR CAST(r.message_id AS INTEGER) < CAST(? AS INTEGER)) AND (? IS NULL OR r.guild_id = ?)
                      AND r.kind IN (${kinds.map(() => '?').join(', ')})
                    ORDER BY CAST(r.message_id AS INTEGER) DESC`, user.id, Date.now() - WEEK, before, before, guildId, guildId, ...kinds);
  const out = [];
  for (const r of rows) {
    const ch = getChannel(r.channel_id);
    if (!ch || !has(channelPerms(ch, user.id), P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY)) continue;
    out.push(messageObj(get('SELECT * FROM messages WHERE id = ?', r.message_id), ch, user.id));
    if (out.length === limit) break;
  }
  return out;
}

function deleteMention({ params, user }) {
  if (run('DELETE FROM recent_mentions WHERE user_id = ? AND message_id = ?', user.id, params.message_id).changes) {
    sendToUsers([user.id], 'RECENT_MENTION_DELETE', { message_id: params.message_id });
  }
}

// POST /read-states/ack-bulk {read_states: [{channel_id, message_id}]}: channel read states only; unreadable channels are skipped
function ackBulk({ body, user }) {
  const list = body?.read_states;
  if (!Array.isArray(list) || list.length > 100) throw invalid('read_states', 'BASE_TYPE_BAD_LENGTH', 'Must be a list of at most 100 read states.');
  for (const r of list) {
    const ok = r && (r.read_state_type ?? 0) === 0 && /^\d{1,19}$/.test(String(r.channel_id)) && /^[1-9]\d{0,18}$/.test(String(r.message_id));
    const ch = ok && getChannel(String(r.channel_id));
    if (!ch || !has(channelPerms(ch, user.id), P.VIEW_CHANNEL)) continue;
    run(`INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES (?, ?, ?, 0)
         ON CONFLICT DO UPDATE SET last_message_id = excluded.last_message_id, mention_count = 0`, user.id, ch.id, String(r.message_id));
    sendToUsers([user.id], 'MESSAGE_ACK', { channel_id: ch.id, message_id: String(r.message_id) });
  }
}

addJob({
  name: 'recent mentions retention',
  next: () => null,
  run: now => run('DELETE FROM recent_mentions WHERE created_at <= ?', now - WEEK),
});

const user = { userOnly: true };
export default [
  ['GET', '/users/@me/mentions', mentions, user],
  ['DELETE', '/users/@me/mentions/:message_id', deleteMention, user],
  ['POST', '/read-states/ack-bulk', ackBulk, user],
];
