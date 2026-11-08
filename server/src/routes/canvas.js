import { get, run } from '../db.js';
import { str, invalid } from '../errors.js';
import { P, need, viewersOf, isThread } from '../permissions.js';
import { sendToUsers } from '../gateway.js';
import { loadChannel } from './channels.js';
import { requireUnarchived } from './messages.js';

function getCanvas(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  const row = get('SELECT * FROM channel_canvas WHERE channel_id = ?', ch.id);
  if (!row) {
    return {
      channel_id: ch.id,
      content: '',
      version: 0,
      updated_at: new Date(0).toISOString(),
      updated_by: null,
    };
  }
  return {
    channel_id: row.channel_id,
    content: row.content,
    version: row.version,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

function putCanvas(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  requireUnarchived(ch);
  if (ch.guild_id) {
    need(ch.perms, isThread(ch) ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES);
  }
  const body = ctx.body ?? {};
  const content = str(body, 'content', 0, 50000);
  const now = new Date().toISOString();

  run(`
    INSERT INTO channel_canvas (channel_id, content, version, updated_at, updated_by)
    VALUES (?, ?, 1, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      content = excluded.content,
      version = channel_canvas.version + 1,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `, ch.id, content, now, ctx.user.id);

  const out = getCanvas(ctx);
  sendToUsers(viewersOf(ch), 'CHANNEL_CANVAS_UPDATE', out);
  return out;
}

// v10: Interactive Collaborative Whiteboard in Voice Rooms (§10)
function getWhiteboard(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  const row = get('SELECT * FROM channel_whiteboard WHERE channel_id = ?', ch.id);
  if (!row) {
    return {
      channel_id: ch.id,
      strokes: [],
      updated_at: new Date(0).toISOString(),
      updated_by: null,
    };
  }
  let strokes = [];
  try { strokes = JSON.parse(row.strokes || '[]'); } catch {}
  return {
    channel_id: row.channel_id,
    strokes,
    updated_at: row.updated_at,
    updated_by: row.updated_by,
  };
}

function postWhiteboardStroke(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  requireUnarchived(ch);
  if (ch.guild_id) {
    need(ch.perms, isThread(ch) ? P.SEND_MESSAGES_IN_THREADS : P.SEND_MESSAGES);
  }
  const stroke = ctx.body?.stroke ?? ctx.body;
  if (!stroke) throw invalid('stroke', 'BASE_TYPE_REQUIRED', 'Stroke data required.');
  const now = new Date().toISOString();

  const cur = get('SELECT strokes FROM channel_whiteboard WHERE channel_id = ?', ch.id);
  let strokes = [];
  if (cur) {
    try { strokes = JSON.parse(cur.strokes || '[]'); } catch {}
  }
  strokes.push(stroke);
  if (strokes.length > 2000) strokes = strokes.slice(-1500);

  run(`
    INSERT INTO channel_whiteboard (channel_id, strokes, updated_at, updated_by)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      strokes = excluded.strokes,
      updated_at = excluded.updated_at,
      updated_by = excluded.updated_by
  `, ch.id, JSON.stringify(strokes), now, ctx.user.id);

  const payload = { channel_id: ch.id, stroke, user_id: ctx.user.id, updated_at: now };
  sendToUsers(viewersOf(ch), 'CHANNEL_WHITEBOARD_STROKE', payload);
  return payload;
}

function clearWhiteboard(ctx) {
  const ch = loadChannel(ctx.params.id, ctx.user);
  if (ch.guild_id) {
    need(ch.perms, P.MANAGE_CHANNELS);
  }
  run('DELETE FROM channel_whiteboard WHERE channel_id = ?', ch.id);
  const payload = { channel_id: ch.id, user_id: ctx.user.id, cleared: true };
  sendToUsers(viewersOf(ch), 'CHANNEL_WHITEBOARD_CLEAR', payload);
  return payload;
}

export default [
  ['GET', '/channels/:id/canvas', getCanvas],
  ['PUT', '/channels/:id/canvas', putCanvas],
  ['GET', '/channels/:id/whiteboard', getWhiteboard],
  ['POST', '/channels/:id/whiteboard/stroke', postWhiteboardStroke],
  ['DELETE', '/channels/:id/whiteboard', clearWhiteboard],
];
