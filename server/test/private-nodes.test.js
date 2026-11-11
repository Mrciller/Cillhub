import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

test('private_nodes: never saved is null; origins only, deduplicated, names plain, synced to other sessions', async () => {
  const srv = await startServer();
  try {
    const sam = await srv.register('sam');
    const patch = body => srv.api('PATCH', '/users/@me/settings', sam.token, body);
    assert.equal((await srv.api('GET', '/users/@me/settings', sam.token)).body.private_nodes, null);
    const gw = await srv.gateway(sam.token);
    const ok = await patch({ private_nodes: [
      { origin: 'https://chat.example.org', name: ' Node\u0000 One ' }, { origin: 'http://127.0.0.1:3398', name: 7 }, { origin: 'https://chat.example.org', name: 'again' },
    ] });
    assert.equal(ok.status, 200);
    const stored = [{ origin: 'https://chat.example.org', name: 'Node One' }, { origin: 'http://127.0.0.1:3398', name: '' }];
    assert.deepEqual(ok.body.private_nodes, stored);
    assert.deepEqual((await gw.event('USER_SETTINGS_UPDATE')).private_nodes, stored);
    for (const origin of ['http://chat.example.org', 'https://chat.example.org/', 'https://chat.example.org/x', 'https://a@chat.example.org', 'javascript:alert(1)', 'HTTPS://Chat.example.org'])
      assert.equal((await patch({ private_nodes: [{ origin, name: 'x' }] })).status, 400, origin);
    for (const bad of ['nope', [null], Array.from({ length: 21 }, (_, i) => ({ origin: `https://n${i}.example.org`, name: '' }))])
      assert.equal((await patch({ private_nodes: bad })).status, 400);
    assert.deepEqual((await patch({ private_nodes: [] })).body.private_nodes, []);
  } finally {
    await srv.stop();
  }
});
