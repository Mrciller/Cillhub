import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, guildWith } from './helpers.js';

let srv, api, g, alice, bob;
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice, bob } = g.users);
});
after(() => srv.stop());

test('connections: CRUD connections, show_on_profile toggle, reflected in GET /users/:id/profile connected_accounts', async () => {
  // 1. Initial list is empty
  const init = (await api('GET', '/users/@me/connections', alice.token)).body;
  assert.deepEqual(init, []);

  // 2. Add GitHub connection
  const gh = (await api('POST', '/users/@me/connections', alice.token, {
    type: 'github',
    name: 'torvalds',
    show_on_profile: true,
    metadata: { profile_url: 'https://github.com/torvalds' },
  })).body;
  assert.ok(gh.id);
  assert.equal(gh.type, 'github');
  assert.equal(gh.name, 'torvalds');
  assert.equal(gh.verified, true);
  assert.equal(gh.show_on_profile, true);
  assert.deepEqual(gh.metadata, { profile_url: 'https://github.com/torvalds' });

  // 3. Add Steam connection with show_on_profile = false
  const steam = (await api('POST', '/users/@me/connections', alice.token, {
    type: 'steam',
    name: 'gaben',
    show_on_profile: false,
  })).body;
  assert.ok(steam.id);
  assert.equal(steam.show_on_profile, false);

  // 4. Duplicate connection returns 400
  const dup = await api('POST', '/users/@me/connections', alice.token, {
    type: 'github',
    name: 'torvalds',
  });
  assert.equal(dup.status, 400);

  // 5. GET /users/@me/connections returns both
  const list = (await api('GET', '/users/@me/connections', alice.token)).body;
  assert.equal(list.length, 2);

  // 6. Bob checks Alice's profile: only GitHub is in connected_accounts
  const profile1 = (await api('GET', `/users/${alice.id}/profile`, bob.token)).body;
  assert.ok(Array.isArray(profile1.connected_accounts));
  assert.equal(profile1.connected_accounts.length, 1);
  assert.equal(profile1.connected_accounts[0].name, 'torvalds');
  assert.equal(profile1.connected_accounts[0].type, 'github');

  // 7. Bob cannot modify Alice's connection
  const bobPatch = await api('PATCH', `/users/@me/connections/${steam.id}`, bob.token, { show_on_profile: true });
  assert.equal(bobPatch.status, 404);

  // 8. Alice updates steam to show_on_profile: true
  const patchRes = await api('PATCH', `/users/@me/connections/${steam.id}`, alice.token, { show_on_profile: true });
  assert.equal(patchRes.status, 200);
  assert.equal(patchRes.body.show_on_profile, true);

  // 9. Now Bob sees both in Alice's profile
  const profile2 = (await api('GET', `/users/${alice.id}/profile`, bob.token)).body;
  assert.equal(profile2.connected_accounts.length, 2);

  // 10. Delete steam connection
  const delRes = await api('DELETE', `/users/@me/connections/${steam.id}`, alice.token);
  assert.ok(delRes.status === 204 || delRes.status === 200);

  // 11. Profile now only has 1
  const profile3 = (await api('GET', `/users/${alice.id}/profile`, bob.token)).body;
  assert.equal(profile3.connected_accounts.length, 1);
  assert.equal(profile3.connected_accounts[0].type, 'github');
});
