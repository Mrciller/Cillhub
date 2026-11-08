// Runs the electron-builder CLI (same args) with two additions:
// - the update feed from src/config.js (PROD_FEED), so the hub address lives in one place; electron-builder writes it
//   into latest.yml/app-update.yml (the app itself sets the same feed at runtime).
// - Windows NSIS builds without wine: electron-builder can extract the NSIS uninstaller with its own pure-JS
//   UninstallerReader, but only enables that on macOS. We enable it here instead of running the intermediate installer under wine.
// shortcut: relies on app-builder-lib internals (out/util/macosVersion), re-check after electron-builder upgrades.
const { PROD_FEED } = require('../src/config');
const macosVersion = require('app-builder-lib/out/util/macosVersion');
macosVersion.isMacOsCatalina = () => true;
process.argv.push('-c.publish.provider=generic', `-c.publish.url=${PROD_FEED}`);
require('electron-builder/out/cli/cli');
