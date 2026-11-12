// 7.12.1 review fixes: recurring message caps and pacing, disabled authors, 2FA on server delete, hidden channels in
// backup export and reorder, friend request and passkey login limits, the terms gate on IDENTIFY.
// Runs with the real rate limits (scale 1).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, guildWith, bits, until } from './helpers.js';
import { totp } from './module-helpers.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const VIEW = 10, MANAGE_CHANNELS = 4, MANAGE_GUILD = 5;
let srv, api, g, alex, sam, robin;
const db = (fn, readOnly = false) => { const d = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite'), { readOnly }); try { return fn(d); } finally { d.close(); } };
const dbRun = (sql, ...a) => db(d => d.prepare(sql).run(...a));
const dbGet = (sql, ...a) => db(d => d.prepare(sql).get(...a), true);
const soon = () => new Date(Date.now() + 3_600_000).toISOString();
// any scheduled message re-arms the timer, so rows moved into the past run now
const rearm = async () => assert.equal((await api('POST', `/channels/${g.general.id}/scheduled-messages`, alex.token, { content: 'wake', send_at: soon() })).status, 201);

before(async () => {
  srv = await startServer({ env: { CILLCORD_RATE_LIMIT_SCALE: '1' } });
  api = srv.api;
  g = await guildWith(srv, ['alex', 'sam', 'robin']);
  ({ alex, sam, robin } = g.users);
});
after(() => srv.stop());

test('recurring messages: at most 25 per author and per channel; a run sends 5 per channel, the rest a minute later', async () => {
  for (let i = 0; i < 25; i++) {
    assert.equal((await api('POST', `/channels/${g.general.id}/recurring-messages`, alex.token, { content: `tick ${i}` })).status, 201);
  }
  assert.equal((await api('POST', `/channels/${g.general.id}/recurring-messages`, alex.token, { content: 'one more' })).status, 400);
  // per channel: a DM already full of another author's rows
  const dm = (await api('POST', '/users/@me/channels', sam.token, { recipient_id: robin.id })).body;
  for (let i = 0; i < 25; i++) {
    dbRun('INSERT INTO recurring_messages (id, channel_id, author_id, content, interval_type, time_of_day, next_run, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      `9${i}`, dm.id, robin.id, 'x', 'daily', '12:00', Date.now() + 86_400_000, Date.now());
  }
  assert.equal((await api('POST', `/channels/${dm.id}/recurring-messages`, sam.token, { content: 'hi' })).status, 400);
  dbRun('DELETE FROM recurring_messages WHERE channel_id = ?', dm.id);

  dbRun('UPDATE recurring_messages SET next_run = 1 WHERE channel_id = ?', g.general.id);
  await rearm();
  await until(() => dbGet('SELECT COUNT(*) AS n FROM recurring_messages WHERE channel_id = ? AND next_run = 1', g.general.id).n === 0);
  const sent = (await api('GET', `/channels/${g.general.id}/messages?limit=100`, alex.token)).body.filter(m => m.content.startsWith('tick '));
  assert.equal(sent.length, 5);
  const waiting = dbGet('SELECT COUNT(*) AS n, MIN(next_run) AS t FROM recurring_messages WHERE channel_id = ? AND next_run < ?', g.general.id, Date.now() + 120_000);
  assert.equal(waiting.n, 20);
  assert.ok(waiting.t > Date.now() + 30_000, 'the rest waits about a minute');
  dbRun('DELETE FROM recurring_messages');
});

test('a disabled account posts no scheduled message', async () => {
  const r = await api('POST', `/channels/${g.general.id}/scheduled-messages`, robin.token, { content: 'from a disabled account', send_at: soon() });
  assert.equal(r.status, 201);
  dbRun('UPDATE users SET disabled = 1 WHERE id = ?', robin.id);
  dbRun('UPDATE scheduled_messages SET send_at = 1 WHERE id = ?', r.body.id);
  await rearm();
  await until(() => !dbGet('SELECT 1 FROM scheduled_messages WHERE id = ?', r.body.id));
  dbRun('UPDATE users SET disabled = 0 WHERE id = ?', robin.id);
  const msgs = (await api('GET', `/channels/${g.general.id}/messages?limit=100`, alex.token)).body;
  assert.equal(msgs.filter(m => m.content === 'from a disabled account').length, 0);
});

test('deleting a server needs the owner\'s 2FA code, as a transfer does', async () => {
  const on = await api('POST', '/users/@me/mfa/totp/enable', sam.token, { password: 'hunter2hunter2', secret: SECRET, code: totp() });
  assert.equal(on.status, 200);
  const guild = (await api('POST', '/guilds', sam.token, { name: 'Sam Server' })).body;
  const no = await api('DELETE', `/guilds/${guild.id}`, sam.token);
  assert.equal(no.status, 401);
  assert.equal(no.body.code, 60003);
  assert.equal((await api('DELETE', `/guilds/${guild.id}`, sam.token, { code: '000000' })).status, 400);
  assert.equal((await api('DELETE', `/guilds/${guild.id}`, sam.token, { code: on.body.backup_codes[0].code })).status, 204);
  // without 2FA nothing changes
  const plain = (await api('POST', '/guilds', robin.token, { name: 'Robin Server' })).body;
  assert.equal((await api('DELETE', `/guilds/${plain.id}`, robin.token)).status, 204);
});

test('backup export and channel reorder leave out channels the caller cannot view', async () => {
  const staff = (await api('POST', `/guilds/${g.guild.id}/channels`, alex.token, { name: 'staff', topic: 'the secret plan' })).body;
  const role = (await api('POST', `/guilds/${g.guild.id}/roles`, alex.token, { name: 'mgr', permissions: bits(MANAGE_GUILD, MANAGE_CHANNELS) })).body;
  await api('PUT', `/guilds/${g.guild.id}/members/${robin.id}/roles/${role.id}`, alex.token);
  await api('PUT', `/channels/${staff.id}/permissions/${robin.id}`, alex.token, { type: 1, allow: '0', deny: bits(VIEW) });
  const out = (await api('GET', `/guilds/${g.guild.id}/backup-export`, robin.token)).body;
  assert.ok(out.guild.channels.some(c => c.id === g.general.id));
  assert.ok(!out.guild.channels.some(c => c.id === staff.id || c.topic === 'the secret plan'));
  assert.ok((await api('GET', `/guilds/${g.guild.id}/backup-export`, alex.token)).body.guild.channels.some(c => c.id === staff.id), 'the owner sees all');
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/channels`, robin.token, [{ id: staff.id, position: 7 }])).status, 400);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/channels`, robin.token, [{ id: g.general.id, position: 7 }])).status, 204);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/channels`, alex.token, [{ id: staff.id, position: 8 }])).status, 204);
});

test('friend requests: 20 per 10 minutes, by name too, accepting is free', async () => {
  const kim = await srv.register('kim');
  for (let i = 0; i < 19; i++) assert.equal((await api('POST', '/users/@me/relationships', kim.token, { username: `nobody${i}` })).status, 400);
  assert.equal((await api('PUT', `/users/@me/relationships/${alex.id}`, kim.token, {})).status, 204); // the 20th
  const r = await api('POST', '/users/@me/relationships', kim.token, { username: 'nobody' });
  assert.equal(r.status, 429, 'an unknown name answers like a known one once the limit is hit');
  assert.equal((await api('PUT', `/users/@me/relationships/${sam.id}`, kim.token, {})).status, 429);
  // accepting an incoming request still works
  assert.equal((await api('PUT', `/users/@me/relationships/${kim.id}`, robin.token, {})).status, 204);
  assert.equal((await api('PUT', `/users/@me/relationships/${robin.id}`, kim.token, {})).status, 204);
  assert.equal((await api('GET', '/users/@me/relationships', kim.token)).body.find(x => x.id === robin.id).type, 1);
});

test('passkey login challenges: 10 per minute per address', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await api('POST', '/auth/webauthn/authenticate/options', null, {})).status, 200);
  assert.equal((await api('POST', '/auth/webauthn/authenticate/options', null, {})).status, 429);
});

test('IDENTIFY waits for the terms like REST does, without a 4004 logout', async () => {
  const taylor = await srv.register('taylor');
  dbRun('UPDATE users SET legal_pending = 1 WHERE id = ?', taylor.id);
  assert.equal((await api('GET', '/users/@me/guilds', taylor.token)).status, 403);
  const gw = srv.socket();
  await gw.wait(f => f.op === 10);
  gw.send({ op: 2, d: { token: taylor.token, properties: {} } });
  assert.equal(await gw.closed, 4003);
  dbRun('UPDATE users SET legal_pending = 0 WHERE id = ?', taylor.id);
  assert.ok((await srv.gateway(taylor.token)).ready.user);
});
