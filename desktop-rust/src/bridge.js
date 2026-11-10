// Runs in the bundled client before its scripts: window.cillcordDesktop, the API client/src/desktop/bridge.ts and
// update.ts use. Only the app's own pages get it (a node's sign-in page loads in the same webview). The shell pushes
// values with window.__cillhubPush(channel, value) (main.rs push()).
(() => {
  if (!(location.protocol === 'tauri:' || location.hostname === 'tauri.localhost')) return;
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  const subs = new Map();
  const subscribe = (channel, cb) => {
    if (typeof cb !== 'function') return () => {};
    if (!subs.has(channel)) subs.set(channel, new Set());
    subs.get(channel).add(cb);
    return () => subs.get(channel).delete(cb);
  };
  // Subscribes and also delivers the current value once (page reload, late mount).
  const withCurrent = (channel, cb) => {
    const off = subscribe(channel, cb);
    let live = true;
    if (typeof cb === 'function') invoke(`${channel}_current`).then((v) => { if (live && v != null) cb(v); }).catch(() => {});
    return () => { live = false; off(); };
  };
  Object.defineProperty(window, '__cillhubPush', {
    value: Object.freeze((channel, value) => { for (const cb of subs.get(channel) || []) try { cb(value); } catch {} }),
  });
  Object.defineProperty(window, 'cillcordDesktop', {
    value: Object.freeze({
      platform: '__PLATFORM__',
      version: '__VERSION__',
      // The UI is bundled in the app: updates come as app updates, not page reloads.
      bundled: true,
      // Chromium (WebView2) encodes screen shares on the GPU; WebKitGTK does not promise it.
      hwEncode: '__PLATFORM__' === 'win32',
      // cb({ state: 'checking' | 'downloading' | 'none' | 'ready' | 'error', version?, percent? })
      onUpdateStatus: (cb) => withCurrent('update-status', cb),
      checkForUpdates: () => invoke('update_check'),
      // Restarts into a downloaded update, or downloads one first and then restarts.
      installUpdate: () => invoke('update_install'),
      // cb({ name, start }) when a known game starts (start = ms epoch), cb(null) when it stops or sharing is off.
      onGameActivity: (cb) => withCurrent('game-activity', cb),
      // Global shortcuts are not part of this shell.
      onHotkey: () => () => {},
    }),
  });
})();
