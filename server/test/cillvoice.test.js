// VOICE_BACKEND=cillvoice: tokens in VOICE_SERVER_UPDATE, SDP signaling over gateway op 50, track announcements and the
// permission rules (server mute, stage suppress) applied to what is offered to others. Media itself is covered by
// the media-*.test.js unit tests and scripts/e2e-*.cjs with real browsers.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startServer, guildWith } from './helpers.js';

const OFFER = readFileSync(new URL('./fixtures/chrome-offer.sdp', import.meta.url), 'utf8');
// a real Chromium offer whose screen share transceiver prefers H.264 (setCodecPreferences), as the client sends it
const OFFER_H264 = readFileSync(new URL('./fixtures/chrome-offer-h264.sdp', import.meta.url), 'utf8');
// the same from Chromium 145 preferring AV1 (two L1T1 simulcast layers), as the client sends an AV1 screen share
const OFFER_AV1 = readFileSync(new URL('./fixtures/chrome-offer-av1.sdp', import.meta.url), 'utf8');
let srv, api, g, alice, bob, carol;

before(async () => {
  srv = await startServer({ env: { VOICE_BACKEND: 'cillvoice', CILLVOICE_UDP_PORT: '3347', CILLVOICE_PUBLIC_IP: '127.0.0.1' } });
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob', 'carol']);
  ({ alice, bob, carol } = g.users);
  for (const u of [alice, bob, carol]) u.gw = await srv.gateway(u.token);
});
after(() => srv.stop());

const join = (u, channelId = g.voice.id) => u.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: channelId, self_mute: false, self_deaf: false } });
const offer = (u, token, extra = {}) => u.gw.send({ op: 50, d: { token, sdp: OFFER, publish: [], subscribe: [], ...extra } });

test('join answers VOICE_SERVER_UPDATE with endpoint "cillvoice" and a token; op 50 returns an ICE-lite answer', async () => {
  join(bob);
  const su = await bob.gw.event('VOICE_SERVER_UPDATE');
  assert.equal(su.endpoint, 'cillvoice');
  assert.equal(su.channel_id, g.voice.id);
  assert.match(su.token, /^[\w-]{32}$/);
  bob.token2 = su.token;
  offer(bob, su.token, { publish: [{ mid: '0', source: 'microphone' }, { mid: '1', source: 'camera' }] });
  const a = await bob.gw.event('CILLVOICE_ANSWER');
  assert.equal(a.channel_id, g.voice.id);
  assert.match(a.sdp, /a=ice-lite/);
  assert.match(a.sdp, /m=audio 3347 /);
  assert.match(a.sdp, /a=candidate:1 1 udp \d+ 127\.0\.0\.1 3347 typ host/);
  assert.match(a.sdp, /a=fingerprint:sha-256 ([0-9A-F]{2}:){31}[0-9A-F]{2}/);
  assert.deepEqual(a.tracks, []);
  assert.deepEqual(a.subscribed, []);
});

test('the others get CILLVOICE_TRACKS; subscribing answers sendonly with an SSRC per track', async () => {
  join(alice);
  const su = await alice.gw.event('VOICE_SERVER_UPDATE');
  alice.cv = su.token;
  offer(alice, su.token);
  const a = await alice.gw.event('CILLVOICE_ANSWER');
  assert.deepEqual(a.tracks.map(t => [t.user_id, t.kind, t.source]), [[bob.id, 'audio', 'microphone'], [bob.id, 'video', 'camera']]);
  const [mic, cam] = a.tracks;
  offer(alice, su.token, { subscribe: [{ mid: '2', track_id: mic.id }, { mid: '3', track_id: cam.id }, { mid: '0', track_id: cam.id }] });
  const b = await alice.gw.event('CILLVOICE_ANSWER');
  assert.deepEqual(b.subscribed.map(s => [s.mid, s.track_id, s.user_id]), [['2', mic.id, bob.id], ['3', cam.id, bob.id]], 'a video track on an audio transceiver is refused');
  const sections = b.sdp.split('\r\nm=');
  assert.match(sections[3], /a=sendonly[\s\S]*a=ssrc:\d+ cname:/);
  assert.match(sections[4], /a=sendonly/);
  assert.match(sections[1], /a=inactive/);
  // bob is told about alice's (empty) publications only when they change
  assert.ok(await bob.gw.none(f => f.t === 'CILLVOICE_TRACKS', 300));
});

test('server mute withdraws the microphone from the others; unmute brings it back', async () => {
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, alice.token, { mute: true })).status, 200);
  let t = await alice.gw.event('CILLVOICE_TRACKS');
  assert.deepEqual(t.tracks.map(x => x.source), ['camera']);
  await api('PATCH', `/guilds/${g.guild.id}/members/${bob.id}`, alice.token, { mute: false });
  t = await alice.gw.event('CILLVOICE_TRACKS');
  assert.deepEqual(t.tracks.map(x => x.source), ['microphone', 'camera']);
});

test('a source the user may not publish, a mismatched kind or a duplicate source is not offered to others', async () => {
  offer(bob, bob.token2, { publish: [{ mid: '0', source: 'camera' }, { mid: '1', source: 'camera' }, { mid: '2', source: 'microphone' }] });
  await bob.gw.event('CILLVOICE_ANSWER');
  const t = await alice.gw.event('CILLVOICE_TRACKS');
  assert.deepEqual(t.tracks.map(x => x.source), ['camera'], 'audio m-line as camera and a recvonly m-line as microphone are ignored');
});

test('tokens: unknown or another user\'s are refused; a flags-only op 4 keeps the token', async () => {
  offer(carol, 'nope');
  assert.match((await carol.gw.event('CILLVOICE_ERROR')).message, /invalid/);
  offer(carol, bob.token2);
  await carol.gw.event('CILLVOICE_ERROR');
  join(bob, g.voice.id); // same channel, same session: flags only, the token stays valid
  offer(bob, bob.token2);
  await bob.gw.event('CILLVOICE_ANSWER');
});

test('a new peer connection (Retry: same token, new certificate) gets a fresh transport; a renegotiation keeps it', async () => {
  const ufrag = sdp => sdp.match(/a=ice-ufrag:(\S+)/)[1];
  offer(bob, bob.token2);
  const a = await bob.gw.event('CILLVOICE_ANSWER');
  offer(bob, bob.token2);
  assert.equal(ufrag((await bob.gw.event('CILLVOICE_ANSWER')).sdp), ufrag(a.sdp), 'same peer connection: same ICE credentials');
  bob.gw.send({ op: 50, d: { token: bob.token2, sdp: OFFER.replace(/D9:70:17/g, 'D9:70:18'), publish: [], subscribe: [] } });
  assert.notEqual(ufrag((await bob.gw.event('CILLVOICE_ANSWER')).sdp), ufrag(a.sdp));
});

test('leaving removes the participant: the others get an empty track list', async () => {
  bob.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: null, self_mute: false, self_deaf: false } });
  const t = await alice.gw.event('CILLVOICE_TRACKS');
  assert.deepEqual(t.tracks, []);
  offer(bob, bob.token2);
  await bob.gw.event('CILLVOICE_ERROR');
});

test('stage: audience members (suppress) publish nothing others can receive until invited to speak', async () => {
  const stage = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, { name: 'Stage', type: 13 })).body;
  join(carol, stage.id);
  const su = await carol.gw.event('VOICE_SERVER_UPDATE', d => d.channel_id === stage.id);
  offer(carol, su.token, { publish: [{ mid: '0', source: 'microphone' }] });
  await carol.gw.event('CILLVOICE_ANSWER');
  join(alice, stage.id);
  const sa = await alice.gw.event('VOICE_SERVER_UPDATE', d => d.channel_id === stage.id);
  offer(alice, sa.token);
  assert.deepEqual((await alice.gw.event('CILLVOICE_ANSWER')).tracks, []);
  assert.equal((await api('PATCH', `/guilds/${g.guild.id}/voice-states/${carol.id}`, alice.token, { channel_id: stage.id, suppress: false })).status, 204);
  const t = await alice.gw.event('CILLVOICE_TRACKS', d => d.channel_id === stage.id);
  assert.deepEqual(t.tracks.map(x => [x.user_id, x.source]), [[carol.id, 'microphone']]);
});

test('codecs: H.264 is answered first for a screen share that prefers it; a member who cannot decode H.264 switches the room to VP8 until they leave', async () => {
  const ch = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, { name: 'Codecs', type: 2 })).body;
  const video = sdp => sdp.split('\r\nm=').find(x => x.includes('a=mid:1\r\n'));
  join(alice, ch.id);
  const sa = await alice.gw.event('VOICE_SERVER_UPDATE', d => d.channel_id === ch.id);
  const pub = { publish: [{ mid: '0', source: 'microphone' }, { mid: '1', source: 'screen_share' }] };
  alice.gw.send({ op: 50, d: { token: sa.token, sdp: OFFER_H264, subscribe: [], ...pub } });
  let m = video((await alice.gw.event('CILLVOICE_ANSWER', d => d.channel_id === ch.id)).sdp);
  assert.match(m, /^video 3347 UDP\/TLS\/RTP\/SAVPF 109 96 45\r\n/, 'H.264 (42e01f, packetization mode 1) first, VP8 second, AV1 last as offered');
  assert.match(m, /a=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f/);
  for (const fb of ['nack', 'nack pli', 'ccm fir', 'transport-cc']) assert.match(m, new RegExp(`a=rtcp-fb:109 ${fb}\r\n`));
  assert.doesNotMatch(m, /rtx|VP9/);

  // carol's browser cannot decode H.264 (no H264 in her receive m-lines): alice is asked to offer again and gets VP8 only
  join(carol, ch.id);
  const sc = await carol.gw.event('VOICE_SERVER_UPDATE', d => d.channel_id === ch.id);
  carol.gw.send({ op: 50, d: { token: sc.token, sdp: OFFER_H264.replace(/a=rtpmap:\d+ H264\/90000\r\n/g, ''), publish: [], subscribe: [] } });
  const ca = await carol.gw.event('CILLVOICE_ANSWER', d => d.channel_id === ch.id);
  const screen = ca.tracks.find(t => t.source === 'screen_share');
  await alice.gw.event('CILLVOICE_TRACKS', d => d.channel_id === ch.id);
  alice.gw.send({ op: 50, d: { token: sa.token, sdp: OFFER_H264, subscribe: [], ...pub } });
  m = video((await alice.gw.event('CILLVOICE_ANSWER', d => d.channel_id === ch.id)).sdp);
  assert.match(m, /^video 3347 UDP\/TLS\/RTP\/SAVPF 96 45\r\n/, 'no H.264 while carol is in the room: VP8 first (AV1, which she decodes, stays behind it as offered)');
  // carol's subscription is answered with VP8 (and still lists no H.264)
  carol.gw.send({ op: 50, d: { token: sc.token, sdp: OFFER_H264.replace(/a=rtpmap:\d+ H264\/90000\r\n/g, ''), publish: [], subscribe: [{ mid: '3', track_id: screen.id }] } });
  const sub = (await carol.gw.event('CILLVOICE_ANSWER', d => d.channel_id === ch.id)).sdp.split('\r\nm=').find(x => x.includes('a=mid:3\r\n'));
  assert.match(sub, /^video 3347 UDP\/TLS\/RTP\/SAVPF 96 45\r\n[\s\S]*a=sendonly/);

  carol.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: null, self_mute: false, self_deaf: false } });
  await alice.gw.event('CILLVOICE_TRACKS', d => d.channel_id === ch.id);
  alice.gw.send({ op: 50, d: { token: sa.token, sdp: OFFER_H264, subscribe: [], ...pub } });
  m = video((await alice.gw.event('CILLVOICE_ANSWER', d => d.channel_id === ch.id)).sdp);
  assert.match(m, /^video 3347 UDP\/TLS\/RTP\/SAVPF 109 96 45\r\n/, 'H.264 again once carol left');
  alice.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: null, self_mute: false, self_deaf: false } });
});

test('codecs: AV1 is answered first for a screen share that prefers it; a member without AV1 makes the room fall back to H.264, one without H.264 too to VP8', async () => {
  const ch = (await api('POST', `/guilds/${g.guild.id}/channels`, alice.token, { name: 'AV1', type: 2 })).body;
  const video = (sdp, mid = '1') => sdp.split('\r\nm=').find(x => x.includes(`a=mid:${mid}\r\n`));
  const noAv1 = OFFER_AV1.replace(/a=rtpmap:\d+ AV1\/90000\r\n/g, '');
  const noAv1H264 = noAv1.replace(/a=rtpmap:\d+ H264\/90000\r\n/g, '');
  const pub = { publish: [{ mid: '0', source: 'microphone' }, { mid: '1', source: 'screen_share' }] };
  const enter = async u => { join(u, ch.id); return (await u.gw.event('VOICE_SERVER_UPDATE', d => d.channel_id === ch.id)).token; };
  const leave = u => u.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: null, self_mute: false, self_deaf: false } });
  const sa = await enter(alice);
  const publish = async () => {
    alice.gw.send({ op: 50, d: { token: sa, sdp: OFFER_AV1, subscribe: [], ...pub } });
    return video((await alice.gw.event('CILLVOICE_ANSWER', d => d.channel_id === ch.id)).sdp);
  };
  let m = await publish();
  assert.match(m, /^video 3347 UDP\/TLS\/RTP\/SAVPF 45 109 96\r\n/, 'AV1 (profile 0) first, then H.264 and VP8 in the offer\'s order');
  assert.match(m, /a=fmtp:45 level-idx=5;profile=0;tier=0\r\n/);
  for (const fb of ['nack', 'nack pli', 'ccm fir', 'transport-cc']) assert.match(m, new RegExp(`a=rtcp-fb:45 ${fb}\r\n`));
  assert.match(m, /a=simulcast:recv h;f/);

  // carol cannot decode AV1: alice offers again and gets H.264 first, no AV1
  const sc = await enter(carol);
  carol.gw.send({ op: 50, d: { token: sc, sdp: noAv1, publish: [], subscribe: [] } });
  const screen = (await carol.gw.event('CILLVOICE_ANSWER', d => d.channel_id === ch.id)).tracks.find(t => t.source === 'screen_share');
  await alice.gw.event('CILLVOICE_TRACKS', d => d.channel_id === ch.id);
  m = await publish();
  assert.match(m, /^video 3347 UDP\/TLS\/RTP\/SAVPF 109 96\r\n/, 'H.264 and VP8 while carol is in the room');
  carol.gw.send({ op: 50, d: { token: sc, sdp: noAv1, publish: [], subscribe: [{ mid: '3', track_id: screen.id }] } });
  const sub = video((await carol.gw.event('CILLVOICE_ANSWER', d => d.channel_id === ch.id)).sdp, '3');
  assert.match(sub, /^video 3347 UDP\/TLS\/RTP\/SAVPF 96 109\r\n[\s\S]*a=sendonly/, "carol's subscription: her codecs, no AV1");

  // bob decodes neither: VP8 only; as they leave, H.264 and then AV1 come back
  const sb = await enter(bob);
  bob.gw.send({ op: 50, d: { token: sb, sdp: noAv1H264, publish: [], subscribe: [] } });
  await bob.gw.event('CILLVOICE_ANSWER', d => d.channel_id === ch.id);
  await alice.gw.event('CILLVOICE_TRACKS', d => d.channel_id === ch.id);
  assert.match(await publish(), /^video 3347 UDP\/TLS\/RTP\/SAVPF 96\r\n/, 'VP8 only while bob is in the room');
  leave(bob);
  await alice.gw.event('CILLVOICE_TRACKS', d => d.channel_id === ch.id);
  assert.match(await publish(), /^video 3347 UDP\/TLS\/RTP\/SAVPF 109 96\r\n/, 'H.264 again once bob left');
  leave(carol);
  await alice.gw.event('CILLVOICE_TRACKS', d => d.channel_id === ch.id);
  assert.match(await publish(), /^video 3347 UDP\/TLS\/RTP\/SAVPF 45 109 96\r\n/, 'AV1 again once carol left');
  leave(alice);
});

test('leaving before signaling revokes the token and a malformed initial offer does not leak a room', async () => {
  const { mediaStats } = await import('../src/media/index.js');
  join(bob, g.voice.id);
  const su = await bob.gw.event('VOICE_SERVER_UPDATE', d => d.channel_id === g.voice.id);
  // bob leaves before sending op 50: the token must be revoked even though no Room existed yet
  bob.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: null, self_mute: false, self_deaf: false } });
  await alice.gw.event('VOICE_STATE_UPDATE', d => d.user_id === bob.id && d.channel_id === null);
  offer(bob, su.token);
  assert.match((await bob.gw.event('CILLVOICE_ERROR')).message, /invalid/);
  assert.equal(mediaStats().rooms, 0);

  // alice joins and sends a malformed offer (no ICE credentials/fingerprint): must not leave an empty Room behind
  join(alice, g.voice.id);
  const sa = await alice.gw.event('VOICE_SERVER_UPDATE', d => d.channel_id === g.voice.id);
  alice.gw.send({ op: 50, d: { token: sa.token, sdp: 'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n', publish: [], subscribe: [] } });
  assert.match((await alice.gw.event('CILLVOICE_ERROR')).message, /offer/);
  assert.equal(mediaStats().rooms, 0);
  alice.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id: null, self_mute: false, self_deaf: false } });
  await alice.gw.event('VOICE_STATE_UPDATE', d => d.user_id === alice.id && d.channel_id === null);
});
