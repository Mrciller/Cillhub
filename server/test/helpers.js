import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

export const tempDir = () => mkdtemp(join(tmpdir(), 'cillcord-test-'));

// starts src/index.js on an ephemeral port; env adds to (and LIVEKIT_* is never inherited from) the test's env
export async function startServer({ env = {}, dataDir } = {}) {
  dataDir ??= await tempDir();
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LIVEKIT_')));
  // a test network key (federation tests) is pinned by a loader hook, and only in a NODE_ENV=test run
  const hook = env.NODE_ENV === 'test' && env.CILLCORD_TEST_HUB_KEY ? ['--import', './test/hub-key.mjs'] : [];
  const proc = spawn(process.execPath, [...hook, 'src/index.js'], {
    cwd: new URL('..', import.meta.url),
    env: { ...clean, PORT: '0', DATA_DIR: dataDir, CILLCORD_RATE_LIMIT_SCALE: '100', ...env },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    proc.stdout.on('data', chunk => {
      out += chunk;
      const m = out.match(/listening on \S+:(\d+)/);
      if (m) resolve(m[1]);
    });
    proc.on('exit', code => reject(new Error(`server exited with ${code}`)));
  });
  const origin = `http://127.0.0.1:${port}`;
  const base = `${origin}/api/v9`;
  const sockets = [];

  async function api(method, path, token, body, headers = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(token && { Authorization: token }), ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  }

  // multipart request: payload as payload_json (or plain fields when it is a Map), files are [field, name, bytes, type]
  async function form(method, path, token, payload, files = []) {
    const f = new FormData();
    if (payload instanceof Map) payload.forEach((v, k) => f.set(k, v));
    else if (payload !== undefined) f.set('payload_json', JSON.stringify(payload));
    files.forEach(([field, name, bytes, type]) => f.set(field, new Blob([bytes], { type }), name));
    const res = await fetch(base + path, { method, headers: token ? { Authorization: token } : {}, body: f });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  }

  // multipart message: files are [name, bytes, type]
  async function upload(channelId, token, payload, files) {
    const form = new FormData();
    form.set('payload_json', JSON.stringify(payload));
    files.forEach(([name, bytes, type], i) => form.set(`files[${i}]`, new Blob([bytes], { type }), name));
    const res = await fetch(`${base}/channels/${channelId}/messages`, { method: 'POST', headers: { Authorization: token }, body: form });
    return { status: res.status, body: await res.json() };
  }

  // opens a raw gateway socket; wait(pred) resolves with (and consumes) the first matching frame
  function socket() {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/gateway`);
    sockets.push(ws);
    const frames = [];
    let waiters = [];
    const closed = new Promise(resolve => ws.addEventListener('close', e => resolve(e.code)));
    ws.addEventListener('message', e => {
      frames.push(JSON.parse(e.data));
      waiters.forEach(w => w());
    });
    const wait = (pred, ms = 3000) => new Promise((resolve, reject) => {
      const check = () => {
        const i = frames.findIndex(pred);
        if (i < 0) return false;
        waiters = waiters.filter(w => w !== check);
        clearTimeout(timer);
        resolve(frames.splice(i, 1)[0]);
        return true;
      };
      const timer = setTimeout(() => {
        waiters = waiters.filter(w => w !== check);
        reject(new Error('timed out waiting for gateway frame'));
      }, ms);
      if (!check()) waiters.push(check);
    });
    // resolves true if no matching frame arrives within ms
    const none = (pred, ms = 300) => wait(pred, ms).then(() => false, () => true);
    const send = obj => ws.send(JSON.stringify(obj));
    return { ws, wait, none, send, closed, frames, event: (t, pred = () => true) => wait(f => f.t === t && pred(f.d)).then(f => f.d) };
  }

  async function gateway(token) {
    const gw = socket();
    const hello = await gw.wait(f => f.op === 10);
    assert.equal(hello.d.heartbeat_interval, 41250);
    gw.send({ op: 2, d: { token, properties: { os: 'linux', browser: 'test', device: 'test' } } });
    gw.ready = await gw.event('READY');
    return gw;
  }

  async function register(name) {
    const r = await api('POST', '/auth/register', null, { email: `${name}@example.com`, username: name, password: 'hunter2hunter2' });
    assert.equal(r.status, 201);
    const me = await api('GET', '/users/@me', r.body.token);
    return { token: r.body.token, id: me.body.id, name };
  }

  async function stop(keepData = false) {
    sockets.forEach(ws => ws.close());
    const exited = new Promise(resolve => proc.once('exit', resolve));
    proc.kill();
    await exited;
    if (!keepData) await rm(dataDir, { recursive: true, force: true });
  }

  return { origin, base, dataDir, api, form, upload, socket, gateway, register, stop };
}

// owner = first name; everyone else joins through one invite. Returns users by name plus the guild's channels.
export async function guildWith(srv, names) {
  const users = {};
  for (const n of names) users[n] = await srv.register(n);
  const owner = users[names[0]];
  const guild = (await srv.api('POST', '/guilds', owner.token, { name: 'Test Guild' })).body;
  const general = guild.channels.find(c => c.name === 'general');
  const voice = guild.channels.find(c => c.type === 2);
  const textCategory = guild.channels.find(c => c.name === 'Text Channels');
  const invite = (await srv.api('POST', `/channels/${general.id}/invites`, owner.token, { max_age: 0 })).body;
  for (const n of names.slice(1)) assert.equal((await srv.api('POST', `/invites/${invite.code}`, users[n].token)).status, 200);
  return { users, guild, general, voice, textCategory, invite };
}

// a decimal permission string with these bits
export const bits = (...ns) => String(ns.reduce((a, n) => a | (1n << BigInt(n)), 0n));

// polls until fn() returns something truthy
export async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 25));
  }
}

// a 1x1 PNG (or w x h, header only: enough for sniffing and size reading)
export function png(w = 1, h = 1) {
  const b = Buffer.alloc(33);
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(b);
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}
