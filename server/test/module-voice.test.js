// A module with voice.read lists voice states only in channels its bot may see (LiveKit is faked, as in voice.test.js).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startServer, guildWith, bits, until } from './helpers.js';
import { makeAdmin, install, pkg, running } from './module-helpers.js';

let srv, livekit;
before(async () => {
  livekit = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }); });
  await new Promise(r => livekit.listen(0, '127.0.0.1', r));
  srv = await startServer({ env: {
    LIVEKIT_URL: `http://127.0.0.1:${livekit.address().port}`, LIVEKIT_PUBLIC_URL: 'wss://lk.example/livekit', LIVEKIT_API_KEY: 'devkey', LIVEKIT_API_SECRET: 'x'.repeat(32),
  } });
});
after(async () => { await srv.stop(); livekit.close(); });

test('voice.list leaves out channels hidden from the module bot', async () => {
  const { api } = srv;
  const root = await makeAdmin(srv, 'jordan');
  const g = await guildWith(srv, ['alex', 'sam']);
  const code = `cillhub.on('HTTP_REQUEST', async req => ({ body: (await cillhub.voice.list(req.query.g)).map(v => v.channel_id) }));`;
  const mod = await install(srv, root, pkg({ id: 'ears', name: 'Ears', permissions: ['voice.read', 'http.routes'] }, { 'index.js': code }));
  await running(srv, root, 'ears');
  const staff = (await api('POST', `/guilds/${g.guild.id}/channels`, g.users.alex.token, { name: 'staff', type: 2 })).body;
  await api('PUT', `/channels/${staff.id}/permissions/${mod.application_id}`, g.users.alex.token, { type: 1, allow: '0', deny: bits(10) });
  const alex = await srv.gateway(g.users.alex.token), sam = await srv.gateway(g.users.sam.token);
  alex.send({ op: 4, d: { guild_id: g.guild.id, channel_id: staff.id, self_mute: false, self_deaf: false } });
  sam.send({ op: 4, d: { guild_id: g.guild.id, channel_id: g.voice.id, self_mute: false, self_deaf: false } });
  const seen = await until(async () => {
    const r = await (await fetch(`${srv.origin}/modules/ears/http/?g=${g.guild.id}`)).json();
    return r.length ? r : null;
  }, 5000);
  await new Promise(r => setTimeout(r, 300));
  assert.deepEqual(await (await fetch(`${srv.origin}/modules/ears/http/?g=${g.guild.id}`)).json(), [g.voice.id], `saw ${seen}`);
});
