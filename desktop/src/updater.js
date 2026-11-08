// Background auto-update via electron-updater (generic feed next to the web client). The UI is bundled since 1.2.0, so
// web changes reach users through these updates; the page's update banner calls check()/install() through the bridge.
const { autoUpdater } = require('electron-updater');
const { Notification } = require('electron');
const log = require('electron-log/main');
const { UPDATE_URL, MOVED_TO } = require('./config');

const FOUR_HOURS = 4 * 60 * 60 * 1000;
let last = { state: 'none' };
let installWhenReady = false;
let busy = false;
let busyTimer = null;

function clearBusy() {
  busy = false;
  installWhenReady = false;
  if (busyTimer) {
    clearTimeout(busyTimer);
    busyTimer = null;
  }
}

function setBusySafetyTimeout() {
  if (busyTimer) clearTimeout(busyTimer);
  busyTimer = setTimeout(() => {
    clearBusy();
  }, 35000);
  if (busyTimer.unref) busyTimer.unref();
}

const check = () => {
  if (last.state === 'ready') return Promise.resolve(null);
  return autoUpdater.checkForUpdates().catch((err) => {
    log.warn('update check failed', err?.message);
    return null;
  });
};

function start({ onStatus, onReady }) {
  const status = (s) => { last = s; onStatus(s); };
  autoUpdater.logger = log;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // A legacy build (MOVED_TO) keeps the feed it was built with (app-update.yml): never the new app's feed, whose installer
  // has another app id, but still a way to ship it a fix.
  if (!MOVED_TO) autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_URL });

  autoUpdater.on('checking-for-update', () => last.state !== 'ready' && status({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => status({ state: 'downloading', version: i.version }));
  autoUpdater.on('update-not-available', () => {
    clearBusy();
    if (last.state !== 'ready') status({ state: 'none' });
  });
  autoUpdater.on('download-progress', (p) => status({ state: 'downloading', version: last.version, percent: Math.round(p.percent) }));
  autoUpdater.on('error', (err) => {
    clearBusy();
    log.warn('update error', err?.message);
    if (last.state !== 'ready') status({ state: 'error' });
  });
  autoUpdater.on('update-downloaded', (info) => {
    status({ state: 'ready', version: info.version });
    onReady(info.version);
    if (installWhenReady) return restart(); // the user already clicked "Update" in the page
    if (Notification.isSupported()) {
      const n = new Notification({ title: 'Cillhub', body: 'Update ready, restart to apply', actions: [{ type: 'button', text: 'Restart' }] });
      n.on('click', restart);
      n.on('action', restart);
      n.show();
    }
  });

  setTimeout(check, 5000); // never block startup
  setInterval(check, FOUR_HOURS);
}

const restart = () => {
  setBusySafetyTimeout();
  autoUpdater.quitAndInstall();
};

/** "Update" in the page: restart now when the update is downloaded, else check, download and restart when it is ready. */
function install() {
  if (busy) return;
  busy = true;
  setBusySafetyTimeout();

  if (last.state === 'ready') return restart();

  installWhenReady = true;
  if (last.state !== 'downloading' && last.state !== 'checking') {
    const p = check();
    if (p && typeof p.then === 'function') {
      p.then(() => {
        if (last.state !== 'ready' && last.state !== 'downloading') {
          clearBusy();
        }
      }).catch(() => {
        clearBusy();
      });
    } else {
      if (last.state !== 'ready' && last.state !== 'downloading') {
        clearBusy();
      }
    }
  }
}

module.exports = { start, restart, check, install, status: () => last, isBusy: () => busy };
