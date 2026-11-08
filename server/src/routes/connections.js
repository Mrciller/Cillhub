import { randomUUID } from 'node:crypto';
import { get, all, run, json } from '../db.js';
import { HttpError, notFound } from '../errors.js';

function connectionObj(r) {
  return {
    id: r.id,
    user_id: r.user_id,
    type: r.type,
    name: r.name,
    verified: Boolean(r.verified),
    show_on_profile: Boolean(r.show_on_profile),
    metadata: json(r.metadata, null),
    created_at: r.created_at,
  };
}

function listConnections(ctx) {
  return all('SELECT * FROM user_connections WHERE user_id = ? ORDER BY created_at ASC', ctx.user.id).map(connectionObj);
}

function createConnection(ctx) {
  const type = String(ctx.body?.type || '').trim().toLowerCase();
  const name = String(ctx.body?.name || '').trim();
  if (!type) throw new HttpError(400, 50035, 'Connection type is required');
  if (!name) throw new HttpError(400, 50035, 'Account name is required');

  const existing = get('SELECT id FROM user_connections WHERE user_id = ? AND type = ? AND name = ?', ctx.user.id, type, name);
  if (existing) {
    throw new HttpError(400, 50035, 'Connection already exists');
  }

  const id = randomUUID();
  const showOnProfile = ctx.body?.show_on_profile !== undefined ? (ctx.body.show_on_profile ? 1 : 0) : 1;
  const metadata = ctx.body?.metadata ? JSON.stringify(ctx.body.metadata) : null;
  const createdAt = new Date().toISOString();

  run(`
    INSERT INTO user_connections (id, user_id, type, name, verified, show_on_profile, metadata, created_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
  `, id, ctx.user.id, type, name, showOnProfile, metadata, createdAt);

  const row = get('SELECT * FROM user_connections WHERE id = ?', id);
  ctx.status = 201;
  return connectionObj(row);
}

function updateConnection(ctx) {
  const conn = get('SELECT * FROM user_connections WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
  if (!conn) throw notFound(10013, 'Connection');

  let showOnProfile = conn.show_on_profile;
  if (ctx.body?.show_on_profile !== undefined) {
    showOnProfile = ctx.body.show_on_profile ? 1 : 0;
  }
  let metadata = conn.metadata;
  if (ctx.body?.metadata !== undefined) {
    metadata = ctx.body.metadata ? JSON.stringify(ctx.body.metadata) : null;
  }

  run('UPDATE user_connections SET show_on_profile = ?, metadata = ? WHERE id = ? AND user_id = ?',
    showOnProfile, metadata, conn.id, ctx.user.id);

  const updated = get('SELECT * FROM user_connections WHERE id = ?', conn.id);
  return connectionObj(updated);
}

function deleteConnection(ctx) {
  const conn = get('SELECT * FROM user_connections WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
  if (!conn) throw notFound(10013, 'Connection');

  run('DELETE FROM user_connections WHERE id = ? AND user_id = ?', conn.id, ctx.user.id);
  ctx.status = 204;
}

const user = { userOnly: true };
export default [
  ['GET', '/users/@me/connections', listConnections, user],
  ['POST', '/users/@me/connections', createConnection, user],
  ['PATCH', '/users/@me/connections/:id', updateConnection, user],
  ['DELETE', '/users/@me/connections/:id', deleteConnection, user],
];
