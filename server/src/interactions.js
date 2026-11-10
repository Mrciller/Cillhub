// Interactions: tokens (15 min), delivery to the bot (gateway or Ed25519-signed HTTP), the 3 s deadline, callbacks,
// and the messages they create; ephemeral messages live only in memory and only reach the invoking user
import { createHash, randomBytes, sign as edSign, createPrivateKey } from 'node:crypto';
import { maxUpload } from './instance.js';
import { mkdirSync, renameSync, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream';
import { join } from 'node:path';
import { snowflake } from './snowflake.js';
import { DATA_DIR, get, all, run, tx, userById, userObj, memberRow, memberObj, channelObj } from './db.js';
import { saveAttachment, removeAttachment, removeChannelFiles, safeFilename } from './files.js';
import { HttpError, str, int, invalid, notFound } from './errors.js';
import { channelPerms, viewersOf } from './permissions.js';
import { sendToUsers, sendToSession, sessionById } from './gateway.js';
import { safeFetch } from './ssrf.js';
import { richEmbeds } from './embeds.js';
import { messageComponents, modal } from './components.js';
import { allowedMentions } from './compose.js';
import { settingsOf } from './userdata.js';
import {
  F, IS_SPOILER, insertMessage, broadcastMessage, messageObj, getMessage, bumpMentions, countedMentions, deleteMessages, interactionFields, attachmentUrl,
} from './message.js';

const TOKEN_TTL = 15 * 60 * 1000;
const DEADLINE = 3000;
const PREFIX = 'aW50ZXJhY3Rpb246'; // base64 of "interaction:", how webhook routes tell interaction tokens apart
// applications that run inside this process (the built-in Cillhub Bot): app id -> handler(interaction payload)
export const localApps = new Map();
export const isInteractionToken = t => typeof t === 'string' && t.startsWith(PREFIX);
const hash = t => createHash('sha256').update(String(t)).digest('hex');
const records = new Map(); // id -> interaction record
const byToken = new Map(); // sha256(token) -> record
const ephemerals = new Map(); // message id -> { msg, userId, appId, expires }

function sweep() {
  const now = Date.now();
  for (const [id, r] of records) if (now - r.created > TOKEN_TTL) { records.delete(id); byToken.delete(hash(r.token)); }
  for (const [id, e] of ephemerals) if (e.expires <= now) ephemerals.delete(id);
  for (const [id, f] of ephFiles) if (f.expires <= now) { ephFiles.delete(id); removeAttachment(EPH, id); }
}

// --- uploads ------------------------------------------------------------------------------------------------------
// Files that belong to no stored message (ATTACHMENT option values, files of ephemeral responses) live 15 minutes under
// attachments/ephemeral/ (no channel id is ever "ephemeral") and are served at /ephemeral-attachments/<app>/<id>/<name>,
// the documented path for them. Files of a stored response are moved into the channel's folder and become normal attachments.
const EPH = 'ephemeral';
const ephFiles = new Map(); // attachment id -> { appId, filename, size, content_type, expires }
removeChannelFiles(EPH); // nothing outlives a restart
const ephPath = id => join(DATA_DIR, 'attachments', EPH, id);
// ids are time-based and filenames guessable: the random key in the URL is what makes the link private
const ephUrl = (appId, a) => `/ephemeral-attachments/${appId}/${a.id}/${a.filename}?key=${ephFiles.get(a.id)?.key ?? ''}`;
const uploadObj = (a, url) => ({
  id: a.id, filename: a.filename, size: a.size, content_type: a.content_type, url, proxy_url: url,
  ...(a.width != null && { width: a.width, height: a.height }), ...(a.description != null && { description: a.description }), flags: a.flags ?? 0,
});
export const ephemeralAttachment = (appId, a) => ({ ...uploadObj(a, ephUrl(appId, a)), ephemeral: true });

// multipart files[n] with their partial attachment objects ({id: n, filename?, description?}); at most 10, 25 MiB each
export async function stageFiles(appId, files, metas) {
  if (!files.length) return [];
  if (files.length > 10) throw invalid('files', 'BASE_TYPE_MAX_LENGTH', 'At most 10 files.');
  if (files.some(f => f.file.size > maxUpload())) throw new HttpError(413, 40005, 'Request entity too large');
  sweep();
  const byN = new Map((Array.isArray(metas) ? metas : []).map(m => [Number(m?.id), m]));
  const out = [];
  for (const { n, file } of files) {
    const id = snowflake();
    const a = { id, n, ...await saveAttachment(EPH, id, file), flags: 0 };
    const meta = byN.get(n);
    if (typeof meta?.filename === 'string' && meta.filename) a.filename = safeFilename(meta.filename);
    if (typeof meta?.description === 'string' && meta.description) a.description = meta.description.slice(0, 1024);
    if (a.filename.startsWith('SPOILER_')) a.flags = IS_SPOILER;
    ephFiles.set(id, { appId, key: randomBytes(18).toString('base64url'), filename: a.filename, size: a.size, content_type: a.content_type, expires: Date.now() + TOKEN_TTL });
    out.push(a);
  }
  return out;
}
export const discardFiles = uploads => uploads.forEach(a => { ephFiles.delete(a.id); removeAttachment(EPH, a.id); });

// a staged upload becomes a normal attachment of a stored message in this channel
function keepFiles(uploads, channelId) {
  mkdirSync(join(DATA_DIR, 'attachments', channelId), { recursive: true });
  for (const a of uploads) { renameSync(ephPath(a.id), join(DATA_DIR, 'attachments', channelId, a.id)); ephFiles.delete(a.id); }
  return uploads.map(a => ({ ...a, channel_id: channelId }));
}

const EPH_PATH = /^\/ephemeral-attachments\/(\d{1,19})\/(\d{1,19})\/([^/]+)$/;
export const isEphemeralPath = pathname => EPH_PATH.test(pathname);
// always a download when opened directly (img/video/audio elements still render it); nosniff and a sandbox CSP as for uploads
export function serveEphemeral(req, res, pathname) {
  const [, appId, id, name] = EPH_PATH.exec(pathname);
  const f = ephFiles.get(id);
  const key = new URL(req.url, 'http://x').searchParams.get('key');
  if (!f || f.appId !== appId || f.filename !== name || f.key !== key || f.expires <= Date.now()) throw new HttpError(404, 0, '404: Not Found');
  res.writeHead(200, {
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Type': f.content_type,
    'Content-Length': f.size, 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Cache-Control': 'private, max-age=900',
    'Access-Control-Allow-Origin': '*',
  });
  if (req.method === 'HEAD') return res.end();
  pipeline(createReadStream(ephPath(id)), res, () => {});
}

// --- HTTP delivery ------------------------------------------------------------------------------------------------
export function signedHeaders(app, body) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = edSign(null, Buffer.from(ts + body), createPrivateKey(app.private_key)).toString('hex');
  return { 'X-Signature-Ed25519': sig, 'X-Signature-Timestamp': ts };
}

function postSigned(app, url, payload, badSignature = false) {
  const body = JSON.stringify(payload);
  const headers = { 'Content-Type': 'application/json', ...signedHeaders(app, body) };
  if (badSignature) headers['X-Signature-Ed25519'] = '00'.repeat(64);
  return safeFetch(url, { method: 'POST', headers, body, maxBytes: 1024 * 1024, truncate: false, timeout: DEADLINE });
}

const parse = buf => { try { return JSON.parse(buf.toString()); } catch { return null; } };

// saving an interactions endpoint: a signed PING must get PONG and a badly signed one must get 401 (the documented check)
export async function verifyEndpoint(app, url) {
  let ok = false;
  try {
    const ping = { id: snowflake(), application_id: app.id, type: 1, token: PREFIX + randomBytes(32).toString('base64url'), version: 1 };
    const good = await postSigned(app, url, ping);
    const bad = await postSigned(app, url, ping, true);
    ok = good.status === 200 && parse(good.body)?.type === 1 && bad.status === 401;
  } catch { /* unreachable or refused by the SSRF guard */ }
  if (!ok) throw invalid('interactions_endpoint_url', 'APPLICATION_INTERACTIONS_ENDPOINT_URL_INVALID', 'The specified interactions endpoint url could not be verified.');
}

async function httpDeliver(rec, payload) {
  try {
    const res = await postSigned(rec.app, rec.app.interactions_endpoint_url, payload);
    const body = res.status === 200 ? parse(res.body) : null;
    if (body?.type) respond(rec, body, false); // the inline response (docs)
    else if (res.status !== 202 && res.status !== 204 && res.status !== 200) fail(rec);
  } catch {
    fail(rec);
  }
}

// --- lifecycle ----------------------------------------------------------------------------------------------------
function toInvoker(rec, t, d) {
  const s = rec.sessionId && sessionById(rec.sessionId);
  if (s && s.user.id === rec.userId) sendToSession(s, t, d);
  else sendToUsers([rec.userId], t, d);
}

// past the deadline without a response: the client hears INTERACTION_FAILURE and the token is dead
function fail(rec) {
  if (rec.responded || rec.expired) return;
  rec.expired = true;
  toInvoker(rec, 'INTERACTION_FAILURE', { id: rec.id, nonce: rec.nonce ?? null, reason_code: 2 });
}

function contextOf(ch, app) {
  if (ch.guild_id) return 0;
  return ch.type === 1 && get('SELECT 1 FROM dm_recipients WHERE channel_id = ? AND user_id = ?', ch.id, app.id) ? 1 : 2;
}

// the interaction object the app receives (official docs)
function payloadOf(rec, user, message) {
  const { ch, app } = rec;
  const g = ch.guild_id;
  return {
    id: rec.id, application_id: app.id, type: rec.type, data: rec.data, ...(g && { guild_id: g, guild: { id: g, locale: 'en-US', features: [] } }),
    channel: channelObj(ch, app.id), channel_id: ch.id,
    ...(g ? { member: { ...memberObj(memberRow(g, user.id)), permissions: String(channelPerms(ch, user.id)) } } : { user: userObj(user) }),
    token: rec.token, version: 1, ...(message && { message }), app_permissions: String(channelPerms(ch, app.id)),
    locale: settingsOf(user.id).locale, ...(g && { guild_locale: 'en-US' }), entitlements: [],
    authorizing_integration_owners: { 0: g ?? '0' }, context: contextOf(ch, app), attachment_size_limit: maxUpload(),
  };
}

// a validated user interaction: assign id and token, tell the client, deliver to the app, start the 3 s clock
export function startInteraction({ app, user, ch, type, data, message, sessionId, nonce, meta }) {
  sweep();
  const rec = {
    id: snowflake(), token: PREFIX + randomBytes(48).toString('base64url'), app, userId: user.id, ch, type, data, messageId: message?.id,
    sessionId, nonce, created: Date.now(), responded: false, expired: false, messageIds: new Set(), meta,
  };
  records.set(rec.id, rec);
  byToken.set(hash(rec.token), rec);
  toInvoker(rec, 'INTERACTION_CREATE', { id: rec.id, nonce: nonce ?? null });
  rec.timer = setTimeout(() => fail(rec), DEADLINE);
  const payload = payloadOf(rec, user, message);
  const local = localApps.get(app.id);
  if (local) setImmediate(() => local(payload));
  else if (app.interactions_endpoint_url) httpDeliver(rec, payload);
  else sendToUsers([app.id], 'INTERACTION_CREATE', payload);
  return rec;
}

export const interactionRecord = id => records.get(id);
export const ephemeralFor = (id, userId, appId) => {
  const e = ephemerals.get(id);
  return e && e.userId === userId && e.appId === appId ? e.msg : null;
};

// --- messages created by interactions -------------------------------------------------------------------------------
const RESPONSE_FLAGS = F.EPHEMERAL | F.SUPPRESS_EMBEDS | F.SUPPRESS_NOTIFICATIONS;

function messageFields(d, partial, urlOf = () => null) {
  const out = {};
  if (!partial || d.content !== undefined) out.content = d.content == null ? '' : str(d, 'content', 0, 2000, false);
  if (!partial || d.embeds !== undefined) out.embeds = richEmbeds(d.embeds ?? [], urlOf);
  if (!partial || d.components !== undefined) out.components = messageComponents(d.components ?? []);
  return out;
}

// embeds may point at this message's new files with attachment://<filename>
const resolverFor = (uploads, url) => name => { const a = uploads.find(x => x.filename === name); return a ? url(a) : null; };

// CHANNEL_MESSAGE_WITH_SOURCE, DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE (loading) and follow-ups; uploads from stageFiles()
function createMessage(rec, d, { loading = false, followup = false, uploads = [] } = {}) {
  const flags = d.flags == null ? 0 : int(d, 'flags', 0, 2 ** 31);
  if (flags & ~RESPONSE_FLAGS) throw invalid('flags', 'MESSAGE_FLAGS_INVALID', 'Unsupported message flags.');
  if (loading && uploads.length) throw invalid('files', 'BASE_TYPE_BAD_VALUE', 'A deferred response carries no files.');
  const { ch, app } = rec;
  const eph = !!(flags & F.EPHEMERAL);
  const url = a => (eph ? ephUrl(app.id, a) : attachmentUrl({ ...a, channel_id: ch.id }));
  const f = loading ? { content: '', embeds: [], components: [] } : messageFields(d, false, resolverFor(uploads, url));
  if (!loading && !f.content.trim() && !f.embeds.length && !f.components.length && !uploads.length) throw new HttpError(400, 50006, 'Cannot send an empty message');
  const meta = { id: rec.id, type: rec.type, user_id: rec.userId, owners: { 0: ch.guild_id ?? '0' }, ...rec.meta };
  const type = followup || rec.type !== 2 ? 0 : rec.meta.command_type === 1 ? 20 : 23;
  const allFlags = (loading ? flags & F.EPHEMERAL : flags) | (loading ? F.LOADING : 0);
  if (allFlags & F.EPHEMERAL) {
    const msg = {
      id: snowflake(), type, channel_id: ch.id, ...(ch.guild_id && { guild_id: ch.guild_id }), author: userObj(userById(app.id)), ...f,
      attachments: uploads.map(a => ephemeralAttachment(app.id, a)), mentions: [], mention_roles: [], mention_everyone: false, pinned: false, tts: false,
      timestamp: new Date().toISOString(), edited_timestamp: null, flags: allFlags, webhook_id: app.id, application_id: app.id, ...interactionFields(meta),
    };
    ephemerals.set(msg.id, { msg, userId: rec.userId, appId: app.id, expires: Date.now() + TOKEN_TTL });
    sendToUsers([rec.userId], 'MESSAGE_CREATE', msg); // never stored, never sent to anyone else
    rec.messageIds.add(msg.id);
    return msg;
  }
  const allowed = allowedMentions(d.allowed_mentions);
  const counted = countedMentions(f.content, ch, channelPerms(ch, app.id), allowed);
  const m = insertMessage({
    ch, authorId: app.id, content: f.content, type, flags: allFlags, embeds: f.embeds, components: f.components, applicationId: app.id,
    interaction: meta, webhook: { id: app.id, author: {} }, mentionEveryone: counted.all || counted.here, mentionRoles: counted.roleIds,
    attachments: keepFiles(uploads, ch.id),
  });
  bumpMentions(ch, m, counted, allowed && (id => allowed.parse.includes('users') || allowed.users.includes(id)));
  broadcastMessage(ch, 'MESSAGE_CREATE', m);
  rec.messageIds.add(m.id);
  return messageObj(m, ch, rec.userId);
}

// which existing attachments an edit keeps: all of them unless `attachments` lists the ones to keep (docs, Edit Webhook Message)
function keptIds(d, uploads) {
  if (d?.attachments == null) return null;
  if (!Array.isArray(d.attachments)) throw invalid('attachments', 'BASE_TYPE_ARRAY', 'Must be an array.');
  const fresh = new Set(uploads.map(a => a.n));
  return new Set(d.attachments.filter(a => !fresh.has(Number(a?.id))).map(a => String(a?.id)));
}

// UPDATE_MESSAGE and webhook edits: content, embeds, components, files and SUPPRESS_EMBEDS; a loading message stops loading
function editMessage(rec, id, d, uploads = []) {
  const eph = ephemerals.get(id);
  const keep = keptIds(d, uploads);
  const suppress = d?.flags == null ? null : int(d, 'flags', 0, 2 ** 31) & F.SUPPRESS_EMBEDS;
  if (eph) {
    if (eph.userId !== rec.userId || eph.appId !== rec.app.id) throw notFound(10008, 'Message');
    const changes = messageFields(d ?? {}, true, resolverFor(uploads, a => ephUrl(rec.app.id, a)));
    const wasLoading = eph.msg.flags & F.LOADING;
    const attachments = [...eph.msg.attachments.filter(a => !keep || keep.has(a.id)), ...uploads.map(a => ephemeralAttachment(rec.app.id, a))];
    Object.assign(eph.msg, changes, { attachments, flags: (eph.msg.flags & ~F.LOADING & ~F.SUPPRESS_EMBEDS) | (suppress ?? (eph.msg.flags & F.SUPPRESS_EMBEDS)), edited_timestamp: wasLoading ? null : new Date().toISOString() });
    sendToUsers([rec.userId], 'MESSAGE_UPDATE', eph.msg);
    return eph.msg;
  }
  const m = get('SELECT * FROM messages WHERE id = ? AND channel_id = ? AND application_id = ?', id, rec.ch.id, rec.app.id);
  if (!m) throw notFound(10008, 'Message');
  const changes = messageFields(d ?? {}, true, resolverFor(uploads, a => attachmentUrl({ ...a, channel_id: rec.ch.id })));
  const content = changes.content ?? m.content;
  const embeds = changes.embeds ? JSON.stringify(changes.embeds) : m.embeds;
  const components = changes.components ? JSON.stringify(changes.components) : m.components;
  const old = all('SELECT id, channel_id FROM attachments WHERE message_id = ? AND in_snapshot = 0', m.id);
  const dropped = keep ? old.filter(a => !keep.has(a.id)) : [];
  if (!content.trim() && embeds === '[]' && components === '[]' && old.length === dropped.length && !uploads.length) throw new HttpError(400, 50006, 'Cannot send an empty message');
  const flags = (m.flags & ~F.LOADING & ~F.SUPPRESS_EMBEDS) | (suppress ?? (m.flags & F.SUPPRESS_EMBEDS));
  const added = keepFiles(uploads, rec.ch.id);
  tx(() => {
    run('UPDATE messages SET content = ?, embeds = ?, components = ?, flags = ?, edited_timestamp = ? WHERE id = ?',
      content, embeds, components, flags, m.flags & F.LOADING ? null : new Date().toISOString(), m.id);
    for (const a of dropped) run('DELETE FROM attachments WHERE id = ?', a.id);
    for (const a of added) {
      run(`INSERT INTO attachments (id, message_id, channel_id, filename, size, content_type, width, height, description, flags)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, a.id, m.id, a.channel_id, a.filename, a.size, a.content_type, a.width ?? null, a.height ?? null, a.description ?? null, a.flags);
    }
  });
  dropped.forEach(a => removeAttachment(a.channel_id, a.id));
  const out = getMessage(m.id);
  broadcastMessage(rec.ch, 'MESSAGE_UPDATE', out);
  return messageObj(out, rec.ch, rec.userId);
}

function deleteMessage(rec, id) {
  const eph = ephemerals.get(id);
  if (eph) {
    if (eph.userId !== rec.userId) throw notFound(10008, 'Message');
    ephemerals.delete(id);
    return sendToUsers([rec.userId], 'MESSAGE_DELETE', { id, channel_id: rec.ch.id, guild_id: rec.ch.guild_id ?? undefined });
  }
  const m = get('SELECT * FROM messages WHERE id = ? AND channel_id = ? AND application_id = ?', id, rec.ch.id, rec.app.id);
  if (!m) throw notFound(10008, 'Message');
  const viewers = viewersOf(rec.ch);
  deleteMessages([m]);
  sendToUsers(viewers, 'MESSAGE_DELETE', { id, channel_id: rec.ch.id, guild_id: rec.ch.guild_id ?? undefined });
}

function getAppMessage(rec, id) {
  const eph = ephemerals.get(id);
  if (eph && eph.userId === rec.userId) return eph.msg;
  const m = get('SELECT * FROM messages WHERE id = ? AND channel_id = ? AND application_id = ?', id, rec.ch.id, rec.app.id);
  if (!m) throw notFound(10008, 'Message');
  return messageObj(m, rec.ch, rec.userId);
}

// --- callback (POST /interactions/:id/:token/callback) ------------------------------------------------------------
export function recordForCallback(id, token) {
  const rec = byToken.get(hash(token));
  if (!rec || rec.id !== id || rec.expired || Date.now() - rec.created > TOKEN_TTL) throw notFound(10062, 'interaction');
  return rec;
}

const wrongType = () => invalid('type', 'INTERACTION_RESPONSE_TYPE_INVALID', 'This response type is not valid for this interaction.');

export function respond(rec, body, withResponse, uploads = []) {
  if (rec.responded) throw new HttpError(400, 40060, 'Interaction has already been acknowledged');
  const d = body?.data ?? {};
  const onMessage = rec.type === 3 || (rec.type === 5 && rec.messageId);
  let message = null;
  switch (body?.type) {
    case 4: case 5:
      if (rec.type === 4) throw wrongType();
      message = createMessage(rec, d, { loading: body.type === 5, uploads });
      rec.originalId = message.id;
      break;
    case 6: case 7:
      if (!onMessage) throw wrongType();
      if (body.type === 7) message = editMessage(rec, rec.messageId, d, uploads);
      rec.originalId = rec.messageId;
      break;
    case 8: {
      if (rec.type !== 4 || uploads.length) throw wrongType();
      const choices = d.choices ?? [];
      if (!Array.isArray(choices) || choices.length > 25 || !choices.every(c => typeof c?.name === 'string' && c.name.length <= 100 && ['string', 'number'].includes(typeof c.value))) {
        throw invalid('data.choices', 'BASE_TYPE_MAX_LENGTH', 'Up to 25 choices with a name and a value.');
      }
      toInvoker(rec, 'APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE', { choices: choices.map(c => ({ name: c.name, value: c.value })), nonce: rec.nonce ?? null });
      break;
    }
    case 9:
      if (rec.type === 4 || rec.type === 5 || uploads.length) throw wrongType();
      rec.modal = modal(d);
      toInvoker(rec, 'INTERACTION_MODAL_CREATE', {
        id: rec.id, nonce: rec.nonce ?? null, channel_id: rec.ch.id, ...rec.modal, application: { id: rec.app.id, name: rec.app.name, icon: rec.app.icon },
      });
      break;
    default: throw invalid('type', 'INTERACTION_RESPONSE_TYPE_INVALID', 'Unsupported interaction callback type.');
  }
  rec.responded = true;
  rec.loading = body.type === 5;
  clearTimeout(rec.timer);
  toInvoker(rec, 'INTERACTION_SUCCESS', { id: rec.id, nonce: rec.nonce ?? null });
  if (!withResponse) return undefined;
  return {
    interaction: {
      id: rec.id, type: rec.type,
      ...(rec.originalId && { response_message_id: rec.originalId, response_message_loading: body.type === 5, response_message_ephemeral: ephemerals.has(rec.originalId) }),
    },
    ...(message && body.type !== 5 && { resource: { type: body.type, message } }),
  };
}

// --- /webhooks/:application_id/:token (follow-ups and the original response) -------------------------------------
// unknown token 404 10015; another application's or an expired token 401 50027 (as for webhook tokens)
export function recordForWebhook(appId, token) {
  const rec = byToken.get(hash(token));
  if (!rec) throw notFound(10015, 'Webhook');
  if (rec.app.id !== appId || rec.expired || Date.now() - rec.created > TOKEN_TTL) throw new HttpError(401, 50027, 'Invalid Webhook Token');
  return rec;
}

const messageIdOf = (rec, mid) => {
  const id = mid === '@original' ? rec.originalId : mid;
  if (!id || (mid !== '@original' && !rec.messageIds.has(id) && id !== rec.originalId)) throw notFound(10008, 'Message');
  return id;
};

export function followUp(rec, body, uploads = []) {
  if (!rec.responded) throw new HttpError(400, 40060, 'The interaction has not been acknowledged yet');
  // right after a deferred response a follow-up edits the loading message instead (docs, deprecated behaviour)
  if (rec.loading && rec.originalId) { rec.loading = false; return editMessage(rec, rec.originalId, body, uploads); }
  return createMessage(rec, body ?? {}, { followup: true, uploads });
}
export const webhookMessage = (rec, mid) => getAppMessage(rec, messageIdOf(rec, mid));
export function webhookEdit(rec, mid, body, uploads = []) {
  const id = messageIdOf(rec, mid);
  const out = editMessage(rec, id, body, uploads);
  if (id === rec.originalId) rec.loading = false;
  return out;
}
export const webhookDelete = (rec, mid) => deleteMessage(rec, messageIdOf(rec, mid));
