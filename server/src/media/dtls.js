// DTLS 1.2 server (RFC 6347, RFC 5246) for DTLS-SRTP (RFC 5764): TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256 with P-256,
// extended master secret (RFC 7627), mutual authentication checked against the SDP fingerprint, and the use_srtp
// extension. Only the handshake and alerts are carried; WebRTC media never travels inside DTLS records.
import { createECDH, createHash, createHmac, createCipheriv, createDecipheriv, generateKeyPairSync, randomBytes, sign, verify, X509Certificate, constants } from 'node:crypto';

const CT = { CCS: 20, ALERT: 21, HANDSHAKE: 22, APP: 23 };
const HS = { CLIENT_HELLO: 1, SERVER_HELLO: 2, CERTIFICATE: 11, SERVER_KEY_EXCHANGE: 12, CERTIFICATE_REQUEST: 13, SERVER_HELLO_DONE: 14, CERTIFICATE_VERIFY: 15, CLIENT_KEY_EXCHANGE: 16, FINISHED: 20 };
const SUITE = 0xc02b; // TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256
const EXT = { SUPPORTED_GROUPS: 10, EC_POINT_FORMATS: 11, SIGNATURE_ALGORITHMS: 13, USE_SRTP: 14, EMS: 23, RENEGOTIATION_INFO: 0xff01 };
const SRTP_PREFERENCE = [7, 1]; // AEAD_AES_128_GCM, then AES_CM_128_HMAC_SHA1_80
const MTU = 1150;

// client CertificateVerify algorithms we accept: [hash, rsa padding?]
const SIG_ALGS = {
  0x0403: ['sha256'], 0x0503: ['sha384'], 0x0401: ['sha256', constants.RSA_PKCS1_PADDING], 0x0501: ['sha384', constants.RSA_PKCS1_PADDING],
  0x0804: ['sha256', constants.RSA_PKCS1_PSS_PADDING], 0x0805: ['sha384', constants.RSA_PKCS1_PSS_PADDING],
};

/** TLS 1.2 PRF with SHA-256 (RFC 5246 section 5). */
export function prf(secret, label, seed, len) {
  const s = Buffer.concat([Buffer.from(label), seed]);
  const out = [];
  let a = s, n = 0;
  while (n < len) {
    a = createHmac('sha256', secret).update(a).digest();
    const block = createHmac('sha256', secret).update(a).update(s).digest();
    out.push(block);
    n += block.length;
  }
  return Buffer.concat(out).subarray(0, len);
}

// --- a minimal DER writer for the self-signed certificate -----------------------------------------------------------
const derLen = n => (n < 128 ? Buffer.from([n]) : n < 256 ? Buffer.from([0x81, n]) : Buffer.from([0x82, n >> 8, n & 0xff]));
const tlvDer = (tag, body) => Buffer.concat([Buffer.from([tag]), derLen(body.length), body]);
const seq = (...items) => tlvDer(0x30, Buffer.concat(items));
const oid = s => {
  const p = s.split('.').map(Number);
  const bytes = [40 * p[0] + p[1]];
  for (const v of p.slice(2)) {
    const enc = [v & 0x7f];
    for (let x = v >> 7; x; x >>= 7) enc.unshift((x & 0x7f) | 0x80);
    bytes.push(...enc);
  }
  return tlvDer(0x06, Buffer.from(bytes));
};
const int = b => tlvDer(0x02, b[0] & 0x80 ? Buffer.concat([Buffer.from([0]), b]) : b);
const utc = d => tlvDer(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, '').slice(2, 14) + 'Z'));
const name = cn => seq(tlvDer(0x31, seq(oid('2.5.4.3'), tlvDer(0x0c, Buffer.from(cn)))));

/** A fresh P-256 key and a self-signed certificate for it; `fingerprint` is the SDP form (sha-256, colon hex). */
export function makeCertificate(cn = 'cillvoice') {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const alg = seq(oid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
  const now = Date.now();
  const tbs = seq(
    tlvDer(0xa0, int(Buffer.from([2]))), int(randomBytes(8).fill(0x7f, 0, 1)), alg, name(cn),
    seq(utc(new Date(now - 86400e3)), utc(new Date(now + 365 * 86400e3))), name(cn),
    publicKey.export({ type: 'spki', format: 'der' }),
  );
  const sig = sign('sha256', tbs, privateKey);
  const der = seq(tbs, alg, tlvDer(0x03, Buffer.concat([Buffer.from([0]), sig])));
  return { key: privateKey, der, fingerprint: fingerprintOf(der) };
}
export const fingerprintOf = der => createHash('sha256').update(der).digest('hex').toUpperCase().match(/../g).join(':');

// --- reading helpers ------------------------------------------------------------------------------------------------
class Reader {
  constructor(b) { this.b = b; this.o = 0; }
  u8() { return this.b[this.o++]; }
  u16() { const v = this.b.readUInt16BE(this.o); this.o += 2; return v; }
  u24() { const v = this.b.readUIntBE(this.o, 3); this.o += 3; return v; }
  bytes(n) { if (this.o + n > this.b.length) throw new Error('short'); const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; }
  vec8() { return this.bytes(this.u8()); }
  vec16() { return this.bytes(this.u16()); }
  vec24() { return this.bytes(this.u24()); }
  get left() { return this.b.length - this.o; }
}
const u16 = v => Buffer.from([v >> 8, v & 0xff]);
const u24 = v => Buffer.from([v >> 16, (v >> 8) & 0xff, v & 0xff]);
const vec8 = b => Buffer.concat([Buffer.from([b.length]), b]);
const vec16 = b => Buffer.concat([u16(b.length), b]);
const vec24 = b => Buffer.concat([u24(b.length), b]);
const ext = (type, body) => Buffer.concat([u16(type), vec16(body)]);

/**
 * One DTLS association, server side. `send(datagram)` writes to the peer; `onConnected({profile, localKey, localSalt,
 * remoteKey, remoteSalt})` fires once the handshake succeeded and the peer's certificate matched `remoteFingerprint`.
 */
export class DtlsServer {
  constructor({ cert, remoteFingerprint, send, onConnected, onClose = () => {}, log = () => {} }) {
    Object.assign(this, { cert, remoteFingerprint: remoteFingerprint?.toUpperCase(), send, onConnected, onClose, log });
    this.state = 'hello'; // hello -> keys -> done | closed
    this.writeEpoch = 0;
    this.writeSeq = [0, 0]; // record sequence per epoch
    this.msgSeq = 0; // our next handshake message_seq
    this.nextRecv = 0; // the client's next handshake message_seq
    this.frags = new Map(); // message_seq -> {type, len, body, have}
    this.transcript = [];
    this.flight = null; // records of our last flight, for retransmission
    this.timer = null;
  }

  close(alert = true) {
    if (this.state === 'closed') return;
    if (alert && this.state === 'done') this.sendRecords([this.record(CT.ALERT, Buffer.from([1, 0]))]); // close_notify
    this.state = 'closed';
    clearTimeout(this.timer);
    this.onClose();
  }

  fail(why, description = 40) {
    this.log(`dtls: ${why}`);
    if (this.state !== 'closed') this.sendRecords([this.record(CT.ALERT, Buffer.from([2, description]))]);
    this.state = 'done';
    this.close(false);
  }

  /** Feeds one datagram (it may hold several records). */
  handle(buf) {
    if (this.state === 'closed') return;
    for (let o = 0; o + 13 <= buf.length;) {
      const type = buf[o], epoch = buf.readUInt16BE(o + 3), len = buf.readUInt16BE(o + 11);
      if (o + 13 + len > buf.length) return;
      const header = buf.subarray(o, o + 13);
      let body = buf.subarray(o + 13, o + 13 + len);
      o += 13 + len;
      if (epoch === 1) {
        if (!this.readKey) continue; // epoch 1 before the key exchange: drop
        body = this.decrypt(header, body);
        if (!body) continue;
      } else if (epoch !== 0) continue;
      try {
        if (type === CT.HANDSHAKE) this.onHandshakeRecord(body, epoch);
        else if (type === CT.CCS) this.clientCcs = true;
        else if (type === CT.ALERT && body.length >= 2) {
          if (body[0] === 2 || body[1] === 0) return this.close(false); // fatal or close_notify
        }
      } catch (e) {
        return this.fail(`bad handshake: ${e.message}`, 50);
      }
      if (this.state === 'closed') return;
    }
  }

  onHandshakeRecord(body, epoch) {
    const r = new Reader(body);
    while (r.left >= 12) {
      const type = r.u8(), len = r.u24(), mseq = r.u16(), off = r.u24(), flen = r.u24();
      const frag = r.bytes(flen);
      if (mseq < this.nextRecv) { this.retransmit(); continue; } // the peer missed our flight
      if (mseq > this.nextRecv + 8 || off + flen > len || len > 1 << 16) continue;
      let m = this.frags.get(mseq);
      if (m && (m.type !== type || m.len !== len || m.epoch !== epoch)) continue;
      if (!m) this.frags.set(mseq, (m = { type, len, body: Buffer.alloc(len), have: new Uint8Array(len), epoch }));
      frag.copy(m.body, off);
      m.have.fill(1, off, off + flen);
      // process every complete message in order
      for (let next = this.frags.get(this.nextRecv); next && next.have.every(Boolean); next = this.frags.get(this.nextRecv)) {
        this.frags.delete(this.nextRecv);
        this.nextRecv++;
        this.onMessage(next.type, next.body, next.epoch);
        if (this.state === 'closed') return;
      }
    }
  }

  // the transcript holds each message with an unfragmented header
  hsBytes(type, mseq, body) { return Buffer.concat([Buffer.from([type]), u24(body.length), u16(mseq), u24(0), u24(body.length), body]); }
  hash(extra = []) { return createHash('sha256').update(Buffer.concat([...this.transcript, ...extra])).digest(); }

  onMessage(type, body, epoch) {
    if (this.state === 'done') return;
    const raw = this.hsBytes(type, this.nextRecv - 1, body);
    if (this.state === 'hello' && type === HS.CLIENT_HELLO) {
      this.transcript.push(raw);
      return this.onClientHello(body);
    }
    if (this.state !== 'keys') throw new Error(`unexpected message ${type} in ${this.state}`);
    switch (type) {
      case HS.CERTIFICATE: {
        const r = new Reader(body), list = new Reader(r.vec24());
        if (!list.left) throw new Error('client sent no certificate');
        this.clientCert = list.vec24();
        if (this.remoteFingerprint && fingerprintOf(this.clientCert) !== this.remoteFingerprint) return this.fail('certificate fingerprint does not match the SDP', 42);
        break;
      }
      case HS.CLIENT_KEY_EXCHANGE: {
        const point = new Reader(body).vec8();
        this.transcript.push(raw);
        const pms = this.ecdh.computeSecret(point);
        this.master = this.ems
          ? prf(pms, 'extended master secret', this.hash(), 48)
          : prf(pms, 'master secret', Buffer.concat([this.clientRandom, this.serverRandom]), 48);
        const kb = prf(this.master, 'key expansion', Buffer.concat([this.serverRandom, this.clientRandom]), 40);
        this.readKey = kb.subarray(0, 16); this.writeKey = kb.subarray(16, 32);
        this.readIv = kb.subarray(32, 36); this.writeIv = kb.subarray(36, 40);
        return;
      }
      case HS.CERTIFICATE_VERIFY: {
        if (!this.clientCert) throw new Error('CertificateVerify without a certificate');
        const r = new Reader(body), alg = r.u16(), sig = r.vec16();
        const how = SIG_ALGS[alg];
        if (!how) return this.fail(`unsupported signature algorithm ${alg.toString(16)}`, 47);
        const key = new X509Certificate(this.clientCert).publicKey;
        const opts = how[1] ? { key, padding: how[1], saltLength: 32 } : key;
        if (!verify(how[0], Buffer.concat(this.transcript), opts, sig)) return this.fail('bad CertificateVerify', 51);
        this.verified = true;
        break;
      }
      case HS.FINISHED: {
        if (epoch !== 1 || !this.clientCcs) throw new Error('Finished before ChangeCipherSpec');
        if (!this.verified) return this.fail('no client certificate', 40);
        const want = prf(this.master, 'client finished', this.hash(), 12);
        if (!want.equals(body)) return this.fail('bad client Finished', 51);
        this.transcript.push(raw);
        const fin = prf(this.master, 'server finished', this.hash(), 12);
        this.writeEpoch = 1;
        this.sendFlight([
          { epoch: 0, type: CT.CCS, body: Buffer.from([1]) },
          { epoch: 1, type: CT.HANDSHAKE, body: this.handshake(HS.FINISHED, fin) },
        ], false);
        this.state = 'done';
        const p = this.srtpProfile, keyLen = 16, saltLen = p === 7 ? 12 : 14;
        const km = prf(this.master, 'EXTRACTOR-dtls_srtp', Buffer.concat([this.clientRandom, this.serverRandom]), 2 * (keyLen + saltLen));
        const at = (i, n) => km.subarray(i, i + n);
        return this.onConnected({
          profile: p, remoteKey: at(0, keyLen), localKey: at(keyLen, keyLen),
          remoteSalt: at(2 * keyLen, saltLen), localSalt: at(2 * keyLen + saltLen, saltLen),
        });
      }
      default: throw new Error(`unexpected message ${type}`);
    }
    this.transcript.push(raw);
  }

  onClientHello(body) {
    const r = new Reader(body);
    r.u16(); // client_version
    this.clientRandom = r.bytes(32);
    r.vec8(); // session id
    r.vec8(); // cookie
    const suites = r.vec16();
    r.vec8(); // compression
    const exts = new Map();
    if (r.left) for (const e = new Reader(r.vec16()); e.left;) { const t = e.u16(); exts.set(t, e.vec16()); }
    const suiteList = [];
    for (let i = 0; i < suites.length; i += 2) suiteList.push(suites.readUInt16BE(i));
    if (!suiteList.includes(SUITE)) return this.fail('client offers no TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256', 40);
    const groups = exts.get(EXT.SUPPORTED_GROUPS);
    if (groups && !new Reader(groups).vec16().toString('hex').match(/^(....)*0017/)) return this.fail('client does not offer P-256', 40);
    const srtp = exts.get(EXT.USE_SRTP);
    if (!srtp) return this.fail('client did not offer use_srtp', 40);
    const offered = [];
    for (const l = new Reader(new Reader(srtp).vec16()); l.left;) offered.push(l.u16());
    this.srtpProfile = SRTP_PREFERENCE.find(p => offered.includes(p));
    if (!this.srtpProfile) return this.fail(`no supported SRTP profile in ${offered}`, 40);
    this.ems = exts.has(EXT.EMS);
    const reneg = exts.has(EXT.RENEGOTIATION_INFO) || suiteList.includes(0x00ff);

    this.serverRandom = randomBytes(32);
    this.ecdh = createECDH('prime256v1');
    const pub = this.ecdh.generateKeys();
    const hello = Buffer.concat([
      u16(0xfefd), this.serverRandom, vec8(Buffer.alloc(0)), u16(SUITE), Buffer.from([0]),
      vec16(Buffer.concat([
        ext(EXT.USE_SRTP, Buffer.concat([vec16(u16(this.srtpProfile)), Buffer.from([0])])),
        ...(this.ems ? [ext(EXT.EMS, Buffer.alloc(0))] : []),
        ...(reneg ? [ext(EXT.RENEGOTIATION_INFO, Buffer.from([0]))] : []),
        ext(EXT.EC_POINT_FORMATS, vec8(Buffer.from([0]))),
      ])),
    ]);
    const params = Buffer.concat([Buffer.from([3]), u16(23), vec8(pub)]); // named_curve secp256r1
    const signature = sign('sha256', Buffer.concat([this.clientRandom, this.serverRandom, params]), this.cert.key);
    const ske = Buffer.concat([params, u16(0x0403), vec16(signature)]);
    const certReq = Buffer.concat([
      vec8(Buffer.from([64, 1])), // ecdsa_sign, rsa_sign
      vec16(Buffer.concat(Object.keys(SIG_ALGS).map(a => u16(Number(a))))),
      vec16(Buffer.alloc(0)),
    ]);
    this.sendFlight([
      [HS.SERVER_HELLO, hello], [HS.CERTIFICATE, vec24(vec24(this.cert.der))], [HS.SERVER_KEY_EXCHANGE, ske],
      [HS.CERTIFICATE_REQUEST, certReq], [HS.SERVER_HELLO_DONE, Buffer.alloc(0)],
    ].map(([t, b]) => ({ epoch: 0, type: CT.HANDSHAKE, body: this.handshake(t, b) })), true);
    this.state = 'keys';
  }

  /** One handshake message (unfragmented), added to the transcript; fragmented later in sendFlight if needed. */
  handshake(type, body) {
    const m = { type, mseq: this.msgSeq++, body };
    this.transcript.push(this.hsBytes(type, m.mseq, body));
    return m;
  }

  // records for a message, split into fragments that fit the MTU
  fragments(m) {
    const out = [];
    const max = MTU - 13 - 12 - 24;
    for (let off = 0; off === 0 || off < m.body.length; off += max) {
      const f = m.body.subarray(off, off + max);
      out.push(Buffer.concat([Buffer.from([m.type]), u24(m.body.length), u16(m.mseq), u24(off), u24(f.length), f]));
      if (!m.body.length) break;
    }
    return out;
  }

  sendFlight(items, timer) {
    this.flight = items;
    this.retries = 0;
    this.transmit();
    clearTimeout(this.timer);
    if (timer) this.arm(1000);
  }
  arm(ms) {
    this.timer = setTimeout(() => {
      if (this.state !== 'keys' || this.retries++ >= 6) return;
      this.transmit();
      this.arm(Math.min(ms * 2, 8000));
    }, ms);
    this.timer.unref?.();
  }
  // a repeated peer flight means ours was lost: send it again, at most every 250 ms
  retransmit() {
    if (!this.flight || Date.now() - (this.lastSent ?? 0) < 250) return;
    this.transmit();
  }
  transmit() {
    this.lastSent = Date.now();
    const records = [];
    for (const it of this.flight) {
      const bodies = it.type === CT.HANDSHAKE ? this.fragments(it.body) : [it.body];
      for (const b of bodies) records.push(this.record(it.type, b, it.epoch));
    }
    this.sendRecords(records);
  }
  sendRecords(records) {
    let dgram = [];
    let size = 0;
    for (const rec of records) {
      if (size + rec.length > MTU && dgram.length) { this.send(Buffer.concat(dgram)); dgram = []; size = 0; }
      dgram.push(rec);
      size += rec.length;
    }
    if (dgram.length) this.send(Buffer.concat(dgram));
  }

  record(type, body, epoch = this.writeEpoch) {
    const seqNo = this.writeSeq[epoch]++;
    const header = Buffer.alloc(13);
    header[0] = type;
    header.writeUInt16BE(0xfefd, 1);
    header.writeUInt16BE(epoch, 3);
    header.writeUIntBE(seqNo, 5, 6);
    if (epoch === 0) {
      header.writeUInt16BE(body.length, 11);
      return Buffer.concat([header, body]);
    }
    const explicit = header.subarray(3, 11);
    const c = createCipheriv('aes-128-gcm', this.writeKey, Buffer.concat([this.writeIv, explicit]));
    const aad = Buffer.concat([explicit, Buffer.from([type]), u16(0xfefd), u16(body.length)]);
    c.setAAD(aad);
    const enc = Buffer.concat([explicit, c.update(body), c.final(), c.getAuthTag()]);
    header.writeUInt16BE(enc.length, 11);
    return Buffer.concat([header, enc]);
  }

  decrypt(header, body) {
    if (body.length < 8 + 16) return null;
    const explicit = body.subarray(0, 8);
    const plainLen = body.length - 24;
    try {
      const d = createDecipheriv('aes-128-gcm', this.readKey, Buffer.concat([this.readIv, explicit]));
      d.setAAD(Buffer.concat([header.subarray(3, 11), Buffer.from([header[0]]), header.subarray(1, 3), u16(plainLen)]));
      d.setAuthTag(body.subarray(body.length - 16));
      return Buffer.concat([d.update(body.subarray(8, body.length - 16)), d.final()]);
    } catch { return null; }
  }
}
