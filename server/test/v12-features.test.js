import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

test('v12 features: silent messages, message requests, vanity URLs, onboarding, member safety, mutual connections', async () => {
  const srv = await startServer();
  try {
    const alice = await srv.register('alice');
    const bob = await srv.register('bob');
    const carol = await srv.register('carol');

    // 1. Mutual Friends & Guilds
    const g1 = (await srv.api('POST', '/guilds', alice.token, { name: 'Alpha Guild' })).body;
    const inv1 = (await srv.api('POST', `/channels/${g1.system_channel_id}/invites`, alice.token)).body;
    await srv.api('POST', `/invites/${inv1.code}`, bob.token);
    await srv.api('POST', `/invites/${inv1.code}`, carol.token);

    // Friendships: alice <-> bob, and alice <-> carol
    await srv.api('POST', '/users/@me/relationships', alice.token, { username: 'bob' });
    await srv.api('PUT', `/users/@me/relationships/${alice.id}`, bob.token);
    await srv.api('POST', '/users/@me/relationships', alice.token, { username: 'carol' });
    await srv.api('PUT', `/users/@me/relationships/${alice.id}`, carol.token);

    // Bob and Carol mutual friends should be [alice]
    const mf = (await srv.api('GET', `/users/${carol.id}/mutual-friends`, bob.token)).body;
    assert.equal(mf.length, 1);
    assert.equal(mf[0].id, alice.id);

    // Bob and Carol mutual guilds should be [g1]
    const mg = (await srv.api('GET', `/users/${carol.id}/mutual-guilds`, bob.token)).body;
    assert.equal(mg.length, 1);
    assert.equal(mg[0].id, g1.id);

    // 2. Silent Messages (@silent prefix)
    const silentMsg = (await srv.api('POST', `/channels/${g1.system_channel_id}/messages`, alice.token, {
      content: '@silent Hello quietly!',
    })).body;
    assert.ok(silentMsg.flags & 4096, 'Silent message should have flag 4096');

    // 3. Message Requests Inbox
    // Bob and Carol are NOT friends, but share a guild. Bob opens a DM to Carol.
    const dm = (await srv.api('POST', '/users/@me/channels', bob.token, { recipient_id: carol.id })).body;
    assert.ok(dm.id);

    // Carol checks message requests
    const reqs = (await srv.api('GET', '/users/@me/message-requests', carol.token)).body;
    assert.ok(reqs.some(r => r.id === dm.id), 'Carol should see message request from Bob');

    // Carol accepts message request
    const accepted = (await srv.api('PUT', `/users/@me/message-requests/${dm.id}`, carol.token, { status: 'accepted' })).body;
    assert.equal(accepted.status, 'accepted');

    const reqsAfter = (await srv.api('GET', '/users/@me/message-requests', carol.token)).body;
    assert.ok(!reqsAfter.some(r => r.id === dm.id), 'Accepted request should not be in pending');

    // 4. Vanity URLs
    const vanityBefore = (await srv.api('GET', `/guilds/${g1.id}/vanity-url`, alice.token)).body;
    assert.equal(vanityBefore.code, null);

    const patchedVanity = (await srv.api('PATCH', `/guilds/${g1.id}/vanity-url`, alice.token, { code: 'alphaguild' })).body;
    assert.equal(patchedVanity.code, 'alphaguild');

    // Resolve vanity url as invite
    const resolvedInvite = (await srv.api('GET', '/invites/alphaguild')).body;
    assert.equal(resolvedInvite.guild.id, g1.id);

    // 5. Community Server Onboarding
    const onboarding = (await srv.api('PUT', `/guilds/${g1.id}/onboarding`, alice.token, {
      enabled: true,
      default_channel_ids: [g1.system_channel_id],
      prompts: [
        {
          id: 'p1',
          title: 'Choose your role',
          options: [
            { id: 'opt1', title: 'Gamer', role_ids: [] },
          ],
        },
      ],
    })).body;
    assert.equal(onboarding.enabled, true);
    assert.equal(onboarding.prompts.length, 1);
    assert.equal(onboarding.default_channel_ids[0], g1.system_channel_id);

    const getOnboard = (await srv.api('GET', `/guilds/${g1.id}/onboarding`, bob.token)).body;
    assert.equal(getOnboard.enabled, true);

    // 6. Member Safety & Moderation Dashboard
    const searchMembers = (await srv.api('GET', `/guilds/${g1.id}/members/search?query=carol`, alice.token)).body;
    assert.equal(searchMembers.length, 1);
    assert.equal(searchMembers[0].user.id, carol.id);
    assert.ok('safety_signals' in searchMembers[0]);

    // Bulk timeout action on carol
    const bulkAction = (await srv.api('POST', `/guilds/${g1.id}/members/bulk-action`, alice.token, {
      action: 'timeout',
      user_ids: [carol.id],
      duration_seconds: 60,
      reason: 'Rule test',
    })).body;
    assert.equal(bulkAction.action, 'timeout');
    assert.equal(bulkAction.count, 1);

    // Verify Carol is timed out
    const carolMember = (await srv.api('GET', `/guilds/${g1.id}/members/${carol.id}`, alice.token)).body;
    assert.ok(carolMember.communication_disabled_until, 'Carol should have communication_disabled_until');
  } finally {
    await srv.stop();
  }
});
