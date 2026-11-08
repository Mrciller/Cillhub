// v8 modules, admin side: every /admin/modules route behind the admin gate, staging and the all-or-nothing approval,
// MFA elevation for install/update/remove, enable/disable, scope (the bot joins and leaves), settings (validation,
// per server, secrets never returned or audited), logs, update with the permission diff, install and update from Git,
// removal with and without keeping data, and the audit entries for each
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { startServer, guildWith, tempDir, until, png } from './helpers.js';
import { makeAdmin, install, stage, pkg, logsOf, logged, running, gitRepo, gitServer, tgz } from './module-helpers.js';

let srv, api, root, g, alice, bob, gitRoot, gitSrv, repo;
const ROUTES = [...readFileSync(new URL('../src/routes/modules.js', import.meta.url), 'utf8').matchAll(/\['(GET|POST|PUT|PATCH|DELETE)', '(\/admin[^']*)'/g)].map(m => [m[1], m[2]]);
const audit = async (action, id) => (await api('GET', `/admin/audit-log?action=${action}${id ? `&target_id=${id}` : ''}`, root.token)).body;
const db = fn => { const d = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite')); try { return fn(d); } finally { d.close(); } };
const formErr = r => Object.entries(r.body.errors ?? {}).map(([k, v]) => [k, v._errors[0].code])[0];

before(async () => {
  gitRoot = await tempDir();
  gitSrv = await gitServer(gitRoot);
  repo = gitRepo(gitRoot, 'gitmod', pkg({ id: 'gitmod', permissions: ['storage'] }, { 'index.js': 'cillhub.on("READY", () => console.log("git v1"));' }));
  srv = await startServer({ env: { CILLCORD_UNFURL_ALLOW: `127.0.0.1:${gitSrv.port}`, CILLCORD_MODULE_BACKOFF_MS: '50' } });
  api = srv.api;
  root = await makeAdmin(srv);
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice, bob } = g.users);
});
after(async () => {
  await srv.stop();
  await gitSrv.close();
  await rm(gitRoot, { recursive: true, force: true });
});

test('every /admin/modules route refuses anonymous users, non-admins, bots and admins without 2FA', async () => {
  assert.ok(ROUTES.length >= 13, 'routes found in the source');
  const nomfa = await srv.register('nomfa');
  const { execFileSync } = await import('node:child_process');
  execFileSync(process.execPath, ['src/admin-cli.js', 'grant', 'nomfa'], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: srv.dataDir }, stdio: 'ignore' });
  const app = (await api('POST', '/applications', bob.token, { name: 'NotAdmin' })).body;
  const botToken = `Bot ${(await api('POST', `/applications/${app.id}/bot/reset`, bob.token, {})).body.token}`;
  const path = p => p.replace(':module_id', 'some-module').replace(':guild_id', g.guild.id);
  for (const [method, p] of ROUTES) {
    const body = method === 'GET' ? undefined : {};
    const what = `${method} ${p}`;
    assert.equal((await api(method, path(p), null, body)).status, 401, what);
    assert.deepEqual([(await api(method, path(p), bob.token, body)).body.code], [50001], what);
    assert.deepEqual([(await api(method, path(p), nomfa.token, body)).body.code], [60003], what);
    assert.equal((await api(method, path(p), botToken, body)).status, 403, what);
  }
  assert.equal((await api('GET', '/admin/modules', root.token)).status, 200);
  assert.equal((await api('GET', '/admin/modules/nope', root.token)).body.code, 10090);
});

const SETTINGS = [
  { key: 'channel', type: 'channel', label: 'Channel', per_server: true },
  { key: 'greeting', type: 'text', label: 'Greeting', default: 'Hello', required: true, per_server: true },
  { key: 'limit', type: 'number', label: 'Limit', integer: true, min: 1, max: 10 },
  { key: 'token', type: 'secret', label: 'Token' },
  { key: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
  { key: 'role', type: 'role', label: 'Role' },
  { key: 'gone', type: 'toggle', label: 'Removed in v2' },
];
const v1 = pkg({ id: 'welcome', name: 'Welcome', permissions: ['commands', 'messages.send', 'storage'], icon: 'icon.png', commands: [{ name: 'welcome', description: 'Say welcome' }], settings: SETTINGS }, {
  'index.js': 'cillhub.on("READY", r => console.log("version", r.module.version));', 'icon.png': png(),
});

test('stage, approve all or nothing, install with MFA: a disabled module with its own bot and no token', async () => {
  const s = await stage(srv, root, v1);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.match(s.body.package_id, /^[0-9a-f]{32}$/);
  assert.deepEqual([s.body.source.type, s.body.source.filename, s.body.manifest.id, s.body.files, s.body.update_of, s.body.warnings], ['file', 'module.tgz', 'welcome', 3, null, []]);
  assert.deepEqual(s.body.permissions, ['commands', 'messages.send', 'storage']);
  assert.ok(Date.parse(s.body.expires_at) - Date.now() > 29 * 60 * 1000);
  const install_ = (body, headers) => api('POST', '/admin/modules', root.token, { package_id: s.body.package_id, ...body }, headers);
  assert.deepEqual(formErr(await install_({ approve: { permissions: ['commands', 'storage'], http_hosts: [] } }, root.elevated)), ['approve', 'MODULE_PERMISSIONS_NOT_APPROVED']);
  assert.deepEqual(formErr(await install_({ approve: { permissions: ['commands', 'messages.send', 'storage', 'ui'], http_hosts: [] } }, root.elevated)), ['approve', 'MODULE_PERMISSIONS_NOT_APPROVED']);
  assert.deepEqual(formErr(await install_({})), ['approve', 'MODULE_PERMISSIONS_NOT_APPROVED']);
  const approve = { permissions: ['storage', 'commands', 'messages.send'], http_hosts: [] }; // a set: order does not matter
  const noMfa = await install_({ approve });
  assert.deepEqual([noMfa.status, noMfa.body.code, typeof noMfa.body.mfa.ticket], [401, 60003, 'string']);
  assert.equal((await install_({ approve, code: '000000' })).body.code, 60008);
  const m = await install_({ approve, code: root.mfa() });
  assert.equal(m.status, 201, JSON.stringify(m.body));
  assert.deepEqual([m.body.id, m.body.name, m.body.version, m.body.enabled, m.body.status, m.body.scope, m.body.per_server_settings, m.body.http_url], ['welcome', 'Welcome', '1.0.0', false, 'disabled', 'all', false, null]);
  assert.match(m.body.icon, /^[0-9a-f]{32}$/);
  assert.deepEqual(m.body.commands, [{ name: 'welcome', type: 1, description: 'Say welcome' }]);
  assert.deepEqual(m.body.settings, { channel: null, greeting: 'Hello', limit: null, token: { set: false }, mode: null, role: null, gone: null });
  assert.deepEqual(m.body.storage, { used_bytes: 0, quota_bytes: 5242880 });
  assert.equal((await install_({ approve, code: root.mfa() })).body.code, 10091, 'a package installs once');
  assert.deepEqual(formErr(await stage(srv, root, v1)), ['id', 'MODULE_ID_TAKEN']);
  // the bot: module flag, the manifest name and icon, username = id; its application cannot be managed or installed by anyone
  const bot = (await api('GET', `/users/${m.body.application_id}`, alice.token)).body;
  assert.deepEqual([bot.bot, bot.module, bot.global_name, bot.username, bot.avatar], [true, true, 'Welcome', 'welcome', m.body.icon]);
  assert.equal((await api('GET', `/applications/${m.body.application_id}`, alice.token)).status, 403);
  const oauth = await api('POST', `/oauth2/authorize?client_id=${m.body.application_id}&scope=bot`, alice.token, { authorize: true, guild_id: g.guild.id });
  assert.equal(oauth.status, 403);
  assert.ok(!db(d => d.prepare('SELECT 1 FROM tokens WHERE user_id = ?').get(m.body.application_id)), 'no token was ever issued');
  assert.ok(existsSync(join(srv.dataDir, 'modules', 'welcome', 'index.js')));
  const [pk] = await audit('module.package', 'welcome');
  assert.deepEqual([pk.details.version, pk.details.source, pk.details.update], ['1.0.0', 'file', false]);
  const [ins] = await audit('module.install', 'welcome');
  assert.deepEqual(ins.details, { id: 'welcome', version: '1.0.0', permissions: ['commands', 'messages.send', 'storage'], http_hosts: [] });
  assert.equal(ins.target_type, 'module');
});

test('packages: wrong files and expired ids are refused with the contract codes', async () => {
  const up = (name, bytes) => srv.form('POST', '/admin/modules/packages', root.token, new Map(), [['file', name, bytes, 'application/octet-stream']]);
  assert.deepEqual(formErr(await up('x.zip', Buffer.from('plain text'))), ['file', 'MODULE_PACKAGE_INVALID']);
  assert.deepEqual(formErr(await up('x.tgz', tgz({ 'index.js': '' }))), ['file', 'MODULE_PACKAGE_INVALID'], 'no manifest');
  assert.deepEqual(formErr(await up('x.tgz', tgz({ 'cillhub-module.json': '{"manifest_version":1}' }))), ['id', 'MODULE_MANIFEST_INVALID']);
  assert.deepEqual(formErr(await up('x.tgz', Buffer.alloc(5 * 1024 * 1024 + 10))), ['file', 'MODULE_PACKAGE_TOO_LARGE']);
  assert.deepEqual(formErr(await api('POST', '/admin/modules/packages', root.token, {})), ['file', 'MODULE_PACKAGE_INVALID']);
  assert.equal((await api('POST', '/admin/modules', root.token, { package_id: 'f'.repeat(32), approve: { permissions: [], http_hosts: [] } }, root.elevated)).body.code, 10091);
  assert.deepEqual(formErr(await api('POST', '/admin/modules/packages', root.token, { git_url: 'file:///etc' })), ['git_url', 'MODULE_GIT_REFUSED']);
  assert.deepEqual(formErr(await api('POST', '/admin/modules/packages', root.token, { git_url: 'https://127.0.0.1/x.git' })), ['git_url', 'MODULE_GIT_REFUSED']);
});

test('enable: the bot joins every server with a managed role, its commands appear; disable hides them', async () => {
  const gw = await srv.gateway(alice.token);
  const on = await api('PATCH', '/admin/modules/welcome', root.token, { enabled: true });
  assert.equal(on.body.enabled, true);
  const joined = await gw.event('GUILD_MEMBER_ADD', d => d.user.module);
  const botId = joined.user.id;
  const role = (await api('GET', `/guilds/${g.guild.id}/roles`, alice.token)).body.find(r => r.tags?.bot_id === botId);
  // View Channels, Send Messages, Embed Links, Attach Files, Add Reactions, External Emoji, Use Application Commands, in threads
  assert.equal(BigInt(role.permissions), (1n << 10n) | (1n << 11n) | (1n << 14n) | (1n << 15n) | (1n << 6n) | (1n << 18n) | (1n << 31n) | (1n << 38n));
  assert.equal(role.managed, true);
  await running(srv, root, 'welcome');
  await logged(srv, root, 'welcome', /^version 1\.0\.0$/);
  const presence = (await srv.gateway(alice.token)).ready.presences.find(p => p.user.id === botId);
  assert.equal(presence?.status, 'online');
  const names = async () => (await api('GET', `/channels/${g.general.id}/application-command-index`, alice.token)).body.application_commands.map(c => c.name);
  assert.ok((await names()).includes('welcome'));
  // a server owner restricts the module with an overwrite on its managed role; disable and enable must keep both
  assert.equal((await api('PUT', `/channels/${g.general.id}/permissions/${role.id}`, alice.token, { type: 0, allow: '0', deny: String(1n << 11n) })).status, 204);
  assert.equal((await api('PATCH', '/admin/modules/welcome', root.token, { enabled: false })).body.status, 'disabled');
  assert.ok(!(await names()).includes('welcome'), 'commands hidden');
  assert.ok((await api('GET', `/guilds/${g.guild.id}/members/${botId}`, alice.token)).status === 200, 'the bot stays in its servers');
  await logged(srv, root, 'welcome', /^Stopped: the module was disabled\.$/, 'system');
  assert.equal((await api('POST', '/admin/modules/welcome/restart', root.token, {})).status, 400);
  assert.equal((await srv.gateway(alice.token)).ready.presences.find(p => p.user.id === botId), undefined, 'shown offline while disabled');
  await api('PATCH', '/admin/modules/welcome', root.token, { enabled: true });
  await running(srv, root, 'welcome');
  assert.ok(await gw.none(f => ['GUILD_MEMBER_REMOVE', 'GUILD_ROLE_DELETE'].includes(f.t) || (f.t === 'GUILD_MEMBER_ADD' && f.d.user.id === botId)), 'no leave and re-join');
  assert.equal((await api('GET', `/guilds/${g.guild.id}/roles`, alice.token)).body.find(r => r.tags?.bot_id === botId).id, role.id, 'the same managed role');
  assert.ok((await api('GET', `/channels/${g.general.id}`, alice.token)).body.permission_overwrites.some(o => o.id === role.id && o.deny === String(1n << 11n)), 'the overwrite stays');
  await api('DELETE', `/channels/${g.general.id}/permissions/${role.id}`, alice.token);
  assert.equal((await audit('module.enable', 'welcome')).length, 2);
  assert.equal((await audit('module.disable', 'welcome')).length, 1);
  const r = await api('POST', '/admin/modules/welcome/restart', root.token, {});
  assert.equal(r.status, 200);
  await running(srv, root, 'welcome');
  assert.equal((await audit('module.restart', 'welcome')).length, 1);
});

test('scope: chosen servers only; the bot leaves the others, returns after a kick only when the list is saved; new servers join under all', async () => {
  const other = (await api('POST', '/guilds', alice.token, { name: 'Other' })).body;
  const botId = (await api('GET', '/admin/modules/welcome', root.token)).body.application_id;
  const member = id => api('GET', `/guilds/${id}/members/${botId}`, alice.token).then(r => r.status === 200);
  await until(() => member(other.id)); // scope all: a server created later gets the bot
  const p = await api('PATCH', '/admin/modules/welcome', root.token, { scope: 'guilds', guild_ids: [g.guild.id] });
  assert.deepEqual([p.body.scope, p.body.guild_ids], ['guilds', [g.guild.id]]);
  assert.equal(await member(other.id), false);
  assert.equal(await member(g.guild.id), true);
  const [cfg] = await audit('module.update_config', 'welcome');
  assert.deepEqual(cfg.details, { scope: 'guilds', guild_ids: [g.guild.id] });
  assert.deepEqual(formErr(await api('PATCH', '/admin/modules/welcome', root.token, { guild_ids: ['123'] })), ['guild_ids', 'BASE_TYPE_INVALID']);
  // a server owner kicks the bot: it stays out until an admin saves the list again
  assert.equal((await api('DELETE', `/guilds/${g.guild.id}/members/${botId}`, alice.token)).status, 204);
  assert.equal(await member(g.guild.id), false);
  await api('PATCH', '/admin/modules/welcome', root.token, { guild_ids: [g.guild.id] });
  assert.equal(await member(g.guild.id), true);
  await api('PATCH', '/admin/modules/welcome', root.token, { scope: 'all' });
  assert.equal(await member(other.id), true);
});

test('settings: validated, secrets never returned or audited, per-server values only when turned on', async () => {
  const put = values => api('PUT', '/admin/modules/welcome/settings', root.token, { values });
  const err = async values => formErr(await put(values));
  assert.deepEqual(await err({ nope: 1 }), ['values.nope', 'MODULE_SETTING_INVALID']);
  assert.deepEqual(await err({ limit: 11 }), ['values.limit', 'MODULE_SETTING_INVALID']);
  assert.deepEqual(await err({ limit: 1.5 }), ['values.limit', 'MODULE_SETTING_INVALID']);
  assert.deepEqual(await err({ mode: 'c' }), ['values.mode', 'MODULE_SETTING_INVALID']);
  assert.deepEqual(await err({ channel: '1' }), ['values.channel', 'MODULE_SETTING_INVALID']);
  assert.deepEqual(await err({ greeting: null }), ['values.greeting', 'MODULE_SETTING_INVALID'], 'required');
  assert.deepEqual(await err({ greeting: 'two\nlines' }), ['values.greeting', 'MODULE_SETTING_INVALID']);
  assert.deepEqual(await err('x'), ['values', 'MODULE_SETTING_INVALID']);
  const ok = await put({ channel: g.general.id, limit: 3, token: 'super-secret-4711', mode: 'b', role: g.guild.id });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual(ok.body.settings, { channel: g.general.id, greeting: 'Hello', limit: 3, token: { set: true }, mode: 'b', role: g.guild.id, gone: null });
  assert.ok(!JSON.stringify((await api('GET', '/admin/modules', root.token)).body).includes('super-secret-4711'));
  assert.ok(!JSON.stringify((await api('GET', '/admin/audit-log?limit=200', root.token)).body).includes('super-secret-4711'), 'never in the audit log');
  assert.deepEqual((await audit('module.settings', 'welcome'))[0].details.keys, ['channel', 'limit', 'token', 'mode', 'role']);
  assert.deepEqual((await put({ token: null, limit: null })).body.settings.token, { set: false });
  // per server
  const gp = (method, values) => api(method, `/admin/modules/welcome/guilds/${g.guild.id}/settings`, root.token, method === 'GET' ? undefined : { values });
  assert.deepEqual(formErr(await gp('PUT', { greeting: 'Hi' })), ['per_server_settings', 'MODULE_SETTING_INVALID']);
  assert.equal((await api('PATCH', '/admin/modules/welcome', root.token, { per_server_settings: true })).body.per_server_settings, true);
  assert.deepEqual(formErr(await gp('PUT', { limit: 2 })), ['values.limit', 'MODULE_SETTING_INVALID'], 'not a per-server key');
  const other = (await api('POST', '/guilds', bob.token, { name: 'Bobs' })).body;
  const otherCh = other.channels.find(c => c.type === 0);
  assert.deepEqual(formErr(await gp('PUT', { channel: otherCh.id })), ['values.channel', 'MODULE_SETTING_INVALID'], 'a channel of that server only');
  const set = await gp('PUT', { greeting: 'Servus', channel: g.general.id });
  assert.deepEqual(set.body, { guild_id: g.guild.id, values: { greeting: 'Servus', channel: g.general.id } });
  assert.deepEqual((await gp('GET')).body, set.body);
  assert.deepEqual((await audit('module.guild_settings', 'welcome'))[0].details, { guild_id: g.guild.id, keys: ['greeting', 'channel'] });
  assert.equal((await gp('DELETE')).status, 204);
  assert.deepEqual((await gp('GET')).body.values, {});
  assert.equal((await audit('module.guild_settings_reset', 'welcome')).length, 1);
  await gp('PUT', { greeting: 'Servus' });
});

test('logs: newest first, limit and before', async () => {
  const all = await logsOf(srv, root, 'welcome');
  assert.ok(all.length >= 5);
  assert.ok(all.every(l => /^\d+$/.test(l.id) && ['debug', 'info', 'warn', 'error', 'system'].includes(l.level) && !Number.isNaN(Date.parse(l.at))));
  assert.ok(Number(all[0].id) > Number(all[1].id));
  const page = (await api('GET', `/admin/modules/welcome/logs?limit=2&before=${all[1].id}`, root.token)).body;
  assert.deepEqual(page.map(l => l.id), all.slice(2, 4).map(l => l.id));
  assert.equal((await api('GET', '/admin/modules/welcome/logs?limit=501', root.token)).status, 400);
});

test('update: the permission diff, the whole new list approved, settings kept where key and type stay, new code runs', async () => {
  const v2settings = SETTINGS.filter(s => s.key !== 'gone').map(s => (s.key === 'mode' ? { key: 'mode', type: 'text', label: 'Mode' } : s));
  const v2 = pkg({ id: 'welcome', name: 'Welcome 2', version: '2.0.0', permissions: ['commands', 'storage', 'members.read'], commands: [{ name: 'hello', description: 'Say hello' }], settings: v2settings }, {
    'index.js': 'cillhub.on("READY", r => console.log("version", r.module.version));',
  });
  assert.deepEqual(formErr(await stage(srv, root, pkg({ id: 'other-id' }, { 'index.js': '' }), 'welcome')), ['module_id', 'MODULE_ID_MISMATCH']);
  const s = await stage(srv, root, v2, 'welcome');
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.deepEqual(s.body.update_of, { module_id: 'welcome', from_version: '1.0.0', added_permissions: ['members.read'], removed_permissions: ['messages.send'], added_http_hosts: [], removed_http_hosts: [] });
  assert.deepEqual(s.body.warnings, []);
  const same = await stage(srv, root, v1, 'welcome');
  assert.deepEqual(same.body.warnings, ['The version is not higher than the installed 2.0.0.'.replace('2.0.0', '1.0.0')]);
  assert.equal((await api('POST', '/admin/modules', root.token, { package_id: s.body.package_id, approve: { permissions: s.body.permissions, http_hosts: [] } }, root.elevated)).body.errors.id._errors[0].code, 'MODULE_ID_TAKEN', 'an update is not an install');
  const put = body => api('PUT', '/admin/modules/welcome/package', root.token, { package_id: s.body.package_id, ...body });
  assert.deepEqual(formErr(await put({ approve: { permissions: ['members.read'], http_hosts: [] } })), ['approve', 'MODULE_PERMISSIONS_NOT_APPROVED'], 'not just the added ones');
  assert.equal((await put({ approve: { permissions: s.body.permissions, http_hosts: [] } })).body.code, 60003);
  const up = await put({ approve: { permissions: s.body.permissions, http_hosts: [] }, code: root.mfa() });
  assert.equal(up.status, 200, JSON.stringify(up.body));
  assert.deepEqual([up.body.version, up.body.name, up.body.icon], ['2.0.0', 'Welcome 2', null]);
  assert.deepEqual(up.body.settings, { channel: g.general.id, greeting: 'Hello', limit: null, token: { set: false }, mode: null, role: g.guild.id });
  assert.deepEqual((await api('GET', `/admin/modules/welcome/guilds/${g.guild.id}/settings`, root.token)).body.values, { greeting: 'Servus' }, 'per-server values stay');
  await logged(srv, root, 'welcome', /^version 2\.0\.0$/); // a running module restarts with the new code
  const names = (await api('GET', `/channels/${g.general.id}/application-command-index`, alice.token)).body.application_commands.filter(c => c.application_id === up.body.application_id).map(c => c.name);
  assert.deepEqual(names, ['hello']);
  const role = (await api('GET', `/guilds/${g.guild.id}/roles`, alice.token)).body.find(r => r.tags?.bot_id === up.body.application_id);
  assert.equal(BigInt(role.permissions) & (1n << 11n), 0n, 'the managed role lost Send Messages');
  assert.deepEqual((await audit('module.upgrade', 'welcome'))[0].details, { from: '1.0.0', to: '2.0.0', added_permissions: ['members.read'] });
});

test('Git: install from a URL through the test hatch, update from the stored source after a new commit', async () => {
  const url = `http://127.0.0.1:${gitSrv.port}/gitmod.git`;
  const s = await api('POST', '/admin/modules/packages', root.token, { git_url: url, git_ref: 'main' });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  assert.deepEqual(s.body.source, { type: 'git', filename: null, git_url: url, git_ref: 'main', commit: repo.first });
  const m = await api('POST', '/admin/modules', root.token, { package_id: s.body.package_id, approve: { permissions: ['storage'], http_hosts: [] } }, root.elevated);
  assert.equal(m.status, 201);
  assert.equal((await api('POST', '/admin/modules/packages', root.token, { module_id: 'welcome' })).body.errors.module_id._errors[0].code, 'MODULE_GIT_REFUSED', 'not from Git');
  const next = repo.commit({ 'index.js': 'cillhub.on("READY", () => console.log("git v2"));', 'cillhub-module.json': JSON.parse(JSON.stringify(pkg({ id: 'gitmod', version: '1.1.0', permissions: ['storage'] })))['cillhub-module.json'] });
  const u = await api('POST', '/admin/modules/packages', root.token, { module_id: 'gitmod' });
  assert.equal(u.status, 201, JSON.stringify(u.body));
  assert.deepEqual([u.body.source.commit, u.body.update_of.from_version, u.body.manifest.version], [next, '1.0.0', '1.1.0']);
  const up = await api('PUT', '/admin/modules/gitmod/package', root.token, { package_id: u.body.package_id, approve: { permissions: ['storage'], http_hosts: [] } }, root.elevated);
  assert.deepEqual([up.status, up.body.source.commit, up.body.version], [200, next, '1.1.0']);
  assert.match(readFileSync(join(srv.dataDir, 'modules', 'gitmod', 'index.js'), 'utf8'), /git v2/);
});

test('remove: confirm and MFA; the bot leaves and becomes a deleted user; data kept or deleted', async () => {
  const mod = (await api('GET', '/admin/modules/welcome', root.token)).body;
  const msg = (await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: 'stays' })).body;
  db(d => d.prepare("INSERT INTO module_storage (module_id, key, value, size) VALUES ('welcome', 'k', '1', 2)").run());
  db(d => d.prepare("UPDATE messages SET author_id = ? WHERE id = ?").run(mod.application_id, msg.id)); // a message by the bot
  const del = body => api('DELETE', '/admin/modules/welcome', root.token, body);
  assert.deepEqual(formErr(await del({ confirm: 'wrong', keep_data: true })), ['confirm', 'CONFIRMATION_MISMATCH']);
  assert.equal((await del({ confirm: 'welcome', keep_data: true })).body.code, 60003);
  assert.equal((await del({ confirm: 'welcome', keep_data: true, code: root.mfa() })).status, 204);
  assert.equal((await api('GET', '/admin/modules/welcome', root.token)).body.code, 10090);
  assert.equal((await api('GET', `/guilds/${g.guild.id}/members/${mod.application_id}`, alice.token)).status, 404);
  const kept = (await api('GET', `/channels/${g.general.id}/messages/${msg.id}`, alice.token)).body;
  assert.deepEqual([kept.content, kept.author.global_name], ['stays', 'Deleted User']);
  assert.ok(!existsSync(join(srv.dataDir, 'modules', 'welcome')));
  assert.ok(!(await api('GET', `/channels/${g.general.id}/application-command-index`, alice.token)).body.application_commands.some(c => c.application_id === mod.application_id));
  const rows = t => db(d => d.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE module_id = 'welcome'`).get().n);
  assert.deepEqual([rows('module_storage'), rows('module_settings') > 0, rows('module_logs')], [1, true, 0]);
  assert.deepEqual((await audit('module.remove', 'welcome'))[0].details, { keep_data: true });
  // a later install of the same id finds its storage and settings again
  const again = await install(srv, root, v1, { enable: false });
  assert.deepEqual([again.storage.used_bytes, again.settings.channel], [2, g.general.id]);
  assert.notEqual(again.application_id, mod.application_id);
  assert.equal((await api('DELETE', '/admin/modules/welcome', root.token, { confirm: 'welcome', keep_data: false }, root.elevated)).status, 204);
  assert.deepEqual([rows('module_storage'), rows('module_settings')], [0, 0]);
});

test('at most 50 modules per instance', async () => {
  const manifest = db(d => d.prepare("SELECT manifest FROM modules WHERE id = 'gitmod'").get().manifest);
  const n = db(d => d.prepare('SELECT COUNT(*) AS n FROM modules').get().n);
  db(d => { for (let i = n; i < 50; i++) d.prepare("INSERT INTO modules (id, app_id, manifest, source, installed_at, updated_at) VALUES (?, ?, ?, '{}', 0, 0)").run(`filler-${i}`, `9${i}`, manifest); });
  const s = await stage(srv, root, pkg({ id: 'one-too-many' }, { 'index.js': '' }));
  const r = await api('POST', '/admin/modules', root.token, { package_id: s.body.package_id, approve: { permissions: [], http_hosts: [] } }, root.elevated);
  assert.deepEqual(formErr(r), ['package_id', 'MODULE_LIMIT_REACHED']);
  db(d => d.prepare("DELETE FROM modules WHERE id LIKE 'filler-%'").run());
});

test('module settings: inherited property names do not resolve to Object.prototype', async () => {
  const modPkg = pkg({
    id: 'protoset',
    name: 'ProtoSet',
    permissions: ['storage', 'messages.read'],
    settings: [
      { key: 'constructor', type: 'text', label: 'Constructor setting', default: 'default_str', per_server: true },
    ],
  }, {
    'index.js': `
cillhub.on("READY", () => console.log("protoset ready"));
cillhub.on("MESSAGE_CREATE", async m => {
  if (m.content === "!testproto") {
    console.log("settings:", JSON.stringify(await cillhub.settings.get(m.guild_id)));
  }
});
`,
  });
  const inst = await install(srv, root, modPkg, { patch: { per_server_settings: true } });
  assert.equal(inst.status, 'running');
  await logged(srv, root, 'protoset', /^protoset ready$/);

  await api('POST', `/channels/${g.general.id}/messages`, alice.token, { content: '!testproto' });
  await logged(srv, root, 'protoset', /^settings: \{"constructor":"default_str"\}$/);

  await api('DELETE', '/admin/modules/protoset', root.token, { confirm: 'protoset', keep_data: false }, root.elevated);
});

