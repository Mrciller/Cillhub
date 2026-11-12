import { get, run, channelUserIds } from '../db.js';
import { invalid } from '../errors.js';
import { sendToUsers } from '../gateway.js';
import { settingsOf } from '../userdata.js';
import { loadChannel } from './channels.js';

function ack({ params, user }) {
  const ch = loadChannel(params.id, user);
  if (!/^\d{1,19}$/.test(params.mid)) throw invalid('message_id', 'NUMBER_TYPE_COERCE', 'Value is not a snowflake.');
  // ids of deleted messages are fine, ids past the newest message are cut back to it (an empty channel: its own id);
  // an older ack than the stored one (a second device behind) changes nothing
  const newest = ch.last_message_id ?? ch.id;
  const asked = BigInt(params.mid) > BigInt(newest) ? newest : params.mid;
  run(`INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES (?, ?, ?, 0)
       ON CONFLICT DO UPDATE SET last_message_id = excluded.last_message_id, mention_count = 0
       WHERE last_message_id IS NULL OR CAST(last_message_id AS INTEGER) <= CAST(excluded.last_message_id AS INTEGER)`, user.id, ch.id, asked);
  const mid = get('SELECT last_message_id FROM read_states WHERE user_id = ? AND channel_id = ?', user.id, ch.id).last_message_id;
  sendToUsers([user.id], 'MESSAGE_ACK', { channel_id: ch.id, message_id: mid });

  if ((ch.type === 1 || ch.type === 3) && settingsOf(user.id).privacy?.dm_read_receipts !== false) {
    const recipients = channelUserIds(ch);
    sendToUsers(recipients, 'CHANNEL_RECIPIENT_ACK', { channel_id: ch.id, user_id: user.id, message_id: mid });
    const others = recipients.filter(id => id !== user.id);
    if (others.length) sendToUsers(others, 'MESSAGE_ACK', { channel_id: ch.id, message_id: mid, user_id: user.id });
  }

  return { token: null };
}

export default [['POST', '/channels/:id/messages/:mid/ack', ack, { userOnly: true }]];
