import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, guildWith, bits } from './helpers.js';

const calls = [];
let livekit, srv, api, g, alice, bob, carol, stage;

before(async () => {
  livekit = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      calls.push({ path: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
    });
  });
  await new Promise(r => livekit.listen(0, '127.0.0.1', r));
  srv = await startServer({ env: {
    LIVEKIT_URL: `http://127.0.0.1:${livekit.address().port}`, LIVEKIT_PUBLIC_URL: 'wss://lk.example/livekit', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's',
  } });
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']);
  ({ alice, bob, carol } = g.users);
  for (const u of [alice, bob, carol]) u.gw = await srv.gateway(u.token);
  stage = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, { name: 'Town Hall', type: 13 })).body;
});
after(async () => {
  await srv.stop();
  livekit.close();
});

const join = (u, channelId, flags = {}) => u.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: channelId, self_mute: false, self_deaf: false, ...flags } });
const grants = token => JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).video.canPublishSources;
async function livekitCall(method, identity) {
  for (let i = 0; i < 100; i++) {
    const at = calls.findIndex(c => c.path.endsWith(method) && c.body.identity === identity);
    if (at >= 0) return calls.splice(at, 1)[0];
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`no ${method} for ${identity}`);
}
const state = (u, pred) => u.gw.event('VOICE_STATE_UPDATE', pred);

test('stage: audience joins suppressed with no publish grant; speaking follows suppress via UpdateParticipant', async () => {
  assert.equal(stage.type, 13);
  join(bob, stage.id);
  const s0 = await state(alice, d => d.user_id === bob.id && d.channel_id === stage.id);
  assert.deepEqual([s0.suppress, s0.request_to_speak_timestamp], [true, null]);
  assert.deepEqual(grants((await bob.gw.event('VOICE_SERVER_UPDATE')).token), []);

  const me = `/guilds/${g.guild.id}/voice-states/@me`;
  const raise = await api('PATCH', me, bob.token, { channel_id: stage.id, request_to_speak_timestamp: new Date().toISOString() });
  assert.equal(raise.status, 204);
  assert.ok((await state(alice, d => d.user_id === bob.id && d.request_to_speak_timestamp)).suppress);
  assert.equal((await api('PATCH', me, bob.token, { suppress: false })).status, 403, 'unsuppressing yourself takes MUTE_MEMBERS');
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/voice-states/${bob.id}`, carol.token, { channel_id: stage.id, suppress: false })).status, 403);

  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/voice-states/${bob.id}`, alice.token, { channel_id: stage.id, suppress: false })).status, 204);
  assert.equal((await state(carol, d => d.user_id === bob.id && !d.suppress)).channel_id, stage.id);
  assert.deepEqual((await livekitCall('UpdateParticipant', bob.id)).body.permission.can_publish_sources, ['MICROPHONE', 'CAMERA', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO']);
  assert.equal((await api('GET', `/guilds/${g.guild.id}/voice-states/${bob.id}`, carol.token)).body.suppress, false);

  // back to the audience by their own choice
  assert.equal((await api('PATCH', me, bob.token, { suppress: true })).status, 204);
  const audience = (await livekitCall('UpdateParticipant', bob.id)).body.permission;
  assert.deepEqual([audience.can_publish, audience.can_publish_sources], [false, []]);

  // REQUEST_TO_SPEAK is needed to raise a hand
  await api('PUT', `/channels/${stage.id}/permissions/${g.guild.id}`, alice.token, { type: 0, allow: '0', deny: bits(32) });
  assert.equal((await api('PATCH', me, bob.token, { request_to_speak_timestamp: new Date().toISOString() })).status, 403);
  await api('DELETE', `/channels/${stage.id}/permissions/${g.guild.id}`, alice.token);
  assert.equal((await api('PATCH', me, carol.token, { suppress: true })).body.code, 10065, 'not in voice');
});

test('stage instances: moderators open, edit and close; the stage closes when its last listener leaves', async () => {
  assert.equal((await api('POST', '/stage-instances', carol.token, { channel_id: stage.id, topic: 'AMA' })).status, 403);
  const r = await api('POST', '/stage-instances', alice.token, { channel_id: stage.id, topic: 'AMA' });
  assert.deepEqual([r.body.channel_id, r.body.topic, r.body.privacy_level], [stage.id, 'AMA', 2]);
  assert.equal((await carol.gw.event('STAGE_INSTANCE_CREATE')).id, r.body.id);
  assert.equal((await api('POST', '/stage-instances', alice.token, { channel_id: stage.id, topic: 'again' })).body.code, 150006);
  assert.equal((await api('PATCH', `/stage-instances/${stage.id}`, alice.token, { topic: 'Q&A' })).body.topic, 'Q&A');
  assert.equal((await carol.gw.event('STAGE_INSTANCE_UPDATE')).topic, 'Q&A');
  const ready = await srv.gateway(carol.token);
  assert.deepEqual(ready.ready.guilds[0].stage_instances.map(i => i.topic), ['Q&A']);
  ready.ws.close();
  // members who cannot view the stage do not learn its topic (review L-11)
  await api('PUT', `/channels/${stage.id}/permissions/${carol.id}`, alice.token, { type: 1, allow: '0', deny: '1024' });
  await api('PATCH', `/stage-instances/${stage.id}`, alice.token, { topic: 'secret' });
  assert.ok(await carol.gw.none(f => f.t === 'STAGE_INSTANCE_UPDATE'));
  const hidden = await srv.gateway(carol.token);
  assert.deepEqual(hidden.ready.guilds[0].stage_instances, []);
  hidden.ws.close();
  await api('DELETE', `/channels/${stage.id}/permissions/${carol.id}`, alice.token);
  join(bob, null);
  assert.equal((await carol.gw.event('STAGE_INSTANCE_DELETE')).channel_id, stage.id);
  assert.equal((await api('GET', `/stage-instances/${stage.id}`, carol.token)).body.code, 10067);
});

// a minimal Ogg Opus file: OpusHead (pre-skip 312) and a last page whose granule position sets the length
function ogg(seconds) {
  const head = Buffer.concat([Buffer.from('OggS'), Buffer.alloc(24), Buffer.from('OpusHead'), Buffer.from([1, 2, 0x38, 0x01]), Buffer.alloc(8)]);
  const last = Buffer.concat([Buffer.from('OggS'), Buffer.from([0, 4]), Buffer.alloc(8), Buffer.alloc(16)]);
  last.writeBigUInt64LE(BigInt(Math.round(seconds * 48000) + 312), 6);
  return Buffer.concat([head, last]);
}
// MPEG-1 Layer III, 128 kbps, 44.1 kHz frames of 417 bytes (1152 samples each)
const mp3 = frames => Buffer.concat(Array.from({ length: frames }, () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)])));
const uri = (type, b) => `data:${type};base64,${b.toString('base64')}`;

test('soundboard: upload rules, VOICE_CHANNEL_EFFECT_SEND to the voice channel, mute and permission checks', async () => {
  const add = (who, body) => api('POST', `/guilds/${g.guild.id}/soundboard-sounds`, who.token, body);
  assert.equal((await add(bob, { name: 'boom', sound: uri('audio/ogg', ogg(1)) })).status, 403, 'CREATE_GUILD_EXPRESSIONS');
  assert.equal((await add(alice, { name: 'long', sound: uri('audio/ogg', ogg(6)) })).status, 400, 'over 5.2 s');
  assert.equal((await add(alice, { name: 'fake', sound: uri('audio/ogg', Buffer.from('not audio')) })).status, 400);
  const mp = await add(alice, { name: 'blip', sound: uri('audio/mpeg', mp3(40)), volume: 0.5, emoji_name: '🔔' });
  assert.equal(mp.status, 201);
  const r = await add(alice, { name: 'boom', sound: uri('audio/ogg', ogg(2)) });
  const sound = r.body;
  assert.deepEqual([sound.name, sound.volume, sound.guild_id, sound.user.id], ['boom', 1, g.guild.id, alice.id]);
  assert.equal((await carol.gw.event('GUILD_SOUNDBOARD_SOUND_CREATE', d => d.sound_id === sound.sound_id)).name, 'boom');
  const cdn = await fetch(`${srv.origin}/soundboard-sounds/${sound.sound_id}`);
  assert.deepEqual([cdn.status, cdn.headers.get('content-type')], [200, 'audio/ogg']);
  assert.deepEqual((await api('GET', `/guilds/${g.guild.id}/soundboard-sounds`, bob.token)).body.items.map(s => s.name), ['blip', 'boom']);

  const play = (who, body = { sound_id: sound.sound_id }) => api('POST', `/channels/${g.voice.id}/send-soundboard-sound`, who.token, body);
  assert.equal((await play(bob)).status, 400, 'not in that channel');
  join(bob, g.voice.id);
  join(carol, g.voice.id);
  await state(alice, d => d.user_id === carol.id && d.channel_id === g.voice.id);
  assert.equal((await play(bob)).status, 204);
  const fx = await carol.gw.event('VOICE_CHANNEL_EFFECT_SEND');
  assert.deepEqual([fx.channel_id, fx.user_id, fx.sound_id, fx.sound_volume], [g.voice.id, bob.id, sound.sound_id, 1]);
  assert.ok(await alice.gw.none(f => f.t === 'VOICE_CHANNEL_EFFECT_SEND'), 'only people in the channel');
  join(bob, g.voice.id, { self_mute: true });
  await state(alice, d => d.user_id === bob.id && d.self_mute);
  assert.equal((await play(bob)).status, 403, 'not while muted');
  await api('PUT', `/channels/${g.voice.id}/permissions/${g.guild.id}`, alice.token, { type: 0, allow: '0', deny: bits(42) });
  assert.equal((await play(carol)).status, 403, 'USE_SOUNDBOARD');
  await api('DELETE', `/channels/${g.voice.id}/permissions/${g.guild.id}`, alice.token);
});

test('a timeout disconnects from voice and removes the LiveKit participant', async () => {
  calls.length = 0;
  await api('PATCH', `/guilds/${g.guild.id}/members/${carol.id}`, alice.token, { communication_disabled_until: new Date(Date.now() + 60_000).toISOString() });
  await state(alice, d => d.user_id === carol.id && d.channel_id === null);
  assert.equal((await livekitCall('RemoveParticipant', carol.id)).body.room, g.voice.id);
});

test('voice moderation honours channel overwrites and stage suppression enforces role hierarchy', async () => {
  // give bob a higher role than carol, and grant bob MUTE_MEMBERS only on g.voice via a channel overwrite
  const role = (await api('POST', `/guilds/${g.guild.id}/roles`, alice.token, { name: 'VoiceHelper', permissions: '0' })).body;
  await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, alice.token, { roles: [role.id] });
  await api('PATCH', `/guilds/${g.guild.id}/members/${carol.id}`, alice.token, { communication_disabled_until: null });
  await api('PUT', `/channels/${g.voice.id}/permissions/${bob.id}`, alice.token, { type: 1, allow: bits(22, 23, 24), deny: '0' });
  join(carol, g.voice.id);
  await state(alice, d => d.user_id === carol.id && d.channel_id === g.voice.id);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/members/${carol.id}`, bob.token, { mute: true })).status, 200);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/members/${carol.id}`, bob.token, { mute: false })).status, 200);
  join(carol, null);

  // stage channel: bob has MUTE_MEMBERS + MOVE_MEMBERS on stage, but cannot force-suppress alice (the guild owner)
  await api('PUT', `/channels/${stage.id}/permissions/${bob.id}`, alice.token, { type: 1, allow: bits(22, 24), deny: '0' });
  join(alice, stage.id);
  await state(alice, d => d.user_id === alice.id && d.channel_id === stage.id);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/voice-states/@me`, alice.token, { channel_id: stage.id, suppress: false })).status, 204);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/voice-states/${alice.id}`, bob.token, { channel_id: stage.id, suppress: true })).status, 403);
  join(alice, null);
});
