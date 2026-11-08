// Firebase Cloud Messaging (HTTP v1) for the Android app; off unless FCM_SERVICE_ACCOUNT_FILE names a service-account key.
// Messages are data-only and carry ids, never message text: the app fetches content itself with its own token.
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';

const FILE = process.env.FCM_SERVICE_ACCOUNT_FILE;
const API = process.env.FCM_API_BASE || 'https://fcm.googleapis.com'; // FCM_API_BASE: tests only

function loadAccount() {
  if (!FILE) return null;
  const a = JSON.parse(readFileSync(FILE, 'utf8'));
  for (const k of ['project_id', 'client_email', 'private_key']) if (typeof a[k] !== 'string' || !a[k]) throw new Error(`FCM key file: missing ${k}`);
  return { ...a, token_uri: a.token_uri || 'https://oauth2.googleapis.com/token' };
}
const account = loadAccount();
export const fcmEnabled = !!account;

let cached = { token: null, until: 0 };
// OAuth2 access token from a self-signed JWT (RS256), cached until five minutes before it expires
async function accessToken() {
  if (cached.token && Date.now() < cached.until) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
    iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: account.token_uri, iat: now, exp: now + 3600,
  })}`;
  const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(account.private_key, 'base64url')}`;
  const res = await fetch(account.token_uri, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }), signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`FCM token request failed: ${res.status}`);
  const body = await res.json();
  cached = { token: body.access_token, until: Date.now() + (Number(body.expires_in) || 3600) * 1000 - 300_000 };
  return cached.token;
}

// one data message to one registration token; resolves 'gone' when FCM says the token is dead (delete it), else 'ok'/'error'
export async function sendFcm(token, data, ttlSeconds = 3600) {
  if (!account) return 'error';
  try {
    const res = await fetch(`${API}/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: { token, data, android: { priority: 'HIGH', ttl: `${ttlSeconds}s` } } }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return 'ok';
    const err = await res.json().catch(() => ({}));
    const code = err?.error?.details?.find?.(d => d.errorCode)?.errorCode;
    if (res.status === 404 || code === 'UNREGISTERED' || (res.status === 400 && code === 'INVALID_ARGUMENT')) return 'gone';
    if (res.status === 401) cached = { token: null, until: 0 };
    console.error(`fcm send failed: ${res.status} ${code ?? ''}`); // never log the registration token
    return 'error';
  } catch (e) {
    console.error(`fcm send failed: ${e.message}`);
    return 'error';
  }
}
