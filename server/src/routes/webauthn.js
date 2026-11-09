import { randomBytes, createHash, createPublicKey, verify } from 'node:crypto';
import { get, all, run, userById } from '../db.js';
import { issueToken, confirmPassword } from '../auth.js';
import { requireMfa } from '../mfa.js';
import { HttpError, str, invalid, unauthorized, notFound } from '../errors.js';
import { settingsOf } from '../userdata.js';
import { localLoginOpen } from '../federation.js';

// in-memory challenge caches with 5-minute TTL
const registerChallenges = new Map();
const authChallenges = new Map();

function cleanChallenges() {
  const now = Date.now();
  for (const [k, v] of registerChallenges) if (now > v.expires) registerChallenges.delete(k);
  for (const [k, v] of authChallenges) if (now > v.expires) authChallenges.delete(k);
}

// Minimal CBOR decoder (RFC 8949 major types 0-5): enough for attestationObject and COSE keys.
function cbor(buf, i = 0) {
  const ib = buf[i++], mt = ib >> 5, ai = ib & 31;
  let n = ai;
  if (ai === 24) n = buf[i++];
  else if (ai === 25) { n = buf.readUInt16BE(i); i += 2; }
  else if (ai === 26) { n = buf.readUInt32BE(i); i += 4; }
  else if (ai > 26) throw new Error('unsupported CBOR');
  if (mt === 0) return [n, i];
  if (mt === 1) return [-1 - n, i];
  if (mt === 2) return [buf.subarray(i, i + n), i + n];
  if (mt === 3) return [buf.toString('utf8', i, i + n), i + n];
  if (mt === 4 || mt === 5) {
    const out = mt === 4 ? [] : new Map();
    for (let k = 0; k < n; k++) {
      let key, val;
      if (mt === 5) [key, i] = cbor(buf, i);
      [val, i] = cbor(buf, i);
      mt === 4 ? out.push(val) : out.set(key, val);
    }
    return [out, i];
  }
  throw new Error('unsupported CBOR');
}

// COSE_Key -> KeyObject. Only ES256 (-7), EdDSA (-8) and RS256 (-257), as offered in registerOptions.
function coseKey(m) {
  const b = k => Buffer.from(m.get(k)).toString('base64url');
  const kty = m.get(1), alg = m.get(3);
  const jwk = kty === 2 && alg === -7 && m.get(-1) === 1 ? { kty: 'EC', crv: 'P-256', x: b(-2), y: b(-3) }
    : kty === 1 && alg === -8 && m.get(-1) === 6 ? { kty: 'OKP', crv: 'Ed25519', x: b(-2) }
    : kty === 3 && alg === -257 ? { kty: 'RSA', n: b(-1), e: b(-2) }
    : null;
  if (!jwk) throw new Error('unsupported key');
  return createPublicKey({ key: jwk, format: 'jwk' });
}

// attestationObject -> { authData, credId, key }
function parseAttestation(b64) {
  const authData = cbor(Buffer.from(b64, 'base64url'))[0].get('authData');
  if (!(authData[32] & 0x40)) throw new Error('no attested credential');
  const len = authData.readUInt16BE(53);
  return { authData, credId: authData.subarray(55, 55 + len).toString('base64url'), key: coseKey(cbor(authData, 55 + len)[0]) };
}

// Stored keys: SPKI PEM (current) or the raw attestationObject (rows written before 2026-11-09).
const keyOf = stored => stored.includes('BEGIN PUBLIC KEY') ? createPublicKey(stored) : parseAttestation(stored).key;

// ctx.headers are the response headers; the request's Host names the site the browser is on
const rpIdOf = ctx => ctx.req?.headers.host ? ctx.req.headers.host.split(':')[0] : 'localhost';

// Shared clientData/authData checks for both ceremonies.
function checkCeremony(cred, type, challengeOk, rpId, authData) {
  let clientData;
  try { clientData = JSON.parse(Buffer.from(cred.response.clientDataJSON, 'base64url').toString('utf8')); } catch { throw invalid('clientDataJSON', 'JSON_INVALID', 'Invalid clientDataJSON.'); }
  if (clientData.type !== type || !challengeOk(clientData.challenge)) throw new HttpError(400, 0, 'WebAuthn challenge mismatch.');
  let origin;
  try { origin = new URL(clientData.origin).hostname; } catch { origin = null; }
  if (origin !== rpId) throw new HttpError(400, 0, 'WebAuthn origin mismatch.');
  if (authData.length < 37 || !authData.subarray(0, 32).equals(createHash('sha256').update(rpId).digest())) throw new HttpError(400, 0, 'WebAuthn rpId mismatch.');
  if (!(authData[32] & 0x01)) throw new HttpError(400, 0, 'WebAuthn user presence required.');
  return clientData;
}

const loginSettings = userId => { const s = settingsOf(userId); return { locale: s.locale, theme: s.theme }; };
const loginTail = user => ({ user_settings: loginSettings(user.id), ...(user.require_password_change && { required_actions: ['update_password'] }) });

// adding a passkey needs the password and, with 2FA on, a code (body.code or the elevation header): a passkey skips both later
async function registerOptions(ctx) {
  if (!(await confirmPassword(ctx.body?.password, ctx.user, ctx.headers))) throw invalid('password', 'PASSWORD_DOES_NOT_MATCH', 'Password does not match.');
  requireMfa(ctx);
  cleanChallenges();
  const challenge = randomBytes(32).toString('base64url');
  registerChallenges.set(ctx.user.id, { challenge, expires: Date.now() + 5 * 60 * 1000 });
  return {
    challenge,
    rp: { name: 'Cillhub', id: rpIdOf(ctx) },
    user: {
      id: Buffer.from(ctx.user.id).toString('base64url'),
      name: ctx.user.email || ctx.user.username,
      displayName: ctx.user.global_name || ctx.user.username,
    },
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' },   // ES256
      { alg: -8, type: 'public-key' },   // EdDSA
      { alg: -257, type: 'public-key' }, // RS256
    ],
    timeout: 60000,
    attestation: 'none',
  };
}

function registerVerify(ctx) {
  cleanChallenges();
  const pending = registerChallenges.get(ctx.user.id);
  if (!pending) throw new HttpError(400, 0, 'No pending WebAuthn registration challenge.');
  registerChallenges.delete(ctx.user.id);

  const cred = ctx.body?.credential ?? ctx.body;
  if (typeof cred?.id !== 'string' || typeof cred?.response?.attestationObject !== 'string') throw invalid('credential', 'BASE_TYPE_REQUIRED', 'Valid WebAuthn credential required.');
  let att;
  try { att = parseAttestation(cred.response.attestationObject); } catch { throw invalid('attestationObject', 'BASE_TYPE_INVALID', 'Unsupported or invalid passkey.'); }
  if (att.credId !== cred.id) throw invalid('credential', 'BASE_TYPE_INVALID', 'Credential id mismatch.');
  checkCeremony(cred, 'webauthn.create', c => c === pending.challenge, rpIdOf(ctx), att.authData);

  const pubKey = att.key.export({ type: 'spki', format: 'pem' });
  const nickname = str(ctx.body, 'nickname', 0, 64) || 'Passkey';
  const now = new Date().toISOString();

  const { changes } = run(`INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, nickname, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING`,
    cred.id, ctx.user.id, pubKey, att.authData.readUInt32BE(33), JSON.stringify(cred.response.transports || []), nickname, now);
  if (!changes) throw new HttpError(400, 0, 'This passkey is already registered.');

  return { ok: true, id: cred.id, nickname, created_at: now };
}

// Usernameless (discoverable) flow: never hand out a user's credential ids before they authenticate.
function authenticateOptions(ctx) {
  cleanChallenges();
  const challenge = randomBytes(32).toString('base64url');
  const rpId = rpIdOf(ctx);
  authChallenges.set(challenge, { expires: Date.now() + 5 * 60 * 1000, rpId });
  return { challenge, timeout: 60000, rpId, allowCredentials: [] };
}

function authenticateVerify(ctx) {
  cleanChallenges();
  const cred = ctx.body?.credential ?? ctx.body;
  if (typeof cred?.id !== 'string' || typeof cred.response?.authenticatorData !== 'string' || typeof cred.response.signature !== 'string') throw invalid('credential', 'BASE_TYPE_REQUIRED', 'Valid WebAuthn credential required.');

  const authData = Buffer.from(cred.response.authenticatorData, 'base64url');
  let challengeInfo;
  checkCeremony(cred, 'webauthn.get', c => {
    challengeInfo = authChallenges.get(c);
    authChallenges.delete(c);
    return !!challengeInfo && Date.now() <= challengeInfo.expires;
  }, rpIdOf(ctx), authData);
  if (challengeInfo.rpId !== rpIdOf(ctx)) throw new HttpError(400, 0, 'WebAuthn rpId mismatch.');

  const stored = get('SELECT * FROM webauthn_credentials WHERE id = ?', cred.id);
  if (!stored) throw unauthorized();
  let ok = false;
  try {
    const key = keyOf(stored.public_key);
    const signed = Buffer.concat([authData, createHash('sha256').update(Buffer.from(cred.response.clientDataJSON, 'base64url')).digest()]);
    ok = verify(key.asymmetricKeyType === 'ed25519' ? null : 'sha256', signed, key, Buffer.from(cred.response.signature, 'base64url'));
  } catch { ok = false; }
  if (!ok) throw unauthorized();
  // A counter that does not grow means a cloned authenticator; 0 means the authenticator keeps no counter.
  const signCount = authData.readUInt32BE(33);
  if (signCount && signCount <= stored.counter) throw unauthorized();

  const user = userById(stored.user_id);
  if (!user) throw notFound(10013, 'User not found.');
  if (user.disabled) throw new HttpError(400, 20013, 'This account has been disabled.');
  if (!localLoginOpen() && !user.instance_admin) throw new HttpError(403, 0, 'This instance only allows sign-in with the hub.');

  run('UPDATE webauthn_credentials SET last_used_at = ?, counter = ? WHERE id = ?', new Date().toISOString(), signCount, stored.id);

  return {
    token: issueToken(user.id),
    user_id: user.id,
    ...loginTail(user),
  };
}

function listCredentials(ctx) {
  return all('SELECT id, nickname, created_at, last_used_at FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at DESC', ctx.user.id);
}

function deleteCredential(ctx) {
  const row = get('SELECT 1 FROM webauthn_credentials WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
  if (!row) throw notFound(10013, 'WebAuthn credential');
  run('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?', ctx.params.id, ctx.user.id);
  return { ok: true };
}

const user = { userOnly: true };
export default [
  ['POST', '/auth/webauthn/register/options', registerOptions, user],
  ['POST', '/auth/webauthn/register/verify', registerVerify, user],
  ['POST', '/auth/webauthn/authenticate/options', authenticateOptions, { open: true }],
  ['POST', '/auth/webauthn/authenticate/verify', authenticateVerify, { open: true }],
  ['GET', '/users/@me/webauthn/credentials', listCredentials, user],
  ['DELETE', '/users/@me/webauthn/credentials/:id', deleteCredential, user],
];
