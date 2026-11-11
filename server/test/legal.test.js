// 7.11 legal: documents and versions, the sign-up checks and the terms gate, public notices (limits, captcha, status by
// code), statements of reasons on admin actions, one appeal per decision, remove-and-preserve with its deletion, and
// that the open routes show nothing private. Local stubs on ephemeral ports: SMTP and the captcha verify endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer as tcpServer } from 'node:net';
import { createServer as httpServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, guildWith, until } from './helpers.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
function totp(at = Date.now()) {
  const key = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef]); // = SECRET
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(msg).digest();
  return String((h.readUInt32BE(h[19] & 0xf) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

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
      if (cmd === 'EHLO') sock.write('250 stub\r\n');
      else if (cmd === 'RCPT') { msg.to.push(line.match(/<(.*)>/)?.[1]); sock.write('250 ok\r\n'); }
      else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') sock.end('221 bye\r\n');
      else sock.write('250 ok\r\n');
    }
  });
  sock.on('error', () => {});
});
const captcha = httpServer((req, res) => {
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: new URLSearchParams(body).get('response') === 'good' }));
  });
});
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const mailTo = addr => until(() => mails.find(m => m.to.includes(addr)), 3000);

let srv, api, alex, el;
const mfaHeaders = async (s, token) => {
  const on = await s.api('POST', '/users/@me/mfa/totp/enable', token, { password: 'hunter2hunter2', secret: SECRET, code: totp() });
  assert.equal(on.status, 200);
  const codes = on.body.backup_codes.map(c => c.code);
  const ticket = (await s.api('POST', '/users/@me/mfa/totp/disable', token, {})).body.mfa.ticket;
  const r = await s.api('POST', '/mfa/finish', token, { ticket, mfa_type: 'backup', data: codes.shift() });
  return { header: { 'X-Cillhub-MFA-Authorization': r.body.token }, codes };
};
const grant = (s, name) => execFileSync(process.execPath, ['src/admin-cli.js', 'grant', name], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: s.dataDir } });
const db = (sql, ...a) => { const d = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite')); try { return d.prepare(sql).all(...a); } finally { d.close(); } };
const why = { category: 'hate', reason: 'Insults against a group of people', ground: 'illegal' };
const reg = (name, extra = {}) => srv.api('POST', '/auth/register', null, { email: `${name}@example.com`, username: name, password: 'hunter2hunter2', ...extra });
const dmsOf = async user => {
  const ch = (await api('GET', '/users/@me/channels', user.token)).body.find(c => c.type === 1 && c.recipients.some(r => r.username.startsWith('cillhub-system')));
  return ch ? (await api('GET', `/channels/${ch.id}/messages`, user.token)).body.map(m => m.content) : [];
};

before(async () => {
  const smtpPort = await listen(smtp);
  const captchaPort = await listen(captcha);
  srv = await startServer({ env: { NODE_ENV: 'test', CILLCORD_TEST_PRESERVE_MS: '1500', CAPTCHA_VERIFY_URL: `http://127.0.0.1:${captchaPort}/verify`, CILLCORD_PUBLIC_URL: 'https://chat.example.org' } });
  api = srv.api;
  alex = await srv.register('alex');
  grant(srv, 'alex');
  el = await mfaHeaders(srv, alex.token);
  api = (m, p, t, b, h = {}) => srv.api(m, p, t, b, t === alex.token ? { ...el.header, ...h } : h);
  assert.equal((await api('PATCH', '/admin/settings', alex.token, { smtp_host: '127.0.0.1', smtp_port: smtpPort, smtp_security: 'none', smtp_from: 'Example Verein <no-reply@example.org>' })).status, 200);
});
after(async () => {
  await srv.stop();
  smtp.close();
  captcha.close();
});

test('operator fields and documents: validation, versions with hashes, public view without private fields', async () => {
  const fresh = (await api('GET', '/instance')).body.legal;
  assert.deepEqual([fresh.imprint, fresh.privacy, fresh.terms, fresh.operator_name, fresh.contact_email, fresh.min_age], [false, false, false, null, null, 14], 'ships empty');
  assert.match(fresh.source_url, /^https:\/\/github\.com\/TCCiller\/Cillhub$/);
  assert.equal((await api('GET', '/admin/overview', alex.token)).body.legal_incomplete, true);

  assert.equal((await api('PATCH', '/admin/settings', alex.token, { legal_operator: { name: 'Example Verein', ceo: 'x' } })).status, 400, 'unknown field');
  assert.equal((await api('PATCH', '/admin/settings', alex.token, { legal_operator: { email: 'not-an-address' } })).status, 400);
  assert.equal((await api('PATCH', '/admin/settings', alex.token, { min_age: 12 })).status, 400);
  assert.equal((await api('PATCH', '/admin/settings', alex.token, { source_url: 'javascript:alert(1)' })).status, 400);
  const op = { name: 'Example Verein', legal_form: 'Verein', address: 'Musterstraße 1\n1010 Wien', email: 'legal@example.org', phone: '+43 1 234', languages: 'de, en' };
  const s = await api('PATCH', '/admin/settings', alex.token, { legal_operator: op, min_age: 16 });
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.legal_operator, op);

  // markdown is stored and served as data, never as a page: no HTML type, the text comes back as it was
  const evil = '# Impressum\n<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const v1 = await api('PUT', '/admin/legal/imprint', alex.token, { en: evil, de: evil });
  assert.deepEqual([v1.status, v1.body.created], [200, true]);
  const same = await api('PUT', '/admin/legal/imprint', alex.token, { en: evil, de: evil });
  assert.deepEqual([same.body.created, same.body.version], [false, v1.body.version], 'unchanged text: no new version');
  const res = await fetch(`${srv.base}/legal/imprint`);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  assert.equal((await res.json()).en, evil);
  assert.equal((await api('GET', '/legal/nothing')).status, 404);
  assert.equal((await api('PUT', '/admin/legal/imprint', alex.token, { en: 'x'.repeat(100_001) })).status, 400);

  const pub = (await api('GET', '/instance')).body.legal;
  assert.deepEqual([pub.imprint, pub.operator_name, pub.contact_email, pub.contact_languages, pub.min_age], [true, 'Example Verein', 'legal@example.org', 'de, en', 16]);
  const text = JSON.stringify((await api('GET', '/instance')).body);
  assert.ok(!text.includes('Musterstraße') && !text.includes('+43 1 234'), 'address and phone only in the imprint text the operator writes');
  const versions = (await api('GET', '/admin/legal', alex.token)).body;
  assert.equal(versions.versions.filter(v => v.doc === 'imprint').length, 1);
  assert.match(versions.versions[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(typeof versions.features.captcha, 'boolean');
});

test('sign-up: age always, terms checkbox once terms exist, the accepted version is stored', async () => {
  const noAge = await reg('sam');
  assert.deepEqual([noAge.status, Object.keys(noAge.body.errors)], [400, ['age_confirmed']]);
  assert.match(noAge.body.errors.age_confirmed._errors[0].message, /16 years/);
  assert.equal((await reg('sam', { age_confirmed: 'yes' })).status, 400, 'only true counts');

  const terms = await api('PUT', '/admin/legal/terms', alex.token, { en: '# Terms\nBe kind.', de: '# Nutzungsbedingungen\nSei nett.' });
  await api('PUT', '/admin/legal/privacy', alex.token, { en: '# Privacy', de: '# Datenschutz' });
  const noTerms = await reg('sam', { age_confirmed: true });
  assert.deepEqual([noTerms.status, Object.keys(noTerms.body.errors)], [400, ['terms_accepted']]);
  const ok = await reg('sam', { age_confirmed: true, terms_accepted: true });
  assert.equal(ok.status, 201);
  const [row] = db("SELECT terms_version, terms_accepted_at FROM users WHERE username = 'sam'");
  assert.ok(row.terms_version >= terms.body.version && row.terms_accepted_at > Date.now() - 60_000);
  assert.deepEqual((await api('GET', '/legal/status', ok.body.token)).body.required, false);
});

test('re-acceptance: a new terms version with the box ticked blocks the API until accepted; logout still works', async () => {
  const robin = await reg('robin', { age_confirmed: true, terms_accepted: true });
  const token = robin.body.token;
  assert.equal((await api('GET', '/users/@me/guilds', token)).status, 200);
  await api('PUT', '/admin/legal/terms', alex.token, { en: '# Terms\nBe kind. Edited.', de: '# Nutzungsbedingungen\nSei nett. Neu.' });
  assert.equal((await api('GET', '/users/@me/guilds', token)).status, 200, 'a plain edit asks nobody again');
  const v = (await api('PUT', '/admin/legal/terms', alex.token, { en: '# Terms\nBe kind. v3', de: '# Nutzungsbedingungen\nv3', reaccept: true })).body.version;
  const blocked = await api('GET', '/users/@me/guilds', token);
  assert.deepEqual([blocked.status, blocked.body.required_actions], [403, ['accept_terms']]);
  assert.equal((await api('GET', '/users/@me', token)).status, 200);
  const st = (await api('GET', '/legal/status', token)).body;
  assert.deepEqual([st.required, st.accept_version], [true, v]);
  assert.equal((await api('POST', '/legal/accept', token, { version: v - 1 })).status, 400, 'an older text cannot be accepted');
  assert.equal((await api('POST', '/legal/accept', token, { version: v })).body.required, false);
  assert.equal((await api('GET', '/users/@me/guilds', token)).status, 200);
  // the admin who saved it is asked too (they are an account like any other)
  assert.equal((await api('GET', '/admin/overview', alex.token)).status, 403);
  assert.equal((await api('POST', '/legal/accept', alex.token, { version: v })).status, 200);
  assert.equal((await api('GET', '/admin/overview', alex.token)).status, 200);
  // a hub-made account on a node (legal_pending) must also confirm the age
  db("UPDATE users SET legal_pending = 1 WHERE username = 'robin'");
  assert.equal((await api('GET', '/users/@me/guilds', token)).status, 403);
  assert.equal((await api('POST', '/legal/accept', token, { version: v })).status, 400, 'age missing');
  assert.equal((await api('POST', '/legal/accept', token, { version: v, age_confirmed: true })).status, 200);
  assert.equal((await api('GET', '/users/@me/guilds', token)).status, 200);
});

test('public notice: field rules, captcha when configured, receipt mail, status by code, decision goes back', async () => {
  const base = { category: 'hate_speech', url: 'https://chat.example.org/channels/1/2/3', explanation: 'This message insults a group of people.', good_faith: true };
  assert.equal((await api('POST', '/legal/notices', null, { ...base, category: 'nope' })).status, 400);
  assert.equal((await api('POST', '/legal/notices', null, base)).status, 400, 'name and email required outside child abuse');
  assert.equal((await api('POST', '/legal/notices', null, { ...base, name: 'Kim', email: 'kim@example.org', good_faith: false })).status, 400);
  assert.equal((await api('POST', '/legal/notices', null, { ...base, name: 'Kim', email: 'kim@example.org', explanation: 'short' })).status, 400);
  assert.equal((await api('POST', '/legal/notices', null, { ...base, url: null, name: 'Kim', email: 'kim@example.org' })).status, 400, 'link or description');
  const anon = await api('POST', '/legal/notices', null, { ...base, category: 'child_abuse' });
  assert.equal(anon.status, 201, 'anonymous is fine for child sexual abuse');
  const big = await fetch(`${srv.base}/legal/notices`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...base, explanation: 'x'.repeat(20_000) }) });
  assert.equal(big.status, 413, 'size cap');

  const n = await api('POST', '/legal/notices', null, { ...base, name: 'Kim', email: 'kim@example.org' });
  assert.equal(n.status, 201);
  assert.ok(n.body.code.length >= 20 && n.body.receipt_mailed);
  const receipt = (await mailTo('kim@example.org')).data.replace(/=\n/g, '');
  assert.match(receipt, new RegExp(n.body.id));
  assert.match(receipt, /--=20\nExample Verein\nhttps:\/\/chat\.example\.org\/imprint/, 'mail footer from the operator fields');
  const status = await api('POST', '/legal/notices/status', null, { code: n.body.code });
  assert.deepEqual([status.body.status, status.body.category, status.body.decision], ['open', 'hate_speech', null]);
  assert.ok(!JSON.stringify(status.body).includes('kim@'), 'nothing about the notifier');
  assert.equal((await api('POST', '/legal/notices/status', null, { code: 'A'.repeat(24) })).status, 404);

  const listed = (await api('GET', '/admin/reports?source=public', alex.token)).body.find(r => r.id === n.body.id);
  assert.deepEqual([listed.source, listed.notice.email, listed.message], ['public', 'kim@example.org', null]);
  assert.equal((await api('POST', `/admin/reports/${n.body.id}/resolve`, alex.token, { action: 'delete_message' })).status, 400);
  assert.equal((await api('POST', `/admin/reports/${n.body.id}/resolve`, alex.token, { action: 'action_taken' })).status, 400, 'decision text required');
  const done = await api('POST', `/admin/reports/${n.body.id}/resolve`, alex.token, { action: 'action_taken', note: 'We removed the message.' });
  assert.equal(done.status, 200);
  assert.ok(await until(() => mails.filter(m => m.to.includes('kim@example.org')).some(m => m.data.includes('We removed the message.'))));
  const after = (await api('POST', '/legal/notices/status', null, { code: n.body.code })).body;
  assert.deepEqual([after.status, after.decision], ['resolved', 'We removed the message.']);

  // captcha: once keys are set the notice needs a good token
  assert.equal((await api('PATCH', '/admin/settings', alex.token, { captcha_site_key: 'site', captcha_secret: 'secret' })).status, 200);
  assert.equal((await api('POST', '/legal/notices', null, { ...base, name: 'Kim', email: 'kim@example.org' })).status, 400);
  assert.equal((await api('POST', '/legal/notices', null, { ...base, name: 'Kim', email: 'kim@example.org', captcha_key: 'bad' })).status, 400);
  assert.equal((await api('POST', '/legal/notices', null, { ...base, name: 'Kim', email: 'kim@example.org', captcha_key: 'good' })).status, 201);
  await api('PATCH', '/admin/settings', alex.token, { captcha_site_key: null, captcha_secret: null });
});

test('public notice rate limit per address (unscaled limits)', async () => {
  const strict = await startServer({ env: { CILLCORD_RATE_LIMIT_SCALE: '1' } });
  try {
    const body = { category: 'child_abuse', description: 'A server called example', explanation: 'Describing the problem here.', good_faith: true };
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await strict.api('POST', '/legal/notices', null, body)).status);
    assert.deepEqual(codes, [201, 201, 201, 201, 201, 429]);
  } finally { await strict.stop(); }
});

test('statement of reasons: required on admin actions, sent to the author, shown on a disabled login; one appeal', async () => {
  const g = await guildWith(srv, ['taylor', 'jordan']);
  const { jordan } = g.users;
  for (const u of Object.values(g.users)) await api('POST', '/legal/accept', u.token, { version: (await api('GET', '/legal/status', u.token)).body.accept_version, age_confirmed: true });
  const m = (await api('POST', `/channels/${g.general.id}/messages`, jordan.token, { content: 'something hateful' })).body;
  const rep = await api('POST', `/channels/${g.general.id}/messages/${m.id}/report`, g.users.taylor.token, { reason: 'hate' });
  assert.equal(rep.status, 201);
  assert.ok((await dmsOf(g.users.taylor)).some(c => c.includes(rep.body.id)), 'receipt to the reporter');
  const resolve = body => api('POST', `/admin/reports/${rep.body.id}/resolve`, alex.token, body);
  assert.equal((await resolve({ action: 'delete_message' })).status, 400, 'reason required');
  assert.equal((await resolve({ action: 'delete_message', category: 'hate', reason: '' })).status, 400);
  assert.equal((await resolve({ action: 'delete_message', ...why })).status, 200);
  const notice = (await dmsOf(jordan)).find(c => c.includes('Insults against a group'));
  assert.ok(notice && /Illegal content/.test(notice) && /appeal#[\w-]{20,}/.test(notice), 'author gets the statement with an appeal link');
  assert.ok((await dmsOf(g.users.taylor)).some(c => c.includes('is closed')), 'outcome to the reporter');

  const code = notice.match(/appeal#([\w-]+)/)[1];
  const look = await api('POST', '/legal/appeals/lookup', null, { code });
  assert.deepEqual([look.body.action, look.body.ground, look.body.appeal], ['delete_message', 'illegal', null]);
  assert.equal((await api('POST', '/legal/appeals', null, { code, text: 'short' })).status, 400);
  assert.equal((await api('POST', '/legal/appeals', null, { code, text: 'It was a quote from a news article.' })).status, 201);
  assert.equal((await api('POST', '/legal/appeals', null, { code, text: 'And another thing I wanted to add.' })).status, 400, 'only once');
  const queue = (await api('GET', '/admin/appeals', alex.token)).body;
  assert.equal(queue.length, 1);
  assert.equal((await api('POST', `/admin/appeals/${queue[0].id}`, alex.token, { outcome: 'upheld' })).status, 400, 'text required');
  assert.equal((await api('POST', `/admin/appeals/${queue[0].id}`, alex.token, { outcome: 'upheld', text: 'The quote itself is the problem.' })).status, 200);
  assert.equal((await api('POST', `/admin/appeals/${queue[0].id}`, alex.token, { outcome: 'reversed', text: 'again' })).status, 404, 'decided once');
  assert.ok((await dmsOf(jordan)).some(c => c.includes('The quote itself is the problem.')));

  // disable from the users page: reason required; the login error carries it with an appeal link; a reversal enables
  assert.equal((await api('POST', `/admin/users/${jordan.id}/disable`, alex.token, {})).status, 400);
  assert.equal((await api('POST', `/admin/users/${jordan.id}/disable`, alex.token, { category: 'harassment', reason: 'Repeated harassment after warnings' })).status, 200);
  const login = await api('POST', '/auth/login', null, { login: 'jordan', password: 'hunter2hunter2' });
  assert.equal(login.status, 400);
  assert.deepEqual([login.body.moderation.ground, login.body.moderation.reason], ['terms', 'Repeated harassment after warnings']);
  assert.match(login.body.moderation.appeal_url, /^https:\/\/chat\.example\.org\/appeal#/);
  assert.equal((await api('POST', '/auth/login', null, { login: 'jordan', password: 'wrong-password' })).body.moderation, undefined, 'nothing without the password');
  const c2 = login.body.moderation.appeal_url.split('#')[1];
  assert.equal((await api('POST', '/legal/appeals', null, { code: c2, text: 'Please look at this again, it was a misunderstanding.' })).status, 201);
  const ap = (await api('GET', '/admin/appeals', alex.token)).body.find(d => d.action === 'disable_account');
  assert.equal((await api('POST', `/admin/appeals/${ap.id}`, alex.token, { outcome: 'reversed', text: 'Agreed, enabled again.' })).status, 200);
  assert.equal((await api('POST', '/auth/login', null, { login: 'jordan', password: 'hunter2hunter2' })).status, 200);

  // directory hide and server delete need a reason too
  assert.equal((await api('DELETE', `/admin/guilds/${g.guild.id}`, alex.token, { confirm: 'Test Guild', code: el.codes.shift() })).status, 400);
  const stats = (await api('GET', '/admin/reports/stats', alex.token)).body;
  assert.ok(stats.actions.delete_message >= 1 && stats.actions.disable_account >= 1 && stats.appeals.upheld === 1 && stats.appeals.reversed === 1);
  assert.ok(stats.notices.by_source.user >= 1 && stats.notices.by_source.public >= 1 && stats.median_handling_hours !== null);
});

test('remove and preserve by link: preview, removal with a kept copy, DMs refused, deleted after the period', async () => {
  const g = await guildWith(srv, ['kim', 'sam2']);
  for (const u of Object.values(g.users)) await api('POST', '/legal/accept', u.token, { version: (await api('GET', '/legal/status', u.token)).body.accept_version, age_confirmed: true });
  const m = (await srv.upload(g.general.id, g.users.sam2.token, { content: 'terror propaganda' }, [['flyer.txt', Buffer.from('file body'), 'text/plain']])).body;
  const link = `https://chat.example.org/channels/${g.guild.id}/${g.general.id}/${m.id}`;
  const pre = await api('POST', '/admin/removals/preview', alex.token, { url: link });
  assert.deepEqual([pre.status, pre.body.type, pre.body.content, pre.body.attachments[0].filename], [200, 'message', 'terror propaganda', 'flyer.txt']);
  assert.equal((await api('POST', '/admin/removals/preview', alex.token, { url: 'https://elsewhere.example/x' })).status, 400);
  const dm = (await api('POST', '/users/@me/channels', g.users.kim.token, { recipient_id: g.users.sam2.id })).body;
  const dmMsg = (await api('POST', `/channels/${dm.id}/messages`, g.users.sam2.token, { content: 'private' })).body;
  assert.equal((await api('POST', '/admin/removals/preview', alex.token, { url: `/channels/@me/${dm.id}/${dmMsg.id}` })).status, 400, 'no DMs');
  assert.equal((await api('POST', '/admin/removals', alex.token, { url: link })).status, 400, 'reason required');

  const r = await api('POST', '/admin/removals', alex.token, { url: link, category: 'terrorism', reason: 'Removal order from the authority' });
  assert.equal(r.status, 201);
  assert.equal((await api('GET', `/channels/${g.general.id}/messages/${m.id}`, g.users.kim.token)).status, 404, 'gone at once');
  const kept = (await api('GET', '/admin/reports?source=removal&status=all', alex.token)).body.find(x => x.id === r.body.id);
  assert.deepEqual([kept.message.content, kept.message.attachments[0].filename], ['terror propaganda', 'flyer.txt']);
  assert.ok(existsSync(join(srv.dataDir, 'preserved', r.body.id)), 'files kept');
  assert.ok((await dmsOf(g.users.sam2)).some(c => c.includes('Removal order from the authority')));
  const log = (await api('GET', '/admin/audit-log?action=removal.', alex.token)).body.map(e => e.action);
  assert.deepEqual(log.sort(), ['removal.message', 'removal.preview']);
  // the test period is 1.5 s; the job deletes row and files
  await until(() => !db('SELECT 1 FROM reports WHERE id = ?', r.body.id).length, 6000);
  assert.ok(!existsSync(join(srv.dataDir, 'preserved', r.body.id)));
});

test('data export: reactions, poll votes, filed reports, decisions and the accepted terms', async () => {
  const g = await guildWith(srv, ['taylor2', 'kim2']);
  for (const u of Object.values(g.users)) await api('POST', '/legal/accept', u.token, { version: (await api('GET', '/legal/status', u.token)).body.accept_version, age_confirmed: true });
  const m = (await api('POST', `/channels/${g.general.id}/messages`, g.users.kim2.token, { content: 'react here' })).body;
  assert.equal((await api('PUT', `/channels/${g.general.id}/messages/${m.id}/reactions/${encodeURIComponent('👍')}/@me`, g.users.taylor2.token)).status, 204);
  await api('POST', `/channels/${g.general.id}/messages/${m.id}/report`, g.users.taylor2.token, { reason: 'spam' });
  const res = await fetch(`${srv.base}/users/@me/export`, { headers: { Authorization: g.users.taylor2.token } });
  const data = await res.json();
  assert.deepEqual(data.reactions, [{ message_id: m.id, emoji: '👍' }]);
  assert.equal(data.reports_filed.length, 1);
  assert.ok(Array.isArray(data.poll_votes) && Array.isArray(data.moderation_decisions));
  assert.ok(data.terms_accepted.version >= 1 && data.terms_accepted.accepted_at);
});
