// Release fixes: bulk delete validation and file removal after commit, ack bounds, failed-token flood limit, static caching.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { startServer, guildWith, tempDir } from './helpers.js';

let srv, api, g, alex, sam;
const db = fn => { const d = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite')); try { return fn(d); } finally { d.close(); } };
const file = (m, i = 0) => join(srv.dataDir, 'attachments', m.channel_id, m.attachments[i].id);

before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alex', 'sam']);
  ({ alex, sam } = g.users);
});
after(() => srv.stop());

test('bulk delete: a non-numeric id is a 400, a failed delete keeps the files, a good one removes them', async () => {
  const send = async c => (await srv.upload(g.general.id, alex.token, { content: c }, [['a.txt', Buffer.from(c), 'text/plain']])).body;
  const [a, b] = [await send('one'), await send('keep')];
  const bad = await api('POST', `/channels/${g.general.id}/messages/bulk-delete`, alex.token, { messages: [a.id, 'x1'] });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.code, 50035);
  db(d => d.exec("CREATE TRIGGER no_del BEFORE DELETE ON messages WHEN OLD.content = 'keep' BEGIN SELECT RAISE(ABORT, 'refused'); END"));
  try {
    assert.equal((await api('POST', `/channels/${g.general.id}/messages/bulk-delete`, alex.token, { messages: [a.id, b.id] })).status, 500);
  } finally { db(d => d.exec('DROP TRIGGER no_del')); }
  assert.ok(existsSync(file(a)) && existsSync(file(b)), 'rolled back: both files still there');
  assert.equal((await api('POST', `/channels/${g.general.id}/messages/bulk-delete`, alex.token, { messages: [a.id, b.id] })).status, 204);
  assert.ok(!existsSync(file(a)) && !existsSync(file(b)));
});

test('ack: ids past the newest message are cut back, older acks do not move the read state back', async () => {
  const m1 = (await api('POST', `/channels/${g.general.id}/messages`, alex.token, { content: 'first' })).body;
  const m2 = (await api('POST', `/channels/${g.general.id}/messages`, alex.token, { content: 'second' })).body;
  const ack = id => api('POST', `/channels/${g.general.id}/messages/${id}/ack`, sam.token, { token: null });
  const read = () => db(d => d.prepare('SELECT last_message_id FROM read_states WHERE user_id = ? AND channel_id = ?').get(sam.id, g.general.id).last_message_id);
  assert.equal((await ack('9000000000000000000')).status, 200);
  assert.equal(read(), m2.id);
  assert.equal((await ack(m1.id)).status, 200);
  assert.equal(read(), m2.id);
  await api('DELETE', `/channels/${g.general.id}/messages/${m2.id}`, alex.token);
  assert.equal((await ack(m2.id)).status, 200, 'a deleted message id is still accepted');
  assert.equal(read(), m2.id);
});

test('failed authentications are limited per network, valid tokens keep working; static files carry cache headers', async () => {
  const dir = await tempDir();
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  writeFileSync(join(dir, 'assets', 'app-abc123.js'), 'x');
  const s = await startServer({ env: { CILLCORD_RATE_LIMIT_SCALE: '1', STATIC_DIR: dir } });
  try {
    const robin = await s.register('robin');
    let last;
    for (let i = 0; i < 31; i++) last = await s.api('GET', '/users/@me', 'not-a-token');
    assert.equal(last.status, 429);
    assert.equal((await s.api('GET', '/users/@me', robin.token)).status, 200);

    const asset = await fetch(`${s.origin}/assets/app-abc123.js`);
    assert.equal(asset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const missing = await fetch(`${s.origin}/assets/gone.js`); // SPA fallback is the app shell, never cached for a year
    assert.equal(missing.headers.get('cache-control'), 'no-cache');
    const page = await fetch(`${s.origin}/`);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    const etag = page.headers.get('etag');
    assert.ok(etag);
    assert.equal((await fetch(`${s.origin}/`, { headers: { 'If-None-Match': etag } })).status, 304);
  } finally { await s.stop(); }
});
