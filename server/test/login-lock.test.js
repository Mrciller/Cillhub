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

test('login delay: an account+IP pair waits after a failure (doubling, 60 s cap), other keys do not', () => {
  const pair = 'login:y:1.2.3.4';
  assert.doesNotThrow(() => checkLogin([pair, 'ip:9.9.9.9']));
  loginFailed([pair, 'ip:9.9.9.9']);
  assert.throws(() => checkLogin([pair]), e => e.status === 429 && e.body.retry_after > 0 && e.body.retry_after <= 1);
  assert.doesNotThrow(() => checkLogin(['ip:9.9.9.9']));
  for (let i = 0; i < 7; i++) loginFailed([pair]);
  assert.throws(() => checkLogin([pair]), e => e.body.retry_after > 59 && e.body.retry_after <= 60);
});
