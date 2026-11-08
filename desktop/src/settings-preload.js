const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('desktopSettings', Object.freeze({
  get: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  recording: (on) => ipcRenderer.send('settings:recording', !!on),
  onState: (cb) => ipcRenderer.on('settings:state', (_e, s) => cb(s)),
  checkForUpdates: () => ipcRenderer.invoke('settings:check-update'),
  installUpdate: () => ipcRenderer.invoke('settings:install-update'),
}));
