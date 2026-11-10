// v8 modules: a malicious module tries every way out of its sandbox and its permissions. Each attempt must fail
// safely, be logged (at level system where the contract says so) and leave the server responsive.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { startServer, guildWith, tempDir, until } from './helpers.js';
import { makeAdmin, install, pkg, logged, logsOf, running } from './module-helpers.js';

let srv, api, root, g, alice, other, web, evil;
const say = (content, ch = g.general.id) => api('POST', `/channels/${ch}/messages`, alice.token, { content });
const see = (re, level, id = 'evil') => logged(srv, root, id, re, level);

const EVIL = `
const log = (...a) => console.log(...a);
const attempt = async (name, fn) => { try { log(name, 'gave', String(await fn())); } catch (e) { log(name, 'refused', e.code ?? e.name, String(e.message).slice(0, 120)); } };
cillhub.on('MESSAGE_CREATE', async m => {
  const [cmd, arg] = m.content.split(' ');
  if (cmd === 'probe') {
    log('globals', typeof process, typeof require, typeof setTimeout, typeof setInterval, typeof fetch, typeof XMLHttpRequest, typeof WebAssembly, typeof Buffer, typeof module, typeof globalThis.std, typeof globalThis.os);
    log('own globals', Object.getOwnPropertyNames(globalThis).filter(k => !/^[A-Z]/.test(k) && !['globalThis', 'undefined', 'console', 'cillhub', 'eval', 'isNaN', 'isFinite', 'parseInt', 'parseFloat', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape', 'unescape', 'queueMicrotask', 'structuredClone', 'navigator', 'performance', 'gc'].includes(k)).join(',') || 'none');
    await attempt('ctor', () => (function () {}).constructor('return typeof process + typeof require')());
    await attempt('ctor2', () => cillhub.call.constructor('return typeof this.process')());
    await attempt('ctor3', () => globalThis.constructor.constructor('return Object.keys(this).length')());
    await attempt('require', () => require('child_process'));
    await attempt('import fs', () => import('fs'));
    await attempt('import node:fs', () => import('node:fs'));
    await attempt('import url', () => import('https://example.com/x.js'));
    await attempt('import escape', () => import('../../../../etc/passwd.js'));
    await attempt('import file', () => import('file:///etc/passwd'));
    await attempt('recursion', () => { const f = n => f(n + 1) + 1; return f(0); });
    await attempt('oom caught', () => { const a = []; for (let i = 0; ; i++) a.push('x'.repeat(1e6) + i); });
    log('alive after oom');
  }
  if (cmd === 'storage') await attempt('storage', async () => JSON.stringify([await cillhub.storage.get('secret'), await cillhub.call('storage.get', { key: 'secret', module_id: 'victim' }), await cillhub.storage.list()]));
  if (cmd === 'fetch') for (const u of arg.split(',')) await attempt('fetch ' + u, async () => (await cillhub.http.fetch(u)).body);
  if (cmd === 'elsewhere') {
    await attempt('send elsewhere', () => cillhub.messages.send(arg, { content: 'x' }));
    await attempt('guild elsewhere', () => cillhub.guilds.get(m.guild_id === arg ? '0' : arg));
    await attempt('unknown channel', () => cillhub.messages.send('123', { content: 'x' }));
  }
  if (cmd === 'undeclared') { await attempt('members', () => cillhub.members.list(m.guild_id)); await attempt('roles', () => cillhub.members.addRole(m.guild_id, m.author.id, m.guild_id)); await attempt('channels', () => cillhub.channels.create(m.guild_id, 'made-by-evil')); }
  if (cmd === 'flood') { let ok = 0; for (let i = 0; i < 10; i++) { try { await cillhub.messages.send(m.channel_id, { content: 'spam ' + i }); ok++; } catch (e) { log('flood stopped', ok, e.code, typeof e.retry_after); break; } } }
  if (cmd === 'big') {
    await attempt('big call', () => cillhub.storage.set('k', 'x'.repeat(2e6)));
    for (let i = 0; i < 300; i++) console.log('flood line', i, 'y'.repeat(3000));
  }
  if (cmd === 'spin') for (;;) {}
  if (cmd === 'bomb') { const a = []; for (let i = 0; ; i++) a.push('x'.repeat(1e6) + i); }
});
cillhub.on('UI_REQUEST', () => 'z'.repeat(2e6));
`;

before(async () => {
  web = createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: `http://127.0.0.1:${web.address().port}/ok` }); return res.end(); }
    res.end('fetched ok');
  });
  await new Promise(r => web.listen(0, '::', r));
  const p = web.address().port;
  srv = await startServer({ env: { CILLCORD_MODULE_BACKOFF_MS: '20', CILLCORD_UNFURL_ALLOW: `127.0.0.1:${p},::1:${p}` } });
  api = srv.api;
  root = await makeAdmin(srv);
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice } = g.users);
  other = (await api('POST', '/guilds', alice.token, { name: 'Not for the module' })).body;
  const victim = await install(srv, root, pkg({ id: 'victim', permissions: ['messages.read', 'storage'] }, {
    'index.js': 'cillhub.on("MESSAGE_CREATE", async m => { if (m.content === "store") { await cillhub.storage.set("secret", "victim-data"); console.log("stored"); } });',
  }));
  assert.equal(victim.status, 'running');
  evil = await install(srv, root, pkg({ id: 'evil', permissions: ['messages.read', 'messages.send', 'storage', 'http.fetch', 'ui'], http_hosts: ['localhost', 'example.com'], ui: { panels: [{ id: 'p', slot: 'channel_panel', title: 'P', entry: 'p.html' }] } }, { 'index.js': EVIL, 'p.html': '' }),
    { patch: { scope: 'guilds', guild_ids: [g.guild.id] } });
});
after(async () => { if (process.env.DEBUG_LOGS) console.log((await logsOf(srv, root, 'evil')).slice(0, 60).reverse().map(l => `${l.level} ${l.message.slice(0, 160)}`).join('\n')); await srv.stop(); await new Promise(r => web.close(r)); });

test('no host objects: no process, require, timers or network; constructor chains stay inside QuickJS; imports refused; recursion and OOM caught', async () => {
  await say('probe');
  await see(/^globals undefined undefined undefined undefined undefined undefined undefined undefined undefined undefined undefined$/);
  await see(/^own globals none$/);
  await see(/^ctor gave undefinedundefined$/);
  await see(/^ctor2 gave undefined$/);
  await see(/^ctor3 gave 3$/); // `this` there is the QuickJS global, not the host's
  await see(/^require refused ReferenceError/);
  for (const what of ['import fs', 'import node:fs', 'import url', 'import escape', 'import file']) await see(new RegExp(`^${what} refused .*Cannot import`));
  await see(/^recursion refused RangeError/);
  await see(/^oom caught refused InternalError out of memory$/);
  await see(/^alive after oom$/);
  assert.equal((await api('GET', '/admin/modules/evil', root.token)).body.status, 'running');
});

test('another module\'s storage is out of reach', async () => {
  await say('store');
  await see(/^stored$/, null, 'victim');
  await say('storage');
  await see(/^storage gave \[null,null,{"items":\[\],"next":null}\]$/);
});

test('fetch: only approved hosts, never private addresses, redirects re-checked', async () => {
  const p = web.address().port;
  await say(`fetch http://localhost:${p}/ok,https://evil.example.org/,https://127.0.0.1/,https://169.254.169.254/latest/meta-data,https://[::1]/,https://localhost/,http://localhost:${p}/redirect,file:///etc/passwd`);
  await see(new RegExp(`^fetch http://localhost:${p}/ok gave fetched ok$`));
  for (const u of ['https://evil.example.org/', 'https://127.0.0.1/', 'https://169.254.169.254/latest/meta-data', 'https://\\[::1\\]/', 'https://localhost/', `http://localhost:${p}/redirect`, 'file:///etc/passwd']) {
    await see(new RegExp(`^fetch ${u.replace(/[./?]/g, '\\$&')} refused FETCH_REFUSED`));
  }
  await see(/^Refused http\.fetch: FETCH_REFUSED \(Fetch refused: address 127\.0\.0\.1:443 not allowed|^Refused http\.fetch: FETCH_REFUSED \(Fetch refused: address ::1:443 not allowed/, 'system');
  await see(/^Refused http\.fetch: FETCH_REFUSED \(Fetch refused: host 127\.0\.0\.1 is not an approved host/, 'system');
});

test('servers and permissions it was not given: NOT_ENABLED and PERMISSION_DENIED, logged', async () => {
  const otherCh = other.channels.find(c => c.type === 0);
  await say(`elsewhere ${otherCh.id}`);
  await see(/^send elsewhere refused NOT_ENABLED/);
  await see(/^unknown channel refused NOT_ENABLED/);
  await say(`elsewhere ${other.id}`);
  await see(/^guild elsewhere refused NOT_ENABLED/);
  await see(/^Refused messages\.send: NOT_ENABLED/, 'system');
  await say('undeclared');
  await see(/^members refused PERMISSION_DENIED/);
  await see(/^roles refused PERMISSION_DENIED/);
  await see(/^channels refused PERMISSION_DENIED/);
  await see(/^Refused members\.add_role: PERMISSION_DENIED \(members\.add_role needs the roles\.manage permission\.\)$/, 'system');
  const msgs = (await api('GET', `/channels/${otherCh.id}/messages`, alice.token)).body;
  assert.equal(msgs.length, 0, 'nothing reached the other server');
});

test('floods: sends are rate limited, huge outputs refused, the log keeps 100 lines per 10 s', async () => {
  await say('flood');
  await see(/^flood stopped 5 RATE_LIMITED number$/);
  await see(/^Refused messages\.send: RATE_LIMITED/, 'system');
  await say('big');
  await see(/^big call refused TOO_LARGE/);
  await see(/^Log limit reached/, 'system');
  const lines = (await logsOf(srv, root, 'evil')).filter(l => l.message.startsWith('flood line'));
  assert.ok(lines.length < 100 && lines.length > 50, String(lines.length));
  assert.ok(lines.every(l => l.message.length <= 2000));
  const ui = await api('POST', '/modules/evil/ui', alice.token, { panel_id: 'p', guild_id: g.guild.id });
  assert.equal(ui.status, 502);
  assert.match(ui.body.message, /too large/);
});

test('an infinite loop is interrupted while the server keeps answering; a memory bomb is stopped', async () => {
  await new Promise(r => setTimeout(r, 1000));
  await say('spin');
  const times = [];
  for (let i = 0; i < 10; i++) { const t = performance.now(); assert.equal((await api('GET', '/users/@me', alice.token)).status, 200); times.push(performance.now() - t); }
  assert.ok(Math.max(...times) < 150, `REST answered in ${times.map(Math.round)} ms`);
  await see(/^Sandbox failure: cpu: the module ran longer than 200 ms without yielding\.$/, 'system');
  await running(srv, root, 'evil');
  await say('bomb');
  await see(/^Sandbox failure: oom: the module ran out of memory\.$/, 'system');
  await running(srv, root, 'evil');
  const m = (await api('GET', '/admin/modules/evil', root.token)).body;
  assert.ok(m.stats.crashes >= 2 && m.stats.restarts >= 2);
});

test('5 failures within 10 minutes disable the module (crashed); enabling clears it', async () => {
  const crashy = await install(srv, root, pkg({ id: 'crashy', permissions: ['commands'], commands: [{ name: 'crashy', description: 'x' }] }, { 'index.js': 'import fs from "node:fs";' }), { enable: false });
  await api('PATCH', '/admin/modules/crashy', root.token, { enabled: true });
  await running(srv, root, 'crashy', 'crashed');
  const m = (await api('GET', '/admin/modules/crashy', root.token)).body;
  assert.deepEqual([m.enabled, m.status], [false, 'crashed']);
  assert.match(m.status_reason, /^5 failures within 10 minutes; the last: load failed: Error: Cannot import 'node:fs'/);
  await see(/^Disabled after 5 failures within 10 minutes\.$/, 'system', 'crashy');
  assert.equal((await logsOf(srv, root, 'crashy')).filter(l => l.message.startsWith('Sandbox failure')).length, 5);
  assert.ok(!(await api('GET', `/channels/${g.general.id}/application-command-index`, alice.token)).body.application_commands.some(c => c.application_id === crashy.application_id), 'commands hidden');
  assert.equal((await api('GET', `/guilds/${g.guild.id}/members/${crashy.application_id}`, alice.token)).status, 200, 'the bot stays in its servers');
  assert.equal((await srv.gateway(alice.token)).ready.presences.find(p => p.user.id === crashy.application_id), undefined, 'shown offline');
  const again = (await api('PATCH', '/admin/modules/crashy', root.token, { enabled: true })).body;
  assert.deepEqual([again.enabled, again.status_reason], [true, null]);
  await running(srv, root, 'crashy', 'crashed');
});

test('the sandbox process: no file access outside its grants, no child processes or workers, an empty environment', async () => {
  const dir = await tempDir();
  process.env.DATA_DIR = dir; // host.js opens the database on import
  const { SANDBOX_ARGS } = await import('../src/modules/host.js');
  const flags = SANDBOX_ARGS.filter(a => a.startsWith('--'));
  assert.ok(flags.includes('--permission') && !flags.some(f => /allow-(child-process|worker|addons|wasi|fs-write|inspector)/.test(f)));
  const probe = `
    const fs = require('node:fs'); const out = {};
    const tryIt = (k, fn) => { try { fn(); out[k] = 'ALLOWED'; } catch (e) { out[k] = e.code; } };
    tryIt('db', () => fs.readFileSync(${JSON.stringify(new URL('../src/db.js', import.meta.url).pathname)}));
    tryIt('data', () => fs.readdirSync(${JSON.stringify(srv.dataDir)}));
    tryIt('etc', () => fs.readFileSync('/etc/passwd'));
    tryIt('write', () => fs.writeFileSync('/tmp/cillhub-sandbox-probe', 'x'));
    tryIt('spawn', () => require('node:child_process').spawnSync('true'));
    tryIt('worker', () => new (require('node:worker_threads').Worker)('1', { eval: true }));
    tryIt('runner', () => fs.readFileSync(${JSON.stringify(new URL('../src/modules/sandbox/prelude.js', import.meta.url).pathname)}));
    out.env = Object.keys(process.env).length;
    console.log(JSON.stringify(out));`;
  const r = spawnSync(process.execPath, [...flags, '-e', probe], { env: {}, encoding: 'utf8' });
  const out = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(out, { db: 'ERR_ACCESS_DENIED', data: 'ERR_ACCESS_DENIED', etc: 'ERR_ACCESS_DENIED', write: 'ERR_ACCESS_DENIED', spawn: 'ERR_ACCESS_DENIED', worker: 'ERR_ACCESS_DENIED', runner: 'ALLOWED', env: 0 });
  await rm(dir, { recursive: true, force: true });
});
