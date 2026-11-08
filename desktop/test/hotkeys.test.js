const test = require('node:test');
const assert = require('node:assert');
const { validAccelerator, validateHotkeys, DEFAULTS } = require('../src/hotkeys');

test('validAccelerator', () => {
  for (const ok of ['Ctrl+Shift+M', 'Ctrl+Shift+D', 'Alt+F4', 'F13', 'Ctrl+Alt+num5', 'Super+Space', 'Shift+PageUp', 'Ctrl+1']) assert.ok(validAccelerator(ok), ok);
  for (const bad of ['M', '', 'Ctrl+', 'Ctrl+Ctrl+M', 'Ctrl+Shift', 'Hyper+M', 'Ctrl+m', 'Ctrl+M+N', 'Ctrl+Shift+Escape', 'Space', null, 42, 'Ctrl+' + 'A'.repeat(40)]) {
    assert.equal(validAccelerator(bad), false, String(bad));
  }
});

test('validateHotkeys: defaults, off, duplicates, junk', () => {
  assert.deepStrictEqual(validateHotkeys({}).hotkeys, DEFAULTS);
  assert.deepStrictEqual(validateHotkeys({ 'toggle-mute': '', 'toggle-deafen': 'Alt+F9', extra: 'x' }).hotkeys, { 'toggle-mute': '', 'toggle-deafen': 'Alt+F9' });
  assert.match(validateHotkeys({ 'toggle-mute': 'Ctrl+K', 'toggle-deafen': 'Ctrl+K' }).error, /different/);
  assert.ok(validateHotkeys({ 'toggle-mute': '', 'toggle-deafen': '' }).hotkeys); // both off is allowed
  assert.match(validateHotkeys({ 'toggle-mute': 'M' }).error, /not a usable shortcut/);
  assert.ok(validateHotkeys(null).error);
  assert.ok(validateHotkeys('Ctrl+M').error);
});
