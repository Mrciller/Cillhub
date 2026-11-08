// v7 federation crypto without database access: Ed25519 keys, signed hub<->node requests, EdDSA ID tokens, PKCE.
// Kept free of db.js so the tests can use it in-process.
import { createHash, createPublicKey, generateKeyPairSync, sign, verify, randomBytes, timingSafeEqual } from 'node:crypto';

const b64u = buf => Buffer.from(buf).toString('base64url');
export const sha256 = data => createHash('sha256').update(data).digest();

// public keys travel as base64url of the raw 32 bytes (JWK "x")
export const publicKeyText = key => (key.type === 'private' ? createPublicKey(key) : key).export({ format: 'jwk' }).x;
export function publicKeyFrom(x) {
  if (typeof x !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(x)) return null;
  try { return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' }); } catch { return null; }
}
export const newKeyPair = () => generateKeyPairSync('ed25519');

// --- signed requests: Cillhub-Signature: keyId="<id>", created=<unix s>, nonce="<base64url>", signature="<base64url>" --
// signing string: METHOD \n path-with-query \n created \n nonce \n sha-256 digest of the body (base64url). The nonce keeps
// two identical calls in the same second (Ed25519 signatures are deterministic) from looking like a replay.
export const WINDOW_S = 300;
const signingString = (method, path, created, nonce, body) => `${method.toUpperCase()}\n${path}\n${created}\n${nonce}\n${b64u(sha256(body ?? ''))}`;

export function signRequest(privateKey, keyId, method, path, body = '', now = Date.now()) {
  const created = Math.floor(now / 1000);
  const nonce = b64u(randomBytes(12));
  const signature = b64u(sign(null, Buffer.from(signingString(method, path, created, nonce, body)), privateKey));
  return { 'Cillhub-Signature': `keyId="${keyId}", created=${created}, nonce="${nonce}", signature="${signature}"` };
}

export function parseSignature(header) {
  const m = /^keyId="([\w.-]{1,64})", created=(\d{1,12}), nonce="([A-Za-z0-9_-]{16})", signature="([A-Za-z0-9_-]{86})"$/.exec(String(header ?? ''));
  return m && { keyId: m[1], created: Number(m[2]), nonce: m[3], signature: m[4] };
}

// replay cache: a signature is accepted once while it is inside the window
export class ReplayCache {
  seen = new Map(); // signature -> expiry ms
  use(sig, now = Date.now()) {
    if (this.seen.size > 20_000) for (const [k, t] of this.seen) if (t <= now) this.seen.delete(k);
    if ((this.seen.get(sig) ?? 0) > now) return false;
    this.seen.set(sig, now + 2 * WINDOW_S * 1000);
    return true;
  }
}

// null when fine, else the reason; keyFor(keyId) gives the public key object or null
export function verifyRequest({ header, method, path, body, keyFor, replay, now = Date.now() }) {
  const p = parseSignature(header);
  if (!p) return 'missing or malformed Cillhub-Signature';
  if (Math.abs(now / 1000 - p.created) > WINDOW_S) return 'signature outside the 5-minute window';
  const key = keyFor(p.keyId);
  if (!key) return 'unknown key';
  if (!verify(null, Buffer.from(signingString(method, path, p.created, p.nonce, body)), key, Buffer.from(p.signature, 'base64url'))) return 'bad signature';
  if (!replay.use(p.signature, now)) return 'replayed request';
  return null;
}

// --- signed answers: the hub signs its answer to a call that carries Cillhub-Challenge (16 base64url chars, random per
// call), so a node trusts an answer only from the holder of the network hub key, bound to the call it made.
// Cillhub-Response-Signature: created=<unix s>, signature="<base64url>" over RESPONSE \n path \n created \n challenge \n digest
export const CHALLENGE = /^[A-Za-z0-9_-]{16}$/;
export function signResponse(privateKey, path, challenge, body = '', now = Date.now()) {
  const created = Math.floor(now / 1000);
  const signature = b64u(sign(null, Buffer.from(signingString('RESPONSE', path, created, challenge, body)), privateKey));
  return `created=${created}, signature="${signature}"`;
}
// null when fine, else the reason
export function verifyResponse({ header, path, challenge, body, publicKey, now = Date.now() }) {
  const m = /^created=(\d{1,12}), signature="([A-Za-z0-9_-]{86})"$/.exec(String(header ?? ''));
  if (!m) return 'unsigned answer';
  if (Math.abs(now / 1000 - Number(m[1])) > WINDOW_S) return 'answer signed outside the 5-minute window';
  const ok = verify(null, Buffer.from(signingString('RESPONSE', path, Number(m[1]), challenge, body)), publicKey, Buffer.from(m[2], 'base64url'));
  return ok ? null : 'bad answer signature';
}

// --- EdDSA JWTs (ID tokens) -------------------------------------------------------------------------------------------
export function signJwt(privateKey, payload) {
  const head = b64u(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${b64u(sign(null, Buffer.from(`${head}.${body}`), privateKey))}`;
}

// the claims when the signature, iss, aud and exp check out, else null
export function verifyJwt(token, publicKey, { iss, aud, now = Date.now() }) {
  const parts = String(token ?? '').split('.');
  if (parts.length !== 3) return null;
  try {
    const head = JSON.parse(Buffer.from(parts[0], 'base64url'));
    if (head.alg !== 'EdDSA') return null;
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'))) return null;
    const c = JSON.parse(Buffer.from(parts[1], 'base64url'));
    if (c.iss !== iss || c.aud !== aud || typeof c.exp !== 'number' || c.exp * 1000 <= now || typeof c.sub !== 'string') return null;
    return c;
  } catch {
    return null;
  }
}

// --- PKCE (S256 only) --------------------------------------------------------------------------------------------------
export const pkceChallenge = verifier => b64u(sha256(verifier));
export function pkceOk(verifier, challenge) {
  if (typeof verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const a = Buffer.from(pkceChallenge(verifier)), b = Buffer.from(String(challenge));
  return a.length === b.length && timingSafeEqual(a, b);
}

export const randomCode = (bytes = 24) => b64u(randomBytes(bytes));
export const sameText = (a, b) => {
  const x = sha256(String(a)), y = sha256(String(b));
  return timingSafeEqual(x, y);
};
