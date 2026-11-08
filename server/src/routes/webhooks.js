import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import { snowflake } from '../snowflake.js';
import { get, all, run, userById, userObj } from '../db.js';
import { HttpError, str, int, invalid, idParam, snowflakeField, notFound } from '../errors.js';
import { P, need, has, channelPerms, viewersOf, isThread } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { saveImage, removeImage } from '../files.js';
import { audit, A, diff } from '../audit.js';
import { proxyUrl } from '../proxy.js';
import { richEmbeds } from '../embeds.js';
import { readPayload, prepare, send } from '../compose.js';
import { F, messageObj, getMessage, getChannel, broadcastMessage, deleteMessages, insertMessage, unfurlLater } from '../message.js';
import { loadChannel } from './channels.js';
import { loadGuild } from './guilds.js';
import { insertThread, threadEvent, reopened, tagsField } from './threads.js';

const HOOKABLE = [0, 2, 5, 13, 15];
const newToken = () => randomBytes(51).toString('base64url');

export function webhookObj(w, { withUser = true, withToken = true } = {}) {
  const out = {
    id: w.id, type: w.type, guild_id: w.guild_id, channel_id: w.channel_id, name: w.name, avatar: w.avatar, application_id: null,
    ...(withUser && { user: userObj(userById(w.user_id)) }),
    ...(withToken && w.token && { token: w.token }),
  };
  if (w.type === 2) {
    const sg = get('SELECT id, name, icon FROM guilds WHERE id = ?', w.source_guild_id);
    const sc = getChannel(w.source_channel_id);
    Object.assign(out, { source_guild: sg && { id: sg.id, name: sg.name, icon: sg.icon }, source_channel: sc && { id: sc.id, name: sc.name } });
  }
  return out;
}

const getWebhook = id => get('SELECT * FROM webhooks WHERE id = ?', id);

// WEBHOOKS_UPDATE to whoever manages webhooks in that channel
function announce(w) {
  const ch = getChannel(w.channel_id);
  if (!ch) return;
  const ids = viewersOf(ch).filter(id => has(channelPerms(ch, id), P.MANAGE_WEBHOOKS));
  sendToUsers(ids, 'WEBHOOKS_UPDATE', { guild_id: w.guild_id, channel_id: w.channel_id });
}

// token routes: unknown or deleted webhook 404 (10015), wrong token 401 (50027)
function byToken({ params }) {
  const w = getWebhook(params.webhook_id);
  if (!w) throw notFound(10015, 'Webhook');
  const hash = s => createHash('sha256').update(String(s)).digest();
  if (!w.token || !timingSafeEqual(hash(w.token), hash(params.token))) throw new HttpError(401, 50027, 'Invalid Webhook Token');
  return w;
}

// authenticated routes: MANAGE_WEBHOOKS in the webhook's channel
function byId({ params, user }) {
  const w = getWebhook(params.webhook_id);
  if (!w) throw notFound(10015, 'Webhook');
  need(loadChannel(w.channel_id, user).perms, P.MANAGE_WEBHOOKS);
  return w;
}

const nameField = body => {
  const n = str(body, 'name', 1, 80);
  if (/cillhub/i.test(n)) throw invalid('name', 'WEBHOOK_NAME_INVALID', 'Name cannot contain "cillhub".');
  return n;
};

async function create(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  if (!HOOKABLE.includes(ch.type)) throw new HttpError(400, 50024, 'Cannot execute action on this channel type');
  need(ch.perms, P.MANAGE_WEBHOOKS);
  const body = ctx.body ?? {};
  const name = nameField(body);
  if (get('SELECT COUNT(*) AS n FROM webhooks WHERE channel_id = ?', ch.id).n >= 15) throw new HttpError(400, 30007, 'Maximum number of webhooks reached (15)');
  const id = snowflake();
  const avatar = body.avatar == null ? null : await saveImage(body.avatar, 'avatar', 'avatars', id);
  run('INSERT INTO webhooks (id, type, guild_id, channel_id, user_id, name, avatar, token) VALUES (?, 1, ?, ?, ?, ?, ?, ?)',
    id, ch.guild_id, ch.id, ctx.user.id, name, avatar, newToken());
  const w = getWebhook(id);
  audit(ctx, ch.guild_id, A.WEBHOOK_CREATE, id, { changes: diff({}, { name, type: 1, channel_id: ch.id, avatar_hash: avatar }) });
  announce(w);
  return webhookObj(w);
}

async function modify(ctx, w, byTokenRoute) {
  const body = ctx.body ?? {};
  const next = { name: body.name === undefined ? w.name : nameField(body), channel_id: w.channel_id, avatar: w.avatar };
  if (body.avatar !== undefined) next.avatar = await saveImage(body.avatar, 'avatar', 'avatars', w.id);
  if (body.channel_id !== undefined && !byTokenRoute) {
    const ch = loadChannel(snowflakeField(body, 'channel_id'), ctx.user);
    if (ch.guild_id !== w.guild_id || !HOOKABLE.includes(ch.type) || w.type !== 1) throw invalid('channel_id', 'BASE_TYPE_INVALID', 'Not a channel of this guild that takes webhooks.');
    need(ch.perms, P.MANAGE_WEBHOOKS);
    next.channel_id = ch.id;
  }
  run('UPDATE webhooks SET name = ?, avatar = ?, channel_id = ? WHERE id = ?', next.name, next.avatar, next.channel_id, w.id);
  if (next.avatar !== w.avatar) removeImage('avatars', w.id, w.avatar);
  const out = getWebhook(w.id);
  audit(byTokenRoute ? null : ctx, w.guild_id, A.WEBHOOK_UPDATE, w.id, {
    changes: diff({ name: w.name, channel_id: w.channel_id, avatar_hash: w.avatar }, { name: out.name, channel_id: out.channel_id, avatar_hash: out.avatar }),
  });
  announce(w);
  if (next.channel_id !== w.channel_id) announce(out);
  return webhookObj(out, { withUser: !byTokenRoute, withToken: !byTokenRoute });
}

function remove(ctx, w, byTokenRoute) {
  run('DELETE FROM webhooks WHERE id = ?', w.id);
  removeImage('avatars', w.id, w.avatar);
  audit(byTokenRoute ? null : ctx, w.guild_id, A.WEBHOOK_DELETE, w.id, { changes: diff({ name: w.name, type: w.type, channel_id: w.channel_id }, {}, ['name', 'type', 'channel_id']) });
  announce(w);
}

function regenerate(ctx) {
  const w = byId(ctx);
  if (w.type !== 1) throw new HttpError(400, 50024, 'Only incoming webhooks have a token');
  run('UPDATE webhooks SET token = ? WHERE id = ?', newToken(), w.id);
  audit(ctx, w.guild_id, A.WEBHOOK_UPDATE, w.id);
  return webhookObj(getWebhook(w.id));
}

// the channel a token route works in: the webhook's own, or a thread under it via ?thread_id
function targetChannel(w, query) {
  const threadId = idParam(query, 'thread_id');
  const ch = getChannel(threadId ?? w.channel_id);
  if (!ch || (threadId && (!isThread(ch) || ch.parent_id !== w.channel_id))) throw notFound(10003, 'Channel');
  return ch;
}

function author(w, body) {
  const username = body.username == null ? w.name : nameField({ name: body.username });
  if (body.avatar_url == null) return { username, avatar: w.avatar };
  if (typeof body.avatar_url !== 'string' || !/^https?:\/\//i.test(body.avatar_url)) throw invalid('avatar_url', 'URL_TYPE_INVALID_URL', 'Not a well formed URL.');
  return { username, avatar: null, avatar_url: proxyUrl(body.avatar_url) };
}

async function execute(ctx) {
  const w = byToken(ctx);
  const { body, files } = await readPayload(ctx);
  let ch = targetChannel(w, ctx.query);
  const forum = ch.type === 15;
  if (forum && !body.thread_name) throw new HttpError(400, 220001, 'Webhooks posted to forum channels must have a thread_name or thread_id');
  if (body.thread_name != null && ch.id !== w.channel_id) throw new HttpError(400, 220002, 'Webhooks posted to forum channels cannot have both a thread_name and thread_id');
  if (body.thread_name != null && !forum) throw new HttpError(400, 220003, 'Webhooks can only create threads in forum channels');
  const webhook = { id: w.id, author: author(w, body) };
  const d = await prepare({ ch, perms: 0n, userId: w.user_id, webhook }, body, files);
  let thread = null;
  if (forum) {
    ch.perms = P.MANAGE_THREADS; // webhooks set any of the forum's tags
    const tags = body.applied_tags == null ? [] : tagsField(body, ch, null, ch.perms);
    thread = insertThread(ch, { name: str(body, 'thread_name', 1, 100), type: 11, applied_tags: tags, rate_limit_per_user: ch.default_thread_rate_limit_per_user }, w.user_id);
    d.ch = ch = thread;
  }
  const m = await send(d, w.user_id, { webhook, ...(thread && { id: thread.id }) });
  if (thread) {
    run('UPDATE channels SET last_message_id = ? WHERE id = ?', thread.id, thread.parent_id);
    threadEvent(thread, 'THREAD_CREATE', { newly_created: true });
  } else if (isThread(ch)) reopened(ch);
  if (ctx.query.get('wait') !== 'true') return undefined;
  return messageObj(m, ch, null);
}

function loadWebhookMessage(ctx) {
  const w = byToken(ctx);
  const ch = targetChannel(w, ctx.query);
  const m = get('SELECT * FROM messages WHERE id = ? AND channel_id = ? AND webhook_id = ?', ctx.params.mid, ch.id, w.id);
  if (!m) throw notFound(10008, 'Message');
  return [w, ch, m];
}

function editMessage(ctx) {
  const [, ch, m] = loadWebhookMessage(ctx);
  const body = ctx.body ?? {};
  const content = body.content === undefined ? m.content : str(body, 'content', 0, 2000, false);
  const embeds = body.embeds === undefined ? m.embeds : JSON.stringify(richEmbeds(body.embeds));
  const flags = body.flags === undefined ? m.flags : (m.flags & ~F.SUPPRESS_EMBEDS) | (int(body, 'flags', 0, 2 ** 31) & F.SUPPRESS_EMBEDS);
  if (!content.trim() && embeds === '[]' && !get('SELECT 1 FROM attachments WHERE message_id = ?', m.id)) throw new HttpError(400, 50006, 'Cannot send an empty message');
  const relink = content !== m.content || flags !== m.flags;
  run(`UPDATE messages SET content = ?, embeds = ?, flags = ?, edited_timestamp = ?, link_embeds = CASE WHEN ? THEN '[]' ELSE link_embeds END WHERE id = ?`,
    content, embeds, flags, new Date().toISOString(), Number(relink), m.id);
  const out = getMessage(m.id);
  broadcastMessage(ch, 'MESSAGE_UPDATE', out);
  if (relink && !(flags & F.SUPPRESS_EMBEDS)) unfurlLater(out);
  return messageObj(out, ch, null);
}

function deleteMessage(ctx) {
  const [, ch, m] = loadWebhookMessage(ctx);
  const viewers = viewersOf(ch);
  deleteMessages([m]);
  sendToUsers(viewers, 'MESSAGE_DELETE', { id: m.id, channel_id: ch.id, guild_id: ch.guild_id });
}

// POST /channels/:id/followers: a channel follower webhook in the target channel re-posts every published message
function follow(ctx) {
  const src = loadChannel(ctx.params.id, ctx.user);
  if (src.type !== 5) throw new HttpError(400, 50024, 'Cannot execute action on this channel type');
  const target = loadChannel(snowflakeField(ctx.body ?? {}, 'webhook_channel_id'), ctx.user);
  if (target.type !== 0 && target.type !== 5) throw new HttpError(400, 50024, 'Cannot execute action on this channel type');
  need(target.perms, P.MANAGE_WEBHOOKS);
  const sg = get('SELECT * FROM guilds WHERE id = ?', src.guild_id);
  const name = `${sg.name} #${src.name}`.slice(0, 80);
  const id = snowflake();
  run(`INSERT INTO webhooks (id, type, guild_id, channel_id, user_id, name, source_guild_id, source_channel_id)
       VALUES (?, 2, ?, ?, ?, ?, ?, ?)`, id, target.guild_id, target.id, ctx.user.id, name, sg.id, src.id);
  audit(ctx, target.guild_id, A.WEBHOOK_CREATE, id, { changes: diff({}, { name, type: 2, channel_id: target.id }) });
  announce(getWebhook(id));
  const m = insertMessage({ ch: target, authorId: ctx.user.id, type: 12, content: name, reference: { channel_id: src.id, guild_id: src.guild_id } });
  broadcastMessage(target, 'MESSAGE_CREATE', m);
  return { channel_id: src.id, webhook_id: id };
}

const tokenPath = '/webhooks/:webhook_id/:token';
export default [
  ['POST', '/channels/:id/webhooks', create, { maxBody: 12 * 1024 * 1024 }],
  ['GET', '/channels/:id/webhooks', ({ params, user }) => {
    const ch = loadChannel(params.id, user);
    need(ch.perms, P.MANAGE_WEBHOOKS);
    return all('SELECT * FROM webhooks WHERE channel_id = ? ORDER BY rowid', ch.id).map(w => webhookObj(w));
  }],
  ['GET', '/guilds/:id/webhooks', ({ params, user }) => all(
    'SELECT * FROM webhooks WHERE guild_id = ? ORDER BY rowid', loadGuild(params.id, user, P.MANAGE_WEBHOOKS).id,
  ).map(w => webhookObj(w))],
  ['POST', '/channels/:id/followers', follow],
  ['POST', '/webhooks/:webhook_id/regenerate-token', regenerate],
  ['GET', '/webhooks/:webhook_id', ctx => webhookObj(byId(ctx))],
  ['PATCH', '/webhooks/:webhook_id', ctx => modify(ctx, byId(ctx), false), { maxBody: 12 * 1024 * 1024 }],
  ['DELETE', '/webhooks/:webhook_id', ctx => remove(ctx, byId(ctx), false)],
  ['GET', tokenPath, ctx => webhookObj(byToken(ctx), { withUser: false }), { open: true }],
  ['PATCH', tokenPath, ctx => modify(ctx, byToken(ctx), true), { open: true, maxBody: 12 * 1024 * 1024 }],
  ['DELETE', tokenPath, ctx => remove(ctx, byToken(ctx), true), { open: true }],
  ['POST', tokenPath, execute, { open: true, multipart: true }],
  ['GET', `${tokenPath}/messages/:mid`, ctx => { const [, ch, m] = loadWebhookMessage(ctx); return messageObj(m, ch, null); }, { open: true }],
  ['PATCH', `${tokenPath}/messages/:mid`, editMessage, { open: true }],
  ['DELETE', `${tokenPath}/messages/:mid`, deleteMessage, { open: true }],
];

