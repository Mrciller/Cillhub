const test = require('node:test');
const assert = require('node:assert');
const { parseUnread } = require('../src/unread');
const { deepLinkPath } = require('../src/deeplink');

test('parseUnread', () => {
  assert.equal(parseUnread('(3) Cillhub'), 3);
  assert.equal(parseUnread('(99+) #general'), 99);
  assert.equal(parseUnread('• Cillhub'), -1);
  assert.equal(parseUnread('Cillhub'), 0);
  assert.equal(parseUnread(undefined), 0);
});

test('deepLinkPath', () => {
  assert.equal(deepLinkPath('cillcord://invite/abc-123'), '/invite/abc-123');
  assert.equal(deepLinkPath('cillcord://invite/abc-123/'), '/invite/abc-123');
  assert.equal(deepLinkPath('cillhub://invite/abc-123'), '/invite/abc-123');
  assert.equal(deepLinkPath('CILLHUB://invite/abc-123'), '/invite/abc-123');
  for (const bad of ['cillcord://invite/a', 'cillcord://invite/../../x', 'cillcord://invite/abc?x=1',
    'cillcord://other/abc', 'cillhub://invite/a', 'cillhubx://invite/abc', 'cillcord://invite/' + 'a'.repeat(33), 'https://evil/invite/abc', undefined]) {
    assert.equal(deepLinkPath(bad), null, String(bad));
  }
});

test('findDeepLink', () => {
  const { findDeepLink } = require('../src/deeplink');
  assert.equal(findDeepLink(['app.exe', 'cillhub://invite/abc']), 'cillhub://invite/abc');
  assert.equal(findDeepLink(['app.exe', 'cillcord://invite/abc']), 'cillcord://invite/abc');
  assert.equal(findDeepLink(['app.exe', 'https://x']), undefined);
});

test('permissionAllowed: only listed permissions, only for the app', () => {
  const { permissionAllowed, HUB_URL } = require('../src/config');
  assert.equal(permissionAllowed('media', 'app://cillhub/channels/@me'), true);
  assert.equal(permissionAllowed('media', HUB_URL + '/download/desktop/'), false);
  assert.equal(permissionAllowed('media', 'https://evil-node.example/x'), false);
  assert.equal(permissionAllowed('hid', 'app://cillhub/'), false);
  assert.equal(permissionAllowed('geolocation', 'app://cillhub/'), false);
  assert.equal(permissionAllowed('media', undefined), false);
});

test('update feed: an http: hub never becomes the feed', () => {
  const p = require.resolve('../src/config');
  delete require.cache[p];
  process.env.CILLCORD_HUB_URL = 'http://hub.example';
  try {
    const c = require('../src/config');
    assert.equal(c.HUB_ORIGIN, 'http://hub.example');
    assert.equal(c.UPDATE_URL, c.PROD_FEED);
  } finally {
    delete process.env.CILLCORD_HUB_URL;
    delete require.cache[p];
  }
});
