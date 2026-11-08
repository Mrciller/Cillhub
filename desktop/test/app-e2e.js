// End-to-end check of the packaged app against a throwaway hub (not part of `npm test`; needs xvfb-run):
//   node test/app-e2e.js                       # runs `electron .` (web/ must be built: npm run build:web)
//   APP_BIN=dist/linux-unpacked/cillhub node test/app-e2e.js   # the packaged app
// Starts the server from ../server on port 3350 with a temp DATA_DIR, plays a 1.1 install (login on the old hub origin),
// then checks: the app runs from app://cillhub, the login was migrated, a message round-trip, the screen-share picker,
// link handling, bounds saved after a resize burst; a second start must not migrate again. SHOTS=<dir> keeps screenshots.
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const PORT = 3350;
const HUB = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-app-e2e-'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let server;
let node;
let failed = 0;
const check = (ok, what, detail) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${ok || detail === undefined ? '' : ` (${JSON.stringify(detail)})`}`); if (!ok) failed++; };

async function api(method, p, token, body) {
  const go = () => fetch(`${HUB}/api/v9${p}`, { method, headers: { ...(token && { Authorization: token }), ...(body && { 'Content-Type': 'application/json' }) }, body: body && JSON.stringify(body) });
  const r = await go().catch(go); // a kept-alive socket the server closed while the app ran
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const register = (name) => api('POST', '/auth/register', null, { email: `${name}@example.com`, username: name, password: 'correct horse battery' }).then((r) => r.token);

async function runApp(env, name) {
  const result = path.join(tmp, `${name}.json`);
  const [bin, ...args] = process.env.APP_BIN ? [path.resolve(root, process.env.APP_BIN)] : [path.join(root, 'node_modules', '.bin', 'electron'), '.'];
  const home = path.join(tmp, 'home');
  fs.mkdirSync(home, { recursive: true });
  // async: the stand-in node below lives in this process and must keep answering while the app runs
  const child = spawn('xvfb-run', ['-a', '-s', '-screen 0 1600x1000x24', bin, ...args, '--no-sandbox'], {
    cwd: root, stdio: ['ignore', 'ignore', 'inherit'], detached: true,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), CILLCORD_TEST_HOOK: '1', CILLCORD_URL: HUB, CILLCORD_TEST_RESULT: result, CILLCORD_TEST_EXIT: '1', ...env },
  });
  const timer = setTimeout(() => { try { process.kill(-child.pid); } catch { /* gone */ } }, 240_000); // our own process group only
  await new Promise((r) => child.on('exit', r));
  clearTimeout(timer);
  return JSON.parse(fs.readFileSync(result, 'utf8'));
}

async function main() {
  const data = path.join(tmp, 'data');
  fs.mkdirSync(data);
  server = spawn(process.execPath, ['src/index.js'], { cwd: path.join(root, '..', 'server'), env: { ...process.env, PORT: String(PORT), DATA_DIR: data, CILLCORD_VERSION: '99.0.0' }, stdio: ['ignore', 'ignore', fs.openSync(path.join(tmp, 'server.log'), 'w')] });
  server.on('exit', (code, sig) => console.log(`server exited ${code ?? sig}: ${fs.readFileSync(path.join(tmp, 'server.log'), 'utf8').slice(-2000)}`));
  for (let i = 0; i < 60 && !(await fetch(`${HUB}/api/v9/instance`).then((r) => r.ok, () => false)); i++) await wait(250);
  const sfx = Math.random().toString(36).slice(2, 7);
  const alice = await register(`alice_${sfx}`);
  const bob = await register(`bob_${sfx}`);
  const guild = await api('POST', '/guilds', alice, { name: `App test ${sfx}` });
  const channel = (await api('GET', `/guilds/${guild.id}/channels`, alice)).find((c) => c.type === 0);
  const invite = await api('POST', `/channels/${channel.id}/invites`, alice, { max_age: 0 });
  await api('POST', `/invites/${invite.code}`, bob);

  // stand-in linked node: its hub-login answers at once with a token for the hub's callback page
  node = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const back = u.searchParams.get('return_to');
    res.writeHead(302, { Location: `${back}#${new URLSearchParams({ token: 'node-token', state: u.searchParams.get('state'), node_id: '1' })}` }).end();
  }).listen(PORT + 1, '127.0.0.1');

  const seed = { token: alice, zoom: '110', 'watch-audio': '{"volume":42,"muted":false,"duck":true,"duckTo":30}', 'voice-settings': '{"inputVolume":80}' };
  const shots = process.env.SHOTS;
  const r = await runApp({ CILLCORD_TEST_SEED: JSON.stringify(seed), CILLCORD_TEST_CHANNEL: `${guild.id}/${channel.id}`, CILLCORD_TEST_TOKEN2: bob, CILLCORD_TEST_SCREENSHARE: '1', CILLCORD_TEST_NODE: `http://127.0.0.1:${PORT + 1}`, ...(shots && { CILLCORD_SHOT_DIR: shots }) }, 'first');
  const api_ = JSON.parse(r.desktopApi);
  check(r.url.startsWith('app://cillhub/'), 'starts from app://cillhub', r.url);
  check(api_.bundled === true && api_.node === 'undefined/undefined' && api_.frozen && ['installUpdate', 'checkForUpdates', 'hwEncode'].every((k) => api_.keys.includes(k)), 'bridge: bundled, frozen, update calls, hwEncode, no Node', api_);
  check(Object.values(r.migrated).every(Boolean) && r.settings.loginMigrated, 'login and local settings migrated from the old origin', r.migrated);
  check(r.loggedIn, 'logged in against the throwaway hub (gateway ready)');
  check(r.cspBlocksEval, 'CSP blocks eval');
  check(r.banner === 'Update', 'hub on a newer server line: update banner offers the app update', r.banner);
  check(r.messages?.composer && r.messages.sentShown, 'message sent from the composer shows up', r.messages);
  check(r.messages?.inboundPosted === 201 && r.messages.inboundShown, 'message from another user arrives through the gateway', r.messages);
  const stored = await api('GET', `/channels/${channel.id}/messages?limit=10`, bob);
  check(stored.some((m) => m.content === r.messages?.sent), 'the app message is stored on the hub');
  check(r.screenshare?.listed > 0 && /live/.test(r.screenshare.result), 'screen-share picker opens and a source is shared', r.screenshare);
  check(r.openedExternally.includes('https://example.com/ext') && r.navBlocked && !r.openedExternally.some((u) => u.startsWith('file:')), 'external links go to the browser, navigation away is blocked', r.openedExternally);
  check(r.hubLinkInApp && r.downloadExternal, 'hub invite link opens in the app, the download page in the browser', [r.hubLinkInApp, r.downloadExternal]);
  check(r.bounds.saved && r.bounds.syncSettingsWrites === 0, 'bounds saved after a resize burst, no synchronous settings writes', r.bounds);
  check(r.signin?.popupPages.at(-1) === 'app://cillhub/instances/callback' && r.signin.handedOver && r.signin.popupClosed, 'node sign-in popup: callback from the bundle, answer handed over, popup closed', r.signin);
  check(r.cspViolations.length === 0, 'no CSP violations in the console', r.cspViolations);
  if (r.games) { // CILLCORD_TEST_GAMES=1 in the environment
    check(r.games.started?.name === 'Counter-Strike 2' && r.games.stoppedAfterMs !== null && r.games.sharingOffEvents === 0, 'game activity (fake cs2)', r.games);
    check(r.hotkeys.received.join() === 'toggle-mute,toggle-deafen' && r.settingsWindow.labelled && r.settingsWindow.version === require('../package.json').version, 'hotkeys and settings window', [r.hotkeys, r.settingsWindow]);
  }
  check(r.windowCount === 1, 'no stray windows', r.windowCount);

  // second start: still logged in, no second migration (a key added to the old origin now must not be copied)
  const r2 = await runApp({ CILLCORD_TEST_SEED: JSON.stringify({ probe: 'late' }), CILLCORD_TEST_SETTLE_MS: '2000' }, 'second');
  check(r2.loggedIn && r2.migrated.probe === false, 'second start: logged in, migration ran only once', [r2.loggedIn, r2.migrated]);
}

main().catch((e) => { console.error(e); failed++; }).finally(() => {
  if (server) server.kill(); // our own child only
  node?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `${failed} check(s) failed` : 'all checks passed');
  process.exit(failed ? 1 : 0);
});
