import { snowflake } from './snowflake.js';
import { run } from './db.js';
import { addJob } from './timers.js';

export const A = {
  GUILD_UPDATE: 1, CHANNEL_CREATE: 10, CHANNEL_UPDATE: 11, CHANNEL_DELETE: 12, CHANNEL_OVERWRITE_CREATE: 13,
  CHANNEL_OVERWRITE_UPDATE: 14, CHANNEL_OVERWRITE_DELETE: 15, MEMBER_KICK: 20, MEMBER_BAN_ADD: 22, BOT_ADD: 28, MEMBER_BAN_REMOVE: 23,
  MEMBER_UPDATE: 24, MEMBER_ROLE_UPDATE: 25, MEMBER_MOVE: 26, MEMBER_DISCONNECT: 27, ROLE_CREATE: 30, ROLE_UPDATE: 31,
  ROLE_DELETE: 32, INVITE_CREATE: 40, INVITE_DELETE: 42, WEBHOOK_CREATE: 50, WEBHOOK_UPDATE: 51, WEBHOOK_DELETE: 52,
  EMOJI_CREATE: 60, EMOJI_UPDATE: 61, EMOJI_DELETE: 62, MESSAGE_DELETE: 72, MESSAGE_BULK_DELETE: 73, MESSAGE_PIN: 74,
  MESSAGE_UNPIN: 75, STAGE_INSTANCE_CREATE: 83, STAGE_INSTANCE_UPDATE: 84, STAGE_INSTANCE_DELETE: 85, STICKER_CREATE: 90,
  STICKER_UPDATE: 91, STICKER_DELETE: 92, GUILD_SCHEDULED_EVENT_CREATE: 100, GUILD_SCHEDULED_EVENT_UPDATE: 101,
  GUILD_SCHEDULED_EVENT_DELETE: 102, THREAD_CREATE: 110, THREAD_UPDATE: 111, THREAD_DELETE: 112, SOUNDBOARD_SOUND_CREATE: 130,
  SOUNDBOARD_SOUND_UPDATE: 131, SOUNDBOARD_SOUND_DELETE: 132, AUTO_MODERATION_RULE_CREATE: 140, AUTO_MODERATION_RULE_UPDATE: 141,
  AUTO_MODERATION_RULE_DELETE: 142, AUTO_MODERATION_BLOCK_MESSAGE: 143, AUTO_MODERATION_FLAG_TO_CHANNEL: 144,
  AUTO_MODERATION_USER_COMMUNICATION_DISABLED: 145,
};

// the X-Audit-Log-Reason header, URL-encoded as clients send it (docs)
export function reasonOf(req) {
  const raw = req?.headers['x-audit-log-reason'];
  if (typeof raw !== 'string' || !raw) return null;
  let r;
  try { r = decodeURIComponent(raw); } catch { r = raw; }
  return r.slice(0, 512) || null;
}

// audit log change list: one entry per key whose value differs; new objects (before = {}) list every set key
export function diff(before, after, keys = Object.keys(after)) {
  const out = [];
  for (const key of keys) {
    const o = before?.[key], n = after?.[key];
    if (JSON.stringify(o) === JSON.stringify(n)) continue;
    out.push({ key, ...(o !== undefined && o !== null && { old_value: o }), ...(n !== undefined && n !== null && { new_value: n }) });
  }
  return out;
}

// actor: { user, req } of a request, or { user: { id } } for actions the server takes for someone
export function audit(actor, guildId, action, targetId, { changes, options } = {}) {
  run('INSERT INTO audit_log (id, guild_id, user_id, target_id, action_type, changes, options, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    snowflake(), guildId, actor?.user?.id ?? null, targetId ?? null, action,
    changes?.length ? JSON.stringify(changes) : null, options ? JSON.stringify(options) : null, reasonOf(actor?.req));
}

// entries are kept 90 days; the id is a snowflake, so its age needs no extra column
const KEEP = 90 * 24 * 3600 * 1000;
addJob({
  name: 'audit log retention',
  next: () => null,
  run: now => run('DELETE FROM audit_log WHERE CAST(id AS INTEGER) < ?', (BigInt(now - KEEP) - 1420070400000n) << 22n),
});
