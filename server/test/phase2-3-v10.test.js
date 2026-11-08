import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

test('Anti-Raid and Quarantine Configuration (Contract v10 §4)', async () => {
  const srv = await startServer();
  try {
    const { token } = (await srv.api('POST', '/auth/register', null, {
      email: 'owner@example.com',
      username: 'owner',
      password: 'password123',
    })).body;

    const guild = (await srv.api('POST', '/guilds', token, { name: 'Raid Shield Guild' })).body;

    // 1. Get initial anti-raid config
    const getRes = await srv.api('GET', `/guilds/${guild.id}/anti-raid`, token);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.anti_raid.enabled, false);

    // 2. Update anti-raid config
    const putRes = await srv.api('PUT', `/guilds/${guild.id}/anti-raid`, token, {
      enabled: true,
      join_threshold: 5,
      action: 'quarantine',
      auto_pause_invites: true,
    });
    assert.equal(putRes.status, 200);
    assert.equal(putRes.body.anti_raid.enabled, true);
    assert.equal(putRes.body.anti_raid.join_threshold_per_minute, 5);
    assert.equal(putRes.body.anti_raid.auto_pause_invites, true);

    const checkRes = await srv.api('GET', `/guilds/${guild.id}/anti-raid`, token);
    assert.equal(checkRes.body.anti_raid.join_threshold_per_minute, 5);
  } finally {
    await srv.stop();
  }
});

test('Server Backup and Migration Archive (.cillpack) (Contract v10 §5)', async () => {
  const srv = await startServer();
  try {
    const { token } = (await srv.api('POST', '/auth/register', null, {
      email: 'owner@example.com',
      username: 'owner',
      password: 'password123',
    })).body;

    const guild = (await srv.api('POST', '/guilds', token, { name: 'Source Guild' })).body;

    // Create a custom channel in source guild
    const ch = (await srv.api('POST', `/guilds/${guild.id}/channels`, token, {
      name: 'announcements-backup',
      type: 0,
    })).body;

    // Export backup
    const exportRes = await srv.api('GET', `/guilds/${guild.id}/backup-export`, token);
    assert.equal(exportRes.status, 200);
    assert.equal(exportRes.body.version, 1);
    assert.equal(exportRes.body.guild.name, 'Source Guild');
    assert(Array.isArray(exportRes.body.guild.channels));
    assert(exportRes.body.guild.channels.some(c => c.name === 'announcements-backup'));

    // Restore into a new guild
    const restoreRes = await srv.api('POST', '/guilds/backup-restore', token, {
      name: 'Restored Guild',
      channels: exportRes.body.guild.channels,
      roles: exportRes.body.guild.roles,
    });
    assert.ok(restoreRes.status === 200 || restoreRes.status === 201);
    assert.equal(restoreRes.body.name, 'Restored Guild');

    // Verify channels in restored guild
    const restoredChannels = (await srv.api('GET', `/guilds/${restoreRes.body.id}/channels`, token)).body;
    assert(restoredChannels.some(c => c.name === 'announcements-backup'));
  } finally {
    await srv.stop();
  }
});

test('Calendar iCal / WebCal Feed (Contract v10 §6)', async () => {
  const srv = await startServer();
  try {
    const { token } = (await srv.api('POST', '/auth/register', null, {
      email: 'calendar_user@example.com',
      username: 'caluser',
      password: 'password123',
    })).body;

    const guild = (await srv.api('POST', '/guilds', token, { name: 'Event Guild' })).body;

    // Create a scheduled event
    const start = new Date(Date.now() + 3600_000).toISOString();
    const end = new Date(Date.now() + 7200_000).toISOString();
    const evRes = await srv.api('POST', `/guilds/${guild.id}/scheduled-events`, token, {
      name: 'Community Gaming Night',
      description: 'Weekly tournament',
      scheduled_start_time: start,
      scheduled_end_time: end,
      entity_type: 3,
      entity_metadata: { location: 'Voice Lounge' },
      privacy_level: 2,
    });
    assert.equal(evRes.status, 200);

    // Get user calendar feed
    const feedRes = await srv.api('GET', '/users/@me/calendar-feed', token);
    assert.equal(feedRes.status, 200);
    assert(feedRes.body.token);
    assert(feedRes.body.url.includes('.ics'));

    // Fetch public .ics feed
    const icsRes = await fetch(feedRes.body.url);
    assert.equal(icsRes.status, 200);
    const icsText = await icsRes.text();
    assert(icsText.includes('BEGIN:VCALENDAR'));
    assert(icsText.includes('SUMMARY:Community Gaming Night'));
    assert(icsText.includes('END:VCALENDAR'));

    // Reset calendar token
    const resetRes = await srv.api('POST', '/users/@me/calendar-feed/reset', token);
    assert.equal(resetRes.status, 200);
    assert.notEqual(resetRes.body.token, feedRes.body.token);

    // Old token should now return 404
    const oldRes = await fetch(feedRes.body.url);
    assert.equal(oldRes.status, 404);
  } finally {
    await srv.stop();
  }
});

test('Detailed Session Audit & Revoke All Others (Contract v10 §8)', async () => {
  const srv = await startServer();
  try {
    await srv.api('POST', '/auth/register', null, {
      email: 'devices@example.com',
      username: 'deviceuser',
      password: 'password123',
    });

    // Log in from two different sessions
    const session1 = (await srv.api('POST', '/auth/login', null, {
      login: 'deviceuser',
      password: 'password123',
    })).body.token;

    const session2 = (await srv.api('POST', '/auth/login', null, {
      login: 'deviceuser',
      password: 'password123',
    })).body.token;

    // Check detailed sessions from session 2
    const detailedRes = await srv.api('GET', '/auth/sessions/detailed', session2);
    assert.equal(detailedRes.status, 200);
    assert(Array.isArray(detailedRes.body.user_sessions));
    assert(detailedRes.body.user_sessions.length >= 2);
    const current = detailedRes.body.user_sessions.find(s => s.current);
    assert(current);
    assert(current.client_info);
    assert(current.client_info.ip_hash);

    // Revoke all other sessions from session 2
    const revokeRes = await srv.api('POST', '/auth/sessions/revoke-all-others', session2);
    assert.equal(revokeRes.status, 200);
    assert(revokeRes.body.revoked_count >= 1);

    // session 1 should now be unauthorized
    const testSession1 = await srv.api('GET', '/users/@me', session1);
    assert.equal(testSession1.status, 401);

    // session 2 remains valid
    const testSession2 = await srv.api('GET', '/users/@me', session2);
    assert.equal(testSession2.status, 200);
  } finally {
    await srv.stop();
  }
});

test('View-Once Media Attachments (Contract v10 §7)', async () => {
  const srv = await startServer();
  try {
    const { token } = (await srv.api('POST', '/auth/register', null, {
      email: 'viewonce@example.com',
      username: 'viewonceuser',
      password: 'password123',
    })).body;

    const guild = (await srv.api('POST', '/guilds', token, { name: 'Media Guild' })).body;
    const generalChannel = guild.channels.find(c => c.name === 'general');

    // Send a message with view_once attachment
    const r = await srv.form(
      'POST',
      `/channels/${generalChannel.id}/messages`,
      token,
      { attachments: [{ id: 0, is_view_once: true }] },
      [['files[0]', 'secret.txt', 'one-time-secret-payload', 'text/plain']]
    );
    assert.equal(r.status, 201);
    assert.equal(r.body.attachments.length, 1);
    const att = r.body.attachments[0];
    assert.equal(att.flags & 16, 16);

    // First fetch should succeed
    const firstFetch = await fetch(srv.origin + att.url);
    assert.equal(firstFetch.status, 200);
    const content = await firstFetch.text();
    assert.equal(content, 'one-time-secret-payload');

    // Wait a brief tick for finish handler to clean up
    await new Promise(res => setTimeout(res, 50));

    // Second fetch should return 404 as it self-destructed
    const secondFetch = await fetch(srv.origin + att.url);
    assert.equal(secondFetch.status, 404);
  } finally {
    await srv.stop();
  }
});
