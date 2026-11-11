// Instance address, SMTP, password reset by email and reCAPTCHA: settings validation and secret masking, the TLS-ask
// check for the bundled Caddy, forgot/reset (no account oracle, single use, expiry, sessions end, 2FA stays, limits)
// and the captcha on sign-up and forgot. Local stubs: SMTP on 127.0.0.1:3391, captcha verify on 127.0.0.1:3392.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer as tcpServer } from 'node:net';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rm, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { startServer, tempDir } from './helpers.js';

process.env.DATA_DIR = await tempDir(); // scrub() runs in-process against its own database
const { scrub, setSetting } = await import('../src/instance.js');

const SMTP_PORT = 3391;
const CAPTCHA_PORT = 3392;
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
function totp(at = Date.now()) {
  const key = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef]); // = SECRET
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(msg).digest();
  return String((h.readUInt32BE(h[19] & 0xf) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// a minimal SMTP server: accepts everything, keeps each message as {to, data}
const mails = [];
const smtp = tcpServer(sock => {
  sock.write('220 stub\r\n');
  let buf = '', inData = false, msg = { to: [], data: '' };
  sock.on('data', chunk => {
    buf += chunk;
    for (let i; (i = buf.indexOf('\r\n')) >= 0;) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (inData) {
        if (line === '.') { inData = false; mails.push(msg); msg = { to: [], data: '' }; sock.write('250 queued\r\n'); } else msg.data += `${line}\n`;
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO') sock.write('250-stub\r\n250 AUTH PLAIN LOGIN\r\n');
      else if (cmd === 'AUTH') sock.write('235 ok\r\n');
      else if (cmd === 'RCPT') { msg.to.push(line.match(/<(.*)>/)?.[1]); sock.write('250 ok\r\n'); }
      else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') sock.end('221 bye\r\n');
      else sock.write('250 ok\r\n');
    }
  });
  sock.on('error', () => {});
});
// captcha verify stub: response "good" passes, "bad" fails, "down" drops the connection
const captcha = httpServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    const f = new URLSearchParams(body);
    if (f.get('response') === 'down') return req.socket.destroy();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: f.get('secret') === 'captcha-secret-kim' && f.get('response') === 'good' }));
  });
});

const wait = ms => new Promise(r => setTimeout(r, ms));
// turns 2FA on and trades a backup code for a 5-minute elevation header (admin settings need the step-up)
async function elevation(s, token) {
  const on = await s.api('POST', '/users/@me/mfa/totp/enable', token, { password: 'hunter2hunter2', secret: SECRET, code: totp() });
  assert.equal(on.status, 200);
  const ticket = (await s.api('POST', '/users/@me/mfa/totp/disable', token, {})).body.mfa.ticket;
  const r = await s.api('POST', '/mfa/finish', token, { ticket, mfa_type: 'backup', data: on.body.backup_codes[0].code });
  return { 'X-Cillhub-MFA-Authorization': r.body.token };
}
async function mailTo(addr, ms = 3000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(50)) {
    const m = mails.find(x => x.to.includes(addr));
    if (m) return mails.splice(mails.indexOf(m), 1)[0];
  }
  return null;
}
// the link is quoted-printable in the mail body
const linkIn = m => m.data.replace(/=\n/g, '').replace(/=3D/g, '=').match(/https:\/\/\S+\/reset#token=([\w-]+)/);

let srv, api, root;
let forgotCalls = 0; // every counted POST /auth/forgot from 127.0.0.1 (10 per hour)
const forgot = (login, extra = {}) => (forgotCalls++, api('POST', '/auth/forgot', null, { login, ...extra }));
const reg = (name, extra = {}) => api('POST', '/auth/register', null, { age_confirmed: true, email: `${name}@example.com`, username: name, password: 'hunter2hunter2', ...extra });
const dbGet = sql => { const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite')); try { return db.prepare(sql).get(); } finally { db.close(); } };
const dbRun = (sql, ...args) => { const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite')); try { return db.prepare(sql).run(...args); } finally { db.close(); } };

before(async () => {
  await new Promise(r => smtp.listen(SMTP_PORT, '127.0.0.1', r));
  await new Promise(r => captcha.listen(CAPTCHA_PORT, '127.0.0.1', r));
  const staticDir = await mkdtemp(join(tmpdir(), 'cillhub-static-'));
  await writeFile(join(staticDir, 'index.html'), '<!doctype html>');
  srv = await startServer({
    env: {
      STATIC_DIR: staticDir,
      CILLCORD_RATE_LIMIT_SCALE: '1', CILLCORD_HOSTNAME: 'old.example.org', CILLCORD_PUBLIC_URL: 'https://old.example.org',
      CAPTCHA_VERIFY_URL: `http://127.0.0.1:${CAPTCHA_PORT}/verify`,
    },
  });
  api = srv.api;
  root = await srv.register('jordan');
  const el = await elevation(srv, root.token);
  api = (m, p, t, b, h = {}) => srv.api(m, p, t, b, t === root.token ? { ...el, ...h } : h); // mail, address and captcha settings need the step-up
  execFileSync(process.execPath, ['src/admin-cli.js', 'grant', 'jordan'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: srv.dataDir } });
});
after(async () => {
  await srv.stop();
  smtp.close();
  captcha.close();
  await rm(process.env.DATA_DIR, { recursive: true, force: true });
});

test('public URL: validation, precedence over CILLCORD_PUBLIC_URL, TLS-ask allows only our own names', async () => {
  const patch = body => api('PATCH', '/admin/settings', root.token, body);
  for (const bad of ['ftp://chat.example.org', 'http://chat.example.org', 'https://alex:pw@chat.example.org', 'not a url', `https://${'a'.repeat(250)}.org`, 42]) {
    assert.equal((await patch({ public_url: bad })).status, 400, String(bad));
  }
  assert.equal((await api('GET', '/admin/settings', root.token)).body.public_url_effective, 'https://old.example.org', 'env when unset');
  assert.equal((await api('GET', '/gateway')).body.url, 'wss://old.example.org/gateway');
  const s = (await patch({ public_url: 'https://Chat.Example.org/some/path?x=1' })).body;
  assert.deepEqual([s.public_url, s.public_url_effective], ['https://chat.example.org', 'https://chat.example.org']);
  assert.equal((await api('GET', '/gateway')).body.url, 'wss://chat.example.org/gateway');
  assert.equal((await patch({ public_url: 'http://localhost:3390' })).body.public_url, 'http://localhost:3390');

  const ask = async d => (await fetch(`${srv.base}/instance/tls-allowed?domain=${encodeURIComponent(d)}`)).status;
  assert.equal(await ask('localhost'), 200, 'the admin-set name');
  assert.equal(await ask('old.example.org'), 200, 'CILLCORD_HOSTNAME keeps working');
  assert.equal(await ask('chat.example.org'), 403, 'no longer set');
  assert.equal(await ask('evil.example.com'), 403);
  assert.equal(await ask(''), 403);
  await patch({ public_url: 'https://chat.example.org' });
  assert.equal(await ask('CHAT.example.org'), 200);
  assert.equal((await patch({ public_url: '' })).body.public_url, null);
  assert.equal((await api('GET', '/gateway')).body.url, 'wss://old.example.org/gateway');
  await patch({ public_url: 'https://chat.example.org' });
});

test('SMTP and captcha secrets are write-only: masked in GET, the audit log, the public instance; test mail', async () => {
  const patch = body => api('PATCH', '/admin/settings', root.token, body);
  assert.equal((await forgot('alex@example.com')).status, 400, 'no SMTP yet');
  forgotCalls--; // refused before the limit counts
  assert.equal((await api('GET', '/instance')).body.password_reset, false);
  for (const bad of [{ smtp_port: 0 }, { smtp_port: 70000 }, { smtp_security: 'ssl' }, { smtp_from: 'no-reply' }, { smtp_from: 'a@b@c' },
    { smtp_host: 'mail.example.org\r\nRCPT TO:<kim@example.com>' }, { smtp_password: 'pw\nx' }, { smtp_from: 'x@example.org\nBcc: kim@example.com' }]) {
    assert.equal((await patch(bad)).status, 400, JSON.stringify(bad));
  }
  const set = await patch({
    smtp_host: '127.0.0.1', smtp_port: SMTP_PORT, smtp_security: 'none', smtp_user: 'mailer', smtp_password: 'pw-Secret-123',
    smtp_from: 'Cillhub <no-reply@example.org>', captcha_site_key: 'site-key-kim', captcha_secret: 'captcha-secret-kim',
  });
  assert.equal(set.status, 200);
  const got = (await api('GET', '/admin/settings', root.token)).body;
  assert.deepEqual([got.smtp_password_set, got.captcha_secret_set, got.smtp_host, got.captcha_site_key], [true, true, '127.0.0.1', 'site-key-kim']);
  assert.ok(!('smtp_password' in got) && !('captcha_secret' in got));
  const pub = (await api('GET', '/instance')).body;
  assert.deepEqual([pub.password_reset, pub.captcha], [true, { service: 'recaptcha', sitekey: 'site-key-kim' }]);
  const [entry] = (await api('GET', '/admin/audit-log?action=settings.update', root.token)).body;
  assert.deepEqual([entry.details.before.smtp_password, entry.details.after.smtp_password, entry.details.after.captcha_secret], ['(cleared)', '(set)', '(set)']);
  const everything = JSON.stringify([got, pub, (await api('GET', '/admin/audit-log', root.token)).body, (await api('GET', '/admin/overview', root.token)).body]);
  assert.ok(!everything.includes('pw-Secret-123') && !everything.includes('captcha-secret-kim'), 'no secret anywhere');

  // absent keeps, null clears, a string sets
  assert.equal((await patch({ smtp_port: SMTP_PORT })).body.smtp_password_set, true);
  assert.equal((await patch({ captcha_secret: null })).body.captcha_secret_set, false);
  assert.equal((await api('GET', '/instance')).body.captcha, null, 'captcha needs both keys');
  const [cleared] = (await api('GET', '/admin/audit-log?action=settings.update', root.token)).body;
  assert.deepEqual([cleared.details.before.captcha_secret, cleared.details.after.captcha_secret], ['(set)', '(cleared)']);

  const r = await api('POST', '/admin/settings/test-mail', root.token, {});
  assert.deepEqual(r.body, { ok: true, error: null });
  const m = await mailTo('jordan@example.com');
  assert.match(m.data, /Test mail from Cillhub/);
  assert.equal((await api('GET', '/admin/audit-log?action=settings.test_mail', root.token)).body[0].details.ok, true);

  // an unreachable SMTP server: the error text comes back without the password
  await patch({ smtp_port: 3399 });
  const down = (await api('POST', '/admin/settings/test-mail', root.token, {})).body;
  assert.equal(down.ok, false);
  assert.match(down.error, /ECONNREFUSED|connect/i);
  await patch({ smtp_port: SMTP_PORT });

  // scrub() removes the secret values even when no pattern matches them
  setSetting('smtp_password', 'Sam7pass');
  assert.equal(scrub('535 rejected Sam7pass for mailer'), '535 rejected [redacted] for mailer');
});

test('forgot and reset: no account oracle, single use, expiry, sessions end, 2FA stays, per-address and per-IP limits', async () => {
  const alex = await srv.register('alex');
  const kim = await srv.register('kim');
  assert.equal((await api('POST', '/users/@me/mfa/totp/enable', kim.token, { password: 'hunter2hunter2', secret: SECRET, code: totp() })).status, 200);
  const gw = await srv.gateway(alex.token);

  const unknown = await forgot('nobody@example.com');
  assert.equal(unknown.status, 204);
  // a forged Host header must not reach the link (it would carry the token to someone else's server)
  forgotCalls++;
  const known = await new Promise((resolve, reject) => {
    const req = httpRequest(`${srv.base}/auth/forgot`, { method: 'POST', headers: { Host: 'evil.example.com', 'X-Forwarded-Host': 'evil.example.com', 'Content-Type': 'application/json' } },
      res => (res.resume(), resolve({ status: res.statusCode })));
    req.on('error', reject);
    req.end(JSON.stringify({ login: 'alex@example.com' }));
  });
  assert.equal(known.status, 204);
  const m = await mailTo('alex@example.com');
  assert.ok(m, 'mail sent to alex');
  assert.equal(await mailTo('nobody@example.com', 300), null, 'none for an unknown address');
  assert.match(m.data, /Reset your password on Cillhub/);
  assert.match(m.data, /30 minutes/);
  const [, token] = linkIn(m);
  assert.match(linkIn(m)[0], /^https:\/\/chat\.example\.org\/reset#token=/, 'link on the public URL, token in the fragment (never in a log)');
  assert.ok(!m.data.includes('evil'), 'no forged host in the mail');

  const reset = (t, password = 'new-pass-alex') => api('POST', '/auth/reset', null, { token: t, password });
  assert.equal((await reset('wrong-token')).body.message, 'This link is invalid or has expired.');
  assert.equal((await reset(token, 'short')).status, 400);
  const ok = await reset(token);
  assert.equal(ok.status, 204);
  assert.equal(ok.body, null, 'no token handed out');
  assert.equal((await reset(token, 'another-pass')).status, 400, 'single use');
  assert.equal((await api('GET', '/users/@me', alex.token)).status, 401, 'old session revoked');
  assert.equal(await gw.closed, 4004);
  assert.equal((await api('POST', '/auth/login', null, { login: 'alex', password: 'hunter2hunter2' })).status, 401);
  assert.ok((await api('POST', '/auth/login', null, { login: 'alex', password: 'new-pass-alex' })).body.token);

  // expired
  assert.equal((await forgot('alex@example.com')).status, 204);
  const [, late] = linkIn(await mailTo('alex@example.com'));
  dbRun('UPDATE password_resets SET expires_at = 1');
  assert.equal((await reset(late)).status, 400);

  // 2FA still applies after a reset
  assert.equal((await forgot('kim@example.com')).status, 204);
  const [, kt] = linkIn(await mailTo('kim@example.com'));
  assert.equal((await reset(kt, 'new-pass-kim')).status, 204);
  const login = (await api('POST', '/auth/login', null, { login: 'kim', password: 'new-pass-kim' })).body;
  assert.deepEqual([login.mfa, !!login.ticket, login.token], [true, true, undefined]);

  // 3 per address per hour, the 4th is answered the same but sends nothing
  assert.equal((await forgot('alex@example.com')).status, 204);
  assert.ok(await mailTo('alex@example.com'));
  assert.equal((await forgot('alex@example.com')).status, 204);
  assert.equal(await mailTo('alex@example.com', 500), null, 'silently limited');

  // captcha on: register and forgot need it; checked before anything else; fails closed
  await api('PATCH', '/admin/settings', root.token, { captcha_secret: 'captcha-secret-kim' });
  const none = await reg('robin');
  assert.deepEqual(none.body, { message: 'Complete the captcha.', captcha_key: ['captcha-required'], captcha_sitekey: 'site-key-kim', captcha_service: 'recaptcha' });
  assert.deepEqual((await reg('robin', { captcha_key: 'bad' })).body.captcha_key, ['invalid-response']);
  const down = await reg('robin', { captcha_key: 'down' });
  assert.equal(down.status, 400);
  assert.match(down.body.message, /unavailable/);
  assert.deepEqual((await reg('jordan', { captcha_key: 'bad' })).body.captcha_key, ['invalid-response'], 'before the taken-name answer');
  assert.equal((await reg('robin', { captcha_key: 'good' })).status, 201);
  assert.deepEqual((await forgot('alex@example.com')).body.captcha_key, ['captcha-required']);
  await api('PATCH', '/admin/settings', root.token, { captcha_secret: null });
  assert.equal((await reg('taylor')).status, 201, 'captcha off: as before');

  // 10 per IP per hour, then 429 with retry_after
  while (forgotCalls < 10) assert.equal((await forgot(`sam${forgotCalls}@example.com`)).status, 204);
  const limited = await forgot('sam@example.com');
  assert.equal(limited.status, 429);
  assert.ok(limited.body.retry_after > 0);
});

test('no configured address: password reset is off (the Host header never builds a link); closed before captcha', async () => {
  const other = await startServer(); // no CILLCORD_PUBLIC_URL
  try {
    const t = (await other.register('taylor')).token;
    const el = await elevation(other, t);
    execFileSync(process.execPath, ['src/admin-cli.js', 'grant', 'taylor'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: other.dataDir } });
    await other.api('PATCH', '/admin/settings', t, { smtp_host: '127.0.0.1', smtp_port: SMTP_PORT, smtp_security: 'none', smtp_from: 'no-reply@example.org' }, el);
    assert.equal((await other.api('GET', '/instance')).body.password_reset, false);
    assert.equal((await other.api('POST', '/auth/forgot', null, { login: 'taylor@example.com' })).status, 400);
    await other.api('PATCH', '/admin/settings', t, { public_url: 'https://chat.example.org' }, el);
    assert.equal((await other.api('GET', '/instance')).body.password_reset, true);
    // a closed instance says so before asking for a captcha
    await other.api('PATCH', '/admin/settings', t, { captcha_site_key: 'site-key-kim', captcha_secret: 'captcha-secret-kim', registration_mode: 'closed' }, el);
    const closed = await other.api('POST', '/auth/register', null, { age_confirmed: true, email: 'kim@example.com', username: 'kim', password: 'hunter2hunter2' });
    assert.deepEqual([closed.status, closed.body.message], [403, 'Registration is closed on this instance.']);
  } finally {
    await other.stop();
  }
});

test('app CSP: reCAPTCHA script hosts only while captcha is on, without a restart', async () => {
  const scripts = async () => (await fetch(`${srv.origin}/login`)).headers.get('content-security-policy').match(/script-src [^;]*/)[0];
  await api('PATCH', '/admin/settings', root.token, { captcha_site_key: 'site-key-kim', captcha_secret: 'captcha-secret-kim' });
  assert.match(await scripts(), /https:\/\/www\.google\.com\/recaptcha\/ https:\/\/www\.gstatic\.com\/recaptcha\//);
  await api('PATCH', '/admin/settings', root.token, { captcha_secret: null });
  assert.equal(await scripts(), "script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com");
});

test('a pending reset link dies when the email or the password changes', async () => {
  const sam = await srv.register('sam');
  const ask = async addr => {
    assert.equal((await api('POST', '/auth/forgot', null, { login: addr }, { 'X-Forwarded-For': '2001:db8:77::1' })).status, 204);
    return linkIn(await mailTo(addr))[1];
  };
  const reset = t => api('POST', '/auth/reset', null, { token: t, password: 'new-pass-sam' });
  const t1 = await ask('sam@example.com');
  assert.equal((await api('PATCH', '/users/@me', sam.token, { email: 'sam2@example.com', password: 'hunter2hunter2' })).status, 200);
  assert.equal((await reset(t1)).status, 400, 'email change');
  const t2 = await ask('sam2@example.com');
  assert.equal((await api('PATCH', '/users/@me', sam.token, { new_password: 'other-pass-sam', password: 'hunter2hunter2' })).status, 200);
  assert.equal((await reset(t2)).status, 400, 'password change');
});

test('forgot answers before any lookup or write: same reply and speed for every address', async () => {
  // with the database write-locked from outside, the old code failed or waited on its writes; now the 204 is already out
  const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite'));
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const addr of ['robin@example.com', 'nobody@example.com']) {
      assert.equal((await api('POST', '/auth/forgot', null, { login: addr }, { 'X-Forwarded-For': '2001:db8:78::1' })).status, 204, addr);
    }
  } finally {
    db.exec('ROLLBACK');
    db.close();
  }
  assert.equal(await mailTo('robin@example.com', 300), null, 'the failed background work sent nothing');
  assert.equal((await api('POST', '/auth/forgot', null, { login: 'robin@example.com' }, { 'X-Forwarded-For': '2001:db8:78::1' })).status, 204);
  assert.ok(await mailTo('robin@example.com'), 'mail once the database is free');
});

test('no reset mail to an address list stored before 7.10.1', async () => {
  dbRun("INSERT INTO users (id, email, username, password_hash, salt) VALUES ('900000000000000001', 'kim@x.test,1', 'kim-old', 'x', 'x')");
  const ask = addr => api('POST', '/auth/forgot', null, { login: addr }, { 'X-Forwarded-For': '2001:db8:79::1' });
  assert.equal((await ask('kim@x.test,1')).status, 204);
  assert.equal(await mailTo('kim@x.test', 500), null, 'nothing sent');
  assert.equal(dbGet("SELECT COUNT(*) AS n FROM password_resets WHERE user_id = '900000000000000001'").n, 0, 'no reset row');
  assert.equal((await ask('sam2@example.com')).status, 204);
  assert.ok(await mailTo('sam2@example.com'), 'a normal account still gets one');
});

test('a look-alike address does not use up the reset budget of a real one; the reply stays the same', async () => {
  const ask = addr => api('POST', '/auth/forgot', null, { login: addr }, { 'X-Forwarded-For': '2001:db8:80::1' });
  for (let i = 0; i < 3; i++) assert.equal((await ask('Kim@example.com')).status, 204); // Kelvin sign: lower-cases to k, but no account matches it
  assert.equal(await mailTo('kim@example.com', 300), null);
  assert.equal((await ask('kim@example.com')).status, 204);
  assert.ok(await mailTo('kim@example.com'), 'the real address still gets its mail');
});
