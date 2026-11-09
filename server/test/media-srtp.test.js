import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv } from 'node:crypto';
import { kdf, SrtpContext } from '../src/media/srtp.js';

const hex = s => Buffer.from(s.replace(/\s+/g, ''), 'hex');

test('RFC 3711 B.2: AES-CM keystream', () => {
  const iv = SrtpContext.cmIv(hex('F0F1F2F3F4F5F6F7F8F9FAFBFCFD'), 0, 0);
  assert.equal(iv.toString('hex').toUpperCase(), 'F0F1F2F3F4F5F6F7F8F9FAFBFCFD0000');
  const ks = createCipheriv('aes-128-ctr', hex('2B7E151628AED2A6ABF7158809CF4F3C'), iv).update(Buffer.alloc(48));
  assert.equal(ks.toString('hex').toUpperCase(), 'E03EAD0935C95E80E166B16DD92B4EB4D23513162B02D0F72A43A2FE4A5F97AB41E95B3BB0A2E8DD477901E4FCA894C0');
});

test('RFC 3711 B.3: key derivation', () => {
  const mk = hex('E1F97A0D3E018BE0D64FA32C06DE4139'), ms = hex('0EC675AD498AFEEBB6960B3AABE6');
  assert.equal(kdf(mk, ms, 0, 16).toString('hex').toUpperCase(), 'C61E7A93744F39EE10734AFE3FF7A087');
  assert.equal(kdf(mk, ms, 2, 14).toString('hex').toUpperCase(), '30CBBC08863D8C85D49DB34A9AE1');
  assert.equal(kdf(mk, ms, 1, 94).toString('hex').toUpperCase(),
    'CEBE321F6FF7716B6FD4AB49AF256A156D38BAA48F0A0ACF3C34E2359E6CDBCEE049646C43D9327AD175578EF72270986371C10C9A369AC2F94A8C5FBCDDDC256D6E919A48B610EF17C2041E474035766B68642C59BBFC2F34DB60DBDFB2');
});

// a context whose session keys are given directly (the RFC 7714 vectors start after key derivation)
function gcmContext(key, salt) {
  const c = new SrtpContext(7, Buffer.alloc(16), Buffer.alloc(12));
  c.rtpKey = c.rtcpKey = key;
  c.rtpSalt = c.rtcpSalt = salt;
  return c;
}
const KEY = hex('000102030405060708090a0b0c0d0e0f'), SALT = hex('517569642070726f2071756f');

test('RFC 7714 16.1.1: SRTP AEAD_AES_128_GCM', () => {
  assert.equal(SrtpContext.gcmIv(SALT, 0x5501a0b2, 0, 0xf17b).toString('hex'), '51753c6580c2726f20718414');
  const plain = Buffer.concat([hex('8040f17b8041f8d35501a0b2'), Buffer.from('Gallia est omnis divisa in partes tres')]);
  const expected = hex(`8040f17b8041f8d35501a0b2 f24de3a3fb34de6cacba861c9d7e4bcabe633bd50d294e6f42a5f47a51c7d19b36de3adf8833
    899d7f27beb16a9152cf765ee4390cce`);
  assert.deepEqual(gcmContext(KEY, SALT).protectRtp(plain), expected);
  assert.deepEqual(gcmContext(KEY, SALT).unprotectRtp(expected), plain);
});

test('RFC 7714 17.1: SRTCP AEAD_AES_128_GCM', () => {
  const plain = hex('81c8000d4d617273 4e5450314e54503252545020 0000042a0000e9304c756e61deadbeefdeadbeefdeadbeefdeadbeefdeadbeef');
  const expected = hex(`81c8000d4d617273 63e94885dcdab67ca727d7662f6b7e997ff5c0f76c06f32dc676a5f1730d6fda4ce09b4686303ded0bb9275b
    c84aa45896cf4d2fc5abf87245d9eade 800005d4`);
  const c = gcmContext(KEY, SALT);
  c.stream(0x4d617273).rtcpIndex = 0x5d3; // protect uses the next index, 0x5d4
  assert.deepEqual(c.protectRtcp(plain), expected);
  assert.deepEqual(gcmContext(KEY, SALT).unprotectRtcp(expected), plain);
});

const rtp = (seq, ssrc = 0x1234, payload = 'hello') => {
  const h = Buffer.alloc(12);
  h[0] = 0x80; h[1] = 111; h.writeUInt16BE(seq, 2); h.writeUInt32BE(seq * 960, 4); h.writeUInt32BE(ssrc, 8);
  return Buffer.concat([h, Buffer.from(payload)]);
};

for (const profile of [1, 7]) {
  test(`profile ${profile}: round trip, tamper, replay, rollover`, () => {
    const mk = Buffer.alloc(16, 9), ms = Buffer.alloc(profile === 7 ? 12 : 14, 4);
    const tx = new SrtpContext(profile, mk, ms), rx = new SrtpContext(profile, mk, ms);
    let seq = 65530;
    for (let i = 0; i < 12; i++, seq = (seq + 1) & 0xffff) {
      const p = rtp(seq);
      const sp = tx.protectRtp(p);
      assert.ok(!sp.subarray(12).toString().includes('hello'), 'payload encrypted');
      assert.deepEqual(rx.unprotectRtp(sp), p, `seq ${seq} across the wrap`);
      assert.equal(rx.unprotectRtp(sp), null, 'replayed packet dropped');
    }
    assert.equal(rx.stream(0x1234).roc, 1);
    const bad = tx.protectRtp(rtp(seq));
    bad[bad.length - 1] ^= 1;
    assert.equal(rx.unprotectRtp(bad), null, 'tampered tag');
    // late (reordered) packet inside the window is accepted once
    const late = tx.protectRtp(rtp(seq - 3 & 0xffff, 0x1234, 'late'));
    assert.equal(rx.unprotectRtp(late), null, 'seq - 3 was already received');
    const tx2 = new SrtpContext(profile, mk, ms), rx2 = new SrtpContext(profile, mk, ms);
    const a = tx2.protectRtp(rtp(10)), b = tx2.protectRtp(rtp(12)), c = tx2.protectRtp(rtp(11));
    assert.ok(rx2.unprotectRtp(a) && rx2.unprotectRtp(b) && rx2.unprotectRtp(c), 'reordered 11 after 12');
    // RTCP
    const rr = Buffer.from('81c90007000000010000000000000000000000000000000000000000000000', 'hex').subarray(0, 32);
    const s1 = tx.protectRtcp(rr), s2 = tx.protectRtcp(rr);
    assert.deepEqual(rx.unprotectRtcp(s1), rr);
    assert.deepEqual(rx.unprotectRtcp(s2), rr);
    assert.equal(rx.unprotectRtcp(s2), null, 'replayed RTCP dropped');
  });
}

test('junk packets with new SSRCs allocate no stream state; streams are capped per context (audit H7)', () => {
  const tx = new SrtpContext(1, Buffer.alloc(16, 1), Buffer.alloc(14, 2)), rx = new SrtpContext(1, Buffer.alloc(16, 1), Buffer.alloc(14, 2));
  const rtp = (ssrc, seq) => { const p = Buffer.alloc(40); p[0] = 0x80; p.writeUInt16BE(seq, 2); p.writeUInt32BE(ssrc, 8); return p; };
  for (let i = 0; i < 1000; i++) assert.equal(rx.unprotectRtp(rtp(i, 1)), null);
  for (let i = 0; i < 1000; i++) assert.equal(rx.unprotectRtcp(Buffer.alloc(40, i & 0xff)), null);
  assert.equal(rx.streams.size, 0);
  for (let i = 0; i < 100; i++) assert.ok(rx.unprotectRtp(tx.protectRtp(rtp(i, 1))));
  assert.equal(rx.streams.size, 64);
});
