import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer } from './helpers.js';

test('Static /download directory and transparent installer delivery', async () => {
  const srv = await startServer();
  try {
    // 1. HEAD /download/desktop/ returns 200 without redirecting external clients
    const headRes = await fetch(`${srv.origin}/download/desktop/Cillhub-Setup-2.1.0.exe`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(headRes.status, 200);
    assert.equal(headRes.headers.get('content-disposition'), 'attachment; filename="Cillhub-Setup-2.1.0.exe"');

    // 2. GET /download/server/install.sh streams the installer with 200 directly from the instance origin
    const shRes = await fetch(`${srv.origin}/download/server/install.sh`, { redirect: 'manual' });
    assert.equal(shRes.status, 200);
    const shText = await shRes.text();
    assert.ok(shText.includes('install.sh') || shText.length > 0);

    // 3. /download/android/Cillhub.apk streams with 200 directly
    const apkRes = await fetch(`${srv.origin}/download/android/Cillhub.apk`, { method: 'HEAD', redirect: 'manual' });
    assert.equal(apkRes.status, 200);
    assert.equal(apkRes.headers.get('content-disposition'), 'attachment; filename="Cillhub.apk"');

    // 4. no file-existence oracle outside the download folders, no 500 on a bad escape (review L-3)
    for (const p of ['/download/server/%2e%2e/%2e%2e/cillcord.sqlite', '/download/server/%']) assert.equal((await fetch(srv.origin + p)).status, 404, p);
  } finally {
    await srv.stop();
  }
});

test('web client pages carry CSP, nosniff and frame protection; HSTS only behind https (audit M3)', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(`${tmpdir()}/cillhub-static-`);
  await writeFile(`${dir}/index.html`, '<!doctype html>');
  await writeFile(`${dir}/offline.html`, '<button onclick="location.reload()">');
  const srv = await startServer({ env: { STATIC_DIR: dir } });
  try {
    const app = await fetch(`${srv.origin}/oauth2/authorize?client_id=1`);
    const csp = app.headers.get('content-security-policy');
    assert.match(csp, /frame-ancestors 'self'/);
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval'/);
    assert.equal(app.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(app.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.equal(app.headers.get('strict-transport-security'), null);
    const offline = await fetch(`${srv.origin}/offline.html`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(offline.headers.get('content-security-policy'), "frame-ancestors 'self'");
    assert.equal(offline.headers.get('strict-transport-security'), 'max-age=31536000');
  } finally {
    await srv.stop();
  }
});

test('the hub download relay forwards only plain names: no double escapes, no quotes in the filename', async () => {
  const { createServer } = await import('node:http');
  const seen = [];
  const hub = createServer((req, res) => { seen.push(req.url); res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); res.end('x'); });
  await new Promise(r => hub.listen(3393, '127.0.0.1', r));
  const srv = await startServer({ env: { CILLCORD_DOWNLOAD_UPSTREAM: 'http://127.0.0.1:3393' } });
  try {
    for (const p of ['/download/desktop/%252e%252e/%252e%252e/secret', '/download/desktop/a%22.exe', '/download/desktop/a%0d%0aX:1.exe']) {
      assert.equal((await fetch(srv.origin + p)).status, 404, p);
    }
    assert.deepEqual(seen.filter(u => u !== '/download/desktop/Cillhub-Setup-9.9.9.exe'), [], 'nothing odd reached the hub');
    const ok = await fetch(`${srv.origin}/download/desktop/Cillhub-Setup-9.9.9.exe`);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('content-disposition'), 'attachment; filename="Cillhub-Setup-9.9.9.exe"');
  } finally {
    await srv.stop();
    hub.close();
  }
});
