import test from 'node:test';
import assert from 'node:assert/strict';
import { checkLogin, loginFailed, loginSucceeded } from '../src/ratelimit.js';

test('login lock: per-IP keys stop at 10, the account-wide key only at 100', () => {
  const ipKeys = ['login:x:1.2.3.4', 'ip:1.2.3.4'];
  for (let i = 0; i < 10; i++) loginFailed(ipKeys);
  assert.throws(() => checkLogin(ipKeys));
  for (let i = 0; i < 99; i++) loginFailed(['acct:victim']);
  assert.doesNotThrow(() => checkLogin(['acct:victim']));
  loginFailed(['acct:victim']);
  assert.throws(() => checkLogin(['acct:victim']));
});

test('login delay: an account+IP pair waits from the 3rd failure in a row (doubling, 60 s cap), other keys do not', () => {
  const pair = 'login:y:1.2.3.4';
  assert.doesNotThrow(() => checkLogin([pair, 'ip:9.9.9.9']));
  loginFailed([pair, 'ip:9.9.9.9']);
  loginFailed([pair]);
  assert.doesNotThrow(() => checkLogin([pair]), 'two failures (a typo and a retry) cost nothing');
  loginFailed([pair]);
  assert.throws(() => checkLogin([pair]), e => e.status === 429 && e.body.retry_after > 0 && e.body.retry_after <= 1);
  assert.doesNotThrow(() => checkLogin(['ip:9.9.9.9']));
  for (let i = 0; i < 6; i++) loginFailed([pair]);
  assert.throws(() => checkLogin([pair]), e => e.body.retry_after > 59 && e.body.retry_after <= 60);
});

test('login delay: a correct password ends the run, the lockout count stays', () => {
  const pair = 'login:z:1.2.3.4';
  for (let i = 0; i < 3; i++) loginFailed([pair]);
  assert.throws(() => checkLogin([pair]));
  loginSucceeded([pair]);
  assert.doesNotThrow(() => checkLogin([pair]));
  loginFailed([pair]); loginFailed([pair]);
  assert.doesNotThrow(() => checkLogin([pair]), 'two new failures after a success are free again');
  for (let i = 0; i < 5; i++) loginFailed([pair]);
  assert.throws(() => checkLogin([pair]), e => e.body.retry_after > 60, 'the 10-per-pair lockout still counts every failure');
});

test('login lock: a parallel burst of wrong passwords from one IP gets no more than 10 tries', async () => {
  const { startServer } = await import('./helpers.js');
  const srv = await startServer();
  try {
    await srv.register('taylor');
    const res = await Promise.all(Array.from({ length: 40 }, () => srv.api('POST', '/auth/login', null, { login: 'taylor', password: 'wrong password' })));
    const tried = res.filter(r => r.status === 401).length;
    assert.ok(tried <= 10, `${tried} guesses got through`);
    assert.equal(tried + res.filter(r => r.status === 429).length, 40);
  } finally {
    await srv.stop();
  }
});
