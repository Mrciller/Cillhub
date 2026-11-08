// Local settings window (tray -> "Settings…"): Activity Privacy, Keybinds, Screen Sharing, About with release notes.
// Sandboxed like the screen-share picker; it talks to us only through settings-preload.js.
const path = require('path');
const { app, BrowserWindow, ipcMain } = require('electron');
const settings = require('./settings');
const games = require('./games');
const hotkeys = require('./hotkeys');
const updater = require('./updater');

let win = null;
let onShareChanged = () => {};
let gpuActive = true; // what this run started with (the switches only change with a restart)
let hwEncodeActive = false;

const state = (error = null) => {
  const s = settings.get();
  return {
    version: app.getVersion(),
    shareActivity: s.shareActivity,
    gpuScreenShare: s.gpuScreenShare !== false,
    gpuActive,
    detected: games.current()?.name || null,
    customGames: s.customGames,
    hotkeys: hotkeys.current(),
    defaults: hotkeys.DEFAULTS,
    hotkeyFailures: hotkeys.failures(),
    error,
    updateStatus: updater.status(),
    gpuInfo: {
      hwEncode: hwEncodeActive,
      platform: process.platform,
      videoEncode: app.getGPUFeatureStatus?.()?.video_encode || 'unknown',
      av1Supported: process.platform === 'win32' && hwEncodeActive,
      h264Supported: hwEncodeActive || process.platform === 'win32',
    },
    audioDspInfo: {
      engines: ['RNNoise (WASM)', 'SpeexDSP (AEC/AGC)', 'Hysteresis NoiseGate', 'High-Pass Biquad (80 Hz)'],
      sampleRate: 48000,
      channels: 2,
      hifiSupported: true,
    },
  };
};

// Everything from the window is validated here; the renderer is not trusted.
function apply(patch) {
  if (!patch || typeof patch !== 'object') return state('Invalid settings');
  if (typeof patch.shareActivity === 'boolean' && patch.shareActivity !== settings.get().shareActivity) {
    settings.set({ shareActivity: patch.shareActivity });
    onShareChanged();
  }
  if (typeof patch.gpuScreenShare === 'boolean') settings.set({ gpuScreenShare: patch.gpuScreenShare });
  if (patch.customGames !== undefined) {
    if (!Array.isArray(patch.customGames) || patch.customGames.length > 50) return state('Too many games (50 at most).');
    const list = patch.customGames.map(games.cleanCustomGame);
    if (list.includes(null)) return state('Enter an executable file name such as game.exe, without a folder.');
    settings.set({ customGames: list });
  }
  if (patch.hotkeys !== undefined) {
    const r = hotkeys.validateHotkeys(patch.hotkeys);
    if (r.error) return state(r.error);
    settings.set({ hotkeys: r.hotkeys });
    hotkeys.register(r.hotkeys);
  }
  return state();
}

function setup(opts) {
  onShareChanged = opts.onShareChanged;
  gpuActive = opts.gpuScreenShare;
  hwEncodeActive = !!opts.hwEncode;
  const own = (e) => !!win && e.sender === win.webContents;
  ipcMain.handle('settings:get', (e) => (own(e) ? state() : null));
  ipcMain.handle('settings:set', (e, patch) => (own(e) ? apply(patch) : null));
  ipcMain.on('settings:recording', (e, on) => { if (own(e)) hotkeys.suspend(!!on); });
  ipcMain.handle('settings:check-update', (e) => { if (own(e)) return updater.check(); });
  ipcMain.handle('settings:install-update', (e) => { if (own(e)) return updater.install(); });
}

function open(section) {
  if (win) { win.show(); win.focus(); return win; }
  win = new BrowserWindow({
    width: 580, height: 720, minWidth: 440, minHeight: 460, title: 'Cillhub Settings', backgroundColor: '#141a26',
    icon: path.join(__dirname, 'assets', 'icon.png'), autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, 'settings-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenu(null);
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.once('ready-to-show', () => win.show());
  win.on('closed', () => { win = null; hotkeys.suspend(false); }); // closed mid-recording: re-arm hotkeys
  win.loadFile(path.join(__dirname, 'settings.html'), section ? { hash: section } : {});
  return win;
}

const refresh = () => win?.webContents.send('settings:state', state());

module.exports = { setup, open, refresh };
