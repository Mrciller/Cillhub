// One sandbox child process per enabled module (CONTRACT-v8 §8): start, stop, restart with backoff, the event queue
// (one event at a time, 10 s each), request/response events (UI and HTTP), the watchdog and the memory check.
// Frames from the child are newline-delimited JSON of at most 1 MiB; anything else kills it and counts as a failure.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DATA_DIR } from '../db.js';
import { inProcessBots, refreshPresence } from '../gateway.js';
import { getModule, moduleLog, refusalLog, addLog, ModuleError } from './store.js';
import { execute } from './capabilities.js';

export const FILES = join(DATA_DIR, 'modules');
const MAX_FRAME = 1024 * 1024;
const QUEUE_MAX = 500;
const EVENT_DEADLINE = 10_000;
const WATCHDOG = 5000;
const RSS_MAX = 256 * 1024 * 1024;
const FAILURES = 5;
const FAILURE_WINDOW = 10 * 60 * 1000;
// tests shorten the restart backoff (default 1 s doubling to 60 s)
const BACKOFF = Number(process.env.CILLCORD_MODULE_BACKOFF_MS) || 1000;

// the child may read this folder and the three QuickJS packages, nothing else
const RUNNER = fileURLToPath(new URL('./sandbox/runner.mjs', import.meta.url));
const pkg = name => {
  const file = fileURLToPath(import.meta.resolve(name));
  return file.slice(0, file.lastIndexOf('/node_modules/') + '/node_modules/'.length + name.length);
};
const CORE = import.meta.resolve('quickjs-emscripten-core');
const VARIANT = import.meta.resolve('@jitl/quickjs-ng-wasmfile-release-sync');
export const SANDBOX_ARGS = [
  '--permission', `--allow-fs-read=${dirname(RUNNER)}`,
  ...['quickjs-emscripten-core', '@jitl/quickjs-ng-wasmfile-release-sync', '@jitl/quickjs-ffi-types'].map(n => `--allow-fs-read=${pkg(n)}`),
  '--max-old-space-size=64', RUNNER, CORE, VARIANT,
];

// set by registry.js: status changes (panels, presence, commands), the READY payload, and the auto-disable
export const hooks = { changed: () => {}, readyPayload: () => ({}), crashed: () => {} };

const rts = new Map(); // module id -> runtime
const statsOf = new Map(); // module id -> stats (kept across restarts and disable/enable)
export const stats = id => statsOf.get(id) ?? { started_at: null, events: 0, errors: 0, crashes: 0, restarts: 0, last_error: null, last_error_at: null };
const statsFor = id => { if (!statsOf.has(id)) statsOf.set(id, stats(id)); return statsOf.get(id); };
export const statusOf = id => rts.get(id)?.status ?? null;
export const isRunning = id => rts.get(id)?.status === 'running';
export const runningIds = () => [...rts.values()].filter(r => r.status === 'running').map(r => r.id);
const system = (id, msg) => addLog(id, 'system', msg);

// the module's .js files, for the load frame (the child never reads the data folder)
function codeOf(id) {
  const dir = join(FILES, id);
  const files = {};
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile() || !/\.m?js$/.test(e.name)) continue;
    const full = join(e.parentPath, e.name);
    files[full.slice(dir.length + 1)] = readFileSync(full, 'utf8');
  }
  return files;
}

const send = (rt, frame) => { if (rt.proc && !rt.dead) rt.proc.stdin.write(`${JSON.stringify(frame)}\n`); };

function spawnChild(rt) {
  const mod = getModule(rt.id);
  if (!mod) return;
  rt.dead = false;
  rt.status = 'starting';
  rt.buf = '';
  rt.busy = null;
  rt.lastPong = Date.now();
  const proc = spawn(process.execPath, SANDBOX_ARGS, { env: {}, stdio: ['pipe', 'pipe', 'pipe'] });
  rt.proc = proc;
  proc.stdin.on('error', () => {}); // a dead child: its exit is handled below
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', chunk => onData(rt, proc, chunk));
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', chunk => { for (const line of chunk.split('\n')) if (line.trim()) refusalLog(rt.id, `sandbox stderr: ${line.slice(0, 1000)}`); });
  proc.on('exit', (code, signal) => { if (rt.proc === proc && !rt.dead) failure(rt, `the sandbox exited (${signal ?? `code ${code}`})`); });
  proc.on('error', e => { if (rt.proc === proc && !rt.dead) failure(rt, `the sandbox could not start (${e.code})`); });
  rt.watch = setInterval(() => watchdog(rt, proc), WATCHDOG);
  try {
    send(rt, { t: 'load', main: mod.manifest.main, files: codeOf(rt.id) });
  } catch (e) {
    failure(rt, `the package files could not be read (${e.code ?? e.message})`);
  }
}

function watchdog(rt, proc) {
  if (rt.proc !== proc || rt.dead) return;
  if (Date.now() - rt.lastPong > 2 * WATCHDOG) return failure(rt, 'watchdog: no answer for 10 s');
  send(rt, { t: 'ping' });
  try {
    // Linux only: resident pages in the second field (4 KiB pages assumed)
    const pages = Number(readFileSync(`/proc/${proc.pid}/statm`, 'utf8').split(' ')[1]);
    if (pages * 4096 > RSS_MAX) failure(rt, 'memory: the sandbox used more than 256 MiB');
  } catch { /* no /proc here */ }
}

function onData(rt, proc, chunk) {
  if (rt.proc !== proc || rt.dead) return;
  rt.buf += chunk;
  let i;
  while ((i = rt.buf.indexOf('\n')) >= 0) {
    const line = rt.buf.slice(0, i);
    rt.buf = rt.buf.slice(i + 1);
    if (line.length > MAX_FRAME) return failure(rt, 'a frame larger than 1 MiB');
    let f;
    try { f = JSON.parse(line); } catch { return failure(rt, 'an invalid frame'); }
    onFrame(rt, f);
    if (rt.dead) return;
  }
  if (rt.buf.length > MAX_FRAME) failure(rt, 'a frame larger than 1 MiB');
}

function onFrame(rt, f) {
  switch (f?.t) {
    case 'ready':
      rt.status = 'running';
      statsFor(rt.id).started_at = new Date().toISOString();
      system(rt.id, 'Started.');
      rt.queue.unshift({ name: 'READY', payload: hooks.readyPayload(rt.id) });
      inProcessBots.add(rt.appId);
      refreshPresence(rt.appId);
      hooks.changed(rt.id);
      return pump(rt);
    case 'pong': rt.lastPong = Date.now(); return;
    case 'log':
      if (['debug', 'info', 'warn', 'error'].includes(f.level) && typeof f.message === 'string') moduleLog(rt.id, f.level, f.message);
      return;
    case 'call': return onCall(rt, f);
    case 'done': return onDone(rt, f);
    case 'fatal': return failure(rt, typeof f.reason === 'string' ? f.reason.slice(0, 500) : 'fatal error');
    default: return failure(rt, 'an unknown frame');
  }
}

async function onCall(rt, f) {
  const proc = rt.proc;
  if (!Number.isInteger(f.id) || typeof f.action !== 'string') return failure(rt, 'an invalid call frame');
  const mod = getModule(rt.id);
  let reply;
  try {
    reply = { t: 'reply', id: f.id, ok: true, json: JSON.stringify(await execute(mod, f.action, f.args)) };
  } catch (e) {
    const err = e instanceof ModuleError ? e : new ModuleError('UNAVAILABLE', 'The server could not carry out this call.');
    reply = { t: 'reply', id: f.id, ok: false, json: JSON.stringify({ code: err.code, message: err.message, ...err.extra }) };
  }
  if (rt.proc === proc) send(rt, reply);
}

// --- the event queue ---------------------------------------------------------------------------------------------
function pump(rt) {
  if (rt.busy || rt.status !== 'running' || rt.dead) return;
  let ev;
  do ev = rt.queue.shift(); while (ev?.settled);
  if (!ev) return;
  ev.eid = rt.nextEid++;
  rt.busy = ev;
  statsFor(rt.id).events++;
  send(rt, { t: 'event', eid: ev.eid, name: ev.name, json: JSON.stringify(ev.payload) });
  ev.deadline = setTimeout(() => {
    if (rt.busy !== ev) return;
    rt.busy = null;
    system(rt.id, `The ${ev.name} handler did not finish within 10 s; the next event goes on.`);
    settle(ev, { ok: false, error: { code: 'TIMEOUT', message: 'The handler did not finish within 10 s.' } });
    pump(rt);
  }, EVENT_DEADLINE);
}

function onDone(rt, f) {
  const ev = rt.busy;
  if (!ev || ev.eid !== f.eid) return;
  clearTimeout(ev.deadline);
  rt.busy = null;
  if (!f.ok) {
    const s = statsFor(rt.id);
    const msg = String(f.error?.message ?? 'Error').slice(0, 1000);
    Object.assign(s, { errors: s.errors + 1, last_error: msg, last_error_at: new Date().toISOString() });
    moduleLog(rt.id, 'error', `The ${ev.name} handler failed: ${msg}`);
  }
  settle(ev, f);
  pump(rt);
}

function settle(ev, result) {
  if (ev.settled) return;
  ev.settled = true;
  clearTimeout(ev.timer);
  ev.resolve?.(result);
}

function enqueue(id, ev) {
  const rt = rts.get(id);
  if (!rt) return settle(ev, { ok: false, error: { code: 'UNAVAILABLE', message: 'The module is not running.' } });
  rt.queue.push(ev);
  if (rt.queue.length > QUEUE_MAX) {
    const dropped = rt.queue.shift();
    settle(dropped, { ok: false, error: { code: 'UNAVAILABLE', message: 'The event queue is full.' } });
    refusalLog(id, `The event queue is full (500): dropped a ${dropped.name} event.`);
  }
  pump(rt);
}

// fire and forget
export const emit = (id, name, payload) => enqueue(id, { name, payload });

// an event whose handler result is the answer: {ok, result} or {ok: false, error}; {timeout: true} after timeoutMs
export function request(id, name, payload, timeoutMs) {
  return new Promise(resolve => {
    const ev = { name, payload, resolve };
    ev.timer = setTimeout(() => settle(ev, { ok: false, timeout: true, error: { code: 'TIMEOUT', message: 'No answer in time.' } }), timeoutMs);
    enqueue(id, ev);
  });
}

// --- lifecycle ---------------------------------------------------------------------------------------------------
function kill(rt) {
  rt.dead = true;
  clearInterval(rt.watch);
  clearTimeout(rt.restartTimer);
  if (rt.busy) { clearTimeout(rt.busy.deadline); settle(rt.busy, { ok: false, error: { code: 'UNAVAILABLE', message: 'The sandbox stopped.' } }); rt.busy = null; }
  rt.proc?.kill('SIGKILL');
  if (inProcessBots.delete(rt.appId)) refreshPresence(rt.appId);
}

function failure(rt, reason) {
  if (rt.dead) return;
  kill(rt);
  const now = Date.now();
  const s = statsFor(rt.id);
  s.crashes++;
  rt.failures = rt.failures.filter(t => now - t < FAILURE_WINDOW);
  rt.failures.push(now);
  system(rt.id, `Sandbox failure: ${reason}.`);
  if (rt.failures.length >= FAILURES) {
    stop(rt.id);
    system(rt.id, `Disabled after ${FAILURES} failures within 10 minutes.`);
    return hooks.crashed(rt.id, `${FAILURES} failures within 10 minutes; the last: ${reason}`);
  }
  const wait = Math.min(60_000, BACKOFF * 2 ** (rt.failures.length - 1));
  rt.status = 'restarting';
  system(rt.id, `Restarting in ${Math.round(wait / 100) / 10} s.`);
  rt.restartTimer = setTimeout(() => { if (rts.get(rt.id) === rt) { s.restarts++; spawnChild(rt); } }, wait);
  hooks.changed(rt.id);
}

export function start(mod) {
  if (rts.has(mod.id)) return;
  const rt = { id: mod.id, appId: mod.app_id, queue: [], nextEid: 1, failures: [], status: 'starting' };
  rts.set(mod.id, rt);
  spawnChild(rt);
  hooks.changed(mod.id);
}

export function stop(id, why = null) {
  const rt = rts.get(id);
  if (!rt) return;
  kill(rt);
  rts.delete(id);
  for (const ev of rt.queue) settle(ev, { ok: false, error: { code: 'UNAVAILABLE', message: 'The module stopped.' } });
  if (why) system(id, why);
  hooks.changed(id);
}

// a fresh sandbox with the current code; the crash counter starts over
export function restart(mod) {
  const queue = rts.get(mod.id)?.queue.filter(ev => !ev.settled) ?? [];
  stop(mod.id);
  start(mod);
  rts.get(mod.id).queue.push(...queue);
}

export const forget = id => statsOf.delete(id);
export const stopAll = () => { for (const id of [...rts.keys()]) { const rt = rts.get(id); rt.dead = true; rt.proc?.kill('SIGKILL'); } };
