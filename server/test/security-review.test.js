// Exercises production handlers, migrations, the limiter and export worker without listening sockets.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Writable } from 'node:stream';
import { authenticator } from './authenticator.js';

const dir = mkdtempSync(join(tmpdir(), 'cillhub-security-test-'));
process.env.DATA_DIR = dir;
process.env.CILLCORD_RATE_LIMIT_SCALE = '1';
const { db, run, get, tx, userById, userObj } = await import('../src/db.js');
const account = await import('../src/routes/account.js');
const connections = (await import('../src/routes/connections.js')).default;
const passkeys = (await import('../src/routes/webauthn.js')).default;
const { compileRoute } = await import('../src/route-policy.js');
const { limit } = await import('../src/ratelimit.js');
const { hashPassword } = await import('../src/auth.js');
const { PRIVATE_DATA } = await import('../src/account-data.js');
const { exportAccount } = await import('../src/account-export.js');
const { stopTimers } = await import('../src/timers.js');
const password = await hashPassword('review-password');
const addUser = id => run('INSERT INTO users (id, email, username, password_hash, salt) VALUES (?, ?, ?, ?, ?)', id, `${id}@example.invalid`, `review${id}`, password.hash, password.salt);
const invoke = (routes, method, path, ctx) => routes.find(r => r[0] === method && r[1] === path)[2](ctx);
after(() => { stopTimers(); db.close(); rmSync(dir, { recursive: true, force: true }); });

test('connections are unverified even when a client submits verified=true', () => {
  addUser('101');
  const ctx = { user: userById('101'), body: { type: 'github', name: 'taylor', verified: true }, headers: {} };
  const result = invoke(connections, 'POST', '/users/@me/connections', ctx);
  assert.equal(result.verified, false);
  const updated = invoke(connections, 'PATCH', '/users/@me/connections/:id', { ...ctx, params: { id: result.id }, body: { verified: true, metadata: { verified: true } } });
  assert.equal(updated.verified, false);
  assert.equal(invoke(connections, 'GET', '/users/@me/connections', ctx)[0].verified, false);
});

test('migration removes false badges, changes the default, and cleans already deleted accounts', () => {
  const old = new DatabaseSync(':memory:');
  try {
    old.exec('PRAGMA foreign_keys = ON');
    const migrations = new URL('../src/migrations/', import.meta.url);
    for (const name of readdirSync(migrations).sort().filter(n => n.endsWith('.sql') && n < '020')) old.exec(readFileSync(new URL(name, migrations), 'utf8'));
    old.exec(`INSERT INTO users (id,email,username,password_hash,salt) VALUES ('a','a@x','a','x','x'),('b','b@x','b','x','x');
      UPDATE users SET deleted=1, calendar_token='secret', hub_user_id='hub-id' WHERE id='b';
      INSERT INTO user_connections (id,user_id,type,name,created_at) VALUES ('a','a','github','someone','now'),('b','b','github','private','now');
      INSERT INTO saved_message_folders (id,user_id,name,created_at) VALUES ('b','b','private','now');`);
    old.exec(readFileSync(new URL('020-account-security.sql', migrations), 'utf8'));
    assert.equal(old.prepare("SELECT verified FROM user_connections WHERE id='a'").get().verified, 0);
    assert.equal(old.prepare("SELECT COUNT(*) AS n FROM user_connections WHERE user_id='b'").get().n, 0);
    assert.equal(old.prepare('SELECT COUNT(*) AS n FROM saved_message_folders').get().n, 0);
    assert.equal(old.prepare("SELECT calendar_token FROM users WHERE id='b'").get().calendar_token, null);
    old.exec("INSERT INTO user_connections (id,user_id,type,name,created_at) VALUES ('c','a','steam','someone','now')");
    assert.equal(old.prepare("SELECT verified FROM user_connections WHERE id='c'").get().verified, 0);
    assert.ok(old.prepare('PRAGMA table_info(scheduled_messages)').all().some(c => c.name === 'message_id'), 'scheduled messages get a delivery id');
    assert.deepEqual(old.prepare('PRAGMA foreign_key_check').all(), []);
  } finally { old.close(); }
});

test('account deletion clears private records and credentials while preserving shared messages', () => {
  addUser('102');
  run("INSERT INTO channels (id,type) VALUES ('201',1)");
  run("INSERT INTO messages (id,channel_id,author_id,content,timestamp) VALUES ('301','201','102','shared','now')");
  run("INSERT INTO dm_recipients (channel_id,user_id) VALUES ('201','102')");
  run("INSERT INTO saved_message_folders (id,user_id,name,created_at) VALUES ('folder','102','private','now')");
  run("INSERT INTO user_connections (id,user_id,type,name,created_at) VALUES ('connection','102','github','private','now')");
  run("INSERT INTO user_e2ee_keys (user_id,public_key,created_at,updated_at) VALUES ('102','key','now','now')");
  run("INSERT INTO dm_keys (channel_id,epoch,user_id,wrapped) VALUES ('201',1,'102','wrap')");
  run("INSERT INTO password_resets VALUES ('reset','102',9999999999999)");
  run("INSERT INTO recurring_messages (id,channel_id,author_id,content,next_run,created_at) VALUES ('rec','201','102','private',1,1)");
  run("INSERT INTO dm_requests VALUES ('201','102','pending','now')");
  run("UPDATE users SET calendar_token='secret',hub_user_id='hub-private',hub_avatar='private' WHERE id='102'");
  account.anonymize('102');
  for (const [table, column] of PRIVATE_DATA) assert.equal(get(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`, '102').n, 0, table);
  assert.equal(get("SELECT content FROM messages WHERE id='301'").content, 'shared');
  assert.ok(get("SELECT 1 FROM dm_recipients WHERE channel_id='201' AND user_id='102'"), 'the other person keeps the DM with Deleted User');
  const user = userById('102');
  assert.equal(user.deleted, 1);
  for (const field of ['calendar_token', 'hub_user_id', 'hub_avatar']) assert.equal(user[field], null);
});

test('all real route declarations validate; unsupported or contradictory policies fail closed', async () => {
  for (const name of readdirSync(new URL('../src/routes/', import.meta.url)).filter(n => n.endsWith('.js'))) {
    const routes = (await import(`../src/routes/${name}`)).default;
    if (routes) for (const route of routes) compileRoute(route);
  }
  for (const opts of [{ limit: 2 }, { typo: true }, { open: true, admin: true }, { userOnly: true, botOnly: true }, { rateLimit: { max: 2, window: 3600 } }]) {
    assert.throws(() => compileRoute(['GET', '/test', () => {}, opts]), TypeError);
  }
});

test('the declared export policy rejects request three and isolates accounts', () => {
  const route = compileRoute(account.default.find(r => r[1] === '/users/@me/export'));
  const headers = {};
  const call = identity => limit(route.method, route.pattern, {}, identity, headers, route.rateLimit);
  call('rate-a'); call('rate-a');
  assert.throws(() => call('rate-a'), e => e.status === 429 && e.body.retry_after > 3590);
  assert.equal(headers['X-RateLimit-Limit'], '2');
  assert.equal(headers['X-RateLimit-Remaining'], '0');
  call('rate-b');
});

test('new user-owned tables require an explicit privacy classification', () => {
  // These retain shared content/history under the anonymized ID or have dedicated lifecycle handling.
  const shared = new Set(['guilds', 'members', 'applications', 'messages', 'invites', 'bans', 'reactions',
    'poll_votes', 'emojis', 'stickers', 'soundboard_sounds', 'scheduled_events', 'webhooks', 'guild_templates',
    'guild_snippets', 'channel_canvas', 'channel_whiteboard', 'relationships', 'dm_recipients']);
  const privateTables = new Set(PRIVATE_DATA.map(([table]) => table));
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()) {
    for (const fk of db.prepare(`PRAGMA foreign_key_list("${name}")`).all()) {
      if (fk.table === 'users') assert.ok(privateTables.has(name) || shared.has(name), `Classify ${name} in account-data.js or the retained shared-data inventory`);
    }
  }
});

test('worker export includes over 10,000 messages, attachments and private data, excluding secrets and other users', async () => {
  addUser('103'); addUser('104');
  run("INSERT INTO user_connections (id,user_id,type,name,created_at) VALUES ('export-conn','103','github','self','now')");
  run("INSERT INTO tokens (token_hash,user_id) VALUES ('never-export-this','103')");
  tx(() => {
    for (let i = 0; i < 10005; i++) run('INSERT INTO messages (id,channel_id,author_id,content,timestamp) VALUES (?,?,?,?,?)', String(1000+i), '201', '103', `message-${i}`, 'now');
    run("INSERT INTO messages (id,channel_id,author_id,content,timestamp) VALUES ('99999','201','104','not yours','now')");
    run("INSERT INTO attachments (id,message_id,channel_id,filename,size,content_type) VALUES ('444','1000','201','file.txt',3,'text/plain')");
  });
  let ticks = 0;
  const timer = setInterval(() => ticks++, 1);
  let output;
  try { output = await invoke(account.default, 'GET', '/users/@me/export', { user: userById('103') }); } finally { clearInterval(timer); }
  try {
    assert.ok(ticks > 0, 'event loop remains available during export');
    const text = readFileSync(join(output.dir, 'export.json'), 'utf8');
    const data = JSON.parse(text);
    assert.equal(data.messages.length, 10005);
    assert.equal(data.messages.find(m => m.id === '1000').attachments[0].filename, 'file.txt');
    assert.equal(data.connections[0].name, 'self');
    assert.ok(!text.includes('never-export-this') && !text.includes('not yours'));
    const sink = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
    sink.writeHead = (status, headers) => { assert.equal(status, 200); assert.equal(headers['Cache-Control'], 'no-store'); };
    await output.send(sink, {});
    assert.equal(existsSync(output.dir), false);
  } finally { await output.dispose(); }
});

test('saving a message cannot reference another account’s folder', async () => {
  const routes = (await import('../src/routes/later.js')).default;
  run("INSERT INTO saved_message_folders (id,user_id,name,created_at) VALUES ('other-folder','104','private','now')");
  run("INSERT INTO dm_recipients (channel_id,user_id) VALUES ('201','103')");
  const ctx = { user: userById('103'), params: { channel_id: '201', message_id: '1000' }, body: { folder_id: 'other-folder' } };
  assert.throws(() => invoke(routes, 'PUT', '/users/@me/saved-messages/:channel_id/:message_id', ctx), e => e.status === 404);
  assert.equal(get("SELECT 1 FROM saved_messages WHERE user_id='103' AND message_id='1000'"), undefined);
  run("INSERT INTO saved_message_folders (id,user_id,name,created_at) VALUES ('own-folder','103','private','now')");
  assert.equal(invoke(routes, 'PUT', '/users/@me/saved-messages/:channel_id/:message_id', { ...ctx, body: { folder_id: 'own-folder' } }).folder_id, 'own-folder');
});

test('exports release capacity on failure, bound concurrency and clean up abandoned downloads', async () => {
  await assert.rejects(exportAccount(dir, { id: 'missing' }), /Account no longer available/);
  const user = userObj(userById('103'), true);
  // a worker stopped at the deadline cannot close its own file; the caller must, or every timeout leaks a descriptor
  const fds = () => readdirSync('/proc/self/fd').length;
  const before = fds();
  await assert.rejects(exportAccount(dir, user, 1), e => e.status === 503);
  assert.equal(fds(), before, 'no descriptor left after a timeout');
  const first = exportAccount(dir, user), second = exportAccount(dir, user);
  await assert.rejects(exportAccount(dir, user), e => e.status === 503);
  const outputs = await Promise.all([first, second]);
  try {
    for (const output of outputs) {
      const sink = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
      sink.destroy();
      await output.send(sink, {});
      assert.equal(existsSync(output.dir), false);
    }
  } finally { await Promise.all(outputs.map(output => output.dispose())); }
});

test('an export keeps its slot until its download ends; archives live in the data folder, cleared at start', async () => {
  const user = userObj(userById('103'), true);
  const outputs = await Promise.all([exportAccount(dir, user), exportAccount(dir, user)]);
  try {
    assert.ok(outputs.every(o => o.dir.startsWith(join(dir, 'exports-tmp'))), 'not in the shared temp folder');
    await assert.rejects(exportAccount(dir, user), e => e.status === 503, 'two archives wait for download');
    const sink = new Writable({ write(_chunk, _encoding, cb) { cb(); } });
    sink.writeHead = () => {};
    await outputs[0].send(sink, {});
    const third = await exportAccount(dir, user);
    await third.dispose();
  } finally { await Promise.all(outputs.map(output => output.dispose())); }
  // a crash leaves an archive behind: the next start removes it
  const stale = join(dir, 'exports-tmp', 'export-crashed');
  mkdirSync(stale, { recursive: true });
  writeFileSync(join(stale, 'export.json'), '{}');
  execFileSync(process.execPath, ['--input-type=module', '-e', "await import('./src/account-export.js')"],
    { cwd: new URL('..', import.meta.url), env: { ...process.env, DATA_DIR: dir } });
  assert.equal(existsSync(stale), false);
});

test('passkeys require the exact configured origin, valid signatures, increasing counters and a single-use challenge', async () => {
  addUser('105');
  const { setSetting } = await import('../src/instance.js');
  setSetting('public_url', 'https://review.example');
  const ctx = { user: userById('105'), token: 'session', headers: {}, req: { headers: { host: 'untrusted.example' }, socket: {} }, body: { password: 'review-password' } };
  for (const type of ['ec', 'rsa', 'ed25519']) {
    const auth = authenticator(type, 'https://review.example');
    const opts = await invoke(passkeys, 'POST', '/auth/webauthn/register/options', ctx);
    assert.equal(opts.rp.id, 'review.example');
    invoke(passkeys, 'POST', '/auth/webauthn/register/verify', { ...ctx, body: { credential: auth.register(opts), nickname: type } });
    const options = () => invoke(passkeys, 'POST', '/auth/webauthn/authenticate/options', ctx);
    const login = credential => invoke(passkeys, 'POST', '/auth/webauthn/authenticate/verify', { ...ctx, body: { credential } });
    for (const origin of ['http://review.example', 'https://review.example:444', 'https://evil.example']) {
      assert.throws(() => login(auth.sign(options(), undefined, undefined, { origin })), /origin mismatch/);
    }
    assert.throws(() => login(auth.sign(options(), undefined, undefined, { crossOrigin: true })), /origin mismatch/);
    assert.throws(() => login(auth.sign(options(), undefined, 1)), /verification required/);
    const assertion = auth.sign(options());
    const forged = structuredClone(assertion); forged.response.signature = Buffer.alloc(64).toString('base64url');
    assert.throws(() => login(forged), e => e.status === 401);
    const valid = auth.sign(options());
    assert.ok(login(valid).token);
    assert.throws(() => login(valid), /challenge mismatch/);
    assert.throws(() => login(auth.sign(options(), undefined, undefined, { counter: 0 })), e => e.status === 401);
  }
  const opts = await invoke(passkeys, 'POST', '/auth/webauthn/register/options', ctx);
  const oversizedArray = Buffer.from([0x9a, 0xff, 0xff, 0xff, 0xff]).toString('base64url');
  assert.throws(() => invoke(passkeys, 'POST', '/auth/webauthn/register/verify', { ...ctx, body: { credential: { id: 'x', response: { attestationObject: oversizedArray } } } }), /Invalid Form Body/);
  assert.ok(opts.challenge);
});
