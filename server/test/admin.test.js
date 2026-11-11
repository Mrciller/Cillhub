// v6 instance administration: the CLI is the only way in, every admin route needs the flag and 2FA, the audit log is
// append-only, no DM content is reachable, reports, registration modes, account and server actions, instance settings
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { rm } from 'node:fs/promises';
import { startServer, guildWith, tempDir } from './helpers.js';

process.env.DATA_DIR = await tempDir(); // instance.js (scrub) opens its own database in-process
const { scrub } = await import('../src/instance.js');

const why = { category: 'spam', reason: 'Spam links in several channels' };
const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
function totp(at = Date.now()) {
  const key = Buffer.from([0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef, 0x48, 0x65, 0x6c, 0x6c, 0x6f, 0x21, 0xde, 0xad, 0xbe, 0xef]); // = SECRET
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(msg).digest();
  return String((h.readUInt32BE(h[19] & 0xf) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

let srv, api, root, backup;
const cli = (...args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, ['src/admin-cli.js', ...args], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: srv.dataDir }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status, out: `${e.stdout}${e.stderr}` };
  }
};
const flag = id => { const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite')); try { return db.prepare('SELECT instance_admin FROM users WHERE id = ?').get(id).instance_admin; } finally { db.close(); } };
// elevation for destructive admin actions: one unused backup code each
const mfa = () => ({ code: backup.shift() });

// every /admin route the server has, read from its source so a new route cannot slip past these tests
const ADMIN_ROUTES = [...['admin', 'legal'].map(f => readFileSync(new URL(`../src/routes/${f}.js`, import.meta.url), 'utf8')).join('\n').matchAll(/\['(GET|POST|PUT|PATCH|DELETE)', '(\/admin[^']*)'/g)].map(m => [m[1], m[2]]);

before(async () => {
  srv = await startServer();
  api = srv.api;
  root = await srv.register('rootadmin');
  const on = await api('POST', '/users/@me/mfa/totp/enable', root.token, { password: 'hunter2hunter2', secret: SECRET, code: totp() });
  assert.equal(on.status, 200);
  backup = on.body.backup_codes.map(c => c.code);
});
after(async () => {
  await srv.stop();
  await rm(process.env.DATA_DIR, { recursive: true, force: true });
});

test('the CLI is the only way to grant admin; the API cannot set the flag', async () => {
  assert.ok(ADMIN_ROUTES.length >= 20, 'admin routes found in the source');
  assert.equal((await api('PATCH', '/users/@me', root.token, { instance_admin: true })).status, 200); // unknown fields are ignored
  assert.equal((await api('PATCH', '/users/@me/settings', root.token, { instance_admin: true })).status, 400);
  assert.equal((await api('PATCH', `/admin/users/${root.id}`, root.token, { instance_admin: true })).status, 404, 'no such route');
  assert.equal((await api('PUT', `/admin/users/${root.id}/admin`, root.token, {})).status, 404);
  assert.equal(flag(root.id), 0);
  assert.equal((await api('GET', '/users/@me', root.token)).body.instance_admin, false);
  assert.equal((await api('GET', '/admin/overview', root.token)).status, 403);

  assert.equal(cli('grant', 'nobody-here').code, 1);
  assert.equal(cli('frobnicate', 'rootadmin').code, 2);
  const granted = cli('grant', 'ROOTADMIN'); // usernames are case-insensitive
  assert.equal(granted.code, 0, granted.out);
  assert.equal(flag(root.id), 1);
  assert.match(cli('list').out, /rootadmin\t.*2FA on/);
  assert.equal((await api('GET', '/users/@me', root.token)).body.instance_admin, true);
  assert.equal((await api('GET', '/admin/overview', root.token)).status, 200, 're-read per request: no restart needed');
  const log = (await api('GET', '/admin/audit-log?action=cli.', root.token)).body;
  assert.deepEqual(log.map(e => [e.action, e.admin_id, e.target_id]), [['cli.grant', null, root.id]]);
});

test('every admin route refuses anonymous users, non-admins, bots and admins without 2FA', async () => {
  const eve = await srv.register('eve');
  const nomfa = await srv.register('nomfa');
  assert.equal(cli('grant', 'nomfa').code, 0);
  const app = (await api('POST', '/applications', eve.token, { name: 'AdminBot' })).body;
  const botToken = `Bot ${(await api('POST', `/applications/${app.id}/bot/reset`, eve.token, {})).body.token}`;
  const path = p => p.replace(':user_id', eve.id).replace(':guild_id', '1').replace(':report_id', '1').replace(':code', 'ABC');
  for (const [method, p] of ADMIN_ROUTES) {
    const body = method === 'GET' ? undefined : {};
    const what = `${method} ${p}`;
    assert.equal((await api(method, path(p), null, body)).status, 401, what);
    const asEve = await api(method, path(p), eve.token, body);
    assert.deepEqual([asEve.status, asEve.body.code], [403, 50001], what);
    const noMfa = await api(method, path(p), nomfa.token, body);
    assert.deepEqual([noMfa.status, noMfa.body.code], [403, 60003], what);
    assert.equal((await api(method, path(p), botToken, body)).status, 403, what);
  }
  // refusals were not acted upon, and they were logged (at most once a minute per user)
  assert.equal((await api('GET', '/users/@me', eve.token)).status, 200, 'eve was not disabled or deleted');
  const denied = (await api('GET', '/admin/audit-log?action=access_denied', root.token)).body;
  assert.deepEqual(new Set(denied.filter(e => e.admin_id !== root.id).map(e => `${e.admin_id}:${e.details.reason}`)), new Set([`${eve.id}:not_admin`, `${nomfa.id}:mfa_disabled`]));
  // revoking takes effect on the next request
  assert.equal(cli('revoke', 'nomfa@example.com').code, 0);
  assert.equal((await api('GET', '/admin/overview', nomfa.token)).body.code, 50001);
});

test('the admin audit log records actions with an IP hash and refuses updates and deletes', async () => {
  const u = await srv.register('audited');
  assert.equal((await api('POST', `/admin/users/${u.id}/logout`, root.token, {})).status, 200);
  const [entry] = (await api('GET', `/admin/audit-log?target_id=${u.id}`, root.token)).body;
  assert.deepEqual([entry.action, entry.admin_id, entry.target_type, entry.target_id], ['user.logout', root.id, 'user', u.id]);
  assert.match(entry.ip_hash, /^[0-9a-f]{32}$/);
  assert.ok(!JSON.stringify(entry).includes('127.0.0.1'), 'no raw IP');
  // viewing is audited too
  await api('GET', `/admin/users/${u.id}`, root.token);
  assert.ok((await api('GET', `/admin/audit-log?target_id=${u.id}`, root.token)).body.some(e => e.action === 'GET /admin/users/:user_id'));
  const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite'));
  try {
    assert.throws(() => db.exec("UPDATE admin_audit_log SET action = 'x'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM admin_audit_log'), /append-only/);
  } finally {
    db.close();
  }
  const filtered = (await api('GET', `/admin/audit-log?admin_id=${root.id}&action=user.&limit=5`, root.token)).body;
  assert.ok(filtered.length >= 1 && filtered.every(e => e.admin_id === root.id && e.action.startsWith('user.')));
});

test('no DM or channel content is reachable for an admin; reported messages are the exception', async () => {
  const g = await guildWith(srv, ['dmowner', 'dmfriend']);
  const { dmowner: a, dmfriend: b } = g.users;
  const dm = (await api('POST', '/users/@me/channels', a.token, { recipient_id: b.id })).body;
  const secret = (await api('POST', `/channels/${dm.id}/messages`, a.token, { content: 'secret dm text 4711' })).body;
  await api('POST', `/channels/${g.general.id}/messages`, a.token, { content: 'guild-only text 4712' });
  const reads = [
    '/admin/overview', '/admin/users', `/admin/users/${a.id}`, `/admin/users/${b.id}`, '/admin/guilds', `/admin/guilds/${g.guild.id}`,
    '/admin/reports?status=all', '/admin/settings', '/admin/audit-log', '/admin/registration-codes',
  ];
  for (const p of reads) {
    const r = await api('GET', p, root.token);
    assert.equal(r.status, 200, p);
    assert.ok(!JSON.stringify(r.body).includes('secret dm text 4711') && !JSON.stringify(r.body).includes('guild-only text 4712'), `${p} leaks content`);
  }
  // as a normal user the admin sees nothing either
  assert.equal((await api('GET', `/channels/${dm.id}/messages`, root.token)).status, 403);
  assert.equal((await api('GET', `/channels/${g.general.id}/messages`, root.token)).status, 403);
  assert.equal((await api('GET', `/guilds/${g.guild.id}`, root.token)).status, 403);
  // once b reports the DM message, its copy is in the report
  assert.equal((await api('POST', `/channels/${dm.id}/messages/${secret.id}/report`, b.token, { reason: 'harassment', note: 'please check' })).status, 201);
  const reports = (await api('GET', '/admin/reports', root.token)).body;
  const r = reports.find(x => x.message.id === secret.id);
  assert.deepEqual([r.message.content, r.reason, r.note, r.reporter.id, r.author.id, r.guild, r.link], ['secret dm text 4711', 'harassment', 'please check', b.id, a.id, null, `/channels/@me/${dm.id}/${secret.id}`]);
});

test('reports: user rules, then delete, timeout and ban from the dashboard', async () => {
  const g = await guildWith(srv, ['rowner', 'rmember', 'rbad']);
  const { rowner, rmember, rbad } = g.users;
  const bad = (await api('POST', `/channels/${g.general.id}/messages`, rbad.token, { content: 'buy cheap stuff' })).body;
  const report = body => api('POST', `/channels/${g.general.id}/messages/${bad.id}/report`, rmember.token, body);
  assert.deepEqual((await api('GET', '/report-reasons', rmember.token)).body.includes('spam'), true);
  assert.equal((await report({ reason: 'meh' })).status, 400);
  assert.equal((await report({ reason: 'spam', note: 'x'.repeat(1001) })).status, 400);
  const ok = await report({ reason: 'spam' });
  assert.deepEqual([ok.status, ok.body.reason, ok.body.message_id], [201, 'spam', bad.id]);
  assert.equal((await report({ reason: 'spam' })).status, 400, 'once per message');
  assert.equal((await api('POST', `/channels/${g.general.id}/messages/${bad.id}/report`, rbad.token, { reason: 'spam' })).status, 400, 'not your own');
  assert.equal((await api('POST', `/channels/${g.general.id}/messages/${bad.id}/report`, root.token, { reason: 'spam' })).status, 403, 'only what you can see');

  const r = (await api('GET', '/admin/reports', root.token)).body.find(x => x.message.id === bad.id);
  assert.deepEqual([r.status, r.guild.id, r.channel.id, r.message.content, r.message.exists], ['open', g.guild.id, g.general.id, 'buy cheap stuff', true]);
  const gw = await srv.gateway(rowner.token);
  const resolve = body => api('POST', `/admin/reports/${r.id}/resolve`, root.token, body);
  assert.equal((await resolve({ action: 'explode' })).status, 400);
  const del = await resolve({ action: 'delete_message', note: 'spam', ...why });
  assert.deepEqual([del.status, del.body.status, del.body.message.exists, del.body.message.content], [200, 'resolved', false, 'buy cheap stuff']);
  assert.equal((await gw.event('MESSAGE_DELETE')).id, bad.id);
  const timeout = await resolve({ action: 'timeout', duration_seconds: 600, ...why });
  assert.equal(timeout.status, 200);
  const member = await gw.event('GUILD_MEMBER_UPDATE', d => d.user.id === rbad.id);
  assert.ok(Date.parse(member.communication_disabled_until) > Date.now());
  assert.equal((await resolve({ action: 'ban', ...why })).status, 200);
  assert.equal((await gw.event('GUILD_MEMBER_REMOVE')).user.id, rbad.id);
  const bans = (await api('GET', `/guilds/${g.guild.id}/bans`, rowner.token)).body;
  assert.deepEqual(bans.map(b => b.user.id), [rbad.id]);
  const final = (await api('GET', '/admin/reports?status=resolved', root.token)).body.find(x => x.id === r.id);
  assert.deepEqual(final.actions.map(a => a.action), ['delete_message', 'timeout', 'ban']);
  // the server's own audit log shows who acted
  const entries = (await api('GET', `/guilds/${g.guild.id}/audit-logs`, rowner.token)).body.audit_log_entries;
  assert.ok(entries.some(e => e.action_type === 22 && e.user_id === root.id && e.target_id === rbad.id));
  // refusing the owner
  const own = (await api('POST', `/channels/${g.general.id}/messages`, rowner.token, { content: 'owner msg' })).body;
  await api('POST', `/channels/${g.general.id}/messages/${own.id}/report`, rmember.token, { reason: 'other' });
  const r2 = (await api('GET', '/admin/reports', root.token)).body.find(x => x.message.id === own.id);
  assert.equal((await api('POST', `/admin/reports/${r2.id}/resolve`, root.token, { action: 'kick', ...why })).status, 400);
  assert.equal((await api('POST', `/admin/reports/${r2.id}/resolve`, root.token, { action: 'dismiss' })).body.status, 'resolved');
});

test('registration modes: closed, invite-only with admin codes, open; public instance info and its event', async () => {
  const watcher = await srv.register('watcher');
  const gw = await srv.gateway(watcher.token);
  assert.equal(gw.ready.instance.registration_mode, 'open');
  const reg = (name, extra = {}) => api('POST', '/auth/register', null, { age_confirmed: true, email: `${name}@example.com`, username: name, password: 'hunter2hunter2', ...extra });
  assert.equal((await api('PATCH', '/admin/settings', root.token, { registration_mode: 'sometimes' })).status, 400);
  assert.equal((await api('PATCH', '/admin/settings', root.token, { registration_mode: 'closed', instance_name: 'Nightfall', motd: 'Scrims at 8' })).status, 200);
  const upd = await gw.event('INSTANCE_SETTINGS_UPDATE');
  assert.deepEqual([upd.registration_mode, upd.name, upd.motd], ['closed', 'Nightfall', 'Scrims at 8']);
  assert.equal((await api('GET', '/instance')).body.name, 'Nightfall');
  assert.equal((await api('GET', '/policies/instance')).body.instanceName, 'Nightfall');
  assert.equal((await reg('closed1')).status, 403);

  await api('PATCH', '/admin/settings', root.token, { registration_mode: 'invite' });
  const noCode = await reg('invited1');
  assert.deepEqual([noCode.status, noCode.body.errors.registration_code._errors[0].code], [400, 'REGISTRATION_CODE_INVALID']);
  const code = (await api('POST', '/admin/registration-codes', root.token, { max_uses: 1, note: 'for Max' })).body;
  assert.match(code.code, /^[A-Z2-9]{10}$/);
  assert.equal((await reg('invited1', { registration_code: code.code })).status, 201);
  assert.equal((await reg('invited2', { registration_code: code.code })).status, 400, 'used up');
  const listed = (await api('GET', '/admin/registration-codes', root.token)).body.find(c => c.code === code.code);
  assert.deepEqual([listed.uses, listed.note], [1, 'for Max']);
  assert.equal((await api('DELETE', `/admin/registration-codes/${code.code}`, root.token)).status, 204);
  await api('PATCH', '/admin/settings', root.token, { registration_mode: 'open' });
  assert.equal((await reg('openagain')).status, 201);
});

test('disable closes sessions and blocks login; force logout; reset 2FA; required password change; delete', async () => {
  const v = await srv.register('victim');
  const gw = await srv.gateway(v.token);
  assert.equal((await api('POST', `/admin/users/${root.id}/disable`, root.token, {})).status, 400, 'admins cannot act on admins');
  const dis = await api('POST', `/admin/users/${v.id}/disable`, root.token, why);
  assert.deepEqual([dis.status, dis.body.disabled], [200, true]);
  assert.equal(await gw.closed, 4004);
  assert.equal((await api('GET', '/users/@me', v.token)).status, 401);
  const login = await api('POST', '/auth/login', null, { login: 'victim', password: 'hunter2hunter2' });
  assert.deepEqual([login.status, login.body.code], [400, 20013]);
  assert.equal((await api('POST', '/auth/login', null, { login: 'victim', password: 'wrong-password' })).status, 401, 'disabled only shows with the right password');
  assert.equal((await api('POST', `/admin/users/${v.id}/enable`, root.token, {})).body.disabled, false);
  const token = (await api('POST', '/auth/login', null, { login: 'victim', password: 'hunter2hunter2' })).body.token;

  // force logout
  const gw2 = await srv.gateway(token);
  assert.equal((await api('POST', `/admin/users/${v.id}/logout`, root.token, {})).status, 200);
  assert.equal(await gw2.closed, 4004);
  assert.equal((await api('GET', '/users/@me', token)).status, 401);

  // required password change: login says so, other routes refuse until the password changed
  let t = (await api('POST', '/auth/login', null, { login: 'victim', password: 'hunter2hunter2' })).body.token;
  assert.equal((await api('POST', `/admin/users/${v.id}/require-password-change`, root.token, {})).body.require_password_change, true);
  const again = (await api('POST', '/auth/login', null, { login: 'victim', password: 'hunter2hunter2' })).body;
  assert.deepEqual(again.required_actions, ['update_password']);
  t = again.token;
  const blocked = await api('GET', '/users/@me/guilds', t);
  assert.deepEqual([blocked.status, blocked.body.required_actions], [403, ['update_password']]);
  assert.equal((await api('GET', '/users/@me', t)).status, 200);
  assert.equal((await api('PATCH', '/users/@me', t, { password: 'hunter2hunter2', new_password: 'brandnew-pass1' })).status, 200);
  assert.equal((await api('GET', '/users/@me/guilds', t)).status, 200);
  assert.equal((await api('POST', '/auth/login', null, { login: 'victim', password: 'brandnew-pass1' })).body.required_actions, undefined);

  // reset 2FA needs the admin's own 2FA (code or elevation)
  const on = await api('POST', '/users/@me/mfa/totp/enable', t, { password: 'brandnew-pass1', secret: SECRET, code: totp() });
  assert.equal(on.status, 200);
  const noCode = await api('POST', `/admin/users/${v.id}/reset-mfa`, root.token, {});
  assert.deepEqual([noCode.status, noCode.body.code], [401, 60003]);
  const wrong = await api('POST', `/admin/users/${v.id}/reset-mfa`, root.token, { code: '000000' });
  assert.deepEqual([wrong.status, wrong.body.code], [400, 60008], 'a wrong code is told apart from a missing one');
  assert.equal((await api('POST', `/admin/users/${v.id}/reset-mfa`, root.token, mfa())).body.mfa_enabled, false);
  assert.ok((await api('POST', '/auth/login', null, { login: 'victim', password: 'brandnew-pass1' })).body.token, 'no MFA step any more');

  // delete: typed username and 2FA; refused while the account owns a server
  const g = await guildWith(srv, ['ownsone']);
  const owner = g.users.ownsone;
  assert.equal((await api('DELETE', `/admin/users/${owner.id}`, root.token, { confirm: 'ownsone', ...mfa() })).body.code, 40011);
  assert.equal((await api('DELETE', `/admin/users/${v.id}`, root.token, { confirm: 'wrong', ...mfa() })).status, 400);
  assert.equal((await api('DELETE', `/admin/users/${v.id}`, root.token, { confirm: 'victim', ...mfa() })).status, 204);
  const gone = (await api('GET', `/admin/users/${v.id}`, root.token)).body;
  assert.deepEqual([gone.deleted, gone.username], [true, `deleted_user_${v.id}`]);
});

test('servers: list and detail without messages, invites disabled, transfer and delete with 2FA', async () => {
  const g = await guildWith(srv, ['sowner', 'smember']);
  const { sowner, smember } = g.users;
  await api('POST', `/channels/${g.general.id}/messages`, sowner.token, { content: 'not for admins 4713' });
  const list = (await api('GET', '/admin/guilds?query=Test', root.token)).body;
  const row = list.find(x => x.id === g.guild.id);
  assert.deepEqual([row.owner.id, row.member_count, row.message_count >= 2], [sowner.id, 2, true]);
  const detail = (await api('GET', `/admin/guilds/${g.guild.id}`, root.token)).body;
  assert.ok(detail.channels.some(c => c.id === g.general.id && c.name === 'general'));
  assert.ok(!JSON.stringify(detail).includes('4713'));
  assert.ok(detail.invites.some(i => i.code === g.invite.code));

  const gw = await srv.gateway(sowner.token);
  assert.equal((await api('PUT', `/admin/guilds/${g.guild.id}/invites-disabled`, root.token, { disabled: true })).body.invites_disabled, true);
  assert.ok((await gw.event('GUILD_UPDATE')).features.includes('INVITES_DISABLED'));
  const late = await srv.register('latecomer');
  assert.equal((await api('POST', `/invites/${g.invite.code}`, late.token)).status, 403);
  assert.equal((await api('POST', `/channels/${g.general.id}/invites`, sowner.token, {})).status, 403);
  await api('PUT', `/admin/guilds/${g.guild.id}/invites-disabled`, root.token, { disabled: false });
  assert.equal((await api('POST', `/invites/${g.invite.code}`, late.token)).status, 200);

  assert.equal((await api('POST', `/admin/guilds/${g.guild.id}/transfer`, root.token, { owner_id: smember.id })).status, 401, 'needs 2FA');
  assert.equal((await api('POST', `/admin/guilds/${g.guild.id}/transfer`, root.token, { owner_id: root.id, ...mfa() })).status, 400, 'members only');
  assert.equal((await api('POST', `/admin/guilds/${g.guild.id}/transfer`, root.token, { owner_id: smember.id, ...mfa() })).body.owner.id, smember.id);
  assert.equal((await api('DELETE', `/admin/guilds/${g.guild.id}`, root.token, { confirm: 'nope', ...mfa() })).status, 400);
  assert.equal((await api('DELETE', `/admin/guilds/${g.guild.id}`, root.token, { confirm: 'Test Guild', ...why, ...mfa() })).status, 204);
  assert.equal((await gw.event('GUILD_DELETE')).id, g.guild.id);
  assert.equal((await api('GET', `/guilds/${g.guild.id}`, smember.token)).status, 404);
});

test('instance settings: upload limit, GIF toggle, voice backend only if configured; announcements with a system DM', async () => {
  const g = await guildWith(srv, ['uploader']);
  const u = g.users.uploader;
  const settings = (await api('GET', '/admin/settings', root.token)).body;
  assert.deepEqual([settings.max_upload_bytes, settings.gifs_enabled, settings.voice.configured], [25 * 1024 * 1024, true, []]);
  assert.equal((await api('PATCH', '/admin/settings', root.token, { max_upload_bytes: 1 })).status, 400);
  assert.equal((await api('PATCH', '/admin/settings', root.token, { voice_backend: 'cillvoice' })).body.errors.voice_backend._errors[0].code, 'VOICE_BACKEND_UNAVAILABLE');
  assert.equal((await api('PATCH', '/admin/settings', root.token, { max_upload_bytes: 1024 * 1024, gifs_enabled: false })).status, 200);
  assert.deepEqual([(await api('GET', '/instance')).body.max_upload_bytes, (await api('GET', '/instance')).body.gifs_enabled], [1024 * 1024, false]);
  const big = await srv.upload(g.general.id, u.token, { content: '' }, [['big.bin', Buffer.alloc(1024 * 1024 + 10), 'application/octet-stream']]);
  assert.deepEqual([big.status, big.body.code], [413, 40005]);
  const small = await srv.upload(g.general.id, u.token, { content: '' }, [['small.bin', Buffer.alloc(1000), 'application/octet-stream']]);
  assert.equal(small.status, 201);
  await api('PATCH', '/admin/settings', root.token, { max_upload_bytes: 25 * 1024 * 1024, gifs_enabled: true });

  const gw = await srv.gateway(u.token);
  const sent = await api('POST', '/admin/announcements', root.token, { content: 'Maintenance tonight 22:00', dm: true });
  assert.equal(sent.status, 201);
  assert.ok(sent.body.dm_count >= 2);
  assert.equal((await gw.event('INSTANCE_ANNOUNCEMENT')).content, 'Maintenance tonight 22:00');
  const dmChannel = await gw.event('CHANNEL_CREATE');
  const dm = await gw.event('MESSAGE_CREATE', m => m.channel_id === dmChannel.id);
  assert.deepEqual([dm.content, dm.author.global_name, dm.author.system], ['Maintenance tonight 22:00', 'Cillhub System', true]);
  assert.equal((await api('GET', '/instance')).body.announcement.content, 'Maintenance tonight 22:00');
  assert.equal((await api('POST', `/channels/${dmChannel.id}/messages`, u.token, { content: 'hello?' })).body.code, 50007, 'one-way');
  assert.equal((await api('POST', '/auth/login', null, { login: dm.author.username, password: 'hunter2hunter2' })).status, 401);
  assert.equal((await api('DELETE', '/admin/announcements', root.token)).status, 204);
  assert.equal((await gw.event('INSTANCE_SETTINGS_UPDATE')).announcement, null);
});

test('overview: counts, chart data, storage, health and scrubbed errors', async () => {
  const o = (await api('GET', '/admin/overview', root.token)).body;
  assert.ok(o.users.total >= 5 && o.users.active_24h >= 1 && o.guilds >= 1);
  assert.equal(o.messages.per_day.length, 14);
  assert.ok(o.messages.per_day.at(-1).count >= 1);
  assert.equal(o.voice.minutes_per_day.length, 14);
  assert.deepEqual(o.voice.backends.livekit, { configured: false, reachable: null });
  assert.ok(o.storage.database_bytes > 0 && o.disk.total_bytes > 0 && o.uptime_seconds >= 0);
  assert.ok(Array.isArray(o.recent_errors));
  const s = scrub('LiveKit failed: Bearer abcdefghijklmnopqrstuvwxyz0123456789 at https://push.example/endpoint/xyz token=hunter2');
  assert.ok(!s.includes('abcdefghijklmnopqrstuvwxyz0123456789') && !s.includes('push.example') && !s.includes('hunter2'), s);
});
