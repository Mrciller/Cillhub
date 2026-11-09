// Streaming multipart/form-data parser: file parts go straight to temp files on disk, so an upload is never held in
// memory. Each file stores at most maxFile bytes; the rest is counted (size) but discarded, so the route's own size
// check answers as before while nothing over the limit is written. Text fields are kept in memory (maxFields in total).
import { createWriteStream, mkdirSync, rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { once } from 'node:events';
import { join } from 'node:path';
import { DATA_DIR } from './db.js';
import { HttpError } from './errors.js';

// same file system as the attachments, so a stored upload is a rename; leftovers of a crash are removed at start
const TMP = join(DATA_DIR, 'uploads-tmp');
rmSync(TMP, { recursive: true, force: true });
mkdirSync(TMP, { recursive: true });

const CRLF2 = Buffer.from('\r\n\r\n');
const MAX_HEADERS = 16 * 1024;
const MAX_PARTS = 200;
const tooLarge = () => new HttpError(413, 0, 'Request entity too large');
const bad = () => new HttpError(400, 0, 'The request body is not valid multipart/form-data.');

/** A stored file part: size counts every byte sent, path holds at most maxFile of them. */
class Upload {
  constructor(name, type, path) { Object.assign(this, { name, type, path, size: 0, written: 0 }); }
  bytes() { return readFile(this.path); }
}

/** The parsed form: [name, string | Upload] entries in order, like FormData. */
class Form {
  constructor(entries) { this.entries = entries; }
  get(name) { return this.entries.find(([k]) => k === name)?.[1] ?? null; }
  [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
}

const param = (headers, key) => new RegExp(`(?:^|;)\\s*${key}="([^"]*)"`, 'i').exec(headers)?.[1];

/**
 * Reads req as multipart/form-data. Returns {form, cleanup}; cleanup() removes the temp files that were not moved away.
 * Over maxTotal bytes or maxFields of text (part headers included): 413 at once. More than maxFiles file parts or
 * MAX_PARTS parts: 400.
 */
export async function parseMultipart(req, { maxTotal, maxFile, maxFields = 1024 * 1024, maxFiles = 20 }) {
  const m = /;\s*boundary=(?:"([^"]{1,70})"|([^\s;"]{1,70}))/i.exec(req.headers['content-type'] ?? '');
  if (!m) throw bad();
  const delim = Buffer.from(`\r\n--${m[1] ?? m[2]}`);
  const dir = await mkdtemp(join(TMP, 'up-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const entries = [];
  let buf = Buffer.from('\r\n'); // the first boundary then looks like every other one
  let state = 'preamble'; // preamble | after (a boundary) | headers | body | done
  let part = null;
  let total = 0, fieldBytes = 0, files = 0, parts = 0;

  async function data(chunk) {
    if (!chunk.length) return;
    if (part.chunks) {
      fieldBytes += chunk.length;
      if (fieldBytes > maxFields) throw tooLarge();
      part.chunks.push(chunk);
      return;
    }
    const f = part.file;
    f.size += chunk.length;
    const keep = chunk.subarray(0, Math.max(0, maxFile - f.written));
    if (!keep.length) return;
    f.written += keep.length;
    if (!part.out.write(keep)) await once(part.out, 'drain');
  }

  async function endPart() {
    if (part.chunks) entries.push([part.name, Buffer.concat(part.chunks).toString('utf8')]);
    else {
      part.out.end();
      await once(part.out, 'finish');
      entries.push([part.name, part.file]);
    }
    part = null;
  }

  function startPart(headers) {
    // part names and filenames stay in memory too, so their headers count against maxFields
    if ((fieldBytes += headers.length) > maxFields) throw tooLarge();
    if (++parts > MAX_PARTS) throw new HttpError(400, 0, `At most ${MAX_PARTS} form parts.`);
    const disposition = /^content-disposition:(.*)$/im.exec(headers)?.[1] ?? '';
    const name = param(disposition, 'name');
    if (name === undefined) throw bad();
    const filename = param(disposition, 'filename');
    if (filename === undefined) return void (part = { name, chunks: [] });
    if (++files > maxFiles) throw new HttpError(400, 0, `At most ${maxFiles} files.`);
    const type = /^content-type:\s*([^\r\n;]*)/im.exec(headers)?.[1].trim() ?? '';
    const file = new Upload(filename, type, join(dir, String(files)));
    part = { name, file, out: createWriteStream(file.path) };
  }

  // consumes as much of buf as can be decided now
  async function consume() {
    for (;;) {
      if (state === 'done') return void (buf = Buffer.alloc(0)); // epilogue
      if (state === 'preamble' || state === 'body') {
        const i = buf.indexOf(delim);
        if (i < 0) {
          const cut = Math.max(0, buf.length - (delim.length - 1)); // a boundary may start in the kept tail
          if (state === 'body') await data(buf.subarray(0, cut));
          buf = buf.subarray(cut);
          return;
        }
        if (state === 'body') (await data(buf.subarray(0, i)), await endPart());
        buf = buf.subarray(i + delim.length);
        state = 'after';
      } else if (state === 'after') {
        if (buf.length < 2) return;
        if (buf[0] === 0x2d && buf[1] === 0x2d) state = 'done';
        else if (buf[0] === 0x0d && buf[1] === 0x0a) (buf = buf.subarray(2), (state = 'headers'));
        else throw bad();
      } else {
        const i = buf.indexOf(CRLF2);
        if (i < 0) {
          if (buf.length > MAX_HEADERS) throw bad();
          return;
        }
        startPart(buf.subarray(0, i).toString('utf8'));
        buf = buf.subarray(i + 4);
        state = 'body';
      }
    }
  }

  try {
    for await (const chunk of req) {
      total += chunk.length;
      if (total > maxTotal) throw tooLarge();
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      await consume();
    }
    if (state !== 'done') throw bad();
  } catch (e) {
    part?.out?.destroy();
    await cleanup();
    throw e;
  }
  return { form: new Form(entries), cleanup };
}
