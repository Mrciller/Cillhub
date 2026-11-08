// v5: Watch Together sessions and voice channel status (needs voice states, so a fake LiveKit answers the room calls)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, guildWith, bits } from './helpers.js';

let livekit, srv, api, g, alice, bob, carol;

before(async () => {
  livekit = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }); });
  await new Promise(r => livekit.listen(0, '127.0.0.1', r));
  srv = await startServer({ env: {
    LIVEKIT_URL: `http://127.0.0.1:${livekit.address().port}`, LIVEKIT_PUBLIC_URL: 'wss://lk.example/livekit', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'secret',
  } });
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']);
  ({ alice, bob, carol } = g.users);
  for (const u of [alice, bob, carol]) u.gw = await srv.gateway(u.token);
});
after(async () => {
  await srv.stop();
  livekit.close();
});

const join = (u, channelId = g.voice.id) => {
  u.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: channelId, self_mute: false, self_deaf: false } });
  return carol.gw.event('VOICE_STATE_UPDATE', d => d.user_id === u.id && d.channel_id === channelId);
};
const watch = (method, who, body) => api(method, `/channels/${g.voice.id}/watch`, who.token, body);
const update = (u, pred = () => true) => u.gw.event('WATCH_SESSION_UPDATE', pred);

test('Watch Together: start, enqueue, control rules, host hand-over and end when the channel empties', async () => {
  await join(alice);
  await join(bob);
  // only people in the channel start sessions, and only YouTube video links count
  assert.equal((await watch('POST', carol, { video_url: 'https://youtu.be/dQw4w9WgXcQ' })).status, 403);
  for (const bad of ['https://example.com/watch?v=dQw4w9WgXcQ', 'https://youtu.be/short', 'javascript:alert(1)', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ"><']) {
    assert.equal((await watch('POST', alice, { video_url: bad })).status, 400, bad);
  }
  const started = await watch('POST', alice, { video_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10' });
  assert.equal(started.status, 200);
  assert.deepEqual([started.body.host_id, started.body.control, started.body.current.video_id, started.body.current.playing, started.body.current.position, started.body.current.rate],
    [alice.id, 'host', 'dQw4w9WgXcQ', true, 0, 1]);
  assert.ok(Math.abs(started.body.current.started_at - Date.now()) < 5000);
  // guild members who can see the channel hear about it (the sidebar shows "Watching"), so does a late fetch
  assert.equal((await update(carol)).current.video_id, 'dQw4w9WgXcQ');
  assert.equal((await watch('GET', carol)).body.host_id, alice.id);
  const late = await srv.gateway(carol.token);
  assert.equal(late.ready.guilds[0].watch_sessions[0].channel_id, g.voice.id);
  late.ws.close();

  const queued = await watch('POST', bob, { video_url: 'https://youtube.com/shorts/abcdefghijk' });
  assert.deepEqual(queued.body.queue.map(q => [q.video_id, q.added_by, q.title]), [['abcdefghijk', bob.id, null]]);

  // control "host": only alice; she may hand control to everyone in the channel, carol (not connected, no MOVE_MEMBERS) may not
  assert.equal((await watch('PATCH', bob, { action: 'pause' })).status, 403);
  assert.equal((await watch('PATCH', carol, { control: 'everyone' })).status, 403);
  assert.equal((await watch('PATCH', alice, { control: 'everyone' })).body.control, 'everyone');
  assert.equal((await watch('PATCH', carol, { action: 'pause' })).status, 403);
  const seek = await watch('PATCH', bob, { action: 'seek', position: 42 });
  assert.deepEqual([seek.body.current.position, seek.body.current.playing], [42, true]);
  assert.equal((await watch('PATCH', bob, { action: 'seek' })).status, 400);
  const paused = await watch('PATCH', bob, { action: 'pause' });
  assert.equal(paused.body.current.playing, false);
  assert.ok(paused.body.current.position >= 42 && paused.body.current.position < 45);
  assert.equal((await watch('PATCH', bob, { action: 'remove', index: 3 })).status, 400);
  assert.equal((await watch('PATCH', bob, { action: 'rewind' })).status, 400);
  const next = await watch('PATCH', bob, { action: 'next' });
  assert.deepEqual([next.body.current.video_id, next.body.current.position, next.body.queue.length], ['abcdefghijk', 0, 0]);
  // only the host (or MOVE_MEMBERS) stops it
  assert.equal((await watch('DELETE', bob)).status, 403);

  // the host leaves: bob takes over; the last one out ends it
  alice.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: null } });
  assert.equal((await update(carol, d => d.host_id === bob.id)).host_id, bob.id);
  bob.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: null } });
  assert.deepEqual(await update(carol, d => d.ended), { channel_id: g.voice.id, guild_id: g.guild.id, ended: true });
  assert.equal((await watch('GET', carol)).status, 404);
});

test('Watch Together: MOVE_MEMBERS stops someone else\'s session', async () => {
  await join(bob);
  await watch('POST', bob, { video_url: 'https://youtu.be/dQw4w9WgXcQ' });
  assert.equal((await watch('DELETE', alice)).status, 204); // alice owns the guild
  await update(carol, d => d.ended);
  bob.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: null } });
  await carol.gw.event('VOICE_STATE_UPDATE', d => d.user_id === bob.id && d.channel_id === null);
});

test('voice channel status: connected with SEND_MESSAGES or MANAGE_CHANNELS, on the channel object, cleared when the channel empties', async () => {
  const put = (who, status) => api('PUT', `/channels/${g.voice.id}/voice-status`, who.token, { status });
  assert.equal((await put(carol, 'Scrim vs Team X')).status, 403); // not connected
  await join(bob);
  assert.equal((await put(bob, 'x'.repeat(501))).status, 400);
  assert.equal((await put(bob, 'Scrim vs Team X 🎮')).status, 204);
  assert.deepEqual(await carol.gw.event('VOICE_CHANNEL_STATUS_UPDATE'), { id: g.voice.id, guild_id: g.guild.id, status: 'Scrim vs Team X 🎮' });
  assert.equal((await api('GET', `/channels/${g.voice.id}`, carol.token)).body.status, 'Scrim vs Team X 🎮');
  // without SEND_MESSAGES in the channel a connected member cannot; MANAGE_CHANNELS can from anywhere
  await api('PUT', `/channels/${g.voice.id}/permissions/${bob.id}`, alice.token, { type: 1, allow: '0', deny: bits(11) });
  assert.equal((await put(bob, 'nope')).status, 403);
  await api('DELETE', `/channels/${g.voice.id}/permissions/${bob.id}`, alice.token);
  assert.equal((await put(alice, 'Practice')).status, 204);
  await carol.gw.event('VOICE_CHANNEL_STATUS_UPDATE', d => d.status === 'Practice');
  bob.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: null } });
  assert.equal((await carol.gw.event('VOICE_CHANNEL_STATUS_UPDATE', d => d.status === null)).id, g.voice.id);
  const late = await srv.gateway(carol.token);
  assert.equal(late.ready.guilds[0].channels.find(c => c.id === g.voice.id).status, null);
  late.ws.close();
});
