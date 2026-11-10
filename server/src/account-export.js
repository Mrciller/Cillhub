import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './errors.js';

let active = 0;
export class AccountExport {
  constructor(dir, userId) { this.dir = dir; this.userId = userId; }
  async dispose() { await rm(this.dir, { recursive: true, force: true }); }
  async send(res, headers) {
    try {
      if (res.destroyed) return;
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="cillhub-data-export-${this.userId}.json"`, 'Cache-Control': 'no-store' });
      await pipeline(createReadStream(join(this.dir, 'export.json')), res);
    } finally { await this.dispose(); }
  }
}

// A worker owns the read snapshot and serializes to a private temporary directory. The request thread only streams it.
// Bound concurrent snapshots and their duration, including failures, so WAL readers cannot grow without limit.
export async function exportAccount(dataDir, user, deadline = 60_000) {
  if (active >= 2) throw new HttpError(503, 0, 'Account exports are busy. Try again shortly.');
  active++;
  let dir, fd;
  try {
    dir = await mkdtemp(join(tmpdir(), 'cillhub-export-'));
    fd = openSync(join(dir, 'export.json'), 'wx', 0o600);
    const worker = new Worker(new URL('./account-export-worker.js', import.meta.url), {
      workerData: { dbPath: resolve(dataDir, 'cillcord.sqlite'), fd, user },
      execArgv: [],
    });
    await new Promise((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; worker.terminate(); }, deadline);
      worker.once('error', reject);
      worker.once('exit', code => {
        clearTimeout(timer);
        if (timedOut) reject(new HttpError(503, 0, 'Account export timed out.'));
        else code === 0 ? resolve() : reject(new Error(`Account export worker exited with ${code}`));
      });
    });
    return new AccountExport(dir, user.id);
  } catch (error) {
    if (dir) await rm(dir, { recursive: true, force: true });
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    active--;
  }
}
