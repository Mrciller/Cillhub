import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { startServer, guildWith, tempDir } from './helpers.js';

// in-process pieces (mfa.js opens its own database in a temp DATA_DIR)
process.env.DATA_DIR = await tempDir();
const { totpStep, seal, base32Decode } = await import('../src/totp.js');
const { verifyCode, newTicket, redeemTicket, setBackupCodes } = await import('../src/mfa.js');
const { run } = await import('../src/db.js');

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
function code(secret, at = Date.now()) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(msg).digest();
  return String((h.readUInt32BE(h[19] & 0xf) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

let srv, api;
before(async () => { srv = await startServer(); api = srv.api; });
after(async () => {
  await srv.stop();
  await rm(process.env.DATA_DIR, { recursive: true, force: true }); // mfa.js's in-process database
});

test('TOTP: RFC 6238 ±1 step window; a code is accepted once per step (replay)', () => {
  const key = base32Decode(SECRET);
  const now = Date.now();
  assert.notEqual(totpStep(key, code(SECRET, now - 30_000), now), null);
  assert.notEqual(totpStep(key, code(SECRET, now + 30_000), now), null);
  assert.equal(totpStep(key, code(SECRET, now - 61_000), now), null);
  assert.equal(totpStep(key, code(SECRET, now + 61_000), now), null);
  assert.equal(totpStep(key, '12345', now), null);
  run("INSERT INTO users (id, email, username, password_hash, salt, mfa_secret) VALUES ('1', 'a@b.c', 'u1', 'x', 'y', ?)", seal(key));
  const user = { id: '1', mfa_secret: seal(key) };
  const c = code(SECRET);
  assert.equal(verifyCode(user, c), true);
  assert.equal(verifyCode(user, c), false, 'replay within the step');
  assert.equal(verifyCode(user, code(SECRET, Date.now() - 30_000)), false, 'an older step after a newer one');
});

test('backup codes are single use; MFA tickets expire after 5 minutes and die after 5 wrong codes', () => {
  setBackupCodes('1', ['abcd1234', 'zzzz9999']);
  const user = { id: '1', mfa_secret: 'x' };
  assert.equal(verifyCode(user, 'abcd1234'), true);
  assert.equal(verifyCode(user, 'abcd1234'), false);
  assert.equal(verifyCode(user, 'ABCD-1234'), false);
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
  try {
    const t = newTicket('1', 'login');
    mock.timers.tick(5 * 60 * 1000 + 1);
    assert.throws(() => redeemTicket(t, 'login', 'zzzz9999'), e => e.body.code === 60006);
    const t2 = newTicket('1', 'login');
    for (let i = 0; i < 5; i++) assert.throws(() => redeemTicket(t2, 'login', '00000000'), e => e.body.code === 60008);
    assert.throws(() => redeemTicket(t2, 'login', 'zzzz9999'), e => e.body.code === 60006);
    assert.throws(() => redeemTicket(newTicket('1', 'elevate'), 'login', 'zzzz9999'), e => e.body.code === 60006);
    assert.equal(redeemTicket(newTicket('1', 'login'), 'login', 'zzzz9999').id, '1');
  } finally {
    mock.timers.reset();
  }
});

test('wrong 2FA codes are limited per user across tickets: 10 in 15 minutes, then 429 even for a right code', () => {
  run("INSERT INTO users (id, email, username, password_hash, salt, mfa_secret) VALUES ('2', 'c@d.e', 'u2', 'x', 'y', 'x')");
  setBackupCodes('2', ['good1234']);
  const user = { id: '2', mfa_secret: 'x' };
  for (let i = 0; i < 2; i++) {
    const t = newTicket('2', 'login'); // a fresh ticket per password login does not reset the count
    for (let j = 0; j < 5; j++) assert.throws(() => redeemTicket(t, 'login', '00000000'), e => e.body.code === 60008);
  }
  assert.throws(() => redeemTicket(newTicket('2', 'login'), 'login', 'good1234'), e => e.status === 429);
  assert.throws(() => verifyCode(user, 'good1234'), e => e.status === 429, 'sensitive actions share the lock');
});

test('enable TOTP, log in with the ticket flow, backup code, disable needs a code', async () => {
  const u = await srv.register('mfa');
  const enable = body => api('POST', '/users/@me/mfa/totp/enable', u.token, body);
  assert.equal((await enable({ password: 'wrong-password' })).status, 400);
  assert.equal((await enable({ password: 'hunter2hunter2' })).body.code, 60005);
  assert.equal((await enable({ password: 'hunter2hunter2', secret: SECRET, code: '000000' })).body.code, 60008);
  const on = await enable({ password: 'hunter2hunter2', secret: SECRET, code: code(SECRET) });
  assert.equal(on.status, 200);
  assert.equal(on.body.backup_codes.length, 10);
  assert.equal((await api('GET', '/users/@me', u.token)).body.mfa_enabled, true);
  const login = (await api('POST', '/auth/login', null, { login: 'mfa', password: 'hunter2hunter2' })).body;
  assert.deepEqual([login.mfa, login.totp, login.backup, login.token], [true, true, true, undefined]);
  const backup = on.body.backup_codes[0].code;
  const viaBackup = await api('POST', '/auth/mfa/totp', null, { ticket: login.ticket, code: backup });
  assert.ok(viaBackup.body.token);
  const second = (await api('POST', '/auth/login', null, { login: 'mfa', password: 'hunter2hunter2' })).body;
  assert.equal((await api('POST', '/auth/mfa/totp', null, { ticket: second.ticket, code: backup })).body.code, 60008, 'backup code used up');
  // disabling needs a code: 401 60003 with a ticket, or the code in the body
  const off = await api('POST', '/users/@me/mfa/totp/disable', u.token, {});
  assert.deepEqual([off.status, off.body.code, typeof off.body.mfa.ticket], [401, 60003, 'string']);
  const fin = await api('POST', '/mfa/finish', u.token, { ticket: off.body.mfa.ticket, mfa_type: 'backup', data: on.body.backup_codes[1].code });
  // the older elevation header name (still sent by bot libraries) is accepted as an alias
  const app = (await api('POST', '/applications', u.token, { name: 'Alias check' })).body;
  assert.ok([200, 204].includes((await api('DELETE', `/applications/${app.id}`, u.token, undefined, { 'X-Botlib-MFA-Authorization': fin.body.token })).status));
  const disabled = await api('POST', '/users/@me/mfa/totp/disable', u.token, {}, { 'X-Cillhub-MFA-Authorization': fin.body.token });
  assert.equal(disabled.status, 200);
  assert.equal((await api('GET', '/users/@me', u.token)).body.mfa_enabled, false);
});

test('password change needs the old password and revokes every other token and session', async () => {
  const u = await srv.register('pw');
  const other = (await api('POST', '/auth/login', null, { login: 'pw', password: 'hunter2hunter2' })).body.token;
  const gw = await srv.gateway(other);
  assert.equal((await api('PATCH', '/users/@me', u.token, { password: 'nope-nope', new_password: 'newpassword1' })).status, 400);
  assert.equal((await api('PATCH', '/users/@me', u.token, { username: 'pw2' })).status, 400, 'username needs the password');
  const ok = await api('PATCH', '/users/@me', u.token, { password: 'hunter2hunter2', new_password: 'newpassword1', username: 'pw2' });
  assert.deepEqual([ok.status, ok.body.username, ok.body.token], [200, 'pw2', u.token]);
  assert.equal(await gw.closed, 4004);
  assert.equal((await api('GET', '/users/@me', other)).status, 401);
  assert.equal((await api('GET', '/users/@me', u.token)).status, 200);
  assert.equal((await api('POST', '/auth/login', null, { login: 'pw2', password: 'newpassword1' })).status, 200);
  const taken = await api('PATCH', '/users/@me', u.token, { password: 'newpassword1', email: 'mfa@example.com' });
  assert.equal(taken.body.errors.email._errors[0].code, 'EMAIL_ALREADY_REGISTERED');
});

test('sessions: listed with client info and current flag, logged out by id hash', async () => {
  const u = await srv.register('sess');
  const second = (await api('POST', '/auth/login', null, { login: 'sess', password: 'hunter2hunter2' })).body.token;
  const gw = await srv.gateway(second);
  const list = (await api('GET', '/auth/sessions', u.token)).body.user_sessions;
  assert.equal(list.length, 2);
  const other = list.find(s => !s.current);
  assert.deepEqual(other.client_info, { os: 'linux', platform: 'test', location: null });
  assert.equal((await api('POST', '/auth/sessions/logout', u.token, { session_id_hashes: [other.id_hash] })).status, 204);
  assert.equal(await gw.closed, 4004);
  assert.equal((await api('GET', '/users/@me', second)).status, 401);
});

test('login rate limit: 10 failures per account answer 429 with retry_after and rate limit headers', async () => {
  await srv.register('victim');
  for (let i = 0; i < 10; i++) assert.equal((await api('POST', '/auth/login', null, { login: 'victim', password: 'wrongwrong' })).status, 401);
  const res = await fetch(`${srv.base}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'victim', password: 'hunter2hunter2' }) });
  const body = await res.json();
  assert.equal(res.status, 429);
  assert.equal(body.global, false);
  assert.ok(body.retry_after > 800 && body.retry_after <= 900);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
});

test('login lock is per account+IP; X-Forwarded-For counts only from a trusted proxy (TRUST_PROXY)', async () => {
  const attempt = (s, xff, password) => s.api('POST', '/auth/login', null, { login: 'shared', password }, { 'X-Forwarded-For': `198.51.100.9, ${xff}` });
  await srv.register('shared');
  for (let i = 0; i < 10; i++) assert.equal((await attempt(srv, '203.0.113.1', 'wrongwrong')).status, 401);
  assert.equal((await attempt(srv, '203.0.113.1', 'hunter2hunter2')).status, 429, 'the guessing client is locked');
  // X-Real-IP is client-controlled behind proxies that pass it through (audit H3): it changes nothing
  const spoofed = await srv.api('POST', '/auth/login', null, { login: 'shared', password: 'hunter2hunter2' }, { 'X-Forwarded-For': '203.0.113.1', 'X-Real-IP': '198.51.100.77' });
  assert.equal(spoofed.status, 429, 'a spoofed X-Real-IP does not unlock');
  assert.equal((await attempt(srv, '203.0.113.2', 'hunter2hunter2')).status, 200, 'the owner on another IP is not');
  // a peer outside TRUST_PROXY cannot pick its own IP: every attempt counts against the real peer
  const untrusted = await startServer({ env: { TRUST_PROXY: '192.0.2.1' } });
  try {
    await untrusted.register('shared');
    for (let i = 0; i < 10; i++) assert.equal((await attempt(untrusted, `203.0.113.${i + 10}`, 'wrongwrong')).status, 401);
    assert.equal((await attempt(untrusted, '203.0.113.99', 'hunter2hunter2')).status, 429);
  } finally {
    await untrusted.stop();
  }
});

test('account deletion: refused while owning a guild; afterwards "Deleted User" with messages kept', async () => {
  const s = await guildWith(srv, ['owner', 'member']);
  const { owner, member } = s.users;
  const msg = (await api('POST', `/channels/${s.general.id}/messages`, member.token, { content: 'still here' })).body;
  assert.equal((await api('POST', '/users/@me/delete', owner.token, { password: 'hunter2hunter2' })).body.code, 40011);
  assert.equal((await api('POST', '/users/@me/delete', member.token, { password: 'bad-password' })).status, 400);
  // ownership transfer, then deletion
  assert.equal((await api('PATCH', `/guilds/${s.guild.id}`, owner.token, { owner_id: member.id })).body.owner_id, member.id);
  assert.equal((await api('POST', '/users/@me/delete', owner.token, { password: 'hunter2hunter2' })).status, 204);
  assert.equal((await api('GET', '/users/@me', owner.token)).status, 401);
  assert.notEqual((await api('POST', '/auth/login', null, { login: 'owner', password: 'hunter2hunter2' })).status, 200); // 401, or 429 after the rate limit test
  const gone = (await api('GET', `/users/${owner.id}`, member.token)).body;
  assert.equal(gone.global_name, 'Deleted User');
  assert.ok((await api('GET', `/channels/${s.general.id}/messages`, member.token)).body.some(m => m.id === msg.id));
  const members = (await api('GET', `/guilds/${s.guild.id}/members`, member.token)).body;
  assert.deepEqual(members.map(m => m.user.id), [member.id]);
});
