import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLogin, loginFailed } from '../src/ratelimit.js';

test('login lock: per-IP keys stop at 10, the account-wide key only at 100', () => {
  const ipKeys = ['login:x:1.2.3.4', 'ip:1.2.3.4'];
  for (let i = 0; i < 10; i++) loginFailed(ipKeys);
  assert.throws(() => checkLogin(ipKeys));
  for (let i = 0; i < 99; i++) loginFailed(['acct:victim']);
  assert.doesNotThrow(() => checkLogin(['acct:victim']));
  loginFailed(['acct:victim']);
  assert.throws(() => checkLogin(['acct:victim']));
});
