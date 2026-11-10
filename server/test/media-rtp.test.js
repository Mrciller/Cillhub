import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseRtp, buildRtp, parseRtcp, buildNack, parseNack, buildPli, parseRemb, buildRemb, buildSr, buildRr, parseReportBlocks,
  ReceiveStats, buildTwcc, vp8Info, vp8PictureId, h264Keyframe, av1Keyframe, isRtcp,
} from '../src/media/rtp.js';
import { parseOffer, buildAnswer, pickCodecs, EXT_URI } from '../src/media/sdp.js';
import { Downstream } from '../src/media/sfu.js';

test('RTP: build and parse with one-byte and two-byte extensions, padding', () => {
  const p = buildRtp({ marker: true, pt: 111, seq: 65535, ts: 4294967295, ssrc: 0xdeadbeef }, [[1, Buffer.from([0x85])], [4, Buffer.from('0')]], Buffer.from('opus'));
  const r = parseRtp(p);
  assert.deepEqual([r.marker, r.pt, r.seq, r.ts, r.ssrc], [true, 111, 65535, 4294967295, 0xdeadbeef]);
  assert.deepEqual(r.ext.get(1), Buffer.from([0x85]));
  assert.equal(r.ext.get(4).toString(), '0');
  assert.equal(r.payload.toString(), 'opus');
  const two = parseRtp(buildRtp({ pt: 96, seq: 1, ts: 2, ssrc: 3 }, [[20, Buffer.from('long-mid-value-over-16-bytes')]], Buffer.alloc(3)));
  assert.equal(two.ext.get(20).toString(), 'long-mid-value-over-16-bytes');
  const padded = Buffer.concat([buildRtp({ pt: 96, seq: 1, ts: 2, ssrc: 3 }, [], Buffer.from('ab')), Buffer.from([0, 0, 3])]);
  padded[0] |= 0x20;
  assert.equal(parseRtp(padded).payload.toString(), 'ab');
  assert.equal(parseRtp(Buffer.alloc(5)), null);
  assert.ok(isRtcp(buildPli(1, 2)) && !isRtcp(p));
});

test('RTCP: NACK round trip with bitmasks, PLI, REMB, SR/RR, compound split', () => {
  const seqs = [65534, 65535, 0, 3, 17, 18, 40];
  const nack = buildNack(1, 0xabc, seqs);
  const [r] = parseRtcp(nack);
  assert.deepEqual([r.pt, r.fmt, r.ssrc, r.body.readUInt32BE(0)], [205, 1, 1, 0xabc]);
  assert.deepEqual(parseNack(r.body).sort((a, b) => a - b), [...seqs].sort((a, b) => a - b));
  const remb = parseRtcp(buildRemb(9, 1_234_567, [5, 6]))[0];
  const v = parseRemb(remb.body);
  assert.deepEqual(v.ssrcs, [5, 6]);
  assert.ok(Math.abs(v.bitrate - 1_234_567) < 16);
  const block = { ssrc: 77, fractionLost: 25, lost: -2, highest: 70000, jitter: 12, lsr: 0x12345678, dlsr: 65536 };
  const parts = parseRtcp(Buffer.concat([buildSr(5, [1, 2], 3, 4, 5), buildRr(6, [block]), buildPli(7, 8)]));
  assert.deepEqual(parts.map(x => x.pt), [200, 201, 206]);
  assert.deepEqual(parseReportBlocks(201, 1, parts[1].body)[0], block);
  assert.equal(parts[0].body.readUInt32BE(8), 3);
});

test('ReceiveStats: loss, extended highest sequence across a wrap, jitter', () => {
  const s = new ReceiveStats(90000);
  let seq = 65530, t = 0;
  for (let i = 0; i < 20; i++, seq = (seq + 1) & 0xffff, t += 33) if (i !== 5 && i !== 6) s.add(seq, (i * 2970) >>> 0, t);
  const b = s.block(1, t);
  assert.equal(b.highest, 65536 + 13);
  assert.equal(b.lost, 2);
  assert.equal(b.fractionLost, Math.floor((2 << 8) / 20));
  assert.ok(b.jitter < 5, 'steady 33 ms spacing (2970 ticks) has almost no jitter');
  assert.equal(s.block(1, t).fractionLost, 0, 'nothing new lost since the last report');
});

// decoder for the feedback we write, per the draft's layout
function decodeTwcc(buf) {
  const [r] = parseRtcp(buf);
  const b = r.body;
  const base = b.readUInt16BE(4), count = b.readUInt16BE(6), ref = b.readUIntBE(8, 3);
  const symbols = [];
  let o = 12;
  while (symbols.length < count) {
    const c = b.readUInt16BE(o); o += 2;
    assert.equal(c >> 14, 3, 'two-bit status vector chunk');
    for (let j = 0; j < 7 && symbols.length < count; j++) symbols.push((c >> (12 - 2 * j)) & 3);
  }
  let t = ref * 64;
  const arrivals = [];
  symbols.forEach((s, i) => {
    if (!s) return;
    const d = s === 1 ? b[o] : b.readInt16BE(o);
    o += s === 1 ? 1 : 2;
    t += d / 4;
    arrivals.push([base + i, t]);
  });
  return { r, arrivals, fb: b[11] };
}

test('transport-cc feedback: statuses and arrival deltas decode back (small, large and negative deltas, losses)', () => {
  const arrivals = [[100, 1000.25], [101, 1001], [103, 1003.5], [104, 1200], [105, 1150], [112, 1151]];
  const { r, arrivals: back, fb } = decodeTwcc(buildTwcc(1, 2, 100, arrivals, 7));
  assert.deepEqual([r.pt, r.fmt, fb], [205, 15, 7]);
  assert.deepEqual(back.map(a => a[0]), arrivals.map(a => a[0]));
  back.forEach(([, t], i) => assert.ok(Math.abs(t - arrivals[i][1]) <= 0.25, `arrival ${i}`));
});

test('VP8 descriptor: keyframe start, 15-bit picture id; H.264 keyframes in single NAL, STAP-A and FU-A', () => {
  const key = Buffer.from([0x90, 0xe0, 0x81, 0x23, 0x05, 0x00, 0x10]); // X S, I L T, pid 0x123, tl0 5, tid, payload P=0
  const i = vp8Info(key);
  assert.ok(i.start && i.keyframe && i.pidLong);
  assert.equal(vp8PictureId(key, i), 0x123);
  assert.equal(key[i.tl0At], 5);
  assert.ok(!vp8Info(Buffer.from([0x90, 0x80, 0x81, 0x23, 0x01])).keyframe, 'P bit set: delta frame');
  assert.ok(!vp8Info(Buffer.from([0x80, 0x80, 0x81, 0x23, 0x00])).keyframe, 'not a partition start');
  assert.ok(h264Keyframe(Buffer.from([0x65, 1])) && h264Keyframe(Buffer.from([0x67, 1])));
  assert.ok(!h264Keyframe(Buffer.from([0x41, 1])));
  assert.ok(h264Keyframe(Buffer.from([0x78, 0, 2, 0x67, 0, 0, 2, 0x68, 0])), 'STAP-A with SPS');
  assert.ok(h264Keyframe(Buffer.from([0x7c, 0x85, 0])) && !h264Keyframe(Buffer.from([0x7c, 0x05, 0])), 'FU-A start of an IDR only');
});

test('SDP: Chrome offer -> answer with ICE-lite, passive DTLS, simulcast recv, codecs and extensions per direction', () => {
  const offer = parseOffer(readFileSync(new URL('./fixtures/chrome-offer.sdp', import.meta.url), 'utf8'));
  assert.equal(offer.media.length, 4);
  assert.match(offer.media[0].fingerprint, /^D9:70/);
  assert.deepEqual(offer.media[1].rids.map(r => r.id), ['q', 'h', 'f']);
  assert.deepEqual(pickCodecs(offer.media[1]).map(c => [c.name, c.pt]), [['vp8', 96], ['h264', 109], ['av1', 45]]);
  const sdp = buildAnswer(offer, [{ recv: true }, { recv: true }, { send: { ssrc: 42, cname: 'c', msid: 'u t' } }, { inactive: true }],
    { ufrag: 'uf', pwd: 'pw', fingerprint: 'AA:BB', ip: '127.0.0.1', port: 3341, sessionId: 1, version: 2 });
  const sections = sdp.split('\r\nm=');
  assert.match(sections[0], /a=group:BUNDLE 0 1 2 3/);
  assert.match(sections[0], /a=ice-lite/);
  assert.match(sections[1], /^audio 3341 UDP\/TLS\/RTP\/SAVPF 111\r\n/);
  assert.match(sections[1], /a=setup:passive/);
  assert.match(sections[1], /a=recvonly/);
  assert.match(sections[1], /a=fmtp:111 minptime=10;useinbandfec=1/);
  assert.match(sections[1], /a=candidate:1 1 udp 2130706431 127\.0\.0\.1 3341 typ host/);
  assert.match(sections[1], new RegExp(`a=extmap:3 ${EXT_URI.twcc}`));
  assert.match(sections[2], /a=simulcast:recv q;h;f/);
  assert.match(sections[2], /a=rid:f recv/);
  assert.match(sections[2], /a=rtcp-fb:96 transport-cc/);
  assert.doesNotMatch(sections[2], /rtx|red\/|ulpfec/i);
  assert.match(sections[3], /a=sendonly[\s\S]*a=ssrc:42 cname:c/);
  assert.match(sections[3], new RegExp(`a=extmap:2 ${EXT_URI.absSendTime}`));
  assert.doesNotMatch(sections[3], /transport-cc/);
  assert.match(sections[4], /a=inactive/);
});

test('SDP: an offer that prefers H.264 (screen share) is answered H.264 first; a codecs override narrows it to VP8', () => {
  const offer = parseOffer(readFileSync(new URL('./fixtures/chrome-offer-h264.sdp', import.meta.url), 'utf8'));
  assert.deepEqual(offer.media[1].rids.map(r => r.id), ['h', 'f']);
  assert.deepEqual(pickCodecs(offer.media[1]).map(c => [c.name, c.pt]), [['h264', 109], ['vp8', 96], ['av1', 45]], 'constrained baseline 42e01f, packetization mode 1');
  const opts = { ufrag: 'uf', pwd: 'pw', fingerprint: 'AA:BB', ip: '127.0.0.1', port: 3341, sessionId: 1, version: 2 };
  const recv = { recv: true }, send = { send: { ssrc: 42, cname: 'c', msid: 'u t' } };
  let video = buildAnswer(offer, [recv, recv, recv, send], opts).split('\r\nm=');
  assert.match(video[2], /^video 3341 UDP\/TLS\/RTP\/SAVPF 109 96 45\r\n/);
  assert.match(video[2], /a=rtpmap:109 H264\/90000\r\n[\s\S]*a=rtcp-fb:109 nack pli\r\na=fmtp:109 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f/);
  assert.match(video[2], /a=simulcast:recv h;f/);
  assert.match(video[4], /^video 3341 UDP\/TLS\/RTP\/SAVPF 96 109 45\r\n/, 'a receive m-line keeps all three, in the browser\'s order');
  assert.match(video[4], new RegExp(`a=extmap:10 ${EXT_URI.rid}`), 'keeps RID on downstream video');
  const vp8 = pickCodecs(offer.media[1]).filter(c => c.name === 'vp8');
  video = buildAnswer(offer, [recv, { recv: true, codecs: vp8 }, recv, send], opts).split('\r\nm=');
  assert.match(video[2], /^video 3341 UDP\/TLS\/RTP\/SAVPF 96\r\n/);
  assert.doesNotMatch(video[2], /H264/);
});

test('SDP: a real Chromium offer whose screen share prefers AV1 is answered AV1 (profile 0) first, then H.264 and VP8', () => {
  const offer = parseOffer(readFileSync(new URL('./fixtures/chrome-offer-av1.sdp', import.meta.url), 'utf8'));
  assert.deepEqual(offer.media[1].rids.map(r => r.id), ['h', 'f']);
  assert.deepEqual(pickCodecs(offer.media[1]).map(c => [c.name, c.pt]), [['av1', 45], ['h264', 109], ['vp8', 96]]);
  // the receive m-line also offers AV1 profile 1 (47), which not every decoder handles
  assert.deepEqual(pickCodecs(offer.media[3]).map(c => [c.name, c.pt]), [['vp8', 96], ['h264', 109], ['av1', 45]]);
  const opts = { ufrag: 'uf', pwd: 'pw', fingerprint: 'AA:BB', ip: '127.0.0.1', port: 3341, sessionId: 1, version: 2 };
  const video = buildAnswer(offer, [{ recv: true }, { recv: true }, { recv: true }, { send: { ssrc: 42, cname: 'c', msid: 'u t' } }], opts).split('\r\nm=');
  assert.match(video[2], /^video 3341 UDP\/TLS\/RTP\/SAVPF 45 109 96\r\n/);
  assert.match(video[4], new RegExp(`a=extmap:10 ${EXT_URI.rid}`));
  assert.match(video[2], /a=rtpmap:45 AV1\/90000\r\na=rtcp-fb:45 transport-cc\r\na=rtcp-fb:45 ccm fir\r\na=rtcp-fb:45 nack\r\na=rtcp-fb:45 nack pli\r\na=fmtp:45 level-idx=5;profile=0;tier=0\r\n/);
  assert.match(video[2], /a=simulcast:recv h;f/);
  assert.doesNotMatch(video[2], /AV1\/90000[\s\S]*AV1\/90000|rtx|dependency-descriptor/, 'one AV1 entry, no RTX, no dependency descriptor');
  assert.match(video[4], /a=rtpmap:45 AV1\/90000[\s\S]*a=rtcp-fb:45 goog-remb/);
  assert.doesNotMatch(video[4], /a=rtpmap:47 /);
});

test('AV1 aggregation header: N=1 (new coded video sequence) is a keyframe start', () => {
  assert.ok(av1Keyframe(Buffer.from([0x18, 0x0a])), 'W=1, N=1: one OBU, a sequence header starts the keyframe');
  assert.ok(av1Keyframe(Buffer.from([0x08])));
  assert.ok(!av1Keyframe(Buffer.from([0x10, 0x32])), 'W=1, N=0: a delta frame');
  assert.ok(!av1Keyframe(Buffer.from([0x90, 0x32])), 'Z=1: continues a fragmented OBU');
  assert.ok(!av1Keyframe(Buffer.alloc(0)));
});

// a fake subscriber and video track to drive one Downstream
function rig() {
  const sent = [];
  const nacks = [];
  const sub = { ptFor: () => 100, extIds: { mid: 4 }, transport: { sendRtp: p => sent.push(parseRtp(p)) }, sendRtcp() {} };
  const track = { kind: 'video', clock: 90, codec: 'vp8', layers: new Map(), owner: { extIds: {} }, nackPublisher: (l, s) => nacks.push(...s), requestKeyframe() {} };
  const layers = { q: { rid: 'q', ssrc: 1 }, f: { rid: 'f', ssrc: 3 } };
  for (const l of Object.values(layers)) track.layers.set(l.rid, l);
  const ds = new Downstream(sub, '5', track);
  const send = (l, seq, ts, key, pid, t) => {
    const payload = Buffer.from([0x90, 0x80, 0x80 | (pid >> 8), pid & 0xff, key ? 0x00 : 0x01]);
    ds.forward({ seq, ts, marker: false, payload, ext: new Map() }, layers[l], key, vp8Info(payload), t);
  };
  return { ds, sent, nacks, send };
}

test('Downstream: waits for a keyframe, switches layers only on keyframes, keeps seq, timestamp and picture id continuous', () => {
  const { ds, sent, send } = rig();
  ds.target = 'q';
  send('q', 500, 9000, false, 10, 0);
  assert.equal(sent.length, 0, 'no delta frames before the first keyframe');
  send('q', 501, 12000, true, 11, 33);
  send('q', 502, 15000, false, 12, 66);
  send('f', 7000, 777000, false, 900, 70); // other layer: not forwarded
  assert.equal(sent.length, 2);
  assert.equal((sent[1].seq - sent[0].seq) & 0xffff, 1);
  assert.equal((sent[1].ts - sent[0].ts) >>> 0, 3000);
  assert.equal(sent[0].ssrc, ds.ssrc);
  assert.equal(sent[0].pt, 100);
  assert.equal(sent[0].ext.get(4).toString(), '5', 'our mid in the mid extension');
  ds.target = 'f';
  send('f', 7001, 780000, false, 901, 99); // delta frame on the target: keep the old layer
  send('q', 503, 18000, false, 13, 99);
  send('f', 7002, 783000, true, 902, 132); // keyframe: switch
  send('q', 504, 21000, false, 14, 133);
  send('f', 7003, 786000, false, 903, 165);
  assert.equal(sent.length, 5);
  const seqs = sent.map(p => p.seq), pids = sent.map(p => vp8PictureId(p.payload, vp8Info(p.payload)));
  for (let i = 1; i < seqs.length; i++) assert.equal((seqs[i] - seqs[i - 1]) & 0xffff, 1, `seq continuity at ${i}`);
  for (let i = 1; i < pids.length; i++) assert.equal((pids[i] - pids[i - 1]) & 0x7fff, 1, `picture id continuity at ${i}`);
  const jump = (sent[3].ts - sent[2].ts) >>> 0;
  assert.ok(jump > 0 && jump <= 33 * 90 + 1, `timestamp moves on by the elapsed time across the switch (${jump})`);
  assert.equal((sent[4].ts - sent[3].ts) >>> 0, 3000);
  send('f', 6999, 774000, false, 899, 170);
  assert.equal(sent.length, 5, 'packets from before the switch are dropped');
});

test('Downstream NACK: answered from the buffer, or passed to the publisher with the original sequence number', () => {
  const { ds, sent, nacks, send } = rig();
  ds.target = 'q';
  send('q', 100, 0, true, 1, 0);
  send('q', 101, 3000, false, 2, 33);
  send('q', 103, 9000, false, 4, 99); // 102 lost on the way to us
  const out = sent.map(p => p.seq);
  ds.onNack([out[1], (out[1] + 1) & 0xffff]);
  assert.equal(sent.length, 4, 'one resend from the buffer');
  assert.equal(sent[3].seq, out[1]);
  assert.deepEqual(nacks, [102]);
});

test('layer allocation: default budget, probing up on a steady REMB, stepping down when it falls, screen shares first', async () => {
  const { Room } = await import('../src/media/sfu.js');
  const room = new Room('r', { sock: {}, dispatch() {} });
  try {
    const layers = rates => rates.map((r, i) => ({ rid: 'qhf'.slice(3 - rates.length)[i], rank: i, meter: { bps: () => r } }));
    const ds = (source, rates) => {
      const ls = layers(rates);
      const track = { kind: 'video', source, layers: new Map(ls.map(l => [l.rid, l])), active: () => ls, requestKeyframe() {} };
      return { track, meter: { bps: () => 0 }, current: null, target: null };
    };
    const cam = ds('camera', [150e3, 450e3, 1500e3]);
    const p = { downstreams: new Map([['1', cam]]), remb: null, rembAt: 0 };
    room.allocate(p);
    assert.equal(cam.target, 'f', 'no REMB yet: 2.5 Mbit/s default');
    Object.assign(p, { remb: 400e3, rembAt: performance.now() });
    cam.meter.bps = () => 150e3;
    p.probedAt = -1e9;
    room.allocate(p);
    assert.equal(cam.target, 'h', 'steady REMB 400k while sending 150k: probe adds headroom, one layer up');
    p.remb = 200e3;
    room.allocate(p);
    assert.equal(cam.target, 'q', 'falling REMB is a hard limit');
    assert.ok(p.backoffUntil > performance.now(), 'the probe that overshot backs off');
    const screen = ds('screen_share', [400e3, 1200e3]);
    p.downstreams = new Map([['1', cam], ['2', screen]]);
    Object.assign(p, { remb: 1300e3, lastRemb: 1300e3, backoffUntil: 0, probedAt: performance.now() });
    cam.meter.bps = () => 1300e3;
    room.allocate(p);
    assert.deepEqual([screen.target, cam.target], ['f', 'q'], 'the screen share gets the bandwidth first');
  } finally {
    room.close();
  }
});

test('layer allocation: a probe lifts a stream to its next layer even 4x the rate, only congestion moves it back down', async () => {
  const { Room } = await import('../src/media/sfu.js');
  const room = new Room('r', { sock: {}, dispatch() {} });
  try {
    const ls = [{ rid: 'h', rank: 0, meter: { bps: () => 1e6 } }, { rid: 'f', rank: 1, meter: { bps: () => 4e6 } }];
    const screen = { track: { kind: 'video', source: 'screen_share', layers: new Map(ls.map(l => [l.rid, l])), active: () => ls, requestKeyframe() {} }, meter: { bps: () => 1e6 }, current: 'h', target: 'h' };
    const p = { downstreams: new Map([['1', screen]]), remb: 1.5e6, rembAt: performance.now(), lastRemb: 1.5e6, probedAt: -1e9 };
    room.allocate(p);
    assert.equal(screen.target, 'f', 'REMB follows what is received (1.5x of 1 Mbit/s): the probe still tries the 4 Mbit/s layer');
    screen.current = 'f';
    screen.meter.bps = () => 2.5e6; // the 2 s meter still half on the old layer
    room.allocate(p);
    assert.equal(screen.target, 'f', 'no congestion: stays up although the meters lag');
    p.remb = 1.2e6;
    room.allocate(p);
    assert.equal(screen.target, 'h', 'a falling REMB right after the probe moves it down');
    assert.ok(p.backoffUntil > performance.now(), 'and backs off');
  } finally {
    room.close();
  }
});

test('Downstream with H.264: waits for SPS/IDR, switches simulcast layers on a keyframe, rewrites the payload type per subscriber', () => {
  const sent = [];
  const sub = { ptFor: (mid, codec) => (codec === 'h264' ? 102 : 96), extIds: {}, transport: { sendRtp: p => sent.push(parseRtp(p)) }, sendRtcp() {} };
  const track = { kind: 'video', clock: 90, codec: 'h264', layers: new Map(), owner: { extIds: {} }, nackPublisher() {}, requestKeyframe() {} };
  const layers = { h: { rid: 'h', ssrc: 1 }, f: { rid: 'f', ssrc: 2 } };
  const ds = new Downstream(sub, '3', track);
  const STAP_SPS = [0x78, 0, 2, 0x67, 0x42, 0, 2, 0x68, 0xce], FU_IDR = [0x7c, 0x85, 1], FU_IDR_END = [0x7c, 0x45, 2], P_SLICE = [0x41, 1];
  const send = (l, seq, ts, bytes, t) => {
    const payload = Buffer.from(bytes);
    ds.forward({ seq, ts, pt: 109, marker: false, payload, ext: new Map() }, layers[l], h264Keyframe(payload), null, t);
  };
  ds.target = 'h';
  send('h', 10, 0, P_SLICE, 0);
  send('h', 11, 0, FU_IDR_END, 0); // the end of an IDR is not a place to start
  assert.equal(sent.length, 0);
  send('h', 12, 3000, STAP_SPS, 33);
  send('h', 13, 3000, FU_IDR, 33);
  send('h', 14, 3000, FU_IDR_END, 33);
  send('h', 15, 6000, P_SLICE, 66);
  assert.equal(sent.length, 4);
  assert.ok(sent.every(p => p.pt === 102), "the subscriber's own H.264 payload type");
  ds.target = 'f';
  send('f', 500, 90000, P_SLICE, 70); // not a keyframe: stay on h
  send('h', 16, 9000, P_SLICE, 99);
  send('f', 501, 93000, STAP_SPS, 100);
  send('f', 502, 93000, FU_IDR, 100);
  send('h', 17, 12000, P_SLICE, 132); // old layer after the switch: dropped
  assert.deepEqual(sent.slice(4).map(p => p.payload[0]), [0x41, 0x78, 0x7c]);
  for (let i = 1; i < sent.length; i++) assert.equal((sent[i].seq - sent[i - 1].seq) & 0xffff, 1, `seq continuity at ${i}`);
});

test('Downstream with AV1: waits for N=1, switches simulcast layers on a keyframe, rewrites seq/timestamp and the payload type, leaves the payload alone', () => {
  const sent = [];
  const sub = { ptFor: (mid, codec) => (codec === 'av1' ? 41 : 96), extIds: {}, transport: { sendRtp: p => sent.push(parseRtp(p)) }, sendRtcp() {} };
  const track = { kind: 'video', clock: 90, codec: 'av1', layers: new Map(), owner: { extIds: {} }, nackPublisher() {}, requestKeyframe() {} };
  const layers = { h: { rid: 'h', ssrc: 1 }, f: { rid: 'f', ssrc: 2 } };
  const ds = new Downstream(sub, '3', track);
  // aggregation headers: keyframe start (N=1, Y=1: the OBU continues), its middle (Z=1, Y=1) and end (Z=1), a delta frame (W=1)
  const KEY = [0x48, 0x0a, 0x0b], MID = [0xc0, 1], END = [0x80, 2], DELTA = [0x10, 0x32, 3];
  const send = (l, seq, ts, bytes, t, marker = false) => {
    const payload = Buffer.from(bytes);
    ds.forward({ seq, ts, pt: 45, marker, payload, ext: new Map() }, layers[l], av1Keyframe(payload), null, t);
  };
  ds.target = 'h';
  send('h', 10, 0, DELTA, 0, true);
  send('h', 11, 0, END, 0, true); // the end of a keyframe is not a place to start
  assert.equal(sent.length, 0);
  send('h', 12, 3000, KEY, 33);
  send('h', 13, 3000, MID, 33);
  send('h', 14, 3000, END, 33, true);
  send('h', 15, 6000, DELTA, 66, true);
  assert.equal(sent.length, 4);
  assert.ok(sent.every(p => p.pt === 41), "the subscriber's own AV1 payload type");
  assert.deepEqual([...sent[0].payload], KEY, 'no payload rewriting for AV1');
  assert.deepEqual(sent.map(p => p.marker), [false, false, true, true]);
  ds.target = 'f';
  send('f', 500, 90000, DELTA, 70, true); // not a keyframe: stay on h
  send('h', 16, 9000, DELTA, 99, true);
  send('f', 501, 93000, KEY, 100);
  send('f', 502, 93000, END, 100, true);
  send('h', 17, 12000, DELTA, 132, true); // old layer after the switch: dropped
  assert.deepEqual(sent.slice(4).map(p => p.payload[0]), [0x10, 0x48, 0x80]);
  for (let i = 1; i < sent.length; i++) assert.equal((sent[i].seq - sent[i - 1].seq) & 0xffff, 1, `seq continuity at ${i}`);
  assert.equal(sent[5].ts, sent[6].ts, 'one frame keeps one timestamp');
  assert.ok(((sent[5].ts - sent[4].ts) >>> 0) > 0 && ((sent[5].ts - sent[4].ts) >>> 0) < 90 * 100, 'the timeline continues across the switch');
});

test('speaking: someone who joins while others speak is told at once', async () => {
  const { Room } = await import('../src/media/sfu.js');
  const sent = [];
  const room = new Room('r', { sock: {}, dispatch: (session, t, d) => sent.push([session, t, d]) });
  try {
    room.join('a', 'sa', []);
    assert.deepEqual(sent, [], 'nobody speaks yet: nothing to tell');
    room.speakers = new Set(['a']);
    room.join('b', 'sb', []);
    assert.deepEqual(sent, [['sb', 'CILLVOICE_SPEAKING', { channel_id: 'r', speaking: ['a'] }]]);
  } finally {
    room.close();
  }
});

test('a publisher cannot grow the SSRC map: unknown rids are dropped, at most 32 streams (review M-3)', async () => {
  const { Room } = await import('../src/media/sfu.js');
  const room = new Room('r', { sock: {}, dispatch() {} });
  try {
    const p = room.join('u', {}, ['camera']);
    p.extIds = { mid: 1, rid: 2 };
    p.published.set('0', { rids: ['q', 'h', 'f'], onPacket() {}, downstreams: new Set() });
    const rtp = (ssrc, rid) => buildRtp({ pt: 96, seq: 1, ts: 0, ssrc }, [[1, Buffer.from('0')], [2, Buffer.from(rid)]], Buffer.alloc(10));
    p.onRtp(rtp(1, 'zz'));
    assert.equal(p.ssrcMap.size, 0, 'rid not negotiated');
    for (let i = 0; i < 100; i++) p.onRtp(rtp(100 + i, 'h'));
    assert.equal(p.ssrcMap.size, 32);
  } finally {
    room.close();
  }
});
