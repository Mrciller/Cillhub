// Copies the installers `tauri build` made to <download dir>/desktop/ with their signatures and update feeds, and the
// download page to <download dir>/index.html (the directory the hub serves as /download/):
//   DOWNLOAD_DIR=/path/to/download npm run publish      or      node scripts/publish.js /path/to/download
// Older versions are kept; feeds are written last. Each installer gets <file>.sig, an Ed25519 signature with the self-host
// release key over "cillhub-desktop\n<version>\n<sha512 hex>\n" (src/update.rs verifies it; so does the 2.2.x app, which
// takes this release as its last update). Env like selfhost/scripts/sign-release.sh:
//   RELEASE_KEY  Ed25519 private key (required);  PASSIN  openssl -passin source (else openssl asks on the terminal)
//   PUBLIC_KEY   the pinned key list the app ships (default selfhost/release-public-key.pem)
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PROD_HUB = 'https://cillhub.cillerian.org';
const ROOT = process.argv[2] || process.env.DOWNLOAD_DIR;
if (!ROOT) {
  console.error('usage: DOWNLOAD_DIR=<dir> npm run publish   (or: node scripts/publish.js <dir>)');
  process.exit(2);
}
const DEST = path.join(ROOT, 'desktop');
const { RELEASE_KEY, PASSIN } = process.env;
const PUBLIC_KEY = process.env.PUBLIC_KEY || path.join(__dirname, '..', '..', 'selfhost', 'release-public-key.pem');
if (!RELEASE_KEY) {
  console.error('set RELEASE_KEY to the release private key (and PASSIN for its passphrase): updates must be signed');
  process.exit(2);
}

const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'tauri.conf.json'), 'utf8')).version;
const BUNDLE = path.join(__dirname, '..', 'target', 'release', 'bundle');
const WIN_BUNDLE = path.join(__dirname, '..', 'target', 'x86_64-pc-windows-msvc', 'release', 'bundle');
// tauri's names → the names the feed, the download page and the 2.2.x apps use
const artifacts = {
  [`Cillhub-Setup-${version}.exe`]: path.join(WIN_BUNDLE, 'nsis', `Cillhub_${version}_x64-setup.exe`),
  [`Cillhub-${version}.AppImage`]: path.join(BUNDLE, 'appimage', `Cillhub_${version}_amd64.AppImage`),
  [`cillhub_${version}_amd64.deb`]: path.join(BUNDLE, 'deb', `Cillhub_${version}_amd64.deb`),
};
for (const [name, from] of Object.entries(artifacts)) if (!fs.existsSync(from)) throw new Error(`missing ${from} (for ${name}): run npm run build and npm run build:windows first`);
const [winFile, appImage, deb] = Object.keys(artifacts);

const sha512 = (file, enc) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest(enc);
const keys = (pem) => (String(pem).match(/-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----/g) ?? [])
  .map((p) => crypto.createPublicKey(p)).filter((k) => k.asymmetricKeyType === 'ed25519');
const message = (file) => Buffer.from(`cillhub-desktop\n${version}\n${sha512(file, 'hex')}\n`);

// Sign before anything is published, so a wrong key or passphrase publishes nothing.
const sigs = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-sign-'));
try {
  for (const [name, from] of Object.entries(artifacts)) {
    const msg = path.join(tmp, 'msg');
    fs.writeFileSync(msg, message(from));
    execFileSync('openssl', ['pkeyutl', '-sign', '-rawin', '-inkey', RELEASE_KEY, ...(PASSIN ? ['-passin', PASSIN] : []), '-in', msg, '-out', path.join(tmp, 'sig')], { stdio: 'inherit' });
    const sig = fs.readFileSync(path.join(tmp, 'sig'));
    if (!keys(fs.readFileSync(PUBLIC_KEY, 'utf8')).some((k) => crypto.verify(null, message(from), k, sig))) {
      throw new Error(`the signature of ${name} does not verify against ${PUBLIC_KEY}: RELEASE_KEY is not a pinned key`);
    }
    sigs[`${name}.sig`] = sig;
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// electron-builder's feed layout: src/update.rs reads version and the file list, the 2.2.x apps read all of it.
const releaseDate = new Date().toISOString();
const entry = (name) => `  - url: ${name}\n    sha512: ${sha512(artifacts[name], 'base64')}\n    size: ${fs.statSync(artifacts[name]).size}\n`;
const feed = (main, files) => `version: ${version}\nfiles:\n${files.map(entry).join('')}path: ${main}\nsha512: ${sha512(artifacts[main], 'base64')}\nreleaseDate: '${releaseDate}'\n`;

for (const d of [ROOT, DEST]) { fs.mkdirSync(d, { recursive: true, mode: 0o755 }); fs.chmodSync(d, 0o755); }
const put = (name, data, dir = DEST) => {
  const tmpFile = path.join(dir, `.${name}.tmp`);
  if (Buffer.isBuffer(data) || typeof data === 'string') fs.writeFileSync(tmpFile, data);
  else fs.copyFileSync(data.from, tmpFile);
  fs.chmodSync(tmpFile, 0o644);
  fs.renameSync(tmpFile, path.join(dir, name)); // atomic swap: no half-written file is ever served
};
for (const [name, from] of Object.entries(artifacts)) put(name, { from });
for (const [name, sig] of Object.entries(sigs)) put(name, sig); // before the feeds, like the installers

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const date = new Date(releaseDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
const vars = { HUB: PROD_HUB, VERSION: version, RELEASE_DATE: date, WIN_FILE: encodeURI(winFile), APPIMAGE_FILE: encodeURI(appImage), DEB_FILE: encodeURI(deb) };
const page = fs.readFileSync(path.join(__dirname, '..', 'download-page', 'index.html'), 'utf8').replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? esc(vars[k]) : m));
if (/\{\{\w+\}\}/.test(page)) throw new Error('unfilled template variable in download page');
put('index.html', page, ROOT);

// Feeds last, so clients only see a new version once its files are in place.
put('latest.yml', feed(winFile, [winFile]));
put('latest-linux.yml', feed(appImage, [appImage, deb]));

console.log(`published ${version} to ${DEST}`);
for (const f of fs.readdirSync(DEST).sort()) {
  const st = fs.statSync(path.join(DEST, f));
  console.log(`${(st.mode & 0o777).toString(8)} ${String(st.size).padStart(11)}  ${f}`);
}
