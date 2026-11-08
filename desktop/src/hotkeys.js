// Global hotkeys (work while Cillhub is unfocused): toggle mute / toggle deafen, forwarded to the page.
const { globalShortcut } = require('electron');
const log = require('electron-log/main');

const DEFAULTS = Object.freeze({ 'toggle-mute': 'Ctrl+Shift+M', 'toggle-deafen': 'Ctrl+Shift+D' });
const MODIFIERS = ['Ctrl', 'Alt', 'Shift', 'Super'];
const KEY = /^([A-Z0-9]|F([1-9]|1[0-9]|2[0-4])|num[0-9]|Space|Up|Down|Left|Right|Home|End|PageUp|PageDown|Insert)$/;

// "Ctrl+Shift+M"-style accelerator: known modifiers once each, exactly one key, a modifier unless it is an F-key.
function validAccelerator(acc) {
  if (typeof acc !== 'string' || acc.length > 40) return false;
  const parts = acc.split('+');
  const key = parts.pop();
  if (!KEY.test(key) || new Set(parts).size !== parts.length || !parts.every((m) => MODIFIERS.includes(m))) return false;
  return parts.length > 0 || /^F\d/.test(key);
}

// { action: accelerator | '' (off) } -> { hotkeys } or { error }.
function validateHotkeys(input) {
  if (!input || typeof input !== 'object') return { error: 'Invalid keybinds' };
  const hotkeys = {};
  for (const action of Object.keys(DEFAULTS)) {
    const acc = input[action] ?? DEFAULTS[action];
    if (acc !== '' && !validAccelerator(acc)) return { error: `"${String(acc).slice(0, 40)}" is not a usable shortcut` };
    hotkeys[action] = acc;
  }
  const used = Object.values(hotkeys).filter(Boolean);
  if (new Set(used).size !== used.length) return { error: 'Mute and deafen need different shortcuts' };
  return { hotkeys };
}

let handler = () => {};
let current = {};
let failed = {}; // action -> accelerator that could not be registered

function register(hotkeys) {
  globalShortcut.unregisterAll();
  current = hotkeys;
  failed = {};
  for (const [action, acc] of Object.entries(hotkeys)) {
    if (!acc) continue;
    let ok = false;
    try { ok = globalShortcut.register(acc, () => handler(action)); } catch { /* invalid on this platform */ }
    if (!ok) { failed[action] = acc; log.warn(`hotkey ${acc} for ${action} could not be registered (taken by another app?)`); }
  }
}

module.exports = {
  DEFAULTS, validAccelerator, validateHotkeys, register,
  start(hotkeys, onHotkey) { handler = onHotkey; register(validateHotkeys(hotkeys).hotkeys || { ...DEFAULTS }); },
  // While the settings window records a shortcut, ours must not swallow the keys.
  suspend(on) { if (on) globalShortcut.unregisterAll(); else register(current); },
  current: () => ({ ...current }),
  failures: () => ({ ...failed }),
  fire: (action) => handler(action), // test hook only
  stop: () => globalShortcut.unregisterAll(),
};
