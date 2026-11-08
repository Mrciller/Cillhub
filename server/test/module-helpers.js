// v8 module tests: archive builders (tar.gz and zip, also malformed ones), an instance admin with 2FA, installing a
// module from an in-memory file map
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { gzipSync, deflateRawSync, crc32 } from 'node:zlib';
import { until } from './helpers.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
export function totp(at = Date.now()) {
  const key = Buffer.from('48656c6c6f21deadbeef48656c6c6f21deadbeef', 'hex'); // = SECRET
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const h = createHmac('sha1', key).update(msg).digest();
  return String((h.readUInt32BE(h[19] & 0xf) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

// an instance admin with 2FA; mfa() hands out one unused backup code per destructive call
export async function makeAdmin(srv, name = 'root') {
  const u = await srv.register(name);
  const on = await srv.api('POST', '/users/@me/mfa/totp/enable', u.token, { password: 'hunter2hunter2', secret: SECRET, code: totp() });
  assert.equal(on.status, 200);
  const codes = on.body.backup_codes.map(c => c.code);
  execFileSync(process.execPath, ['src/admin-cli.js', 'grant', name], { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: srv.dataDir }, stdio: 'ignore' });
  // a 5-minute elevation (X-Cillhub-MFA-Authorization) for the helpers; mfa() still hands out single backup codes
  const ticket = (await srv.api('POST', '/users/@me/mfa/totp/disable', u.token, {})).body.mfa.ticket;
  const { token } = (await srv.api('POST', '/mfa/finish', u.token, { ticket, mfa_type: 'backup', data: codes.shift() })).body;
  return { ...u, mfa: () => codes.shift(), elevated: { 'X-Cillhub-MFA-Authorization': token } };
}

// --- archives ----------------------------------------------------------------------------------------------------
function tarHeader(name, size, type = '0', link = '') {
  const h = Buffer.alloc(512);
  h.write(name, 0, 100, 'latin1');
  h.write('0000644\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write(link, 157, 100, 'latin1');
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
// entries: {path: string | Buffer} or [[path, data, type?, link?]]
export function tgz(entries) {
  const list = Array.isArray(entries) ? entries : Object.entries(entries);
  const parts = [];
  for (const [name, data = '', type = '0', link = ''] of list) {
    const b = Buffer.from(data);
    parts.push(tarHeader(name, type === '0' ? b.length : 0, type, link));
    if (type === '0') parts.push(b, Buffer.alloc((512 - (b.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

// entries as for tgz; options per entry: {mode (unix), declared (uncompressed size to claim), stored}
export function zip(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : Object.entries(entries);
  const locals = [], centrals = [];
  let offset = 0;
  for (const [name, data = '', o = {}] of list) {
    const raw = Buffer.from(data);
    const comp = o.stored ? raw : deflateRawSync(raw);
    const n = Buffer.from(name);
    const usize = o.declared ?? raw.length;
    const l = Buffer.alloc(30);
    l.writeUInt32LE(0x04034b50, 0); l.writeUInt16LE(20, 4); l.writeUInt16LE(o.stored ? 0 : 8, 8);
    l.writeUInt32LE(crc32(raw), 14); l.writeUInt32LE(comp.length, 18); l.writeUInt32LE(usize, 22); l.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE((3 << 8) | 20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(o.stored ? 0 : 8, 10);
    c.writeUInt32LE(crc32(raw), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(usize, 24); c.writeUInt16LE(n.length, 28);
    c.writeUInt32LE(((o.mode ?? 0o100644) << 16) >>> 0, 38); c.writeUInt32LE(offset, 42);
    locals.push(l, n, comp);
    centrals.push(c, n);
    offset += 30 + n.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const e = Buffer.alloc(22);
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(list.length, 8); e.writeUInt16LE(list.length, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, e, ...(opts.trailer ? [opts.trailer] : [])]);
}

// a module package: manifest fields plus files
export const pkg = (manifest, files = {}) => ({
  'cillhub-module.json': JSON.stringify({ manifest_version: 1, name: manifest.id, version: '1.0.0', permissions: [], ...manifest }),
  ...files,
});

export async function stage(srv, admin, files, moduleId) {
  const form = new Map(moduleId ? [['module_id', moduleId]] : []);
  return srv.form('POST', '/admin/modules/packages', admin.token, form, [['file', 'module.tgz', tgz(files), 'application/gzip']]);
}

// stage, approve exactly, optionally enable and wait until running
export async function install(srv, admin, files, { enable = true, patch = {} } = {}) {
  const s = await stage(srv, admin, files);
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const m = await srv.api('POST', '/admin/modules', admin.token, { package_id: s.body.package_id, approve: { permissions: s.body.permissions, http_hosts: s.body.http_hosts } }, admin.elevated);
  assert.equal(m.status, 201, JSON.stringify(m.body));
  if (enable || Object.keys(patch).length) {
    const p = await srv.api('PATCH', `/admin/modules/${m.body.id}`, admin.token, { ...patch, ...(enable && { enabled: true }) });
    assert.equal(p.status, 200, JSON.stringify(p.body));
  }
  if (enable) await running(srv, admin, m.body.id);
  return (await srv.api('GET', `/admin/modules/${m.body.id}`, admin.token)).body;
}

export const running = (srv, admin, id, status = 'running') => until(async () => (await srv.api('GET', `/admin/modules/${id}`, admin.token)).body.status === status, 8000);
export const logsOf = async (srv, admin, id) => (await srv.api('GET', `/admin/modules/${id}/logs?limit=500`, admin.token)).body;
export const logged = (srv, admin, id, re, level) => until(async () => (await logsOf(srv, admin, id)).find(l => re.test(l.message) && (!level || l.level === level)), 8000);

// --- a local smart-HTTP Git server (git http-backend as CGI) and repositories for it ---------------------------------
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const gitEnv = home => ({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' });
export const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd, env: gitEnv(cwd), encoding: 'utf8' }).trim();

// a bare repository root/<name>.git whose main branch holds files; returns a commit(files) for later versions
export function gitRepo(root, name, files) {
  const bare = join(root, `${name}.git`), work = join(root, `${name}-work`);
  mkdirSync(work, { recursive: true });
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  git(work, 'init', '-q', '-b', 'main');
  const commit = f => {
    for (const [p, d] of Object.entries(f)) { mkdirSync(join(work, p, '..'), { recursive: true }); writeFileSync(join(work, p), d); }
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'version');
    git(work, 'push', '-q', bare, 'main');
    return git(work, 'rev-parse', 'HEAD');
  };
  return { first: commit(files), commit, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

export async function gitServer(root) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    const u = new URL(req.url, 'http://x');
    const env = {
      ...gitEnv(root), GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_ADDR: '127.0.0.1', ...(req.headers['content-encoding'] && { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] }),
      ...(req.headers['git-protocol'] && { GIT_PROTOCOL: req.headers['git-protocol'] }),
    };
    const p = spawn('git', ['http-backend'], { env });
    req.pipe(p.stdin);
    let head = Buffer.alloc(0), started = false;
    p.stdout.on('data', chunk => {
      if (started) return res.write(chunk);
      head = Buffer.concat([head, chunk]);
      const i = head.indexOf('\r\n\r\n');
      if (i < 0) return;
      started = true;
      let status = 200;
      const h = {};
      for (const line of head.subarray(0, i).toString().split('\r\n')) {
        const c = line.indexOf(':');
        if (line.slice(0, c).toLowerCase() === 'status') status = parseInt(line.slice(c + 1));
        else h[line.slice(0, c)] = line.slice(c + 1).trim();
      }
      res.writeHead(status, h);
      res.write(head.subarray(i + 4));
    });
    p.stdout.on('end', () => (started ? res.end() : res.writeHead(500).end()));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, requests, close: () => new Promise(r => server.close(r)) };
}
