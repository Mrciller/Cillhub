// Inputs that used to end the whole process: a gateway command, a module's interaction answer, a file stream that
// fails, an upload whose temp file cannot be written, an async timer job that rejects. Each must stay local.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, guildWith, tempDir } from './helpers.js';
import { makeAdmin, install, pkg, logged } from './module-helpers.js';

process.env.DATA_DIR = await tempDir(); // the in-process checks below open their own database
const wait = ms => new Promise(r => setTimeout(r, ms));

let srv, api, g;
before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alex', 'sam']);
});
after(async () => {
  await srv.stop();
  rmSync(process.env.DATA_DIR, { recursive: true, force: true });
});
const alive = async () => assert.equal((await api('GET', '/instance')).status, 200, 'the server still answers');

test('gateway: a member request with an id that cannot become a string does not end the process', async () => {
  const gw = await srv.gateway(g.users.alex.token);
  gw.send({ op: 8, d: { guild_id: g.guild.id, user_ids: [{ toString: null }, g.users.sam.id] } });
  const chunk = await gw.event('GUILD_MEMBERS_CHUNK');
  assert.deepEqual(chunk.members.map(m => m.user.id), [g.users.sam.id]);
  await alive();
});

test('a module answering an interaction with an unreadable embed timestamp is refused and logged', async () => {
  const root = await makeAdmin(srv, 'robin');
  const code = `cillhub.on('INTERACTION_CREATE', () => ({ type: 4, data: { content: 'x', embeds: [{ timestamp: { toString: null } }] } }));`;
  const mod = await install(srv, root, pkg({ id: 'stamp', name: 'Stamp', permissions: ['commands'], commands: [{ name: 'stamp', description: 'Stamp' }] }, { 'index.js': code }));
  const cmd = (await api('GET', `/channels/${g.general.id}/application-command-index`, g.users.alex.token)).body.application_commands.find(c => c.name === 'stamp');
  const r = await api('POST', '/interactions', g.users.alex.token, {
    type: 2, application_id: mod.application_id, guild_id: g.guild.id, channel_id: g.general.id, nonce: 'n1', data: { id: cmd.id, name: 'stamp', type: 1 },
  });
  assert.equal(r.status, 204);
  await logged(srv, root, 'stamp', /The interaction response was refused/);
  await alive();
});

test('a file that vanished before it is streamed ends that answer, not the process', async () => {
  const { sendRanged } = await import('../src/files.js');
  const res = new PassThrough();
  res.writeHead = () => {};
  sendRanged({ headers: {}, method: 'GET' }, res, {}, join(process.env.DATA_DIR, 'gone.bin'), 10);
  await wait(100);
  assert.ok(res.destroyed, 'the answer is closed');
});

test('an upload whose temp file cannot be written fails the request instead of the process', async () => {
  const { parseMultipart } = await import('../src/multipart.js');
  const tmp = join(process.env.DATA_DIR, 'uploads-tmp');
  async function* body() {
    yield Buffer.from('--b\r\nContent-Disposition: form-data; name="f"; filename="a.txt"\r\n\r\nhello');
    for (const d of readdirSync(tmp)) rmSync(join(tmp, d), { recursive: true, force: true }); // the temp folder disappears
    await wait(100);
    yield Buffer.from(' world\r\n--b--\r\n');
  }
  const req = Object.assign(body(), { headers: { 'content-type': 'multipart/form-data; boundary=b' } });
  await assert.rejects(parseMultipart(req, { maxTotal: 1e6, maxFile: 1e6 }), /ENOENT/);
});

test('an overdue async job that is still running does not make the other jobs run again and again', async () => {
  const { addJob, startTimers, stopTimers } = await import('../src/timers.js');
  let hourly = 0, slowDone = false;
  addJob({ name: 'hourly', next: () => Date.now() + 3_600_000, run: () => { hourly++; } });
  addJob({ name: 'slow', next: () => (slowDone ? Date.now() + 3_600_000 : 0), run: async () => { await wait(100); slowDone = true; } });
  startTimers();
  await wait(250);
  stopTimers();
  assert.equal(hourly, 1, `hourly ran ${hourly} times while the overdue job was busy`);
});

test('an overdue timer job that fails waits 5 s before it runs again', async () => {
  const { addJob, startTimers, stopTimers } = await import('../src/timers.js');
  let sync = 0, async = 0;
  addJob({ name: 'sync fail', next: () => 0, run: () => { sync++; throw new Error('sync failed'); } });
  addJob({ name: 'async fail', next: () => 0, run: async () => { async++; throw new Error('async failed'); } });
  startTimers();
  await wait(500);
  assert.deepEqual([sync, async], [1, 1]);
  await wait(5000);
  stopTimers();
  assert.deepEqual([sync, async], [2, 2], 'and runs again after the pause');
});

test('an async timer job that rejects is logged and does not run twice at once', async () => {
  const { addJob, startTimers, stopTimers } = await import('../src/timers.js');
  let runs = 0;
  addJob({ name: 'boom', next: () => Date.now() + 20, run: async () => { runs++; await wait(150); throw new Error('job failed'); } });
  startTimers();
  await wait(400);
  stopTimers();
  assert.ok(runs >= 1 && runs <= 3, `runs ${runs}: no overlap while the first is pending`);
});

test('one failing insert hook does not stop the next one', async () => {
  const { run } = await import('../src/db.js');
  const { insertMessage, insertHooks } = await import('../src/message.js');
  run("INSERT INTO users (id, email, username, password_hash, salt) VALUES ('9001', 'taylor@example.com', 'taylor', 'x', 'x')");
  run("INSERT INTO channels (id, type) VALUES ('9002', 1)");
  let seen = 0;
  insertHooks.push(() => { throw new Error('hook failed'); }, () => { seen++; });
  const m = insertMessage({ ch: { id: '9002', type: 1 }, authorId: '9001', content: 'hi' });
  assert.equal(m.content, 'hi');
  assert.equal(seen, 1);
});
