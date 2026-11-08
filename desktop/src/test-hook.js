// Test-only automation, loaded only when CILLCORD_TEST_HOOK=1. Never active in normal use.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app, shell, BrowserWindow, net } = require('electron');
const log = require('electron-log/main');
const { APP_ORIGIN, HUB_URL } = require('./config');
const hotkeys = require('./hotkeys');
const settings = require('./settings');
const settingsWindow = require('./settings-window');

const opened = [];
shell.openExternal = async (url) => { opened.push(url); log.info('[test] openExternal', url); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// CILLCORD_TEST_SEED (JSON of localStorage keys) plays a 1.1 install: written to the old hub origin before the migration runs.
async function seedOldOrigin(ses) {
  const { withOldOrigin } = require('./migrate');
  const seed = JSON.parse(process.env.CILLCORD_TEST_SEED);
  await withOldOrigin(ses, (w) => w.webContents.executeJavaScript(`((s) => { for (const [k, v] of Object.entries(s)) localStorage.setItem(k, v); })(${JSON.stringify(seed)})`));
  ses.flushStorageData();
  log.info('[test] seeded the old origin with', Object.keys(seed).join(', '));
}

const until = async (fn, ms, step = 250) => {
  for (const end = Date.now() + ms; Date.now() < end; await wait(step)) { const v = await fn(); if (v) return v; }
  return null;
};

async function run(win) {
  const wc = win.webContents;
  const cspViolations = [];
  wc.on('console-message', (e, _level, text) => {
    const m = String(e.message ?? text);
    if (/Content Security Policy/i.test(m) && !/unsafe-eval/.test(m)) cspViolations.push(m.slice(0, 300)); // the eval probe below is on purpose
  });
  await new Promise((r) => wc.once('did-finish-load', r));
  await wait(Number(process.env.CILLCORD_TEST_SETTLE_MS || 4000));
  const results = { url: wc.getURL(), title: await wc.executeJavaScript('document.title') };
  results.bodyText = (await wc.executeJavaScript('document.body.innerText')).slice(0, 300);
  results.desktopApi = await wc.executeJavaScript('JSON.stringify({keys:Object.keys(window.cillcordDesktop),frozen:Object.isFrozen(window.cillcordDesktop),platform:window.cillcordDesktop.platform,version:window.cillcordDesktop.version,bundled:window.cillcordDesktop.bundled,hwEncode:window.cillcordDesktop.hwEncode,node:typeof require+"/"+typeof process})');
  results.cspBlocksEval = await wc.executeJavaScript(`(() => { try { (0, eval)('1'); return false } catch (e) { return e instanceof EvalError } })()`);
  results.settings = { loginMigrated: settings.get().loginMigrated === true };
  if (process.env.CILLCORD_TEST_SEED) {
    const seed = JSON.parse(process.env.CILLCORD_TEST_SEED);
    // compare in the page, so the token itself never reaches the results file or the log
    results.migrated = await readPage(wc, `Object.fromEntries(${JSON.stringify(Object.keys(seed))}.map((k) => [k, localStorage.getItem(k) === ${JSON.stringify(seed)}[k]]))`);
  }
  results.loggedIn = !!(await until(() => wc.executeJavaScript(`document.querySelector('.app')?.dataset.gateway === 'ready'`), 20000));
  // the hub runs a newer server line than the bundle was built for: the banner offers the app update
  results.banner = await until(() => wc.executeJavaScript(`document.querySelector('.update-banner:not([hidden]) .update-reload')?.textContent || ''`), 8000);
  if (process.env.CILLCORD_TEST_CHANNEL) results.messages = await testMessages(wc);

  const shotDir = process.env.CILLCORD_SHOT_DIR;
  if (shotDir) {
    fs.mkdirSync(shotDir, { recursive: true });
    fs.writeFileSync(path.join(shotDir, 'app-login.png'), (await wc.capturePage()).toPNG());
  }

  // external link via window.open -> must go to (stubbed) default browser, no new window
  await wc.executeJavaScript(`(() => { const a = document.createElement('a'); a.href = 'https://example.com/ext'; a.target = '_blank'; document.body.append(a); a.click(); })()`, true);
  await wait(500);
  // top-level navigation to another origin -> must be blocked (and handed to browser)
  await wc.executeJavaScript(`location.href = 'https://example.org/nav'`, true);
  await wait(2000);
  // non-http scheme -> blocked and NOT opened externally
  await wc.executeJavaScript(`window.open('file:///etc/passwd')`, true);
  await wait(500);

  results.openedExternally = opened;
  results.urlAfterNav = wc.getURL();
  results.navBlocked = wc.getURL().startsWith(`${APP_ORIGIN}/`);
  // a client page on the hub (invite link) opens in the app; the download page opens in the browser
  await wc.executeJavaScript(`window.open(${JSON.stringify(`${HUB_URL}/invite/test-hub-link`)}, '_blank')`, true);
  await wait(1500);
  results.hubLinkInApp = wc.getURL() === `${APP_ORIGIN}/invite/test-hub-link`;
  await wc.executeJavaScript(`window.open(${JSON.stringify(`${HUB_URL}/download/`)}, '_blank')`, true);
  await wait(500);
  results.downloadExternal = opened.includes(`${HUB_URL}/download/`);
  results.bounds = await testBounds(win);
  if (process.env.CILLCORD_TEST_NODE) results.signin = await testSignin(wc);
  results.windowCount = BrowserWindow.getAllWindows().length;
  if (process.env.CILLCORD_TEST_SCREENSHARE === '1') results.screenshare = await testScreenshare(wc, shotDir);
  results.releaseNotesOpen = BrowserWindow.getAllWindows().some((w) => w.webContents.getURL().endsWith('settings.html#about'));
  if (process.env.CILLCORD_TEST_GAMES === '1') {
    results.hotkeys = await testHotkeys(wc);
    results.settingsWindow = await testSettings(shotDir);
    results.games = await testGames(wc);
  }
  results.cspViolations = cspViolations;
  log.info('[test] results', JSON.stringify(results));
  if (process.env.CILLCORD_TEST_RESULT) fs.writeFileSync(process.env.CILLCORD_TEST_RESULT, JSON.stringify(results, null, 2));
  if (process.env.CILLCORD_TEST_EXIT === '1') app.exit(0);
}

// Opens getDisplayMedia from the page, screenshots our picker, picks the first source, reports the track.
async function testScreenshare(wc, shotDir) {
  const pending = wc.executeJavaScript(`navigator.mediaDevices.getDisplayMedia({ video: true })
    .then((s) => s.getVideoTracks()[0].label + ' ' + s.getVideoTracks()[0].readyState).catch((e) => 'error: ' + e.name)`, true);
  let picker;
  for (let i = 0; i < 40 && !(picker = BrowserWindow.getAllWindows().find((w) => w.webContents !== wc && w.isVisible())); i++) await wait(500);
  if (!picker) return { picker: false, result: await Promise.race([pending, wait(5000).then(() => 'pending')]) };
  if (shotDir) fs.writeFileSync(path.join(shotDir, 'screenshare-picker.png'), (await picker.webContents.capturePage()).toPNG());
  const listed = await picker.webContents.executeJavaScript(`document.querySelectorAll('.src').length`);
  await picker.webContents.executeJavaScript(`document.querySelector('.src').click(); document.getElementById('share').click()`);
  return { listed, result: await pending };
}

const readPage = async (wc, expr) => JSON.parse(await wc.executeJavaScript(`JSON.stringify(${expr})`));

// Fake game: a copy of /bin/sleep named cs2. The page must get { name: 'Counter-Strike 2', start } and later null.
async function testGames(wc) {
  await wc.executeJavaScript('window.__activity = []; window.cillcordDesktop.onGameActivity((a) => window.__activity.push({ a, t: Date.now() })); true');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cillcord-game-'));
  const exe = path.join(dir, 'cs2');
  fs.copyFileSync('/bin/sleep', exe);
  fs.chmodSync(exe, 0o755);
  const waitFor = async (pred, ms) => {
    for (const end = Date.now() + ms; Date.now() < end; await wait(250)) {
      const hit = (await readPage(wc, 'window.__activity')).find(pred);
      if (hit) return hit;
    }
    return null;
  };
  const r = {};
  let t = Date.now();
  let child = spawn(exe, ['600'], { stdio: 'ignore' });
  const started = await waitFor((e) => e.a?.name === 'Counter-Strike 2', 25000);
  r.started = started?.a || null;
  r.startedAfterMs = started && started.t - t;
  child.kill();
  t = Date.now();
  const stopped = await waitFor((e) => e.a === null && e.t >= t, 25000);
  r.stoppedAfterMs = stopped && stopped.t - t;
  r.events = (await readPage(wc, 'window.__activity')).map((e) => e.a);
  // Sharing off: the game is still detected locally, but nothing reaches the page.
  settings.set({ shareActivity: false });
  child = spawn(exe, ['600'], { stdio: 'ignore' });
  await wait(18000);
  r.sharingOffDetectedLocally = require('./games').current()?.name || null;
  r.sharingOffEvents = (await readPage(wc, 'window.__activity')).length - r.events.length;
  child.kill();
  settings.set({ shareActivity: true });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

async function testHotkeys(wc) {
  await wc.executeJavaScript('window.__hotkeys = []; window.cillcordDesktop.onHotkey((a) => window.__hotkeys.push(a)); true');
  hotkeys.fire('toggle-mute');
  hotkeys.fire('toggle-deafen');
  await wait(500);
  return { registered: hotkeys.current(), failures: hotkeys.failures(), received: await readPage(wc, 'window.__hotkeys') };
}

async function testSettings(shotDir) {
  const w = settingsWindow.open();
  await new Promise((r) => (w.webContents.isLoading() ? w.webContents.once('did-finish-load', r) : r()));
  await wait(800);
  const r = await readPage(w.webContents, `{ version: document.getElementById('version').textContent,
    detected: document.getElementById('detected').textContent,
    keys: [...document.querySelectorAll('[data-action]')].map((b) => b.textContent),
    labelled: [...document.querySelectorAll('input')].every((i) => i.labels.length > 0) }`);
  r.rejectsBadHotkey = (await w.webContents.executeJavaScript(`window.desktopSettings.set({ hotkeys: { 'toggle-mute': 'M' } })`)).error;
  if (shotDir) {
    fs.writeFileSync(path.join(shotDir, `settings-about-${app.getVersion()}.png`), (await w.webContents.capturePage()).toPNG());
    await w.webContents.executeJavaScript('window.scrollTo(0, 0)');
    await wait(200);
    fs.writeFileSync(path.join(shotDir, `settings-${app.getVersion()}.png`), (await w.webContents.capturePage()).toPNG());
  }
  return r;
}

// Sends a message through the composer (real key events) and waits for the server's echo; then a message from a second
// user (posted to the hub by the main process) must show up through the gateway.
async function testMessages(wc) {
  const [guild, channel] = process.env.CILLCORD_TEST_CHANNEL.split('/');
  await wc.loadURL(`${APP_ORIGIN}/channels/${guild}/${channel}`);
  const box = await until(() => wc.executeJavaScript(`(() => { const t = document.querySelector('textarea[aria-label^="Message"]'); if (!t) return false; t.focus(); return true })()`), 20000);
  const out = `hello from the app ${Date.now()}`;
  wc.insertText(out);
  await wait(200);
  wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' });
  wc.sendInputEvent({ type: 'char', keyCode: '\r' });
  wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' });
  const shown = (text) => until(() => wc.executeJavaScript(`[...document.querySelectorAll('.content')].some((e) => e.textContent.includes(${JSON.stringify(text)}))`), 15000);
  const r = { composer: !!box, sentShown: !!(await shown(out)), sent: out };
  if (process.env.CILLCORD_TEST_TOKEN2) {
    const inbound = `hello to the app ${Date.now()}`;
    const res = await net.fetch(`${HUB_URL}/api/v9/channels/${channel}/messages`, { method: 'POST', headers: { Authorization: process.env.CILLCORD_TEST_TOKEN2, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: inbound }) });
    r.inboundPosted = res.status;
    r.inboundShown = !!(await shown(inbound));
  }
  return r;
}

// Node sign-in popup: a stand-in node redirects to the hub's callback page, which must open from the bundle in the popup,
// hand the answer to the main window (BroadcastChannel) and close.
async function testSignin(wc) {
  await wc.executeJavaScript(`localStorage.setItem('instance-signin', JSON.stringify({ state: 'st', node: {}, then: {}, at: Date.now(), popup: true }));
    window.__signin = []; const bc = new BroadcastChannel('cillcord-instance-signin'); bc.onmessage = (e) => window.__signin.push(e.data); true`);
  const before = BrowserWindow.getAllWindows().length;
  const navs = []; // every page the popup shows
  app.once('web-contents-created', (_e, c) => c.on('did-navigate', (_n, u) => navs.push(u.split('#')[0])));
  const url = `${process.env.CILLCORD_TEST_NODE}/api/v9/federation/hub-login?return_to=${encodeURIComponent(`${HUB_URL}/instances/callback`)}&state=st`;
  // not awaited: the call returns when the popup's first navigation settles
  wc.executeJavaScript(`window.__popup = window.open(${JSON.stringify(url)}, 'cillcord-signin', 'popup,width=520,height=720'); true`, true);
  const got = await until(async () => (await readPage(wc, 'window.__signin')).length > 0, 15000);
  await wait(1000);
  const r = { popupPages: navs, handedOver: !!got && (await readPage(wc, 'window.__signin[0].fragment')).includes('token=node-token'),
    popupClosed: BrowserWindow.getAllWindows().length === before };
  await wc.executeJavaScript(`localStorage.removeItem('instance-signin'); true`);
  return r;
}

// A burst of resizes/moves must not write settings.json synchronously; the bounds land on disk ~500 ms after the last one.
async function testBounds(win) {
  const file = path.join(app.getPath('userData'), 'settings.json');
  if (win.isMaximized()) win.unmaximize();
  const writes = [];
  const origSync = fs.writeFileSync;
  fs.writeFileSync = (...a) => (writes.push(String(a[0])), origSync(...a));
  const t0 = Date.now();
  for (let i = 0; i < 60; i++) win.setBounds({ x: 40 + i, y: 50, width: 1000 + i, height: 700 });
  const burstMs = Date.now() - t0;
  fs.writeFileSync = origSync;
  const want = win.getBounds();
  const onDisk = await until(() => { try { const b = JSON.parse(fs.readFileSync(file, 'utf8')).bounds; return b && b.width === want.width && b.x === want.x ? b : null; } catch { return null; } }, 5000, 100);
  return { burstMs, syncSettingsWrites: writes.filter((f) => f.includes('settings.json')).length, saved: !!onDisk, want, onDisk };
}

module.exports = { run, seedOldOrigin };
