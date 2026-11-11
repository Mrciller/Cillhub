import { snowflake } from './snowflake.js';
import { maxUpload } from './instance.js';
import { get, idTime } from './db.js';
import { HttpError, str, int, invalid, snowflakeField, snowflakes, rateLimited, notFound } from './errors.js';
import { P, has, need, channelPerms, isThread } from './permissions.js';
import { saveAttachment, removeAttachment, safeFilename } from './files.js';
import { richEmbeds } from './embeds.js';
import {
  F, IS_SPOILER, getChannel, messageObj, insertMessage, bumpMentions, countedMentions, broadcastMessage,
  copyAttachments, unfurlLater, attachmentUrl,
} from './message.js';
import { usableEmoji } from './routes/emojis.js';
import { usableSticker } from './routes/stickers.js';
import { messageComponents } from './components.js';

const USER_FLAGS = F.SUPPRESS_EMBEDS | F.SUPPRESS_NOTIFICATIONS | F.IS_VOICE_MESSAGE;
const WEBHOOK_FLAGS = F.SUPPRESS_EMBEDS | F.SUPPRESS_NOTIFICATIONS;
const FIVE_MIN = 5 * 60 * 1000;

// JSON body, or multipart with payload_json and files[n] (n is what attachments[].id refers to)
export async function readPayload(ctx) {
  if (!ctx.form) return { body: ctx.body ?? {}, files: [] };
  const form = await ctx.form();
  const files = [];
  for (const [k, v] of form) {
    const m = /^files\[(\d+)\]$/.exec(k);
    if (m && typeof v !== 'string') files.push({ n: Number(m[1]), file: v });
  }
  let body;
  try { body = JSON.parse(form.get('payload_json') ?? '{}'); } catch { throw invalid('payload_json', 'JSON_INVALID', 'Must be valid JSON.'); }
  return { body: body ?? {}, files };
}

// slowmode: last send per channel and user, in memory (a restart forgives the remaining wait)
const lastSent = new Map();
export function checkSlowmode(ch, userId, perms) {
  const s = ch.rate_limit_per_user;
  if (!s || has(perms, P.MANAGE_MESSAGES) || has(perms, P.MANAGE_CHANNELS)) return;
  const wait = (lastSent.get(`${ch.id}:${userId}`) ?? 0) + s * 1000 - Date.now();
  if (wait > 0) throw rateLimited(wait / 1000);
}
export function markSent(ch, userId) {
  if (!ch.rate_limit_per_user) return;
  const now = Date.now();
  for (const [k, t] of lastSent) if (now - t > 21600 * 1000) lastSent.delete(k);
  lastSent.set(`${ch.id}:${userId}`, now);
}

// guild verification level: LOW = account older than 5 minutes, MEDIUM = also a member for 5 minutes; members with a role skip it
export function checkVerification(guildId, userId) {
  const g = get('SELECT owner_id, verification_level FROM guilds WHERE id = ?', guildId);
  if (!g?.verification_level || g.owner_id === userId) return;
  if (get('SELECT 1 FROM member_roles WHERE guild_id = ? AND user_id = ?', guildId, userId)) return;
  const joined = Date.parse(get('SELECT joined_at FROM members WHERE guild_id = ? AND user_id = ?', guildId, userId)?.joined_at ?? 0);
  const tooNew = Date.now() - idTime(userId) < FIVE_MIN || (g.verification_level >= 2 && Date.now() - joined < FIVE_MIN);
  if (tooNew) throw new HttpError(403, 50009, 'Channel verification level is too high for you to gain access');
}

// locked threads only take messages from MANAGE_THREADS; archived ones reopen on send
export function checkThreadOpen(ch, perms) {
  if (isThread(ch) && ch.locked && !has(perms, P.MANAGE_THREADS)) throw new HttpError(403, 160005, 'Thread is locked');
}

export function checkSend(ch, userId, perms) {
  need(perms, P.SEND_MESSAGES);
  if (ch.guild_id) checkVerification(ch.guild_id, userId);
  checkThreadOpen(ch, perms);
  checkSlowmode(ch, userId, perms);
}

export function allowedMentions(v) {
  if (v == null) return null;
  if (typeof v !== 'object') throw invalid('allowed_mentions', 'MODEL_TYPE_CONVERT', 'Must be an object.');
  const ids = x => (Array.isArray(x) ? x.map(String) : []);
  return { parse: Array.isArray(v.parse) ? v.parse : [], roles: ids(v.roles), users: ids(v.users) };
}

export function pollField(p) {
  if (typeof p !== 'object' || p === null) throw invalid('poll', 'MODEL_TYPE_CONVERT', 'Must be a poll object.');
  const question = { text: str(p.question ?? {}, 'text', 1, 300) };
  if (!Array.isArray(p.answers) || p.answers.length < 1 || p.answers.length > 10) throw invalid('poll.answers', 'BASE_TYPE_BAD_LENGTH', 'Must have 1 to 10 answers.');
  const answers = p.answers.map((a, i) => {
    const media = a?.poll_media ?? {};
    const e = media.emoji;
    const emoji = e == null ? undefined : e.id != null ? { id: String(e.id) } : { name: str(e, 'name', 1, 32) };
    return { answer_id: i + 1, poll_media: { text: str(media, 'text', 1, 55), ...(emoji && { emoji }) } };
  });
  const hours = p.duration === undefined ? 1 : int(p, 'duration', 1, 768);
  if (p.layout_type !== undefined && p.layout_type !== 1) throw invalid('poll.layout_type', 'BASE_TYPE_CHOICES', 'Only the default layout (1).');
  const anonymous = !!p.anonymous;
  const allowed_role_ids = Array.isArray(p.allowed_role_ids) ? [...new Set(p.allowed_role_ids.map(String))] : [];
  let correct_answer_id = p.correct_answer_id == null ? null : Number(p.correct_answer_id);
  if (correct_answer_id !== null && !answers.some(a => a.answer_id === correct_answer_id)) {
    throw invalid('poll.correct_answer_id', 'BASE_TYPE_CHOICES', 'Unknown answer id.');
  }
  return {
    question, answers, allow_multiselect: !!p.allow_multiselect, layout_type: 1, expiry: Date.now() + hours * 3600 * 1000,
    anonymous, allowed_role_ids, correct_answer_id,
  };
}

// custom emoji the author may not use become plain :name:, which is what the reference client sends instead
export function filterEmoji(content, ch, userId, perms) {
  return content.replace(/<a?:(\w{2,32}):(\d{1,19})>/g, (all, name, id) => (usableEmoji(id, ch, userId, perms) ? all : `:${name}:`));
}

async function forwardOf(ref, userId) {
  const srcCh = getChannel(snowflakeField(ref, 'channel_id'));
  const src = srcCh && get('SELECT * FROM messages WHERE id = ? AND channel_id = ?', snowflakeField(ref, 'message_id'), srcCh.id);
  if (!src) throw notFound(10008, 'Message');
  if (!has(channelPerms(srcCh, userId), P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY)) {
    throw new HttpError(403, 160014, 'You cannot forward a message whose content you cannot read');
  }
  if (![0, 19].includes(src.type) || get('SELECT 1 FROM polls WHERE message_id = ?', src.id)) throw new HttpError(400, 50068, 'Invalid message type');
  return { src, srcCh };
}

function attachmentMetas(body, files) {
  const metas = new Map();
  if (body.attachments == null) return metas;
  if (!Array.isArray(body.attachments)) throw invalid('attachments', 'BASE_TYPE_ARRAY', 'Must be an array.');
  for (const a of body.attachments) {
    if (a?.description != null) str(a, 'description', 0, 1024);
    metas.set(Number(a?.id), a);
  }
  return metas;
}

function voiceMeta(meta) {
  const d = meta?.duration_secs, w = meta?.waveform;
  const wave = typeof w === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(w) ? Buffer.from(w, 'base64') : null;
  if (typeof d !== 'number' || !(d > 0) || !wave?.length) throw new HttpError(400, 50161, 'Voice messages must have supporting metadata.');
  if (d > 1200 || wave.length > 256) throw invalid('attachments', 'BASE_TYPE_BAD_LENGTH', 'At most 20 minutes and 256 waveform samples.');
  return { duration_secs: d, waveform: w };
}

// validated message fields from a create body. who: { ch, perms, userId, webhook? }
export async function prepare(who, body, files) {
  const { ch, perms, userId, webhook, bot } = who;
  if (body.content != null && typeof body.content !== 'string') throw invalid('content', 'BASE_TYPE_REQUIRED', 'Must be a string.');
  let content = str({ content: body.content ?? '' }, 'content', 0, 2000, false);
  const nonce = body.nonce === undefined || webhook ? undefined : str(body, 'nonce', 1, 25, false);
  let flags = body.flags == null ? 0 : int(body, 'flags', 0, 2 ** 31);
  if (flags & ~(webhook ? WEBHOOK_FLAGS : USER_FLAGS)) throw invalid('flags', 'MESSAGE_FLAGS_INVALID', 'Unsupported message flags.');
  if (content.startsWith('@silent ')) {
    flags |= F.SUPPRESS_NOTIFICATIONS;
  }
  if (files.length > 10) throw invalid('files', 'BASE_TYPE_MAX_LENGTH', 'At most 10 files.');
  if (files.some(f => f.file.size > maxUpload())) throw new HttpError(413, 40005, 'Request entity too large');
  if (files.length && !webhook) need(perms, P.ATTACH_FILES);
  const metas = attachmentMetas(body, files);
  const d = { ch, content, nonce, flags, files: files.map(f => ({ ...f, meta: metas.get(f.n) })), embeds: [], stickerItems: [] };

  if (flags & F.IS_VOICE_MESSAGE) {
    if (!has(perms, P.SEND_VOICE_MESSAGES)) throw new HttpError(403, 50173, 'You cannot send voice messages in this channel.');
    if (files.length !== 1 || content || body.sticker_ids?.length || body.poll) throw invalid('flags', 'VOICE_MESSAGE_INVALID', 'A voice message is exactly one audio file.');
    d.voice = voiceMeta(d.files[0].meta);
  }
  if (body.sticker_ids != null) {
    d.stickerItems = snowflakes(body, 'sticker_ids', 3).map(id => {
      const s = usableSticker(id, ch, userId, perms, !!webhook);
      if (!s) throw invalid('sticker_ids', 'UNKNOWN_STICKER', 'Unknown or unusable sticker.');
      return { id: s.id, name: s.name, format_type: s.format_type };
    });
  }
  if (body.poll != null) {
    if (!webhook) need(perms, P.SEND_POLLS);
    d.poll = pollField(body.poll);
  }
  if (body.e2ee_envelope != null) {
    if (typeof body.e2ee_envelope !== 'object') throw invalid('e2ee_envelope', 'MODEL_TYPE_CONVERT', 'Must be an object.');
    d.e2eeEnvelope = body.e2ee_envelope;
    d.type = 100;
  }
  if (webhook || bot) {
    // validated now so nothing is stored for a bad body; attachment:// names resolve for real in send()
    richEmbeds(body.embeds, name => (files.some(f => f.file.name === name) ? '/' : null));
    d.embeds = body.embeds;
    d.rich = true;
  }
  if (bot) d.components = messageComponents(body.components);
  const ref = body.message_reference;
  if (ref != null && !webhook) {
    if (ref.type === 1) {
      if (content || files.length || d.poll || d.stickerItems.length) throw invalid('message_reference', 'FORWARD_INVALID', 'A forward carries nothing else.');
      d.forward = await forwardOf(ref, userId);
    } else {
      if (!has(perms, P.READ_MESSAGE_HISTORY)) throw new HttpError(403, 160002, 'Cannot reply without permission to read message history');
      d.referenceId = snowflakeField(ref, 'message_id');
      if (!get('SELECT 1 FROM messages WHERE id = ? AND channel_id = ?', d.referenceId, ch.id)) {
        throw invalid('message_reference', 'MESSAGE_REFERENCE_UNKNOWN_MESSAGE', 'Unknown message in this channel.');
      }
    }
  }
  if (!content.trim() && !files.length && !d.stickerItems.length && !d.poll && !d.forward && !(d.rich && body.embeds?.length) && !d.components?.length && !d.e2eeEnvelope) {
    throw new HttpError(400, 50006, 'Cannot send an empty message');
  }
  if (!webhook) d.content = content = filterEmoji(content, ch, userId, perms);
  const allowed = allowedMentions(body.allowed_mentions);
  d.counted = countedMentions(content, ch, webhook ? P.MENTION_EVERYONE : perms, allowed);
  d.allowedUsers = allowed && (id => allowed.parse.includes('users') || allowed.users.includes(id));
  d.embedLinks = webhook || has(perms, P.EMBED_LINKS);
  return d;
}

// stores the files of a prepared message; a voice message must really be Ogg or WebM audio
async function saveFiles(ch, d) {
  const saved = [];
  try {
    for (const { file, meta } of d.files) {
      const id = snowflake();
      const a = { id, ...await saveAttachment(ch.id, id, file) };
      saved.push(a);
      if (typeof meta?.filename === 'string' && meta.filename) a.filename = safeFilename(meta.filename);
      if (meta?.description) a.description = meta.description;
      if (meta?.is_spoiler || a.filename.startsWith('SPOILER_')) a.flags = (a.flags || 0) | IS_SPOILER;
      if (meta?.is_view_once || meta?.view_once) a.flags = (a.flags || 0) | 16;
      if (d.voice) {
        if (a.content_type !== 'audio/ogg' && a.content_type !== 'video/webm') throw invalid('files', 'VOICE_MESSAGE_INVALID', 'Voice messages are audio/ogg or audio/webm.');
        Object.assign(a, d.voice, { content_type: a.content_type === 'video/webm' ? 'audio/webm' : a.content_type });
      }
    }
  } catch (e) {
    saved.forEach(a => removeAttachment(ch.id, a.id));
    throw e;
  }
  return saved;
}

// stores and announces a prepared message. author: { id } of the user (or the webhook's creator) and optional webhook
// inTx: more writes that commit or fail together with the message row
export async function send(d, authorId, { webhook, id, type = 0, inTx } = {}) {
  const ch = d.ch;
  const attachments = await saveFiles(ch, d);
  let m;
  try { // files already on disk go again if the message cannot be stored (channel gone, database error)
    let snapshot = null;
    if (d.forward) {
      const copies = await copyAttachments(d.forward.src.id, ch.id, true);
      const s = messageObj(d.forward.src, d.forward.srcCh, null, true);
      const copyObj = a => ({
        id: a.id, filename: a.filename, size: a.size, content_type: a.content_type, url: attachmentUrl(a), proxy_url: attachmentUrl(a),
        ...(a.width != null && { width: a.width, height: a.height }), ...(a.description != null && { description: a.description }), flags: a.flags,
      });
      snapshot = { message: {
        type: s.type, content: s.content, embeds: s.embeds, attachments: copies.map(copyObj),
        timestamp: s.timestamp, edited_timestamp: s.edited_timestamp, flags: s.flags, mentions: s.mentions, mention_roles: s.mention_roles,
        ...(s.sticker_items && { sticker_items: s.sticker_items }),
      } };
      attachments.push(...copies);
    }
    // webhook embeds may point at their own uploads with attachment://name
    const embeds = d.rich ? richEmbeds(d.embeds, name => {
      const a = attachments.find(x => x.filename === name);
      return a && attachmentUrl({ ...a, channel_id: ch.id });
    }) : [];
    m = insertMessage({
      id, ch, authorId, content: d.content, type: d.forward ? 0 : d.referenceId ? 19 : (d.type ?? type), flags: d.flags | (d.forward ? F.HAS_SNAPSHOT : 0),
      referenceId: d.referenceId, mentionEveryone: d.counted.all || d.counted.here, mentionRoles: d.counted.roleIds, embeds,
      stickerItems: d.stickerItems, poll: d.poll, attachments, webhook, components: d.components,
      snapshot, reference: d.forward && { type: 1, message_id: d.forward.src.id, channel_id: d.forward.srcCh.id, guild_id: d.forward.srcCh.guild_id ?? undefined },
      e2eeEnvelope: d.e2eeEnvelope, inTx,
    });
  } catch (e) {
    attachments.forEach(a => removeAttachment(ch.id, a.id));
    throw e;
  }
  bumpMentions(ch, m, d.counted, d.allowedUsers);
  broadcastMessage(ch, 'MESSAGE_CREATE', m, d.nonce === undefined ? undefined : { nonce: d.nonce });
  if (d.embedLinks && !(m.flags & F.SUPPRESS_EMBEDS)) unfurlLater(m);
  return m;
}

