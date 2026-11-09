import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createECDH, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { startServer, guildWith, until } from './helpers.js';

const ece = createRequire(import.meta.url)('http_ece'); // web-push's own RFC 8188 implementation, to decrypt like a browser
let srv, api, g, alice, bob, carol, livekit, push;
const pushed = []; // { path, headers, body }
let pushStatus = 201;

before(async () => {
  livekit = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }); });
  push = createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { pushed.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) }); res.writeHead(pushStatus); res.end(); });
  });
  await new Promise(r => livekit.listen(0, '127.0.0.1', r));
  await new Promise(r => push.listen(0, '127.0.0.1', r));
  srv = await startServer({ env: {
    LIVEKIT_URL: `http://127.0.0.1:${livekit.address().port}`, LIVEKIT_PUBLIC_URL: 'wss://lk.example/livekit', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's',
    CILLCORD_UNFURL_ALLOW: `127.0.0.1:${push.address().port}`,
  } });
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']);
  ({ alice, bob, carol } = g.users);
  for (const u of [alice, bob, carol]) u.gw = await srv.gateway(u.token);
});
after(async () => { await srv.stop(); livekit.close(); push.close(); });

test('DM calls: op 4 with guild_id null starts the call, ring and stop-ringing update it, the last leave ends it', async () => {
  const dm = (await api('POST', '/users/@me/channels', alice.token, { recipient_id: bob.id })).body;
  alice.gw.send({ op: 4, d: { guild_id: null, channel_id: dm.id, self_mute: false, self_deaf: false } });
  const server = await alice.gw.event('VOICE_SERVER_UPDATE');
  assert.deepEqual([server.guild_id, server.channel_id, server.endpoint], [null, dm.id, 'wss://lk.example/livekit']);
  const call = await bob.gw.event('CALL_CREATE');
  assert.deepEqual([call.channel_id, call.ringing, call.voice_states.map(v => v.user_id)], [dm.id, [], [alice.id]]);
  const msg = await bob.gw.event('MESSAGE_CREATE', m => m.type === 3);
  assert.deepEqual(msg.call, { participants: [alice.id], ended_timestamp: null });
  assert.equal((await api('POST', `/channels/${dm.id}/call/ring`, alice.token, {})).status, 204);
  assert.deepEqual((await bob.gw.event('CALL_UPDATE')).ringing, [bob.id]);
  assert.equal((await api('POST', `/channels/${dm.id}/call/stop-ringing`, bob.token, {})).status, 204);
  assert.deepEqual((await alice.gw.event('CALL_UPDATE', c => !c.ringing.length)).ringing, []);
  bob.gw.send({ op: 4, d: { guild_id: null, channel_id: dm.id, self_mute: true, self_deaf: false } });
  assert.deepEqual((await alice.gw.event('MESSAGE_UPDATE', m => m.id === msg.id)).call.participants, [alice.id, bob.id]);
  // a reconnecting client asks for the call (op 13)
  const late = await srv.gateway(carol.token);
  late.send({ op: 13, d: { channel_id: dm.id } });
  assert.ok(await late.none(f => f.t === 'CALL_CREATE', 200), 'not a recipient');
  alice.gw.send({ op: 4, d: { guild_id: null, channel_id: null } });
  bob.gw.send({ op: 4, d: { guild_id: null, channel_id: null } });
  assert.deepEqual(await alice.gw.event('CALL_DELETE'), { channel_id: dm.id });
  assert.ok((await alice.gw.event('MESSAGE_UPDATE', m => m.id === msg.id && m.call.ended_timestamp)).call.ended_timestamp);
});

test('a 1:1 call with a user who blocked the caller does not start: no ringing, no call message (audit M4)', async () => {
  const dm = (await api('POST', '/users/@me/channels', alice.token, { recipient_id: carol.id })).body;
  await api('PUT', `/users/@me/relationships/${alice.id}`, carol.token, { type: 2 });
  alice.gw.send({ op: 4, d: { guild_id: null, channel_id: dm.id, self_mute: false, self_deaf: false } });
  assert.ok(await carol.gw.none(f => f.t === 'CALL_CREATE' || (f.t === 'MESSAGE_CREATE' && f.d.channel_id === dm.id)));
  assert.ok(await alice.gw.none(f => f.t === 'CALL_CREATE' && f.d.channel_id === dm.id, 50));
  await api('DELETE', `/users/@me/relationships/${alice.id}`, carol.token);
});

test('group DM calls: removing a recipient disconnects them from the call and switching sessions keeps the call alive', async () => {
  await api('PUT', `/users/@me/relationships/${bob.id}`, alice.token, {});
  await api('PUT', `/users/@me/relationships/${alice.id}`, bob.token, {});
  await api('PUT', `/users/@me/relationships/${carol.id}`, alice.token, {});
  await api('PUT', `/users/@me/relationships/${alice.id}`, carol.token, {});
  const grp = (await api('POST', '/users/@me/channels', alice.token, { recipients: [bob.id, carol.id], name: 'Squad Call' })).body;
  alice.gw.send({ op: 4, d: { guild_id: null, channel_id: grp.id, self_mute: false, self_deaf: false } });
  await alice.gw.event('CALL_CREATE', c => c.channel_id === grp.id);
  bob.gw.send({ op: 4, d: { guild_id: null, channel_id: grp.id, self_mute: false, self_deaf: false } });
  await alice.gw.event('VOICE_STATE_UPDATE', d => d.user_id === bob.id && d.channel_id === grp.id);
  // kicking bob from the group DM also disconnects him from the active call
  assert.equal((await api('DELETE', `/channels/${grp.id}/recipients/${bob.id}`, alice.token)).status, 204);
  await alice.gw.event('VOICE_STATE_UPDATE', d => d.user_id === bob.id && d.channel_id === null);
  // alice (now the sole participant) switches to a second gateway session: the call stays alive (no CALL_DELETE)
  const alice2 = await srv.gateway(alice.token);
  alice2.send({ op: 4, d: { guild_id: null, channel_id: grp.id, self_mute: true, self_deaf: false } });
  await alice.gw.event('VOICE_STATE_UPDATE', d => d.user_id === alice.id && d.session_id === alice2.ready.session_id);
  assert.ok(await alice.gw.none(f => f.t === 'CALL_DELETE', 150), 'switching sessions does not end the call');
  alice2.send({ op: 4, d: { guild_id: null, channel_id: null } });
  await alice.gw.event('CALL_DELETE', c => c.channel_id === grp.id);
  alice2.ws.close();
});

// a browser-like subscription: P-256 key pair and auth secret
function subscription() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, body: { endpoint: `http://127.0.0.1:${push.address().port}/push/${randomBytes(4).toString('hex')}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
}
const decrypt = (sub, body) => JSON.parse(ece.decrypt(body, { version: 'aes128gcm', privateKey: sub.ecdh, authSecret: sub.auth }).toString());

test('web push: VAPID key, encrypted (aes128gcm) payload only while idle, mutes respected, gone subscriptions removed', async () => {
  const { public_key } = (await api('GET', '/push/vapid-public-key')).body;
  assert.equal(Buffer.from(public_key, 'base64url').length, 65);
  assert.equal((await api('POST', '/users/@me/push-subscriptions', bob.token, { endpoint: 'ftp://x', keys: {} })).status, 400);
  const sub = subscription();
  assert.equal((await api('POST', '/users/@me/push-subscriptions', bob.token, sub.body)).status, 204);
  const dm = (await api('POST', '/users/@me/channels', alice.token, { recipient_id: bob.id })).body;
  const mine = () => pushed.filter(p => p.path === new URL(sub.body.endpoint).pathname);
  // bob's session is active: nothing
  await api('POST', `/channels/${dm.id}/messages`, alice.token, { content: 'are you there?' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(mine().length, 0);
  // afk: pushed, encrypted, VAPID-signed, body cut to 100 characters
  bob.gw.send({ op: 3, d: { status: 'online', afk: true, since: Date.now(), activities: [] } });
  await new Promise(r => setTimeout(r, 100));
  await api('POST', `/channels/${dm.id}/messages`, alice.token, { content: 'x'.repeat(300) });
  const p = await until(() => mine()[0]);
  assert.equal(p.headers['content-encoding'], 'aes128gcm');
  assert.match(p.headers.authorization, /^vapid t=.+, k=/);
  assert.ok(!p.body.includes('xxxx'), 'payload is encrypted');
  const payload = decrypt(sub, p.body);
  assert.deepEqual([payload.title, payload.body.length, payload.tag], ['alice', 100, dm.id]);
  assert.match(payload.url, new RegExp(`^/channels/@me/${dm.id}/\\d+$`));
  // muted DMs: nothing
  await api('PATCH', '/users/@me/guilds/@me/settings', bob.token, { muted: true });
  await api('POST', `/channels/${dm.id}/messages`, alice.token, { content: 'muted?' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(mine().length, 1);
  await api('PATCH', '/users/@me/guilds/@me/settings', bob.token, { muted: false });
  // guild mentions push, plain guild messages do not, suppressed @everyone does not
  await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: 'no mention' });
  await api('PATCH', `/users/@me/guilds/${g.guild.id}/settings`, bob.token, { suppress_everyone: true });
  await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: '@everyone hi' });
  await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: `<@${bob.id}> look` });
  const mention = await until(() => mine()[1]);
  assert.equal(decrypt(sub, mention.body).body, `<@${bob.id}> look`);
  await new Promise(r => setTimeout(r, 200));
  assert.equal(mine().length, 2);
  // incoming friend request while idle, then 410: the subscription is deleted
  pushStatus = 410;
  const dave = await srv.register('dave');
  await api('POST', '/users/@me/relationships', dave.token, { username: 'bob' });
  assert.equal(decrypt(sub, (await until(() => mine()[2])).body).title, 'Friend request');
  pushStatus = 201;
  await api('POST', `/channels/${dm.id}/messages`, alice.token, { content: 'after 410' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(mine().length, 3);
  // active again: no push
  bob.gw.send({ op: 3, d: { status: 'online', afk: false, since: 0, activities: [] } });
});

test('rate limits: v9 rate limit headers on every response, 429 with retry_after per route bucket', async () => {
  await srv.stop(true);
  srv = await startServer({ dataDir: srv.dataDir, env: { CILLCORD_RATE_LIMIT_SCALE: '1' } });
  const send = () => fetch(`${srv.base}/channels/${g.general.id}/messages`, { method: 'POST', headers: { Authorization: alice.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'spam' }) });
  const first = await send();
  assert.equal(first.status, 201);
  assert.equal(first.headers.get('x-ratelimit-limit'), '10');
  assert.equal(first.headers.get('x-ratelimit-remaining'), '9');
  assert.match(first.headers.get('x-ratelimit-bucket'), /^[0-9a-f]{16}$/);
  assert.ok(Number(first.headers.get('x-ratelimit-reset-after')) <= 5);
  assert.ok(Number(first.headers.get('x-ratelimit-reset')) > Date.now() / 1000);
  let last;
  for (let i = 0; i < 10; i++) last = await send();
  assert.equal(last.status, 429);
  const body = await last.json();
  assert.equal(body.global, false);
  assert.ok(body.retry_after > 0 && body.retry_after <= 5);
  assert.equal(last.headers.get('x-ratelimit-remaining'), '0');
  assert.equal(last.headers.get('x-ratelimit-scope'), 'user');
  // other channels and other users have their own buckets
  const other = await fetch(`${srv.base}/channels/${g.general.id}/messages`, { method: 'POST', headers: { Authorization: bob.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: 'fine' }) });
  assert.equal(other.status, 201);
  // rings: 10 a minute per user, across channels
  const dm = (await srv.api('POST', '/users/@me/channels', bob.token, { recipient_id: carol.id })).body;
  for (let i = 0; i < 10; i++) assert.equal((await srv.api('POST', `/channels/${dm.id}/call/ring`, bob.token, {})).status, 204);
  assert.equal((await srv.api('POST', `/channels/${dm.id}/call/ring`, bob.token, {})).status, 429);
});
