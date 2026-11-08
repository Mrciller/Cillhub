// Tiny JSON settings store in userData (window, tray, activity sharing, added games, hotkeys, GPU, last run version, migration).
// Writes are debounced and asynchronous: a synchronous write on every 'resize'/'move' event blocked the Windows modal sizing
// loop (the window stuck and the mouse lagged). flushSync() writes what is pending once on close/quit.
const fs = require('fs');
const path = require('path');

const defaults = { closeToTray: true, bounds: { width: 1280, height: 800 }, maximized: false, shareActivity: true, customGames: [], hotkeys: {}, gpuScreenShare: true };

function createStore(file, delay = 500) {
  let cache;
  let timer = null;
  let writing = null; // the running async write
  let again = false; // a change arrived while writing
  const tmp = `${file}.tmp`;

  function get() {
    if (!cache) {
      try { cache = { ...defaults, ...JSON.parse(fs.readFileSync(file, 'utf8')) }; } catch { cache = { ...defaults }; }
    }
    return cache;
  }

  async function writeNow() {
    timer = null;
    if (writing) { again = true; return writing; } // never two writes at once: the running one goes round again
    writing = (async () => {
      do {
        again = false;
        // atomic: a crash mid-write leaves the old file, never half a file
        try { await fs.promises.writeFile(tmp, JSON.stringify(cache)); await fs.promises.rename(tmp, file); } catch { /* non-fatal: settings just won't persist */ }
      } while (again);
    })();
    await writing;
    writing = null;
  }

  function set(patch) {
    Object.assign(get(), patch);
    clearTimeout(timer);
    timer = setTimeout(writeNow, delay);
  }

  /** Writes pending changes synchronously (window close, quit). No-op when nothing is pending. */
  function flushSync() {
    if (!timer && !writing) return;
    clearTimeout(timer);
    timer = null;
    // shortcut: an async write still in flight at quit could land after this one; it carries the same or older data
    // only if a change raced it in the last few ms before quit. Good enough for window bounds and toggles.
    try { fs.writeFileSync(tmp, JSON.stringify(cache)); fs.renameSync(tmp, file); } catch { /* non-fatal */ }
  }

  const exists = () => fs.existsSync(file);
  const idle = () => writing ?? Promise.resolve(); // tests
  return { get, set, flushSync, exists, idle };
}

let store;
const def = () => (store ??= createStore(path.join(require('electron').app.getPath('userData'), 'settings.json')));
module.exports = {
  get: () => def().get(),
  set: (patch) => def().set(patch),
  flushSync: () => def().flushSync(),
  exists: () => def().exists(),
  createStore,
};
