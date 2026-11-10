// node --test selfhost/test/updater-feed.test.mjs: the updater's check of the signed latest.json (key list, expiry, minimum version)
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyFeed, parseKeys } from '../updater.mjs';

const pair = () => crypto.generateKeyPairSync('ed25519');
const pem = (k) => k.publicKey.export({ type: 'spki', format: 'pem' });
const id = (k) => crypto.createHash('sha256').update(k.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
const [oldKey, newKey, evil] = [pair(), pair(), pair()];
const keys = parseKeys(pem(oldKey) + pem(newKey));
const now = Date.parse('2026-11-09T00:00:00Z');
const feed = (signer, extra = {}) => {
  const body = Buffer.from(JSON.stringify({ version: '7.1.0', url: 'https://hub.example/download/server/x.tar.gz', sha256: 'a'.repeat(64), size: 1,
    security: false, key_id: id(signer), expires: now / 1000 + 86400, min_version: null, ...extra }));
  return [body, crypto.sign(null, body, signer.privateKey)];
};

test('both pinned keys verify; an unknown key, a wrong key_id or a tampered body do not', () => {
  assert.equal(keys.size, 2);
  assert.equal(verifyFeed(...feed(oldKey), keys, null, now).version, '7.1.0');
  assert.equal(verifyFeed(...feed(newKey), keys, null, now).version, '7.1.0');
  assert.throws(() => verifyFeed(...feed(evil), keys, null, now), /does not trust/);
  const [body] = feed(evil, { key_id: id(oldKey) });
  assert.throws(() => verifyFeed(body, crypto.sign(null, body, evil.privateKey), keys, null, now), /does not verify/);
  const [b, s] = feed(oldKey);
  assert.throws(() => verifyFeed(Buffer.from(b.toString().replace('7.1.0', '7.2.0')), s, keys, null, now), /does not verify/);
});

test('expiry and minimum version', () => {
  assert.throws(() => verifyFeed(...feed(oldKey), keys, null, now + 2 * 86400e3), /expired/);
  assert.throws(() => verifyFeed(...feed(oldKey, { expires: undefined }), keys, null, now), /malformed/);
  assert.throws(() => verifyFeed(...feed(oldKey), keys, '7.2.0', now), /below the minimum version 7.2.0/);
  assert.throws(() => verifyFeed(...feed(oldKey, { min_version: '7.10.0' }), keys, '7.0.0', now), /below the minimum version 7.10.0/);
  assert.equal(verifyFeed(...feed(oldKey, { min_version: '7.1.0' }), keys, '7.0.5', now).min_version, '7.1.0');
});

test('a key list in the feed must hold valid Ed25519 keys', () => {
  assert.deepEqual(verifyFeed(...feed(oldKey, { keys: [pem(oldKey), pem(newKey)] }), keys, null, now).keys, [pem(oldKey), pem(newKey)]);
  assert.throws(() => verifyFeed(...feed(oldKey, { keys: ['nope'] }), keys, null, now), /malformed/);
  assert.throws(() => verifyFeed(...feed(oldKey, { keys: [pem(oldKey) + pem(newKey)] }), keys, null, now), /malformed/);
});

test('a key list cannot drop the key that signed the feed (no permanent lockout)', () => {
  assert.throws(() => verifyFeed(...feed(oldKey, { keys: [pem(newKey)] }), keys, null, now), /drops the key that signed it/);
  assert.throws(() => verifyFeed(...feed(oldKey, { keys: [] }), keys, null, now), /drops the key that signed it/);
  assert.deepEqual(verifyFeed(...feed(newKey, { keys: [pem(newKey)] }), keys, null, now).keys, [pem(newKey)]); // rotation: the new key retires the old
});
