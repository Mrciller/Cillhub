import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, createHash, randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { startServer } from './helpers.js';

// Tiny CBOR encoder (ints, byte/text strings, maps) to build attestationObjects like an authenticator.
function cbor(v) {
  const head = (mt, n) => n < 24 ? Buffer.from([mt << 5 | n]) : n < 256 ? Buffer.from([mt << 5 | 24, n]) : Buffer.from([mt << 5 | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (typeof v === 'string') return Buffer.concat([head(3, Buffer.byteLength(v)), Buffer.from(v)]);
  return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
}

function authenticator(type) {
  const { publicKey, privateKey } = type === 'rsa' ? generateKeyPairSync('rsa', { modulusLength: 2048 })
    : type === 'ec' ? generateKeyPairSync('ec', { namedCurve: 'P-256' }) : generateKeyPairSync('ed25519');
  const j = publicKey.export({ format: 'jwk' });
  const b = s => Buffer.from(s, 'base64url');
  const cose = type === 'ec' ? new Map([[1, 2], [3, -7], [-1, 1], [-2, b(j.x)], [-3, b(j.y)]])
    : type === 'rsa' ? new Map([[1, 3], [3, -257], [-1, b(j.n)], [-2, b(j.e)]])
    : new Map([[1, 1], [3, -8], [-1, 6], [-2, b(j.x)]]);
  const id = randomBytes(16);
  let count = 0;
  const authData = (rpId, extra = Buffer.alloc(0), flags = 0x01) => {
    const c = Buffer.alloc(4); c.writeUInt32BE(count++);
    return Buffer.concat([createHash('sha256').update(rpId).digest(), Buffer.from([flags]), c, extra]);
  };
  const clientData = (type, challenge, rpId) => Buffer.from(JSON.stringify({ type, challenge, origin: `http://${rpId}:3000` })).toString('base64url');
  return {
    id: id.toString('base64url'),
    register(opts) {
      const len = Buffer.from([0, id.length]);
      const ad = authData(opts.rp.id, Buffer.concat([Buffer.alloc(16), len, id, cbor(cose)]), 0x41);
      return { id: id.toString('base64url'), response: { clientDataJSON: clientData('webauthn.create', opts.challenge, opts.rp.id), attestationObject: cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', ad]])).toString('base64url') } };
    },
    sign(opts, key = privateKey) {
      const ad = authData(opts.rpId);
      const cd = clientData('webauthn.get', opts.challenge, opts.rpId);
      const sig = sign(type === 'ed25519' ? null : 'sha256', Buffer.concat([ad, createHash('sha256').update(b(cd)).digest()]), key);
      return { id: id.toString('base64url'), response: { clientDataJSON: cd, authenticatorData: ad.toString('base64url'), signature: sig.toString('base64url') } };
    },
  };
}

test('WebAuthn / Passkey: real signatures log in, forged assertions do not', async () => {
  const srv = await startServer();
  try {
    const alice = await srv.register('alice');
    const mallory = await srv.register('mallory');
    for (const type of ['ec', 'rsa', 'ed25519']) {
      const auth = authenticator(type);
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
