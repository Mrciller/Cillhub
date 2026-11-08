import { get, all, run, userObj } from '../db.js';
import { HttpError, notFound, missingPermissions } from '../errors.js';
import { P, need, viewersOf, isRestricted } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { reactionEmoji } from '../message.js';
import { loadChannel } from './channels.js';
import { requireUnarchived } from './messages.js';
import { usableEmoji } from './emojis.js';

const segmenter = new Intl.Segmenter();
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const FLAG = /^\p{Regional_Indicator}{2}$/u;
const KEYCAP = /^[0-9#*]️?⃣$/u;

// one grapheme that is an emoji (pictographic, a flag or a keycap), or a custom emoji as name:id, stored as its id
export function parseEmoji(raw) {
  let e;
  try { e = decodeURIComponent(raw); } catch { e = ''; }
  const custom = /^(?:a:)?\w{1,32}:(\d{1,19})$/.exec(e);
  if (custom) return custom[1];
  const graphemes = [...segmenter.segment(e)];
  if (graphemes.length !== 1 || e.length > 32 || !(PICTOGRAPHIC.test(e) || FLAG.test(e) || KEYCAP.test(e))) {
    throw new HttpError(400, 10014, 'Unknown Emoji');
  }
  return e;
}

function load({ params, user }) {
  const ch = loadChannel(params.id, user);
  need(ch.perms, P.READ_MESSAGE_HISTORY);
  const m = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', params.mid, ch.id);
  if (!m) throw notFound(10008, 'Message');
  return [ch, m, parseEmoji(params.emoji)];
}

const event = (ch, m, emoji, userId) => ({ user_id: userId, channel_id: ch.id, message_id: m.id, guild_id: ch.guild_id ?? undefined, emoji: reactionEmoji(emoji) });

function add(ctx) {
  const [ch, m, emoji] = load(ctx);
  requireUnarchived(ch);
  // timed-out and pending members keep READ_MESSAGE_HISTORY but may not react at all
  if (ch.guild_id && isRestricted(ch.guild_id, ctx.user.id)) throw missingPermissions();
  if (!get('SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ?', m.id, emoji)) {
    need(ch.perms, P.ADD_REACTIONS);
    if (/^\d+$/.test(emoji) && !usableEmoji(emoji, ch, ctx.user.id, ch.perms)) throw new HttpError(400, 10014, 'Unknown Emoji');
    if (get('SELECT COUNT(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?', m.id).n >= 20) {
      throw new HttpError(400, 30010, 'Maximum number of reactions reached (20)');
    }
  }
  if (run('INSERT OR IGNORE INTO reactions (message_id, emoji, user_id) VALUES (?, ?, ?)', m.id, emoji, ctx.user.id).changes) {
    sendToUsers(viewersOf(ch), 'MESSAGE_REACTION_ADD', event(ch, m, emoji, ctx.user.id));
  }
}

function remove(ctx, userId) {
  const [ch, m, emoji] = load(ctx);
  requireUnarchived(ch);
  if (userId !== ctx.user.id) need(ch.perms, P.MANAGE_MESSAGES);
  if (run('DELETE FROM reactions WHERE message_id = ? AND emoji = ? AND user_id = ?', m.id, emoji, userId).changes) {
    sendToUsers(viewersOf(ch), 'MESSAGE_REACTION_REMOVE', event(ch, m, emoji, userId));
  }
}

function users(ctx) {
  const [, m, emoji] = load(ctx);
  return all('SELECT u.* FROM reactions r JOIN users u ON u.id = r.user_id WHERE r.message_id = ? AND r.emoji = ? ORDER BY r.rowid', m.id, emoji).map(u => userObj(u));
}

const base = '/channels/:id/messages/:mid/reactions/:emoji';
export default [
  ['PUT', `${base}/@me`, add],
  ['DELETE', `${base}/@me`, ctx => remove(ctx, ctx.user.id)],
  ['DELETE', `${base}/:user_id`, ctx => remove(ctx, ctx.params.user_id)],
  ['GET', base, users],
];
