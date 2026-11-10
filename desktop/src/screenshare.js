// getDisplayMedia() support: our own sandboxed picker listing screens/windows from desktopCapturer.
const path = require('path');
const { BrowserWindow, desktopCapturer, ipcMain } = require('electron');
const log = require('electron-log/main');
const { APP_ORIGIN, originOf } = require('./config');

function setup(ses, getParent) {
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (originOf(request.securityOrigin) !== APP_ORIGIN) return callback(null);
    let sources;
    try {
      sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
    } catch (err) {
      log.warn('desktopCapturer failed', err);
      return callback(null);
    }
    const choice = await pick(getParent(), sources);
    const source = choice && sources.find((s) => s.id === choice.id);
    if (!source) return callback(null); // cancel / closed = deny
    // Loopback system audio is only supported on Windows.
    callback(choice.audio && process.platform === 'win32' ? { video: source, audio: 'loopback' } : { video: source });
  }, { useSystemPicker: false });
}

function pick(parent, sources) {
  return new Promise((resolve) => {
    const validParent = parent && !parent.isDestroyed() ? parent : null;
    const win = new BrowserWindow({
      parent: validParent, modal: !!validParent, width: 760, height: 560, minWidth: 480, minHeight: 360,
      title: 'Share your screen', backgroundColor: '#17191e', autoHideMenuBar: true, show: false,
      webPreferences: { preload: path.join(__dirname, 'picker-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    let done = false;
    const finish = (choice) => {
      if (done) return;
      done = true;
      ipcMain.removeListener('picker:choice', onChoice);
      if (!win.isDestroyed()) win.destroy();
      resolve(choice);
    };
    const onChoice = (e, choice) => {
      if (e.sender !== win.webContents) return; // only our picker may answer
      finish(choice && typeof choice.id === 'string' ? choice : null);
    };
    ipcMain.on('picker:choice', onChoice);
    win.on('closed', () => finish(null));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.webContents.once('did-finish-load', () => {
      if (win.isDestroyed()) return;
      win.webContents.send('picker:sources', {
        audioSupported: process.platform === 'win32',
        sources: sources.map((s) => ({ id: s.id, name: s.name, thumbnail: s.thumbnail.toDataURL() })),
      });
      win.show();
    });
    win.loadFile(path.join(__dirname, 'picker.html'));
  });
}

module.exports = { setup };
