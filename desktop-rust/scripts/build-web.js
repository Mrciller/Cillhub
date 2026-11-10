// Builds the web client (../client) into web/, the UI the app ships: REST, gateway, CDN, LiveKit and the media proxy are
// on the hub (VITE_API_BASE). VITE_SERVER_VERSION is the server line this client is built for (package.json
// "cillhubServer"); a hub on a newer major.minor shows the update banner (client/src/update.ts).
// CILLCORD_HUB_URL points a fork's build at its own hub; the Rust side reads the same variable (src/config.rs).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pkg = require('../package.json');

const PROD_HUB = 'https://cillhub.cillerian.org';
const client = path.join(__dirname, '..', '..', 'client');
const out = path.join(__dirname, '..', 'web');
const vite = path.join(client, 'node_modules', 'vite', 'bin', 'vite.js');
const targetHub = process.env.CILLCORD_HUB_URL || PROD_HUB;
execFileSync(process.execPath, [vite, 'build', '--outDir', out, '--emptyOutDir'], {
  cwd: client, stdio: 'inherit', env: { ...process.env, VITE_API_BASE: targetHub, VITE_SERVER_VERSION: pkg.cillhubServer },
});
// Website-only files: the service worker and its offline page (the app's UI is local).
for (const f of ['sw.js', 'offline.html']) fs.rmSync(path.join(out, f), { force: true });
if (!fs.readFileSync(path.join(out, 'index.html'), 'utf8').includes('/assets/index-')) throw new Error('web/index.html has no bundle');
console.log(`web/ built for ${targetHub} (server ${pkg.cillhubServer})`);
