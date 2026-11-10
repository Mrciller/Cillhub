import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { createReadStream, openSync, closeSync, rmSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { HttpError } from './errors.js';
import { DATA_DIR } from './db.js';

// archives live in the data folder, never the shared temp folder; whatever a crash left behind is removed at start
const TMP = join(DATA_DIR, 'exports-tmp');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true, mode: 0o700 });
const SEND_DEADLINE = 10 * 60_000; // a download that stalls longer gives its slot back

let active = 0; // archives being built or waiting for their download: each holds a slot until disposed
export class AccountExport {
  constructor(dir, userId) { this.dir = dir; this.userId = userId; }
  async dispose() {
    if (!this.released) { this.released = true; active--; }
    await rm(this.dir, { recursive: true, force: true });
  }
  async send(res, headers) {
    const timer = setTimeout(() => res.destroy(), SEND_DEADLINE);
    try {
      if (res.destroyed) return;
      res.writeHead(200, { ...headers, 'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="cillhub-data-export-${this.userId}.json"`, 'Cache-Control': 'no-store' });
      await pipeline(createReadStream(join(this.dir, 'export.json')), res);
    } finally {
      clearTimeout(timer);
      await this.dispose();
    }
  }
}

// A worker owns the read snapshot and serializes to a private temporary directory. The request thread only streams it.
// Bound concurrent snapshots and their duration, including failures, so WAL readers cannot grow without limit.
export async function exportAccount(dataDir, user, deadline = 60_000) {
  if (active >= 2) throw new HttpError(503, 0, 'Account exports are busy. Try again shortly.');
  active++;
  let dir, fd, done = false;
  try {
    dir = await mkdtemp(join(TMP, 'export-'));
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
    done = true;
    return new AccountExport(dir, user.id); // its dispose() frees the slot
  } catch (error) {
    if (dir) await rm(dir, { recursive: true, force: true });
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (!done) active--;
  }
}
