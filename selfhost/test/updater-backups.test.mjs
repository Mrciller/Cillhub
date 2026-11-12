// node --test selfhost/test/updater-backups.test.mjs: old update backups are pruned, the rollback snapshot's folder stays
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pruneBackups } from '../updater.mjs';

test('keeps the newest 3 backups, the one a rollback needs, and anything that is not a backup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cillhub-prune-'));
  const names = ['2026-01-01T00-00-00-000Z-pre-1.0.1', '2026-02-01T00-00-00-000Z-pre-1.0.2', '2026-03-01T00-00-00-000Z-pre-1.1.0',
    '2026-04-01T00-00-00-000Z-pre-1.2.0', '2026-05-01T00-00-00-000Z-pre-1.3.0', 'keep-me'];
  for (const n of names) fs.mkdirSync(path.join(root, 'backups', n), { recursive: true });
  pruneBackups(root, 3, path.join(root, 'backups', names[0], 'cillcord.sqlite'));
  assert.deepEqual(fs.readdirSync(path.join(root, 'backups')).sort(), [names[0], ...names.slice(2)].sort());
  pruneBackups(root, 3, null);
  assert.deepEqual(fs.readdirSync(path.join(root, 'backups')).sort(), [...names.slice(2)].sort());
  fs.rmSync(root, { recursive: true, force: true });
});
