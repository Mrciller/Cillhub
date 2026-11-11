import { mkdirSync } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { snowflake } from './snowflake.js';
import { DATA_DIR, get, all, run, tx, json, userById, userObj, channelUserIds, threadObj } from './db.js';
import { P, has, viewersOf } from './permissions.js';
import { sendToUsers, isOnline } from './gateway.js';
import { notifyMessage } from './push.js';
import { removeAttachment } from './files.js';
import { linkUrls, unfurl } from './embeds.js';
import { attachmentSig } from './proxy.js';
import { addJob, schedule } from './timers.js';
import { recordGuildMetric } from './analytics.js';

export const F = {
  CROSSPOSTED: 1, IS_CROSSPOST: 2, SUPPRESS_EMBEDS: 4, SOURCE_MESSAGE_DELETED: 8, HAS_THREAD: 32, EPHEMERAL: 64, LOADING: 128,
  SUPPRESS_NOTIFICATIONS: 4096, IS_VOICE_MESSAGE: 8192, HAS_SNAPSHOT: 16384,
};
export const IS_SPOILER = 8; // attachment flag

export const getMessage = id => get('SELECT * FROM messages WHERE id = ?', id);
export const getChannel = id => get('SELECT * FROM channels WHERE id = ?', id);

export const attachmentUrl = a => `/attachments/${a.channel_id}/${a.id}/${attachmentSig(a.channel_id, a.id)}/${a.filename}`;
const attachmentObj = a => ({
  id: a.id, filename: a.filename, size: a.size, content_type: a.content_type, url: attachmentUrl(a), proxy_url: attachmentUrl(a),
  ...(a.width != null && { width: a.width, height: a.height }),
  ...(a.description != null && { description: a.description }),
  flags: a.flags,
  ...(a.duration_secs != null && { duration_secs: a.duration_secs, waveform: a.waveform }),
});
const attachmentsOf = (messageId, inSnapshot = 0) =>
  all('SELECT * FROM attachments WHERE message_id = ? AND in_snapshot = ? ORDER BY rowid', messageId, inSnapshot).map(attachmentObj);

// webhook messages: author is the webhook, with the per-message name and avatar overrides
// whose row author_id is the author (users and interaction responses); SQL twin of the test in authorOf()
export const AUTHOR_IS_ID_SQL = '(m.webhook_id IS NULL OR m.application_id IS NOT NULL)';
function authorOf(m) {
  if (!m.webhook_id || m.application_id) return userObj(userById(m.author_id)); // keep AUTHOR_IS_ID_SQL in step
  const w = json(m.webhook_author, {});
  return {
    id: m.webhook_id, username: w.username, discriminator: '0000', global_name: null, avatar: w.avatar ?? null, bot: true,
    ...(w.avatar_url && { avatar_url: w.avatar_url }),
  };
}

export function pollObj(p, viewerId, messageAuthorId) {
  const counts = all('SELECT answer_id, COUNT(*) AS n, MAX(user_id = ?) AS me FROM poll_votes WHERE message_id = ? GROUP BY answer_id', viewerId ?? '', p.message_id);
  const answers = json(p.answers);
  const userHasVoted = counts.some(c => c.me);
  const isQuiz = p.correct_answer_id != null;
  const canReveal = !isQuiz || !!p.finalized || p.expiry <= Date.now() || userHasVoted || (messageAuthorId != null && viewerId === messageAuthorId);
  return {
    question: json(p.question), answers, expiry: new Date(p.expiry).toISOString(), allow_multiselect: !!p.allow_multiselect,
    layout_type: p.layout_type,
    anonymous: !!p.anonymous,
    allowed_role_ids: json(p.allowed_roles, []),
    is_quiz: isQuiz,
    correct_answer_id: canReveal && isQuiz ? p.correct_answer_id : null,
    results: {
      is_finalized: !!p.finalized,
      answer_counts: answers.map(a => {
        const c = counts.find(x => x.answer_id === a.answer_id);
        return { id: a.answer_id, count: c?.n ?? 0, me_voted: !!c?.me };
      }),
    },
  };
}

export function messageObj(m, ch, viewerId, nested = false) {
  const ids = new Set([...m.content.matchAll(/<@!?(\d+)>/g)].map(x => x[1]));
  const mentions = ids.size ? channelUserIds(ch).filter(id => ids.has(id)).map(id => userObj(userById(id))) : [];
  const reactions = all(`SELECT emoji, COUNT(*) AS count, MAX(user_id = ?) AS me FROM reactions WHERE message_id = ?
                         GROUP BY emoji ORDER BY MIN(rowid)`, viewerId ?? '', m.id)
    .map(r => ({ emoji: reactionEmoji(r.emoji), count: r.count, me: !!r.me }));
  const thread = get('SELECT * FROM channels WHERE id = ? AND parent_id = ? AND type IN (10, 11)', m.id, m.channel_id);
  const poll = get('SELECT * FROM polls WHERE message_id = ?', m.id);
  const author = authorOf(m);
  const accessory = author.module && get('SELECT module_id, panel_id FROM module_message_panels WHERE message_id = ?', m.id);
  const out = {
    id: m.id, type: m.type, channel_id: m.channel_id, guild_id: ch.guild_id ?? undefined, author,
    content: m.content, timestamp: m.timestamp, edited_timestamp: m.edited_timestamp, tts: false,
    mentions, mention_roles: json(m.mention_roles), mention_everyone: !!m.mention_everyone,
    attachments: attachmentsOf(m.id),
    embeds: m.flags & F.SUPPRESS_EMBEDS ? [] : [...json(m.embeds, []), ...json(m.link_embeds, [])],
    pinned: !!m.pinned_at, flags: m.flags | (thread ? F.HAS_THREAD : 0),
    ...(reactions.length && { reactions }),
    ...(m.webhook_id && { webhook_id: m.webhook_id }),
    ...(m.sticker_items !== '[]' && { sticker_items: json(m.sticker_items) }),
    ...(poll && { poll: pollObj(poll, viewerId, m.author_id) }),
    ...(thread && { thread: threadObj(thread, viewerId) }),
    components: json(m.components, []),
    ...(m.application_id && { application_id: m.application_id }),
    ...(m.interaction_metadata && interactionFields(json(m.interaction_metadata))),
    ...(m.call && { call: json(m.call) }),
    ...(m.e2ee_envelope && { e2ee_envelope: json(m.e2ee_envelope) }),
    ...(accessory && { module_accessory: { module_id: accessory.module_id, panel_id: accessory.panel_id } }),
  };
  if (m.reference_id) {
    out.message_reference = { message_id: m.reference_id, channel_id: m.channel_id, guild_id: ch.guild_id ?? undefined };
  } else if (m.reference) out.message_reference = json(m.reference);
  if (m.snapshot) out.message_snapshots = [json(m.snapshot)];
  // replies and thread starters carry the message they point at, one level deep
  if (!nested && (m.type === 19 || m.type === 21) && out.message_reference) {
    const ref = getMessage(out.message_reference.message_id);
    const refCh = ref && getChannel(ref.channel_id);
    out.referenced_message = ref ? messageObj(ref, refCh, viewerId, true) : null;
  }
  return out;
}

// interaction_metadata (current) and interaction (deprecated, still read by libraries) of an interaction response
export function interactionFields(meta) {
  const user = userById(meta.user_id);
  const u = user ? userObj(user) : { id: meta.user_id };
  return {
    interaction_metadata: { id: meta.id, type: meta.type, user: u, authorizing_integration_owners: meta.owners ?? {}, ...(meta.name && { name: meta.name }), ...(meta.target_user_id && { target_user: { id: meta.target_user_id } }), ...(meta.target_message_id && { target_message_id: meta.target_message_id }), ...(meta.interacted_message_id && { interacted_message_id: meta.interacted_message_id }) },
    ...(meta.name && { interaction: { id: meta.id, type: meta.type, name: meta.name, user: u } }),
  };
}

// custom reactions are stored as the emoji id
export function reactionEmoji(key) {
  if (!/^\d+$/.test(key)) return { id: null, name: key };
  const e = get('SELECT name, animated FROM emojis WHERE id = ?', key);
  return { id: key, name: e?.name ?? null, ...(e?.animated && { animated: true }) };
}

// every user sees reactions, votes and thread membership as their own, so payloads are rendered per recipient
export const broadcastMessage = (ch, t, m, extra) => sendToUsers(viewersOf(ch), t, uid => ({ ...messageObj(m, ch, uid), ...extra }));

export function deleteMessages(rows) {
  const pinnedChannels = new Set();
  for (const m of rows) {
    for (const a of all('SELECT id, channel_id FROM attachments WHERE message_id = ?', m.id)) removeAttachment(a.channel_id, a.id);
    // Any unread mention from this message is withdrawn before the cascade removes recent_mentions.
    run(`UPDATE read_states SET mention_count = MAX(0, mention_count - 1)
         WHERE channel_id = ? AND user_id IN (SELECT user_id FROM recent_mentions WHERE message_id = ?)
           AND (last_message_id IS NULL OR CAST(last_message_id AS INTEGER) < CAST(? AS INTEGER))`, m.channel_id, m.id, m.id);
    run('DELETE FROM messages WHERE id = ?', m.id);
    run('UPDATE channels SET message_count = MAX(0, message_count - 1) WHERE id = ? AND type IN (10, 11, 12) AND id != ?', m.channel_id, m.id);
    run(`UPDATE channels SET last_message_id = (SELECT id FROM messages WHERE channel_id = ? ORDER BY CAST(id AS INTEGER) DESC LIMIT 1)
         WHERE id = ? AND last_message_id = ?`, m.channel_id, m.channel_id, m.id);
    if (m.pinned_at) pinnedChannels.add(m.channel_id);
  }
  for (const channelId of pinnedChannels) {
    const ch = getChannel(channelId);
    if (!ch) continue;
    const last = get('SELECT MAX(pinned_at) AS t FROM messages WHERE channel_id = ?', ch.id).t;
    sendToUsers(viewersOf(ch), 'CHANNEL_PINS_UPDATE', { channel_id: ch.id, guild_id: ch.guild_id ?? undefined, last_pin_timestamp: last });
  }
}

// copies of another message's files, for forwards and crossposts (the original may be deleted later)
export async function copyAttachments(fromMessageId, toChannelId, inSnapshot) {
  const out = [];
  for (const a of all('SELECT * FROM attachments WHERE message_id = ? AND in_snapshot = 0 ORDER BY rowid', fromMessageId)) {
    const id = snowflake();
    mkdirSync(join(DATA_DIR, 'attachments', toChannelId), { recursive: true });
    try {
      await copyFile(join(DATA_DIR, 'attachments', a.channel_id, a.id), join(DATA_DIR, 'attachments', toChannelId, id));
    } catch (e) {
      out.forEach(c => removeAttachment(toChannelId, c.id)); // no orphan copies when a later file fails
      throw e;
    }
    out.push({ ...a, id, channel_id: toChannelId, in_snapshot: inSnapshot ? 1 : 0 });
  }
  return out;
}

// the stored row for a new message and everything that changes with it, in one transaction
// called with every stored message right after the insert, before it is broadcast (v8: a module message's accessory panel)
export const insertHooks = [];

export function insertMessage(d) {
  const id = d.id ?? snowflake();
  const now = new Date().toISOString();
  const ch = d.ch;
  tx(() => {
    run(`INSERT INTO messages (id, channel_id, author_id, content, timestamp, type, reference_id, mention_everyone, mention_roles,
           flags, embeds, reference, snapshot, sticker_items, webhook_id, webhook_author, components, application_id, interaction_metadata, call, e2ee_envelope)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, ch.id, d.authorId, d.content ?? '', now, d.type ?? 0, d.referenceId ?? null, Number(!!d.mentionEveryone),
    JSON.stringify(d.mentionRoles ?? []), d.flags ?? 0, JSON.stringify(d.embeds ?? []), d.reference ? JSON.stringify(d.reference) : null,
    d.snapshot ? JSON.stringify(d.snapshot) : null, JSON.stringify(d.stickerItems ?? []), d.webhook?.id ?? null,
    d.webhook ? JSON.stringify(d.webhook.author) : null, JSON.stringify(d.components ?? []), d.applicationId ?? null,
    d.interaction ? JSON.stringify(d.interaction) : null, d.call ? JSON.stringify(d.call) : null,
    d.e2eeEnvelope ? JSON.stringify(d.e2eeEnvelope) : null);
    for (const a of d.attachments ?? []) {
      run(`INSERT INTO attachments (id, message_id, channel_id, filename, size, content_type, width, height, description, flags,
             duration_secs, waveform, in_snapshot) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      a.id, id, a.channel_id ?? ch.id, a.filename, a.size, a.content_type, a.width ?? null, a.height ?? null, a.description ?? null,
      a.flags ?? 0, a.duration_secs ?? null, a.waveform ?? null, a.in_snapshot ?? 0);
    }
    if (d.poll) {
      run(`INSERT INTO polls (message_id, question, answers, allow_multiselect, layout_type, expiry, anonymous, allowed_roles, correct_answer_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, JSON.stringify(d.poll.question), JSON.stringify(d.poll.answers), Number(d.poll.allow_multiselect), d.poll.layout_type,
      d.poll.expiry, Number(!!d.poll.anonymous), JSON.stringify(d.poll.allowed_role_ids ?? []), d.poll.correct_answer_id ?? null);
    }
    run('UPDATE channels SET last_message_id = ? WHERE id = ?', id, ch.id);
    // a thread's first message (forum post, id = thread id) is not counted; sending is activity and unarchives
    if ([10, 11, 12].includes(ch.type)) {
      run(`UPDATE channels SET message_count = message_count + ?, total_message_sent = total_message_sent + ?, last_activity = ?,
             archived = 0, archive_timestamp = CASE WHEN archived THEN ? ELSE archive_timestamp END WHERE id = ?`,
      Number(id !== ch.id), Number(id !== ch.id), Date.now(), now, ch.id);
    }
    // your own message never makes the channel unread for you
    if (!d.webhook) {
      run(`INSERT INTO read_states (user_id, channel_id, last_message_id) VALUES (?, ?, ?)
           ON CONFLICT DO UPDATE SET last_message_id = excluded.last_message_id`, d.authorId, ch.id, id);
    }
    d.inTx?.();
  });
  if (d.poll) schedule();
  if (ch.message_ttl > 0 || (ch.parent_id && getChannel(ch.parent_id)?.message_ttl > 0)) schedule();
  const m = getMessage(id);
  // the message is committed: a failing metric or hook is logged, it must not fail the send (a retry would post it twice)
  try {
    if (ch.guild_id) recordGuildMetric(ch.guild_id, 'messages_sent', 1);
    insertHooks.forEach(f => f(m));
  } catch (e) { console.error(`after storing message ${id}:`, e); }
  return m;
}

// mention_count for everyone the message pings: users, counted roles, @everyone/@here; every DM message.
// Guild mentions also land in the recent-mentions inbox; pings may push to idle users.
export function bumpMentions(ch, m, counted, allowedUsers) {
  if (m.flags & F.SUPPRESS_NOTIFICATIONS) return;
  const kinds = new Map(); // user id -> user | role | everyone | dm
  const users = new Set([...m.content.matchAll(/<@!?(\d+)>/g)].map(x => x[1]).filter(id => !allowedUsers || allowedUsers(id)));
  if (!ch.guild_id) channelUserIds(ch).forEach(id => kinds.set(id, 'dm'));
  else {
    const hasRole = id => counted.roleIds.some(r => get('SELECT 1 FROM member_roles WHERE guild_id = ? AND user_id = ? AND role_id = ?', ch.guild_id, id, r));
    for (const id of viewersOf(ch)) {
      const kind = users.has(id) ? 'user' : hasRole(id) ? 'role' : counted.all || (counted.here && isOnline(id)) ? 'everyone' : null;
      if (kind) kinds.set(id, kind);
    }
  }
  if (!m.webhook_id) kinds.delete(m.author_id);
  const now = Date.now();
  for (const [id, kind] of kinds) {
    run(`INSERT INTO read_states (user_id, channel_id, mention_count) VALUES (?, ?, 1)
         ON CONFLICT DO UPDATE SET mention_count = mention_count + 1`, id, ch.id);
    if (kind !== 'dm' || users.has(id)) {
      run('INSERT OR IGNORE INTO recent_mentions (user_id, message_id, channel_id, guild_id, kind, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        id, m.id, ch.id, ch.guild_id ?? null, kind === 'dm' ? 'user' : kind, now);
    }
  }
  notifyMessage(ch, m, kinds);
}

// what of @everyone, @here and <@&role> counts: needs MENTION_EVERYONE (or a mentionable role), then allowed_mentions
export function countedMentions(content, ch, perms, allowed) {
  const everyone = has(perms, P.MENTION_EVERYONE);
  let roleIds = ch.guild_id ? [...new Set([...content.matchAll(/<@&(\d+)>/g)].map(x => x[1]))].filter(id => {
    const r = get('SELECT mentionable FROM roles WHERE id = ? AND guild_id = ? AND id != guild_id', id, ch.guild_id);
    return r && (r.mentionable || everyone);
  }) : [];
  let all = everyone && content.includes('@everyone');
  let here = everyone && content.includes('@here');
  if (allowed) {
    if (!allowed.parse.includes('everyone')) all = here = false;
    if (!allowed.parse.includes('roles')) roleIds = roleIds.filter(id => allowed.roles.includes(id));
  }
  return { all, here, roleIds };
}

// link embeds run after the message is stored and never affect its creation; a later edit wins over a slow unfurl
export function unfurlLater(m) {
  const urls = linkUrls(m.content);
  if (!urls.length) return;
  Promise.all(urls.map(u => unfurl(u))).then(embeds => {
    const cur = getMessage(m.id);
    if (!cur || cur.content !== m.content || cur.flags & F.SUPPRESS_EMBEDS) return;
    const found = embeds.filter(Boolean);
    if (!found.length && cur.link_embeds === '[]') return;
    run('UPDATE messages SET link_embeds = ? WHERE id = ?', JSON.stringify(found), m.id);
    const ch = getChannel(cur.channel_id);
    if (ch) broadcastMessage(ch, 'MESSAGE_UPDATE', getMessage(m.id));
  }).catch(e => console.error('unfurl failed:', e));
}

// messages under a lifetime, with the time each expires. A 1:1 DM keeps what was sent before its lifetime was set
// (message_ttl_since: the first message id it covers), so one side cannot erase the other's history.
const TTL_TTL = 'COALESCE(NULLIF(c.message_ttl, 0), (SELECT p.message_ttl FROM channels p WHERE p.id = c.parent_id), 0)';
const TTL_EXPIRY = `((CAST(m.id AS INTEGER) >> 22) + 1420070400000) + ${TTL_TTL} * 1000`;
const TTL_FROM = `FROM messages m JOIN channels c ON c.id = m.channel_id
  WHERE (c.message_ttl > 0 OR (c.parent_id IS NOT NULL AND (SELECT p.message_ttl FROM channels p WHERE p.id = c.parent_id) > 0))
    AND (c.message_ttl_since IS NULL OR CAST(m.id AS INTEGER) >= CAST(c.message_ttl_since AS INTEGER))`;

// only due rows, at most 1000 per run (the timer fires again at once while more are due)
export function sweepExpiredMessages() {
  const expired = all(`SELECT m.id, m.channel_id, m.pinned_at, c.guild_id ${TTL_FROM} AND ${TTL_EXPIRY} <= ? LIMIT 1000`, Date.now());
  if (!expired.length) return 0;

  const byChannel = new Map();
  for (const m of expired) {
    if (!byChannel.has(m.channel_id)) byChannel.set(m.channel_id, []);
    byChannel.get(m.channel_id).push(m);
  }

  for (const [channelId, msgs] of byChannel) {
    const ch = getChannel(channelId);
    deleteMessages(msgs);
    if (ch) {
      const viewers = viewersOf(ch);
      for (const m of msgs) {
        sendToUsers(viewers, 'MESSAGE_DELETE', { id: m.id, channel_id: ch.id, guild_id: ch.guild_id ?? undefined });
      }
    }
  }
  return expired.length;
}

addJob({
  name: 'message ttl sweep',
  next() {
    const row = get(`SELECT MIN(${TTL_EXPIRY}) AS next_expiry ${TTL_FROM}`);
    return row?.next_expiry ? Number(row.next_expiry) : null;
  },
  run: sweepExpiredMessages,
});


