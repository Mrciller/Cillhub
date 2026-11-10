// Group DMs (type 3: recipients, name, icon, owner) and DM/group call ringing, per the user docs
import { snowflake } from '../snowflake.js';
import { get, all, run, tx, isFriend, userById, userObj, channelObj, channelUserIds } from '../db.js';
import { HttpError, str, int, invalid, notFound, missingAccess, missingPermissions, snowflakes } from '../errors.js';
import { sendToUsers } from '../gateway.js';
import { saveImage, removeImage, removeChannelFiles } from '../files.js';
import { disconnectChannel, disconnectFromChannel } from '../voice.js';
import { ring, stopRinging, activeCall } from '../calls.js';
import { blockedEither } from './relationships.js';
import { schedule } from '../timers.js';
import { limit } from '../ratelimit.js';

const MAX_RECIPIENTS = 10; // including the owner (docs)
const getChannel = id => get('SELECT * FROM channels WHERE id = ?', id);
const isRecipient = (channelId, userId) => !!get('SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?', channelId, userId);

// a DM or group DM the user is in
function loadPrivate(id, user, types = [1, 3]) {
  const ch = getChannel(id);
  if (!ch) throw notFound(10003, 'Channel');
  if (!isRecipient(ch.id, user.id)) throw missingAccess();
  if (!types.includes(ch.type)) throw new HttpError(400, 50024, 'Cannot execute action on this channel type');
  return ch;
}

// group members must be friends of whoever adds them and must not have blocked them (or be blocked)
function checkAddable(adder, id) {
  const u = userById(id);
  if (!u || u.deleted) throw notFound(10013, 'User');
  if (u.bot || !isFriend(adder.id, id) || blockedEither(adder.id, id)) throw new HttpError(403, 50007, 'Cannot send messages to this user');
}

export function insertGroup(owner, ids, originId, name = null) {
  const id = snowflake();
  tx(() => {
    run('INSERT INTO channels (id, type, owner_id, name) VALUES (?, 3, ?, ?)', id, owner.id, name);
    for (const uid of [owner.id, ...ids]) run('INSERT INTO dm_recipients (channel_id, user_id) VALUES (?, ?)', id, uid);
  });
  const ch = getChannel(id);
  sendToUsers([owner.id, ...ids], 'CHANNEL_CREATE', uid => ({ ...channelObj(ch, uid), ...(originId && { origin_channel_id: originId }) }));
  return channelObj(ch, owner.id);
}

// POST /users/@me/channels with recipients: none or several (or yourself included) make a group, up to 9 others
export function createGroup(user, body) {
  if (user.bot) throw new HttpError(403, 20001, 'Bots cannot use this endpoint');
  const ids = snowflakes(body, 'recipients', MAX_RECIPIENTS).filter(id => id !== user.id);
  if (ids.length > MAX_RECIPIENTS - 1) throw new HttpError(400, 30014, 'Maximum number of recipients reached (10)');
  ids.forEach(id => checkAddable(user, id));
  return insertGroup(user, ids);
}

// PUT /channels/:id/recipients/:user_id: on a group 204 + CHANNEL_RECIPIENT_ADD; on a DM a new group with all three
function addRecipient({ params, user }) {
  const ch = loadPrivate(params.id, user);
  if (isRecipient(ch.id, params.user_id)) return ch.type === 3 ? undefined : channelObj(ch, user.id);
  checkAddable(user, params.user_id);
  if (ch.type === 1) return insertGroup(user, [...channelUserIds(ch).filter(id => id !== user.id), params.user_id], ch.id);
  if (channelUserIds(ch).length >= MAX_RECIPIENTS) throw new HttpError(400, 30014, 'Maximum number of recipients reached (10)');
  run('INSERT INTO dm_recipients (channel_id, user_id) VALUES (?, ?)', ch.id, params.user_id);
  sendToUsers([params.user_id], 'CHANNEL_CREATE', channelObj(ch, params.user_id));
  sendToUsers(channelUserIds(ch).filter(id => id !== params.user_id), 'CHANNEL_RECIPIENT_ADD', { channel_id: ch.id, user: userObj(userById(params.user_id)) });
}

// someone leaves or is removed: the rest hear CHANNEL_RECIPIENT_REMOVE, the leaver CHANNEL_DELETE; ownership passes on; the last one deletes it
export function leaveGroup(channelId, u) {
  const ch = getChannel(channelId);
  if (!ch || !isRecipient(ch.id, u.id)) return;
  const gone = channelObj(ch, u.id);
  stopRinging(ch, [u.id]);
  disconnectFromChannel(ch.id, u.id);
  run('DELETE FROM dm_recipients WHERE channel_id = ? AND user_id = ?', ch.id, u.id);
  const rest = channelUserIds(ch);
  sendToUsers([u.id], 'CHANNEL_DELETE', gone);
  if (!rest.length) {
    disconnectChannel(ch.id);
    run('DELETE FROM channels WHERE id = ?', ch.id);
    removeChannelFiles(ch.id);
    removeImage('channel-icons', ch.id, ch.icon);
    return;
  }
  sendToUsers(rest, 'CHANNEL_RECIPIENT_REMOVE', { channel_id: ch.id, user: userObj(u) });
  if (ch.owner_id === u.id) {
    run('UPDATE channels SET owner_id = ? WHERE id = ?', rest[0], ch.id);
    sendToUsers(rest, 'CHANNEL_UPDATE', uid => channelObj(getChannel(ch.id), uid));
  }
}

function removeRecipient({ params, user }) {
  const ch = loadPrivate(params.id, user, [3]);
  if (params.user_id !== user.id && ch.owner_id !== user.id) throw missingPermissions();
  const target = userById(params.user_id);
  if (!target || !isRecipient(ch.id, target.id)) throw notFound(10013, 'User');
  leaveGroup(ch.id, target);
}

// PATCH /channels/:id on a group: name and icon by any member, owner (transfer) by the owner
export async function patchGroup(ctx, ch) {
  const body = ctx.body ?? {};
  const next = {};
  if (body.name !== undefined) next.name = body.name === null ? null : str(body, 'name', 0, 100) || null;
  if (body.message_ttl !== undefined) next.message_ttl = body.message_ttl === null ? 0 : int(body, 'message_ttl', 0, 31536000);
  if (body.icon !== undefined) next.icon = await saveImage(body.icon, 'icon', 'channel-icons', ch.id);
  if (body.owner !== undefined && body.owner !== ch.owner_id) {
    if (ch.owner_id !== ctx.user.id) throw missingPermissions();
    if (!isRecipient(ch.id, String(body.owner))) throw invalid('owner', 'BASE_TYPE_INVALID', 'The new owner must be a recipient.');
    next.owner_id = String(body.owner);
  }
  for (const [k, v] of Object.entries(next)) run(`UPDATE channels SET ${k} = ? WHERE id = ?`, v, ch.id); // keys are fixed above
  // like a 1:1 DM: the lifetime covers messages from now on, what members sent before stays
  if (next.message_ttl !== undefined) run('UPDATE channels SET message_ttl_since = CASE WHEN ? > 0 THEN COALESCE(message_ttl_since, ?) END WHERE id = ?', next.message_ttl, snowflake(), ch.id);
  if (next.message_ttl !== undefined) schedule();
  if ('icon' in next && next.icon !== ch.icon) removeImage('channel-icons', ch.id, ch.icon);
  const updated = getChannel(ch.id);
  sendToUsers(channelUserIds(ch), 'CHANNEL_UPDATE', uid => channelObj(updated, uid));
  return channelObj(updated, ctx.user.id);
}

const recipientsField = (body, field) => (body?.[field] == null ? null : snowflakes(body, field, MAX_RECIPIENTS));

export default [
  ['PUT', '/channels/:id/recipients/:user_id', addRecipient, { userOnly: true }],
  ['DELETE', '/channels/:id/recipients/:user_id', removeRecipient, { userOnly: true }],
  ['GET', '/channels/:id/call', ({ params, user }) => {
    const ch = loadPrivate(params.id, user);
    return { ringable: channelUserIds(ch).some(id => id !== user.id && !blockedEither(user.id, id)) };
  }, { userOnly: true }],
  ['POST', '/channels/:id/call/ring', ({ params, body, user, headers }) => {
    const ch = loadPrivate(params.id, user);
    limit('CALL', 'ring', {}, user.id, headers); // per user across channels: every ring may push to every recipient
    ring(ch, user, recipientsField(body, 'recipients'));
  }, { userOnly: true }],
  ['POST', '/channels/:id/call/stop-ringing', ({ params, body, user }) => {
    const ch = loadPrivate(params.id, user);
    if (!activeCall(ch.id)) return;
    stopRinging(ch, recipientsField(body, 'recipients') ?? [user.id]);
  }, { userOnly: true }],
];
