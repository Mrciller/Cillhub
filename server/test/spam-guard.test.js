import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith, bits, until } from './helpers.js';

// short automatic periods; the 5 s counting window and the 10 s slow modes are the real ones
const env = { NODE_ENV: 'test', CILLCORD_TEST_SPAM_MS: '1500' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
let srv, api, g, alex, sam, robin, kim, jordan, taylor;
before(async () => {
  srv = await startServer({ env });
  api = srv.api;
  g = await guildWith(srv, ['alex', 'sam', 'robin', 'kim', 'jordan', 'taylor']);
  ({ alex, sam, robin, kim, jordan, taylor } = g.users);
  const mod = (await api('POST', `/guilds/${g.guild.id}/roles`, alex.token, { name: 'Mod', permissions: bits(13) })).body;
  assert.equal((await api('PUT', `/guilds/${g.guild.id}/members/${jordan.id}/roles/${mod.id}`, alex.token)).status, 204);
});
after(() => srv?.stop());

const channel = async (rate = 0) => (await api('POST', `/guilds/${g.guild.id}/channels`, alex.token, { name: 'spam', rate_limit_per_user: rate })).body;
const say = (ch, who, content = 'hi') => api('POST', `/channels/${ch.id}/messages`, who.token, { content });
const rate = async ch => (await api('GET', `/channels/${ch.id}`, alex.token)).body.rate_limit_per_user;
// 16 messages from 4 members in 4 rounds (each member 4, nobody 5) with this pause between rounds;
// the 15th switches the slow mode on, so the last one may already be refused
async function crowd(ch, pause = 0) {
  let sent = 0;
  for (let i = 0; i < 4; i++) {
    if (i && pause) await sleep(pause);
    const r = await Promise.all([sam, robin, kim, taylor].map(u => say(ch, u, `${u.name} ${i}`)));
    sent += r.filter(x => x.status === 201).length;
  }
  assert.ok(sent >= 15, `${sent} sent`);
}

test('switch is on by default and shows on the guild', async () => {
  assert.equal((await api('GET', `/guilds/${g.guild.id}`, sam.token)).body.auto_spam_slowmode_enabled, true);
});

test('one member: 5 messages in 5 s -> personal slow mode, refused like channel slow mode, ends after the period', async () => {
  const ch = await channel();
  for (let i = 0; i < 5; i++) assert.equal((await say(ch, sam)).status, 201);
  const refused = await say(ch, sam);
  assert.equal(refused.status, 429);
  assert.equal(refused.body.code, 20016);
  assert.equal(refused.body.global, false);
  assert.ok(refused.body.retry_after > 8 && refused.body.retry_after <= 10, String(refused.body.retry_after));
  assert.equal((await say(ch, robin)).status, 201, 'others still talk');
  assert.equal(await rate(ch), 0, 'the channel itself is not slowed');
  await sleep(1600);
  assert.equal((await say(ch, sam)).status, 201, 'personal slow mode is over');
});

test('many members: channel gets 10 s slow mode with CHANNEL_UPDATE, the old value comes back', async () => {
  const ch = await channel(1);
  const gw = await srv.gateway(sam.token);
  await crowd(ch, 1050); // the channel's own 1 s slow mode between rounds
  assert.equal((await gw.event('CHANNEL_UPDATE', d => d.id === ch.id)).rate_limit_per_user, 10);
  assert.equal(await rate(ch), 10);
  const r = await say(ch, sam);
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 20016);
  assert.equal((await gw.event('CHANNEL_UPDATE', d => d.id === ch.id && d.rate_limit_per_user === 1)).rate_limit_per_user, 1);
  assert.equal(await rate(ch), 1);
});

test('moderators are exempt', async () => {
  const ch = await channel();
  for (let i = 0; i < 8; i++) assert.equal((await say(ch, jordan)).status, 201);
  for (let i = 0; i < 8; i++) assert.equal((await say(ch, alex)).status, 201);
});

test('a slow mode set by hand during the automatic period wins', async () => {
  const ch = await channel();
  await crowd(ch);
  await until(async () => (await rate(ch)) === 10);
  assert.equal((await api('PATCH', `/channels/${ch.id}`, alex.token, { rate_limit_per_user: 30 })).status, 200);
  await sleep(1800);
  assert.equal(await rate(ch), 30);
});

test('switch off: nothing happens', async () => {
  const off = await api('PATCH', `/guilds/${g.guild.id}`, alex.token, { auto_spam_slowmode_enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.auto_spam_slowmode_enabled, false);
  const ch = await channel();
  for (let i = 0; i < 7; i++) assert.equal((await say(ch, sam)).status, 201);
  await crowd(ch);
  assert.equal(await rate(ch), 0);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}`, alex.token, { auto_spam_slowmode_enabled: true })).body.auto_spam_slowmode_enabled, true);
});

test('the restore survives a restart', async () => {
  const ch = await channel(1);
  await crowd(ch, 1050);
  await until(async () => (await rate(ch)) === 10);
  await srv.stop(true);
  srv = await startServer({ env, dataDir: srv.dataDir });
  api = srv.api;
  await until(async () => (await rate(ch)) === 1, 5000);
});
