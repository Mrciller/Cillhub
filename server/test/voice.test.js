import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { startServer, guildWith, bits } from './helpers.js';

const SECRET = 'test-secret';
const calls = []; // requests the fake LiveKit received
let livekit, srv, api, g, alice, bob, carol;

function verify(jwt) {
  const [header, payload, sig] = jwt.split('.');
  assert.equal(createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url'), sig, 'signed with LIVEKIT_API_SECRET');
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { alg: 'HS256', typ: 'JWT' });
  return JSON.parse(Buffer.from(payload, 'base64url'));
}

async function livekitCall(method, identity) {
  for (let i = 0; i < 100; i++) {
    const i2 = calls.findIndex(c => c.path === `/twirp/livekit.RoomService/${method}` && c.body.identity === identity);
    if (i2 >= 0) return calls.splice(i2, 1)[0];
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`no ${method} for ${identity}`);
}

before(async () => {
  livekit = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise(r => livekit.listen(0, '127.0.0.1', r));
  srv = await startServer({ env: {
    LIVEKIT_URL: `http://127.0.0.1:${livekit.address().port}`, LIVEKIT_PUBLIC_URL: 'wss://lk.example/livekit',
    LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: SECRET,
  } });
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']);
  ({ alice, bob, carol } = g.users);
  for (const u of [alice, bob, carol]) u.gw = await srv.gateway(u.token);
  bob.gw2 = await srv.gateway(bob.token);
});
after(async () => {
  await srv.stop();
  livekit.close();
});

const join = (gw, channelId, flags = {}) => gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: channelId, self_mute: false, self_deaf: false, ...flags } });
const stateOf = (gw, userId, channelId) => gw.event('VOICE_STATE_UPDATE', d => d.user_id === userId && d.channel_id === channelId);
const s = {};

test('join: VOICE_STATE_UPDATE to the guild, VOICE_SERVER_UPDATE only to the joining session, token grants', async () => {
  join(bob.gw, g.voice.id);
  const state = await stateOf(alice.gw, bob.id, g.voice.id);
  assert.equal(state.session_id, bob.gw.ready.session_id);
  assert.deepEqual([state.guild_id, state.mute, state.deaf, state.self_mute, state.self_video, state.member.user.id], [g.guild.id, false, false, false, false, bob.id]);
  await stateOf(carol.gw, bob.id, g.voice.id);
  const server = await bob.gw.event('VOICE_SERVER_UPDATE');
  assert.deepEqual([server.guild_id, server.channel_id, server.endpoint], [g.guild.id, g.voice.id, 'wss://lk.example/livekit']);
  assert.ok(await bob.gw2.none(f => f.t === 'VOICE_SERVER_UPDATE'));
  assert.ok(await alice.gw.none(f => f.t === 'VOICE_SERVER_UPDATE', 50));

  const claims = verify(server.token);
  assert.equal(claims.iss, 'devkey');
  assert.equal(claims.sub, bob.id);
  assert.equal(claims.name, 'bob');
  assert.equal(claims.exp - claims.nbf, 6 * 3600);
  assert.deepEqual(JSON.parse(claims.metadata), { user_id: bob.id });
  assert.deepEqual(claims.video, {
    room: g.voice.id, roomJoin: true, canSubscribe: true, canPublish: true, canPublishData: false, canUpdateOwnMetadata: true,
    canPublishSources: ['microphone', 'camera', 'screen_share', 'screen_share_audio'],
  });
  const ready = await srv.gateway(carol.token);
  assert.deepEqual(ready.ready.guilds[0].voice_states.map(v => [v.user_id, v.channel_id]), [[bob.id, g.voice.id]]);
  ready.ws.close();

  // same channel, same session: only the flags change
  join(bob.gw, g.voice.id, { self_mute: true, self_video: true });
  const flags = await alice.gw.event('VOICE_STATE_UPDATE', d => d.user_id === bob.id && d.self_mute);
  assert.equal(flags.self_video, true);
  assert.ok(await bob.gw.none(f => f.t === 'VOICE_SERVER_UPDATE'));
});

test('server mute updates the state and calls UpdateParticipant; a muted join gets no microphone', async () => {
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, carol.token, { mute: true })).status, 403);
  const r = await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, alice.token, { mute: true });
  assert.equal(r.body.mute, true);
  assert.equal((await alice.gw.event('VOICE_STATE_UPDATE', d => d.user_id === bob.id && d.mute)).channel_id, g.voice.id);
  assert.equal((await carol.gw.event('GUILD_MEMBER_UPDATE', d => d.user.id === bob.id)).mute, true);
  const call = await livekitCall('UpdateParticipant', bob.id);
  assert.deepEqual(call.body, {
    room: g.voice.id, identity: bob.id,
    permission: { can_subscribe: true, can_publish: true, can_publish_data: false, can_publish_sources: ['CAMERA', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO'] },
  });
  const admin = verify(call.auth.replace(/^Bearer /, ''));
  assert.deepEqual([admin.iss, admin.video], ['devkey', { roomAdmin: true, room: g.voice.id }]);

  // the same user joining from another session moves the state there
  join(bob.gw2, g.voice.id);
  const moved = await alice.gw.event('VOICE_STATE_UPDATE', d => d.user_id === bob.id && d.session_id === bob.gw2.ready.session_id);
  assert.equal(moved.channel_id, g.voice.id);
  const server = await bob.gw2.event('VOICE_SERVER_UPDATE');
  assert.deepEqual(verify(server.token).video.canPublishSources, ['camera', 'screen_share', 'screen_share_audio']);

  await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, alice.token, { mute: false });
  assert.ok((await livekitCall('UpdateParticipant', bob.id)).body.permission.can_publish_sources.includes('MICROPHONE'));
});

test('no microphone without SPEAK, no camera or screen without STREAM', async () => {
  const deny = String((1n << 21n) | (1n << 9n));
  s.listen = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, {
    name: 'Listen', type: 2, permission_overwrites: [{ id: g.guild.id, type: 0, allow: '0', deny }],
  })).body;
  join(carol.gw, s.listen.id);
  const muted = verify((await carol.gw.event('VOICE_SERVER_UPDATE')).token).video;
  assert.deepEqual([muted.canPublish, muted.canPublishSources], [false, []]); // empty sources alone would allow all (audit M8)
});

test('user_limit; moving between channels; MOVE_MEMBERS bypasses the limit', async () => {
  s.duo = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, { name: 'Duo', type: 2, user_limit: 1 })).body;
  join(carol.gw, s.duo.id);
  await stateOf(alice.gw, carol.id, s.duo.id);
  await carol.gw.event('VOICE_SERVER_UPDATE', d => d.channel_id === s.duo.id);
  join(bob.gw2, s.duo.id);
  assert.ok(await bob.gw2.none(f => f.t === 'VOICE_SERVER_UPDATE'));
  join(alice.gw, s.duo.id);
  assert.equal((await alice.gw.event('VOICE_SERVER_UPDATE')).channel_id, s.duo.id);
});

test('moderator move and disconnect call LiveKit; disconnect on gateway close; own leave does not', async () => {
  const member = (who, body) => api('PATCH', `/guilds/${g.guild.id}/members/${who.id}`, alice.token, body);
  assert.equal((await member(bob, { channel_id: s.listen.id })).status, 200);
  await stateOf(carol.gw, bob.id, s.listen.id);
  assert.equal((await bob.gw2.event('VOICE_SERVER_UPDATE')).channel_id, s.listen.id);
  assert.equal((await livekitCall('RemoveParticipant', bob.id)).body.room, g.voice.id);

  assert.equal((await member(carol, { channel_id: null })).status, 200);
  await stateOf(alice.gw, carol.id, null);
  assert.deepEqual((await livekitCall('RemoveParticipant', carol.id)).body, { room: s.duo.id, identity: carol.id });
  const notIn = await member(carol, { channel_id: null });
  assert.deepEqual([notIn.status, notIn.body.code], [400, 40032]);

  bob.gw2.ws.close();
  await stateOf(alice.gw, bob.id, null);
  assert.deepEqual((await livekitCall('RemoveParticipant', bob.id)).body, { room: s.listen.id, identity: bob.id });

  join(alice.gw, null);
  await stateOf(carol.gw, alice.id, null);
  await new Promise(r => setTimeout(r, 200));
  assert.ok(!calls.some(c => c.body.identity === alice.id));
});

test('voice disabled without LiveKit env: endpoint null, no state', async () => {
  const plain = await startServer();
  try {
    const pg = await guildWith(plain, ['dan']);
    const gw = await plain.gateway(pg.users.dan.token);
    gw.send({ op: 4, d: { guild_id: pg.guild.id, channel_id: pg.voice.id, self_mute: false, self_deaf: false } });
    assert.deepEqual(await gw.event('VOICE_SERVER_UPDATE'), { guild_id: pg.guild.id, channel_id: pg.voice.id, token: null, endpoint: null });
    assert.ok(await gw.none(f => f.t === 'VOICE_STATE_UPDATE'));
  } finally {
    await plain.stop();
  }
});

test('moving someone needs MOVE_MEMBERS and CONNECT in the destination for the mover too (docs)', async () => {
  const role = (await api('POST', `/guilds/${g.guild.id}/roles`, alice.token, { name: 'Mover', permissions: bits(10, 20, 24) })).body;
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, alice.token, { roles: [role.id] })).status, 200);
  const staff = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, {
    name: 'Staff only', type: 2, permission_overwrites: [{ id: bob.id, type: 1, allow: '0', deny: bits(20) }],
  })).body;
  join(carol.gw, g.voice.id);
  await stateOf(alice.gw, carol.id, g.voice.id);
  const move = (who, to) => api('PATCH', `/guilds/${g.guild.id}/members/${carol.id}`, who.token, { channel_id: to });
  assert.equal((await move(bob, staff.id)).status, 403, 'Bob cannot connect to Staff only');
  assert.equal((await move(alice, staff.id)).status, 200);
  await stateOf(bob.gw, carol.id, staff.id);
  assert.equal((await move(bob, g.voice.id)).status, 200, 'out of it into a channel Bob can join is fine');
  await stateOf(alice.gw, carol.id, g.voice.id);
  join(carol.gw, null);
  await stateOf(alice.gw, carol.id, null);
});

test('self_video and self_stream require STREAM permission and clear when STREAM is revoked', async () => {
  // s.listen denies SPEAK and STREAM: joining or updating with self_video/self_stream clamps them to false
  join(carol.gw, s.listen.id, { self_mute: true, self_video: true, self_stream: true });
  const st1 = await alice.gw.event('VOICE_STATE_UPDATE', d => d.user_id === carol.id && d.channel_id === s.listen.id && d.self_mute);
  assert.deepEqual([st1.self_video, st1.self_stream], [false, false]);
  await carol.gw.event('VOICE_SERVER_UPDATE', d => d.channel_id === s.listen.id);

  // in g.voice carol has STREAM, so self_video and self_stream are allowed until STREAM is denied on the channel
  join(carol.gw, g.voice.id, { self_mute: true, self_video: true, self_stream: true });
  const st2 = await alice.gw.event('VOICE_STATE_UPDATE', d => d.user_id === carol.id && d.channel_id === g.voice.id && d.self_mute);
  assert.deepEqual([st2.self_video, st2.self_stream], [true, true]);
  await carol.gw.event('VOICE_SERVER_UPDATE', d => d.channel_id === g.voice.id);

  await api('PUT', `/channels/${g.voice.id}/permissions/${g.guild.id}`, alice.token, { type: 0, allow: '0', deny: bits(9) });
  const st3 = await alice.gw.event('VOICE_STATE_UPDATE', d => d.user_id === carol.id && d.channel_id === g.voice.id && !d.self_video);
  assert.deepEqual([st3.self_video, st3.self_stream], [false, false]);
  await api('DELETE', `/channels/${g.voice.id}/permissions/${g.guild.id}`, alice.token);
  join(carol.gw, null);
  await stateOf(alice.gw, carol.id, null);
});
