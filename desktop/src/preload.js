// Runs sandboxed in the bundled client (app://cillhub). Exposes only a tiny frozen API; no Node, no raw ipcRenderer.
const { contextBridge, ipcRenderer } = require('electron');

const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').split('=')[1] || '';

// Returns an unsubscribe function.
const subscribe = (channel, cb) => {
  if (typeof cb !== 'function') return () => {};
  const listener = (_e, value) => cb(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

// Subscribes and also delivers the current value once (page reload, late mount).
const withCurrent = (channel, cb) => {
  const off = subscribe(channel, cb);
  let live = true;
  if (typeof cb === 'function') ipcRenderer.invoke(`${channel}:current`).then((v) => { if (live && v) cb(v); });
  return () => { live = false; off(); };
};

// Only the app's own pages get the bridge (a sign-in popup may visit a linked node's pages).
if (location.protocol === 'app:') {
  contextBridge.exposeInMainWorld('cillcordDesktop', Object.freeze({
    platform: process.platform,
    version: arg('cillcord-version'),
    // The UI is bundled in the app (1.2.0+): updates come as app updates, not page reloads.
    bundled: true,
    // Hardware video encoding (H.264 and AV1 via the GPU) is switched on for screen sharing.
    hwEncode: arg('cillhub-hw-encode') === '1',
    // cb({ state: 'checking' | 'downloading' | 'none' | 'ready' | 'error', version?, percent? })
    onUpdateStatus: (cb) => withCurrent('update-status', cb),
    checkForUpdates: () => ipcRenderer.invoke('update:check'),
    // Restarts into a downloaded update, or downloads one first and then restarts.
    installUpdate: () => ipcRenderer.invoke('update:install'),
    // cb({ name, start }) when a known game starts (start = ms epoch), cb(null) when it stops or sharing is turned off.
    onGameActivity: (cb) => withCurrent('game-activity', cb),
    // cb('toggle-mute' | 'toggle-deafen') from global shortcuts, even while the window is unfocused.
    onHotkey: (cb) => subscribe('hotkey', cb),
    // Hardware AV1/H.264 GPU encoding status
    getGpuInfo: () => ipcRenderer.invoke('gpu:info'),
    // Native audio DSP and voice engine capabilities
    getAudioDspInfo: () => ipcRenderer.invoke('audio-dsp:info'),
    // Native shell controls: open native desktop settings, get public settings, toggle activity sharing
    openSettings: (section) => ipcRenderer.invoke('settings:open', section),
    getSettings: () => ipcRenderer.invoke('settings:get-public'),
    setActivitySharing: (enabled) => ipcRenderer.invoke('settings:set-activity-sharing', enabled),
    // League of Legends local lobby bridge (LCU)
    onLeagueLobby: (cb) => withCurrent('league-lobby', cb),
    getLeagueLobby: () => ipcRenderer.invoke('league:lobby'),
    sendLeagueInvite: (target) => ipcRenderer.invoke('league:send-invite', target),
    acceptLeagueInvite: (invitationId) => ipcRenderer.invoke('league:accept-invite', invitationId),
  }));
}
