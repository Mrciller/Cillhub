import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { startServer, guildWith, until, tempDir } from './helpers.js';

// a fake Google: the OAuth2 token endpoint and the FCM v1 send endpoint
let google, livekit, srv, api, alice, bob, keyDir;
const tokenRequests = [];
const sends = [];
let sendStatus = 200;
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

before(async () => {
  google = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      if (req.url === '/token') {
        tokenRequests.push(new URLSearchParams(body));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600, token_type: 'Bearer' }));
      }
      sends.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      res.writeHead(sendStatus, { 'Content-Type': 'application/json' });
      res.end(sendStatus === 200 ? '{"name":"projects/test-proj/messages/1"}'
        : JSON.stringify({ error: { code: 404, status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } }));
    });
  });
  livekit = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); }); });
  await new Promise(r => google.listen(0, '127.0.0.1', r));
  await new Promise(r => livekit.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${google.address().port}`;
  keyDir = await tempDir();
  const keyFile = join(keyDir, 'service-account.json');
  await writeFile(keyFile, JSON.stringify({
    type: 'service_account', project_id: 'test-proj', client_email: 'fcm@test-proj.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }), token_uri: `${base}/token`,
  }));
  srv = await startServer({ env: {
    FCM_SERVICE_ACCOUNT_FILE: keyFile, FCM_API_BASE: base,
    LIVEKIT_URL: `http://127.0.0.1:${livekit.address().port}`, LIVEKIT_PUBLIC_URL: 'wss://lk.example/livekit', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 's',
  } });
  api = srv.api;
  ({ alice, bob } = (await guildWith(srv, ['alice', 'bob'])).users);
});
after(async () => { await srv.stop(); google.close(); livekit.close(); await rm(keyDir, { recursive: true, force: true }); });

const FCM_TOKEN = `dGVzdA:APA91b${'x'.repeat(140)}`;

test('FCM (Android app): registration, data-only pushes with ids, call rings, dead tokens removed', async () => {
  assert.deepEqual((await api('GET', '/push/fcm')).body, { enabled: true });
  assert.equal((await api('POST', '/users/@me/fcm-tokens', bob.token, { token: 'short' })).status, 400);
  assert.equal((await api('POST', '/users/@me/fcm-tokens', bob.token, { token: 'x y'.repeat(20) })).status, 400);
  assert.equal((await api('POST', '/users/@me/fcm-tokens', bob.token, { token: FCM_TOKEN })).status, 204);

  // bob has no gateway session (app closed): a DM is pushed with ids only, never the text
  const dm = (await api('POST', '/users/@me/channels', alice.token, { recipient_id: bob.id })).body;
  const sent = (await api('POST', `/channels/${dm.id}/messages`, alice.token, { content: 'secret words' })).body;
  const push = await until(() => sends[0]);
  assert.equal(push.url, '/v1/projects/test-proj/messages:send');
  assert.equal(push.auth, 'Bearer ya29.test');
  assert.deepEqual(push.body.message, {
    token: FCM_TOKEN, data: { type: 'message', channel_id: dm.id, message_id: sent.id }, android: { priority: 'HIGH', ttl: '3600s' },
  });
  assert.ok(!JSON.stringify(push.body).includes('secret'), 'no message content goes through Google');

  // the access token came from a correctly signed JWT grant
  const grant = tokenRequests[0];
  assert.equal(grant.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
  const [h, p, sig] = grant.get('assertion').split('.');
  assert.ok(createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url')));
  const claims = JSON.parse(Buffer.from(p, 'base64url'));
  assert.equal(claims.iss, 'fcm@test-proj.iam.gserviceaccount.com');
  assert.equal(claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
  assert.equal(claims.aud, `http://127.0.0.1:${google.address().port}/token`);

  // a second push reuses the cached access token
  await api('POST', `/channels/${dm.id}/messages`, alice.token, { content: 'again' });
  await until(() => sends[1]);
  assert.equal(tokenRequests.length, 1);

  // muted DMs: nothing
  await api('PATCH', '/users/@me/guilds/@me/settings', bob.token, { muted: true });
  await api('POST', `/channels/${dm.id}/messages`, alice.token, { content: 'muted?' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(sends.length, 2);
  await api('PATCH', '/users/@me/guilds/@me/settings', bob.token, { muted: false });

  // an incoming call rings through FCM with a short TTL
  const agw = await srv.gateway(alice.token);
  agw.send({ op: 4, d: { guild_id: null, channel_id: dm.id, self_mute: false, self_deaf: false } });
  await agw.event('CALL_CREATE');
  assert.equal((await api('POST', `/channels/${dm.id}/call/ring`, alice.token, {})).status, 204);
  const ring = await until(() => sends.find(s => s.body.message.data.type === 'call'));
  assert.deepEqual(ring.body.message.data, { type: 'call', channel_id: dm.id });
  assert.equal(ring.body.message.android.ttl, '60s');
  agw.send({ op: 4, d: { guild_id: null, channel_id: null } });

  // FCM says the token is gone: it is deleted and not used again
  sendStatus = 404;
  const before = sends.length;
  await api('POST', `/channels/${dm.id}/messages`, alice.token, { content: 'to a dead token' });
  await until(() => sends.length > before);
  sendStatus = 200;
  await new Promise(r => setTimeout(r, 200));
  await api('POST', `/channels/${dm.id}/messages`, alice.token, { content: 'nobody' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(sends.length, before + 1);

  // register again, then unregister: nothing more
  assert.equal((await api('POST', '/users/@me/fcm-tokens', bob.token, { token: FCM_TOKEN })).status, 204);
  assert.equal((await api('DELETE', '/users/@me/fcm-tokens', bob.token, { token: FCM_TOKEN })).status, 204);
  await api('POST', `/channels/${dm.id}/messages`, alice.token, { content: 'unregistered' });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(sends.length, before + 1);
});

test('FCM is off without a service-account key', async () => {
  const plain = await startServer();
  try {
    assert.deepEqual((await plain.api('GET', '/push/fcm')).body, { enabled: false });
  } finally {
    await plain.stop();
  }
});
