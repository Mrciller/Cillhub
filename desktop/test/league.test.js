const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseLockfile, findLockfilePath, queueName } = require('../src/league');

test('parseLockfile: parses valid lockfile and handles invalid content', () => {
  const content = 'LeagueClient:12345:51234:ThIsIsApAsSwOrD:https\n';
  const parsed = parseLockfile(content);
  assert.deepStrictEqual(parsed, {
    procName: 'LeagueClient',
    pid: 12345,
    port: 51234,
    password: 'ThIsIsApAsSwOrD',
    protocol: 'https',
  });

  assert.strictEqual(parseLockfile(''), null);
  assert.strictEqual(parseLockfile('too:few:parts'), null);
  assert.strictEqual(parseLockfile('Proc:pid:notanumber:pass:https'), null);
});

test('queueName: maps standard queue IDs to human-readable names', () => {
  assert.strictEqual(queueName(420), 'Ranked Solo/Duo (5v5)');
  assert.strictEqual(queueName(440), 'Ranked Flex (5v5)');
  assert.strictEqual(queueName(450), 'ARAM');
  assert.strictEqual(queueName(1700), 'Arena (2v2v2v2)');
  assert.strictEqual(queueName(99999), 'Custom / Special Mode');
});

test('findLockfilePath: finds lockfile in install directory from command line', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'league-test-'));
  const lockfile = path.join(dir, 'lockfile');
  fs.writeFileSync(lockfile, 'LeagueClient:99:50000:secret:https');

  const procs = [
    { names: ['LeagueClientUx.exe'], info: `--install-directory="${dir}" --other-flag` }
  ];

  const found = findLockfilePath(procs);
  assert.strictEqual(found, lockfile);

  fs.rmSync(dir, { recursive: true });
});
