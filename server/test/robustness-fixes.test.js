// Robustness fixes from the 2026-11-10 audits: no orphan files after a failed send, scheduled messages survive a crash
// mid-send, group DM lifetimes, recurring times of day, the password change an admin asks for (2FA step-up, gateway).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { existsSync, readdirSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { startServer, guildWith, until } from './helpers.js';
import { makeAdmin, totp, install, pkg, logged } from './module-helpers.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
let srv, api, g, alex, sam, root;
const db = (fn, readOnly = false) => { const d = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite'), { readOnly }); try { return fn(d); } finally { d.close(); } };
const soon = ms => new Date(Date.now() + ms).toISOString();

before(async () => {
  srv = await startServer();
  api = srv.api;
  g = await guildWith(srv, ['alex', 'sam']);
  ({ alex, sam } = g.users);
  root = await makeAdmin(srv, 'jordan');
});
after(() => srv.stop());

test('a message that cannot be stored leaves no uploaded file behind', async () => {
  db(d => d.exec("CREATE TRIGGER no_boom BEFORE INSERT ON messages WHEN NEW.content = 'boom' BEGIN SELECT RAISE(ABORT, 'refused'); END"));
  try {
    const r = await srv.upload(g.general.id, alex.token, { content: 'boom' }, [['a.txt', Buffer.from('hello'), 'text/plain']]);
    assert.equal(r.status, 500);
  } finally { db(d => d.exec('DROP TRIGGER no_boom')); }
  const dir = join(srv.dataDir, 'attachments', g.general.id);
  assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], []);
});

test('a failure after the message is stored keeps its files and the message', async () => {
  db(d => d.exec("CREATE TRIGGER no_metric BEFORE INSERT ON guild_analytics_daily BEGIN SELECT RAISE(ABORT, 'refused'); END"));
  let r;
  try {
    r = await srv.upload(g.general.id, alex.token, { content: 'kept' }, [['b.txt', Buffer.from('hello'), 'text/plain']]);
  } finally { db(d => d.exec('DROP TRIGGER no_metric')); }
  assert.ok(r.status < 300, 'the stored message is answered');
  assert.ok(existsSync(join(srv.dataDir, 'attachments', g.general.id, r.body.attachments[0].id)), 'its file is still there');
});

test('a failing metric after the insert does not skip the insert hooks (module accessory panel)', async () => {
  const code = `cillhub.on('MESSAGE_CREATE', async m => {
    if (m.content === '!card') console.log('card', (await cillhub.messages.send(m.channel_id, { content: 'card', accessory_panel: 'acc' })).id);
  });`;
  await install(srv, root, pkg({ id: 'cards', name: 'Cards', permissions: ['messages.read', 'messages.send', 'ui'],
    ui: { panels: [{ id: 'acc', slot: 'message_accessory', title: 'Acc', entry: 'ui/acc.html' }] } }, { 'index.js': code, 'ui/acc.html': '<p>acc</p>' }));
  db(d => d.exec("CREATE TRIGGER no_metric2 BEFORE INSERT ON guild_analytics_daily BEGIN SELECT RAISE(ABORT, 'refused'); END"));
  let line;
  try {
    await api('POST', `/channels/${g.general.id}/messages`, alex.token, { content: '!card' });
    line = await logged(srv, root, 'cards', /^card \d+$/);
  } finally { db(d => d.exec('DROP TRIGGER no_metric2')); }
  const id = line.message.split(' ')[1];
  assert.ok(db(d => d.prepare('SELECT 1 FROM module_message_panels WHERE message_id = ?').get(id), true), 'panel row stored');
});

test('a forward whose second file is missing leaves no copy of the first behind', async () => {
  const src = (await srv.upload(g.general.id, alex.token, { content: 'two files' },
    [['one.txt', Buffer.from('one'), 'text/plain'], ['two.txt', Buffer.from('two'), 'text/plain']])).body;
  rmSync(join(srv.dataDir, 'attachments', g.general.id, src.attachments[1].id));
  const target = (await api('POST', `/guilds/${g.guild.id}/channels`, alex.token, { name: 'forwards' })).body;
  const r = await api('POST', `/channels/${target.id}/messages`, alex.token, { message_reference: { type: 1, message_id: src.id, channel_id: g.general.id } });
  assert.equal(r.status, 500);
  const dir = join(srv.dataDir, 'attachments', target.id);
  assert.deepEqual(existsSync(dir) ? readdirSync(dir) : [], []);
});

test('a scheduled message is sent under the id fixed before the send, and never twice', async () => {
  const path = `/channels/${g.general.id}/scheduled-messages`;
  const gw = await srv.gateway(alex.token);
  const a = (await api('POST', path, alex.token, { content: 'first run', send_at: soon(60_000) })).body;
  db(d => d.prepare("UPDATE scheduled_messages SET message_id = '1400000000000000001', send_at = ? WHERE id = ?").run(Date.now() + 800, a.id));
  await api('PATCH', `/users/@me/scheduled-messages/${a.id}`, alex.token, { content: 'first run' }); // re-arms the timer
  const sent = await gw.event('MESSAGE_CREATE', m => m.content === 'first run');
  assert.equal(sent.id, '1400000000000000001', 'the id fixed before the send');
  // as after a crash between the send and the removal: the row is still there, the message too
  const b = (await api('POST', path, alex.token, { content: 'again', send_at: soon(800) })).body;
  db(d => d.prepare('UPDATE scheduled_messages SET message_id = ? WHERE id = ?').run(sent.id, b.id));
  const done = await gw.event('SCHEDULED_MESSAGE_DELETE', d => d.id === b.id);
  assert.deepEqual([done.failed, done.message_id], [undefined, sent.id]);
  assert.ok(await gw.none(f => f.t === 'MESSAGE_CREATE' && f.d.content === 'again', 300), 'not sent twice');
  assert.equal(db(d => d.prepare('SELECT COUNT(*) AS n FROM scheduled_messages WHERE id = ?').get(b.id).n, true), 0);
});

test('a scheduled message deleted after delivery is not sent again by the recovery', async () => {
  const gw = await srv.gateway(alex.token);
  const r = (await api('POST', `/channels/${g.general.id}/scheduled-messages`, alex.token, { content: 'only once', send_at: soon(800) })).body;
  // the scheduled row cannot be removed (as if the process stopped right after the send)
  db(d => d.exec(`CREATE TRIGGER keep_row BEFORE DELETE ON scheduled_messages WHEN OLD.id = '${r.id}' BEGIN SELECT RAISE(ABORT, 'kept'); END`));
  try { await new Promise(res => setTimeout(res, 1500)); } finally { db(d => d.exec('DROP TRIGGER keep_row')); }
  db(d => d.prepare("DELETE FROM messages WHERE content = 'only once'").run()); // a lifetime removes the delivered message
  await api('PATCH', `/users/@me/scheduled-messages/${r.id}`, alex.token, { content: 'only once' }); // re-arms the timer
  await until(() => !db(d => d.prepare('SELECT 1 FROM scheduled_messages WHERE id = ?').get(r.id), true), 8000); // a failed run is retried 5 s later
  await new Promise(res => setTimeout(res, 300));
  assert.equal(gw.frames.filter(f => f.t === 'MESSAGE_CREATE' && f.d.content === 'only once').length, 1, 'sent exactly once');
});

test('a scheduled message whose send is rolled back stays scheduled and is sent on a later run', { timeout: 20_000 }, async () => {
  const gw = await srv.gateway(alex.token);
  const r = (await api('POST', `/channels/${g.general.id}/scheduled-messages`, alex.token, { content: 'rolled back', send_at: soon(500) })).body;
  // the row cannot be removed while its message exists: the removal inside the send fails and undoes the message
  db(d => d.exec(`CREATE TRIGGER keep_sent BEFORE DELETE ON scheduled_messages
    WHEN OLD.id = '${r.id}' AND EXISTS (SELECT 1 FROM messages WHERE id = OLD.message_id) BEGIN SELECT RAISE(ABORT, 'kept'); END`));
  try {
    await until(() => db(d => d.prepare('SELECT message_id FROM scheduled_messages WHERE id = ?').get(r.id), true)?.message_id, 3000);
    await new Promise(res => setTimeout(res, 1000)); // the first attempt has failed by now
    assert.ok(db(d => d.prepare('SELECT 1 FROM scheduled_messages WHERE id = ?').get(r.id), true), 'still scheduled');
  } finally { db(d => d.exec('DROP TRIGGER keep_sent')); }
  const sent = (await gw.wait(f => f.t === 'MESSAGE_CREATE' && f.d.content === 'rolled back', 10_000)).d; // the retry, 5 s later
  assert.equal(db(d => d.prepare('SELECT COUNT(*) AS n FROM scheduled_messages WHERE id = ?').get(r.id), true).n, 0);
  assert.ok(sent.id);
});

test('a group DM lifetime can be set and covers only messages from then on', async () => {
  const grp = (await api('POST', '/users/@me/channels', sam.token, { recipients: [] })).body;
  const old = (await api('POST', `/channels/${grp.id}/messages`, sam.token, { content: 'kept' })).body;
  const r = await api('PATCH', `/channels/${grp.id}`, sam.token, { message_ttl: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const fresh = (await api('POST', `/channels/${grp.id}/messages`, sam.token, { content: 'gone soon' })).body;
  await until(async () => (await api('GET', `/channels/${grp.id}/messages/${fresh.id}`, sam.token)).status === 404, 5000);
  assert.equal((await api('GET', `/channels/${grp.id}/messages/${old.id}`, sam.token)).status, 200);
});

test('recurring messages: 00:30 is half past midnight, an impossible time falls back to 12:00', async () => {
  const dm = (await api('POST', '/users/@me/channels', sam.token, { recipient_id: alex.id })).body;
  const at = async time_of_day => {
    const r = await api('POST', `/channels/${dm.id}/recurring-messages`, sam.token, { content: 'tick', interval_type: 'daily', time_of_day });
    const d = new Date(r.body.next_run);
    return [r.body.time_of_day, d.getHours(), d.getMinutes()];
  };
  assert.deepEqual(await at('00:30'), ['00:30', 0, 30]);
  assert.deepEqual(await at('99:99'), ['12:00', 12, 0]);
});

test('a required password change works with 2FA, and the gateway waits for it', async () => {
  const kim = await srv.register('kim');
  const on = await api('POST', '/users/@me/mfa/totp/enable', kim.token, { password: 'hunter2hunter2', secret: SECRET, code: totp() });
  assert.equal(on.status, 200);
  const gw = await srv.gateway(kim.token);
  assert.equal((await api('POST', `/admin/users/${kim.id}/require-password-change`, root.token, {}, root.elevated)).status, 200);
  assert.equal(await gw.closed, 4004, 'open gateway closed');
  const again = srv.socket();
  await again.wait(f => f.op === 10);
  again.send({ op: 2, d: { token: kim.token, properties: {} } });
  assert.equal(await again.closed, 4004, 'no new gateway session');
  const body = { password: 'hunter2hunter2', new_password: 'new-pass-kim' };
  const step = await api('PATCH', '/users/@me', kim.token, body);
  assert.equal(step.status, 401);
  const fin = await api('POST', '/mfa/finish', kim.token, { ticket: step.body.mfa.ticket, mfa_type: 'backup', data: on.body.backup_codes[0].code });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  assert.equal((await api('PATCH', '/users/@me', kim.token, body, { 'X-Cillhub-MFA-Authorization': fin.body.token })).status, 200);
});
