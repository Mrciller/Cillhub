// cillvoice SFU: a room per voice channel or call, one browser PeerConnection per participant (BUNDLE, rtcp-mux).
// The browser always sends the offer (its own send transceivers plus one receive transceiver per remote track it
// wants); the server answers. Media is forwarded with per-subscriber SSRC, sequence number, timestamp and VP8
// picture-id rewriting, one simulcast layer per subscriber chosen from its REMB estimate and switched on keyframes.
import { randomInt } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Transport } from './transport.js';
import { parseOffer, pickCodecs, codecKey, buildAnswer, EXT_URI } from './sdp.js';
import {
  parseRtp, buildRtp, parseRtcp, buildNack, parseNack, buildPli, parseRemb, buildSr, buildRr, buildTwcc, ReceiveStats,
  vp8Info, vp8PictureId, setVp8PictureId, h264Keyframe, av1Keyframe,
} from './rtp.js';

export const SOURCES = { microphone: 'audio', screen_share_audio: 'audio', camera: 'video', screen_share: 'video' };
// video codecs a publisher may prefer over VP8, which every browser decodes; one a room member cannot decode is left out (Room.blocked)
const OPTIONAL_CODECS = ['av1', 'h264'];
const SPEAK_LEVEL = 45; // ssrc-audio-level is -dBov; 45 means louder than -45 dBov
const SPEAK_WINDOW = 600, SPEAK_HITS = 6; // ms, loud packets within the window (Opus sends one per 20 ms)
const BUFFER = 512; // retransmission buffer per video downstream, in packets
const DEFAULT_BUDGET = 2_500_000; // bit/s per subscriber until its first REMB arrives
const rand32 = () => randomInt(1, 2 ** 32 - 1);
const now = () => performance.now();

const MAX_SSRCS = 32; // per participant: 4 sources x 3 simulcast layers x RTX fits

class Meter { // bytes over a sliding 2 s window, in 250 ms buckets
  constructor() { this.buckets = new Float64Array(8); this.at = 0; }
  roll(t) {
    const slot = Math.floor(t / 250);
    if (slot - this.at >= 8) this.buckets.fill(0);
    else for (let s = this.at + 1; s <= slot; s++) this.buckets[s % 8] = 0;
    if (slot > this.at) this.at = slot;
    return slot;
  }
  add(n, t = now()) { this.buckets[this.roll(t) % 8] += n; }
  bps(t = now()) { this.roll(t); return (this.buckets.reduce((a, b) => a + b, 0) * 8) / 2; }
}

/** A published track: a microphone, camera, screen share or screen share audio, with its simulcast layers. */
class Track {
  constructor(owner, mid, source, rids) {
    Object.assign(this, { owner, mid, source, kind: SOURCES[source], rids });
    this.id = `${owner.userId}-${mid}`;
    this.layers = new Map(); // rid ('' without simulcast) -> layer
    this.downstreams = new Set();
    this.loud = []; // arrival times of loud audio packets
    this.codec = null;
  }
  get allowed() { return this.owner.sources.has(this.source); }
  get clock() { return this.kind === 'audio' ? 48 : 90; } // ticks per ms

  layer(rid, ssrc) {
    let l = this.layers.get(rid);
    if (!l) this.layers.set(rid, (l = { rid, rank: Math.max(0, this.rids.indexOf(rid)), meter: new Meter(), nacked: new Map(), pliAt: 0 }));
    if (l.ssrc !== ssrc) Object.assign(l, { ssrc, stats: new ReceiveStats(this.clock * 1000), sr: null });
    return l;
  }
  active(t = now()) { return [...this.layers.values()].filter(l => t - (l.lastAt ?? -1e9) < 1500).sort((a, b) => a.rank - b.rank); }

  onPacket(p, rid, size) {
    const t = now();
    const l = this.layer(rid, p.ssrc);
    l.stats.add(p.seq, p.ts, t);
    l.meter.add(size, t);
    l.lastAt = t;
    const codec = this.owner.mids.get(this.mid)?.codecs.find(c => c.pt === p.pt);
    if (!codec || !this.allowed) return;
    this.codec = codecKey(codec);
    let vp8 = null, key = false;
    if (this.kind === 'video' && p.payload.length) {
      if (codec.name === 'vp8') { vp8 = vp8Info(p.payload); key = !!vp8?.keyframe; }
      else key = codec.name === 'av1' ? av1Keyframe(p.payload) : h264Keyframe(p.payload);
    }
    if (this.source === 'microphone') {
      const lv = p.ext.get(this.owner.extIds.audioLevel);
      if (lv && (lv[0] & 0x7f) <= SPEAK_LEVEL) this.loud.push(t);
    }
    if (!this.downstreams.size) return;
    const absTime = Math.round(((Date.now() % 64000) / 1000) * 2 ** 18) & 0xffffff;
    for (const ds of this.downstreams) ds.forward(p, l, key, vp8, t, absTime);
  }

  requestKeyframe(rid, force = false) {
    const l = this.layers.get(rid);
    if (!l || this.kind !== 'video') return;
    const t = now();
    if (!force && t - l.pliAt < 500) return;
    l.pliAt = t;
    this.owner.sendRtcp(buildPli(this.owner.rtcpSsrc, l.ssrc));
  }

  nackPublisher(l, seqs) {
    const t = now();
    const fresh = seqs.filter(s => t - (l.nacked.get(s) ?? -1e9) > 100);
    if (!fresh.length) return;
    for (const s of fresh) l.nacked.set(s, t);
    if (l.nacked.size > 2048) for (const [s, at] of l.nacked) if (t - at > 1000) l.nacked.delete(s);
    this.owner.sendRtcp(buildNack(this.owner.rtcpSsrc, l.ssrc, fresh));
  }

  speaking(t = now()) {
    while (this.loud.length && t - this.loud[0] > SPEAK_WINDOW) this.loud.shift();
    return this.allowed && this.loud.length >= SPEAK_HITS;
  }
}

/** One track forwarded to one subscriber on one of its receive transceivers. */
export class Downstream {
  constructor(sub, mid, track) {
    Object.assign(this, { sub, mid, track });
    this.midBuf = Buffer.from(String(mid));
    this.absBuf = Buffer.allocUnsafe(3);
    this.ssrc = rand32();
    this.current = null; // rid being forwarded
    this.target = null; // rid wanted (video), switched to on its next keyframe
    this.sync = true;
    this.lastSeq = randomInt(0, 0xffff);
    this.lastTs = rand32();
    this.lastSendAt = null;
    this.lastPid = randomInt(0, 0x7fff);
    this.lastTl0 = randomInt(0, 0xff);
    this.packets = 0;
    this.octets = 0;
    this.meter = new Meter();
    this.buffer = track.kind === 'video' ? new Array(BUFFER) : null;
    this.fractionLost = 0;
  }

  forward(p, l, key, vp8, t, absTime) {
    if (this.sub.deaf && this.track.kind === 'audio') return;
    if (this.track.kind === 'video') {
      if (this.target === l.rid && this.current !== l.rid && key) { this.current = l.rid; this.sync = true; }
      if (l.rid !== this.current) return;
    } else if (this.current !== l.rid) { this.current = l.rid; this.sync = true; }
    const pt = this.sub.ptFor(this.mid, this.track.codec);
    if (pt === undefined) return;
    if (this.sync) {
      // continue our own sequence and timeline from where the previous layer (or nothing) left off
      this.seqOffset = (this.lastSeq + 1 - p.seq) & 0xffff;
      const gap = this.lastSendAt === null ? 0 : Math.max(1, Math.round((t - this.lastSendAt) * this.track.clock));
      this.tsOffset = (this.lastTs + gap - p.ts + 2 ** 32) % 2 ** 32;
      if (vp8?.pidAt >= 0) this.pidOffset = (this.lastPid + 1 - vp8PictureId(p.payload, vp8)) & 0x7fff;
      if (vp8?.tl0At >= 0) this.tl0Offset = (this.lastTl0 + 1 - p.payload[vp8.tl0At]) & 0xff;
      this.switchSeq = p.seq;
      this.sync = false;
    } else if (((p.seq - this.switchSeq) & 0xffff) >= 0x8000) return; // from before the switch
    const seq = (p.seq + this.seqOffset) & 0xffff;
    const ts = (p.ts + this.tsOffset) % 2 ** 32;
    let payload = p.payload;
    if (vp8 && (vp8.pidAt >= 0 || vp8.tl0At >= 0)) {
      payload = Buffer.from(payload);
      if (vp8.pidAt >= 0) {
        const pid = (vp8PictureId(payload, vp8) + (this.pidOffset ?? 0)) & 0x7fff;
        setVp8PictureId(payload, vp8, pid);
        if (vp8.pidLong) this.lastPid = pid;
      }
      if (vp8.tl0At >= 0) payload[vp8.tl0At] = this.lastTl0 = (payload[vp8.tl0At] + (this.tl0Offset ?? 0)) & 0xff;
    }
    const newer = ((seq - this.lastSeq) & 0xffff) < 0x8000;
    if (newer) { this.lastSeq = seq; this.lastTs = ts; this.lastSendAt = t; }
    const ids = this.sub.extIds;
    const exts = [];
    if (ids.mid) exts.push([ids.mid, this.midBuf]);
    const level = this.track.kind === 'audio' && p.ext.get(this.track.owner.extIds.audioLevel);
    if (level && ids.audioLevel) exts.push([ids.audioLevel, level]);
    if (ids.absSendTime) {
      const v = absTime ?? (Math.round(((Date.now() % 64000) / 1000) * 2 ** 18) & 0xffffff);
      this.absBuf[0] = v >> 16;
      this.absBuf[1] = (v >> 8) & 0xff;
      this.absBuf[2] = v & 0xff;
      exts.push([ids.absSendTime, this.absBuf]);
    }
    const pkt = buildRtp({ marker: p.marker, pt, seq, ts, ssrc: this.ssrc }, exts, payload);
    if (this.buffer) this.buffer[seq % BUFFER] = { seq, pkt };
    this.packets++;
    this.octets += payload.length;
    this.meter.add(pkt.length, t);
    this.sub.transport?.sendRtp(pkt);
  }

  onNack(seqs) {
    const l = this.track.layers.get(this.current);
    const missing = [];
    for (const s of seqs) {
      const e = this.buffer?.[s % BUFFER];
      if (e?.seq === s) { this.sub.transport?.sendRtp(e.pkt); continue; }
      if (!l || this.seqOffset === undefined) continue;
      const orig = (s - this.seqOffset) & 0xffff;
      if (((orig - this.switchSeq) & 0xffff) < 0x8000) missing.push(orig); // never reached us: ask the publisher
    }
    if (missing.length) this.track.nackPublisher(l, missing);
  }

  onSr(l, ntpSec, ntpFrac, rtpTs) {
    if (l.rid !== this.current || this.tsOffset === undefined) return;
    this.sub.sendRtcp(buildSr(this.ssrc, [ntpSec, ntpFrac], (rtpTs + this.tsOffset) % 2 ** 32, this.packets, this.octets));
  }
}

/** A participant: its transport, what it publishes and what it receives. */
class Participant {
  constructor(room, userId, session, sources, deaf = false) {
    Object.assign(this, { room, userId, session, sources: new Set(sources), deaf }); // deaf: server deafened, gets no audio
    this.rtcpSsrc = rand32();
    this.mids = new Map(); // mid -> {kind, codecs, ext}
    this.extIds = {};
    this.ssrcMap = new Map(); // publisher ssrc -> {mid, rid}
    this.published = new Map(); // mid -> Track
    this.downstreams = new Map(); // mid -> Downstream
    this.version = 0;
    this.sessionId = rand32();
    this.twcc = { arrivals: [], highest: -1, next: null, count: 0, ssrc: 0 };
    this.remb = null;
    this.announced = '';
    this.cannot = new Set(); // OPTIONAL_CODECS this browser cannot decode
  }

  ptFor(mid, codec) { return this.mids.get(mid)?.codecs.find(c => codecKey(c) === codec)?.pt; }
  sendRtcp(b) { this.transport?.sendRtcp(b); }

  /** Handles an offer: {sdp, publish: [{mid, source}], subscribe: [{mid, track_id}]}; returns the answer payload. */
  offer(d, sock) {
    const offer = parseOffer(d.sdp);
    if (!offer.media.length || offer.media.length > 64) throw new Error('bad offer');
    const first = offer.media.find(m => m.port);
    if (!first?.iceUfrag || !first.icePwd || !first.fingerprint) throw new Error('offer lacks ICE credentials or a sha-256 fingerprint');
    // a new RTCPeerConnection (retry after a lost connection) has a new certificate: start a fresh transport
    if (this.transport && !this.transport.closed && this.transport.remoteFingerprint !== first.fingerprint) this.transport.close('new peer connection');
    if (!this.transport || this.transport.closed) {
      this.transport = new Transport(sock, {
        remoteUfrag: first.iceUfrag, remoteFingerprint: first.fingerprint,
        onRtp: p => this.onRtp(p), onRtcp: p => this.onRtcp(p),
        onConnected: () => this.room.allocate(this, true),
        onClose: () => this.transportClosed(),
      });
    } else this.transport.remoteUfrag = first.iceUfrag;
    const publish = new Map((Array.isArray(d.publish) ? d.publish : []).map(p => [String(p?.mid), String(p?.source)]));
    const subscribe = new Map((Array.isArray(d.subscribe) ? d.subscribe : []).map(s => [String(s?.mid), String(s?.track_id)]));
    this.mids = new Map();
    const wantPublish = new Map(), wantDown = new Map(), usedSources = new Set();
    // a browser that cannot decode AV1 or H.264 makes the whole room publish without it (Room.checkCodecs); capabilities do not change
    for (const m of offer.media) {
      if (m.kind !== 'video' || !m.port || !/recv/.test(m.direction)) continue;
      const names = pickCodecs(m).map(c => c.name);
      for (const c of OPTIONAL_CODECS) if (!names.includes(c)) this.cannot.add(c);
    }
    const blocked = this.room.blocked();
    const sections = offer.media.map(m => {
      const codecs = m.port && m.mid ? pickCodecs(m) : [];
      if (!codecs.length) return { reject: true };
      this.mids.set(m.mid, { kind: m.kind, codecs, ext: m.ext });
      for (const [k, uri] of Object.entries(EXT_URI)) if (m.ext[uri]) this.extIds[k] ??= m.ext[uri];
      const source = publish.get(m.mid);
      if (source && SOURCES[source] === m.kind && !usedSources.has(source) && /send/.test(m.direction)) {
        usedSources.add(source);
        wantPublish.set(m.mid, { source, rids: m.rids.filter(r => r.dir === 'send').map(r => r.id), ssrcs: m.ssrcs });
        const ok = codecs.filter(c => !blocked.has(c.name));
        if (ok.length === codecs.length || !ok.length) return { recv: true };
        this.mids.get(m.mid).codecs = ok;
        return { recv: true, codecs: ok };
      }
      const track = this.room.trackById(subscribe.get(m.mid));
      if (track && track.owner !== this && track.allowed && track.kind === m.kind && /recv/.test(m.direction)) {
        let ds = this.downstreams.get(m.mid);
        if (ds?.track !== track) ds = new Downstream(this, m.mid, track);
        wantDown.set(m.mid, ds);
        return { send: { ssrc: ds.ssrc, cname: `cillvoice-${track.owner.userId}`, msid: `${track.owner.userId} ${track.id}` } };
      }
      return { inactive: true };
    });
    // publications: drop what is gone or changed, add what is new
    for (const [mid, t] of this.published) {
      const w = wantPublish.get(mid);
      if (!w || w.source !== t.source) this.unpublish(mid);
    }
    for (const [mid, w] of wantPublish) {
      if (!this.published.has(mid)) this.published.set(mid, new Track(this, mid, w.source, w.rids));
      for (const s of w.ssrcs) this.ssrcMap.set(s, { mid, rid: '' });
    }
    for (const [mid, ds] of this.downstreams) if (wantDown.get(mid) !== ds) ds.track.downstreams.delete(ds);
    this.downstreams = wantDown;
    for (const ds of wantDown.values()) ds.track.downstreams.add(ds);
    this.dsBySsrc = new Map([...wantDown.values()].map(ds => [ds.ssrc, ds]));
    const sdp = buildAnswer(offer, sections, {
      ufrag: this.transport.ufrag, pwd: this.transport.pwd, fingerprint: sock.cert.fingerprint, ip: sock.ip, port: sock.port,
      sessionId: this.sessionId, version: ++this.version,
    });
    this.announced = JSON.stringify(this.room.tracksFor(this)); // the answer carries the list
    this.room.announce();
    this.room.checkCodecs(this);
    this.room.allocate(this, true);
    return { sdp, subscribed: [...wantDown.values()].map(ds => ({ mid: ds.mid, track_id: ds.track.id, user_id: ds.track.owner.userId, source: ds.track.source })) };
  }

  unpublish(mid) {
    const t = this.published.get(mid);
    if (!t) return;
    this.published.delete(mid);
    for (const ds of t.downstreams) ds.track = deadTrack(ds.track); // the subscriber renegotiates it away
    t.downstreams.clear();
    // the ssrc -> mid mapping stays: a transceiver turned on again keeps its SSRCs, but the browser may no longer
    // send the mid/rid extensions we learned it from
  }

  onRtp(pkt) {
    const p = parseRtp(pkt);
    if (!p) return;
    let m = this.ssrcMap.get(p.ssrc);
    if (!m) {
      const mid = p.ext.get(this.extIds.mid)?.toString();
      const rid = p.ext.get(this.extIds.rid)?.toString() ?? '';
      // only negotiated rids, and a bounded number of streams: each one allocates a layer (review M-3)
      if (!mid || !this.published.has(mid) || (rid && !this.published.get(mid).rids.includes(rid)) || this.ssrcMap.size >= MAX_SSRCS) return;
      m = { mid, rid };
      this.ssrcMap.set(p.ssrc, m);
    }
    const tw = this.extIds.twcc && p.ext.get(this.extIds.twcc);
    if (tw?.length >= 2) this.twccArrival(tw.readUInt16BE(0), p.ssrc);
    this.published.get(m.mid)?.onPacket(p, m.rid, pkt.length);
  }

  twccArrival(seq16, ssrc) {
    const tw = this.twcc;
    const u = tw.highest < 0 ? seq16 : tw.highest + ((((seq16 - (tw.highest & 0xffff)) & 0xffff) ^ 0x8000) - 0x8000);
    if (u > tw.highest) tw.highest = u;
    if (tw.arrivals.length < 2048) tw.arrivals.push([u, now()]);
    tw.ssrc = ssrc;
  }

  // transport-wide feedback every 100 ms: arrival times of everything since the last report
  sendTwcc() {
    const tw = this.twcc;
    if (!tw.arrivals.length) return;
    const a = tw.arrivals.sort((x, y) => x[0] - y[0]);
    tw.arrivals = [];
    let idx = 0;
    if (tw.next !== null) while (idx < a.length && a[idx][0] < tw.next) idx++;
    if (tw.next === null || (idx < a.length && a[idx][0] - tw.next > 1000)) tw.next = a[idx]?.[0] ?? tw.next;
    while (idx < a.length) {
      let end = idx;
      while (end < a.length && a[end][0] < tw.next + 400) end++;
      if (end === idx) { tw.next = a[idx][0]; continue; }
      const chunk = a.slice(idx, end);
      idx = end;
      this.sendRtcp(buildTwcc(this.rtcpSsrc, tw.ssrc, tw.next, chunk, tw.count++));
      tw.next = chunk.at(-1)[0] + 1;
    }
  }

  onRtcp(buf) {
    let urgentAlloc = false;
    for (const r of parseRtcp(buf)) {
      if (r.pt === 200) { // a publisher's sender report: keep it for our RRs, translate it for the subscribers
        const m = this.ssrcMap.get(r.ssrc), t = m && this.published.get(m.mid), l = t?.layers.get(m.rid);
        if (!l || r.body.length < 20) continue;
        const [sec, frac, rtpTs] = [r.body.readUInt32BE(0), r.body.readUInt32BE(4), r.body.readUInt32BE(8)];
        l.stats.onSr(sec, frac, now());
        for (const ds of t.downstreams) ds.onSr(l, sec, frac, rtpTs);
      }
      if (r.pt === 200 || r.pt === 201) {
        const count = r.raw[0] & 0x1f;
        for (let i = 0, o = r.pt === 200 ? 20 : 0; i < count && o + 24 <= r.body.length; i++, o += 24) {
          const ds = this.dsBySsrc?.get(r.body.readUInt32BE(o));
          if (ds) {
            ds.fractionLost = r.body[o + 4] / 256;
            if (ds.track.kind === 'video' && ds.fractionLost >= 0.05) urgentAlloc = true;
          }
        }
      } else if (r.pt === 205 && r.fmt === 1 && r.body.length >= 8) {
        this.dsBySsrc?.get(r.body.readUInt32BE(0))?.onNack(parseNack(r.body));
      } else if (r.pt === 206 && (r.fmt === 1 || r.fmt === 4) && r.body.length >= 4) {
        const ssrc = r.fmt === 1 ? r.body.readUInt32BE(0) : r.body.length >= 8 ? r.body.readUInt32BE(4) : 0;
        const ds = this.dsBySsrc?.get(ssrc);
        if (ds) ds.track.requestKeyframe(ds.target ?? ds.current);
      } else if (r.pt === 206 && r.fmt === 15) {
        const remb = parseRemb(r.body);
        if (remb) {
          if (this.remb !== null && remb.bitrate < this.remb * 0.85) urgentAlloc = true;
          this.remb = remb.bitrate;
          this.rembAt = now();
        }
      }
    }
    if (urgentAlloc) {
      const t = now();
      if (t - (this.fastAllocAt ?? 0) >= 200) {
        this.fastAllocAt = t;
        this.room.allocate(this);
      }
    }
  }

  // once a second: receiver reports for everything we receive from this participant
  sendReports() {
    const t = now();
    const blocks = [];
    for (const track of this.published.values()) {
      // audio: report the worst subscriber's loss, so the publisher's Opus encoder adds in-band FEC for them
      const worst = track.kind === 'audio' ? Math.max(0, ...[...track.downstreams].map(ds => ds.fractionLost ?? 0)) : 0;
      for (const l of track.layers.values()) {
        if (l.stats.base < 0 || t - l.lastAt > 5000) continue;
        const b = l.stats.block(l.ssrc, t);
        b.fractionLost = Math.max(b.fractionLost, Math.min(255, Math.round(worst * 256)));
        blocks.push(b);
      }
    }
    for (let i = 0; i < blocks.length; i += 31) this.sendRtcp(buildRr(this.rtcpSsrc, blocks.slice(i, i + 31)));
  }

  transportClosed() {
    for (const mid of [...this.published.keys()]) this.unpublish(mid);
    this.ssrcMap = new Map();
    for (const ds of this.downstreams.values()) ds.track.downstreams.delete(ds);
    this.downstreams = new Map();
    this.dsBySsrc = new Map();
    this.room.announce();
  }

  close() {
    this.closed = true;
    this.transport?.close('left');
  }
}

// a downstream whose track was unpublished keeps a placeholder until the subscriber's next offer drops it
const deadTrack = t => ({ kind: t.kind, codec: t.codec, clock: t.clock, layers: new Map(), downstreams: new Set(), requestKeyframe() {}, nackPublisher() {}, owner: t.owner });

export class Room {
  constructor(id, { sock, dispatch }) {
    Object.assign(this, { id, sock, dispatch });
    this.participants = new Map(); // user id -> Participant
    this.speakers = new Set();
    this.blockedKey = ''; // the codecs publishers leave out (blocked()), as last announced
    this.timers = [
      setInterval(() => this.participants.forEach(p => p.sendTwcc()), 100),
      setInterval(() => this.tickSpeaking(), 150),
      setInterval(() => this.participants.forEach(p => (p.sendReports(), this.allocate(p))), 1000),
      ...(process.env.CILLVOICE_DEBUG ? [setInterval(() => {
        const m = process.memoryUsage();
        console.error(`${this.describe()}\ncillvoice memory: rss ${m.rss >> 20} MB, heap ${m.heapUsed >> 20}/${m.heapTotal >> 20} MB, external ${m.external >> 20} MB, buffers ${m.arrayBuffers >> 20} MB`);
      }, 5000)] : []),
    ];
    this.timers.forEach(t => t.unref());
  }

  join(userId, session, sources, deaf = false) {
    const old = this.participants.get(userId);
    if (old && old.session === session) return old;
    old?.close();
    const p = new Participant(this, userId, session, sources, deaf);
    this.participants.set(userId, p);
    // CILLVOICE_SPEAKING only goes out on changes: a newcomer learns who is speaking already
    if (this.speakers.size) this.dispatch(session, 'CILLVOICE_SPEAKING', { channel_id: this.id, speaking: [...this.speakers] });
    return p;
  }

  leave(userId) {
    const p = this.participants.get(userId);
    if (!p) return;
    this.participants.delete(userId);
    p.close();
    p.transportClosed();
    this.checkCodecs();
  }

  /** The OPTIONAL_CODECS someone in the room cannot decode: AV1 falls back to H.264, H.264 to VP8. */
  blocked() { return new Set([...this.participants.values()].flatMap(p => [...p.cannot])); }
  /**
   * When the blocked codecs change (someone who cannot decode one joins or the last one leaves), every other video
   * publisher gets CILLVOICE_TRACKS (its list may be unchanged), offers again and gets an answer with the codecs
   * everyone can decode. `except` just got its answer with the new codecs.
   */
  checkCodecs(except) {
    const key = [...this.blocked()].sort().join();
    if (key === this.blockedKey) return;
    this.blockedKey = key;
    for (const p of this.participants.values()) {
      if (p !== except && [...p.published.values()].some(t => t.kind === 'video')) this.dispatch(p.session, 'CILLVOICE_TRACKS', { channel_id: this.id, tracks: this.tracksFor(p) });
    }
  }

  setSources(userId, sources, deaf = false) {
    const p = this.participants.get(userId);
    if (!p) return;
    p.sources = new Set(sources);
    p.deaf = deaf;
    this.announce();
  }

  trackById(id) {
    for (const p of this.participants.values()) for (const t of p.published.values()) if (t.id === id) return t;
    return null;
  }
  tracksFor(p) {
    const out = [];
    for (const o of this.participants.values()) if (o !== p) for (const t of o.published.values()) if (t.allowed) out.push({ id: t.id, user_id: o.userId, kind: t.kind, source: t.source });
    return out;
  }
  /** CILLVOICE_TRACKS to every participant whose list of available remote tracks changed. */
  announce() {
    for (const p of this.participants.values()) {
      const tracks = this.tracksFor(p);
      const key = JSON.stringify(tracks);
      if (key === p.announced) continue;
      p.announced = key;
      this.dispatch(p.session, 'CILLVOICE_TRACKS', { channel_id: this.id, tracks });
    }
  }

  tickSpeaking() {
    const t = now();
    const speaking = new Set();
    for (const p of this.participants.values()) for (const tr of p.published.values()) if (tr.source === 'microphone' && tr.speaking(t)) speaking.add(p.userId);
    if (speaking.size === this.speakers.size && [...speaking].every(u => this.speakers.has(u))) return;
    this.speakers = speaking;
    const list = [...speaking];
    for (const p of this.participants.values()) this.dispatch(p.session, 'CILLVOICE_SPEAKING', { channel_id: this.id, speaking: list });
  }

  /**
   * Picks the simulcast layer of every video downstream of `p` within its bandwidth: screen shares first, then
   * cameras, each the best active layer that fits what is left. Chrome's REMB starts low and never rises much above
   * 1.5x what it receives, so it only counts as a limit when it falls (its delay-based estimator backs off on
   * congestion) or packets get lost; otherwise the current rate stands and every 2 s the budget gets headroom to try
   * higher layers. A probe followed by a falling REMB backs off for 20 s.
   */
  allocate(p, fresh = false) {
    const t = now();
    const all = [...p.downstreams.values()];
    const video = all.filter(ds => ds.track.kind === 'video' && ds.track.layers.size)
      .sort((a, b) => (a.track.source === 'screen_share' ? 0 : 1) - (b.track.source === 'screen_share' ? 0 : 1));
    if (!video.length) return;
    const sent = all.reduce((s, ds) => s + ds.meter.bps(t), 0);
    const audio = all.filter(ds => ds.track.kind === 'audio').reduce((s, ds) => s + ds.meter.bps(t), 0);
    const remb = p.remb !== null && t - p.rembAt < 5000 ? p.remb : null;
    const loss = Math.max(0, ...video.map(ds => ds.fractionLost ?? 0));
    const falling = remb !== null && p.lastRemb != null && remb < p.lastRemb * 0.95;
    p.lastRemb = remb;
    const congested = remb !== null && (falling || loss >= 0.02);
    let budget, probe = false;
    if (remb === null) budget = DEFAULT_BUDGET;
    else if (congested) {
      budget = remb;
      if (t - (p.probedAt ?? -1e9) < 6000) p.backoffUntil = t + 20_000; // the last probe overshot
    } else if (t - (p.probedAt ?? -1e9) > 2000 && t > (p.backoffUntil ?? 0)) {
      budget = Math.max(remb, sent) + Math.max(sent * 0.5, 300_000);
      p.probedAt = t;
      probe = true;
    } else budget = Math.max(remb, sent);
    budget -= audio;
    for (const ds of video) {
      const layers = ds.track.active(t);
      if (!layers.length) continue;
      const rate = l => Math.max(l.meter.bps(t), 30_000);
      let pick = layers[0];
      for (const l of layers) if (rate(l) <= budget) pick = l;
      // a probe may lift one downstream one layer above what it gets now: the next layer is often 4x the rate, more
      // than any headroom, and REMB only follows what is received, so without this a stream stays on its low layer
      const up = layers[layers.findIndex(l => l.rid === ds.current) + 1];
      if (probe && up && pick.rank < up.rank && ds.current !== null) { pick = up; probe = false; }
      // and only congestion moves a downstream down: right after a switch up the 2 s rate meters lag behind
      const cur = layers.find(l => l.rid === ds.current);
      if (!congested && cur && pick.rank < cur.rank) pick = cur;
      budget -= rate(pick);
      if (ds.target !== pick.rid || (ds.current !== ds.target && (fresh || t - (ds.askedAt ?? 0) > 1000))) {
        ds.target = pick.rid;
        ds.askedAt = t;
        if (ds.current !== pick.rid) ds.track.requestKeyframe(pick.rid, fresh);
      }
    }
  }

  /** One line per participant: REMB estimate, send rate and the layer of every video downstream (debug log). */
  describe() {
    const t = now();
    return [...this.participants.values()].map(p => `cillvoice ${this.id} ${p.userId}: remb ${p.remb === null ? '-' : Math.round(p.remb / 1000)} kbps, sending ${Math.round([...p.downstreams.values()].reduce((s, d) => s + d.meter.bps(t), 0) / 1000)} kbps; ${
      [...p.downstreams.values()].filter(d => d.track.kind === 'video').map(d => `${d.track.source}@${d.track.owner?.userId}: ${d.current}->${d.target} ${Math.round(d.meter.bps(t) / 1000)}k`).join(', ')}`).join('\n');
  }

  close() {
    this.timers.forEach(clearInterval);
    for (const id of [...this.participants.keys()]) this.leave(id);
  }
}
