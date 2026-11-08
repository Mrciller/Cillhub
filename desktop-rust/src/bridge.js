// Cillhub Native Desktop Client Bridge (Rust Core)
// Injected into app://cillhub on page load. Exposes frozen window.cillcordDesktop with nativeAudio extension.
if (location.protocol === 'app:') {
  const invoke = (cmd, args = {}) => {
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke) {
      return window.__TAURI_INTERNALS__.invoke(cmd, args);
    }
    return Promise.resolve(null);
  };

  const listen = (event, cb) => {
    if (window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.listen) {
      return window.__TAURI_INTERNALS__.listen(event, (e) => cb(e.payload));
    }
    return Promise.resolve(() => {});
  };

  const listeners = new Map();

  const subscribe = (channel, cb) => {
    if (typeof cb !== 'function') return () => {};
    let active = true;
    listen(channel, (val) => { if (active) cb(val); }).then((unsub) => {
      if (!active && typeof unsub === 'function') unsub();
      else listeners.set(cb, unsub);
    });
    return () => {
      active = false;
      const unsub = listeners.get(cb);
      if (typeof unsub === 'function') { unsub(); listeners.delete(cb); }
    };
  };

  const withCurrent = (channel, cb) => {
    const off = subscribe(channel, cb);
    let live = true;
    invoke(`${channel}_current`).then((v) => { if (live && v != null) cb(v); }).catch(() => {});
    return () => { live = false; off(); };
  };

  Object.defineProperty(window, 'cillcordDesktop', {
    configurable: false,
    writable: false,
    value: Object.freeze({
      platform: window.__CILLHUB_PLATFORM__ || 'linux',
      version: window.__CILLHUB_VERSION__ || '2.2.1',
      bundled: true,
      hwEncode: true,
      onUpdateStatus: (cb) => withCurrent('update-status', cb),
      checkForUpdates: () => invoke('update_check'),
      installUpdate: () => invoke('update_install'),
      onGameActivity: (cb) => withCurrent('game-activity', cb),
      onHotkey: (cb) => subscribe('hotkey', cb),
      getGpuInfo: () => invoke('gpu_info'),
      getAudioDspInfo: () => invoke('audio_dsp_info'),
      openSettings: (section) => invoke('settings_open', { section }),
      getSettings: () => invoke('settings_get_public'),
      setActivitySharing: (enabled) => invoke('settings_set_activity_sharing', { enabled }),
      onLeagueLobby: (cb) => withCurrent('league-lobby', cb),
      getLeagueLobby: () => invoke('league_lobby'),
      sendLeagueInvite: (target) => invoke('league_send_invite', { target }),
      acceptLeagueInvite: (invitationId) => invoke('league_accept_invite', { invitationId }),
      nativeAudio: Object.freeze({
        supported: true,
        getMetrics: () => invoke('audio_get_metrics'),
        setConfig: (cfg) => invoke('audio_set_config', { cfg }),
      }),
    }),
  });
}
