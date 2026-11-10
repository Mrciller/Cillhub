// The sandbox child process (CONTRACT-v8 §8.1). Started by host.js with `node --permission`, read access only to this
// folder and the QuickJS packages, an empty environment and no other grants. The module's code runs inside QuickJS
// (WebAssembly) and reaches nothing but `send`, which turns its calls, logs and results into frames on stdout.
// Frames are newline-delimited JSON; the host checks every one of them.
import { readFileSync } from 'node:fs';

const MAX_FRAME = 1024 * 1024 - 1;
const [coreUrl, variantUrl] = process.argv.slice(2);
const { newQuickJSWASMModuleFromVariant, newVariant } = await import(coreUrl);
// QuickJS cannot measure its allocations in this build (no malloc_usable_size), so its own heap limit would never trip:
// the WebAssembly memory itself is capped (80 MiB: the 64 MiB heap plus stack and runtime), and malloc fails past it
const QuickJS = await newQuickJSWASMModuleFromVariant(newVariant((await import(variantUrl)).default, {
  wasmMemory: new WebAssembly.Memory({ initial: 256, maximum: 1280 }),
}));
const PRELUDE = readFileSync(new URL('./prelude.js', import.meta.url), 'utf8');

const write = line => process.stdout.write(`${line}\n`);
function die(reason) {
  write(JSON.stringify({ t: 'fatal', reason: String(reason).slice(0, 500) }));
  process.exit(1);
}
process.on('uncaughtException', e => die(`runner error: ${e?.message ?? e}`));

let rt, vm, dispatch, files = {}, deadline = 0, interrupted = false, oom = false, mainPromise = null, ready = false;
const isOom = text => /out of memory/i.test(text);
const errText = h => {
  const e = vm.dump(h);
  return typeof e === 'object' && e ? `${e.name ?? 'Error'}: ${e.message ?? ''}` : String(e);
};

// the module's own .js files by relative path; node built-ins, bare names and URLs do not exist here
let refused = '';
let logWindow = 0, logCount = 0; // log frames this second: the host keeps 100 per 10 s, so more is wasted pipe traffic
function normalize(base, requested) {
  refused = `Cannot import '${requested.slice(0, 100)}': modules may only import their own .js files by relative path`;
  if (!/^\.\.?\//.test(requested)) return { error: new Error(refused) };
  const parts = base.split('/').slice(0, -1);
  for (const seg of requested.split('/')) {
    if (seg === '..') { if (!parts.length) return { error: new Error(`Cannot import '${requested}'`) }; parts.pop(); } else if (seg && seg !== '.') parts.push(seg);
  }
  const path = parts.join('/');
  return Object.hasOwn(files, path) ? path : { error: new Error(refused) };
}

function drain() {
  while (rt.hasPendingJob() && !interrupted && !oom) {
    const r = rt.executePendingJobs();
    if (r.error) {
      if (isOom(errText(r.error))) oom = true;
      r.error.dispose();
    }
  }
}

// one VM entry with a CPU budget: the frame, then every job it queued
function slice(ms, fn) {
  deadline = Date.now() + ms;
  try {
    fn();
    drain();
  } finally {
    deadline = 0;
  }
  if (interrupted) die(`cpu: the module ran longer than ${ms} ms without yielding`);
  if (oom) die('oom: the module ran out of memory');
  if (!ready && mainPromise) {
    const s = vm.getPromiseState(mainPromise);
    if (s.type === 'fulfilled' || s.type === 'rejected') {
      const msg = s.type === 'rejected' ? errText(s.error) : null;
      if (!s.notAPromise) (s.value ?? s.error)?.dispose();
      mainPromise.dispose();
      mainPromise = null;
      if (msg) die(isOom(msg) ? 'oom: the module ran out of memory' : `load failed: ${msg}`);
      ready = true;
      write('{"t":"ready"}');
    }
  }
}

function call(fn, ...args) {
  const handles = args.map(a => (typeof a === 'number' ? vm.newNumber(a) : vm.newString(a)));
  const r = vm.callFunction(fn, vm.undefined, ...handles);
  handles.forEach(h => h.dispose());
  if (r.error) { if (isOom(errText(r.error))) oom = true; r.error.dispose(); } else r.value.dispose();
}

function load({ files: f, main }) {
  files = f;
  rt = QuickJS.newRuntime();
  rt.setMemoryLimit(64 * 1024 * 1024);
  rt.setMaxStackSize(256 * 1024);
  rt.setInterruptHandler(() => {
    if (deadline && Date.now() > deadline) { interrupted = true; return true; }
    return false;
  });
  rt.setModuleLoader(name => (Object.hasOwn(files, name) ? files[name] : { error: new Error(refused) }), normalize);
  vm = rt.newContext();
  const str = h => (h && vm.typeof(h) === 'string' ? vm.getString(h) : '');
  const send = vm.newFunction('send', (tH, idH, aH, bH) => {
    const t = str(tH), a = str(aH), b = str(bH);
    const id = idH && vm.typeof(idH) === 'number' ? vm.getNumber(idH) | 0 : 0;
    let line;
    if (t === 'call') line = `{"t":"call","id":${id},"action":${JSON.stringify(a)},"args":${b}}`;
    else if (t === 'done') line = `{"t":"done","eid":${id},"ok":${a === 'ok'},"${a === 'ok' ? 'result' : 'error'}":${b}}`;
    else if (t === 'log') {
      if (Date.now() - logWindow > 1000) { logWindow = Date.now(); logCount = 0; }
      if (++logCount > 200) return vm.false;
      line = JSON.stringify({ t: 'log', level: a, message: b.slice(0, 2000) });
    } else return vm.false;
    if (Buffer.byteLength(line) > MAX_FRAME) return vm.false;
    if (t === 'done' && a !== 'ok' && isOom(b)) oom = true;
    write(line);
    return vm.true;
  });
  const prelude = vm.unwrapResult(vm.evalCode(PRELUDE, 'cillhub:prelude'));
  dispatch = vm.unwrapResult(vm.callFunction(prelude, vm.undefined, send));
  prelude.dispose();
  send.dispose();
  slice(1000, () => {
    const r = vm.evalCode(files[main], main, { type: 'module' });
    if (r.error) {
      const msg = errText(r.error);
      r.error.dispose();
      if (!interrupted) die(isOom(msg) ? 'oom: the module ran out of memory' : `load failed: ${msg}`);
      return;
    }
    // evaluation gives the module's exports, or a promise for them (top-level await); ready once it settles
    mainPromise = r.value;
  });
}

function onFrame(f) {
  switch (f.t) {
    case 'load': return load(f);
    case 'event': return slice(200, () => call(dispatch, 'event', f.eid, f.name, f.json));
    case 'reply': return slice(200, () => call(dispatch, 'reply', f.id, f.ok ? 'ok' : 'err', f.json));
    case 'ping': return write('{"t":"pong"}');
    default: return die(`unknown frame ${f.t}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line) onFrame(JSON.parse(line));
  }
});
process.stdin.on('end', () => process.exit(0));
