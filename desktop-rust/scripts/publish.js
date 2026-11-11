// Packages and publishes the 100% pure-Rust Cillhub desktop client installers & portable archives to
// <download dir>/desktop/ and updates <download dir>/index.html (served at /download/):
//   DOWNLOAD_DIR=/path/to/download npm run publish      or      node scripts/publish.js /path/to/download
// Older versions and existing signed feeds (latest.yml, latest-linux.yml) are preserved.
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
const DEST = path.join(ROOT, 'desktop');
const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_DIR, 'package.json'), 'utf8'));
const version = pkg.version;

const linuxBin = path.join(PROJECT_DIR, 'target', 'release', 'cillhub');
const winBin = path.join(PROJECT_DIR, 'target', 'x86_64-pc-windows-msvc', 'release', 'cillhub.exe');
const winSetup = path.join(PROJECT_DIR, 'target', 'x86_64-pc-windows-msvc', 'release', `Cillhub-Rust-Setup-${version}.exe`);

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

  // 5. Atomically publish all pure-Rust artifacts to <ROOT>/desktop/
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

  // 6. Render and atomically publish download-page/index.html -> <ROOT>/index.html
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

  console.log(`published pure-Rust desktop client ${version} to ${DEST}`);
  for (const f of Object.keys(rustArtifacts).sort()) {
    const st = fs.statSync(path.join(DEST, f));
    console.log(`${(st.mode & 0o777).toString(8)} ${String(st.size).padStart(11)}  ${f}`);
  }
} finally {
  fs.rmSync(stage, { recursive: true, force: true });
}
