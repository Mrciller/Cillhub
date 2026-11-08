import { run, channelUserIds } from '../db.js';
import { invalid } from '../errors.js';
import { sendToUsers } from '../gateway.js';
import { settingsOf } from '../userdata.js';
import { loadChannel } from './channels.js';

function ack({ params, user }) {
  const ch = loadChannel(params.id, user);
  if (!/^\d{1,19}$/.test(params.mid)) throw invalid('message_id', 'NUMBER_TYPE_COERCE', 'Value is not a snowflake.');
  run(`INSERT INTO read_states (user_id, channel_id, last_message_id, mention_count) VALUES (?, ?, ?, 0)
       ON CONFLICT DO UPDATE SET last_message_id = excluded.last_message_id, mention_count = 0`, user.id, ch.id, params.mid);
  sendToUsers([user.id], 'MESSAGE_ACK', { channel_id: ch.id, message_id: params.mid });

  if ((ch.type === 1 || ch.type === 3) && settingsOf(user.id).privacy?.dm_read_receipts !== false) {
    const recipients = channelUserIds(ch);
    sendToUsers(recipients, 'CHANNEL_RECIPIENT_ACK', { channel_id: ch.id, user_id: user.id, message_id: params.mid });
    const others = recipients.filter(id => id !== user.id);
    if (others.length) sendToUsers(others, 'MESSAGE_ACK', { channel_id: ch.id, message_id: params.mid, user_id: user.id });
  }

  return { token: null };
}

export default [['POST', '/channels/:id/messages/:mid/ack', ack, { userOnly: true }]];
