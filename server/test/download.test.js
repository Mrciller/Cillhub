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
  } finally {
    await srv.stop();
  }
});
