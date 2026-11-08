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

test('onboarding: get, put config, respond assigns roles, emits events, checks permissions', async () => {
  const guildId = g.guild.id;

  // Initial GET
  const init = (await api('GET', `/guilds/${guildId}/onboarding`, alice.token)).body;
  assert.equal(init.enabled, false);
  assert.deepEqual(init.prompts, []);

  // Create a role to assign via onboarding
  const gamerRole = (await api('POST', `/guilds/${guildId}/roles`, alice.token, { name: 'Gamer' })).body;

  // PUT onboarding config
  const putRes = await api('PUT', `/guilds/${guildId}/onboarding`, alice.token, {
    enabled: true,
    prompts: [
      {
        title: 'Choose your interests',
        single_select: false,
        required: true,
        options: [
          { title: 'Gaming', description: 'Access to gaming channels', role_ids: [gamerRole.id], channel_ids: [g.general.id] }
        ]
      }
    ]
  });
  assert.equal(putRes.status, 200);
  assert.equal(putRes.body.enabled, true);
  assert.equal(putRes.body.prompts.length, 1);
  const prompt = putRes.body.prompts[0];
  const option = prompt.options[0];
  assert.ok(prompt.id);
  assert.ok(option.id);

  // Bob receives GUILD_ONBOARDING_UPDATE event
  const obEv = await bob.gw.event('GUILD_ONBOARDING_UPDATE', d => d.guild_id === guildId);
  assert.equal(obEv.enabled, true);

  // Bob responds to onboarding
  const resp = await api('POST', `/guilds/${guildId}/onboarding/respond`, bob.token, {
    option_ids: [option.id]
  });
  assert.equal(resp.status, 200);
  assert.equal(resp.body.success, true);
  assert.deepEqual(resp.body.assigned_roles, [gamerRole.id]);

  // Bob should now have the role
  const member = (await api('GET', `/guilds/${guildId}/members/${bob.id}`, alice.token)).body;
  assert.ok(member.roles.includes(gamerRole.id));

  // Non-manager cannot configure onboarding
  const forbiddenPut = await api('PUT', `/guilds/${guildId}/onboarding`, bob.token, { enabled: false });
  assert.equal(forbiddenPut.status, 403);
});

test('analytics: records messages and joins, returns daily metrics to manager', async () => {
  const guildId = g.guild.id;

  // Send a message in general to trigger messages_sent metric
  await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: 'test metric' });

  // Alice (owner/manager) fetches analytics
  const res = await api('GET', `/guilds/${guildId}/analytics?days=7`, alice.token);
  assert.equal(res.status, 200);
  assert.equal(res.body.guild_id, guildId);
  assert.ok(Array.isArray(res.body.daily));
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayEntry = res.body.daily.find(d => d.date === todayStr);
  assert.ok(todayEntry);
  assert.ok(todayEntry.messages_sent >= 1);
  assert.ok(todayEntry.joins >= 1); // bob joined

  // Stranger cannot fetch analytics
  const forbidden = await api('GET', `/guilds/${guildId}/analytics`, stranger.token);
  assert.equal(forbidden.status, 403);
});
