import { get, all, run, tx, userById, userObj } from '../db.js';
import { HttpError, str, notFound } from '../errors.js';
import { sendToUsers, statusOf, presenceObj } from '../gateway.js';
import { pushTo } from '../push.js';
import { limit } from '../ratelimit.js';

export const relationshipsOf = userId => all(
  'SELECT u.*, r.type AS rel FROM relationships r JOIN users u ON u.id = r.other_id WHERE r.user_id = ?', userId,
).map(u => ({ id: u.id, type: u.rel, user: userObj(u) }));

const typeOf = (a, b) => get('SELECT type FROM relationships WHERE user_id = ? AND other_id = ?', a, b)?.type;
// blocking is one-sided (type 2 in the blocker's view); most effects apply whichever side blocked
export const hasBlocked = (a, b) => typeOf(a, b) === 2;
export const blockedEither = (a, b) => hasBlocked(a, b) || hasBlocked(b, a);

const relEvent = (to, other, type) => sendToUsers([to], 'RELATIONSHIP_ADD', { id: other, type, user: userObj(userById(other)) });

function set(a, b, typeForA, typeForB) {
  tx(() => {
    run('INSERT OR REPLACE INTO relationships (user_id, other_id, type) VALUES (?, ?, ?)', a, b, typeForA);
    run('INSERT OR REPLACE INTO relationships (user_id, other_id, type) VALUES (?, ?, ?)', b, a, typeForB);
  });
  relEvent(a, b, typeForA);
  relEvent(b, a, typeForB);
}

// sends a request, or accepts the other side's pending one
function befriend(me, other, headers) {
  if (!other || typeOf(me.id, other.id) !== 3) limit('FRIEND', 'request', {}, me.id, headers); // accepting is free
  if (!other || other.deleted) throw new HttpError(400, 80004, 'No users with that username exist');
  if (other.id === me.id) throw new HttpError(400, 80003, 'Cannot send friend request to self');
  if (other.bot) throw new HttpError(400, 80000, 'Incoming friend requests disabled.');
  if (blockedEither(me.id, other.id)) throw new HttpError(400, 80001, 'Friend request blocked.');
  const current = typeOf(me.id, other.id);
  if (current === 3) {
    set(me.id, other.id, 1, 1);
    // friends now see each other's presence
    for (const [from, to] of [[me.id, other.id], [other.id, me.id]]) {
      if (statusOf(from) !== 'offline') sendToUsers([to], 'PRESENCE_UPDATE', presenceObj(from));
    }
  } else if (current === undefined) {
    set(me.id, other.id, 4, 3);
    pushTo([other.id], null, 'friend', { title: 'Friend request', body: `${me.global_name ?? me.username} sent you a friend request`, url: '/channels/@me', tag: `friend-${me.id}` });
  }
}

// blocking drops any friendship or request both ways; the blocked user just sees the relationship vanish
function block(me, other) {
  if (other.id === me.id) throw new HttpError(400, 80003, 'Cannot block yourself');
  const theirs = typeOf(other.id, me.id);
  tx(() => {
    run('INSERT OR REPLACE INTO relationships (user_id, other_id, type) VALUES (?, ?, 2)', me.id, other.id);
    if (theirs !== undefined && theirs !== 2) run('DELETE FROM relationships WHERE user_id = ? AND other_id = ?', other.id, me.id);
  });
  if (theirs !== undefined && theirs !== 2) sendToUsers([other.id], 'RELATIONSHIP_REMOVE', { id: me.id, type: theirs });
  relEvent(me.id, other.id, 2);
}

function remove({ params, user }) {
  const mine = typeOf(user.id, params.user_id);
  if (mine === undefined) return;
  const theirs = typeOf(params.user_id, user.id);
  // unblocking only removes my side; their own block of me stays
  if (mine === 2) {
    run('DELETE FROM relationships WHERE user_id = ? AND other_id = ?', user.id, params.user_id);
    return sendToUsers([user.id], 'RELATIONSHIP_REMOVE', { id: params.user_id, type: 2 });
  }
  run('DELETE FROM relationships WHERE (user_id = ? AND other_id = ?) OR (user_id = ? AND other_id = ? AND type != 2)', user.id, params.user_id, params.user_id, user.id);
  sendToUsers([user.id], 'RELATIONSHIP_REMOVE', { id: params.user_id, type: mine });
  if (theirs !== undefined && theirs !== 2) sendToUsers([params.user_id], 'RELATIONSHIP_REMOVE', { id: user.id, type: theirs });
}

// PUT {type?}: 2 blocks, anything else (default) sends or accepts a friend request
function put({ params, body, user, headers }) {
  const other = userById(params.user_id);
  if (!other || other.deleted) throw notFound(10013, 'User');
  if (body?.type === 2) return block(user, other);
  befriend(user, other, headers);
}

const user = { userOnly: true };
export default [
  ['GET', '/users/@me/relationships', ({ user: me }) => relationshipsOf(me.id), user],
  ['POST', '/users/@me/relationships', ({ body, user: me, headers }) => befriend(me, get('SELECT * FROM users WHERE username = ?', str(body, 'username', 1, 32)), headers), user],
  ['PUT', '/users/@me/relationships/:user_id', put, user],
  ['DELETE', '/users/@me/relationships/:user_id', remove, user],
];
