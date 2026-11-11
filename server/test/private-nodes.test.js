import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

test('private_nodes: never saved is null; the first list only while none is stored; origins only, names plain, synced', async () => {
  const srv = await startServer();
  try {
    const sam = await srv.register('sam');
    const initial = nodes => srv.api('PUT', '/users/@me/settings/private-nodes/initial', sam.token, { nodes });
    assert.equal((await srv.api('GET', '/users/@me/settings', sam.token)).body.private_nodes, null);
    assert.equal((await srv.api('PATCH', '/users/@me/settings', sam.token, { private_nodes: [] })).status, 400, 'never replaced whole');
    for (const bad of ['nope', [null], Array.from({ length: 21 }, (_, i) => ({ origin: `https://n${i}.example.org`, name: '' }))])
      assert.equal((await initial(bad)).status, 400);
    const gw = await srv.gateway(sam.token);
    const ok = await initial([
      { origin: 'https://chat.example.org', name: ' Node\u0000 One ' }, { origin: 'http://127.0.0.1:3398', name: 7 }, { origin: 'https://chat.example.org', name: 'again' },
    ]);
    assert.equal(ok.status, 200);
    const stored = [{ origin: 'https://chat.example.org', name: 'Node One' }, { origin: 'http://127.0.0.1:3398', name: '' }];
    assert.deepEqual(ok.body.private_nodes, stored);
    assert.deepEqual((await gw.event('USER_SETTINGS_UPDATE')).private_nodes, stored);
    // a second device's delayed first upload does not bring back what was removed meanwhile
    await srv.api('DELETE', `/users/@me/settings/private-nodes?origin=${encodeURIComponent('https://chat.example.org')}`, sam.token);
    assert.deepEqual((await initial([{ origin: 'https://chat.example.org', name: 'x' }])).body.private_nodes, [stored[1]]);
    for (const origin of ['http://chat.example.org', 'https://chat.example.org/', 'https://chat.example.org/x', 'https://a@chat.example.org', 'javascript:alert(1)', 'HTTPS://Chat.example.org'])
      assert.equal((await srv.api('PUT', '/users/@me/settings/private-nodes', sam.token, { origin, name: 'x' })).status, 400, origin);
  } finally {
    await srv.stop();
  }
});

test('private-nodes add/remove: one change at a time on the stored list, so a removal is never undone by another device', async () => {
  const srv = await startServer();
  try {
    const kim = await srv.register('kim');
    const add = (origin, name = 'n') => srv.api('PUT', '/users/@me/settings/private-nodes', kim.token, { origin, name });
    const remove = origin => srv.api('DELETE', `/users/@me/settings/private-nodes?origin=${encodeURIComponent(origin)}`, kim.token);
    await add('https://x.example.org');
    await add('https://y.example.org'); // another device, its copy still had x
    await remove('https://x.example.org');
    const last = await add('https://z.example.org'); // a stale device adds after the removal
    assert.deepEqual(last.body.private_nodes.map(n => n.origin), ['https://y.example.org', 'https://z.example.org']);
    assert.deepEqual((await add('https://y.example.org', 'again')).body.private_nodes.length, 2, 'a repeated origin changes nothing');
    assert.equal((await add('https://y.example.org/path')).status, 400);
    assert.equal((await srv.api('DELETE', '/users/@me/settings/private-nodes', kim.token)).status, 400);
    for (let i = 0; i < 18; i++) await add(`https://n${i}.example.org`);
    assert.equal((await add('https://full.example.org')).status, 400, 'at most 20');
  } finally {
    await srv.stop();
  }
});
