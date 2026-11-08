import { randomBytes } from 'node:crypto';
import { get, all, isMember, threadObj, threadMemberObj } from '../db.js';
import { invalid, intParam, idParam, notFound } from '../errors.js';
import { P, has, need, channelPerms, isThread } from '../permissions.js';
import { messageObj, getChannel } from '../message.js';
import { loadChannel } from './channels.js';

const HAS = {
  link: "(m.content LIKE '%http://%' OR m.content LIKE '%https://%')",
  embed: "(m.embeds != '[]' OR m.link_embeds != '[]')",
  file: 'EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.in_snapshot = 0)',
  image: `(EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.in_snapshot = 0 AND a.content_type LIKE 'image/%')
          OR m.link_embeds LIKE '%"type":"image"%')`,
  video: `(EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.in_snapshot = 0 AND a.content_type LIKE 'video/%')
          OR m.link_embeds LIKE '%"type":"video"%')`,
  sound: "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.in_snapshot = 0 AND a.content_type LIKE 'audio/%')",
  audio: "EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id AND a.in_snapshot = 0 AND a.content_type LIKE 'audio/%')",
  code: "(m.content LIKE '%```%')",
  poll: 'EXISTS (SELECT 1 FROM polls p WHERE p.message_id = m.id)',
  sticker: "m.sticker_items != '[]'",
  snapshot: 'm.snapshot IS NOT NULL',
};
const AUTHOR_TYPE = { user: 'm.webhook_id IS NULL', webhook: 'm.webhook_id IS NOT NULL', bot: 'm.webhook_id IS NOT NULL' };

const ids = (q, name) => q.getAll(name).filter(v => /^\d{1,19}$/.test(v));
function boolParam(q, name) {
  if (!q.has(name)) return null;
  if (!['true', 'false'].includes(q.get(name))) throw invalid(name, 'BASE_TYPE_BOOLEAN', 'Must be a boolean.');
  return q.get(name) === 'true';
}

// "-type" negates, as in the user docs
function choices(q, name, table, where) {
  for (const raw of q.getAll(name)) {
    const neg = raw.startsWith('-');
    const sql = table[neg ? raw.slice(1) : raw];
    if (!sql) throw invalid(name, 'BASE_TYPE_CHOICES', `Unknown ${name} value.`);
    where.push(neg ? `NOT ${sql}` : sql);
  }
}

// every user-supplied word becomes a quoted FTS5 token, so nothing in the query is FTS syntax
const ftsQuery = text => (text.match(/[\p{L}\p{N}_]+/gu) ?? []).map(t => `"${t}"`).join(' ');

const EPOCH = 1420070400000n;
function timeOrIdToSnowflake(val) {
  if (!val) return null;
  if (/^\d{1,19}$/.test(val)) return val;
  const t = Date.parse(val);
  if (!Number.isNaN(t)) {
    return String((BigInt(Math.max(0, Math.floor(t))) - EPOCH) << 22n);
  }
  return null;
}

// the search itself, over channels the caller already proved they can read
function search(query, readable, userId) {
  const where = ['m.channel_id IN (SELECT value FROM json_each(?))'];
  const args = [];
  const wanted = [...ids(query, 'channel_id'), ...ids(query, 'in'), ...ids(query, 'channel')];
  const nsfw = boolParam(query, 'include_nsfw') ?? false;
  const channels = readable.filter(c => (!wanted.length || wanted.includes(c.id)) && (nsfw || !c.nsfw_effective));
  args.push(JSON.stringify(channels.map(c => c.id)));
  let join = '';
  const content = query.get('content');
  if (content != null) {
    if (content.length > 1024) throw invalid('content', 'BASE_TYPE_BAD_LENGTH', 'At most 1024 characters.');
    const fts = ftsQuery(content);
    if (fts) {
      join = 'JOIN messages_fts f ON f.rowid = m.rowid AND messages_fts MATCH ?';
      args.unshift(fts);
    }
  }
  const authors = [...ids(query, 'author_id'), ...ids(query, 'from'), ...ids(query, 'author')];
  if (authors.length) {
    where.push('((m.webhook_id IS NULL AND m.author_id IN (SELECT value FROM json_each(?))) OR m.webhook_id IN (SELECT value FROM json_each(?)))');
    args.push(JSON.stringify(authors), JSON.stringify(authors));
  }
  for (const id of ids(query, 'mentions')) {
    where.push("(m.content LIKE '%<@' || ? || '>%' OR m.content LIKE '%<@!' || ? || '>%')");
    args.push(id, id);
  }
  const everyone = boolParam(query, 'mention_everyone');
  if (everyone !== null) where.push(`m.mention_everyone = ${Number(everyone)}`);
  const pinned = boolParam(query, 'pinned');
  if (pinned !== null) where.push(pinned ? 'm.pinned_at IS NOT NULL' : 'm.pinned_at IS NULL');
  choices(query, 'has', HAS, where);
  choices(query, 'author_type', AUTHOR_TYPE, where);
  const minId = idParam(query, 'min_id') ?? timeOrIdToSnowflake(query.get('after'));
  const maxId = idParam(query, 'max_id') ?? timeOrIdToSnowflake(query.get('before'));
  if (minId) { where.push('CAST(m.id AS INTEGER) > CAST(? AS INTEGER)'); args.push(minId); }
  if (maxId) { where.push('CAST(m.id AS INTEGER) < CAST(? AS INTEGER)'); args.push(maxId); }
  const limit = intParam(query, 'limit', 25, 1, 25);
  const offset = intParam(query, 'offset', 0, 0, 9975);
  const relevance = query.get('sort_by') === 'relevance' && join;
  const dir = query.get('sort_order') === 'asc' ? 'ASC' : 'DESC';
  const from = `FROM messages m ${join} WHERE ${where.join(' AND ')}`;
  const total = get(`SELECT COUNT(*) AS n ${from}`, ...args).n;
  const rows = all(`SELECT m.* ${from} ORDER BY ${relevance ? 'f.rank' : `CAST(m.id AS INTEGER) ${dir}`} LIMIT ? OFFSET ?`, ...args, limit, offset);
  const threads = [...new Set(rows.map(m => m.channel_id))].map(getChannel).filter(isThread);
  return {
    analytics_id: randomBytes(16).toString('hex'), doing_deep_historical_index: false, total_results: total,
    messages: rows.map(m => {
      const { reactions: _, ...msg } = messageObj(m, getChannel(m.channel_id), userId);
      return [{ ...msg, hit: true }];
    }),
    threads: threads.map(t => threadObj(t, userId)),
    members: threads.map(t => get('SELECT * FROM thread_members WHERE channel_id = ? AND user_id = ?', t.id, userId)).filter(Boolean).map(tm => threadMemberObj(tm)),
  };
}

const readableBy = userId => c => has(channelPerms(c, userId), P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY);

function guildSearch({ params, query, user }) {
  if (!isMember(params.id, user.id)) throw notFound(10004, 'Guild');
  const channels = all('SELECT * FROM channels WHERE guild_id = ? AND type != 4', params.id);
  const nsfw = new Set(channels.filter(c => c.nsfw).map(c => c.id));
  const readable = channels.filter(readableBy(user.id)).map(c => ({ ...c, nsfw_effective: nsfw.has(c.id) || nsfw.has(c.parent_id) }));
  return search(query, readable, user.id);
}

function channelSearch({ params, query, user }) {
  const ch = loadChannel(params.id, user);
  need(ch.perms, P.READ_MESSAGE_HISTORY);
  const parent = isThread(ch) ? getChannel(ch.parent_id) : null;
  return search(query, [{ ...ch, nsfw_effective: !!(ch.nsfw || parent?.nsfw) }], user.id);
}

export default [
  ['GET', '/guilds/:id/messages/search', guildSearch],
  ['GET', '/channels/:id/messages/search', channelSearch],
];
