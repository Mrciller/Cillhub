// Limits and leaks from the 2026-11-10 risk check: anonymous limits per IPv6 /64, the calendar feed only shows visible
// events, generated invite codes never collide with custom invite names, /download relaying is limited, email checks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, guildWith } from './helpers.js';

let srv, api;
const from = ip => ({ 'X-Forwarded-For': ip }); // the test client is a trusted proxy (loopback), so this is the client address
const reg = (name, ip, email = `${name}@example.com`) =>
  api('POST', '/auth/register', null, { email, username: name, password: 'hunter2hunter2' }, from(ip));
const dbRun = (sql, ...args) => { const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite')); try { return db.prepare(sql).run(...args); } finally { db.close(); } };

before(async () => {
  // nothing listens on 3399, so relayed downloads answer 404 at once
  srv = await startServer({ env: { CILLCORD_RATE_LIMIT_SCALE: '1', CILLCORD_DOWNLOAD_UPSTREAM: 'http://127.0.0.1:3399' } });
  api = srv.api;
});
after(() => srv.stop());

test('netOf: IPv6 by expanded /64, IPv4 and IPv4-mapped as one address', async () => {
  const { netOf } = await import('../src/ratelimit.js');
  assert.equal(netOf('a:b::5'), netOf('a:b::6'));
  assert.equal(netOf('a:b::5'), netOf('a:b:0:0::7'));
  assert.equal(netOf('2001:DB8:1:2::9'), netOf('2001:db8:1:2:ffff::1'));
  assert.notEqual(netOf('2001:db8:1:2::9'), netOf('2001:db8:1:3::9'));
  assert.notEqual(netOf('a:b::5'), netOf('a:b:0:1::5'));
  assert.equal(netOf('::ffff:1.2.3.4'), '1.2.3.4');
  assert.equal(netOf('1.2.3.4'), '1.2.3.4');
  assert.notEqual(netOf('1.2.3.4'), netOf('1.2.3.5'));
});

test('sign-up limit counts one IPv6 /64 as one client', async () => {
  const codes = [];
  for (let i = 0; i < 13; i++) codes.push((await reg(`kim${i}`, `2001:db8:1:2::${(0x10 + i).toString(16)}`)).status);
  assert.deepEqual([codes.filter(c => c === 201).length, codes.filter(c => c === 429).length], [10, 3], codes.join());
  assert.equal((await reg('kim-other', '2001:db8:1:3::10')).status, 201, 'another /64 has its own budget');
});

test('email addresses: one plain address only, at sign-up and on change', async () => {
  for (const bad of ['robin@x.test,postmaster', 'robin@x.test;b', '<robin@x.test>', '"robin"@x.test', 'robin(x)@x.test', 'ro bin@x.test', 'robin@x.test\u0007']) {
    const r = await reg('robin', '192.0.2.50', bad);
    assert.deepEqual([r.status, Object.keys(r.body.errors ?? {})], [400, ['email']], JSON.stringify(bad));
  }
  assert.equal((await reg('robin', '192.0.2.51', 'robin+chat@x.test')).status, 201);
  const robin = (await api('POST', '/auth/login', null, { login: 'robin', password: 'hunter2hunter2' })).body.token;
  assert.equal((await api('PATCH', '/users/@me', robin, { email: 'robin@x.test, kim@x.test', password: 'hunter2hunter2' })).status, 400);
  assert.equal((await api('PATCH', '/users/@me', robin, { email: 'robin@y.test', password: 'hunter2hunter2' })).body.email, 'robin@y.test');
});

test('calendar feed: no events of channels the member cannot see', async () => {
  const g = await guildWith(srv, ['alex', 'sam']);
  const { alex, sam } = g.users;
  const staff = (await api('POST', `/guilds/${g.guild.id}/channels`, alex.token, {
    name: 'staff', type: 2, permission_overwrites: [{ id: g.guild.id, type: 0, allow: '0', deny: String(1 << 10) }],
  })).body;
  const start = new Date(Date.now() + 3600e3).toISOString();
  const event = (name, channel) => api('POST', `/guilds/${g.guild.id}/scheduled-events`, alex.token, { name, entity_type: 2, channel_id: channel.id, privacy_level: 2, scheduled_start_time: start });
  assert.equal((await event('Staff meeting', staff)).status, 200);
  assert.equal((await event('Game night', g.voice)).status, 200);
  const feed = async user => (await fetch((await api('GET', '/users/@me/calendar-feed', user.token)).body.url)).text();
  const samFeed = await feed(sam);
  assert.ok(samFeed.includes('SUMMARY:Game night'));
  assert.ok(!samFeed.includes('Staff meeting'), 'hidden channel event left out');
  assert.ok((await feed(alex)).includes('SUMMARY:Staff meeting'), 'shown to who can see the channel');
  const samUrl = (await api('GET', '/users/@me/calendar-feed', sam.token)).body.url;
  dbRun('UPDATE users SET disabled = 1 WHERE id = ?', sam.id);
  assert.equal((await fetch(samUrl)).status, 404, 'a disabled account has no feed');
});

test('invite codes: generated ones always carry a capital, custom names cannot take an old invite link', async () => {
  const g = await guildWith(srv, ['taylor', 'jordan']);
  const { taylor, jordan } = g.users;
  for (let i = 0; i < 25; i++) {
    const inv = (await api('POST', `/channels/${g.general.id}/invites`, taylor.token, {})).body;
    assert.match(inv.code, /[A-Z]/, inv.code);
  }
  // codes made before this change could be all lower case: one expired, one live
  const row = 'INSERT INTO invites (code, guild_id, channel_id, inviter_id, expires_at, max_age, max_uses, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, ?)';
  dbRun(row, 'oldlink', g.guild.id, g.general.id, taylor.id, 1, new Date().toISOString());
  dbRun(row, 'livelink', g.guild.id, g.general.id, taylor.id, null, new Date().toISOString());
  const own = (await api('POST', '/guilds', jordan.token, { name: 'Jordan Guild' })).body;
  for (const code of ['oldlink', 'livelink']) {
    assert.equal((await api('PATCH', `/guilds/${own.id}/vanity-url`, jordan.token, { code })).body.code, 50020, code);
  }
  assert.equal((await api('GET', '/invites/oldlink')).status, 404, 'expired stays unknown');
  assert.equal((await api('GET', '/invites/livelink')).body.guild.id, g.guild.id, 'live old invite keeps working');
  assert.equal((await api('PATCH', `/guilds/${own.id}/vanity-url`, jordan.token, { code: 'jordan-guild' })).body.code, 'jordan-guild');
});

test('download relay to the hub: limited per client', async () => {
  const get = ip => fetch(`${srv.origin}/download/desktop/Cillhub-Setup-9.9.9.exe`, { headers: from(ip) });
  for (let i = 0; i < 60; i++) assert.equal((await get(`2001:db8:5:6::${i + 1}`)).status, 404);
  const limited = await get('2001:db8:5:6::99');
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await get('2001:db8:5:7::1')).status, 404, 'another client is not affected');
});
