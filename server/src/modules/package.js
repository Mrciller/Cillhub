// Module packages (CONTRACT-v8 §1, §2.1, §2.2): .zip and .tgz unpacked in memory with every limit enforced while
// unpacking, and Git sources cloned by the git CLI under strict rules. The result is always a Map path -> Buffer.
import { gunzipSync, inflateRawSync, crc32 } from 'node:zlib';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readdir, lstat, readFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { invalid } from '../errors.js';
import { vet, ENV_ALLOW, FetchRefused } from '../ssrf.js';

const MIB = 1024 * 1024;
export const LIMITS = { archive: 5 * MIB, total: 20 * MIB, files: 500, file: 5 * MIB, path: 200 };
const PATH = /^[A-Za-z0-9._/@+-]+$/;
const TEXT = /\.(js|mjs|json|html|css|txt|svg|md)$/i;

export const pkgInvalid = msg => invalid('file', 'MODULE_PACKAGE_INVALID', msg);
export const tooLarge = msg => invalid('file', 'MODULE_PACKAGE_TOO_LARGE', msg);
const gitRefused = msg => invalid('git_url', 'MODULE_GIT_REFUSED', msg);
const gitFailed = msg => invalid('git_url', 'MODULE_GIT_FAILED', msg);

// a package path by the §1 rules; archives made with `tar -C dir .` name entries ./x, which is accepted
export function cleanPath(raw) {
  const p = raw.replace(/^(\.\/)+/, '');
  if (p.length > LIMITS.path || !PATH.test(p) || p.includes('..') || p.startsWith('/') || p.split('/').some(s => !s || s === '.')) throw pkgInvalid(`Path not allowed: ${raw.slice(0, 100)}`);
  return p;
}

// collects the files of one package, enforcing count and sizes as they arrive
class Collector {
  files = new Map();
  total = 0;
  add(rawName, data) {
    const name = cleanPath(rawName);
    if (name.split('/').includes('.git')) return; // a .git folder is ignored
    if (this.files.has(name)) throw pkgInvalid(`Duplicate path: ${name}`);
    if (this.files.size >= LIMITS.files) throw tooLarge(`More than ${LIMITS.files} files.`);
    if (data.length > LIMITS.file) throw tooLarge(`${name} is larger than 5 MiB.`);
    this.total += data.length;
    if (this.total > LIMITS.total) throw tooLarge('The package is larger than 20 MiB unpacked.');
    if (TEXT.test(name)) {
      try { new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { throw pkgInvalid(`${name} is not UTF-8.`); }
    }
    this.files.set(name, data);
  }
  // the manifest at the root, or in the single top-level folder (then that folder is stripped)
  result() {
    if (this.files.has('cillhub-module.json')) return this.files;
    const tops = new Set([...this.files.keys()].map(p => p.split('/')[0]));
    const [top] = tops;
    if (tops.size === 1 && this.files.has(`${top}/cillhub-module.json`)) {
      return new Map([...this.files].map(([p, d]) => [p.slice(top.length + 1), d]));
    }
    return this.files;
  }
}

// --- tar (ustar, pax and GNU long names) --------------------------------------------------------------------------
const field = (h, off, len) => h.subarray(off, off + len).toString('latin1').replace(/\0.*$/s, '');
const octal = (h, off, len) => {
  const s = field(h, off, len).trim();
  if (!/^[0-7]*$/.test(s)) throw pkgInvalid('Corrupt tar header.');
  return s ? parseInt(s, 8) : 0;
};

function untar(buf, out) {
  let off = 0, longName = null, paxPath = null, paxSize = null;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every(b => b === 0)) break; // end of archive
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    if (sum !== octal(h, 148, 8)) throw pkgInvalid('Corrupt tar header (checksum).');
    const type = String.fromCharCode(h[156] || 48);
    const size = paxSize ?? octal(h, 124, 12);
    const start = off + 512;
    if (start + size > buf.length) throw pkgInvalid('Truncated tar archive.');
    const data = buf.subarray(start, start + size);
    off = start + Math.ceil(size / 512) * 512;
    const prefix = field(h, 345, 155);
    const name = longName ?? paxPath ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    if (type === 'L') { longName = data.toString('utf8').replace(/\0.*$/s, ''); continue; }
    if (type === 'x') {
      ({ path: paxPath = null, size: paxSize = null } = pax(data));
      continue;
    }
    longName = paxPath = paxSize = null;
    if (type === 'g') continue; // global pax header (git archive writes the commit id there)
    if (type === '5') { if (name.replace(/^(\.\/)+/, '').replace(/\/$/, '')) cleanPath(name.replace(/\/$/, '')); continue; }
    if (type === '1' || type === '2') throw pkgInvalid(`Links are not allowed: ${name.slice(0, 100)}`);
    if (type !== '0' && type !== '7') throw pkgInvalid(`Only regular files and folders are allowed: ${name.slice(0, 100)}`);
    out.add(name, Buffer.from(data));
  }
}

// pax records "<len> key=value\n"; only path and size matter here
function pax(data) {
  const out = {};
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const len = Number(data.subarray(i, sp).toString());
    if (sp < 0 || !Number.isInteger(len) || len <= 0 || i + len > data.length) throw pkgInvalid('Corrupt pax header.');
    const rec = data.subarray(sp + 1, i + len - 1).toString('utf8');
    const eq = rec.indexOf('=');
    const [k, v] = [rec.slice(0, eq), rec.slice(eq + 1)];
    if (k === 'path') out.path = v;
    if (k === 'size') { out.size = Number(v); if (!Number.isSafeInteger(out.size) || out.size < 0) throw pkgInvalid('Corrupt pax size.'); }
    if (k === 'linkpath') throw pkgInvalid('Links are not allowed.');
    i += len;
  }
  return out;
}

// --- zip (central directory, stored and deflate, no zip64, no encryption) ---------------------------------------------
function unzip(buf, out) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw pkgInvalid('Corrupt zip archive (no end of central directory).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw pkgInvalid('ZIP64 archives are not supported.');
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw pkgInvalid('Corrupt zip central directory.');
    const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt8(p + 5), attrs = buf.readUInt32LE(p + 38), local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    p += 46 + nlen + xlen + clen;
    const mode = attrs >>> 16;
    const kind = mode & 0o170000;
    // unix-made entries say what they are; links, devices, fifos and sockets are refused
    if ((madeBy === 3 || madeBy === 19) && kind && kind !== 0o100000 && kind !== 0o040000) throw pkgInvalid(`Only regular files and folders are allowed: ${name.slice(0, 100)}`);
    if (name.endsWith('/')) { if (name.replace(/^(\.\/)+/, '') !== '') cleanPath(name.slice(0, -1)); continue; }
    if (flags & 1) throw pkgInvalid('Encrypted zip entries are not supported.');
    if (usize > LIMITS.file) throw tooLarge(`${name.slice(0, 100)} is larger than 5 MiB.`);
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw pkgInvalid('Corrupt zip local header.');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    if (start + csize > buf.length) throw pkgInvalid('Truncated zip archive.');
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) {
      // the declared size bounds the output: a zip bomb stops at usize + 1 bytes
      try { data = inflateRawSync(raw, { maxOutputLength: usize + 1 }); } catch { throw pkgInvalid(`Corrupt or oversized zip entry: ${name.slice(0, 100)}`); }
    } else throw pkgInvalid(`Unsupported zip compression method ${method}.`);
    if (data.length !== usize || crc32(data) !== crc) throw pkgInvalid(`Corrupt zip entry: ${name.slice(0, 100)}`);
    out.add(name, Buffer.from(data));
  }
}

// an uploaded archive (format from its bytes) -> Map path -> Buffer
export function unpack(buf) {
  if (buf.length > LIMITS.archive) throw tooLarge('The archive is larger than 5 MiB.');
  const out = new Collector();
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) unzip(buf, out);
  else if (buf.length >= 22 && buf.readUInt32LE(0) === 0x06054b50) unzip(buf, out);
  else if (buf[0] === 0x1f && buf[1] === 0x8b) {
    let tar;
    // tar adds a 512-byte header per file plus padding to the 20 MiB of content
    try { tar = gunzipSync(buf, { maxOutputLength: LIMITS.total + 1024 * (LIMITS.files + 2) }); } catch (e) {
      throw e?.code === 'ERR_BUFFER_TOO_LARGE' ? tooLarge('The package is larger than 20 MiB unpacked.') : pkgInvalid('Corrupt gzip data.');
    }
    untar(tar, out);
  } else throw pkgInvalid('Not a .zip, .tgz or .tar.gz archive.');
  return out.result();
}

// --- Git -------------------------------------------------------------------------------------------------------
const GIT_TIMEOUT = 60_000;

// §2.2 URL rules; the test-only CILLCORD_UNFURL_ALLOW hatch (exact vetted ip:port) also admits http:// and IP literals/ports
export async function checkGitUrl(gitUrl, gitRef) {
  if (typeof gitUrl !== 'string' || gitUrl.length > 300) throw gitRefused('The Git URL must be at most 300 characters.');
  if (gitRef != null && (typeof gitRef !== 'string' || !/^[A-Za-z0-9._/-]{1,100}$/.test(gitRef) || gitRef.includes('..') || gitRef.startsWith('-'))) {
    throw invalid('git_ref', 'MODULE_GIT_REFUSED', 'The branch or tag must be 1-100 of A-Z a-z 0-9 . _ / - without "..".');
  }
  let url;
  try { url = new URL(gitUrl); } catch { throw gitRefused('Not a URL.'); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw gitRefused('Only https:// Git URLs are allowed.');
  if (url.username || url.password) throw gitRefused('The Git URL must not contain a user name or password.');
  let target;
  try { target = await vet(url); } catch (e) { throw gitRefused(e instanceof FetchRefused ? `The host is not allowed (${e.message}).` : 'The host could not be resolved.'); }
  const hatch = ENV_ALLOW.has(`${target.address}:${target.port}`);
  if (!hatch) {
    if (url.protocol !== 'https:') throw gitRefused('Only https:// Git URLs are allowed.');
    if (isIP(url.hostname.replace(/^\[|\]$/g, ''))) throw gitRefused('The Git URL must use a host name, not an IP address.');
    if (target.port !== 443) throw gitRefused('The Git URL must use port 443.');
  }
  return { url, target };
}

// only PATH from the server's environment; no system or user configuration, no prompts, no proxies
const gitEnv = home => ({ PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });

function runGit(args, { env, timeout = GIT_TIMEOUT, watch } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn('git', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', killed = null;
    p.stdout.on('data', d => { if (out.length < 4 * MIB) out += d; });
    p.stderr.on('data', d => { if (err.length < 64 * 1024) err += d; });
    const kill = why => { killed ??= why; p.kill('SIGKILL'); };
    const timer = setTimeout(() => kill('timed out after 60 seconds'), timeout);
    const poll = watch && setInterval(async () => { if (await watch()) kill('the repository is larger than 20 MiB'); }, 250);
    p.on('error', e => { clearTimeout(timer); clearInterval(poll); reject(gitFailed(`git could not be started (${e.code}).`)); });
    p.on('close', code => {
      clearTimeout(timer);
      clearInterval(poll);
      if (killed) reject(gitFailed(`The clone was stopped: ${killed}.`));
      else if (code !== 0) reject(gitFailed(`git failed: ${err.trim().split('\n').pop()?.slice(0, 300) ?? `exit ${code}`}`));
      else resolve(out);
    });
  });
}

async function dirSize(dir) {
  let n = 0;
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (e.isFile()) n += (await lstat(join(e.parentPath, e.name)).catch(() => ({ size: 0 }))).size;
  }
  return n;
}

// shallow clone of one branch or tag, pinned to the vetted address; returns {files, commit}
export async function fetchGit(gitUrl, gitRef) {
  const { url, target } = await checkGitUrl(gitUrl, gitRef);
  const tmp = await mkdtemp(join(tmpdir(), 'cillhub-git-'));
  try {
    const dir = join(tmp, 'repo'), template = join(tmp, 'template'), home = join(tmp, 'home');
    await mkdir(template);
    await mkdir(home);
    const env = gitEnv(home);
    const port = target.port;
    const ip = target.family === 6 ? `[${target.address}]` : target.address;
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const config = [
      `http.curloptResolve=${host}:${port}:${ip}`, 'protocol.allow=never', `protocol.${url.protocol.slice(0, -1)}.allow=always`,
      'http.followRedirects=false', 'core.hooksPath=/dev/null', 'credential.helper=', 'core.symlinks=false', 'http.proxy=',
      'submodule.recurse=false', 'core.fsmonitor=false',
    ].flatMap(c => ['-c', c]);
    await runGit([...config, 'clone', '--depth', '1', '--single-branch', '--no-tags', '--no-recurse-submodules',
      ...(gitRef ? ['--branch', gitRef] : []), `--template=${template}`, '--', url.href, dir], { env, watch: async () => await dirSize(tmp) > LIMITS.total });
    const safe = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-C', dir];
    const commit = (await runGit([...safe, 'rev-parse', 'HEAD'], { env })).trim();
    // core.symlinks=false checks links out as plain files, so the tree itself says what is a link
    for (const line of (await runGit([...safe, 'ls-tree', '-r', '--full-tree', 'HEAD'], { env })).split('\n')) {
      if (line.startsWith('120000 ')) throw pkgInvalid(`Links are not allowed: ${line.split('\t')[1]?.slice(0, 100)}`);
    }
    await rm(join(dir, '.git'), { recursive: true, force: true });
    const out = new Collector();
    for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
      const full = join(e.parentPath, e.name);
      const rel = full.slice(dir.length + 1);
      if (e.isDirectory()) continue;
      if (!e.isFile()) throw pkgInvalid(`Only regular files and folders are allowed: ${rel.slice(0, 100)}`);
      if ((await lstat(full)).size > LIMITS.file) throw tooLarge(`${rel.slice(0, 100)} is larger than 5 MiB.`);
      out.add(rel, await readFile(full));
    }
    return { files: out.result(), commit: /^[0-9a-f]{40,64}$/.test(commit) ? commit : null };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}
