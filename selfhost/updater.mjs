// cillcord-updater: the sidecar that updates a self-hosted Cillhub node when the app asks it to.
// Runs in the app image (`node /install/updater.mjs`) with /install = the install dir and the Docker socket.
// Interface (HTTP on the compose network only, Authorization: Bearer $CILLCORD_UPDATER_SECRET):
//   GET  /status    -> state (see README.md)
//   GET  /check     -> {current_version, latest: {version, notes, size, min_upgrade_from, security}, update_available, can_update}
//   POST /update    {version?, auto?} -> 202 state; 409 busy / up to date / version mismatch / (auto) a version that failed
//                   or was rolled back before; 422 min_upgrade_from
//   POST /rollback  -> 202 state; 409 busy or nothing to roll back to
// An update: verify the signed latest.json, download + sha256 + size, docker load, back up (tar of the
// files, app stopped, VACUUM INTO), start the new image, health-check; on failure restore the snapshot
// and start the previous container again.
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

process.umask(0o077); // backups hold the database and the node's keys: owner only
const env = process.env;
const ROOT = env.CILLCORD_INSTALL_DIR || '/install';
const SECRET = env.CILLCORD_UPDATER_SECRET || '';
const HUB = (env.CILLCORD_HUB_URL || '').replace(/\/+$/, '');
const REPO = env.CILLCORD_IMAGE;
const PROJECT = env.COMPOSE_PROJECT_NAME;
const PORT = Number(env.CILLCORD_UPDATER_PORT || 8787);
const HEALTH_MS = Number(env.CILLCORD_UPDATER_HEALTH_TIMEOUT || 90) * 1000;
const SOCKET = '/var/run/docker.sock';
const DB = path.join(ROOT, 'data', 'cillcord.sqlite');
const STATE_FILE = path.join(ROOT, 'updater-state.json');
const VERSION_RE = /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/;

const MAIN = process.argv[1] === fileURLToPath(import.meta.url); // imported by selfhost/test/updater-feed.test.mjs otherwise
if (MAIN && (SECRET.length < 32 || !REPO || !PROJECT || !HUB)) {
  console.error('updater: CILLCORD_UPDATER_SECRET (32+ chars), CILLCORD_IMAGE, COMPOSE_PROJECT_NAME and CILLCORD_HUB_URL are required');
  process.exit(1);
}
// the pinned release keys: one or more PEM public keys; a feed names the one it is signed with by key_id (sha256 of the DER key)
const KEYS_FILE = path.join(ROOT, 'release-public-key.pem');

// ---- state (persisted so the dashboard still sees the last result after a restart)
let state = { state: 'idle' };
try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch {}
function save(patch) {
  state = { ...state, ...patch };
  fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
}
const step = (s) => { console.log(`updater: ${s}`); save({ step: s }); };
let locked = false; // single-flight: taken before /update's first await, so two requests can't both pass busy()
const busy = () => locked || state.state === 'updating' || state.state === 'rolling_back';
if (busy()) save({ state: 'failed', step: null, error: 'the updater restarted during the operation; check `docker compose ps`' });

// ---- Docker Engine API over the unix socket
function docker(method, p, body, raw = false) {
  return new Promise((resolve, reject) => {
    const stream = body && typeof body.pipe === 'function';
    const headers = stream ? { 'Content-Type': 'application/x-tar' } : body ? { 'Content-Type': 'application/json' } : {};
    const req = http.request({ socketPath: SOCKET, method, path: p, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode >= 400) return reject(new Error(`docker ${method} ${p.split('?')[0]}: ${res.statusCode} ${buf.toString().slice(0, 300)}`));
        if (raw) return resolve(buf);
        try { resolve(JSON.parse(buf)); } catch { resolve(buf.toString()); }
      });
    });
    req.on('error', reject);
    if (stream) body.pipe(req); else req.end(body ? JSON.stringify(body) : undefined);
  });
}
const enc = encodeURIComponent;
const tag = (image, t) => docker('POST', `/images/${enc(image)}/tag?repo=${enc(REPO)}&tag=${enc(t)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function appContainer() {
  const filters = enc(JSON.stringify({ label: [`com.docker.compose.project=${PROJECT}`, 'com.docker.compose.service=app'] }));
  const list = (await docker('GET', `/containers/json?all=1&filters=${filters}`)).filter((c) => !c.Names.some((n) => n.endsWith('-replaced')));
  if (list.length !== 1) throw new Error(`expected one app container, found ${list.length}`);
  return docker('GET', `/containers/${list[0].Id}/json`);
}
const versionOf = (image) => (image.Config?.Env || []).find((e) => e.startsWith('CILLCORD_VERSION='))?.slice(17) || null;
async function currentVersion() {
  const c = await appContainer();
  return versionOf(await docker('GET', `/images/${enc(c.Image)}/json`));
}

// shortcut: numeric dot compare; a pre-release sorts after its release. Use real semver if pre-releases ship.
export function cmp(a, b) {
  const x = String(a).split(/[.-]/), y = String(b).split(/[.-]/);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? '', q = y[i] ?? '';
    if (p === q) continue;
    if (/^\d+$/.test(p) && /^\d+$/.test(q)) return Math.sign(Number(p) - Number(q));
    return p < q ? -1 : 1;
  }
  return 0;
}

// ---- release from the hub, trusted only after the signature check
async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}
const fingerprint = (k) => crypto.createHash('sha256').update(k.export({ type: 'spki', format: 'der' })).digest('hex');
export const parseKeys = (pem) => new Map((String(pem).match(/-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----/g) ?? [])
  .map((p) => crypto.createPublicKey(p)).filter((k) => k.asymmetricKeyType === 'ed25519').map((k) => [fingerprint(k), k]));
// latest.json is trusted only when signed by a pinned key (key_id), not expired (expires, Unix seconds) and not below the
// highest min_version this node has seen (floor), so an old signed feed cannot be replayed to freeze or roll back nodes
export function verifyFeed(body, sig, keys, floor, now = Date.now()) {
  let j;
  try { j = JSON.parse(body); } catch { throw new Error('latest.json: malformed'); }
  const key = typeof j?.key_id === 'string' && keys.get(j.key_id);
  if (!key) throw new Error(`latest.json: signed by a key this node does not trust (${String(j?.key_id).slice(0, 16)})`);
  if (!crypto.verify(null, body, key, sig)) throw new Error('latest.json: signature does not verify');
  if (!VERSION_RE.test(j.version) || !/^[0-9a-f]{64}$/.test(j.sha256) || !Number.isSafeInteger(j.size)
    || typeof j.url !== 'string' || !(j.url.startsWith('https://') || j.url.startsWith(`${HUB}/download/server/`)) || (j.min_upgrade_from && !VERSION_RE.test(j.min_upgrade_from))
    || (j.security !== undefined && typeof j.security !== 'boolean') || !Number.isSafeInteger(j.expires)
    || (j.min_version && !VERSION_RE.test(j.min_version)) || (j.keys !== undefined && !(Array.isArray(j.keys) && j.keys.every((k) => parseKeys(k).size === 1)))) throw new Error('latest.json: malformed');
  // a new key list must keep the key that signed this feed, so no feed can lock its own signer (the owner's key) out for good
  if (j.keys && !j.keys.some((k) => parseKeys(k).has(j.key_id))) throw new Error('latest.json: the key list drops the key that signed it');
  if (j.expires * 1000 <= now) throw new Error(`latest.json: expired on ${new Date(j.expires * 1000).toISOString()}; the hub has to re-sign it`);
  const min = [floor, j.min_version].filter(Boolean).sort(cmp).pop();
  if (min && cmp(j.version, min) < 0) throw new Error(`latest.json: offers ${j.version}, below the minimum version ${min}`);
  return j;
}
async function latest() {
  const base = `${HUB}/download/server/latest.json`;
  const [body, sig] = await Promise.all([get(base), get(`${base}.sig`)]);
  const j = verifyFeed(body, sig, parseKeys(fs.readFileSync(KEYS_FILE, 'utf8')), state.min_version);
  if (j.min_version && (!state.min_version || cmp(j.min_version, state.min_version) > 0)) save({ min_version: j.min_version });
  // key rotation: a newer feed brings the key list from then on (adds the next key, drops a retired one); an older one never does
  if (j.keys?.length && (!state.keys_from || cmp(j.version, state.keys_from) > 0)) {
    fs.rmSync(KEYS_FILE + '.tmp', { force: true });
    fs.writeFileSync(KEYS_FILE + '.tmp', j.keys.map((k) => crypto.createPublicKey(k).export({ type: 'spki', format: 'pem' })).join(''), { flag: 'wx', mode: 0o644 });
    fs.renameSync(KEYS_FILE + '.tmp', KEYS_FILE); // rename replaces a planted symlink instead of following it
    save({ keys_from: j.version });
  }
  return j;
}
async function download(j) {
  fs.mkdirSync(path.join(ROOT, 'releases'), { recursive: true });
  const file = path.join(ROOT, 'releases', `cillhub-server-${j.version}.tar.gz`);
  const r = await fetch(j.url, { signal: AbortSignal.timeout(30 * 60e3) });
  if (!r.ok) throw new Error(`download: HTTP ${r.status}`);
  const hash = crypto.createHash('sha256');
  let size = 0;
  const count = new Transform({ transform(c, _e, cb) {
    hash.update(c); size += c.length;
    cb(size > j.size ? new Error('download is larger than announced') : null, c);
  } });
  await pipeline(Readable.fromWeb(r.body), count, fs.createWriteStream(file + '.part'));
  if (size !== j.size || hash.digest('hex') !== j.sha256) { fs.rmSync(file + '.part'); throw new Error('download: checksum or size mismatch'); }
  fs.renameSync(file + '.part', file);
  return file;
}
async function load(file) {
  const out = await docker('POST', '/images/load?quiet=1', fs.createReadStream(file));
  const text = typeof out === 'string' ? out : JSON.stringify(out);
  const m = /Loaded image: ([^\s"\\]+)/.exec(text);
  if (!m) throw new Error(`docker load: ${text.slice(0, 300)}`);
  return m[1];
}

// ---- swapping the app container
// data/ belongs to the app: never write through a link it may have planted (rm and rename act on the link itself)
function restoreDb(snapshot) {
  fs.rmSync(DB + '.restore', { force: true });
  fs.copyFileSync(snapshot, DB + '.restore', fs.constants.COPYFILE_EXCL);
  const { uid, gid } = fs.statSync(path.dirname(DB));
  fs.chownSync(DB + '.restore', uid, gid); // the app runs as the owner of data/, not as root
  for (const f of [DB + '-wal', DB + '-shm']) fs.rmSync(f, { force: true });
  fs.renameSync(DB + '.restore', DB);
}
const isLink = (f) => fs.lstatSync(f, { throwIfNoEntry: false })?.isSymbolicLink();
// The new container is the old one's config with the new image; values that came from the old image are dropped.
function spec(old, oldImage, newImageId) {
  const img = oldImage.Config || {};
  const cfg = { ...old.Config, Image: `${REPO}:current` };
  cfg.Env = (cfg.Env || []).filter((e) => !(img.Env || []).includes(e));
  cfg.Labels = Object.fromEntries(Object.entries(cfg.Labels || {}).filter(([k, v]) => img.Labels?.[k] !== v));
  if (cfg.Labels['com.docker.compose.image']) cfg.Labels['com.docker.compose.image'] = newImageId;
  for (const k of ['Cmd', 'Entrypoint', 'WorkingDir', 'User', 'Healthcheck', 'StopSignal', 'ExposedPorts', 'Volumes']) {
    if (JSON.stringify(cfg[k]) === JSON.stringify(img[k])) delete cfg[k];
  }
  delete cfg.Hostname;
  const EndpointsConfig = {};
  for (const [net, ep] of Object.entries(old.NetworkSettings.Networks || {})) {
    EndpointsConfig[net] = { Aliases: [...new Set([...(ep.Aliases || []), 'app'])], IPAMConfig: ep.IPAMConfig, Links: ep.Links, DriverOpts: ep.DriverOpts };
  }
  return { ...cfg, HostConfig: old.HostConfig, NetworkingConfig: { EndpointsConfig } };
}
async function healthy(id) {
  const until = Date.now() + HEALTH_MS;
  while (Date.now() < until) {
    const c = await docker('GET', `/containers/${id}/json`);
    if (c.State.Status === 'exited' || c.State.Restarting || c.RestartCount > 0) throw new Error(`the app exited (code ${c.State.ExitCode})`);
    const ip = Object.values(c.NetworkSettings.Networks || {})[0]?.IPAddress;
    const port = (c.Config.Env || []).find((e) => e.startsWith('PORT='))?.slice(5) || '3000';
    if (ip) {
      try {
        const r = await fetch(`http://${ip}:${port}/api/v9/gateway`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) return;
      } catch {}
    }
    await sleep(1000);
  }
  throw new Error(`health check failed: no answer within ${HEALTH_MS / 1000} s`);
}
async function logTail(id) {
  const buf = await docker('GET', `/containers/${id}/logs?stdout=1&stderr=1&tail=30`, null, true);
  const parts = [];
  for (let i = 0; i + 8 <= buf.length; i += 8 + buf.readUInt32BE(i + 4)) parts.push(buf.subarray(i + 8, i + 8 + buf.readUInt32BE(i + 4)));
  return Buffer.concat(parts).toString().slice(-4000);
}

// Backs up, switches the app to `target` (image id or ref), health-checks; reverts everything on failure.
async function swap(target, label, restoreFrom) {
  const old = await appContainer();
  const name = old.Name.replace(/^\//, '');
  const oldImage = await docker('GET', `/images/${enc(old.Image)}/json`);
  const newImage = await docker('GET', `/images/${enc(target)}/json`);
  const dir = path.join(ROOT, 'backups', `${new Date().toISOString().replace(/[:.]/g, '-')}-${label}`);
  fs.mkdirSync(dir, { recursive: true });
  step('backing up files');
  // Files while the app still runs (can take a while); the database below with the app stopped.
  execFileSync('tar', ['-czf', path.join(dir, 'data.tar.gz'), '-C', ROOT, '--exclude=data/cillcord.sqlite*', 'data']);
  step('stopping the app');
  await docker('POST', `/containers/${old.Id}/stop?t=30`);
  const snapshot = path.join(dir, 'cillcord.sqlite');
  let snapped = false, renamed = false, created = null;
  try {
    step('database snapshot');
    for (const f of [DB, `${DB}-wal`, `${DB}-shm`]) if (isLink(f)) throw new Error(`data/${path.basename(f)} is a symbolic link; refusing to open it`);
    if (fs.existsSync(DB)) {
      const db = new DatabaseSync(DB);
      try { db.exec(`VACUUM INTO '${snapshot}'`); } finally { db.close(); }
      snapped = true;
    }
    if (restoreFrom) { step('restoring the database from before the update'); restoreDb(restoreFrom); }
    step(`starting ${versionOf(newImage) || target}`);
    await tag(newImage.Id, 'current');
    await docker('POST', `/containers/${old.Id}/rename?name=${enc(name + '-replaced')}`);
    renamed = true;
    created = await docker('POST', `/containers/create?name=${enc(name)}`, spec(old, oldImage, newImage.Id));
    await docker('POST', `/containers/${created.Id}/start`);
    step('health check');
    await healthy(created.Id);
    await docker('DELETE', `/containers/${old.Id}?force=1`);
    return { backup: dir, snapshot: snapped ? snapshot : null, previous: { image: oldImage.Id, version: versionOf(oldImage) } };
  } catch (err) {
    step(`reverting: ${err.message}`);
    err.rolled_back = true;
    if (created) {
      err.logs = await logTail(created.Id).catch(() => null);
      await docker('DELETE', `/containers/${created.Id}?force=1`).catch(() => {});
    }
    if (snapped) restoreDb(snapshot);
    await tag(oldImage.Id, 'current');
    if (renamed) await docker('POST', `/containers/${old.Id}/rename?name=${enc(name)}`);
    await docker('POST', `/containers/${old.Id}/start`);
    try { await healthy(old.Id); } catch (e) {
      err.rolled_back = false;
      err.message += `; the previous version did not come back either (${e.message}), backup in ${dir}`;
    }
    throw err;
  }
}

async function run(kind, target, fn) {
  save({ state: kind === 'update' ? 'updating' : 'rolling_back', action: kind, target_version: target, step: null,
    error: null, rolled_back: null, logs: null, started_at: new Date().toISOString(), finished_at: null });
  try {
    await fn();
    save({ state: 'done', step: null, finished_at: new Date().toISOString() });
  } catch (err) {
    console.error(`updater: ${kind} failed: ${err.message}`);
    save({ state: 'failed', step: null, error: err.message, rolled_back: err.rolled_back ?? false, logs: err.logs ?? null, finished_at: new Date().toISOString(),
      ...(kind === 'update' && { skip_version: target }) }); // automatic updates leave this version alone
  }
}
async function update(j) {
  step('downloading');
  const file = await download(j);
  step('loading the image');
  const ref = await load(file);
  fs.rmSync(file);
  const image = await docker('GET', `/images/${enc(ref)}/json`);
  if (versionOf(image) !== j.version) throw new Error(`the image is version ${versionOf(image)}, expected ${j.version}`);
  const r = await swap(image.Id, `pre-${j.version}`, null);
  await tag(r.previous.image, 'previous');
  save({ previous: r.previous, rollback_snapshot: r.snapshot, backup: r.backup });
}
async function rollback() {
  const from = await currentVersion().catch(() => null);
  const r = await swap(state.previous.image, `pre-rollback-to-${state.previous.version}`, state.rollback_snapshot);
  save({ previous: null, rollback_snapshot: null, backup: r.backup, skip_version: from }); // rolled back by hand: no automatic retry
}

// ---- HTTP interface for the app
const PRIVATE = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1$|f[cd][0-9a-f]{2}:)/i;
const digest = (s) => crypto.createHash('sha256').update(s).digest();
const authorized = (req) => crypto.timingSafeEqual(digest(req.headers.authorization || ''), digest(`Bearer ${SECRET}`));

async function handle(req, res) {
  const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!PRIVATE.test(addr)) return send(403, { error: 'local network only' });
  if (!authorized(req)) return send(401, { error: 'unauthorized' });
  const url = new URL(req.url, 'http://updater');
  const route = `${req.method} ${url.pathname}`;
  const status = async () => ({ ...state, current_version: await currentVersion().catch(() => null) });

  if (route === 'GET /status') return send(200, await status());
  if (route === 'GET /check') {
    const [j, cur] = await Promise.all([latest(), currentVersion()]);
    return send(200, { current_version: cur, latest: { version: j.version, notes: j.notes, size: j.size, min_upgrade_from: j.min_upgrade_from, security: j.security === true },
      update_available: cmp(j.version, cur) > 0, can_update: !j.min_upgrade_from || cmp(cur, j.min_upgrade_from) >= 0 });
  }
  if (route === 'POST /update') {
    if (busy()) return send(409, { error: 'busy', state: state.state });
    locked = true;
    try { // run() marks the state busy synchronously, so the lock can go once it is called
      let body = '';
      for await (const c of req) { body += c; if (body.length > 10000) return send(413, { error: 'body too large' }); }
      let want, auto;
      try { ({ version: want, auto } = body ? JSON.parse(body) : {}); } catch { return send(400, { error: 'body must be JSON' }); }
      const [j, cur] = await Promise.all([latest(), currentVersion()]);
      if (want && want !== j.version) return send(409, { error: `the hub offers ${j.version}, not ${want}` });
      if (auto === true && state.skip_version === j.version) return send(409, { error: `${j.version} failed or was rolled back before; update by hand` });
      if (cmp(j.version, cur) <= 0) return send(409, { error: `already on ${cur}, the hub offers ${j.version}` });
      if (j.min_upgrade_from && cmp(cur, j.min_upgrade_from) < 0) return send(422, { error: `update to ${j.min_upgrade_from} first` });
      run('update', j.version, () => update(j));
    } finally { locked = false; }
    return send(202, await status());
  }
  if (route === 'POST /rollback') {
    if (busy()) return send(409, { error: 'busy', state: state.state });
    if (!state.previous?.image) return send(409, { error: 'no previous version to roll back to' });
    run('rollback', state.previous.version, rollback);
    return send(202, await status());
  }
  send(404, { error: 'not found' });
}

if (MAIN) http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    console.error(`updater: ${req.method} ${req.url}: ${err.message}`);
    if (!res.headersSent) { res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); }
  });
}).listen(PORT, () => console.log(`updater: listening on :${PORT} (project ${PROJECT}, image ${REPO})`));
