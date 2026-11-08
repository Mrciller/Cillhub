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
