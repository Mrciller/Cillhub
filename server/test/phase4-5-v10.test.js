import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { startServer } from './helpers.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
function totp(at = Date.now()) {
  const key = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef]);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(msg).digest();
  return String((h.readUInt32BE(h[19] & 0xf) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

test('Interactive Collaborative Whiteboard (Contract v10 §10)', async () => {
  const srv = await startServer();
  try {
    const { token } = (await srv.api('POST', '/auth/register', null, {
      email: 'whiteboard@example.com',
      username: 'wbuser',
      password: 'password123',
    })).body;

    const guild = (await srv.api('POST', '/guilds', token, { name: 'Whiteboard Guild' })).body;
    const voiceChannel = guild.channels.find(c => c.type === 2);

    // 1. Get initial whiteboard
    const initialRes = await srv.api('GET', `/channels/${voiceChannel.id}/whiteboard`, token);
    assert.equal(initialRes.status, 200);
    assert.equal(initialRes.body.channel_id, voiceChannel.id);
    assert.deepEqual(initialRes.body.strokes, []);

    // 2. Post a stroke
    const stroke = { points: [{ x: 10, y: 20 }, { x: 30, y: 40 }], color: '#ff0000', width: 3 };
    const strokeRes = await srv.api('POST', `/channels/${voiceChannel.id}/whiteboard/stroke`, token, { stroke });
    assert.equal(strokeRes.status, 200);
    assert.deepEqual(strokeRes.body.stroke, stroke);

    // 3. Verify stroke was appended
    const updatedRes = await srv.api('GET', `/channels/${voiceChannel.id}/whiteboard`, token);
    assert.equal(updatedRes.status, 200);
    assert.equal(updatedRes.body.strokes.length, 1);
    assert.deepEqual(updatedRes.body.strokes[0], stroke);

    // 4. Clear whiteboard
    const clearRes = await srv.api('DELETE', `/channels/${voiceChannel.id}/whiteboard`, token);
    assert.equal(clearRes.status, 200);
    assert.equal(clearRes.body.cleared, true);

    const clearedRes = await srv.api('GET', `/channels/${voiceChannel.id}/whiteboard`, token);
    assert.equal(clearedRes.body.strokes.length, 0);
  } finally {
    await srv.stop();
  }
});

test('Federation Directory, DMs and Telemetry (Contract v10 §11, §12, §13)', async () => {
  const srv = await startServer();
  try {
    const { token } = (await srv.api('POST', '/auth/register', null, {
      email: 'fedadmin@example.com',
      username: 'fedadmin',
      password: 'password123',
    })).body;

    const me = (await srv.api('GET', '/users/@me', token)).body;

    // 1. User Node Lookup (§11)
    const lookupRes = await srv.api('GET', `/federation/users/${me.id}/node`, null);
    assert.equal(lookupRes.status, 200);
    assert.equal(lookupRes.body.hub_user_id, me.id);
    assert.ok(lookupRes.body.public_key);

    // 2. Route Federated DM Envelope (§11)
    const dmRes = await srv.api('POST', '/federation/dm/envelope', null, {
      recipient_id: me.id,
      sender_id: 'remote_user_42',
      encrypted_payload: 'cipher-text-blob',
      signature: 'mock-sig',
    });
    assert.equal(dmRes.status, 200);
    assert.equal(dmRes.body.delivered, true);
    assert.equal(dmRes.body.recipient_id, me.id);

    // 3. Federated Public Channel Directory (§12)
    const pubRes = await srv.api('PUT', '/federation/public-channels', null, {
      channels: [
        { id: '1001', name: 'general-federated', topic: 'Chat across instances', guild_name: 'Argon Hub' },
        { id: '1002', name: 'dev-discuss', topic: 'Core protocol engineering', guild_name: 'Argon Hub' },
      ],
    });
    assert.equal(pubRes.status, 200);
    assert.equal(pubRes.body.published, 2);

    const dirSearch = await srv.api('GET', '/federation/directory/channels?query=dev', null);
    assert.equal(dirSearch.status, 200);
    assert.equal(dirSearch.body.channels.length, 1);
    assert.equal(dirSearch.body.channels[0].name, 'dev-discuss');

    // 4. Node Telemetry Monitor (§13)
    // Enable 2FA on fedadmin and grant instance admin via CLI
    const mfaRes = await srv.api('POST', '/users/@me/mfa/totp/enable', token, {
      password: 'password123',
      secret: SECRET,
      code: totp(),
    });
    assert.equal(mfaRes.status, 200);

    execFileSync(process.execPath, ['src/admin-cli.js', 'grant', 'fedadmin'], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, DATA_DIR: srv.dataDir },
      encoding: 'utf8',
    });

    const telemetryRes = await srv.api('GET', '/admin/federation/telemetry', token);
    assert.equal(telemetryRes.status, 200);
    assert.equal(telemetryRes.body.status, 'healthy');
    assert.ok(telemetryRes.body.memory.rss_mb >= 0);
    assert.ok(telemetryRes.body.hub_sync);
  } finally {
    await srv.stop();
  }
});
