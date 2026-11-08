// Per-server voice server (migration 009): guild voice_backend picks LiveKit or cillvoice for new calls; a running call keeps its backend.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith } from './helpers.js';

let srv, api, g, alice, bob;
before(async () => {
  srv = await startServer({ env: {
    LIVEKIT_URL: 'http://127.0.0.1:9', LIVEKIT_PUBLIC_URL: 'wss://lk.example/livekit', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'x'.repeat(32),
    CILLVOICE_UDP_PORT: '3348', CILLVOICE_PUBLIC_IP: '127.0.0.1',
  } });
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice, bob } = g.users);
  for (const u of [alice, bob]) u.gw = await srv.gateway(u.token);
});
after(() => srv.stop());

const join = (u, channel_id = g.voice.id) => u.gw.send({ op: 4, d: { guild_id: g.guild.id, channel_id, self_mute: false, self_deaf: false } });
const endpoint = async u => (await u.gw.event('VOICE_SERVER_UPDATE')).endpoint;
const patch = (u, voice_backend) => api('PATCH', `/guilds/${g.guild.id}`, u.token, { voice_backend });

test('instance info lists the configured voice servers', async () => {
  const info = await fetch(`${srv.base}/instance`).then(r => r.json());
  assert.deepEqual(info.voice, { configured: ['livekit', 'cillvoice'], default: 'livekit' });
});

test('a server picks its voice server; new calls use it, a running call keeps its own', async () => {
  join(alice);
  assert.equal(await endpoint(alice), 'wss://lk.example/livekit'); // instance default
  join(alice, null);

  assert.equal((await patch(bob, 'cillvoice')).status, 403); // needs Manage Server
  assert.equal((await patch(alice, 'teamspeak')).body.errors.voice_backend._errors[0].code, 'VOICE_BACKEND_UNAVAILABLE');
  const ok = await patch(alice, 'cillvoice');
  assert.equal(ok.body.voice_backend, 'cillvoice');
  await alice.gw.event('GUILD_UPDATE', d => d.voice_backend === 'cillvoice');

  join(alice);
  assert.equal(await endpoint(alice), 'cillvoice');
  await patch(alice, 'livekit'); // changed while a call runs: Bob still joins Alice's cillvoice call
  join(bob);
  assert.equal(await endpoint(bob), 'cillvoice');
  join(alice, null); join(bob, null);
  await new Promise(r => setTimeout(r, 100));
  join(bob);
  assert.equal(await endpoint(bob), 'wss://lk.example/livekit'); // the next call uses the new choice
  join(bob, null);

  assert.equal((await patch(alice, null)).body.voice_backend, null); // back to the instance default
});
