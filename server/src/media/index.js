// cillvoice as a voice backend with the same interface as livekit.js (endpoint, joinToken, removeParticipant,
// updateParticipant), plus the gateway signaling op. Enabled with VOICE_BACKEND=cillvoice, CILLVOICE_UDP_PORT and
// CILLVOICE_PUBLIC_IP.
import { randomBytes } from 'node:crypto';
import { MediaSocket } from './transport.js';
import { Room } from './sfu.js';
import { sendToSession } from '../gateway.js';

const { CILLVOICE_UDP_PORT, CILLVOICE_PUBLIC_IP } = process.env;
const PORT = Number(CILLVOICE_UDP_PORT);
export const endpoint = PORT > 0 && PORT < 65536 && /^\d+\.\d+\.\d+\.\d+$/.test(CILLVOICE_PUBLIC_IP ?? '') ? 'cillvoice' : null;
if (process.env.VOICE_BACKEND === 'cillvoice' && !endpoint) console.error('cillvoice: CILLVOICE_UDP_PORT and CILLVOICE_PUBLIC_IP (IPv4) are required; voice is disabled');

let sock = null;
const rooms = new Map(); // channel id -> Room
const tokens = new Map(); // token -> {userId, room, session, sources, at}
const TOKEN_TTL = 6 * 3600e3;

function socket() {
  if (!sock) {
    sock = new MediaSocket({ port: PORT, ip: CILLVOICE_PUBLIC_IP, ...(process.env.CILLVOICE_BIND_IP && { bindIp: process.env.CILLVOICE_BIND_IP }) });
    sock.start().catch(e => console.error(`cillvoice: cannot bind UDP ${PORT}: ${e.message}`));
  }
  return sock;
}
const dispatch = (session, t, d) => sendToSession(session, t, d);

/** A join token for one voice state (a user has one at a time); only the session that got it can use it. */
export function joinToken(userId, name, room, sources, session) {
  socket();
  const now = Date.now();
  for (const [k, v] of tokens) if (now - v.at > TOKEN_TTL || v.userId === userId) tokens.delete(k);
  const token = randomBytes(24).toString('base64url');
  tokens.set(token, { userId, room, session, sources: [...sources], at: now });
  return token;
}

export function removeParticipant(room, userId) {
  for (const [k, v] of tokens) if (v.userId === userId && v.room === room) tokens.delete(k);
  const r = rooms.get(room);
  if (!r) return;
  r.leave(userId);
  if (!r.participants.size) (r.close(), rooms.delete(room));
}

export function updateParticipant(room, userId, sources) {
  for (const v of tokens.values()) if (v.userId === userId && v.room === room) v.sources = [...sources];
  rooms.get(room)?.setSources(userId, sources);
}

/** Gateway op 50 CILLVOICE_SIGNAL {token, sdp, publish: [{mid, source}], subscribe: [{mid, track_id}]} -> CILLVOICE_ANSWER. */
export function signal(session, d) {
  const entry = tokens.get(String(d?.token ?? ''));
  if (!endpoint || !entry || Date.now() - entry.at > TOKEN_TTL || entry.session !== session || entry.userId !== session.user.id || typeof d.sdp !== 'string' || d.sdp.length > 60_000) {
    return sendToSession(session, 'CILLVOICE_ERROR', { message: 'invalid voice token or offer' });
  }
  let r = rooms.get(entry.room);
  if (!r) rooms.set(entry.room, (r = new Room(entry.room, { sock: socket(), dispatch })));
  const p = r.join(entry.userId, session, entry.sources);
  try {
    const answer = p.offer(d, socket());
    sendToSession(session, 'CILLVOICE_ANSWER', { channel_id: entry.room, ...answer, tracks: r.tracksFor(p) });
  } catch (e) {
    if (!p.transport) {
      r.leave(entry.userId);
      if (!r.participants.size) (r.close(), rooms.delete(entry.room));
    }
    sendToSession(session, 'CILLVOICE_ERROR', { message: e.message });
  }
}

/** v7 voice self-check: binds the UDP port and answers plain STUN Binding requests for `ms`; {listening, probe_until}. */
export async function probe(ms = 60_000) {
  if (!endpoint) return { listening: false, probe_until: null };
  const s = socket();
  const listening = await s.ready.then(() => true, () => false);
  s.probeUntil = Date.now() + ms;
  return { listening, probe_until: new Date(s.probeUntil).toISOString() };
}

/** Counters for tests and the measurement script. */
export const mediaStats = () => ({ rooms: rooms.size, ...(sock?.stats ?? {}) });
export function stopMedia() {
  for (const r of rooms.values()) r.close();
  rooms.clear();
  sock?.stop();
  sock = null;
}
