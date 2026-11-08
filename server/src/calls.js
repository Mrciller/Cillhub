// DM and group DM calls: who is in the call lives in the voice states, the call object and its ringing list live here
import { get, all, run, json, channelUserIds } from './db.js';
import { sendToUsers, sendToSession } from './gateway.js';
import { statesIn, voiceStateObj, joinHooks, leaveHooks } from './voice.js';
import { insertMessage, broadcastMessage, getMessage, getChannel } from './message.js';
import { blockedEither } from './routes/relationships.js';
import { pushTo } from './push.js';

const calls = new Map(); // channel id -> { channel_id, message_id, ringing: Set }

export const callObj = c => ({
  channel_id: c.channel_id, message_id: c.message_id, region: 'cillhub', ringing: [...c.ringing],
  voice_states: statesIn(c.channel_id).map(v => voiceStateObj(v)),
});
const update = c => sendToUsers(channelUserIds({ id: c.channel_id }), 'CALL_UPDATE', (({ voice_states, ...rest }) => rest)(callObj(c)));

// the call message (type 3) records who took part and when it ended
function editCallMessage(c, change) {
  const m = getMessage(c.message_id);
  if (!m) return;
  const call = change(json(m.call, { participants: [], ended_timestamp: null }));
  run('UPDATE messages SET call = ? WHERE id = ?', JSON.stringify(call), m.id);
  broadcastMessage(getChannel(m.channel_id), 'MESSAGE_UPDATE', getMessage(m.id));
}

export const activeCall = channelId => calls.get(channelId);
export const callsOf = userId => all('SELECT channel_id FROM dm_recipients WHERE user_id = ?', userId)
  .map(r => calls.get(r.channel_id)).filter(Boolean).map(callObj);

joinHooks.push((v, ch) => {
  let c = calls.get(ch.id);
  if (!c) {
    const m = insertMessage({ ch, authorId: v.user_id, type: 3, call: { participants: [v.user_id], ended_timestamp: null } });
    broadcastMessage(ch, 'MESSAGE_CREATE', m);
    c = { channel_id: ch.id, message_id: m.id, ringing: new Set() };
    calls.set(ch.id, c);
    return sendToUsers(channelUserIds(ch), 'CALL_CREATE', callObj(c));
  }
  editCallMessage(c, call => ({ ...call, participants: [...new Set([...call.participants, v.user_id])] }));
  if (c.ringing.delete(v.user_id)) update(c);
});

// a call ends when its last participant leaves
leaveHooks.push(v => {
  const c = !v.guild_id && calls.get(v.channel_id);
  if (!c || statesIn(c.channel_id).length) return;
  calls.delete(c.channel_id);
  editCallMessage(c, call => ({ ...call, ended_timestamp: new Date().toISOString() }));
  sendToUsers(channelUserIds({ id: c.channel_id }), 'CALL_DELETE', { channel_id: c.channel_id });
});

// rings the given recipients (default: everyone not in the call); nobody who blocked the caller, or was blocked by them, rings
export function ring(ch, caller, recipients) {
  const c = calls.get(ch.id);
  if (!c) return;
  const inCall = new Set(statesIn(ch.id).map(v => v.user_id));
  const members = channelUserIds(ch);
  const targets = (recipients ?? members).filter(id => members.includes(id) && id !== caller.id && !inCall.has(id) && !blockedEither(caller.id, id));
  const fresh = targets.filter(id => !c.ringing.has(id));
  targets.forEach(id => c.ringing.add(id));
  update(c);
  const name = caller.global_name ?? caller.username;
  pushTo(fresh, ch, 'dm', { title: 'Incoming call', body: `${name} is calling you`, url: `/channels/@me/${ch.id}`, tag: `call-${ch.id}` }, { type: 'call', channel_id: ch.id });
}

export function stopRinging(ch, userIds) {
  const c = calls.get(ch.id);
  if (!c) return;
  if (userIds.filter(id => c.ringing.delete(id)).length) update(c);
}

// gateway op 13 (Request Call Connect): the call of one private channel, if there is one
export function callConnect(s, d) {
  const id = String(d?.channel_id ?? '');
  const c = calls.get(id);
  if (c && get('SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?', id, s.user.id)) sendToSession(s, 'CALL_CREATE', callObj(c));
}

