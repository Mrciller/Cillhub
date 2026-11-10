#!/usr/bin/env node
// Publishes the signed release APKs into a download folder (served as <hub>/download/):
//   android/Cillhub-<version>.apk (universal) with the stable alias android/Cillhub.apk (the download page links it),
//   android/Cillhub-<version>-<abi>.apk per processor family (the app's updater takes the one for its phone) and
//   android/cillhub.json, the app's update feed (written last), with android/cillhub.json.sig, its detached Ed25519
//   signature by the release key (the selfhost one: RELEASE_KEY, passphrase via PASSIN as in sign-release.sh). The app
//   only accepts a feed signed by a key pinned in UpdateInfo.KEYS, so the key must be the first in
//   selfhost/release-public-key.pem.
// The maintainer decides when to run this. Usage:
//   RELEASE_KEY=/path/to/key.pem [PASSIN=env:VAR|file:/path|pass:x] DOWNLOAD_DIR=/path/to/download node scripts/publish.js [notes]
//     (notes default: android/release-notes.txt)
//   DOWNLOAD_DIR=/path/to/download node scripts/publish.js --bridge  (feed for the old 1.x app, see README; unsigned)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const HERE = path.join(__dirname, '..');
const OUT = path.join(HERE, 'app/build/outputs/apk/release');
// the universal APK (ABI splits are on); app-release.apk is what builds without splits produced
const APK = process.env.APK || [path.join(OUT, 'app-universal-release.apk'), path.join(OUT, 'app-release.apk')].find((f) => fs.existsSync(f)) || path.join(OUT, 'app-universal-release.apk');
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];
const DEST = process.env.DOWNLOAD_DIR;
const PACKAGE = 'io.github.mrciller.cillhub';
// the hub's address has one home, the release build's prodUrl
const ORIGIN = /val prodUrl = "([^"]+)"/.exec(fs.readFileSync(path.join(HERE, 'app/build.gradle.kts'), 'utf8'))[1];
// 1.x apps (old package) poll <OLD_ORIGIN>/download/android.json and only accept APK URLs on their own origin
const OLD_ORIGIN = 'https://jeopardy.cillerian.org';
const SDK = process.env.ANDROID_HOME || '/opt/android-sdk';
const AAPT = path.join(SDK, 'build-tools/36.0.0/aapt2');
const APKSIGNER = path.join(SDK, 'build-tools/36.0.0/apksigner');
const KEY_SHA256 = '8ebd07d6615519b5a42c9d9eb260a02caf048e3ce828fcd1da0cc3f5d4df7063'; // the release key's certificate
const bridge = process.argv[2] === '--bridge';

if (!DEST) throw new Error('set DOWNLOAD_DIR to the folder served as /download/');
if (!fs.existsSync(APK)) throw new Error('no release APK: run ./gradlew assembleRelease first');
if (!bridge && !process.env.RELEASE_KEY) throw new Error('set RELEASE_KEY to the release private key (and PASSIN for its passphrase) to sign the feed');
/** Detached Ed25519 signature of the feed by RELEASE_KEY, checked against the first pinned key before anything is published. */
function signFeed(data) {
  const passin = process.env.PASSIN ?? 'pass:';
  const [, kind, rest] = /^(pass|env|file):(.*)$/s.exec(passin) ?? [];
  if (!kind) throw new Error('PASSIN must be pass:<passphrase>, env:<variable> or file:<path>');
  const passphrase = kind === 'pass' ? rest : kind === 'env' ? process.env[rest] ?? '' : fs.readFileSync(rest, 'utf8').split('\n')[0];
  const key = crypto.createPrivateKey({ key: fs.readFileSync(process.env.RELEASE_KEY), passphrase });
  const pinned = crypto.createPublicKey(fs.readFileSync(path.join(HERE, '../selfhost/release-public-key.pem'), 'utf8').match(/-----BEGIN PUBLIC KEY-----[^-]+-----END PUBLIC KEY-----/)[0]);
  const sig = crypto.sign(null, data, key);
  if (!crypto.verify(null, data, pinned, sig)) throw new Error('RELEASE_KEY is not the first key in selfhost/release-public-key.pem, which the app pins');
  return sig;
}
/** Package, version and signing key of an APK; throws unless it is the release package signed with the release key. */
function check(apk) {
  const badging = execFileSync(AAPT, ['dump', 'badging', apk], { encoding: 'utf8' });
  const m = /package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/.exec(badging);
  if (!m || m[1] !== PACKAGE) throw new Error(`${apk}: not the release package ${PACKAGE} (debug build?)`);
  // installed apps only accept updates signed with the same key
  const certs = execFileSync(APKSIGNER, ['verify', '--print-certs', apk], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  if (!certs.includes(`SHA-256 digest: ${KEY_SHA256}`)) throw new Error(`${apk}: not signed with the Cillhub release key`);
  return { versionCode: m[2], versionName: m[3] };
}
const { versionCode, versionName } = check(APK);
const bytes = fs.readFileSync(APK);
const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
// the per-ABI APKs of the same build (none when APK points elsewhere or splits are off)
const splits = process.env.APK ? [] : ABIS.map((abi) => ({ abi, apk: path.join(OUT, `app-${abi}-release.apk`) })).filter((x) => fs.existsSync(x.apk)).map((x) => {
  const v = check(x.apk);
  if (v.versionCode !== versionCode) throw new Error(`${x.apk}: versionCode ${v.versionCode}, the universal APK has ${versionCode}`);
  const data = fs.readFileSync(x.apk);
  return { ...x, data, sha256: crypto.createHash('sha256').update(data).digest('hex'), file: `Cillhub-${versionName}-${x.abi}.apk` };
});
const file = `Cillhub-${versionName}.apk`;
const put = (name, data) => {
  const full = path.join(DEST, name);
  fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o755 });
  const tmp = path.join(path.dirname(full), `.${path.basename(name)}.tmp`);
  fs.writeFileSync(tmp, data);
  fs.chmodSync(tmp, 0o644);
  fs.renameSync(tmp, full); // atomic: no half-written file is ever served
};
const json = (o) => `${JSON.stringify(o, null, 2)}\n`;

if (bridge) {
  // The old app shows these notes verbatim in its update dialog. Its installer cannot install a different
  // package (it pins its own package name), so the notes carry the instructions; see README "Moving from 1.x".
  if (!fs.existsSync(path.join(DEST, 'android', file))) throw new Error(`publish ${versionName} normally first`);
  const notes = [
    `Cillhub moved to a new app: install it from ${ORIGIN}/download/ , log in, then uninstall this old app.`,
    `Cillhub ist in eine neue App umgezogen: installiere sie von ${ORIGIN}/download/ , melde dich an und deinstalliere danach diese alte App.`,
  ].join('\n\n');
  const feed = { versionCode: Number(versionCode), versionName, url: `${OLD_ORIGIN}/download/android/${encodeURI(file)}`, sha256, notes };
  put('android.json', json(feed));
  console.log(`wrote the 1.x bridge feed to ${DEST}/android.json\n${json(feed)}`);
} else {
  const notesFile = path.join(HERE, 'release-notes.txt');
  const notes = (process.argv[2] ?? (fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '')).trim().slice(0, 2000);
  put(`android/${file}`, bytes);
  put('android/Cillhub.apk', bytes);
  for (const x of splits) put(`android/${x.file}`, x.data);
  const feed = { versionCode: Number(versionCode), versionName, url: `${ORIGIN}/download/android/${encodeURI(file)}`, sha256, notes };
  if (splits.length) feed.abis = Object.fromEntries(splits.map((x) => [x.abi, { url: `${ORIGIN}/download/android/${encodeURI(x.file)}`, sha256: x.sha256 }]));
  const body = json(feed);
  put('android/cillhub.json.sig', signFeed(Buffer.from(body)));
  put('android/cillhub.json', body); // last: apps only see the version once its file and signature are in place
  console.log(`published Android ${versionName} (${versionCode}) to ${DEST}/android\n${json(feed)}`);
}
