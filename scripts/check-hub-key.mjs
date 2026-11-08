// Checks which federation key a running network hub uses, over its public HTTPS URL only (read-only GET requests):
//   1. GET <url>/.well-known/cillhub must say role "hub" and serve the expected public key;
//   2. proof of possession: GET <url>/api/v9/federation/nodes without a token, with a random Cillhub-Challenge; the 401
//      answer must carry a Cillhub-Response-Signature that verifies with the expected key (servers from 2026-11-05 on).
// Usage: node scripts/check-hub-key.mjs <hub-url> [public-key]   (key default: the key pinned in server/src/federation.js)
// Exit: 0 key served and proven, 1 mismatch or error, 3 key served but the hub does not sign answers yet (older version).
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { publicKeyFrom, verifyResponse } from '../server/src/fedcrypto.js';

const [url, keyArg] = process.argv.slice(2);
if (!url) {
  console.error('usage: node scripts/check-hub-key.mjs <hub-url> [public-key]');
  process.exit(1);
}
const base = new URL(url).origin;
const pinned = /export const NETWORK_KEY = '([A-Za-z0-9_-]{43})'/.exec(readFileSync(new URL('../server/src/federation.js', import.meta.url), 'utf8'))?.[1];
const key = keyArg ?? pinned;
const publicKey = publicKeyFrom(key);
if (!publicKey) {
  console.error(`not an Ed25519 public key (base64url, 43 characters): ${key}`);
  process.exit(1);
}
const fail = msg => { console.error(`FAIL ${msg}`); process.exit(1); };
console.log(`hub ${base}\nexpected key ${key}${key === pinned ? ' (pinned in server/src/federation.js)' : ` (pinned: ${pinned})`}`);

const wk = await (await fetch(`${base}/.well-known/cillhub`, { signal: AbortSignal.timeout(15_000) })).json();
console.log(`served: role ${wk.role}, version ${wk.version}, key ${wk.public_key}`);
if (wk.role !== 'hub') fail('the instance does not run as the hub');
if (wk.public_key !== key) fail('the hub serves another key');

const path = '/api/v9/federation/nodes';
const challenge = randomBytes(12).toString('base64url');
const r = await fetch(base + path, { headers: { 'Cillhub-Challenge': challenge }, signal: AbortSignal.timeout(15_000) });
const body = Buffer.from(await r.arrayBuffer());
const header = r.headers.get('cillhub-response-signature');
if (!header) {
  console.log('WARN the hub does not sign answers yet (runs a version from before 2026-11-05): the served key matches, possession not proven');
  process.exit(3);
}
const err = verifyResponse({ header, path, challenge, body, publicKey });
if (err) fail(`answer signature: ${err}`);
console.log('OK the hub holds the private key: its answer to a fresh challenge verifies with the expected key');
