// v8 modules, in-process: manifest validation (every field rule), archive unpacking with its limits and attacks, and
// the Git URL rules and clone against a local smart-HTTP Git server (allowed only through CILLCORD_UNFURL_ALLOW)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tempDir, png } from './helpers.js';
import { tgz, zip, gitRepo, gitServer } from './module-helpers.js';

let tmp, gitRoot, server, validateManifest, unpack, fetchGit, checkGitUrl, repo;
before(async () => {
  tmp = await tempDir();
  process.env.DATA_DIR = join(tmp, 'data'); // manifest.js reaches commands.js, which opens the database
  gitRoot = join(tmp, 'git');
  server = await gitServer(gitRoot);
  process.env.CILLCORD_UNFURL_ALLOW = `127.0.0.1:${server.port}`; // ssrf.js reads it on import
  ({ validateManifest } = await import('../src/modules/manifest.js'));
  ({ unpack, fetchGit, checkGitUrl } = await import('../src/modules/package.js'));
  repo = gitRepo(gitRoot, 'mod', { 'cillhub-module.json': '{"manifest_version":1,"id":"from-git","name":"Git","version":"1.0.0"}', 'index.js': '// v1\n', 'lib/a.js': 'export {}\n' });
});
after(async () => { await server.close(); await rm(tmp, { recursive: true, force: true }); });

const files = (extra = {}) => new Map(Object.entries({ 'index.js': '', 'ui/board.html': '', 'icon.png': png(), 'big.png': Buffer.alloc(300 * 1024, 0x89), ...extra }).map(([k, v]) => [k, Buffer.from(v)]));
const base = { manifest_version: 1, id: 'scrim-board', name: 'Scrim Board', version: '1.0.0' };
const ok = (m, f = files()) => validateManifest({ ...base, ...m }, f);
const bad = (m, field, f = files()) => {
  try { validateManifest({ ...base, ...m }, f); } catch (e) {
    const [k, v] = Object.entries(e.body.errors)[0];
    assert.equal(v._errors[0].code, 'MODULE_MANIFEST_INVALID');
    assert.ok(k.startsWith(field), `${field} expected, got ${k}: ${v._errors[0].message}`);
    assert.ok(v._errors[0].message.startsWith(k), 'the message names the field');
    return;
  }
  assert.fail(`${JSON.stringify(m)} was accepted`);
};

test('manifest: defaults and every field rule', () => {
  const m = ok({});
  assert.deepEqual([m.main, m.permissions, m.http_hosts, m.commands, m.settings, m.ui.panels, m.icon], ['index.js', [], [], [], [], [], null]);
  bad({ manifest_version: 2 }, 'manifest_version');
  for (const id of ['ab', '-abc', 'abc-', 'ABC', 'a_bc', 'a'.repeat(41)]) bad({ id }, 'id');
  ok({ id: 'abc' }); ok({ id: 'a'.repeat(40) });
  bad({ name: '' }, 'name'); bad({ name: 'x'.repeat(65) }, 'name');
  for (const version of ['1.0', '1.0.0.0', 'v1.0.0', '01.0.0']) bad({ version }, 'version');
  ok({ version: '2.10.3-beta.1' });
  bad({ description: 'x'.repeat(401) }, 'description'); bad({ author: 'x'.repeat(101) }, 'author');
  bad({ homepage: 'http://example.com' }, 'homepage'); bad({ homepage: 'https://' + 'x'.repeat(300) }, 'homepage'); ok({ homepage: 'https://example.com' });
  bad({ main: 'missing.js' }, 'main'); bad({ main: 'ui/board.html' }, 'main');
  bad({ icon: 'missing.png' }, 'icon'); bad({ icon: 'index.js' }, 'icon'); bad({ icon: 'big.png' }, 'icon'); ok({ icon: 'icon.png' });
  bad({ permissions: ['root'] }, 'permissions'); bad({ permissions: ['ui', 'ui'] }, 'permissions'); bad({ permissions: 'ui' }, 'permissions');
  bad({ unknown_field: true }, 'manifest.unknown_field');
});

test('manifest: http_hosts, commands, settings and panels', () => {
  bad({ permissions: ['http.fetch'] }, 'http_hosts'); bad({ http_hosts: ['example.com'] }, 'http_hosts');
  for (const h of ['1.2.3.4', 'example.com:443', 'https://example.com', '*.*.example.com', '*.com', 'Example.com', 'a*.example.com', '[::1]']) bad({ permissions: ['http.fetch'], http_hosts: [h] }, 'http_hosts');
  bad({ permissions: ['http.fetch'], http_hosts: Array.from({ length: 21 }, (_, i) => `h${i}.example.com`) }, 'http_hosts');
  assert.deepEqual(ok({ permissions: ['http.fetch'], http_hosts: ['api.example.com', '*.twitch.tv'] }).http_hosts, ['api.example.com', '*.twitch.tv']);

  const cmd = { name: 'scrim', description: 'Add a scrim' };
  bad({ commands: [cmd] }, 'commands');
  assert.deepEqual(ok({ permissions: ['commands'], commands: [cmd] }).commands[0].contexts, [0]);
  bad({ permissions: ['commands'], commands: [{ name: 'Bad Name', description: 'x' }] }, 'commands.0.name');
  bad({ permissions: ['commands'], commands: [cmd, cmd] }, 'commands');
  bad({ permissions: ['commands'], commands: Array.from({ length: 26 }, (_, i) => ({ name: `c${i}`, description: 'x' })) }, 'commands');

  const s = (x, field = 'settings.0') => bad({ settings: [x] }, field);
  s({ key: 'Bad', type: 'text', label: 'L' }, 'settings.0.key');
  s({ key: 'a', type: 'colour', label: 'L' }, 'settings.0.type');
  s({ key: 'a', type: 'text', label: '' }, 'settings.0.label');
  s({ key: 'a', type: 'text', label: 'L', max_length: 2001 }, 'settings.0.max_length');
  s({ key: 'a', type: 'text', label: 'L', default: 'x'.repeat(201) }, 'settings.0.default');
  s({ key: 'a', type: 'number', label: 'L', min: 5, max: 1 }, 'settings.0.min');
  s({ key: 'a', type: 'number', label: 'L', integer: true, default: 1.5 }, 'settings.0.default');
  s({ key: 'a', type: 'select', label: 'L', options: [] }, 'settings.0.options');
  s({ key: 'a', type: 'select', label: 'L', options: [{ value: 'x', label: 'X' }], default: 'y' }, 'settings.0.default');
  s({ key: 'a', type: 'channel', label: 'L', default: '1' }, 'settings.0.default');
  s({ key: 'a', type: 'secret', label: 'L', default: 'x' }, 'settings.0.default');
  s({ key: 'a', type: 'toggle', label: 'L', max_length: 3 }, 'settings.0.max_length');
  bad({ settings: [{ key: 'a', type: 'toggle', label: 'L' }, { key: 'a', type: 'text', label: 'M' }] }, 'settings');
  const st = ok({ settings: [{ key: 'a', type: 'text', label: 'L' }, { key: 'b', type: 'toggle', label: 'T', default: true, per_server: true }] }).settings;
  assert.deepEqual(st[0], { key: 'a', type: 'text', label: 'L', description: null, required: false, default: null, per_server: false, max_length: 200, multiline: false, placeholder: null });
  assert.equal(st[1].default, true);

  const panel = { id: 'board', slot: 'channel_panel', title: 'Scrims', entry: 'ui/board.html' };
  bad({ ui: { panels: [panel] } }, 'ui.panels');
  const p = (x, field) => bad({ permissions: ['ui'], ui: { panels: [{ ...panel, ...x }] } }, field);
  p({ id: 'Board' }, 'ui.panels.0.id'); p({ slot: 'header' }, 'ui.panels.0.slot'); p({ title: 'x'.repeat(41) }, 'ui.panels.0.title');
  p({ entry: 'index.js' }, 'ui.panels.0.entry'); p({ entry: 'ui/none.html' }, 'ui.panels.0.entry'); p({ height: 801 }, 'ui.panels.0.height');
  p({ icon: 'ab' }, 'ui.panels.0.icon'); p({ extra: 1 }, 'ui.panels.0.extra');
  assert.deepEqual(ok({ permissions: ['ui'], ui: { panels: [{ ...panel, icon: '🎮' }] } }).ui.panels[0], { ...panel, icon: '🎮', height: 360 });
});

test('manifest: the three example modules are valid', () => {
  const root = new URL('../../examples/modules/', import.meta.url);
  let n = 0;
  for (const name of readdirSync(root)) {
    let raw;
    try { raw = readFileSync(new URL(`${name}/cillhub-module.json`, root), 'utf8'); } catch { continue; }
    const dir = new URL(`${name}/`, root);
    const all = new Map(readdirSync(dir, { recursive: true }).map(p => [p, (() => { try { return readFileSync(new URL(p, dir)); } catch { return Buffer.alloc(0); } })()]));
    assert.equal(validateManifest(JSON.parse(raw), all).id, name);
    n++;
  }
  assert.ok(n >= 3);
});

const code = (fn, expected) => {
  try { fn(); } catch (e) { assert.equal(Object.values(e.body.errors)[0]._errors[0].code, expected, Object.values(e.body.errors)[0]._errors[0].message); return; }
  assert.fail('accepted');
};

test('archives: zip and tgz unpack, the single top-level folder is stripped, .git is ignored', () => {
  const content = { 'cillhub-module.json': '{}', 'index.js': 'x', 'ui/a.html': '<p>' };
  for (const f of [unpack(tgz(content)), unpack(zip(content)), unpack(zip(Object.entries(content), {})), unpack(tgz([['./', '', '5'], ...Object.entries(content).map(([k, v]) => [`./${k}`, v])]))]) {
    assert.deepEqual([...f.keys()].sort(), ['cillhub-module.json', 'index.js', 'ui/a.html']);
  }
  const nested = unpack(tgz({ 'mod-1.0/cillhub-module.json': '{}', 'mod-1.0/index.js': 'x', 'mod-1.0/.git/config': 'x' }));
  assert.deepEqual([...nested.keys()].sort(), ['cillhub-module.json', 'index.js']);
  assert.equal(unpack(zip({ 'm/cillhub-module.json': '{}', 'm/a.js': 'y' }, {})).get('a.js').toString(), 'y');
  // two top-level folders: nothing is stripped (and the manifest check refuses it later)
  assert.ok(unpack(tgz({ 'a/cillhub-module.json': '{}', 'b/x.js': '' })).has('a/cillhub-module.json'));
});

test('archives: zip slip, absolute paths, links, devices and bad encodings are refused', () => {
  for (const p of ['../evil.js', 'a/../../evil.js', '/etc/passwd', 'a//b.js', 'a\\b.js', 'sp ace.js', 'x'.repeat(201)]) {
    if (p.length <= 100) code(() => unpack(tgz({ [p]: 'x' })), 'MODULE_PACKAGE_INVALID'); // the test tar writer has 100-byte names
    code(() => unpack(zip({ [p]: 'x' })), 'MODULE_PACKAGE_INVALID');
  }
  code(() => unpack(tgz([['link.js', '', '2', '/etc/passwd']])), 'MODULE_PACKAGE_INVALID'); // symlink
  code(() => unpack(tgz([['hard.js', '', '1', 'index.js']])), 'MODULE_PACKAGE_INVALID'); // hard link
  code(() => unpack(tgz([['dev', '', '3']])), 'MODULE_PACKAGE_INVALID'); // character device
  code(() => unpack(tgz([['fifo', '', '6']])), 'MODULE_PACKAGE_INVALID');
  code(() => unpack(zip([['link.js', '/etc/passwd', { mode: 0o120777 }]])), 'MODULE_PACKAGE_INVALID');
  code(() => unpack(tgz({ 'index.js': Buffer.from([0xff, 0xfe, 0x00]) })), 'MODULE_PACKAGE_INVALID'); // not UTF-8
  assert.ok(unpack(tgz({ 'icon.png': Buffer.from([0xff, 0xfe]) })).has('icon.png'), 'binary files are fine');
  code(() => unpack(Buffer.from('not an archive at all')), 'MODULE_PACKAGE_INVALID');
  code(() => unpack(zip({ 'a.js': 'x' }).subarray(0, 40)), 'MODULE_PACKAGE_INVALID');
});

test('archives: file count, file size, total size and bombs', () => {
  code(() => unpack(tgz(Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`f${i}.txt`, 'x'])))), 'MODULE_PACKAGE_TOO_LARGE');
  const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
  code(() => unpack(tgz({ 'big.txt': big })), 'MODULE_PACKAGE_TOO_LARGE');
  code(() => unpack(zip({ 'big.txt': big })), 'MODULE_PACKAGE_TOO_LARGE');
  // 5 files of 4.5 MiB: each fits, together they pass 20 MiB
  const chunk = Buffer.alloc(4.5 * 1024 * 1024, 0x61);
  code(() => unpack(tgz(Object.fromEntries([1, 2, 3, 4, 5].map(i => [`p${i}.txt`, chunk])))), 'MODULE_PACKAGE_TOO_LARGE');
  // a zip bomb that lies about its size: inflating stops at the declared size
  code(() => unpack(zip([['bomb.txt', Buffer.alloc(50 * 1024 * 1024), { declared: 1000 }]])), 'MODULE_PACKAGE_INVALID');
  // a gzip bomb (1 GiB of zeros is about 1 MiB compressed): gunzip stops at the limit
  const t0 = Date.now();
  code(() => unpack(tgz({ 'zeros.txt': Buffer.alloc(200 * 1024 * 1024) })), 'MODULE_PACKAGE_TOO_LARGE');
  assert.ok(Date.now() - t0 < 5000);
  code(() => unpack(Buffer.alloc(5 * 1024 * 1024 + 1)), 'MODULE_PACKAGE_TOO_LARGE');
});

test('git: URL rules without the test hatch', async () => {
  const refused = async (url, ref) => {
    await assert.rejects(checkGitUrl(url, ref), e => Object.values(e.body.errors)[0]._errors[0].code === 'MODULE_GIT_REFUSED');
  };
  for (const url of ['file:///etc', 'ssh://git@example.com/x.git', 'git://example.com/x.git', 'ftp://example.com/x', 'https://user:pw@example.com/x.git',
    'https://127.0.0.1/x.git', 'https://169.254.169.254/x.git', 'https://[::1]/x.git', 'https://localhost/x.git', 'https://10.0.0.1/x.git',
    'https://1.1.1.1/x.git', `http://127.0.0.1:${server.port + 1}/x.git`, 'https://example.com/' + 'x'.repeat(300), 'not a url']) await refused(url);
  for (const ref of ['../main', '-upload-pack=x', 'a b', '']) await refused(`http://127.0.0.1:${server.port}/mod.git`, ref);
});

test('git: a shallow clone through the hatch, pinned and without hooks; commit recorded, .git dropped', async () => {
  const { files: f, commit } = await fetchGit(`http://127.0.0.1:${server.port}/mod.git`, 'main');
  assert.equal(commit, repo.first);
  assert.deepEqual([...f.keys()].sort(), ['cillhub-module.json', 'index.js', 'lib/a.js']);
  assert.ok(server.requests.some(r => r.includes('git-upload-pack')), 'smart HTTP (shallow needs it)');
  const second = repo.commit({ 'index.js': '// v2\n' });
  const again = await fetchGit(`http://127.0.0.1:${server.port}/mod.git`);
  assert.deepEqual([again.commit, again.files.get('index.js').toString()], [second, '// v2\n']);
  await assert.rejects(fetchGit(`http://127.0.0.1:${server.port}/missing.git`), e => Object.values(e.body.errors)[0]._errors[0].code === 'MODULE_GIT_FAILED');
  await assert.rejects(fetchGit(`http://127.0.0.1:${server.port}/mod.git`, 'no-such-branch'), e => Object.values(e.body.errors)[0]._errors[0].code === 'MODULE_GIT_FAILED');
  // a symbolic link in the tree is refused even though core.symlinks=false checks it out as a file
  const linked = gitRepo(gitRoot, 'linked', { 'cillhub-module.json': '{}', 'index.js': '' });
  const { execFileSync } = await import('node:child_process');
  const work = join(gitRoot, 'linked-work');
  execFileSync('ln', ['-s', '/etc/passwd', join(work, 'passwd.js')]);
  linked.commit({});
  await assert.rejects(fetchGit(`http://127.0.0.1:${server.port}/linked.git`), e => Object.values(e.body.errors)[0]._errors[0].code === 'MODULE_PACKAGE_INVALID');
});
