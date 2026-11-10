// selfhost/install.sh writes --hub into .env through an unquoted heredoc: only a plain URL may pass
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const install = (...args) => spawnSync('sh', [new URL('../../selfhost/install.sh', import.meta.url).pathname, ...args, '--yes'], { encoding: 'utf8' });

test('install.sh refuses a --hub that is not a plain URL, before anything else runs', () => {
  for (const hub of ['https://x.org/$(id)', 'https://x.org\nCILLCORD_IMAGE=evil', 'https://x.org/a"b', 'https://x.org/${HOME}']) {
    const r = install('--hub', hub);
    assert.equal(r.status, 1, hub);
    assert.match(r.stderr, /--hub must be a plain URL/, hub);
  }
  // a plain one passes this check (stopped right after the prerequisites by a bad port)
  assert.doesNotMatch(install('--hub', 'https://hub.example.org', '--http-port', 'x').stderr, /--hub must/);
});
