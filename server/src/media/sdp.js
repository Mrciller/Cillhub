// SDP for cillvoice: parse the browser's offer (unified plan, BUNDLE, rtcp-mux) and write the server's answer.
// The browser always offers; the server answers as ICE-lite, DTLS passive (the browser is the DTLS client).

export const EXT_URI = {
  audioLevel: 'urn:ietf:params:rtp-hdrext:ssrc-audio-level',
  absSendTime: 'http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time',
  twcc: 'http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
  mid: 'urn:ietf:params:rtp-hdrext:sdes:mid',
  rid: 'urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id',
};

/** {iceUfrag, icePwd, fingerprint, media: [{kind, port, mid, direction, codecs: [{pt, name, rate, channels, fmtp, fb}], ext: {uri: id}, rids, ssrcs}]} */
export function parseOffer(sdp) {
  const lines = String(sdp).split(/\r?\n/).filter(Boolean);
  const session = { media: [] };
  let m = null;
  const target = () => m ?? session;
  for (const line of lines) {
    if (line.startsWith('m=')) {
      const [kind, port, , ...pts] = line.slice(2).split(' ');
      m = { kind, port: Number(port), pts: pts.map(Number), codecs: new Map(), ext: {}, rids: [], ssrcs: [], direction: 'sendrecv', simulcast: null };
      session.media.push(m);
      continue;
    }
    if (!line.startsWith('a=')) continue;
    const [key, ...rest] = line.slice(2).split(':');
    const val = rest.join(':');
    const codec = pt => {
      if (!m.codecs.has(pt)) m.codecs.set(pt, { pt, fb: [], fmtp: '' });
      return m.codecs.get(pt);
    };
    switch (key) {
      case 'ice-ufrag': target().iceUfrag = val; break;
      case 'ice-pwd': target().icePwd = val; break;
      case 'fingerprint': { const [alg, fp] = val.split(' '); if (alg.toLowerCase() === 'sha-256') target().fingerprint = fp.toUpperCase(); break; }
      case 'setup': target().setup = val; break;
      case 'mid': m && (m.mid = val); break;
      case 'sendrecv': case 'sendonly': case 'recvonly': case 'inactive': m && (m.direction = key); break;
      case 'rtpmap': {
        if (!m) break;
        const [pt, enc] = val.split(' ');
        const [name, rate, channels] = enc.split('/');
        Object.assign(codec(Number(pt)), { name: name.toLowerCase(), rate: Number(rate), channels: Number(channels) || 1 });
        break;
      }
      case 'fmtp': { if (!m) break; const i = val.indexOf(' '); codec(Number(val.slice(0, i))).fmtp = val.slice(i + 1); break; }
      case 'rtcp-fb': { if (!m) break; const i = val.indexOf(' '); if (val.slice(0, i) !== '*') codec(Number(val.slice(0, i))).fb.push(val.slice(i + 1)); break; }
      case 'extmap': { if (!m) break; const [id, uri] = val.split(' '); m.ext[uri] = Number(id.split('/')[0]); break; }
      case 'rid': { if (!m) break; const [id, dir] = val.split(' '); m.rids.push({ id, dir }); break; }
      case 'simulcast': m && (m.simulcast = val); break;
      case 'ssrc': { if (!m) break; const ssrc = Number(val.split(' ')[0]); if (!m.ssrcs.includes(ssrc)) m.ssrcs.push(ssrc); break; }
      case 'ssrc-group': m && val.startsWith('FID ') && (m.rtxSsrcs = val.split(' ').slice(2).map(Number)); break;
    }
  }
  for (const x of session.media) {
    x.codecs = [...x.codecs.values()].filter(c => c.name);
    if (x.rtxSsrcs) x.ssrcs = x.ssrcs.filter(s => !x.rtxSsrcs.includes(s));
    for (const k of ['iceUfrag', 'icePwd', 'fingerprint', 'setup']) x[k] ??= session[k];
  }
  return session;
}

const fmtpParams = f => Object.fromEntries(f.split(';').filter(Boolean).map(p => p.trim().split('=')));

/**
 * The codecs the server takes from an m-section: Opus; VP8, H.264 (packetization mode 1, constrained baseline
 * preferred) and AV1 (profile 0, the one every AV1 decoder handles), in the browser's order, so a client that prefers
 * AV1 or H.264 (setCodecPreferences) sends it.
 */
export function pickCodecs(m) {
  if (m.kind === 'audio') return m.codecs.filter(c => c.name === 'opus' && c.rate === 48000).slice(0, 1);
  const vp8 = m.codecs.find(c => c.name === 'vp8');
  const h264 = m.codecs.filter(c => c.name === 'h264' && fmtpParams(c.fmtp)['packetization-mode'] === '1')
    .sort((a, b) => score(b) - score(a))[0];
  const av1 = m.codecs.find(c => c.name === 'av1' && (fmtpParams(c.fmtp).profile ?? '0') === '0');
  return [vp8, h264, av1].filter(Boolean).sort((a, b) => m.codecs.indexOf(a) - m.codecs.indexOf(b));
}
// 42e01f (constrained baseline) first: every browser decodes it
const score = c => { const p = (fmtpParams(c.fmtp)['profile-level-id'] ?? '').toLowerCase(); return p.startsWith('42e0') ? 2 : p.startsWith('4200') ? 1 : 0; };

/** A codec's identity across peers (payload types differ per browser). */
export const codecKey = c => (c.name === 'h264' ? 'h264' : c.name);

/**
 * The answer. `sections[i]` says what to do with offer m-section i: {reject} | {recv: true, codecs?} (the browser
 * publishes; `codecs` narrows pickCodecs) | {send: {ssrc, msid, cname}} (the server forwards a track) | {inactive: true}.
 */
export function buildAnswer(offer, sections, { ufrag, pwd, fingerprint, ip, port, sessionId, version }) {
  const accepted = offer.media.filter((m, i) => !sections[i].reject).map(m => m.mid);
  const out = [
    'v=0', `o=- ${sessionId} ${version} IN IP4 0.0.0.0`, 's=cillvoice', 't=0 0',
    ...(accepted.length ? [`a=group:BUNDLE ${accepted.join(' ')}`] : []),
    'a=ice-lite', 'a=msid-semantic: WMS *',
  ];
  offer.media.forEach((m, i) => {
    const s = sections[i];
    const codecs = s.reject ? [] : s.codecs ?? pickCodecs(m);
    if (s.reject || !codecs.length) {
      out.push(`m=${m.kind} 0 UDP/TLS/RTP/SAVPF ${m.pts[0] ?? 0}`, 'c=IN IP4 0.0.0.0', `a=mid:${m.mid}`, 'a=inactive');
      return;
    }
    out.push(`m=${m.kind} ${port} UDP/TLS/RTP/SAVPF ${codecs.map(c => c.pt).join(' ')}`, `c=IN IP4 ${ip}`,
      `a=ice-ufrag:${ufrag}`, `a=ice-pwd:${pwd}`, `a=fingerprint:sha-256 ${fingerprint}`, 'a=setup:passive', `a=mid:${m.mid}`,
      `a=candidate:1 1 udp 2130706431 ${ip} ${port} typ host generation 0`, 'a=end-of-candidates');
    const publish = !!s.recv;
    // header extensions: the browser's ids, only the ones we use in that direction.
    // For video, negotiate RID whenever offered so libWebRTC does not disable simulcast header extensions on subsequent renegotiations.
    const want = [
      EXT_URI.mid,
      ...(m.kind === 'audio' ? [EXT_URI.audioLevel] : []),
      ...(m.kind === 'video' ? [EXT_URI.rid] : []),
      ...(publish ? [EXT_URI.twcc] : [EXT_URI.absSendTime]),
    ];
    for (const uri of want) if (m.ext[uri]) out.push(`a=extmap:${m.ext[uri]} ${uri}`);
    out.push(`a=${s.recv ? 'recvonly' : s.send ? 'sendonly' : 'inactive'}`);
    if (s.send) out.push(`a=msid:${s.send.msid}`);
    out.push('a=rtcp-mux', 'a=rtcp-rsize');
    for (const c of codecs) {
      out.push(`a=rtpmap:${c.pt} ${c.name === 'opus' ? 'opus' : c.name.toUpperCase()}/${c.rate}${c.name === 'opus' ? '/2' : ''}`);
      const fb = m.kind === 'audio' ? (publish ? ['transport-cc'] : [])
        : publish ? ['transport-cc', 'ccm fir', 'nack', 'nack pli'] : ['goog-remb', 'ccm fir', 'nack', 'nack pli'];
      for (const f of fb) if (c.fb.includes(f)) out.push(`a=rtcp-fb:${c.pt} ${f}`);
      if (c.name === 'opus') out.push(`a=fmtp:${c.pt} minptime=10;useinbandfec=1`);
      else if (c.fmtp) out.push(`a=fmtp:${c.pt} ${c.fmtp}`);
    }
    if (publish && m.simulcast && m.rids.length) {
      for (const r of m.rids) out.push(`a=rid:${r.id} recv`);
      out.push(`a=simulcast:recv ${m.rids.map(r => r.id).join(';')}`);
    }
    if (s.send) out.push(`a=ssrc:${s.send.ssrc} cname:${s.send.cname}`, `a=ssrc:${s.send.ssrc} msid:${s.send.msid}`);
  });
  return out.join('\r\n') + '\r\n';
}
