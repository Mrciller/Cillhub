// One UDP socket for every peer (RFC 7983 demultiplexing) and the per-peer transport on top of it:
// ICE-lite (RFC 8445) answers, DTLS 1.2 handshake, then SRTP/SRTCP in both directions.
import dgram from 'node:dgram';
import { randomBytes } from 'node:crypto';
import { handleBinding, plainBinding } from './stun.js';
import { DtlsServer, makeCertificate } from './dtls.js';
import { SrtpContext } from './srtp.js';

const DEBUG = !!process.env.CILLVOICE_DEBUG;
// tests only: this fraction of the RTP we send is dropped, to exercise NACK and the bandwidth logic (see README)
const TEST_DROP = Math.min(0.5, Number(process.env.CILLVOICE_TEST_DROP) || 0);
const CONSENT_TIMEOUT = 30_000; // RFC 7675: no binding request for this long ends the transport

export class MediaSocket {
  // bindIp: answers must leave from the address the browser sent to, so a loopback public IP binds to loopback
  constructor({ port, ip, bindIp = ip.startsWith('127.') ? ip : '0.0.0.0', log = console.error }) {
    Object.assign(this, { port, ip, bindIp, log });
    this.cert = makeCertificate();
    this.byUfrag = new Map();
    this.byAddress = new Map();
    this.stats = { in: 0, out: 0, bytesIn: 0, bytesOut: 0, dropped: 0 };
  }

  start() {
    if (this.sock) return this.ready;
    this.sock = dgram.createSocket({ type: 'udp4', recvBufferSize: 4 << 20, sendBufferSize: 4 << 20 });
    this.sock.on('message', (m, r) => this.onMessage(m, r));
    this.sock.on('error', e => this.log(`cillvoice UDP: ${e.message}`));
    this.ready = new Promise((res, rej) => {
      this.sock.once('error', rej);
      this.sock.bind(this.port, this.bindIp, () => res());
    });
    this.sweep = setInterval(() => {
      const now = Date.now();
      for (const t of this.byUfrag.values()) if (now - t.lastStun > CONSENT_TIMEOUT) t.close('ICE consent expired');
    }, 5000);
    this.sweep.unref();
    return this.ready;
  }

  stop() {
    clearInterval(this.sweep);
    for (const t of [...this.byUfrag.values()]) t.close('server stopping');
    this.sock?.close();
    this.sock = null;
  }

  send(buf, addr) {
    if (!this.sock || !addr) return;
    this.stats.out++;
    this.stats.bytesOut += buf.length;
    this.sock.send(buf, addr.port, addr.address);
  }

  onMessage(buf, rinfo) {
    this.stats.in++;
    this.stats.bytesIn += buf.length;
    const b = buf[0];
    if (b < 4) {
      // v7 voice self-check: for a minute after an admin asks, answer credential-less Binding requests like a STUN server
      const probe = this.probeUntil > Date.now() && plainBinding(buf, rinfo);
      if (probe) return void this.sock.send(probe, rinfo.port, rinfo.address);
      const res = handleBinding(buf, rinfo, ufrag => {
        const t = this.byUfrag.get(ufrag);
        return t && { pwd: t.pwd, remoteUfrag: t.remoteUfrag };
      });
      if (DEBUG) this.log(`cillvoice stun from ${rinfo.address}:${rinfo.port}: ${res ? (res.localUfrag ? 'ok' : 'refused') : 'dropped'}`);
      if (!res) return;
      this.sock.send(res.response, rinfo.port, rinfo.address);
      const t = res.localUfrag && this.byUfrag.get(res.localUfrag);
      if (t) t.onBinding(rinfo, res.useCandidate);
      return;
    }
    const t = this.byAddress.get(`${rinfo.address}:${rinfo.port}`);
    if (!t) return void this.stats.dropped++;
    if (b >= 20 && b <= 63) t.onDtls(buf, rinfo);
    else if (b >= 128 && b <= 191) {
      if (buf.length >= 2 && buf[1] >= 192 && buf[1] <= 223) t.onSrtcp(buf);
      else t.onSrtp(buf);
    }
  }
}

/** A peer's transport. Callbacks: onConnected(), onRtp(plainPacket), onRtcp(plainCompound), onClose(reason). */
export class Transport {
  constructor(sock, { remoteUfrag, remoteFingerprint, onConnected, onRtp, onRtcp, onClose }) {
    Object.assign(this, { sock, remoteUfrag, remoteFingerprint, onConnected, onRtp, onRtcp, onClose });
    this.ufrag = randomBytes(4).toString('hex'); // ice-chars are ALPHA / DIGIT / + / /
    this.pwd = randomBytes(16).toString('hex');
    this.addresses = new Set();
    this.addr = null;
    this.lastStun = Date.now();
    this.connected = false;
    sock.byUfrag.set(this.ufrag, this);
  }

  onBinding(rinfo, nominated) {
    this.lastStun = Date.now();
    const key = `${rinfo.address}:${rinfo.port}`;
    if (!this.addresses.has(key)) {
      this.addresses.add(key);
      this.sock.byAddress.get(key)?.forget(key); // the address moved to this peer
      this.sock.byAddress.set(key, this);
    }
    if (nominated || !this.addr) this.addr = { address: rinfo.address, port: rinfo.port };
  }
  forget(key) { this.addresses.delete(key); }

  onDtls(buf, rinfo) {
    this.dtls ??= new DtlsServer({
      cert: this.sock.cert, remoteFingerprint: this.remoteFingerprint,
      send: b => this.sock.send(b, this.addr ?? rinfo),
      log: m => this.sock.log(`cillvoice ${m}`),
      onConnected: k => {
        this.srtpIn = new SrtpContext(k.profile, k.remoteKey, k.remoteSalt);
        this.srtpOut = new SrtpContext(k.profile, k.localKey, k.localSalt);
        this.connected = true;
        this.onConnected?.();
      },
      onClose: () => this.close('DTLS closed'),
    });
    this.dtls.handle(buf);
  }

  onSrtp(buf) {
    if (!this.srtpIn) return;
    const p = this.srtpIn.unprotectRtp(buf);
    if (p) this.onRtp(p);
    else this.sock.stats.dropped++;
  }
  onSrtcp(buf) {
    if (!this.srtpIn) return;
    const p = this.srtpIn.unprotectRtcp(buf);
    if (p) this.onRtcp(p);
    else this.sock.stats.dropped++;
  }

  sendRtp(plain) {
    if (!this.srtpOut || !this.addr) return;
    const out = this.srtpOut.protectRtp(plain);
    if (!TEST_DROP || Math.random() >= TEST_DROP) this.sock.send(out, this.addr);
  }
  sendRtcp(plain) { if (this.srtpOut && this.addr) this.sock.send(this.srtpOut.protectRtcp(plain), this.addr); }

  close(reason) {
    if (this.closed) return;
    this.closed = true;
    this.dtls?.close();
    this.sock.byUfrag.delete(this.ufrag);
    for (const k of this.addresses) if (this.sock.byAddress.get(k) === this) this.sock.byAddress.delete(k);
    this.onClose?.(reason);
  }
}
