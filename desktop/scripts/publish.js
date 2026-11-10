// Copies the built installers, blockmaps and update feeds to <download dir>/desktop/ and the download page to
// <download dir>/index.html (the directory the hub serves as /download/):
//   DOWNLOAD_DIR=/path/to/download npm run publish      or      node scripts/publish.js /path/to/download
// Older versions are kept (their blockmaps enable differential updates); feeds are written last.
// Each auto-update installer gets <file>.sig, an Ed25519 signature with the self-host release key (src/release-sig.js);
// apps refuse an update without it. Env like selfhost/scripts/sign-release.sh:
//   RELEASE_KEY  Ed25519 private key (required);  PASSIN  openssl -passin source (else openssl asks on the terminal)
//   PUBLIC_KEY   the pinned key list the app ships (default selfhost/release-public-key.pem)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { PROD_HUB } = require('../src/config');
const { message, verify } = require('../src/release-sig');

const DIST = path.join(__dirname, '..', 'dist');
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

const readYml = (name) => fs.readFileSync(path.join(DIST, name), 'utf8');
const field = (yml, key) => {
  const m = new RegExp(`^${key}: '?([^'\\n]+)'?$`, 'm').exec(yml);
  if (!m) throw new Error(`${key} missing in feed`);
  return m[1].trim();
};
const urls = (yml) => [...yml.matchAll(/^\s+- url: (.+)$/gm)].map((m) => m[1].trim());
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const win = readYml('latest.yml');
const linux = readYml('latest-linux.yml');
const version = field(win, 'version');
if (field(linux, 'version') !== version) throw new Error('Windows and Linux feeds have different versions');
const winFile = field(win, 'path');
const appImage = field(linux, 'path');
const deb = urls(linux).find((u) => u.endsWith('.deb'));
const rustDeb = `cillhub-desktop-rust_${version}_amd64.deb`;
const rustTar = `Cillhub-Rust-${version}-linux-x64.tar.gz`;
const rustWinZip = `Cillhub-Rust-${version}-windows-x64.zip`;
const rustWinExe = `Cillhub-Rust-${version}-windows-x64.exe`;
const rustWinSetup = `Cillhub-Rust-Setup-${version}.exe`;
const files = [winFile, `${winFile}.blockmap`, appImage, deb, rustDeb, rustTar, rustWinZip, rustWinExe, rustWinSetup].filter((f) => f && fs.existsSync(path.join(DIST, f)));
for (const f of [winFile, `${winFile}.blockmap`, appImage, deb].filter(Boolean)) if (!fs.existsSync(path.join(DIST, f))) throw new Error(`missing dist/${f}`);

for (const d of [ROOT, DEST]) { fs.mkdirSync(d, { recursive: true, mode: 0o755 }); fs.chmodSync(d, 0o755); }
const put = (name, data, dir = DEST) => {
  const tmp = path.join(dir, `.${name}.tmp`);
  if (Buffer.isBuffer(data) || typeof data === 'string') fs.writeFileSync(tmp, data);
  else fs.copyFileSync(data.from, tmp);
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, path.join(dir, name)); // atomic swap: no half-written file is ever served
};

// Sign before anything is published, so a wrong key or passphrase publishes nothing.
const sigs = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-sign-'));
(async () => {
  for (const f of [winFile, appImage, deb].filter(Boolean)) {
    const msg = path.join(tmp, 'msg');
    fs.writeFileSync(msg, await message(path.join(DIST, f), version));
    execFileSync('openssl', ['pkeyutl', '-sign', '-rawin', '-inkey', RELEASE_KEY, ...(PASSIN ? ['-passin', PASSIN] : []), '-in', msg, '-out', path.join(tmp, 'sig')], { stdio: 'inherit' });
    sigs[`${f}.sig`] = fs.readFileSync(path.join(tmp, 'sig'));
    if (!(await verify(path.join(DIST, f), version, sigs[`${f}.sig`], fs.readFileSync(PUBLIC_KEY, 'utf8')))) {
      throw new Error(`the signature of ${f} does not verify against ${PUBLIC_KEY}: RELEASE_KEY is not a pinned key`);
    }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  publish();
})().catch((err) => {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error(err.message);
  process.exit(1);
});

function publish() {
  for (const f of files) put(f, { from: path.join(DIST, f) });
  for (const [name, sig] of Object.entries(sigs)) put(name, sig); // before the feeds, like the installers

  const date = new Date(field(win, 'releaseDate')).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  const vars = { HUB: PROD_HUB, VERSION: version, RELEASE_DATE: date, WIN_FILE: encodeURI(winFile), APPIMAGE_FILE: encodeURI(appImage), DEB_FILE: encodeURI(deb || appImage) };
  const page = fs.readFileSync(path.join(__dirname, '..', 'download-page', 'index.html'), 'utf8')
    .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? esc(vars[k]) : m));
  if (/\{\{\w+\}\}/.test(page)) throw new Error('unfilled template variable in download page');
  put('index.html', page, ROOT);

  // Feeds last, so clients only see a new version once its files are in place.
  put('latest.yml', win);
  put('latest-linux.yml', linux);

  console.log(`published ${version} to ${DEST}`);
  for (const f of fs.readdirSync(DEST).sort()) {
    const st = fs.statSync(path.join(DEST, f));
    console.log(`${(st.mode & 0o777).toString(8)} ${String(st.size).padStart(11)}  ${f}`);
  }
}
