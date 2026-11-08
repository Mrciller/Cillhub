const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('picker', Object.freeze({
  onSources: (cb) => ipcRenderer.once('picker:sources', (_e, data) => cb(data)),
  choose: (id, audio) => ipcRenderer.send('picker:choice', { id, audio: !!audio }),
}));
