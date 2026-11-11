// DTLS server against OpenSSL's DTLS 1.2 client (s_client): the SRTP keying material both sides export must match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import { DtlsServer, makeCertificate, fingerprintOf, prf } from '../src/media/dtls.js';

const PORT = 3348; // cillvoice tests stay within 3340-3349
let hasOpenssl = true;
try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); } catch { hasOpenssl = false; }
const skip = hasOpenssl ? false : 'needs the openssl CLI (DTLS client for interop)';

test('TLS 1.2 PRF (SHA-256) known answer', () => {
  const out = prf(Buffer.from('9bbe436ba940f017b17652849a71db35', 'hex'), 'test label', Buffer.from('a0ba9f936cda311827a6f796ffd5198c', 'hex'), 100);
  assert.equal(out.toString('hex'), 'e3f229ba727be17b8d122620557cd453c2aab21d07c3d495329b52d4e61edb5a6b301791e90d35c9c9a46b4e14baf9af0fa022f7077def17abfd3797c0564bab4fbc91666e9def9b97fce34f796789baa48082d122ee42c5a72e5a5110fff70187347b66');
});

test('self-signed certificate: valid X.509, ECDSA P-256, verifies with its own key', () => {
  const c = makeCertificate();
  const x = new X509Certificate(c.der);
  assert.ok(x.verify(x.publicKey));
  assert.equal(x.publicKey.asymmetricKeyDetails.namedCurve, 'prime256v1');
  assert.equal(x.fingerprint256, c.fingerprint);
  assert.equal(x.subject, 'CN=cillvoice');
});

async function handshake({ profile, keyType = 'ec', fingerprint }) {
  const dir = mkdtempSync(join(tmpdir(), 'cv-dtls-'));
  try {
    const keyArgs = keyType === 'ec' ? ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1'] : ['-newkey', 'rsa:2048'];
    execFileSync('openssl', ['req', '-x509', ...keyArgs, '-nodes', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem'), '-subj', '/CN=client', '-days', '1'], { stdio: 'ignore' });
    const der = execFileSync('openssl', ['x509', '-in', join(dir, 'c.pem'), '-outform', 'DER']);
    const cert = makeCertificate();
    const sock = dgram.createSocket('udp4');
    await new Promise(r => sock.bind(0, '127.0.0.1', r));
    const port = sock.address().port;
    const result = {};
    let srv;
    sock.on('message', (m, r) => {
      srv ??= new DtlsServer({ cert, remoteFingerprint: fingerprint ?? fingerprintOf(der), send: b => sock.send(b, r.port, r.address), onConnected: k => (result.keys = k), onClose: () => (result.closed = true) });
      srv.handle(m);
    });
    const len = profile.includes('GCM') ? 56 : 60;
    const c = spawn('openssl', ['s_client', '-dtls1_2', '-connect', `127.0.0.1:${port}`, '-use_srtp', profile, '-cert', join(dir, 'c.pem'), '-key', join(dir, 'k.pem'), '-keymatexport', 'EXTRACTOR-dtls_srtp', '-keymatexportlen', String(len)]);
    let out = '';
    c.stdout.on('data', d => (out += d));
    c.stderr.on('data', d => (out += d));
    for (let i = 0; i < 60 && !/Keying material: [0-9A-F]+/.test(out) && !result.closed; i++) await new Promise(r => setTimeout(r, 50));
    c.kill();
    sock.close();
    result.openssl = out.match(/Keying material: ([0-9A-F]+)/)?.[1];
    result.text = out;
    return result;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

for (const [profile, id] of [['SRTP_AEAD_AES_128_GCM', 7], ['SRTP_AES128_CM_SHA1_80', 1]]) {
  test(`handshake with OpenSSL, ${profile}: same SRTP keys on both sides, EMS used`, { skip }, async () => {
    const r = await handshake({ profile });
    assert.ok(r.keys, r.text);
    assert.equal(r.keys.profile, id);
    const k = r.keys;
    assert.equal(Buffer.concat([k.remoteKey, k.localKey, k.remoteSalt, k.localSalt]).toString('hex').toUpperCase(), r.openssl);
    assert.match(r.text, /Extended master secret: yes/);
  });
}

test('RSA client certificate (CertificateVerify with RSA) is accepted', { skip }, async () => {
  const r = await handshake({ profile: 'SRTP_AEAD_AES_128_GCM', keyType: 'rsa' });
  assert.ok(r.keys, r.text);
});

test('a client certificate that does not match the SDP fingerprint is refused', { skip }, async () => {
  const r = await handshake({ profile: 'SRTP_AEAD_AES_128_GCM', fingerprint: 'AA:'.repeat(31) + 'AA' });
  assert.equal(r.keys, undefined);
  assert.ok(r.closed);
});

test('mismatched DTLS fragment headers for the same message_seq are ignored without crashing', () => {
  let closed = false;
  const srv = new DtlsServer({ cert: makeCertificate(), remoteFingerprint: 'AA:'.repeat(31) + 'AA', send: () => {}, onConnected: () => {}, onClose: () => { closed = true; } });
  const hsFrag = (mseq, len, off, body) => {
    const h = Buffer.alloc(12);
    h[0] = 1; // CLIENT_HELLO
    h.writeUIntBE(len, 1, 3);
    h.writeUInt16BE(mseq, 4);
    h.writeUIntBE(off, 6, 3);
    h.writeUIntBE(body.length, 9, 3);
    const payload = Buffer.concat([h, body]);
    const rec = Buffer.alloc(13);
    rec[0] = 22; // HANDSHAKE
    rec.writeUInt16BE(0xfefd, 1);
    rec.writeUInt16BE(payload.length, 11);
    return Buffer.concat([rec, payload]);
  };
  srv.handle(hsFrag(0, 10, 0, Buffer.alloc(5)));
  srv.handle(hsFrag(0, 20, 15, Buffer.alloc(5)));
  assert.equal(closed, false);
});

test('a plaintext alert cannot close a transport once the keys are in place', () => {
  let closed = false;
  const srv = new DtlsServer({ cert: makeCertificate(), remoteFingerprint: 'AA:'.repeat(31) + 'AA', send: () => {}, onConnected: () => {}, onClose: () => { closed = true; } });
  const alert = Buffer.alloc(15);
  alert[0] = 21; // ALERT, epoch 0
  alert.writeUInt16BE(0xfefd, 1);
  alert.writeUInt16BE(2, 11);
  alert[13] = 2; // fatal
  srv.readKey = Buffer.alloc(16); // past the key exchange (as after a handshake)
  srv.handle(alert);
  assert.equal(closed, false, 'spoofed epoch-0 alert ignored');
  srv.readKey = null;
  srv.handle(alert);
  assert.equal(closed, true, 'during the handshake a plaintext alert still ends it');
});

test('a malformed plaintext handshake record cannot close an established transport', () => {
  let closed = false, sent = 0;
  const srv = new DtlsServer({ cert: makeCertificate(), send: () => sent++, onConnected: () => {}, onClose: () => { closed = true; } });
  Object.assign(srv, { state: 'done', readKey: Buffer.alloc(16), nextRecv: 4, flight: [{ type: 20, epoch: 0, body: Buffer.from([1]) }] });
  // 25 bytes: HANDSHAKE, epoch 0, record length 12, a header that claims 1 fragment byte and carries none
  const bad = Buffer.alloc(25);
  bad[0] = 22;
  bad.writeUInt16BE(0xfefd, 1);
  bad.writeUInt16BE(12, 11);
  bad.writeUIntBE(1, 22, 3);
  srv.handle(bad);
  assert.equal(closed, false, 'dropped, the transport stays up');
  assert.equal(sent, 0, 'no alert sent');
  // a retransmitted final flight from the peer (an old message_seq) still gets our last flight again
  const again = Buffer.alloc(26);
  again[0] = 22;
  again.writeUInt16BE(0xfefd, 1);
  again.writeUInt16BE(13, 11);
  again.writeUIntBE(1, 14, 3); // length 1
  again.writeUInt16BE(3, 17); // message_seq 3 < 4
  again.writeUIntBE(1, 22, 3); // one fragment byte, present
  srv.handle(again);
  assert.equal(closed, false);
  assert.equal(sent, 1, 'last flight resent');
});
