// Cillhub desktop: the web client bundled as a program (app://cillhub/), talking to the hub; a locked-down Electron shell.
const path = require('path');
const { app, BrowserWindow, session, shell, nativeImage, screen, ipcMain, dialog } = require('electron');
const log = require('electron-log/main');
const { APP_URL, APP_ORIGIN, HUB_URL, TEST_HOOK, APP_ID, MOVED_TO, originOf, isAppUrl, isHttpUrl, appUrlFor, permissionAllowed } = require('./config');
const settings = require('./settings');
const protocol = require('./protocol');
const gpu = require('./gpu');
const { migrate } = require('./migrate');
const tray = require('./tray');
const updater = require('./updater');
const screenshare = require('./screenshare');
const games = require('./games');
const { LeagueClientManager } = require('./league');
const hotkeys = require('./hotkeys');
const settingsWindow = require('./settings-window');
const { parseUnread } = require('./unread');
const { PROTOCOLS, deepLinkPath, findDeepLink } = require('./deeplink');

// app.name is productName ("Cillhub"); it fixes the userData dir (holds the login), the Windows login item and WM_CLASS.
// Not set here on purpose: a legacy build with another productName must keep its own.
if (process.platform === 'win32') app.setAppUserModelId(APP_ID);
protocol.registerScheme(); // must happen before ready
const gpuShare = settings.get().gpuScreenShare !== false; // read once: switches only change with a restart
const hwEncode = gpu.apply(app, gpuShare);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win = null;
  let quitting = false;
  const SIGNIN = 'cillcord-signin'; // window name the client uses for "sign in with the hub" on a linked node
  const badge = nativeImage.createFromPath(path.join(__dirname, 'assets', 'badge.png'));

  const openExternal = (url) => { if (isHttpUrl(url)) shell.openExternal(url); };

  const show = () => {
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };
  const openInApp = (url) => { if (win) { win.loadURL(url); show(); } };

  // Bridge events go only to the app's own pages.
  const sendToPage = (channel, value) => { if (win && isAppUrl(win.webContents.getURL())) win.webContents.send(channel, value); };
  const fromPage = (e) => !!win && e.sender === win.webContents && isAppUrl(e.senderFrame?.url);
  const sharedActivity = () => (settings.get().shareActivity ? games.current() : null);

  const openDeepLink = (argv) => {
    const p = deepLinkPath(findDeepLink(argv));
    if (p) openInApp(APP_ORIGIN + p);
  };

  function restoreBounds() {
    const { bounds } = settings.get();
    const visible = bounds.x !== undefined && screen.getAllDisplays().some(({ workArea: a }) =>
      bounds.x < a.x + a.width && bounds.x + bounds.width > a.x && bounds.y < a.y + a.height && bounds.y + bounds.height > a.y);
    return visible ? bounds : { width: bounds.width, height: bounds.height };
  }

  // Main window: app pages stay, client pages on the hub (invite or message links) open in the app, the rest in the browser.
  function guardMain(e, url) {
    if (isAppUrl(url)) return;
    e.preventDefault();
    const inApp = appUrlFor(url);
    if (inApp) setImmediate(() => win?.loadURL(inApp)); // not inside the cancelled navigation's event
    else openExternal(url);
  }
  // Sign-in popup (linked node → hub consent → node → callback): http(s) hops are allowed; hub client pages (the consent
  // page, the callback) are loaded from the bundle instead, where the app's login lives.
  function guardSignin(wc, e, url) {
    if (isAppUrl(url)) return;
    const inApp = appUrlFor(url);
    if (!inApp && isHttpUrl(url)) return;
    e.preventDefault();
    if (inApp) setImmediate(() => !wc.isDestroyed() && wc.loadURL(inApp).catch((err) => log.warn('sign-in page failed', err?.message)));
  }

  // Truthful: the switches are on and Chromium did not put video encoding on its GPU blocklist for this machine.
  const hwEncodeOn = () => hwEncode && /^enabled/.test(app.getGPUFeatureStatus().video_encode || '');

  function createWindow() {
    win = new BrowserWindow({
      ...restoreBounds(),
      minWidth: 380,
      minHeight: 320,
      resizable: true,
      title: 'Cillhub',
      backgroundColor: '#17191e',
      icon: path.join(__dirname, 'assets', 'icon.png'),
      autoHideMenuBar: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: true,
        additionalArguments: [`--cillcord-version=${app.getVersion()}`, `--cillhub-hw-encode=${hwEncodeOn() ? 1 : 0}`],
      },
    });
    win.setMenu(null);
    if (settings.get().maximized) win.maximize();
    win.once('ready-to-show', () => win.show());

    const wc = win.webContents;
    wc.on('will-navigate', guardMain);
    wc.on('will-redirect', guardMain);
    wc.on('did-create-window', (child, { frameName }) => {
      if (frameName !== SIGNIN) return;
      child.setMenu(null);
      const guard = (e, url) => guardSignin(child.webContents, e, url);
      child.webContents.on('will-navigate', guard);
      child.webContents.on('will-redirect', guard);
    });

    win.on('page-title-updated', (e, title) => {
      e.preventDefault();
      const n = parseUnread(title);
      win.setTitle(n > 0 ? `(${n}) Cillhub` : 'Cillhub');
      const text = n > 0 ? `${n} unread mention${n === 1 ? '' : 's'}` : n < 0 ? 'unread messages' : '';
      tray.setUnread(text);
      if (process.platform === 'win32') win.setOverlayIcon(n ? badge : null, text);
      else app.setBadgeCount(Math.max(n, 0));
    });

    // Cheap per event: settings.set only debounces; the file is written ~500 ms after the last resize/move, off the main thread.
    const saveBounds = () => {
      if (!win.isMaximized() && !win.isMinimized() && !win.isFullScreen()) settings.set({ bounds: win.getBounds() });
    };
    win.on('resize', saveBounds);
    win.on('move', saveBounds);
    win.on('close', (e) => {
      settings.set({ maximized: win.isMaximized() });
      settings.flushSync();
      if (!quitting && process.platform !== 'darwin' && settings.get().closeToTray) {
        e.preventDefault();
        win.hide();
      }
    });
    win.on('closed', () => { win = null; });
  }

  function lockDownSession(ses) {
    // The node sign-in popup shares this session and may load any node's page: it gets nothing, and no page gets USB/HID/serial.
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => callback(permissionAllowed(permission, details.requestingUrl)));
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => permissionAllowed(permission, requestingOrigin));
    ses.setDevicePermissionHandler(() => false);
    screenshare.setup(ses, () => win);
  }

  // Every webContents: no webviews; popups only for the node sign-in, client pages on the hub open in the app.
  app.on('web-contents-created', (_e, contents) => {
    contents.on('will-attach-webview', (e) => e.preventDefault());
    contents.setWindowOpenHandler(({ url, frameName }) => {
      const inApp = appUrlFor(url);
      if (inApp) { openInApp(inApp); return { action: 'deny' }; }
      if (frameName === SIGNIN && isHttpUrl(url) && isAppUrl(contents.getURL())) {
        return { action: 'allow', overrideBrowserWindowOptions: { width: 520, height: 720, title: 'Cillhub', autoHideMenuBar: true, backgroundColor: '#17191e' } };
      }
      openExternal(url);
      return { action: 'deny' };
    });
  });

  app.on('second-instance', (_e, argv) => { show(); openDeepLink(argv); });
  app.on('before-quit', () => { quitting = true; });
  app.on('will-quit', () => { settings.flushSync(); hotkeys.stop(); games.stop(); });
  app.on('window-all-closed', () => app.quit());
  app.on('open-url', (e, url) => { e.preventDefault(); openDeepLink([url]); });

  // Shown on every start of a legacy build; "Later" dismisses it until the next start.
  async function showMovedNotice() {
    const de = app.getLocale().startsWith('de');
    log.info(`moved notice shown (${MOVED_TO})`);
    const { response } = await dialog.showMessageBox(win, {
      type: 'info',
      title: 'Cillhub',
      message: de ? 'Cillhub ist in eine neue App umgezogen' : 'Cillhub moved to a new app',
      detail: de
        ? 'Diese App bekommt keine Updates mehr. Lade die neue Cillhub-App herunter, installiere sie und melde dich dort einmal neu an. Danach kannst du diese App deinstallieren.'
        : 'This app no longer receives updates. Download and install the new Cillhub app and sign in there once. Then you can uninstall this one.',
      buttons: [de ? 'Neue App herunterladen' : 'Download the new app', de ? 'Später' : 'Later'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    log.info(`moved notice: ${response === 0 ? 'download' : 'later'}`);
    if (response === 0) openExternal(MOVED_TO);
  }

  app.whenReady().then(async () => {
    if (!process.defaultApp) for (const p of PROTOCOLS) app.setAsDefaultProtocolClient(p);
    const updatedFrom = settings.exists() && settings.get().lastVersion !== app.getVersion(); // false on a fresh install
    const ses = session.defaultSession;
    protocol.handle(ses);
    lockDownSession(ses);
    createWindow();
    tray.create({ show, restartToUpdate: updater.restart, openSettings: () => settingsWindow.open() });

    settingsWindow.setup({
      onShareChanged: () => sendToPage('game-activity', sharedActivity()),
      gpuScreenShare: gpuShare,
      hwEncode: hwEncodeOn(),
    });
    const league = new LeagueClientManager();
    league.onChange((lobby) => sendToPage('league-lobby', lobby));

    games.start({
      getCustom: () => settings.get().customGames,
      onProcesses: (procs) => league.check(procs).catch(() => {}),
      onChange: (activity) => {
        if (settings.get().shareActivity) sendToPage('game-activity', activity);
        settingsWindow.refresh();
      },
    });
    ipcMain.handle('game-activity:current', (e) => (fromPage(e) ? sharedActivity() : null));
    ipcMain.handle('league:lobby', (e) => (fromPage(e) ? league.getLobby() : null));
    ipcMain.handle('league-lobby:current', (e) => (fromPage(e) ? league.getLobby() : null));
    ipcMain.handle('league:send-invite', async (e, target) => {
      if (!fromPage(e)) return false;
      try {
        await league.sendInvite(target);
        return true;
      } catch (err) {
        log.warn('LCU send invite error:', err?.message);
        throw err;
      }
    });
    ipcMain.handle('league:accept-invite', async (e, invitationId) => {
      if (!fromPage(e)) return false;
      try {
        await league.acceptInvite(invitationId);
        return true;
      } catch (err) {
        log.warn('LCU accept invite error:', err?.message);
        throw err;
      }
    });
    ipcMain.handle('update-status:current', (e) => (fromPage(e) ? updater.status() : null));
    ipcMain.handle('update:check', (e) => { if (fromPage(e)) updater.check(); });
    ipcMain.handle('update:install', (e) => { if (fromPage(e)) MOVED_TO ? openExternal(MOVED_TO) : updater.install(); });
    ipcMain.handle('gpu:info', (e) => {
      if (!fromPage(e)) return null;
      return {
        hwEncode: hwEncodeOn(),
        platform: process.platform,
        videoEncode: app.getGPUFeatureStatus?.()?.video_encode || 'unknown',
        av1Supported: process.platform === 'win32' && hwEncodeOn(),
        h264Supported: hwEncodeOn() || process.platform === 'win32',
      };
    });
    ipcMain.handle('audio-dsp:info', (e) => {
      if (!fromPage(e)) return null;
      return {
        engines: ['RNNoise', 'SpeexDSP', 'GTCRN', 'NoiseGate'],
        sampleRate: 48000,
        channels: 2,
        hifiSupported: true,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        highPassFilter: true,
      };
    });
    ipcMain.handle('settings:open', (e, section) => {
      if (fromPage(e)) {
        settingsWindow.open(typeof section === 'string' ? section : undefined);
        return true;
      }
      return false;
    });
    ipcMain.handle('settings:get-public', (e) => {
      if (!fromPage(e)) return null;
      const s = settings.get();
      return {
        shareActivity: s.shareActivity !== false,
        gpuScreenShare: s.gpuScreenShare !== false,
        hotkeys: hotkeys.current(),
      };
    });
    ipcMain.handle('settings:set-activity-sharing', (e, enabled) => {
      if (!fromPage(e)) return false;
      settings.set({ shareActivity: !!enabled });
      sendToPage('game-activity', sharedActivity());
      settingsWindow.refresh();
      return true;
    });
    hotkeys.start(settings.get().hotkeys, (action) => sendToPage('hotkey', action));

    // Release notes once after an update (the About section lists what's new).
    if (settings.get().lastVersion !== app.getVersion()) {
      settings.set({ lastVersion: app.getVersion() });
      if (updatedFrom && !MOVED_TO) win.once('ready-to-show', () => settingsWindow.open('about')); // a legacy build shows the moved notice instead
    }
    updater.start({
      onStatus: (status) => {
        sendToPage('update-status', status);
        settingsWindow.refresh();
      },
      onReady: (v) => {
        tray.setUpdateReady(v);
        settingsWindow.refresh();
      },
    });
    if (MOVED_TO) win.once('ready-to-show', showMovedNotice); // legacy build (old app id): point to the new app on every start

    if (TEST_HOOK && process.env.CILLCORD_TEST_SEED) await require('./test-hook').seedOldOrigin(ses);
    await migrate(ses); // 1.0/1.1 kept the login on the website's origin: move it before the UI reads it
    const link = deepLinkPath(findDeepLink(process.argv));
    win.loadURL(APP_ORIGIN + (link || '/'));
    if (TEST_HOOK && process.env.CILLCORD_TEST_RESULT) require('./test-hook').run(win);
    log.info(`Cillhub ${app.getVersion()} started (${APP_URL}, hub ${HUB_URL}, GPU screen share ${gpuShare ? 'on' : 'off'}, hw encode ${hwEncodeOn()})`);
  });
}
