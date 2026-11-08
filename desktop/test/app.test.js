const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { originOf, isAppUrl, appUrlFor, HUB_URL, APP_ID, MOVED_TO, PROD_FEED, PROD_HUB } = require('../src/config');
const { resolve, serve, CSP } = require('../src/protocol');
const gpu = require('../src/gpu');

test('originOf/isAppUrl handle app:// (WHATWG gives it the origin "null")', () => {
  assert.equal(originOf('app://cillhub/channels/@me'), 'app://cillhub');
  assert.equal(originOf('https://hub.example:443/x'), 'https://hub.example');
  assert.equal(originOf('null'), null);
  assert.ok(isAppUrl('app://cillhub/'));
  for (const bad of ['app://other/', 'https://hub.example/', 'file:///etc/passwd', 'app://cillhub.evil/']) assert.equal(isAppUrl(bad), false, bad);
});

test('appUrlFor: client pages on the hub open in the app, everything else does not', () => {
  assert.equal(appUrlFor(`${HUB_URL}/invite/abc`), 'app://cillhub/invite/abc');
  assert.equal(appUrlFor(`${HUB_URL}/instances/callback#token=x&state=y`), 'app://cillhub/instances/callback#token=x&state=y');
  assert.equal(appUrlFor(`${HUB_URL}/oauth2/authorize?client_id=1`), 'app://cillhub/oauth2/authorize?client_id=1');
  assert.equal(appUrlFor(`${HUB_URL}/`), 'app://cillhub/');
  for (const no of [`${HUB_URL}/download/`, `${HUB_URL}/api/v9/gateway`, `${HUB_URL}/attachments/1/2/a.png`, 'https://node.example/invite/abc', HUB_URL.replace(/^https:/, 'http:') + '/invite/abc', 'nonsense']) {
    assert.equal(appUrlFor(no), null, no);
  }
});

test('protocol: files, SPA fallback, 404 for missing assets, no escape from the web dir', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-web-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'assets'));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><script type="module" src="/assets/index-x.js"></script>');
  fs.writeFileSync(path.join(dir, 'assets', 'index-x.js'), 'console.log(1)');
  assert.equal(resolve('/assets/index-x.js', dir), path.join(dir, 'assets', 'index-x.js'));
  assert.equal(resolve('/channels/@me/123', dir), path.join(dir, 'index.html'));
  assert.equal(resolve('/', dir), path.join(dir, 'index.html'));
  assert.equal(resolve('/assets/missing.js', dir), null);
  assert.equal(resolve('/../../etc/passwd', dir), null);
  assert.equal(resolve('/%2e%2e/%2e%2e/etc/passwd', dir), null);
  assert.equal(resolve('/%E0%A4%A', dir), null);

  const js = await serve({ url: 'app://cillhub/assets/index-x.js' }, dir);
  assert.equal(js.status, 200);
  assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8');
  const page = await serve({ url: 'app://cillhub/invite/abc' }, dir);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(page.headers.get('content-security-policy'), CSP);
  assert.equal((await serve({ url: 'app://cillhub/assets/nope.js' }, dir)).status, 404);
  assert.equal((await serve({ url: 'app://other/index.html' }, dir)).status, 404);
});

test('CSP: scripts only from the package, no eval, no plugins, no foreign framing', () => {
  const d = Object.fromEntries(CSP.split('; ').map((p) => [p.split(' ')[0], p.split(' ').slice(1)]));
  assert.deepEqual(d['script-src'], ["'self'", "'wasm-unsafe-eval'", 'https://www.youtube.com', 'https://s.ytimg.com']);
  assert.ok(!CSP.includes("'unsafe-eval'"));
  assert.deepEqual(d['object-src'], ["'none'"]);
  assert.deepEqual(d['frame-ancestors'], ["'none'"]);
  assert.ok(d['connect-src'].includes(HUB_URL) && d['connect-src'].includes(HUB_URL.replace(/^http/, 'ws')));
});

test('gpu.apply: switches only on Windows and only when wanted', () => {
  const calls = [];
  const app = { commandLine: { appendSwitch: (...a) => calls.push(a) } };
  assert.equal(gpu.apply(app, false, 'win32'), false);
  assert.equal(gpu.apply(app, true, 'linux'), false);
  assert.equal(calls.length, 0);
  assert.equal(gpu.apply(app, true, 'win32'), true);
  assert.equal(calls[0][0], 'enable-features');
  assert.deepEqual(calls[0][1].split(','), gpu.FEATURES);
  // H.264 constrained baseline and AV1 from the Media Foundation encoder (Chromium 156 feature names)
  assert.deepEqual(gpu.FEATURES, ['PlatformH264CbpEncoding', 'WebRtcAV1HWEncode']);
});

test('identity: app id matches the build config, release builds have no moved notice, feed under the hub', () => {
  const pkg = require('../package.json');
  assert.equal(APP_ID, pkg.build.appId);
  assert.equal(MOVED_TO, null);
  assert.equal(PROD_FEED, `${PROD_HUB}/download/desktop/`);
  assert.ok(!pkg.build.publish, 'the feed comes from scripts/dist.js (src/config.js), not package.json');
});

test('argon theme: desktop windows, settings page, and screen-share picker use obsidian surfaces and cyan-teal accent', () => {
  for (const f of ['main.js', 'settings-window.js', 'screenshare.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.match(src, /backgroundColor:\s*'#141a26'/, `${f} uses Argon obsidian surface`);
  }
  for (const f of ['settings.html', 'picker.html']) {
    const html = fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');
    assert.match(html, /#141a26/, `${f} uses Argon obsidian background`);
    assert.match(html, /#00d2eb/, `${f} uses Argon cyan-teal accent`);
  }
});
