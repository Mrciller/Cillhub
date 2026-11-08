import { snowflake } from '../snowflake.js';
import { get, run, json, threadObj } from '../db.js';
import { HttpError, str, int, invalid, snowflakeField } from '../errors.js';
import { P } from '../permissions.js';
import { readPayload, prepare, send } from '../compose.js';
import { messageObj } from '../message.js';
import { moderateMessage } from '../automod.js';
import { insertThread, checkStart, announceNew, durationField, tagsField } from './threads.js';

const REQUIRE_TAG = 16;

function tagsOf(value, current) {
  if (!Array.isArray(value) || value.length > 20) throw invalid('available_tags', 'BASE_TYPE_MAX_LENGTH', 'At most 20 tags.');
  const known = new Set(json(current, []).map(t => t.id));
  return value.map(t => {
    if (t?.emoji_id != null && t?.emoji_name != null) throw invalid('available_tags', 'TAG_EMOJI_INVALID', 'At most one of emoji_id and emoji_name.');
    return {
      id: t?.id != null && known.has(String(t.id)) ? String(t.id) : snowflake(),
      name: str(t, 'name', 1, 20), moderated: !!t.moderated,
      emoji_id: t.emoji_id == null ? null : snowflakeField(t, 'emoji_id'), emoji_name: t.emoji_name == null ? null : str(t, 'emoji_name', 1, 32),
    };
  });
}

function reactionOf(v) {
  if (v == null || (v.emoji_id == null && v.emoji_name == null)) return null; // an empty reaction (as template links send it) means none
  if (v.emoji_id != null && v.emoji_name != null) throw invalid('default_reaction_emoji', 'BASE_TYPE_INVALID', 'Exactly one of emoji_id and emoji_name.');
  return { emoji_id: v.emoji_id == null ? null : snowflakeField(v, 'emoji_id'), emoji_name: v.emoji_name == null ? null : str(v, 'emoji_name', 1, 32) };
}

// columns for the forum-only settings in a create or PATCH body
export function forumFields(body, current = {}) {
  const out = {};
  if (body.available_tags !== undefined) out.available_tags = JSON.stringify(tagsOf(body.available_tags, current.available_tags));
  if (body.default_reaction_emoji !== undefined) out.default_reaction_emoji = JSON.stringify(reactionOf(body.default_reaction_emoji));
  if (body.default_sort_order !== undefined) {
    if (![null, 0, 1].includes(body.default_sort_order)) throw invalid('default_sort_order', 'BASE_TYPE_CHOICES', 'Must be null, 0 or 1.');
    out.default_sort_order = body.default_sort_order;
  }
  if (body.default_forum_layout !== undefined) out.default_forum_layout = int(body, 'default_forum_layout', 0, 2);
  if (body.default_thread_rate_limit_per_user !== undefined) out.default_thread_rate_limit_per_user = int(body, 'default_thread_rate_limit_per_user', 0, 21600);
  if (body.flags !== undefined) {
    const flags = int(body, 'flags', 0, 2 ** 31);
    if (flags & ~REQUIRE_TAG) throw invalid('flags', 'CHANNEL_FLAGS_INVALID', 'Only REQUIRE_TAG on forum channels.');
    out.flags = flags;
  }
  return out;
}

// POST /channels/:forum_id/threads: a post is a public thread whose first message shares its id
export async function createPost(ctx, parent) {
  checkStart(ctx, parent, P.SEND_MESSAGES);
  const { body, files } = await readPayload(ctx);
  const name = str(body, 'name', 1, 100);
  const tags = body.applied_tags == null ? [] : tagsField(body, parent, null, parent.perms);
  if (parent.flags & REQUIRE_TAG && !tags.length) throw new HttpError(400, 40067, 'A tag is required to create a forum post in this channel');
  if (typeof body.message !== 'object' || body.message === null) throw invalid('message', 'BASE_TYPE_REQUIRED', 'A post needs its first message.');
  const { message_reference: _, ...msg } = body.message;
  const d = await prepare({ ch: parent, perms: parent.perms, userId: ctx.user.id }, msg, files);
  const mod = moderateMessage(parent, ctx.user.id, `${name}\n${d.content}`);
  if (mod?.blocked) throw mod.reject();
  const id = snowflake();
  const t = insertThread(parent, {
    name, type: 11, applied_tags: tags,
    rate_limit_per_user: body.rate_limit_per_user == null ? parent.default_thread_rate_limit_per_user : int(body, 'rate_limit_per_user', 0, 21600),
    auto_archive_duration: body.auto_archive_duration == null ? undefined : durationField(body),
  }, ctx.user.id, id);
  d.ch = t;
  const m = await send(d, ctx.user.id, { id });
  run('UPDATE channels SET last_message_id = ? WHERE id = ?', t.id, parent.id);
  announceNew(ctx, parent, t);
  mod?.execute(m.id);
  ctx.status = 201;
  return { ...threadObj(get('SELECT * FROM channels WHERE id = ?', t.id), ctx.user.id), message: messageObj(m, t, ctx.user.id) };
}
