const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createStore } = require('../src/settings');

const tmpFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-settings-')), 'settings.json');
const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('settings: a burst of sets is written once, after the debounce, atomically', async (t) => {
  const file = tmpFile();
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const s = createStore(file, 50);
  const writes = [];
  const orig = fs.promises.writeFile;
  fs.promises.writeFile = (...a) => (writes.push(a[0]), orig(...a));
  t.after(() => { fs.promises.writeFile = orig; });
  for (let i = 0; i < 100; i++) s.set({ bounds: { x: i, y: 0, width: 1000, height: 700 } });
  assert.equal(s.get().bounds.x, 99, 'get() sees the change at once');
  assert.equal(fs.existsSync(file), false, 'nothing written synchronously');
  await wait(20);
  assert.equal(writes.length, 0, 'still debouncing');
  await wait(80);
  await s.idle();
  assert.equal(writes.length, 1);
  assert.ok(writes[0].endsWith('.tmp'), 'written to a temp file and renamed');
  assert.equal(read(file).bounds.x, 99);
  assert.equal(fs.existsSync(`${file}.tmp`), false);
});

test('settings: no overlapping writes; a change during a write is written right after', async (t) => {
  const file = tmpFile();
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const s = createStore(file, 1);
  let active = 0;
  let maxActive = 0;
  const orig = fs.promises.writeFile;
  fs.promises.writeFile = async (...a) => { active++; maxActive = Math.max(maxActive, active); await wait(30); try { return await orig(...a); } finally { active--; } };
  t.after(() => { fs.promises.writeFile = orig; });
  s.set({ maximized: true });
  await wait(10); // first write is running
  s.set({ maximized: false, closeToTray: false });
  await wait(10);
  await s.idle();
  await wait(5);
  await s.idle();
  assert.equal(maxActive, 1);
  assert.deepEqual([read(file).maximized, read(file).closeToTray], [false, false]);
});

test('settings: flushSync writes pending changes at once and cancels the timer', async (t) => {
  const file = tmpFile();
  t.after(() => fs.rmSync(path.dirname(file), { recursive: true, force: true }));
  const s = createStore(file, 10_000);
  s.flushSync();
  assert.equal(fs.existsSync(file), false, 'nothing pending: nothing written');
  s.set({ bounds: { x: 5, y: 6, width: 900, height: 600 }, maximized: true });
  s.flushSync();
  assert.deepEqual(read(file).bounds, { x: 5, y: 6, width: 900, height: 600 });
  const again = createStore(file);
  assert.equal(again.get().maximized, true, 'a new store (next start) reads it back');
  assert.equal(again.get().gpuScreenShare, true, 'defaults fill missing keys');
});

test('nothing in the shell turns off hardware acceleration', () => {
  for (const f of fs.readdirSync(path.join(__dirname, '..', 'src')).filter((n) => n.endsWith('.js'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), /disableHardwareAcceleration\s*\(/, f);
  }
});
