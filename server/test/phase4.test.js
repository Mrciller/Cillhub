import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { authenticator } from './authenticator.js';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startServer } from './helpers.js';

test('WebAuthn / Passkey: real signatures log in, forged assertions do not', async () => {
  const srv = await startServer();
  try {
    const alice = await srv.register('alice');
    const mallory = await srv.register('mallory');
    for (const type of ['ec', 'rsa', 'ed25519']) {
      const auth = authenticator(type, srv.origin);
      // adding a passkey needs the password (audit M2)
      assert.equal((await srv.api('POST', '/auth/webauthn/register/options', alice.token)).status, 400);
      const regOptions = (await srv.api('POST', '/auth/webauthn/register/options', alice.token, { password: 'hunter2hunter2' })).body;
      assert.ok(regOptions.pubKeyCredParams.some(p => p.alg === -8));
      const reg = await srv.api('POST', '/auth/webauthn/register/verify', alice.token, { credential: auth.register(regOptions), nickname: 'Key ' + type });
      assert.equal(reg.status, 200, JSON.stringify(reg.body));

      // Another user cannot take over the credential id.
      const steal = await srv.api('POST', '/auth/webauthn/register/verify', mallory.token, { credential: auth.register((await srv.api('POST', '/auth/webauthn/register/options', mallory.token, { password: 'hunter2hunter2' })).body) });
      assert.equal(steal.status, 400);

      // Options never reveal credential ids, even when asked about a user.
      const opts = async () => (await srv.api('POST', '/auth/webauthn/authenticate/options', null, { login: 'alice' })).body;
      assert.deepEqual((await opts()).allowCredentials, []);

      const login = async credential => srv.api('POST', '/auth/webauthn/authenticate/verify', null, { credential });
      // Forged: no signature, a signature by another key, a reused challenge.
      const noSig = auth.sign(await opts()); delete noSig.response.signature;
      assert.equal((await login(noSig)).status, 400);
      const other = type === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 }) : type === 'ec' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('ed25519');
      assert.equal((await login(auth.sign(await opts(), other.privateKey))).status, 401);
      assert.equal((await login(auth.sign(await opts(), undefined, 0x01))).body.message, 'WebAuthn user verification required.');
      const o = await opts();
      const ok = await login(auth.sign(o));
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.user_id, alice.id);
      assert.equal((await login(auth.sign(o))).status, 400);
    }
    const creds = (await srv.api('GET', '/users/@me/webauthn/credentials', alice.token)).body;
    assert.equal(creds.length, 3);
    assert.equal((await srv.api('DELETE', `/users/@me/webauthn/credentials/${creds[0].id}`, alice.token)).status, 200);
    assert.equal((await srv.api('GET', '/users/@me/webauthn/credentials', alice.token)).body.length, 2);
    // a password change removes every passkey: one added with a stolen token must not outlive the reset
    assert.equal((await srv.api('PATCH', '/users/@me', alice.token, { password: 'hunter2hunter2', new_password: 'hunter3hunter3' })).status, 200);
    assert.equal((await srv.api('GET', '/users/@me/webauthn/credentials', alice.token)).body.length, 0);
    // password re-entry with a token is under the login lock (audit M1)
    for (let i = 0; i < 10; i++) assert.equal((await srv.api('POST', '/auth/webauthn/register/options', mallory.token, { password: 'wrongwrong' })).status, 400);
    assert.equal((await srv.api('POST', '/auth/webauthn/register/options', mallory.token, { password: 'hunter2hunter2' })).status, 429);
  } finally {
    await srv.stop();
  }
});

test('Federated Public Module Catalog (Contract v9 §10)', async () => {
  const srv = await startServer();
  try {
    const { token } = (await srv.api('POST', '/auth/register', null, { age_confirmed: true,
      email: 'admin@example.com',
      username: 'admin',
      password: 'password123',
    })).body;

    // Grant instance admin and 2FA
    const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite'));
    db.exec("UPDATE users SET instance_admin = 1, mfa_secret = 'JBSWY3DPEHPK3PXP' WHERE email = 'admin@example.com'");
    db.close();

    // 1. Browse catalog (public and admin)
    const catalogRes = await srv.api('GET', '/federation/modules');
    assert.equal(catalogRes.status, 200);
    assert.ok(Array.isArray(catalogRes.body));
    const welcomeMod = catalogRes.body.find(m => m.id === 'welcome-roles');
    assert.ok(welcomeMod);
    assert.equal(welcomeMod.name, 'Welcome Roles');
    assert.deepEqual(welcomeMod.permissions, ['members.read', 'messages.send', 'roles.manage']);

    // 2. Stage install from catalog
    const stageRes = await srv.api('POST', '/admin/modules/install-from-catalog', token, {
      module_id: 'welcome-roles',
    });
    assert.equal(stageRes.status, 201);
    assert.ok(stageRes.body.package_id);
    assert.equal(stageRes.body.manifest.id, 'welcome-roles');
    assert.deepEqual(stageRes.body.manifest.permissions, ['members.read', 'messages.send', 'roles.manage']);
  } finally {
    await srv.stop();
  }
});

// The v9 draft's free-form key blobs and type 100 messages are retired: encrypted DMs live in e2ee.test.js
test('the v9 E2EE draft shapes are refused', async () => {
  const srv = await startServer();
  try {
    const alex = await srv.register('alex_e2ee');
    const put = await srv.api('PUT', '/users/@me/e2ee/keys', alex.token, { identity_key: 'alex-public-identity-key-base64', signed_prekey: 'x', signature: 'y' });
    assert.equal(put.status, 400);
  } finally {
    await srv.stop();
  }
});
