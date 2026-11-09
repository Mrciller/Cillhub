import { createHmac } from 'node:crypto';

const { LIVEKIT_URL, LIVEKIT_PUBLIC_URL, LIVEKIT_API_KEY: KEY, LIVEKIT_API_SECRET: SECRET } = process.env;
export const endpoint = LIVEKIT_URL && LIVEKIT_PUBLIC_URL && KEY && SECRET ? LIVEKIT_PUBLIC_URL : null;

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url');
function jwt(claims, ttl) {
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: KEY, nbf: now, exp: now + ttl, ...claims })}`;
  return `${unsigned}.${createHmac('sha256', SECRET).update(unsigned).digest('base64url')}`;
}

// sources use the token spelling: microphone, camera, screen_share, screen_share_audio. canUpdateOwnMetadata lets a client
// set participant attributes: a viewer without AV1 says `av1: '0'` so sharers leave AV1 out (client voice/engine.ts);
// nothing reads LiveKit names or metadata, so a participant changing its own is harmless.
// An empty canPublishSources means every source to LiveKit, so no sources must be canPublish: false.
export const joinToken = (userId, name, room, sources) => jwt({
  sub: userId, name, metadata: JSON.stringify({ user_id: userId }),
  video: { room, roomJoin: true, canSubscribe: true, canPublish: sources.length > 0, canPublishData: false, canUpdateOwnMetadata: true, canPublishSources: sources },
}, 6 * 3600);

function call(method, body) {
  if (!endpoint) return;
  const auth = jwt({ video: { roomAdmin: true, room: body.room } }, 600);
  return fetch(`${LIVEKIT_URL}/twirp/livekit.RoomService/${method}`, {
    method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(3000),
  }).then(async res => {
    await res.arrayBuffer();
    if (!res.ok) console.error(`LiveKit ${method} failed: HTTP ${res.status}`);
  }).catch(e => console.error(`LiveKit ${method} failed: ${e.message}`));
}

export const removeParticipant = (room, identity) => call('RemoveParticipant', { room, identity });
// Twirp's protobuf JSON wants the TrackSource enum names, the uppercase form of the token spelling
export const updateParticipant = (room, identity, sources) => call('UpdateParticipant', {
  room, identity,
  permission: { can_subscribe: true, can_publish: sources.length > 0, can_publish_data: false, can_publish_sources: sources.map(s => s.toUpperCase()) },
});
