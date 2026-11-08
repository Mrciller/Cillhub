// Tray icon: Open / Settings / Close to tray / Start at login / restart-for-update / Quit, plus unread tooltip.
const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');
const settings = require('./settings');
const autostart = require('./autostart');

let tray;
let updateVersion = null;
let unreadText = '';
let actions;

function create(a) {
  actions = a;
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'assets', 'icon.png')).resize({ width: 16, height: 16 }));
  tray.on('click', actions.show);
  refresh();
}

function refresh() {
  if (!tray) return;
  tray.setToolTip(['Cillhub', unreadText, updateVersion && `update ${updateVersion} ready`].filter(Boolean).join(' – '));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open Cillhub', click: actions.show },
    { label: 'Settings…', click: actions.openSettings },
    { type: 'separator' },
    ...(updateVersion ? [{ label: `Restart to update (${updateVersion})`, click: actions.restartToUpdate }, { type: 'separator' }] : []),
    { label: 'Close to tray', type: 'checkbox', checked: settings.get().closeToTray, click: (i) => settings.set({ closeToTray: i.checked }) },
    { label: 'Start Cillhub when I log in', type: 'checkbox', checked: autostart.isEnabled(), click: (i) => { autostart.setEnabled(i.checked); refresh(); } },
    { type: 'separator' },
    { label: 'Quit Cillhub', click: () => app.quit() },
  ]));
}

function setUnread(text) { unreadText = text; refresh(); }
function setUpdateReady(version) { updateVersion = version; refresh(); }

module.exports = { create, setUnread, setUpdateReady };
