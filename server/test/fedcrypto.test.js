// v7 federation crypto in-process: signed requests (window, tampering, wrong key, replay), EdDSA ID tokens
// (signature, iss, aud, expiry, alg), PKCE S256
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  signRequest, verifyRequest, ReplayCache, signJwt, verifyJwt, pkceChallenge, pkceOk, publicKeyText, publicKeyFrom, signResponse, verifyResponse,
} from '../src/fedcrypto.js';

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const other = generateKeyPairSync('ed25519');

test('signed requests: good signature accepted once; tampering, wrong key, old or future timestamps and replays refused', () => {
  const replay = new ReplayCache();
  const body = '{"name":"node"}';
  const h = signRequest(privateKey, '42', 'POST', '/api/v9/federation/heartbeat', body)['Cillhub-Signature'];
  const check = (over = {}) => verifyRequest({ header: h, method: 'POST', path: '/api/v9/federation/heartbeat', body: Buffer.from(body), keyFor: id => id === '42' && publicKey, replay, ...over });
  assert.equal(check({ body: Buffer.from('{"name":"evil"}') }), 'bad signature');
  assert.equal(check({ path: '/api/v9/federation/notify' }), 'bad signature');
  assert.equal(check({ method: 'PUT' }), 'bad signature');
  assert.equal(check({ keyFor: () => other.publicKey }), 'bad signature');
  assert.equal(check({ keyFor: () => null }), 'unknown key');
  assert.equal(check({ header: 'nonsense' }), 'missing or malformed Cillhub-Signature');
  assert.equal(check({ now: Date.now() + 305_000 }), 'signature outside the 5-minute window');
  assert.equal(check({ now: Date.now() - 305_000 }), 'signature outside the 5-minute window');
  assert.equal(check(), null);
  assert.equal(check(), 'replayed request');
  // an empty body signs as the empty string
  const g = signRequest(privateKey, '42', 'POST', '/x')['Cillhub-Signature'];
  assert.equal(verifyRequest({ header: g, method: 'POST', path: '/x', body: Buffer.alloc(0), keyFor: () => publicKey, replay }), null);
  // the same call twice in one second (e.g. two heartbeats) is two requests, not a replay
  const again = signRequest(privateKey, '42', 'POST', '/x')['Cillhub-Signature'];
  assert.notEqual(again, g);
  assert.equal(verifyRequest({ header: again, method: 'POST', path: '/x', body: Buffer.alloc(0), keyFor: () => publicKey, replay }), null);
});

test('ID tokens: EdDSA signature, issuer, audience and expiry are all checked', () => {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: 'https://hub.example', aud: '7', sub: '100', iat: now, exp: now + 300, username: 'alice' };
  const t = signJwt(privateKey, claims);
  const opts = { iss: 'https://hub.example', aud: '7' };
  assert.equal(verifyJwt(t, publicKey, opts).username, 'alice');
  assert.equal(verifyJwt(t, publicKey, { ...opts, aud: '8' }), null, 'another node cannot use it');
  assert.equal(verifyJwt(t, publicKey, { ...opts, iss: 'https://evil.example' }), null);
  assert.equal(verifyJwt(t, other.publicKey, opts), null, 'wrong key');
  assert.equal(verifyJwt(t, publicKey, { ...opts, now: (now + 301) * 1000 }), null, 'expired');
  const [h, , s] = t.split('.');
  const forged = Buffer.from(JSON.stringify({ ...claims, sub: '1' })).toString('base64url');
  assert.equal(verifyJwt(`${h}.${forged}.${s}`, publicKey, opts), null, 'changed claims');
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${forged}.`;
  assert.equal(verifyJwt(none, publicKey, opts), null, 'alg none');
  assert.equal(verifyJwt('garbage', publicKey, opts), null);
});

test('PKCE S256 and key encoding', () => {
  const verifier = randomBytes(32).toString('base64url');
  assert.ok(pkceOk(verifier, pkceChallenge(verifier)));
  assert.ok(!pkceOk(`${verifier}x`, pkceChallenge(verifier)));
  assert.ok(!pkceOk('short', pkceChallenge('short')), 'verifier must be 43-128 characters');
  const x = publicKeyText(privateKey);
  assert.equal(x.length, 43);
  assert.equal(publicKeyText(publicKeyFrom(x)), x);
  assert.equal(publicKeyFrom('not a key'), null);
});

test('signed answers: bound to the key, the path, the challenge and the body, inside the window', () => {
  const body = Buffer.from('{"status":"active"}');
  const h = signResponse(privateKey, '/api/v9/federation/heartbeat', 'abcdefghijklmnop', body);
  const check = (over = {}) => verifyResponse({ header: h, path: '/api/v9/federation/heartbeat', challenge: 'abcdefghijklmnop', body, publicKey, ...over });
  assert.equal(check(), null);
  assert.equal(check(), null, 'an answer is checked against its own challenge, so no replay cache');
  assert.equal(check({ publicKey: other.publicKey }), 'bad answer signature');
  assert.equal(check({ challenge: 'ponmlkjihgfedcba' }), 'bad answer signature');
  assert.equal(check({ path: '/api/v9/federation/token' }), 'bad answer signature');
  assert.equal(check({ body: Buffer.from('{"status":"banned"}') }), 'bad answer signature');
  assert.equal(check({ header: undefined }), 'unsigned answer');
  assert.equal(check({ now: Date.now() + 301_000 }), 'answer signed outside the 5-minute window');
  // a request signature can never pass as an answer (different signing string)
  const req = signRequest(privateKey, 'hub', 'POST', '/api/v9/federation/heartbeat', body)['Cillhub-Signature'];
  assert.equal(check({ header: req }), 'unsigned answer');
});
