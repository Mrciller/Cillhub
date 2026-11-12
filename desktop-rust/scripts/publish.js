// Packages and publishes the 100% pure-Rust Cillhub desktop client installers & portable archives to
// <download dir>/desktop/ and updates <download dir>/index.html (served at /download/):
//   DOWNLOAD_DIR=/path/to/download npm run publish      or      node scripts/publish.js /path/to/download
// The updater's installers (setup .exe, .deb) get <file>.sig, an Ed25519 signature with the self-host release key over
// "cillhub-native\n<version>\n<sha512 hex>\n" (rust-client/src/update.rs verifies it). The native app has its own
// feeds, native-latest.yml and native-latest-linux.yml, written last; the old desktop app's latest.yml and
// latest-linux.yml are left alone, and neither app accepts the other's signatures. Env like
// selfhost/scripts/sign-release.sh:
//   RELEASE_KEY  Ed25519 private key (required);  PASSIN  openssl -passin source (else openssl asks on the terminal)
//   PUBLIC_KEY   the pinned key list the app ships (default selfhost/release-public-key.pem)
//   CARGO_TARGET_DIR  where cargo built the binaries (default desktop-rust/target)
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

const PROJECT_DIR = path.join(__dirname, '..');
const { RELEASE_KEY, PASSIN } = process.env;
const PUBLIC_KEY = process.env.PUBLIC_KEY || path.join(PROJECT_DIR, '..', 'selfhost', 'release-public-key.pem');
if (!RELEASE_KEY) {
  console.error('set RELEASE_KEY to the release private key (and PASSIN for its passphrase): updates must be signed');
  process.exit(2);
}
const TARGET = process.env.CARGO_TARGET_DIR || path.join(PROJECT_DIR, 'target');
const DEST = path.join(ROOT, 'desktop');
const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8'));
const version = pkg.version;

const linuxBin = path.join(TARGET, 'release', 'cillhub');
const winBin = path.join(TARGET, 'x86_64-pc-windows-msvc', 'release', 'cillhub.exe');
const winSetup = path.join(TARGET, 'x86_64-pc-windows-msvc', 'release', `Cillhub-Rust-Setup-${version}.exe`);

if (!fs.existsSync(linuxBin)) {
  throw new Error(`missing ${linuxBin}: run "npm run build" first`);
}
if (!fs.existsSync(winBin)) {
  throw new Error(`missing ${winBin}: run "npm run build:windows" first`);
}
if (!fs.existsSync(winSetup)) {
  execFileSync('makensis', [`-DVERSION=${version}`, path.join(PROJECT_DIR, 'installer.nsi')], {
    cwd: PROJECT_DIR,
    stdio: 'inherit',
  });
}

const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-rust-pkg-'));
try {
  // 1. Strip Linux release binary into staging
  const strippedLinux = path.join(stage, 'cillhub-desktop');
  fs.copyFileSync(linuxBin, strippedLinux);
  fs.chmodSync(strippedLinux, 0o755);
  try {
    execFileSync('strip', ['--strip-unneeded', strippedLinux], { stdio: 'ignore' });
  } catch {
    // Keep unstripped binary if strip is unavailable
  }

  // 2. Build Linux portable tarball: Cillhub-Rust-<version>-linux-x64.tar.gz
  const linuxTar = path.join(stage, `Cillhub-Rust-${version}-linux-x64.tar.gz`);
  execFileSync('tar', ['-czf', linuxTar, '-C', stage, 'cillhub-desktop'], { stdio: 'inherit' });

  // 3. Build Debian package: cillhub-desktop-rust_<version>_amd64.deb
  const debRoot = path.join(stage, 'deb');
  const debDebian = path.join(debRoot, 'DEBIAN');
  const debBin = path.join(debRoot, 'usr', 'bin');
  const debApps = path.join(debRoot, 'usr', 'share', 'applications');
  const debIcon128 = path.join(debRoot, 'usr', 'share', 'icons', 'hicolor', '128x128', 'apps');
  const debIcon512 = path.join(debRoot, 'usr', 'share', 'icons', 'hicolor', '512x512', 'apps');
  for (const d of [debDebian, debBin, debApps, debIcon128, debIcon512]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o755 });
  }
  fs.writeFileSync(
    path.join(debDebian, 'control'),
    [
      'Package: cillhub-desktop',
      `Version: ${version}`,
      'Section: net',
      'Priority: optional',
      'Architecture: amd64',
      'Maintainer: Pascal Oraze <Mrciller@users.noreply.github.com>',
      'Description: Fast, lightweight pure-Rust native desktop client & audio DSP engine for Cillhub (Rust Core)',
      '',
    ].join('\n'),
    { mode: 0o644 }
  );
  fs.copyFileSync(strippedLinux, path.join(debBin, 'cillhub-desktop'));
  fs.chmodSync(path.join(debBin, 'cillhub-desktop'), 0o755);
  fs.writeFileSync(
    path.join(debApps, 'cillhub-desktop.desktop'),
    [
      '[Desktop Entry]',
      'Name=Cillhub',
      'Comment=Fast, lightweight pure-Rust native desktop client & audio DSP engine for Cillhub',
      'Exec=/usr/bin/cillhub-desktop %u',
      'Icon=cillhub',
      'Terminal=false',
      'Type=Application',
      'Categories=Network;Chat;InstantMessaging;',
      'MimeType=x-scheme-handler/cillhub;x-scheme-handler/cillcord;',
      '',
    ].join('\n'),
    { mode: 0o644 }
  );
  fs.copyFileSync(path.join(PROJECT_DIR, 'icons', '128x128.png'), path.join(debIcon128, 'cillhub.png'));
  fs.copyFileSync(path.join(PROJECT_DIR, 'icons', 'icon.png'), path.join(debIcon512, 'cillhub.png'));
  const debOut = path.join(stage, `cillhub-desktop-rust_${version}_amd64.deb`);
  execFileSync('dpkg-deb', ['--build', '--root-owner-group', debRoot, debOut], { stdio: 'inherit' });

  // 4. Build Windows portable zip: Cillhub-Rust-<version>-windows-x64.zip (containing Cillhub.exe)
  const winZipDir = path.join(stage, 'win');
  fs.mkdirSync(winZipDir, { recursive: true });
  const stagedWinExe = path.join(winZipDir, 'Cillhub.exe');
  fs.copyFileSync(winBin, stagedWinExe);
  const winZip = path.join(stage, `Cillhub-Rust-${version}-windows-x64.zip`);
  execFileSync('zip', ['-q', '-9', '-j', winZip, stagedWinExe], { stdio: 'inherit' });

  // 5. Sign the updater's installers before anything is published, so a wrong key or passphrase publishes nothing.
  const winFeedFile = `Cillhub-Rust-Setup-${version}.exe`;
  const debFeedFile = `cillhub-desktop-rust_${version}_amd64.deb`;
  const signed = { [winFeedFile]: winSetup, [debFeedFile]: debOut };
  const sha512 = (file, enc) => crypto.createHash('sha512').update(fs.readFileSync(file)).digest(enc);
  const keys = (pem) => (String(pem).match(/-----BEGIN PUBLIC KEY-----[A-Za-z0-9+/=\s]+-----END PUBLIC KEY-----/g) ?? [])
    .map((p) => crypto.createPublicKey(p)).filter((k) => k.asymmetricKeyType === 'ed25519');
  const message = (file) => Buffer.from(`cillhub-native\n${version}\n${sha512(file, 'hex')}\n`);
  const sigs = {};
  for (const [name, from] of Object.entries(signed)) {
    const msg = path.join(stage, 'msg');
    fs.writeFileSync(msg, message(from));
    execFileSync('openssl', ['pkeyutl', '-sign', '-rawin', '-inkey', RELEASE_KEY, ...(PASSIN ? ['-passin', PASSIN] : []), '-in', msg, '-out', path.join(stage, 'sig')], { stdio: 'inherit' });
    const sig = fs.readFileSync(path.join(stage, 'sig'));
    if (!keys(fs.readFileSync(PUBLIC_KEY, 'utf8')).some((k) => crypto.verify(null, message(from), k, sig))) {
      throw new Error(`the signature of ${name} does not verify against ${PUBLIC_KEY}: RELEASE_KEY is not a pinned key`);
    }
    sigs[`${name}.sig`] = sig;
  }
  // electron-builder's feed layout, which src/update.rs reads (version, then url/sha512 per file)
  const releaseDate = new Date().toISOString();
  const entry = (name) => `  - url: ${name}\n    sha512: ${sha512(signed[name], 'base64')}\n    size: ${fs.statSync(signed[name]).size}\n`;
  const feed = (main) => `version: ${version}\nfiles:\n${entry(main)}path: ${main}\nsha512: ${sha512(signed[main], 'base64')}\nreleaseDate: '${releaseDate}'\n`;

  // 6. Atomically publish all pure-Rust artifacts to <ROOT>/desktop/
  for (const d of [ROOT, DEST]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o755 });
    fs.chmodSync(d, 0o755);
  }
  const put = (name, data, dir = DEST) => {
    const tmpFile = path.join(dir, `.${name}.tmp`);
    if (Buffer.isBuffer(data) || typeof data === 'string') fs.writeFileSync(tmpFile, data);
    else fs.copyFileSync(data.from, tmpFile);
    fs.chmodSync(tmpFile, 0o644);
    fs.renameSync(tmpFile, path.join(dir, name));
  };

  const rustArtifacts = {
    [`Cillhub-Rust-Setup-${version}.exe`]: winSetup,
    'Cillhub-Rust-Setup.exe': winSetup,
    'Cillhub-Rust-Setup-2.2.1.exe': winSetup,
    [`Cillhub-Rust-${version}-windows-x64.exe`]: winBin,
    'Cillhub-Rust-2.2.1-windows-x64.exe': winBin,
    [`Cillhub-Rust-${version}-windows-x64.zip`]: winZip,
    'Cillhub-Rust-2.2.1-windows-x64.zip': winZip,
    [`cillhub-desktop-rust_${version}_amd64.deb`]: debOut,
    'cillhub-desktop-rust_2.2.1_amd64.deb': debOut,
    [`Cillhub-Rust-${version}-linux-x64.tar.gz`]: linuxTar,
    'Cillhub-Rust-2.2.1-linux-x64.tar.gz': linuxTar,
  };
  for (const [name, from] of Object.entries(rustArtifacts)) {
    put(name, { from });
  }
  for (const [name, sig] of Object.entries(sigs)) put(name, sig); // before the feeds, like the installers

  // 7. Render and atomically publish download-page/index.html -> <ROOT>/index.html
  const winFile = `Cillhub-Setup-${version}.exe`;
  const appImage = `Cillhub-${version}.AppImage`;
  const deb = `cillhub_${version}_amd64.deb`;
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const date = new Date().toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const vars = {
    HUB: PROD_HUB,
    VERSION: version,
    RELEASE_DATE: date,
    WIN_FILE: encodeURI(winFile),
    APPIMAGE_FILE: encodeURI(appImage),
    DEB_FILE: encodeURI(deb),
  };
  const page = fs
    .readFileSync(path.join(PROJECT_DIR, 'download-page', 'index.html'), 'utf8')
    .replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? esc(vars[k]) : m));
  if (/\{\{\w+\}\}/.test(page)) throw new Error('unfilled template variable in download page');
  put('index.html', page, ROOT);

  // 8. Feeds last, so clients only see a new version once its files are in place.
  put('native-latest.yml', feed(winFeedFile));
  put('native-latest-linux.yml', feed(debFeedFile));

  console.log(`published pure-Rust desktop client ${version} to ${DEST}`);
  for (const f of [...Object.keys(rustArtifacts), ...Object.keys(sigs), 'native-latest.yml', 'native-latest-linux.yml'].sort()) {
    const st = fs.statSync(path.join(DEST, f));
    console.log(`${(st.mode & 0o777).toString(8)} ${String(st.size).padStart(11)}  ${f}`);
  }
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
