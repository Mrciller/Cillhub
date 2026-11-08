// One-time move of the login and local settings (token, node tokens, zoom, watch audio, voice settings, settings cache, …)
// from LEGACY_ORIGIN (config.js), where 1.0/1.1 ran the website, to app://cillhub. Runs before the UI loads and works
// offline: the old origin is answered locally with an empty page, so no website code runs. Keys the new origin already
// has are kept. Values are never logged. Since 2.0.0 (new app id, fresh userData) there is nothing to copy; kept for the
// legacy build that still runs on the old userData.
const { BrowserWindow, net } = require('electron');
const log = require('electron-log/main');
const settings = require('./settings');
const { LEGACY_ORIGIN, APP_ORIGIN } = require('./config');

const OLD_PAGE = `${LEGACY_ORIGIN}/__cillhub-migrate`;
const BLANK = () => new Response('<!doctype html><title></title>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

// Runs fn(win) with the old origin answered locally (an empty page at OLD_PAGE, everything else passes through).
async function withOldOrigin(ses, fn) {
  const scheme = new URL(LEGACY_ORIGIN).protocol.slice(0, -1);
  ses.protocol.handle(scheme, (req) => (req.url === OLD_PAGE ? BLANK() : net.fetch(req, { bypassCustomProtocolHandlers: true })));
  const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  try {
    await win.loadURL(OLD_PAGE);
    return await fn(win);
  } finally {
    ses.protocol.unhandle(scheme);
    win.destroy();
  }
}

async function migrate(ses) {
  if (settings.get().loginMigrated) return;
  try {
    const raw = await withOldOrigin(ses, (win) => win.webContents.executeJavaScript('JSON.stringify(Object.entries(localStorage))'));
    const entries = JSON.parse(raw).filter((e) => Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string');
    const win = new BrowserWindow({ show: false, webPreferences: { session: ses, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    let copied;
    try {
      await win.loadURL(`${APP_ORIGIN}/__blank`);
      copied = await win.webContents.executeJavaScript(`((e) => { let n = 0; for (const [k, v] of e) if (localStorage.getItem(k) === null) { localStorage.setItem(k, v); n++; } return n; })(${JSON.stringify(entries)})`);
    } finally {
      win.destroy();
    }
    ses.flushStorageData();
    settings.set({ loginMigrated: true });
    settings.flushSync();
    log.info(`login migration: copied ${copied} of ${entries.length} local keys from the old origin`);
  } catch (err) {
    log.warn('login migration failed, will retry at the next start', err?.message);
  }
}

module.exports = { migrate, withOldOrigin };
