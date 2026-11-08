// v8 modules end to end against a real instance: commands, buttons and autocomplete answered by the sandbox, events,
// messages with embeds and components, reactions, roles within the hierarchy, storage and its quota, settings with the
// per-server overlay, UI requests and live events, panels in guild objects, HTTP endpoints, panel files, schedules
// (also across a restart), module_accessory and the module flag. Voice states are not covered here: they reach the
// module through the same event sink as the others but need a voice backend (voice.test.js fakes LiveKit).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer, guildWith, until } from './helpers.js';
import { makeAdmin, install, pkg, logged, logsOf, running } from './module-helpers.js';

let srv, api, root, g, alice, bob, kit, gw, lastCard = 0;
const CODE = `
const log = (...a) => console.log(...a);
const button = { type: 1, components: [{ type: 2, style: 1, label: 'Click', custom_id: 'click' }] };
cillhub.on('READY', r => log('READY', r.module.id, r.guilds.length));
cillhub.on('GUILD_MEMBER_ADD', m => log('member', m.user.username, m.guild_id));
cillhub.on('MESSAGE_REACTION_ADD', r => log('reaction', r.emoji.name));
cillhub.on('GUILD_CREATE', x => log('guild create', x.name));
cillhub.on('GUILD_DELETE', x => log('guild delete', x.id));
cillhub.on('SETTINGS_UPDATE', s => log('settings changed', s.guild_id));
cillhub.on('SCHEDULE', s => log('SCHEDULE', s.name, typeof s.at));
cillhub.on('MESSAGE_CREATE', async m => {
  log('message', m.content);
  const [cmd, ...rest] = m.content.split(' ');
  if (cmd === '!card') {
    const sent = await cillhub.messages.send(m.channel_id, { content: 'card', embeds: [{ title: 'Card', description: 'x' }], components: [button], accessory_panel: 'acc' });
    await cillhub.reactions.add(m.channel_id, sent.id, '👍');
    const edited = await cillhub.messages.edit(m.channel_id, sent.id, { embeds: [{ title: 'Edited' }] });
    log('card', sent.id, edited.embeds[0].title, JSON.stringify(sent.module_accessory));
    try { await cillhub.messages.edit(m.channel_id, m.id, { content: 'hijack' }); } catch (e) { log('edit other', e.code, e.status, e.api_code); }
    try { await cillhub.messages.send(m.channel_id, { content: 'x', accessory_panel: 'side' }); } catch (e) { log('bad panel', e.code); }
  }
  if (cmd === '!delete') { await cillhub.messages.delete(m.channel_id, rest[0]); log('deleted', rest[0]); }
  if (cmd === '!role') {
    try { await cillhub.members.addRole(m.guild_id, rest[0], rest[1]); log('role ok'); } catch (e) { log('role refused', e.code, e.status, e.api_code); }
  }
  if (cmd === '!settings') log('settings', JSON.stringify(await cillhub.settings.get(m.guild_id)), JSON.stringify(await cillhub.settings.get()));
  if (cmd === '!read') {
    const list = await cillhub.messages.list(m.channel_id, { limit: 2 });
    const one = await cillhub.messages.get(m.channel_id, m.id);
    const member = await cillhub.members.get(m.guild_id, m.author.id);
    const members = await cillhub.members.list(m.guild_id, { limit: 2 });
    const guilds = await cillhub.guilds.list();
    const guild = await cillhub.guilds.get(m.guild_id);
    const channels = await cillhub.channels.list(m.guild_id);
    log('read', list.length, one.content, member.user.id === m.author.id, members.length, guilds.length, guild.roles.length > 0, channels.length > 0);
  }
  if (cmd === '!storage') {
    await cillhub.storage.set('a:1', { n: 1 }); await cillhub.storage.set('a:2', [2]); await cillhub.storage.set('b:1', 'x');
    const page = await cillhub.storage.list({ prefix: 'a:', limit: 1 });
    log('storage', JSON.stringify(await cillhub.storage.get('a:1')), JSON.stringify(page), JSON.stringify(await cillhub.storage.get('none')));
    await cillhub.storage.delete('b:1');
    try { await cillhub.storage.set('big', 'x'.repeat(70000)); } catch (e) { log('too large', e.code); }
    let n = 0;
    try { for (;;) { await cillhub.storage.set('fill' + n, 'y'.repeat(65000)); n++; } } catch (e) { log('quota', e.code, n); }
  }
  if (cmd === '!at') { await cillhub.schedule.at('soon', Date.now() + 300); await cillhub.schedule.every('tick', 60000); log('schedules', JSON.stringify((await cillhub.schedule.list()).map(s => [s.name, s.interval_ms]))); }
  if (cmd === '!publish') await cillhub.ui.publish(m.guild_id, { hello: 'panel' });
  if (cmd === '!crypto') {
    const h = await cillhub.crypto.hmac('sha256', 'key', 'data');
    log('crypto', h, await cillhub.crypto.sha256('abc', 'base64'), (await cillhub.crypto.random(8)).length, cillhub.crypto.equal(h, h), cillhub.crypto.equal(h, h.slice(1)));
  }
});
cillhub.on('INTERACTION_CREATE', async i => {
  if ('token' in i) log('LEAK token');
  if (i.type === 4) return { type: 8, data: { choices: [{ name: 'Alpha', value: 'a' }] } };
  if (i.type === 3) return { type: 7, data: { content: 'Clicked by ' + i.member.user.username, components: [] } };
  if (i.data.name === 'later') {
    await cillhub.interactions.respond(i.id, { type: 5 });
    await cillhub.interactions.edit(i.id, { content: 'edited original' });
    await cillhub.interactions.followup(i.id, { content: 'a follow-up' });
    return;
  }
  return { type: 4, data: { content: 'Pick ' + i.data.options?.[0]?.value, components: [button] } };
});
cillhub.on('UI_REQUEST', r => {
  if (r.data === 'throw') throw new Error('panel says no');
  return { echo: r.data, user: r.user.username, panel: r.panel_id, slot: r.slot, channel: r.channel_id, message: r.message_id, perms: typeof r.member.permissions };
});
cillhub.on('HTTP_REQUEST', async req => {
  if (req.path === '/throw') throw new Error('boom');
  if (req.path === '/none') return;
  if (req.path === '/json') return { body: { ok: true } };
  return { status: 201, headers: { 'content-type': 'text/html', 'set-cookie': 'a=b', 'x-custom': '1', 'x-frame-options': 'ALLOW', location: '/x' }, body: JSON.stringify(req) };
});
`;
const KIT = pkg({
  id: 'kit', name: 'Kit',
  permissions: ['commands', 'messages.read', 'messages.send', 'members.read', 'roles.manage', 'storage', 'ui', 'http.routes', 'schedule'],
  commands: [
    { name: 'pick', description: 'Pick something', options: [{ type: 3, name: 'what', description: 'What', autocomplete: true }] },
    { name: 'later', description: 'Deferred answer' },
  ],
  settings: [{ key: 'greeting', type: 'text', label: 'Greeting', default: 'Hello', per_server: true }, { key: 'color', type: 'text', label: 'Color' }],
  ui: { panels: [{ id: 'side', slot: 'channel_panel', title: 'Side', entry: 'ui/side.html', icon: '🎮' }, { id: 'acc', slot: 'message_accessory', title: 'Acc', entry: 'ui/acc.html', height: 120 }] },
}, { 'index.js': CODE, 'ui/side.html': '<!doctype html><p>side</p>', 'ui/acc.html': '<p>acc</p>', 'ui/app.js': 'parent.postMessage({}, "*")', 'ui/data.bin': 'x', 'notes.txt': 'outside the ui folder' });

before(async () => {
  srv = await startServer();
  api = srv.api;
  root = await makeAdmin(srv);
  g = await guildWith(srv, ['alice', 'bob']);
  ({ alice, bob } = g.users);
  gw = await srv.gateway(alice.token);
  kit = await install(srv, root, KIT);
});
after(async () => { if (process.env.DEBUG_LOGS) console.log((await logsOf(srv, root, 'kit')).slice(0, 40).reverse().map(l => `${l.level} ${l.message.slice(0, 200)}`).join('\n')); await srv.stop(); });

const say = (who, content) => api('POST', `/channels/${g.general.id}/messages`, who.token, { content }).then(r => r.body);
const see = re => logged(srv, root, 'kit', re);

test('the bot carries module: true; READY reaches the module; panels appear in guild objects and updates', async () => {
  const joined = (await api('GET', `/guilds/${g.guild.id}/members/${kit.application_id}`, alice.token)).body;
  assert.equal(joined.user.module, true);
  await see(/^READY kit 1$/);
  const fresh = await srv.gateway(bob.token);
  const panels = fresh.ready.guilds.find(x => x.id === g.guild.id).module_panels;
  assert.deepEqual(panels, [
    { module_id: 'kit', application_id: kit.application_id, panel_id: 'side', slot: 'channel_panel', title: 'Side', icon: '🎮', height: 360, url: '/modules/kit/ui/ui/side.html' },
    { module_id: 'kit', application_id: kit.application_id, panel_id: 'acc', slot: 'message_accessory', title: 'Acc', icon: null, height: 120, url: '/modules/kit/ui/ui/acc.html' },
  ]);
  await api('PATCH', '/admin/modules/kit', root.token, { enabled: false });
  assert.deepEqual(await fresh.event('GUILD_MODULE_PANELS_UPDATE'), { guild_id: g.guild.id, module_panels: [] });
  await api('PATCH', '/admin/modules/kit', root.token, { enabled: true });
  assert.equal((await fresh.event('GUILD_MODULE_PANELS_UPDATE')).module_panels.length, 2);
  await running(srv, root, 'kit');
  // GUILD_CREATE when it is enabled in a new server, GUILD_DELETE when that server goes
  const fresh2 = (await api('POST', '/guilds', alice.token, { name: 'Fresh' })).body;
  await see(/^guild create Fresh$/);
  assert.equal((await api('DELETE', `/guilds/${fresh2.id}`, alice.token)).status, 204);
  await see(new RegExp(`^guild delete ${fresh2.id}$`));
});

test('a slash command, autocomplete, a button and a deferred answer, answered by the sandbox without the token', async () => {
  const cmds = (await api('GET', `/channels/${g.general.id}/application-command-index`, alice.token)).body.application_commands;
  const pick = cmds.find(c => c.name === 'pick');
  const body = (type, data, extra = {}) => ({ type, application_id: kit.application_id, guild_id: g.guild.id, channel_id: g.general.id, nonce: `n${Math.random()}`.slice(0, 20), data, ...extra });
  const ac = await api('POST', '/interactions', alice.token, body(4, { id: pick.id, name: 'pick', type: 1, options: [{ name: 'what', type: 3, value: 'al', focused: true }] }));
  assert.equal(ac.status, 204);
  assert.deepEqual((await gw.event('APPLICATION_COMMAND_AUTOCOMPLETE_RESPONSE')).choices, [{ name: 'Alpha', value: 'a' }]);
  assert.equal((await api('POST', '/interactions', alice.token, body(2, { id: pick.id, name: 'pick', type: 1, options: [{ name: 'what', type: 3, value: 'a' }] }))).status, 204);
  const answer = await gw.event('MESSAGE_CREATE', d => d.content === 'Pick a');
  assert.deepEqual([answer.author.id, answer.author.module, answer.components[0].components[0].custom_id], [kit.application_id, true, 'click']);
  assert.equal((await api('POST', '/interactions', bob.token, body(3, { component_type: 2, custom_id: 'click' }, { message_id: answer.id }))).status, 204);
  assert.equal((await gw.event('MESSAGE_UPDATE', d => d.id === answer.id)).content, 'Clicked by bob');
  const later = cmds.find(c => c.name === 'later');
  await api('POST', '/interactions', alice.token, body(2, { id: later.id, name: 'later', type: 1 }));
  assert.equal((await gw.event('MESSAGE_UPDATE', d => d.content === 'edited original')).author.id, kit.application_id);
  await gw.event('MESSAGE_CREATE', d => d.content === 'a follow-up');
  assert.ok(!(await logsOf(srv, root, 'kit')).some(l => l.message.includes('LEAK')));
});

test('events: messages, members joining, reactions; messages with embeds, components, a reaction and an accessory panel', async () => {
  await say(alice, 'hello module');
  await see(/^message hello module$/);
  const eve = await srv.register('eve');
  assert.equal((await api('POST', `/invites/${g.invite.code}`, eve.token)).status, 200);
  await see(new RegExp(`^member eve ${g.guild.id}$`));
  await say(alice, '!card');
  const card = await gw.event('MESSAGE_CREATE', d => d.content === 'card');
  assert.deepEqual([card.embeds[0].title, card.components[0].components[0].label, card.module_accessory], ['Card', 'Click', { module_id: 'kit', panel_id: 'acc' }]);
  assert.equal((await gw.event('MESSAGE_REACTION_ADD', d => d.message_id === card.id)).emoji.name, '👍');
  assert.equal((await gw.event('MESSAGE_UPDATE', d => d.id === card.id)).embeds[0].title, 'Edited');
  assert.deepEqual((await api('GET', `/channels/${g.general.id}/messages/${card.id}`, bob.token)).body.module_accessory, { module_id: 'kit', panel_id: 'acc' });
  await see(new RegExp(`^card ${card.id} Edited {"module_id":"kit","panel_id":"acc"}$`));
  await see(/^edit other FORBIDDEN 403 50005$/);
  await see(/^bad panel INVALID$/);
  assert.ok(!(await logsOf(srv, root, 'kit')).some(l => l.message === 'message card'), 'its own messages are not delivered back');
  await api('PUT', `/channels/${g.general.id}/messages/${card.id}/reactions/${encodeURIComponent('🔥')}/@me`, bob.token);
  await see(/^reaction 🔥$/);
  lastCard = Date.now();
  await say(alice, `!delete ${card.id}`);
  await gw.event('MESSAGE_DELETE', d => d.id === card.id);
  await say(alice, '!read');
  await see(/^read 2 !read true 2 1 true true$/);
  await say(alice, '!crypto');
  await see(/^crypto 5031fe3d989c6d1537a013fa6e739da23463fdaec3b70137d828e36ace221bd0 ungWv48Bz\+pBQUDeXa4iI7ADYaOWF3qctBD\/YfIAFa0= 16 true false$/);
});

test('roles: a module adds roles below its own role and is refused above it', async () => {
  const mk = name => api('POST', `/guilds/${g.guild.id}/roles`, alice.token, { name }).then(r => r.body);
  const low = await mk('Low');
  const botRole = (await api('GET', `/guilds/${g.guild.id}/roles`, alice.token)).body.find(r => r.tags?.bot_id === kit.application_id);
  const high = await mk('High');
  // order: @everyone, Low, bot role, High
  await api('PATCH', `/guilds/${g.guild.id}/roles`, alice.token, [{ id: low.id, position: 1 }, { id: botRole.id, position: 2 }, { id: high.id, position: 3 }]);
  await say(alice, `!role ${bob.id} ${low.id}`);
  await see(/^role ok$/);
  assert.ok((await api('GET', `/guilds/${g.guild.id}/members/${bob.id}`, alice.token)).body.roles.includes(low.id));
  await say(alice, `!role ${bob.id} ${high.id}`);
  await see(/^role refused FORBIDDEN 403 50013$/);
});

test('storage: get, set, list by prefix, the 64 KiB value limit and the 5 MiB quota', async () => {
  await say(alice, '!storage');
  await see(/^storage {"n":1} {"items":\[{"key":"a:1","value":{"n":1}}\],"next":"a:1"} null$/);
  await see(/^too large TOO_LARGE$/);
  const q = await see(/^quota QUOTA_EXCEEDED \d+$/);
  assert.ok(Number(q.message.split(' ')[2]) > 70);
  const m = (await api('GET', '/admin/modules/kit', root.token)).body;
  assert.ok(m.storage.used_bytes <= 5 * 1024 * 1024 && m.storage.used_bytes > 4.9 * 1024 * 1024);
  await logged(srv, root, 'kit', /^Refused storage\.set: QUOTA_EXCEEDED/, 'system');
});

test('settings.get: global values, overlaid with the server\'s own when per-server settings are on; SETTINGS_UPDATE', async () => {
  await api('PUT', '/admin/modules/kit/settings', root.token, { values: { color: 'red' } });
  await see(/^settings changed null$/);
  await say(alice, '!settings');
  await see(/^settings {"greeting":"Hello","color":"red"} {"greeting":"Hello","color":"red"}$/);
  await api('PATCH', '/admin/modules/kit', root.token, { per_server_settings: true });
  await api('PUT', `/admin/modules/kit/guilds/${g.guild.id}/settings`, root.token, { values: { greeting: 'Servus' } });
  await see(new RegExp(`^settings changed ${g.guild.id}$`));
  await say(alice, '!settings');
  await see(/^settings {"greeting":"Servus","color":"red"} {"greeting":"Hello","color":"red"}$/);
});

test('UI requests and ui.publish', async () => {
  const ui = (who, body) => api('POST', '/modules/kit/ui', who.token, { panel_id: 'side', guild_id: g.guild.id, ...body });
  const r = await ui(bob, { channel_id: g.general.id, data: { q: 1 } });
  assert.deepEqual(r.body, { data: { echo: { q: 1 }, user: 'bob', panel: 'side', slot: 'channel_panel', channel: g.general.id, message: null, perms: 'string' } });
  assert.equal((await ui(bob, { data: 'throw' })).status, 502);
  assert.equal((await ui(bob, { data: 'throw' })).body.message, 'Error: panel says no');
  assert.equal((await ui(bob, { panel_id: 'nope' })).status, 400);
  const stranger = await srv.register('stranger');
  assert.equal((await ui(stranger, {})).status, 403);
  assert.equal((await api('POST', '/modules/kit/ui', null, { panel_id: 'side', guild_id: g.guild.id })).status, 401);
  // an accessory request names a message of the module with that panel
  await new Promise(r => setTimeout(r, 5000 - (Date.now() - lastCard))); // 5 writes per 5 s per channel
  await say(alice, '!card');
  const card = await gw.event('MESSAGE_CREATE', d => d.content === 'card');
  const acc = await ui(bob, { panel_id: 'acc', channel_id: g.general.id, message_id: card.id, data: 2 });
  assert.equal(acc.body.data.message, card.id);
  const mine = await say(alice, 'not the module');
  assert.equal((await ui(bob, { panel_id: 'acc', channel_id: g.general.id, message_id: mine.id })).status, 404);
  await say(alice, '!publish');
  assert.deepEqual(await gw.event('MODULE_UI_EVENT'), { module_id: 'kit', guild_id: g.guild.id, data: { hello: 'panel' } });
  let limited = 0;
  for (let i = 0; i < 25; i++) if ((await ui(alice, {})).status === 429) limited++;
  assert.ok(limited >= 5, '20 per 10 s per user');
});

test('HTTP endpoints: headers in and out, CSP on every answer, limits', async () => {
  const base = `${srv.origin}/modules/kit/http`;
  const safe = res => {
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; sandbox");
  };
  const res = await fetch(`${base}/hook?a=1&b=2`, { method: 'POST', headers: { Cookie: 'sid=1', Authorization: 'Bearer x', 'X-Forwarded-For': '1.2.3.4', 'X-Cillhub-MFA-Authorization': 'y', 'X-Signature': 'sig', 'Content-Type': 'application/json' }, body: '{"x":1}' });
  safe(res);
  assert.equal(res.status, 201);
  assert.deepEqual([res.headers.get('x-custom'), res.headers.get('set-cookie'), res.headers.get('x-frame-options'), res.headers.get('location'), res.headers.get('content-type')], ['1', null, null, '/x', 'text/html']);
  const seen = JSON.parse(await res.text());
  assert.deepEqual([seen.method, seen.path, seen.query, seen.body, seen.body_encoding], ['POST', '/hook', { a: '1', b: '2' }, '{"x":1}', 'utf8']);
  for (const h of ['cookie', 'authorization', 'x-forwarded-for', 'x-cillhub-mfa-authorization']) assert.ok(!(h in seen.headers), h);
  assert.equal(seen.headers['x-signature'], 'sig');
  const bin = await fetch(`${base}/`, { method: 'PUT', body: Buffer.from([0xff, 0x00, 0xfe]) });
  assert.deepEqual([JSON.parse(await bin.text()).body_encoding, JSON.parse(await (await fetch(`${base}/`, { method: 'PUT', body: Buffer.from([0xff]) })).text()).body], ['base64', '/w==']);
  const json = await fetch(`${base}/json`);
  assert.deepEqual([json.status, json.headers.get('content-type'), await json.text()], [200, 'application/json', '{"ok":true}']);
  const none = await fetch(`${base}/none`);
  safe(none);
  assert.equal(none.status, 204);
  const thrown = await fetch(`${base}/throw`);
  safe(thrown);
  assert.equal(thrown.status, 502);
  assert.ok(!(await thrown.text()).includes('boom'), 'the error goes to the module log, not to the caller');
  await logged(srv, root, 'kit', /HTTP_REQUEST handler failed: Error: boom/, 'error');
  const big = await fetch(`${base}/big`, { method: 'POST', body: Buffer.alloc(256 * 1024 + 1) });
  safe(big);
  assert.equal(big.status, 413);
  for (const p of ['/modules/none/http/x', '/modules/kit/http']) {
    const r = await fetch(srv.origin + p, { method: p.endsWith('x') ? 'GET' : 'OPTIONS' });
    safe(r);
    assert.ok([404, 405].includes(r.status), `${p} ${r.status}`);
  }
  let throttled;
  for (let i = 0; i < 125 && !throttled; i++) { const r = await fetch(`${base}/none`); if (r.status === 429) throttled = r; }
  assert.ok(throttled, '120 per minute');
  safe(throttled);
});

test('HTTP endpoints: no answer within 5 s is 504 (a module of its own, whose queue stays blocked for the 10 s handler deadline)', async () => {
  await install(srv, root, pkg({ id: 'slowpoke', permissions: ['http.routes'] }, { 'index.js': 'cillhub.on("HTTP_REQUEST", () => new Promise(() => {}));' }));
  const t0 = Date.now();
  const slow = await fetch(`${srv.origin}/modules/slowpoke/http/`);
  assert.deepEqual([slow.status, slow.headers.get('content-security-policy')], [504, "default-src 'none'; sandbox"]);
  assert.ok(Date.now() - t0 >= 4900 && Date.now() - t0 < 6000);
  await api('PATCH', '/admin/modules/slowpoke', root.token, { enabled: false });
});

test('panel files: only under the panel folders, allowed types, sandbox CSP; 404 otherwise', async () => {
  const res = await fetch(`${srv.origin}/modules/kit/ui/ui/side.html`, { headers: { Cookie: 'x=1', Authorization: 'nope' } });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '<!doctype html><p>side</p>');
  assert.deepEqual(Object.fromEntries(['content-type', 'content-security-policy', 'x-content-type-options', 'cache-control', 'referrer-policy', 'access-control-allow-origin'].map(h => [h, res.headers.get(h)])), {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'",
    'x-content-type-options': 'nosniff', 'cache-control': 'no-cache', 'referrer-policy': 'no-referrer', 'access-control-allow-origin': '*',
  });
  assert.equal((await fetch(`${srv.origin}/modules/kit/ui/ui/app.js`)).headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal((await fetch(`${srv.origin}/modules/kit/ui/ui/app.js`, { method: 'HEAD' })).status, 200);
  for (const p of ['ui/data.bin', 'notes.txt', 'index.js', 'cillhub-module.json', 'ui/missing.html', 'ui/../index.js', 'ui/%2e%2e/index.js', 'ui/%2e%2e%2findex.js']) {
    assert.equal((await fetch(`${srv.origin}/modules/kit/ui/${p}`)).status, 404, p);
  }
  assert.equal((await fetch(`${srv.origin}/modules/other/ui/ui/side.html`)).status, 404);
  await api('PATCH', '/admin/modules/kit', root.token, { enabled: false });
  assert.equal((await fetch(`${srv.origin}/modules/kit/ui/ui/side.html`)).status, 404, 'disabled modules serve nothing');
  assert.equal((await fetch(`${srv.origin}/modules/kit/http/none`)).status, 503, 'not running');
  await api('PATCH', '/admin/modules/kit', root.token, { enabled: true });
  await running(srv, root, 'kit');
});

test('schedules: an at schedule fires and is deleted; due schedules fire once when the module runs again after a restart', async () => {
  await say(alice, '!at');
  await see(/^schedules \[\["soon",null\],\["tick",60000\]\]$/);
  await see(/^SCHEDULE soon number$/);
  const db = () => new DatabaseSync(join(srv.dataDir, 'cillcord.sqlite'));
  await until(() => { const d = db(); try { return !d.prepare("SELECT 1 FROM module_schedules WHERE name = 'soon'").get(); } finally { d.close(); } });
  const tick = (() => { const d = db(); try { return d.prepare("SELECT next_at FROM module_schedules WHERE name = 'tick'").get().next_at; } finally { d.close(); } })();
  assert.ok(tick > Date.now() + 50_000, 'every first fires interval_ms after it was set');
  // stopped server: both made due in the past; on start each fires once, the every one is re-armed
  await srv.stop(true);
  const d = db();
  d.prepare("UPDATE module_schedules SET next_at = ? WHERE name = 'tick'").run(Date.now() - 3_600_000);
  d.prepare("INSERT INTO module_schedules (module_id, name, next_at, interval_ms) VALUES ('kit', 'missed', ?, NULL)").run(Date.now() - 1000);
  d.close();
  srv = await startServer({ dataDir: srv.dataDir });
  api = srv.api;
  await see(/^SCHEDULE tick number$/);
  await see(/^SCHEDULE missed number$/);
  await new Promise(r => setTimeout(r, 300));
  assert.equal((await logsOf(srv, root, 'kit')).filter(l => l.message === 'SCHEDULE tick number').length, 1, 'once, not once per missed interval');
  const after_ = db();
  try {
    assert.ok(after_.prepare("SELECT next_at FROM module_schedules WHERE name = 'tick'").get().next_at > Date.now() + 50_000);
    assert.equal(after_.prepare("SELECT 1 FROM module_schedules WHERE name = 'missed'").get(), undefined);
  } finally { after_.close(); }
});
