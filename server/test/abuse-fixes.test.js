// Abuse and resource limits from the 2026-11-10 audits: whiteboard size, follower webhook count, webhooks in locked
// threads, e2ee key size, snippets without embed rights, rate-limit keys and map caps, the per-account login budget.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { startServer, guildWith, bits, tempDir } from './helpers.js';

process.env.DATA_DIR = await tempDir(); // the in-process limiter checks below open their own database
process.env.CILLCORD_RATE_LIMIT_SCALE = '1';
const { limit, loginFailed } = await import('../src/ratelimit.js');
const { hit } = await import('../src/modules/store.js');

const MANAGE_WEBHOOKS = 29, EMBED_LINKS = 14;
let srv, api, g, alex, sam;
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alex', 'sam']);
  ({ alex, sam } = g.users);
});
after(async () => {
  await srv.stop();
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});

test('whiteboard: a stroke is an object of at most 32 KiB, the board stays under 1 MiB', async () => {
  const post = stroke => api('POST', `/channels/${g.general.id}/whiteboard/stroke`, alex.token, { stroke });
  assert.equal((await post('x')).status, 400, 'not an object');
  assert.equal((await post({ points: 'p'.repeat(33 * 1024) })).status, 400, 'too big');
  for (let i = 0; i < 40; i++) assert.equal((await post({ i, points: 'p'.repeat(30 * 1024) })).status, 200);
  const board = (await api('GET', `/channels/${g.general.id}/whiteboard`, alex.token)).body;
  assert.ok(JSON.stringify(board.strokes).length <= 1024 * 1024, 'board capped');
  assert.equal(board.strokes.at(-1).i, 39, 'the newest strokes stay');
});

test('follower webhooks count toward the 15 per channel', async () => {
  const news = (await api('POST', `/guilds/${g.guild.id}/channels`, alex.token, { name: 'news', type: 5 })).body;
  const target = (await api('POST', `/guilds/${g.guild.id}/channels`, alex.token, { name: 'target' })).body;
  for (let i = 0; i < 15; i++) assert.equal((await api('POST', `/channels/${news.id}/followers`, alex.token, { webhook_channel_id: target.id })).status, 200);
  const r = await api('POST', `/channels/${news.id}/followers`, alex.token, { webhook_channel_id: target.id });
  assert.deepEqual([r.status, r.body.code], [400, 30007]);
});

test('webhooks cannot post into a locked thread or edit in an archived one', async () => {
  const hook = (await api('POST', `/channels/${g.general.id}/webhooks`, alex.token, { name: 'Deploys' })).body;
  const thread = (await api('POST', `/channels/${g.general.id}/threads`, alex.token, { name: 'ops', type: 11 })).body;
  const url = `/webhooks/${hook.id}/${hook.token}`;
  const m = (await api('POST', `${url}?wait=true&thread_id=${thread.id}`, null, { content: 'before' })).body;
  assert.equal((await api('PATCH', `/channels/${thread.id}`, alex.token, { archived: true })).status, 200);
  assert.equal((await api('PATCH', `${url}/messages/${m.id}?thread_id=${thread.id}`, null, { content: 'after' })).status, 400, 'archived: no edit');
  assert.equal((await api('PATCH', `/channels/${thread.id}`, alex.token, { archived: false, locked: true })).status, 200);
  assert.equal((await api('POST', `${url}?thread_id=${thread.id}`, null, { content: 'locked' })).status, 403);
});

test('e2ee keys are at most 8192 characters', async () => {
  assert.equal((await api('PUT', '/users/@me/e2ee/keys', sam.token, { public_key: 'k'.repeat(9000) })).status, 400);
  assert.equal((await api('PUT', '/users/@me/e2ee/keys', sam.token, { identity_key: 'k'.repeat(9000) })).status, 400);
  assert.equal((await api('PUT', '/users/@me/e2ee/keys', sam.token, { identity_key: 'k'.repeat(100) })).status, 200);
});

test('a snippet posts its embed only for members who may embed links', async () => {
  assert.equal((await api('POST', `/guilds/${g.guild.id}/snippets`, alex.token, { name: 'rules', content: 'be kind' })).status < 300, true);
  await api('PUT', `/channels/${g.general.id}/permissions/${sam.id}`, alex.token, { type: 1, allow: '0', deny: bits(EMBED_LINKS) });
  const m = (await api('POST', `/channels/${g.general.id}/messages`, sam.token, { content: '!rules' })).body;
  assert.deepEqual([m.content, m.embeds], ['!rules', []]);
  const own = (await api('POST', `/channels/${g.general.id}/messages`, alex.token, { content: '!rules' })).body;
  assert.equal(own.embeds[0].description, 'be kind');
});

test('rate limits: a guessed webhook token gets no fresh bucket', () => {
  const hit1 = i => limit('POST', '/webhooks/:webhook_id/:token', { webhook_id: '1', token: `guess${i}` }, '203.0.113.9', {});
  for (let i = 0; i < 50; i++) hit1(i);
  assert.throws(() => hit1(50), e => e.status === 429);
});

test('rate-limit, login and module maps stay bounded under a flood of new keys', { timeout: 20_000 }, async () => {
  // past 50,000 live keys the old sweep walked the whole map on every call; yields so the timeout can fire
  const flood = async fn => { for (let i = 0; i < 120_000; i++) { fn(i); if (i % 5000 === 0) await new Promise(setImmediate); } };
  await flood(i => limit('GET', '/channels/:id', { id: String(i) }, '203.0.113.10', {}));
  await flood(i => loginFailed([`ip:flood${i}`]));
  await flood(i => hit(`flood:${i}`, 5, 60_000));
});

test('the account login budget is shared by its name and its email', async () => {
  const kim = await srv.register('kim');
  const fail = (login, n) => api('POST', '/auth/login', null, { login, password: 'wrong password' }, { 'X-Forwarded-For': `198.51.100.${n}` });
  for (let n = 0; n < 10; n++) {
    const res = await Promise.all(Array.from({ length: 10 }, () => fail(n < 5 ? 'kim' : 'kim@example.com', n)));
    assert.ok(res.every(r => r.status === 401), JSON.stringify(res.map(r => r.status)));
  }
  const r = await api('POST', '/auth/login', null, { login: 'kim', password: 'hunter2hunter2' }, { 'X-Forwarded-For': '198.51.100.200' });
  assert.equal(r.status, 429, 'locked after 100 failures across name and email');
  assert.ok(kim.id);
});
