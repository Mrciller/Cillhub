// Access and leak fixes from the 2026-11-10 audits: webhook tokens, AutoMod alerts, recurring messages, message
// content for bots, MFA tickets and calendar links after a password change, bulk timeouts, channel clones, session
// revocation, DM lifetimes, mail settings step-up, module log secrets, vanity links.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, guildWith, bits, until } from './helpers.js';
import { makeAdmin, install, pkg, logged, totp } from './module-helpers.js';

const SECRET = 'JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP';
const VIEW = 10, SEND = 11, MANAGE_CHANNELS = 4, MANAGE_WEBHOOKS = 29, MODERATE = 40, ADMIN = 3;
let srv, api, g, alex, sam, robin, root;
const dbRun = (sql, ...args) => { const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite')); try { return db.prepare(sql).run(...args); } finally { db.close(); } };
const dbGet = (sql, ...args) => { const db = new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite'), { readOnly: true }); try { return db.prepare(sql).get(...args); } finally { db.close(); } };
const deny = (ch, id, b) => api('PUT', `/channels/${ch}/permissions/${id}`, alex.token, { type: id === g.guild.id ? 0 : 1, allow: '0', deny: b });
const allow = (ch, id, b) => api('PUT', `/channels/${ch}/permissions/${id}`, alex.token, { type: 1, allow: b, deny: '0' });
const mfaOn = async u => assert.equal((await api('POST', '/users/@me/mfa/totp/enable', u.token, { password: 'hunter2hunter2', secret: SECRET, code: totp() })).status, 200);

before(async () => {
  srv = await startServer({ env: { CILLCORD_PUBLIC_URL: 'https://chat.example.org' } });
  api = srv.api;
  g = await guildWith(srv, ['alex', 'sam', 'robin']);
  ({ alex, sam, robin } = g.users);
  root = await makeAdmin(srv, 'jordan');
});
after(() => srv.stop());

test('guild webhook list leaves out channels the caller cannot see', async () => {
  const hidden = (await api('POST', `/guilds/${g.guild.id}/channels`, alex.token, { name: 'staff' })).body;
  for (const ch of [g.general, hidden]) assert.equal((await api('POST', `/channels/${ch.id}/webhooks`, alex.token, { name: 'Hook' })).status, 200);
  const role = (await api('POST', `/guilds/${g.guild.id}/roles`, alex.token, { name: 'hooks', permissions: bits(MANAGE_WEBHOOKS) })).body;
  await api('PUT', `/guilds/${g.guild.id}/members/${sam.id}/roles/${role.id}`, alex.token);
  await deny(hidden.id, sam.id, bits(VIEW));
  const list = (await api('GET', `/guilds/${g.guild.id}/webhooks`, sam.token)).body;
  assert.deepEqual(list.map(w => w.channel_id), [g.general.id]);
});

test('AutoMod alerts with message text reach only managers who can see the channel', async () => {
  const secret = (await api('POST', `/guilds/${g.guild.id}/channels`, alex.token, { name: 'secret' })).body;
  const role = (await api('POST', `/guilds/${g.guild.id}/roles`, alex.token, { name: 'mgr', permissions: bits(5) })).body; // MANAGE_GUILD
  await api('PUT', `/guilds/${g.guild.id}/members/${robin.id}/roles/${role.id}`, alex.token);
  await deny(secret.id, robin.id, bits(VIEW));
  assert.equal((await api('POST', `/guilds/${g.guild.id}/auto-moderation/rules`, alex.token, {
    name: 'words', event_type: 1, trigger_type: 1, trigger_metadata: { keyword_filter: ['forbidden'] }, actions: [{ type: 1 }], enabled: true,
  })).status, 200);
  const gw = await srv.gateway(robin.token), owner = await srv.gateway(alex.token);
  await allow(secret.id, sam.id, bits(VIEW, SEND));
  assert.equal((await api('POST', `/channels/${secret.id}/messages`, sam.token, { content: 'the forbidden plan' })).status, 400, 'blocked');
  assert.equal((await owner.event('AUTO_MODERATION_ACTION_EXECUTION')).content, 'the forbidden plan', 'a manager who sees the channel');
  assert.ok(await gw.none(f => f.t === 'AUTO_MODERATION_ACTION_EXECUTION', 400), 'no alert text for a manager outside the channel');
});

test('recurring messages stop when the recipient blocks the author', async () => {
  const dm = (await api('POST', '/users/@me/channels', sam.token, { recipient_id: robin.id })).body;
  const r = await api('POST', `/channels/${dm.id}/recurring-messages`, sam.token, { content: 'daily ping', interval_type: 'daily', time_of_day: '00:00' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await api('PUT', `/users/@me/relationships/${sam.id}`, robin.token, { type: 2 })).status, 204);
  dbRun('UPDATE recurring_messages SET next_run = 1 WHERE id = ?', r.body.id);
  await api('POST', `/channels/${dm.id}/recurring-messages`, sam.token, { content: 'wake', interval_type: 'daily', time_of_day: '23:59' }); // re-arms the timer
  await until(() => !!dbGet('SELECT 1 FROM recurring_messages WHERE id = ? AND next_run > 1', r.body.id), 3000); // the job ran
  const msgs = (await api('GET', `/channels/${dm.id}/messages`, sam.token)).body;
  assert.equal(msgs.filter(m => m.content === 'daily ping').length, 0);
  await api('DELETE', `/users/@me/relationships/${sam.id}`, robin.token);
});

test('bots without message content read no content through pins, search or edit history', async () => {
  const app = (await api('POST', '/applications', alex.token, { name: 'Reader' })).body;
  const bot = `Bot ${(await api('POST', `/applications/${app.id}/bot/reset`, alex.token, {})).body.token}`;
  await api('PUT', `/guilds/${g.guild.id}/members/${app.id}`, bot, {});
  dbRun('INSERT OR IGNORE INTO members (guild_id, user_id, joined_at) VALUES (?, ?, ?)', g.guild.id, app.id, new Date().toISOString());
  const m = (await api('POST', `/channels/${g.general.id}/messages`, alex.token, { content: 'first words' })).body;
  await api('PATCH', `/channels/${g.general.id}/messages/${m.id}`, alex.token, { content: 'second words' });
  await api('PUT', `/channels/${g.general.id}/pins/${m.id}`, alex.token);
  const pins = (await api('GET', `/channels/${g.general.id}/pins`, bot)).body;
  assert.equal(pins.find(p => p.id === m.id).content, '');
  const edits = (await api('GET', `/channels/${g.general.id}/messages/${m.id}/edits`, bot)).body.edits;
  assert.deepEqual(edits.map(e => e.content), ['']);
  const found = await until(async () => (await api('GET', `/guilds/${g.guild.id}/messages/search?content=words`, bot)).body.messages?.flat().find(x => x.id === m.id), 3000);
  assert.equal(found.content, '');
  assert.deepEqual((await api('GET', `/channels/${g.general.id}/messages/${m.id}/edits`, alex.token)).body.edits.map(e => e.content), ['first words'], 'people still see them');
});

test('a password change ends pending 2FA tickets, refuses disabled accounts, and drops the calendar link', async () => {
  const kim = await srv.register('kim');
  await mfaOn(kim);
  const ticket = (await api('POST', '/auth/login', null, { login: 'kim', password: 'hunter2hunter2' })).body.ticket;
  const feed = (await api('GET', '/users/@me/calendar-feed', kim.token)).body;
  assert.match(feed.url, /^https:\/\/chat\.example\.org\/api\/v9\/calendar\/feed\/\w+\.ics$/, 'configured address, not the request Host');
  const local = feed.url.replace('https://chat.example.org', srv.origin);
  assert.equal((await fetch(local)).status, 200);
  assert.equal((await api('PATCH', '/users/@me', kim.token, { password: 'hunter2hunter2', new_password: 'new-pass-kim', code: totp(Date.now() + 30_000) })).status, 200);
  assert.equal((await api('POST', '/auth/mfa/totp', null, { ticket, code: totp(Date.now() + 30_000) })).body.code, 60006, 'old ticket is gone');
  assert.equal((await fetch(local)).status, 404, 'old feed link is gone');
  const t2 = (await api('POST', '/auth/login', null, { login: 'kim', password: 'new-pass-kim' })).body.ticket;
  dbRun("UPDATE users SET disabled = 1 WHERE username = 'kim'");
  assert.equal((await api('POST', '/auth/mfa/totp', null, { ticket: t2, code: totp(Date.now() + 60_000) })).body.code, 60006, 'disabled account');
  assert.equal((await api('POST', '/auth/sessions/revoke-all-others', sam.token)).status, 200, 'without 2FA nothing changes');
});

test('revoking all other sessions needs the 2FA step-up', async () => {
  const taylor = await srv.register('taylor');
  await mfaOn(taylor);
  const r = await api('POST', '/auth/sessions/revoke-all-others', taylor.token);
  assert.deepEqual([r.status, r.body.code], [401, 60003]);
});

test('bulk timeout follows the single-member rules', async () => {
  const admin = (await api('POST', `/guilds/${g.guild.id}/roles`, alex.token, { name: 'admins', permissions: bits(ADMIN) })).body;
  const mod = (await api('POST', `/guilds/${g.guild.id}/roles`, alex.token, { name: 'mods', permissions: bits(MODERATE) })).body;
  await api('PATCH', `/guilds/${g.guild.id}/roles`, alex.token, [{ id: mod.id, position: 5 }, { id: admin.id, position: 1 }]);
  await api('PUT', `/guilds/${g.guild.id}/members/${robin.id}/roles/${admin.id}`, alex.token);
  await api('PUT', `/guilds/${g.guild.id}/members/${sam.id}/roles/${mod.id}`, alex.token);
  const act = body => api('POST', `/guilds/${g.guild.id}/members/bulk-action`, sam.token, { action: 'timeout', user_ids: [robin.id], ...body });
  assert.equal((await act({ duration_seconds: 3153600000 })).status, 400, '28 days at most');
  assert.deepEqual((await act({ duration_seconds: 60 })).body.user_ids, [], 'administrators are immune');
  assert.equal((await act({ duration_seconds: 60, reason: 'x'.repeat(600) })).status, 400);
});

test('cloning a channel needs the server-wide Manage Channels', async () => {
  // Manage Channels and Manage Permissions in this channel only, through a role below Sam's moderator role
  const role = (await api('POST', `/guilds/${g.guild.id}/roles`, alex.token, { name: 'cloners', permissions: '0' })).body;
  await api('PUT', `/guilds/${g.guild.id}/members/${sam.id}/roles/${role.id}`, alex.token);
  await api('PUT', `/channels/${g.general.id}/permissions/${role.id}`, alex.token, { type: 0, allow: bits(VIEW, MANAGE_CHANNELS, 28), deny: '0' });
  assert.equal((await api('POST', `/channels/${g.general.id}/clone`, sam.token, {})).status, 403);
});

test('a DM lifetime covers only later messages, never against a block, and each side gets its own view', async () => {
  const dm = (await api('POST', '/users/@me/channels', alex.token, { recipient_id: sam.id })).body;
  const old = (await api('POST', `/channels/${dm.id}/messages`, sam.token, { content: 'before the lifetime' })).body;
  const gw = await srv.gateway(sam.token);
  const set = await api('PATCH', `/channels/${dm.id}`, alex.token, { message_ttl: 1 });
  assert.equal(set.status, 200);
  assert.equal((await gw.event('CHANNEL_UPDATE', c => c.id === dm.id)).recipients[0].id, alex.id, 'Sam sees Alex');
  const later = (await api('POST', `/channels/${dm.id}/messages`, sam.token, { content: 'after' })).body;
  await until(async () => (await api('GET', `/channels/${dm.id}/messages/${later.id}`, sam.token)).status === 404, 5000);
  assert.equal((await api('GET', `/channels/${dm.id}/messages/${old.id}`, sam.token)).status, 200, 'older message kept');
  await api('PATCH', `/channels/${dm.id}`, alex.token, { message_ttl: null });
  assert.equal((await api('PUT', `/users/@me/relationships/${alex.id}`, sam.token, { type: 2 })).status, 204);
  assert.equal((await api('PATCH', `/channels/${dm.id}`, alex.token, { message_ttl: 60 })).status, 403);
  await api('DELETE', `/users/@me/relationships/${alex.id}`, sam.token);
});

test('mail, address and captcha settings and the test mail need the 2FA step-up; a new host drops the password', async () => {
  const patch = (body, h = {}) => api('PATCH', '/admin/settings', root.token, body, h);
  assert.deepEqual([(await patch({ smtp_host: 'mail.example.org' })).status], [401]);
  assert.equal((await patch({ instance_name: 'Cillhub' })).status, 200, 'other settings as before');
  assert.equal((await patch({ smtp_host: 'mail.example.org', smtp_password: 'pw-Kim-123' }, root.elevated)).body.smtp_password_set, true);
  assert.equal((await patch({ smtp_host: 'mail.example.org' })).status, 200, 'an unchanged value needs nothing');
  assert.equal((await patch({ smtp_host: 'other.example.org' }, root.elevated)).body.smtp_password_set, false, 'password dropped');
  assert.equal((await patch({ smtp_from: '"Cillhub" <no-reply@example.org>, postmaster' }, root.elevated)).status, 400);
  assert.equal((await patch({ smtp_from: 'Cillhub <no-reply@example.org>' }, root.elevated)).status, 200);
  assert.equal((await api('POST', '/admin/settings/test-mail', root.token, {})).status, 401);
});

test('a module that logs its secret setting gets it masked', async () => {
  const code = `cillhub.on('READY', async () => console.log('my token is ' + (await cillhub.settings.get()).token));`;
  const mod = await install(srv, root, pkg({ id: 'leaky', name: 'Leaky', permissions: [], settings: [{ key: 'token', type: 'secret', label: 'Token' }] }, { 'index.js': code }), { enable: false });
  assert.equal((await api('PUT', '/admin/modules/leaky/settings', root.token, { values: { token: 'super-secret-4711' } }, root.elevated)).status, 200);
  await api('PATCH', '/admin/modules/leaky', root.token, { enabled: true }, root.elevated);
  const line = await logged(srv, root, mod.id, /my token is/);
  assert.equal(line.message, 'my token is [redacted]');
});

test('a vanity link names only a channel everyone can see', async () => {
  const own = (await api('POST', '/guilds', alex.token, { name: 'Vanity' })).body;
  const general = own.channels.find(c => c.name === 'general');
  const lobby = (await api('POST', `/guilds/${own.id}/channels`, alex.token, { name: 'lobby' })).body;
  await api('PUT', `/channels/${general.id}/permissions/${own.id}`, alex.token, { type: 0, allow: '0', deny: bits(VIEW) });
  await api('PATCH', `/guilds/${own.id}/vanity-url`, alex.token, { code: 'alex-vanity' });
  const inv = (await api('GET', '/invites/alex-vanity')).body;
  assert.equal(inv.channel.id, lobby.id);
});
