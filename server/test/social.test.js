import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

let srv, api, alice, bob;
before(async () => {
  srv = await startServer();
  api = srv.api;
  alice = await srv.register('alice');
  bob = await srv.register('bob');
  alice.gw = await srv.gateway(alice.token);
  bob.gw = await srv.gateway(bob.token);
});
after(() => srv.stop());

test('DMs need a friendship or a shared guild', async () => {
  const r = await api('POST', '/users/@me/channels', bob.token, { recipient_id: alice.id });
  assert.deepEqual([r.status, r.body.code], [403, 50007]);
});

test('friends: request, accept, remove, events on both sides', async () => {
  const unknown = await api('POST', '/users/@me/relationships', alice.token, { username: 'nobody' });
  assert.deepEqual([unknown.status, unknown.body.code, unknown.body.message], [400, 80004, 'No users with that username exist']);
  const self = await api('POST', '/users/@me/relationships', alice.token, { username: 'alice' });
  assert.deepEqual([self.status, self.body.code], [400, 80003]);

  assert.equal((await api('POST', '/users/@me/relationships', alice.token, { username: 'Bob' })).status, 204);
  assert.deepEqual(await alice.gw.event('RELATIONSHIP_ADD'), { id: bob.id, type: 4, user: (await api('GET', `/users/${bob.id}`, alice.token)).body });
  assert.equal((await bob.gw.event('RELATIONSHIP_ADD')).type, 3);
  assert.deepEqual((await api('GET', '/users/@me/relationships', bob.token)).body.map(r => [r.id, r.type]), [[alice.id, 3]]);

  assert.equal((await api('PUT', `/users/@me/relationships/${alice.id}`, bob.token, {})).status, 204);
  assert.equal((await alice.gw.event('RELATIONSHIP_ADD')).type, 1);
  assert.equal((await bob.gw.event('RELATIONSHIP_ADD')).type, 1);
  // friends see each other's presence, now and in READY
  assert.equal((await alice.gw.event('PRESENCE_UPDATE', d => d.user.id === bob.id)).status, 'online');
  const again = await srv.gateway(alice.token);
  assert.deepEqual(again.ready.relationships.map(r => [r.id, r.type, r.user.username]), [[bob.id, 1, 'bob']]);
  assert.ok(again.ready.presences.some(p => p.user.id === bob.id));
  again.ws.close();

  const dm = await api('POST', '/users/@me/channels', bob.token, { recipient_id: alice.id });
  assert.equal(dm.status, 200);

  assert.equal((await api('DELETE', `/users/@me/relationships/${bob.id}`, alice.token)).status, 204);
  assert.deepEqual(await alice.gw.event('RELATIONSHIP_REMOVE'), { id: bob.id, type: 1 });
  assert.deepEqual(await bob.gw.event('RELATIONSHIP_REMOVE'), { id: alice.id, type: 1 });
  // the DM that exists keeps working
  assert.equal((await api('POST', '/users/@me/channels', bob.token, { recipient_id: alice.id })).body.id, dm.body.id);

  // cancelling an outgoing request removes it on both sides
  await api('PUT', `/users/@me/relationships/${bob.id}`, alice.token, {});
  await bob.gw.event('RELATIONSHIP_ADD', d => d.type === 3);
  await api('DELETE', `/users/@me/relationships/${bob.id}`, alice.token);
  assert.deepEqual(await bob.gw.event('RELATIONSHIP_REMOVE'), { id: alice.id, type: 3 });
});

test('status is persisted and used on the next connect', async () => {
  const carol = await srv.register('carol');
  await api('POST', '/users/@me/relationships', carol.token, { username: 'alice' });
  await api('PUT', `/users/@me/relationships/${carol.id}`, alice.token, {});
  const gw = await srv.gateway(carol.token);
  assert.equal(gw.ready.user_settings.status, 'online');
  assert.equal((await alice.gw.event('PRESENCE_UPDATE', d => d.user.id === carol.id)).status, 'online');
  gw.send({ op: 3, d: { status: 'dnd' } });
  assert.equal((await alice.gw.event('PRESENCE_UPDATE', d => d.user.id === carol.id && d.status === 'dnd')).status, 'dnd');
  gw.ws.close();
  await alice.gw.event('PRESENCE_UPDATE', d => d.user.id === carol.id && d.status === 'offline');
  const next = await srv.gateway(carol.token);
  assert.equal(next.ready.user_settings.status, 'dnd');
  assert.equal((await alice.gw.event('PRESENCE_UPDATE', d => d.user.id === carol.id)).status, 'dnd'); // straight back to dnd
});

test('online users with every session away (inactive tab, phone in the background) show as idle', async () => {
  const dave = await srv.register('dave');
  await api('POST', '/users/@me/relationships', dave.token, { username: 'alice' });
  await api('PUT', `/users/@me/relationships/${dave.id}`, alice.token, {});
  const pc = await srv.gateway(dave.token);
  await alice.gw.event('PRESENCE_UPDATE', d => d.user.id === dave.id && d.status === 'online');
  const phone = await srv.gateway(dave.token);
  phone.send({ op: 3, d: { afk: true } }); // the phone app in the background
  pc.send({ op: 3, d: { status: 'online', afk: true, since: Date.now(), activities: [] } }); // the PC without input
  await alice.gw.event('PRESENCE_UPDATE', d => d.user.id === dave.id && d.status === 'idle');
  pc.send({ op: 3, d: { status: 'online', afk: false, since: 0, activities: [] } }); // back at the PC
  await alice.gw.event('PRESENCE_UPDATE', d => d.user.id === dave.id && d.status === 'online');
  pc.ws.close(); // only the background phone is left
  await alice.gw.event('PRESENCE_UPDATE', d => d.user.id === dave.id && d.status === 'idle');
  phone.send({ op: 3, d: { status: 'dnd' } }); // dnd and invisible are kept as chosen
  await alice.gw.event('PRESENCE_UPDATE', d => d.user.id === dave.id && d.status === 'dnd');
  phone.ws.close();
  await alice.gw.event('PRESENCE_UPDATE', d => d.user.id === dave.id && d.status === 'offline');
});
