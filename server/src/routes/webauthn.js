import { randomBytes, createHash, createVerify } from 'node:crypto';
import { get, all, run, userById } from '../db.js';
import { issueToken } from '../auth.js';
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

const loginSettings = userId => { const s = settingsOf(userId); return { locale: s.locale, theme: s.theme }; };
const loginTail = user => ({ user_settings: loginSettings(user.id), ...(user.require_password_change && { required_actions: ['update_password'] }) });

function registerOptions(ctx) {
  cleanChallenges();
  const challenge = randomBytes(32).toString('base64url');
  registerChallenges.set(ctx.user.id, { challenge, expires: Date.now() + 5 * 60 * 1000 });
  const host = ctx.headers.host ? ctx.headers.host.split(':')[0] : 'localhost';
  return {
    challenge,
    rp: { name: 'Cillhub', id: host },
    user: {
      id: Buffer.from(ctx.user.id).toString('base64url'),
      name: ctx.user.email || ctx.user.username,
      displayName: ctx.user.global_name || ctx.user.username,
    },
    pubKeyCredParams: [
      { alg: -7, type: 'public-key' },   // ES256
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
  if (!cred?.id || !cred?.response) throw invalid('credential', 'BASE_TYPE_REQUIRED', 'Valid WebAuthn credential required.');
  const clientDataRaw = Buffer.from(cred.response.clientDataJSON, 'base64url').toString('utf8');
  let clientData;
  try { clientData = JSON.parse(clientDataRaw); } catch { throw invalid('clientDataJSON', 'JSON_INVALID', 'Invalid clientDataJSON.'); }

  if (clientData.challenge !== pending.challenge) {
    throw new HttpError(400, 0, 'WebAuthn challenge mismatch.');
  }

  const pubKey = cred.response.publicKey || cred.publicKey || cred.response.attestationObject || cred.id;
  const nickname = str(ctx.body, 'nickname', 0, 64) || 'Passkey';
  const now = new Date().toISOString();

  run(`INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, nickname, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET public_key = excluded.public_key, nickname = excluded.nickname`,
    cred.id, ctx.user.id, pubKey, JSON.stringify(cred.response.transports || []), nickname, now);

  return { ok: true, id: cred.id, nickname, created_at: now };
}

function authenticateOptions(ctx) {
  cleanChallenges();
  const challenge = randomBytes(32).toString('base64url');
  const challengeId = randomBytes(16).toString('hex');
  const host = ctx.headers.host ? ctx.headers.host.split(':')[0] : 'localhost';

  let allowCredentials = [];
  const login = ctx.body?.login;
  let targetUserId = null;
  if (typeof login === 'string' && login.trim()) {
    const user = get(`SELECT * FROM users WHERE ${login.includes('@') ? 'email' : 'username'} = ?`, login.trim());
    if (user) {
      targetUserId = user.id;
      allowCredentials = all('SELECT id, transports FROM webauthn_credentials WHERE user_id = ?', user.id).map(r => ({
        id: r.id,
        type: 'public-key',
        transports: JSON.parse(r.transports || '[]'),
      }));
    }
  }

  authChallenges.set(challenge, { expires: Date.now() + 5 * 60 * 1000, targetUserId });

  return {
    challenge,
    timeout: 60000,
    rpId: host,
    allowCredentials,
  };
}

function authenticateVerify(ctx) {
  cleanChallenges();
  const cred = ctx.body?.credential ?? ctx.body;
  if (!cred?.id || !cred?.response) throw invalid('credential', 'BASE_TYPE_REQUIRED', 'Valid WebAuthn credential required.');

  const clientDataRaw = Buffer.from(cred.response.clientDataJSON, 'base64url').toString('utf8');
  let clientData;
  try { clientData = JSON.parse(clientDataRaw); } catch { throw invalid('clientDataJSON', 'JSON_INVALID', 'Invalid clientDataJSON.'); }

  const challengeInfo = authChallenges.get(clientData.challenge);
  if (!challengeInfo) throw new HttpError(400, 0, 'Invalid or expired WebAuthn authentication challenge.');
  authChallenges.delete(clientData.challenge);

  const stored = get('SELECT * FROM webauthn_credentials WHERE id = ?', cred.id);
  if (!stored) throw notFound(10013, 'WebAuthn credential not found.');

  const user = userById(stored.user_id);
  if (!user) throw notFound(10013, 'User not found.');
  if (user.disabled) throw new HttpError(400, 20013, 'This account has been disabled.');
  if (!localLoginOpen() && !user.instance_admin) throw new HttpError(403, 0, 'This instance only allows sign-in with the hub.');

  // If public key is a PEM string or standard public key, verify signature if present
  if (cred.response.signature && stored.public_key.includes('BEGIN PUBLIC KEY')) {
    try {
      const authData = Buffer.from(cred.response.authenticatorData, 'base64url');
      const clientDataHash = createHash('sha256').update(Buffer.from(cred.response.clientDataJSON, 'base64url')).digest();
      const signedData = Buffer.concat([authData, clientDataHash]);
      const verifier = createVerify('SHA256');
      verifier.update(signedData);
      const sig = Buffer.from(cred.response.signature, 'base64url');
      if (!verifier.verify(stored.public_key, sig)) {
        throw unauthorized();
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      // If signature parsing fails, require signature validity
      throw unauthorized();
    }
  }

  const now = new Date().toISOString();
  run('UPDATE webauthn_credentials SET last_used_at = ?, counter = counter + 1 WHERE id = ?', now, stored.id);

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
