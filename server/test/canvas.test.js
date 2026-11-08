import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith } from './helpers.js';

let srv, api, g, alice, bob, stranger;
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice, bob } = g.users);
  alice.gw = await srv.gateway(alice.token);
  bob.gw = await srv.gateway(bob.token);
  stranger = await srv.register('stranger');
});
after(() => srv.stop());

test('channel canvas: initial get, put update, version bump, gateway event, permissions', async () => {
  const ch = g.general.id;

  // Initial GET returns empty canvas with version 0
  const init = (await api('GET', `/channels/${ch}/canvas`, alice.token)).body;
  assert.equal(init.channel_id, ch);
  assert.equal(init.content, '');
  assert.equal(init.version, 0);
  assert.equal(init.updated_by, null);

  // PUT updates canvas and emits CHANNEL_CANVAS_UPDATE
  const updated = await api('PUT', `/channels/${ch}/canvas`, alice.token, { content: '# Team Canvas\n- Item 1\n- Item 2' });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.channel_id, ch);
  assert.equal(updated.body.content, '# Team Canvas\n- Item 1\n- Item 2');
  assert.equal(updated.body.version, 1);
  assert.equal(updated.body.updated_by, alice.id);

  // Gateway event received by bob
  const ev = await bob.gw.event('CHANNEL_CANVAS_UPDATE', d => d.channel_id === ch);
  assert.equal(ev.content, '# Team Canvas\n- Item 1\n- Item 2');
  assert.equal(ev.version, 1);
  assert.equal(ev.updated_by, alice.id);

  // Bob updates canvas -> version 2
  const updated2 = await api('PUT', `/channels/${ch}/canvas`, bob.token, { content: 'Updated by Bob' });
  assert.equal(updated2.status, 200);
  assert.equal(updated2.body.version, 2);
  assert.equal(updated2.body.updated_by, bob.id);

  // Stranger without access gets 403
  const forbiddenGet = await api('GET', `/channels/${ch}/canvas`, stranger.token);
  assert.equal(forbiddenGet.status, 403);
  const forbiddenPut = await api('PUT', `/channels/${ch}/canvas`, stranger.token, { content: 'Hacked' });
  assert.equal(forbiddenPut.status, 403);
});
