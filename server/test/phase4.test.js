import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createSign, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startServer } from './helpers.js';

test('WebAuthn / Passkey registration and login flows (Contract v9 §9)', async () => {
  const srv = await startServer();
  try {
    const { token } = (await srv.api('POST', '/auth/register', null, {
      email: 'alice@example.com',
      username: 'alice',
      password: 'password123',
    })).body;
    const me = (await srv.api('GET', '/users/@me', token)).body;
    const userId = me.id;

    // 1. Request registration options
    const regOptions = (await srv.api('POST', '/auth/webauthn/register/options', token)).body;
    assert.ok(regOptions.challenge);
    assert.equal(regOptions.rp.name, 'Cillhub');
    assert.ok(regOptions.user.id);

    // 2. Generate a key pair to simulate authenticator
    const { publicKey, privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });

    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.create',
      challenge: regOptions.challenge,
      origin: 'http://localhost',
    })).toString('base64url');

    const credId = 'test-cred-' + Date.now();
    const regVerifyRes = await srv.api('POST', '/auth/webauthn/register/verify', token, {
      credential: {
        id: credId,
        publicKey,
        response: {
          clientDataJSON,
          transports: ['internal'],
        },
      },
      nickname: 'Work Laptop',
    });
    assert.equal(regVerifyRes.status, 200);
    assert.equal(regVerifyRes.body.ok, true);
    assert.equal(regVerifyRes.body.nickname, 'Work Laptop');

    // 3. List credentials
    const creds = (await srv.api('GET', '/users/@me/webauthn/credentials', token)).body;
    assert.equal(creds.length, 1);
    assert.equal(creds[0].id, credId);
    assert.equal(creds[0].nickname, 'Work Laptop');

    // 4. Request authentication options
    const authOptions = (await srv.api('POST', '/auth/webauthn/authenticate/options', null, {
      login: 'alice',
    })).body;
    assert.ok(authOptions.challenge);
    assert.equal(authOptions.allowCredentials.length, 1);
    assert.equal(authOptions.allowCredentials[0].id, credId);

    // 5. Sign the challenge
    const authClientData = Buffer.from(JSON.stringify({
      type: 'webauthn.get',
      challenge: authOptions.challenge,
      origin: 'http://localhost',
    })).toString('base64url');

    const authData = Buffer.from('auth-data-bytes-32-chars-long-padding');
    const clientDataHash = createHash('sha256').update(Buffer.from(authClientData, 'base64url')).digest();
    const signer = createSign('SHA256');
    signer.update(Buffer.concat([authData, clientDataHash]));
    const signature = signer.sign(privateKey).toString('base64url');

    const authVerifyRes = await srv.api('POST', '/auth/webauthn/authenticate/verify', null, {
      credential: {
        id: credId,
        response: {
          clientDataJSON: authClientData,
          authenticatorData: authData.toString('base64url'),
          signature,
        },
      },
    });
    assert.equal(authVerifyRes.status, 200);
    assert.ok(authVerifyRes.body.token);
    assert.equal(authVerifyRes.body.user_id, userId);

    // 6. Delete credential
    const delRes = await srv.api('DELETE', `/users/@me/webauthn/credentials/${credId}`, token);
    assert.equal(delRes.status, 200);
    const credsAfter = (await srv.api('GET', '/users/@me/webauthn/credentials', token)).body;
    assert.equal(credsAfter.length, 0);
  } finally {
    await srv.stop();
  }
});

test('Federated Public Module Catalog (Contract v9 §10)', async () => {
  const srv = await startServer();
  try {
    const { token } = (await srv.api('POST', '/auth/register', null, {
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

test('End-to-End Encrypted (E2EE) 1-on-1 DMs (Contract v9 §11)', async () => {
  const srv = await startServer();
  try {
    const aliceAuth = (await srv.api('POST', '/auth/register', null, {
      email: 'alice-e2ee@example.com',
      username: 'alice_e2ee',
      password: 'password123',
    })).body;
    const alice = (await srv.api('GET', '/users/@me', aliceAuth.token)).body;

    const bobAuth = (await srv.api('POST', '/auth/register', null, {
      email: 'bob-e2ee@example.com',
      username: 'bob_e2ee',
      password: 'password123',
    })).body;
    const bob = (await srv.api('GET', '/users/@me', bobAuth.token)).body;

    // 1. Alice registers her E2EE public keys
    const aliceKeys = {
      identity_key: 'alice-public-identity-key-base64',
      signed_prekey: 'alice-signed-prekey-base64',
      signature: 'alice-signature-base64',
    };
    const putRes = await srv.api('PUT', '/users/@me/e2ee/keys', aliceAuth.token, aliceKeys);
    assert.equal(putRes.status, 200);
    assert.equal(putRes.body.ok, true);

    // 2. Bob fetches Alice's public keys
    const getRes = await srv.api('GET', `/users/${alice.id}/e2ee/keys`, bobAuth.token);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.body.user_id, alice.id);
    assert.equal(getRes.body.keys.identity_key, aliceKeys.identity_key);

    // Make Alice and Bob friends so they can open a DM
    await srv.api('POST', '/users/@me/relationships', aliceAuth.token, { username: 'bob_e2ee' });
    await srv.api('PUT', `/users/@me/relationships/${alice.id}`, bobAuth.token, {});

    // 3. Open 1-on-1 DM channel
    const dmRes = await srv.api('POST', '/users/@me/channels', bobAuth.token, { recipient_id: alice.id });
    assert.equal(dmRes.status, 200);
    const dm = dmRes.body;

    // 4. Send an E2EE encrypted message
    const envelope = {
      ciphertext: '5a2b8e...base64ciphertext...',
      iv: '12-byte-iv-base64',
      sender_key: 'bob-ephemeral-key',
      recipient_key: aliceKeys.identity_key,
    };

    const msgRes = await srv.api('POST', `/channels/${dm.id}/messages`, bobAuth.token, {
      content: '', // cleartext is empty
      e2ee_envelope: envelope,
    });
    assert.equal(msgRes.status, 201);
    assert.equal(msgRes.body.type, 100);
    assert.deepEqual(msgRes.body.e2ee_envelope, envelope);

    // 5. Alice reads DM messages and sees the envelope
    const listRes = await srv.api('GET', `/channels/${dm.id}/messages`, aliceAuth.token);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.body.length, 1);
    assert.equal(listRes.body[0].type, 100);
    assert.deepEqual(listRes.body[0].e2ee_envelope, envelope);
  } finally {
    await srv.stop();
  }
});
