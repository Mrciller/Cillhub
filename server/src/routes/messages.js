import { get, all, run, tx, json, channelUserIds, idTime } from '../db.js';
import { blockedEither } from './relationships.js';
import { I, privilegedAllowed, redact } from '../intents.js';
import { HttpError, str, int, invalid, intParam, idParam, notFound, missingPermissions } from '../errors.js';
import { P, need, has, viewersOf, isThread, MESSAGEABLE } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { audit, A } from '../audit.js';
import { moderateMessage } from '../automod.js';
import { readPayload, prepare, send, checkSend, checkThreadOpen, markSent, filterEmoji } from '../compose.js';
import {
  F, messageObj, getMessage, getChannel, broadcastMessage, deleteMessages, countedMentions, unfurlLater, insertMessage, copyAttachments,
} from '../message.js';
import { loadChannel } from './channels.js';
import { reopened } from './threads.js';

// bots without the MESSAGE_CONTENT flag on their application read content only where the docs allow it
export const seesContent = user => !user.bot
  || !!(privilegedAllowed(get('SELECT flags FROM applications WHERE id = ?', user.id)?.flags ?? 0) & I.MESSAGE_CONTENT);
export const forViewer = (m, user) => (seesContent(user) ? m : redact(m, user.id));

export function loadMessage({ params, user }) {
  const ch = loadChannel(params.id, user);
  const m = get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', params.mid, ch.id);
  if (!m) throw notFound(10008, 'Message');
  return [ch, m];
}

// the user's own message; webhook messages belong to the webhook, not to whoever created it
export const ownMessage = (m, userId) => m.author_id === userId && !m.webhook_id;

export function requireUnarchived(ch) {
  if (isThread(ch) && ch.archived) throw new HttpError(400, 50083, 'Thread is archived');
}

function list({ params, query, user }) {
  const ch = loadChannel(params.id, user);
  need(ch.perms, P.READ_MESSAGE_HISTORY);
  const limit = intParam(query, 'limit', 50, 1, 100);
  const before = idParam(query, 'before');
  const after = idParam(query, 'after');
  const around = idParam(query, 'around');
  const page = (cmp, order, id, n) => all(`SELECT * FROM messages WHERE channel_id = ? AND CAST(id AS INTEGER) ${cmp} CAST(? AS INTEGER) ORDER BY CAST(id AS INTEGER) ${order} LIMIT ?`, ch.id, id, n);
  if (around && !after && !before) {
    // around= (docs): the message itself and older ones, plus up to half the limit newer ones, newest first
    const newer = page('>', 'ASC', around, Math.floor(limit / 2)).reverse();
    return [...newer, ...page('<=', 'DESC', around, limit - newer.length)].map(m => forViewer(messageObj(m, ch, user.id), user));
  }
  // after= returns the oldest `limit` messages following the id, still newest first
  const rows = after
    ? all('SELECT * FROM messages WHERE channel_id = ? AND CAST(id AS INTEGER) > CAST(? AS INTEGER) ORDER BY CAST(id AS INTEGER) LIMIT ?', ch.id, after, limit).reverse()
    : all('SELECT * FROM messages WHERE channel_id = ? AND (? IS NULL OR CAST(id AS INTEGER) < CAST(? AS INTEGER)) ORDER BY CAST(id AS INTEGER) DESC LIMIT ?', ch.id, before, before, limit);
  return rows.map(m => forViewer(messageObj(m, ch, user.id), user));
}

async function create(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  if (ch.type === 15) throw new HttpError(400, 40058, 'Cannot send a message in a forum channel');
  if (!MESSAGEABLE.includes(ch.type)) throw new HttpError(400, 50008, 'Cannot send messages in a non-text channel');
  checkSend(ch, ctx.user.id, ch.perms);
  // nobody messages someone they blocked or who blocked them in a 1:1 DM
  // nobody messages the system account either (v6 announcements are one-way)
  if (ch.type === 1 && channelUserIds(ch).some(id => id !== ctx.user.id && (blockedEither(ctx.user.id, id) || get('SELECT system FROM users WHERE id = ?', id)?.system))) {
    throw new HttpError(403, 50007, 'Cannot send messages to this user');
  }
  const { body, files } = await readPayload(ctx);
  const d = await prepare({ ch, perms: ch.perms, userId: ctx.user.id, bot: !!ctx.user.bot }, body, files);
  if (ch.guild_id && has(ch.perms, P.EMBED_LINKS) && typeof body?.content === 'string') { // a snippet posts an embed
    const mTrigger = body.content.trim().match(/^!([a-z0-9_-]{1,32})$/i);
    if (mTrigger) {
      const sn = get('SELECT * FROM guild_snippets WHERE guild_id = ? AND name = ?', ch.guild_id, mTrigger[1].toLowerCase());
      if (sn) {
        d.embeds = [{ type: 'rich', title: `!${sn.name}`, description: sn.content, color: 0x5865f2 }];
        d.rich = true;
      }
    }
  }
  const mod = moderateMessage(ch, ctx.user.id, d.content);
  if (mod?.blocked) throw mod.reject();
  const m = await send(d, ctx.user.id);
  markSent(ch, ctx.user.id);
  if (isThread(ch)) reopened(ch);
  mod?.execute(m.id);
  ctx.status = 201;
  return { ...messageObj(m, ch, ctx.user.id), nonce: d.nonce };
}

function edit(ctx) {
  const [ch, m] = loadMessage(ctx);
  const body = ctx.body ?? {};
  const own = ownMessage(m, ctx.user.id);
  if (body.flags === undefined && !own) throw missingPermissions();
  requireUnarchived(ch);
  let { flags, content } = m;
  if (body.flags !== undefined) {
    if (!own) need(ch.perms, P.MANAGE_MESSAGES);
    flags = (m.flags & ~F.SUPPRESS_EMBEDS) | (int(body, 'flags', 0, 2 ** 31) & F.SUPPRESS_EMBEDS); // only SUPPRESS_EMBEDS can change
  }
  let mod = null;
  let counted = { all: !!m.mention_everyone, here: false, roleIds: json(m.mention_roles) };
  if (body.content !== undefined) {
    if (!own) throw missingPermissions();
    if (m.flags & F.IS_VOICE_MESSAGE) throw invalid('content', 'VOICE_MESSAGE_EDIT', 'Voice messages cannot be edited.');
    checkThreadOpen(ch, ch.perms);
    content = filterEmoji(str(body, 'content', 0, 2000, false), ch, ctx.user.id, ch.perms);
    const hasMore = get('SELECT 1 FROM attachments WHERE message_id = ?', m.id) || m.sticker_items !== '[]' || m.snapshot
      || get('SELECT 1 FROM polls WHERE message_id = ?', m.id);
    if (!content.trim() && !hasMore) throw new HttpError(400, 50006, 'Cannot send an empty message');
    mod = moderateMessage(ch, ctx.user.id, content);
    if (mod?.blocked) throw mod.reject();
    counted = countedMentions(content, ch, ch.perms);
  }
  if (body.content !== undefined && content !== m.content && !m.e2ee_envelope) {
    run('INSERT INTO message_edits (message_id, previous_content, edited_at) VALUES (?, ?, ?)',
      m.id, m.content, m.edited_timestamp ?? m.timestamp);
    run(`DELETE FROM message_edits WHERE message_id = ? AND id NOT IN (
      SELECT id FROM message_edits WHERE message_id = ? ORDER BY id DESC LIMIT 25
    )`, m.id, m.id);
  }
  const relink = content !== m.content || (flags & F.SUPPRESS_EMBEDS) !== (m.flags & F.SUPPRESS_EMBEDS);
  run(`UPDATE messages SET content = ?, flags = ?, mention_everyone = ?, mention_roles = ?, edited_timestamp = ?,
         link_embeds = CASE WHEN ? THEN '[]' ELSE link_embeds END WHERE id = ?`,
  content, flags, Number(counted.all || counted.here), JSON.stringify(counted.roleIds),
  content !== m.content ? new Date().toISOString() : m.edited_timestamp, Number(relink), m.id);
  const out = getMessage(m.id);
  broadcastMessage(ch, 'MESSAGE_UPDATE', out);
  if (relink && !(flags & F.SUPPRESS_EMBEDS) && (m.webhook_id || has(ch.perms, P.EMBED_LINKS))) unfurlLater(out);
  mod?.execute(m.id);
  return messageObj(out, ch, ctx.user.id);
}

function remove(ctx) {
  const [ch, m] = loadMessage(ctx);
  const own = ownMessage(m, ctx.user.id);
  if (!own) need(ch.perms, P.MANAGE_MESSAGES);
  if (m.type === 21) throw new HttpError(400, 50021, 'Cannot execute action on a system message');
  const viewers = viewersOf(ch);
  deleteMessages([m]);
  sendToUsers(viewers, 'MESSAGE_DELETE', { id: m.id, channel_id: ch.id, guild_id: ch.guild_id ?? undefined });
  if (!own && ch.guild_id) audit(ctx, ch.guild_id, A.MESSAGE_DELETE, m.webhook_id ?? m.author_id, { options: { channel_id: ch.id, count: '1' } });
}

// publish an announcement: mark it CROSSPOSTED and re-post it through every follower webhook
async function crosspost(ctx) {
  const [ch, m] = loadMessage(ctx);
  if (ch.type !== 5) throw new HttpError(400, 50024, 'Cannot execute action on this channel type');
  need(ch.perms, ownMessage(m, ctx.user.id) ? P.SEND_MESSAGES : P.MANAGE_MESSAGES);
  if (m.flags & F.CROSSPOSTED) throw new HttpError(400, 40033, 'This message has already been crossposted');
  if (m.type !== 0 && m.type !== 19) throw new HttpError(400, 50068, 'Invalid message type');
  run('UPDATE messages SET flags = flags | ? WHERE id = ?', F.CROSSPOSTED, m.id);
  const g = get('SELECT * FROM guilds WHERE id = ?', ch.guild_id);
  for (const w of all('SELECT * FROM webhooks WHERE source_channel_id = ? AND type = 2', ch.id)) {
    const target = getChannel(w.channel_id);
    if (!target) continue;
    const copy = insertMessage({
      ch: target, authorId: w.user_id, content: m.content, embeds: json(m.embeds), flags: F.IS_CROSSPOST,
      reference: { message_id: m.id, channel_id: ch.id, guild_id: ch.guild_id },
      attachments: await copyAttachments(m.id, target.id, false), stickerItems: json(m.sticker_items),
      webhook: { id: w.id, author: { username: `${g.name} #${ch.name}`, avatar: null, ...(g.icon && { avatar_url: `/icons/${g.id}/${g.icon}` }) } },
    });
    broadcastMessage(target, 'MESSAGE_CREATE', copy);
    unfurlLater(copy);
  }
  const out = getMessage(m.id);
  broadcastMessage(ch, 'MESSAGE_UPDATE', out);
  return messageObj(out, ch, ctx.user.id);
}

function bulkDelete(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  if (!ch.guild_id) throw new HttpError(400, 50024, 'Cannot bulk delete in a direct message');
  need(ch.perms, P.MANAGE_MESSAGES);
  const rawList = Array.isArray(ctx.body?.messages) ? ctx.body.messages : [];
  const ids = [...new Set(rawList.map(String))];
  if (ids.length < 2 || ids.length > 100) {
    throw new HttpError(400, 50016, 'You must provide between 2 and 100 messages to delete.');
  }
  const now = Date.now();
  for (const id of ids) {
    if (now - idTime(id) > 14 * 86400_000) {
      throw new HttpError(400, 50034, 'You can only bulk delete messages that are under 14 days old.');
    }
  }
  const placeholders = ids.map(() => '?').join(',');
  const rows = all(`SELECT * FROM messages WHERE channel_id = ? AND id IN (${placeholders})`, ch.id, ...ids);
  const deletedIds = rows.map(r => r.id);
  if (deletedIds.length > 0) {
    tx(() => deleteMessages(rows));
  }
  if (ch.guild_id) {
    audit(ctx, ch.guild_id, A.MESSAGE_BULK_DELETE, ch.id, { options: { count: String(deletedIds.length) } });
  }
  sendToUsers(viewersOf(ch), 'MESSAGE_DELETE_BULK', {
    ids: deletedIds,
    channel_id: ch.id,
    guild_id: ch.guild_id ?? undefined,
  });
  ctx.status = 204;
}

function getMessageEdits(ctx) {
  const [ch, m] = loadMessage(ctx);
  need(ch.perms, P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY);
  const obj = messageObj(m, ch, ctx.user.id);
  const hidden = forViewer(obj, ctx.user) !== obj; // a bot without message content reads no old versions either
  const edits = all('SELECT previous_content AS content, edited_at FROM message_edits WHERE message_id = ? ORDER BY id ASC', m.id);
  return { edits: hidden ? edits.map(e => ({ ...e, content: '' })) : edits };
}

function listChannelMedia(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  need(ch.perms, P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY);
  const tab = ctx.query.get('tab') || 'media';
  const before = idParam(ctx.query, 'before');
  const limit = intParam(ctx.query, 'limit', 50, 1, 100);

  let whereClause = '';
  if (tab === 'links') {
    whereClause = "AND (m.content LIKE '%http://%' OR m.content LIKE '%https://%')";
  } else if (tab === 'files') {
    whereClause = `AND EXISTS (
      SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.in_snapshot = 0 AND (a.flags & 16) = 0
        AND a.content_type NOT LIKE 'image/%' AND a.content_type NOT LIKE 'video/%'
    )`;
  } else {
    // 'media' (photos & videos)
    whereClause = `AND EXISTS (
      SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.in_snapshot = 0 AND (a.flags & 16) = 0
        AND (a.content_type LIKE 'image/%' OR a.content_type LIKE 'video/%')
    )`;
  }

  const rows = all(`
    SELECT m.* FROM messages m
    WHERE m.channel_id = ? AND (? IS NULL OR CAST(m.id AS INTEGER) < CAST(? AS INTEGER))
      AND m.e2ee_envelope IS NULL
      ${whereClause}
    ORDER BY CAST(m.id AS INTEGER) DESC LIMIT ?
  `, ch.id, before, before, limit);

  return { messages: rows.map(r => forViewer(messageObj(r, ch, ctx.user.id), ctx.user)) };
}

export default [
  ['GET', '/channels/:id/messages', list],
  ['GET', '/channels/:id/media', listChannelMedia],
  ['POST', '/channels/:id/messages/bulk-delete', bulkDelete, { rateLimit: { max: 5, windowMs: 5000 } }],
  ['GET', '/channels/:id/messages/:mid/edits', getMessageEdits],
  ['GET', '/channels/:id/messages/:mid', ctx => {
    const [ch, m] = loadMessage(ctx);
    need(ch.perms, P.READ_MESSAGE_HISTORY);
    return forViewer(messageObj(m, ch, ctx.user.id), ctx.user);
  }],
  ['POST', '/channels/:id/messages', create, { multipart: true }],
  ['PATCH', '/channels/:id/messages/:mid', edit],
  ['DELETE', '/channels/:id/messages/:mid', remove],
  ['POST', '/channels/:id/messages/:mid/crosspost', crosspost],
];
