// Test harness only (never in a release image, .dockerignore drops server/test): `node --import ./test/hub-key.mjs
// src/index.js` with CILLCORD_TEST_HUB_KEY pins that key as the network key in src/federation.js, so two local
// instances can play hub and node. Production code has no switch for this.
import { register } from 'node:module';

const key = process.env.CILLCORD_TEST_HUB_KEY;
if (!/^[A-Za-z0-9_-]{43}$/.test(key ?? '')) throw new Error('hub-key.mjs: CILLCORD_TEST_HUB_KEY must be a base64url Ed25519 public key');
register(`data:text/javascript,${encodeURIComponent(`
export async function load(url, context, next) {
  const out = await next(url, context);
  if (!url.endsWith('/src/federation.js')) return out;
  const source = String(out.source).replace(/NETWORK_KEY = '[A-Za-z0-9_-]{43}'/, "NETWORK_KEY = '${key}'");
  if (source === String(out.source)) throw new Error('hub-key.mjs: NETWORK_KEY not found in federation.js');
  return { ...out, source };
}`)}`);
