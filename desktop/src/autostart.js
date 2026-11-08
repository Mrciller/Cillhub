// "Start Cillhub when I log in": login item on Windows, XDG autostart entry on Linux.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

// Named after productName (cillhub.desktop), so an older app installed next to this one keeps its own entry.
const desktopFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'autostart', `${app.getName().toLowerCase()}.desktop`);

function isEnabled() {
  if (process.platform === 'linux') return fs.existsSync(desktopFile);
  return app.getLoginItemSettings().openAtLogin;
}

function setEnabled(on) {
  if (process.platform !== 'linux') return app.setLoginItemSettings({ openAtLogin: on });
  if (!on) return fs.rmSync(desktopFile, { force: true });
  const exe = process.env.APPIMAGE || process.execPath; // AppImage path survives updates; execPath for .deb
  fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
  fs.writeFileSync(desktopFile, `[Desktop Entry]\nType=Application\nName=Cillhub\nExec="${exe.replace(/(["`$\\])/g, '\\$1')}"\nX-GNOME-Autostart-enabled=true\n`);
}

module.exports = { isEnabled, setEnabled };
