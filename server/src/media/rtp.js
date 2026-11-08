// RTP/RTCP packet handling for the SFU (RFC 3550, RFC 4585, RFC 5104, RFC 8285 header extensions, draft-alvestrand
// REMB, draft-holmer transport-wide congestion control feedback), and the VP8/H.264/AV1 bits needed for keyframes.

/** Parsed RTP header; `ext` maps extension id -> value (one-byte and two-byte forms). Null when malformed. */
export function parseRtp(b) {
  if (b.length < 12 || b[0] >> 6 !== 2) return null;
  const cc = b[0] & 0x0f;
  let o = 12 + cc * 4;
  const ext = new Map();
  if (b[0] & 0x10) {
    if (b.length < o + 4) return null;
    const profile = b.readUInt16BE(o), len = b.readUInt16BE(o + 2) * 4;
    const end = o + 4 + len;
    if (end > b.length) return null;
    for (let i = o + 4; i < end;) {
      if (profile === 0xbede) {
        if (b[i] === 0) { i++; continue; }
        const id = b[i] >> 4, l = (b[i] & 0x0f) + 1;
        if (id === 15) break;
        if (i + 1 + l > end) return null;
        ext.set(id, b.subarray(i + 1, i + 1 + l));
        i += 1 + l;
      } else if ((profile & 0xfff0) === 0x1000) {
        if (b[i] === 0) { i++; continue; }
        if (i + 1 >= end) return null;
        const id = b[i], l = b[i + 1];
        if (i + 2 + l > end) return null;
        ext.set(id, b.subarray(i + 2, i + 2 + l));
        i += 2 + l;
      } else break;
    }
    o = end;
  }
  let end = b.length;
  if (b[0] & 0x20) end -= b[b.length - 1];
  if (end < o) return null;
  return {
    marker: !!(b[1] & 0x80), pt: b[1] & 0x7f, seq: b.readUInt16BE(2), ts: b.readUInt32BE(4), ssrc: b.readUInt32BE(8),
    ext, payload: b.subarray(o, end), padding: b.length - end,
  };
}

/** Writes an RTP packet (no CSRCs) with the given one-byte or two-byte extensions ([id, Buffer][]) and payload. */
export function buildRtp({ marker, pt, seq, ts, ssrc }, exts, payload) {
  let extTotal = 0, twoByte = false, bodyLen = 0, padLen = 0;
  if (exts.length) {
    for (let i = 0; i < exts.length; i++) {
      const [id, v] = exts[i];
      if (id > 14 || v.length > 16 || !v.length) { twoByte = true; break; }
    }
    for (let i = 0; i < exts.length; i++) bodyLen += (twoByte ? 2 : 1) + exts[i][1].length;
    padLen = (4 - (bodyLen & 3)) & 3;
    extTotal = 4 + bodyLen + padLen;
  }
  const out = Buffer.allocUnsafe(12 + extTotal + payload.length);
  out[0] = 0x80 | (extTotal ? 0x10 : 0);
  out[1] = (marker ? 0x80 : 0) | pt;
  out.writeUInt16BE(seq & 0xffff, 2);
  out.writeUInt32BE(ts >>> 0, 4);
  out.writeUInt32BE(ssrc >>> 0, 8);
  let o = 12;
  if (extTotal) {
    out.writeUInt16BE(twoByte ? 0x1000 : 0xbede, o);
    out.writeUInt16BE((bodyLen + padLen) >> 2, o + 2);
    o += 4;
    for (let i = 0; i < exts.length; i++) {
      const [id, v] = exts[i];
      if (twoByte) { out[o++] = id; out[o++] = v.length; }
      else out[o++] = (id << 4) | (v.length - 1);
      v.copy(out, o);
      o += v.length;
    }
    for (let i = 0; i < padLen; i++) out[o++] = 0;
  }
  payload.copy(out, o);
  return out;
}

export const isRtcp = b => b.length >= 8 && b[1] >= 192 && b[1] <= 223;

/** Splits a compound RTCP packet: [{pt, fmt, ssrc, body (after the 8-byte header), raw}]. */
export function parseRtcp(b) {
  const out = [];
  for (let o = 0; o + 4 <= b.length;) {
    const len = (b.readUInt16BE(o + 2) + 1) * 4;
    if (o + len > b.length || len < 8 || b[o] >> 6 !== 2) break;
    const raw = b.subarray(o, o + len);
    out.push({ pt: b[o + 1], fmt: b[o] & 0x1f, ssrc: raw.readUInt32BE(4), body: raw.subarray(8), raw });
    o += len;
  }
  return out;
}

function rtcpHeader(fmt, pt, ssrc, bodyLen) {
  const h = Buffer.alloc(8);
  h[0] = 0x80 | fmt;
  h[1] = pt;
  h.writeUInt16BE((8 + bodyLen) / 4 - 1, 2);
  h.writeUInt32BE(ssrc >>> 0, 4);
  return h;
}

/** Generic NACK (RFC 4585 6.2.1) for a list of lost sequence numbers. */
export function buildNack(senderSsrc, mediaSsrc, seqs) {
  const sorted = [...new Set(seqs)].sort((a, b) => ((a - b + 0x8000) & 0xffff) - 0x8000);
  const items = [];
  for (const s of sorted) {
    const last = items.at(-1);
    const d = last ? (s - last.pid) & 0xffff : 0;
    if (last && d >= 1 && d <= 16) last.blp |= 1 << (d - 1);
    else items.push({ pid: s, blp: 0 });
  }
  const body = Buffer.alloc(4 + items.length * 4);
  body.writeUInt32BE(mediaSsrc >>> 0, 0);
  items.forEach((it, i) => { body.writeUInt16BE(it.pid, 4 + i * 4); body.writeUInt16BE(it.blp, 6 + i * 4); });
  return Buffer.concat([rtcpHeader(1, 205, senderSsrc, body.length), body]);
}
/** Sequence numbers a NACK body (after the 8-byte header) asks for. */
export function parseNack(body) {
  const seqs = [];
  for (let o = 4; o + 4 <= body.length; o += 4) {
    const pid = body.readUInt16BE(o), blp = body.readUInt16BE(o + 2);
    seqs.push(pid);
    for (let i = 0; i < 16; i++) if (blp & (1 << i)) seqs.push((pid + i + 1) & 0xffff);
  }
  return seqs;
}

export function buildPli(senderSsrc, mediaSsrc) {
  const body = Buffer.alloc(4);
  body.writeUInt32BE(mediaSsrc >>> 0);
  return Buffer.concat([rtcpHeader(1, 206, senderSsrc, 4), body]);
}

/** REMB (draft-alvestrand-rmcat-remb): {bitrate, ssrcs} or null. */
export function parseRemb(body) {
  if (body.length < 12 || body.toString('latin1', 4, 8) !== 'REMB') return null;
  const n = body[8], exp = body[9] >> 2, mantissa = ((body[9] & 3) << 16) | body.readUInt16BE(10);
  const ssrcs = [];
  for (let i = 0; i < n && 12 + i * 4 + 4 <= body.length; i++) ssrcs.push(body.readUInt32BE(12 + i * 4));
  return { bitrate: mantissa * 2 ** exp, ssrcs };
}
export function buildRemb(senderSsrc, bitrate, ssrcs) {
  let exp = 0, m = Math.round(bitrate);
  while (m > 0x3ffff) { m = Math.floor(m / 2); exp++; }
  const body = Buffer.alloc(12 + ssrcs.length * 4);
  body.write('REMB', 4, 'latin1');
  body[8] = ssrcs.length;
  body[9] = (exp << 2) | (m >> 16);
  body.writeUInt16BE(m & 0xffff, 10);
  ssrcs.forEach((s, i) => body.writeUInt32BE(s >>> 0, 12 + i * 4));
  return Buffer.concat([rtcpHeader(15, 206, senderSsrc, body.length), body]);
}

/** NTP timestamp of a millisecond clock value: [seconds, fraction]. */
export function ntp(ms = Date.now()) {
  const secs = Math.floor(ms / 1000) + 2208988800;
  return [secs >>> 0, Math.floor(((ms % 1000) / 1000) * 2 ** 32) >>> 0];
}

/** Sender report for a stream we send (no report blocks). */
export function buildSr(ssrc, ntpTime, rtpTs, packets, octets) {
  const body = Buffer.alloc(20);
  body.writeUInt32BE(ntpTime[0], 0);
  body.writeUInt32BE(ntpTime[1], 4);
  body.writeUInt32BE(rtpTs >>> 0, 8);
  body.writeUInt32BE(packets >>> 0, 12);
  body.writeUInt32BE(octets >>> 0, 16);
  return Buffer.concat([rtcpHeader(0, 200, ssrc, 20), body]);
}

/** Receiver report with one block per stream: [{ssrc, fractionLost, lost, highest, jitter, lsr, dlsr}]. */
export function buildRr(senderSsrc, blocks) {
  const body = Buffer.alloc(blocks.length * 24);
  blocks.forEach((b, i) => {
    const o = i * 24;
    body.writeUInt32BE(b.ssrc >>> 0, o);
    body[o + 4] = b.fractionLost;
    body.writeIntBE(Math.max(-0x800000, Math.min(0x7fffff, b.lost)), o + 5, 3);
    body.writeUInt32BE(b.highest >>> 0, o + 8);
    body.writeUInt32BE(b.jitter >>> 0, o + 12);
    body.writeUInt32BE(b.lsr >>> 0, o + 16);
    body.writeUInt32BE(b.dlsr >>> 0, o + 20);
  });
  return Buffer.concat([rtcpHeader(blocks.length, 201, senderSsrc, body.length), body]);
}
/** Report blocks of an SR or RR body. */
export function parseReportBlocks(pt, count, body) {
  const out = [];
  for (let i = 0, o = pt === 200 ? 20 : 0; i < count && o + 24 <= body.length; i++, o += 24) {
    out.push({ ssrc: body.readUInt32BE(o), fractionLost: body[o + 4], lost: body.readIntBE(o + 5, 3), highest: body.readUInt32BE(o + 8), jitter: body.readUInt32BE(o + 12), lsr: body.readUInt32BE(o + 16), dlsr: body.readUInt32BE(o + 20) });
  }
  return out;
}

/** Per incoming stream statistics for receiver reports (RFC 3550 appendix A.3 and A.8). */
export class ReceiveStats {
  constructor(clockRate) { Object.assign(this, { clockRate, base: -1, maxSeq: 0, cycles: 0, received: 0, expectedPrior: 0, receivedPrior: 0, jitter: 0, transit: null, lsr: 0, srAt: 0 }); }
  add(seq, ts, arrivalMs) {
    if (this.base < 0) { this.base = seq; this.maxSeq = seq; }
    else {
      const d = (seq - this.maxSeq) & 0xffff;
      if (d > 0 && d < 0x8000) { if (seq < this.maxSeq) this.cycles += 0x10000; this.maxSeq = seq; }
    }
    this.received++;
    const transit = (arrivalMs * this.clockRate) / 1000 - ts;
    if (this.transit !== null) {
      let d = Math.abs(transit - this.transit);
      if (d > 2 ** 31) d = Math.abs(d - 2 ** 32);
      this.jitter += (d - this.jitter) / 16;
    }
    this.transit = transit;
  }
  onSr(ntpSec, ntpFrac, nowMs) { this.lsr = (((ntpSec & 0xffff) << 16) | (ntpFrac >>> 16)) >>> 0; this.srAt = nowMs; }
  block(ssrc, nowMs) {
    const highest = this.cycles + this.maxSeq;
    const expected = highest - this.base + 1;
    const lost = expected - this.received;
    const expInt = expected - this.expectedPrior, recvInt = this.received - this.receivedPrior;
    this.expectedPrior = expected;
    this.receivedPrior = this.received;
    const lostInt = expInt - recvInt;
    return {
      ssrc, fractionLost: expInt <= 0 || lostInt <= 0 ? 0 : Math.min(255, Math.floor((lostInt << 8) / expInt)), lost, highest,
      jitter: Math.round(this.jitter), lsr: this.lsr, dlsr: this.srAt ? Math.round(((nowMs - this.srAt) / 1000) * 65536) : 0,
    };
  }
}

/**
 * Transport-wide congestion control feedback (draft-holmer-rmcat-transport-wide-cc-extensions-01 section 3.1).
 * `arrivals` is [[transportSeq, arrivalMs]] sorted by unwrapped sequence; written with two-bit status vector chunks.
 */
export function buildTwcc(senderSsrc, mediaSsrc, baseSeq, arrivals, fbCount) {
  const bySeq = new Map(arrivals.map(([s, t]) => [s, t]));
  const last = arrivals.at(-1)[0];
  const count = last - baseSeq + 1;
  const ref = Math.floor(arrivals[0][1] / 64); // reference time in 64 ms units
  let prev = ref * 64;
  const symbols = [], deltas = [];
  for (let s = baseSeq; s <= last; s++) {
    const t = bySeq.get(s);
    if (t === undefined) { symbols.push(0); continue; }
    const d = Math.round((t - prev) * 4); // 250 us units
    prev += d / 4;
    if (d >= 0 && d <= 255) { symbols.push(1); deltas.push(Buffer.from([d])); }
    else { const b = Buffer.alloc(2); b.writeInt16BE(Math.max(-32768, Math.min(32767, d))); symbols.push(2); deltas.push(b); }
  }
  const chunks = [];
  for (let i = 0; i < symbols.length; i += 7) {
    let c = 0xc000;
    for (let j = 0; j < 7; j++) c |= (symbols[i + j] ?? 0) << (12 - 2 * j);
    chunks.push(c);
  }
  const head = Buffer.alloc(12);
  head.writeUInt32BE(mediaSsrc >>> 0, 0);
  head.writeUInt16BE(baseSeq & 0xffff, 4);
  head.writeUInt16BE(count, 6);
  head.writeUIntBE(ref & 0xffffff, 8, 3); // arrival times come from a monotonic clock, so this stays positive
  head[11] = fbCount & 0xff;
  const chunkBuf = Buffer.alloc(chunks.length * 2);
  chunks.forEach((c, i) => chunkBuf.writeUInt16BE(c, i * 2));
  let body = Buffer.concat([head, chunkBuf, ...deltas]);
  body = Buffer.concat([body, Buffer.alloc((4 - (body.length % 4)) % 4)]);
  return Buffer.concat([rtcpHeader(15, 205, senderSsrc, body.length), body]);
}

// --- codecs ---------------------------------------------------------------------------------------------------------

/** VP8 payload descriptor (RFC 7741): offsets of picture id / TL0PICIDX and whether this packet starts a keyframe. */
export function vp8Info(p) {
  if (p.length < 1) return null;
  let o = 1;
  const x = p[0] & 0x80, start = !!(p[0] & 0x10) && (p[0] & 0x07) === 0;
  const info = { start, pidAt: -1, pidLong: false, tl0At: -1 };
  if (x) {
    if (p.length < 2) return null;
    const i = p[1] & 0x80, l = p[1] & 0x40, t = p[1] & 0x20, k = p[1] & 0x10;
    o = 2;
    if (i) { info.pidAt = o; info.pidLong = !!(p[o] & 0x80); o += info.pidLong ? 2 : 1; }
    if (l) { info.tl0At = o; o++; }
    if (t || k) o++;
  }
  if (o >= p.length) return null;
  info.keyframe = start && !(p[o] & 0x01);
  return info;
}
export const vp8PictureId = (p, info) => (info.pidLong ? p.readUInt16BE(info.pidAt) & 0x7fff : p[info.pidAt] & 0x7f);
export function setVp8PictureId(p, info, v) {
  if (info.pidLong) p.writeUInt16BE(0x8000 | (v & 0x7fff), info.pidAt);
  else p[info.pidAt] = v & 0x7f;
}

/** True when an H.264 RTP payload (RFC 6184) starts a keyframe: SPS or IDR, alone, in a STAP-A or a starting FU-A. */
export function h264Keyframe(p) {
  if (!p.length) return false;
  const type = p[0] & 0x1f;
  if (type === 5 || type === 7) return true;
  if (type === 24) {
    for (let o = 1; o + 2 < p.length;) {
      const len = p.readUInt16BE(o);
      const t = p[o + 2] & 0x1f;
      if (t === 5 || t === 7) return true;
      o += 2 + len;
    }
    return false;
  }
  if (type === 28 && p.length > 1) return !!(p[1] & 0x80) && [5, 7].includes(p[1] & 0x1f);
  return false;
}

/**
 * True when an AV1 RTP payload (AOM "RTP Payload Format for AV1", 4.4) starts a keyframe. The first byte is the
 * aggregation header Z|Y|W W|N|- - -; N=1 marks the first packet of a new coded video sequence, which the sender sets
 * on the first packet of every keyframe (libwebrtc: when it starts with a sequence header).
 */
export const av1Keyframe = p => p.length > 0 && !!(p[0] & 0x08);
