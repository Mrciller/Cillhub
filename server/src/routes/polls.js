import { get, all, run, json, userObj } from '../db.js';
import { HttpError, list, invalid, intParam, idParam, notFound, missingPermissions } from '../errors.js';
import { P, need, viewersOf, isRestricted } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { addJob } from '../timers.js';
import { messageObj, getMessage, getChannel, broadcastMessage, insertMessage } from '../message.js';
import { loadChannel } from './channels.js';

function loadPoll({ params, user }) {
  const ch = loadChannel(params.id, user);
  need(ch.perms, P.READ_MESSAGE_HISTORY);
  const m = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', params.mid, ch.id);
  if (!m) throw notFound(10008, 'Message');
  return [ch, m, get('SELECT * FROM polls WHERE message_id = ?', m.id)];
}

// ends the poll: final results on the message, then a POLL_RESULT (46) message pointing at it
export function finalize(messageId, now = Date.now()) {
  const p = get('SELECT * FROM polls WHERE message_id = ? AND finalized = 0', messageId);
  if (!p) return;
  run('UPDATE polls SET finalized = 1, expiry = MIN(expiry, ?) WHERE message_id = ?', now, messageId);
  const m = getMessage(messageId);
  const ch = getChannel(m.channel_id);
  broadcastMessage(ch, 'MESSAGE_UPDATE', m);
  const counts = all('SELECT answer_id, COUNT(*) AS n FROM poll_votes WHERE message_id = ? GROUP BY answer_id ORDER BY n DESC', messageId);
  const total = get('SELECT COUNT(DISTINCT user_id) AS n FROM poll_votes WHERE message_id = ?', messageId).n;
  const top = counts[0]?.n ?? 0;
  // a single winner only; a tie names none
  const victor = top > 0 && counts.filter(c => c.n === top).length === 1 && json(p.answers).find(a => a.answer_id === counts[0].answer_id);
  const field = (name, value) => ({ name, value: String(value), inline: false });
  const fields = [field('poll_question_text', json(p.question).text), field('victor_answer_votes', top), field('total_votes', total)];
  if (victor) {
    fields.push(field('victor_answer_id', victor.answer_id), field('victor_answer_text', victor.poll_media.text));
    const e = victor.poll_media.emoji;
    if (e?.id) fields.push(field('victor_answer_emoji_id', e.id));
    if (e?.name) fields.push(field('victor_answer_emoji_name', e.name));
  }
  const result = insertMessage({
    ch, authorId: m.author_id, type: 46, embeds: [{ type: 'poll_result', fields }],
    reference: { message_id: m.id, channel_id: ch.id, guild_id: ch.guild_id ?? undefined },
    webhook: m.webhook_id ? { id: m.webhook_id, author: json(m.webhook_author) } : null,
  });
  broadcastMessage(ch, 'MESSAGE_CREATE', result);
}

addJob({
  name: 'poll finalize',
  next: () => get('SELECT MIN(expiry) AS t FROM polls WHERE finalized = 0').t,
  run: now => all('SELECT message_id FROM polls WHERE finalized = 0 AND expiry <= ?', now).forEach(p => finalize(p.message_id, now)),
});

function vote(ctx) {
  const [ch, m, p] = loadPoll(ctx);
  if (!p) throw notFound(10008, 'Message');
  if (ch.guild_id && isRestricted(ch.guild_id, ctx.user.id)) throw missingPermissions();
  if (p.finalized || p.expiry <= Date.now()) throw new HttpError(400, 520001, 'Poll expired');
  const allowedRoles = json(p.allowed_roles, []);
  if (allowedRoles.length > 0 && ch.guild_id) {
    const hasRole = get(`SELECT 1 FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id IN (${allowedRoles.map(() => '?').join(',')})`, ch.guild_id, ctx.user.id, ...allowedRoles);
    if (!hasRole) throw new HttpError(403, 520007, 'You do not have the required role to vote in this poll');
  }
  const ids = [...new Set(list(ctx.body ?? {}, 'answer_ids').map(Number))];
  const valid = new Set(json(p.answers).map(a => a.answer_id));
  if (ids.some(id => !valid.has(id))) throw invalid('answer_ids', 'BASE_TYPE_CHOICES', 'Unknown answer.');
  if (ids.length > 1 && !p.allow_multiselect) throw invalid('answer_ids', 'BASE_TYPE_MAX_LENGTH', 'This poll allows one answer.');
  const before = all('SELECT answer_id FROM poll_votes WHERE message_id = ? AND user_id = ?', m.id, ctx.user.id).map(r => r.answer_id);
  const event = answer_id => ({ user_id: ctx.user.id, channel_id: ch.id, message_id: m.id, guild_id: ch.guild_id ?? undefined, answer_id });
  const viewers = viewersOf(ch);
  const otherViewers = viewers.filter(id => id !== ctx.user.id);
  for (const id of before.filter(id => !ids.includes(id))) {
    run('DELETE FROM poll_votes WHERE message_id = ? AND answer_id = ? AND user_id = ?', m.id, id, ctx.user.id);
    if (p.anonymous) {
      sendToUsers([ctx.user.id], 'MESSAGE_POLL_VOTE_REMOVE', event(id));
      if (otherViewers.length) {
        sendToUsers(otherViewers, 'MESSAGE_POLL_VOTE_REMOVE', { channel_id: ch.id, message_id: m.id, guild_id: ch.guild_id ?? undefined, answer_id: id, user_id: '0' });
      }
    } else {
      sendToUsers(viewers, 'MESSAGE_POLL_VOTE_REMOVE', event(id));
    }
  }
  for (const id of ids.filter(id => !before.includes(id))) {
    run('INSERT INTO poll_votes (message_id, answer_id, user_id) VALUES (?, ?, ?)', m.id, id, ctx.user.id);
    const selfEvent = { ...event(id), ...(p.correct_answer_id != null && { correct_answer_id: p.correct_answer_id }) };
    if (p.anonymous) {
      sendToUsers([ctx.user.id], 'MESSAGE_POLL_VOTE_ADD', selfEvent);
      if (otherViewers.length) {
        sendToUsers(otherViewers, 'MESSAGE_POLL_VOTE_ADD', { channel_id: ch.id, message_id: m.id, guild_id: ch.guild_id ?? undefined, answer_id: id, user_id: '0' });
      }
    } else {
      sendToUsers([ctx.user.id], 'MESSAGE_POLL_VOTE_ADD', selfEvent);
      if (otherViewers.length) {
        sendToUsers(otherViewers, 'MESSAGE_POLL_VOTE_ADD', event(id));
      }
    }
  }
  if (p.correct_answer_id != null) {
    return { correct_answer_id: p.correct_answer_id };
  }
}

function voters(ctx) {
  const [, m, p] = loadPoll(ctx);
  if (!p) throw notFound(10008, 'Message');
  if (p.anonymous) return { users: [] };
  const after = idParam(ctx.query, 'after');
  const limit = intParam(ctx.query, 'limit', 25, 1, 100);
  const users = all(`SELECT u.* FROM poll_votes v JOIN users u ON u.id = v.user_id WHERE v.message_id = ? AND v.answer_id = ?
                     AND (? IS NULL OR CAST(u.id AS INTEGER) > CAST(? AS INTEGER)) ORDER BY CAST(u.id AS INTEGER) LIMIT ?`,
  m.id, Number(ctx.params.answer_id), after, after, limit);
  return { users: users.map(u => userObj(u)) };
}

function expire(ctx) {
  const [ch, m, p] = loadPoll(ctx);
  if (!p) throw new HttpError(400, 520006, 'Cannot expire a non-poll message');
  if (m.author_id !== ctx.user.id || m.webhook_id) throw missingPermissions();
  finalize(m.id);
  return messageObj(getMessage(m.id), ch, ctx.user.id);
}

export default [
  ['PUT', '/channels/:id/polls/:mid/answers/@me', vote],
  ['GET', '/channels/:id/polls/:mid/answers/:answer_id', voters],
  ['POST', '/channels/:id/polls/:mid/expire', expire],
];
