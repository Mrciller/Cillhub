// Single source of truth for addresses. The UI is bundled (web/, served as app://cillhub/); it talks to the hub at HUB_URL.
// The default hub, the maintainer's instance. A fork that runs its own hub changes this one line (and rebuilds web/).
const PROD_HUB = 'https://cillhub.cillerian.org';
// Where apps up to 1.1 kept the login (they loaded the website from this origin); only migrate.js reads it, offline.
const LEGACY_ORIGIN = 'https://jeopardy.cillerian.org';
const TEST_HOOK = process.env.CILLCORD_TEST_HOOK === '1';
// CILLCORD_URL, CILLCORD_HUB_URL, or --hub=<url> points the app at another hub (e.g. Betacord, custom node, or test instance).
const hubArg = process.argv?.find?.((a) => typeof a === 'string' && a.startsWith('--hub='));
const cliHub = hubArg ? hubArg.slice('--hub='.length) : '';
const envHub = process.env.CILLCORD_HUB_URL || process.env.CILLCORD_URL;
let HUB_URL = (cliHub || envHub || PROD_HUB).replace(/\/+$/, '');
let HUB_ORIGIN = PROD_HUB;
try {
  HUB_ORIGIN = new URL(HUB_URL).origin;
} catch {
  HUB_URL = PROD_HUB;
  HUB_ORIGIN = new URL(PROD_HUB).origin;
}
const APP_ORIGIN = 'app://cillhub';
const APP_URL = `${APP_ORIGIN}/`;
// Update feed under the hub's downloads (scripts/dist.js writes PROD_FEED into the build); CILLCORD_UPDATE_URL is honoured
// only with the test hook on.
const FEED_PATH = '/download/desktop/';
const PROD_FEED = PROD_HUB + FEED_PATH;
// Never an http: hub's feed: anyone on the path could hand us an installer.
const UPDATE_URL = (TEST_HOOK && process.env.CILLCORD_UPDATE_URL) || (HUB_ORIGIN.startsWith('https:') ? HUB_ORIGIN + FEED_PATH : PROD_FEED);
// package.json metadata: the app id (Windows AppUserModelID) and, only in a maintainer's legacy build for the old app id,
// the download page users are sent to because the app moved (main.js shows a notice on every start; updater.js keeps
// the feed that build was made with).
const pkg = require('../package.json');
const APP_ID = pkg.cillhubAppId || 'io.github.mrciller.cillhub';
const MOVED_TO = typeof pkg.cillhubMovedTo === 'string' && /^https:\/\//.test(pkg.cillhubMovedTo) ? pkg.cillhubMovedTo : null;

// scheme://host[:port]; also for app:// (WHATWG URL gives non-special schemes the origin "null")
const originOf = (url) => {
  try { const u = new URL(url); return u.host ? `${u.protocol}//${u.host}` : null; } catch { return null; }
};
const isAppUrl = (url) => originOf(url) === APP_ORIGIN;
const isHttpUrl = (url) => {
  try { return ['http:', 'https:'].includes(new URL(url).protocol); } catch { return false; }
};

// Permissions the client needs (calls, screen share, notifications, copy, fullscreen); only its own pages get them (hub pages
// shown in the app are only the sign-in popup and non-client paths, which need none).
const ALLOWED_PERMISSIONS = new Set(['media', 'notifications', 'display-capture', 'clipboard-sanitized-write', 'fullscreen']);
const permissionAllowed = (permission, url) => ALLOWED_PERMISSIONS.has(permission) && originOf(url) === APP_ORIGIN;

// Pages of the web client. A hub link to one of them (invite, message link, OAuth consent, sign-in callback) opens in the
// app; any other hub path (/download, /api, files) is not part of the bundle and opens in the browser.
const SPA_SECTIONS = new Set(['', 'channels', 'invite', 'template', 'login', 'register', 'oauth2', 'instances', 'developers', 'admin', 'directory']);
/** https://<hub>/invite/abc → app://cillhub/invite/abc; null when the URL is not a client page on the hub. */
function appUrlFor(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.origin !== HUB_ORIGIN || !SPA_SECTIONS.has(u.pathname.split('/')[1])) return null;
  return APP_ORIGIN + u.pathname + u.search + u.hash;
}

module.exports = { PROD_HUB, LEGACY_ORIGIN, PROD_FEED, APP_ID, MOVED_TO, HUB_URL, HUB_ORIGIN, APP_ORIGIN, APP_URL, UPDATE_URL, TEST_HOOK, originOf, isAppUrl, isHttpUrl, appUrlFor, permissionAllowed };
