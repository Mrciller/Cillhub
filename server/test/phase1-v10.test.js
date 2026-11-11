import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

test('Custom Soundboard Packs API (Contract v10 §2)', async () => {
  const srv = await startServer();
  try {
    const { token } = (await srv.api('POST', '/auth/register', null, { age_confirmed: true,
      email: 'owner@example.com',
      username: 'owner',
      password: 'password123',
    })).body;

    const guild = (await srv.api('POST', '/guilds', token, { name: 'Sound Guild' })).body;

    // 1. Create a soundboard pack
    const createRes = await srv.api('POST', `/guilds/${guild.id}/soundboard-packs`, token, {
      name: 'Gaming SFX',
      description: 'Sound effects for clutch moments',
      icon_emoji: '🎮',
      sound_ids: ['1001', '1002'],
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.name, 'Gaming SFX');
    assert.equal(createRes.body.description, 'Sound effects for clutch moments');
    assert.equal(createRes.body.icon_emoji, '🎮');
    assert.deepEqual(createRes.body.sound_ids, ['1001', '1002']);
    const packId = createRes.body.id;

    // 2. List packs
    const listRes = await srv.api('GET', `/guilds/${guild.id}/soundboard-packs`, token);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.length, 1);
    assert.equal(listRes.body[0].id, packId);

    // 3. Update pack
    const updateRes = await srv.api('PUT', `/guilds/${guild.id}/soundboard-packs/${packId}`, token, {
      name: 'Pro Gaming SFX',
      sound_ids: ['1001', '1002', '1003'],
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateRes.body.name, 'Pro Gaming SFX');
    assert.deepEqual(updateRes.body.sound_ids, ['1001', '1002', '1003']);

    // 4. Delete pack
    const delRes = await srv.api('DELETE', `/guilds/${guild.id}/soundboard-packs/${packId}`, token);
    assert.equal(delRes.status, 204);

    const afterList = (await srv.api('GET', `/guilds/${guild.id}/soundboard-packs`, token)).body;
    assert.equal(afterList.length, 0);
  } finally {
    await srv.stop();
  }
});

test('Recurring Messages & Scheduled Announcements API (Contract v10 §3)', async () => {
  const srv = await startServer();
  try {
    const { token } = (await srv.api('POST', '/auth/register', null, { age_confirmed: true,
      email: 'organizer@example.com',
      username: 'organizer',
      password: 'password123',
    })).body;

    const guild = (await srv.api('POST', '/guilds', token, { name: 'Announcements Server' })).body;
    const generalChannelId = guild.system_channel_id;

    // 1. Create a recurring message schedule
    const createRes = await srv.api('POST', `/channels/${generalChannelId}/recurring-messages`, token, {
      content: 'Good morning everyone! Remember our daily standup at 10:00.',
      interval_type: 'daily',
      time_of_day: '09:45',
    });
    assert.equal(createRes.status, 201);
    assert.equal(createRes.body.content, 'Good morning everyone! Remember our daily standup at 10:00.');
    assert.equal(createRes.body.interval_type, 'daily');
    assert.equal(createRes.body.time_of_day, '09:45');
    assert.ok(createRes.body.next_run);
    const recurringId = createRes.body.id;

    // 2. List recurring messages in channel
    const listRes = await srv.api('GET', `/channels/${generalChannelId}/recurring-messages`, token);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.length, 1);
    assert.equal(listRes.body[0].id, recurringId);

    // 3. Delete recurring message schedule
    const delRes = await srv.api('DELETE', `/channels/${generalChannelId}/recurring-messages/${recurringId}`, token);
    assert.equal(delRes.status, 200);
    assert.equal(delRes.body.ok, true);

    const afterList = (await srv.api('GET', `/channels/${generalChannelId}/recurring-messages`, token)).body;
    assert.equal(afterList.length, 0);
  } finally {
    await srv.stop();
  }
});
