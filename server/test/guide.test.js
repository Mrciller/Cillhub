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

test('server guide: get default, put requires MANAGE_GUILD, emits GUILD_UPDATE, get reflects changes', async () => {
  const guildId = g.guild.id;

  // 1. Initial GET
  const init = (await api('GET', `/guilds/${guildId}/guide`, alice.token)).body;
  assert.equal(init.guild_id, guildId);
  assert.equal(init.enabled, false);
  assert.equal(init.welcome_message, null);
  assert.deepEqual(init.new_member_actions, []);
  assert.deepEqual(init.resource_pages, []);

  // 2. Stranger gets 403/404
  const strangerRes = await api('GET', `/guilds/${guildId}/guide`, stranger.token);
  assert.ok(strangerRes.status === 403 || strangerRes.status === 404);

  // 3. Bob (non-admin, no MANAGE_GUILD) tries to PUT
  const bobPut = await api('PUT', `/guilds/${guildId}/guide`, bob.token, {
    enabled: true,
    welcome_message: 'Welcome by Bob',
  });
  assert.equal(bobPut.status, 403);

  // 4. Alice (owner, has MANAGE_GUILD) PUTs guide
  const putRes = await api('PUT', `/guilds/${guildId}/guide`, alice.token, {
    enabled: true,
    welcome_message: 'Welcome to our awesome server!',
    new_member_actions: [
      {
        title: 'Say hello in general',
        description: 'Introduce yourself to the community',
        channel_id: g.general.id,
        icon: 'wave',
      },
      {
        title: 'Check announcements',
        description: 'Stay updated',
        channel_id: g.general.id,
        icon: 'megaphone',
      },
    ],
    resource_pages: [
      {
        title: 'Rules and Guidelines',
        description: 'Read our community rules before posting',
        channel_id: g.general.id,
        icon: 'book',
      },
    ],
  });

  assert.equal(putRes.status, 200);
  assert.equal(putRes.body.guild_id, guildId);
  assert.equal(putRes.body.enabled, true);
  assert.equal(putRes.body.welcome_message, 'Welcome to our awesome server!');
  assert.equal(putRes.body.new_member_actions.length, 2);
  assert.ok(putRes.body.new_member_actions[0].id);
  assert.equal(putRes.body.new_member_actions[0].title, 'Say hello in general');
  assert.equal(putRes.body.resource_pages.length, 1);
  assert.ok(putRes.body.resource_pages[0].id);
  assert.equal(putRes.body.resource_pages[0].title, 'Rules and Guidelines');

  // 5. Bob receives GUILD_UPDATE with guide payload
  const ev = await bob.gw.event('GUILD_UPDATE', e => e.id === guildId && e.guide != null);
  assert.equal(ev.guide.enabled, true);
  assert.equal(ev.guide.welcome_message, 'Welcome to our awesome server!');
  assert.equal(ev.guide.new_member_actions.length, 2);

  // 6. Bob GETs guide
  const bobGet = (await api('GET', `/guilds/${guildId}/guide`, bob.token)).body;
  assert.equal(bobGet.enabled, true);
  assert.equal(bobGet.welcome_message, 'Welcome to our awesome server!');
  assert.equal(bobGet.new_member_actions.length, 2);
  assert.equal(bobGet.resource_pages.length, 1);
});
